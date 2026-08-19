/**
 * Van Rysel D100 – FTMS (Fitness Machine Service, 0x1826)
 *
 * Zwei Dinge sind hier entscheidend für einen stabilen ERG-Betrieb:
 *
 * 1. Schreibvorgänge auf den Control Point werden serialisiert. Der Standard
 *    erlaubt genau einen offenen Befehl; überlappende Schreibvorgänge sind der
 *    übliche Grund, warum ein Trainer stillschweigend aus dem ERG-Modus fällt.
 *    Neue Watt-Vorgaben, die noch in der Warteschlange stehen, werden dabei
 *    zusammengefasst – es zählt ohnehin nur der zuletzt gewünschte Wert.
 *
 * 2. Eine Zeitüberschreitung gilt als Fehlschlag, nicht als Erfolg. Vorher
 *    konnte eine verlorene Vorgabe unbemerkt bleiben, während die Anzeige
 *    etwas anderes behauptete.
 */

import { BleDevice } from './ble_base.js';

const FTMS_SERVICE_UUID   = 0x1826;
const CONTROL_POINT_UUID  = 0x2ad9;
const MACHINE_STATUS_UUID = 0x2ada;
const BIKE_DATA_UUID      = 0x2ad2;

// Control-Point-Opcodes
const OP_REQUEST_CONTROL  = 0x00;
const OP_RESET            = 0x01;
const OP_SET_TARGET_POWER = 0x05;
const OP_START_RESUME     = 0x07;
const OP_RESPONSE         = 0x80;

const RESULT_SUCCESS = 0x01;

const WRITE_TIMEOUT_MS   = 3000;
// Der Handschlag beim Verbinden bekommt mehr Zeit als eine laufende
// Watt-Vorgabe: manche Trainer antworten direkt nach dem Verbinden traege.
const HANDSHAKE_TIMEOUT_MS = 6000;
// Kurze Ruhe nach dem Einschalten der Benachrichtigungen. Schreibt man
// sofort danach, verschluckt manche Android-Bluetooth-Schicht die Antwort.
const SETTLE_MS = 400;

export class D100Bluetooth extends BleDevice {
    constructor() {
        super({
            key:      'd100',
            label:    'D100',
            filters:  [
                { namePrefix: 'D100' },
                { namePrefix: 'Van Rysel' },
                { services: [FTMS_SERVICE_UUID] },
            ],
            services: [FTMS_SERVICE_UUID],
        });

        this.controlPoint = null;

        this.onPower         = null;  // (watt) => void
        this.onCadence       = null;  // (rpm) => void
        this.onControlLost   = null;  // () => void
        this.onMachineStatus = null;  // (text) => void

        this.lastTargetSent = null;
        this.lastAckTime    = 0;
        this.hasControl     = false;
        // Solange der Handschlag laeuft, duerfen Zwischenmeldungen des Trainers
        // keinen Steuerungsverlust ausloesen - sonst rettet die App eine
        // Verbindung, die gerade erst aufgebaut wird.
        this._handshakeRunning = false;
        // Merkt einen echten Steuerungsverlust, der waehrend des Handschlags
        // eintrifft - sonst wuerde ihn die Schlusszuweisung wieder zudecken.
        this._controlLostDuringHandshake = false;

        this._queue   = [];
        this._running = false;
        this._pending = null;   // { opcode, resolve, reject, timer }
    }

    async _setupServices(server) {
        let service;
        try {
            service = await server.getPrimaryService(FTMS_SERVICE_UUID);
        } catch (err) {
            // Häufigste Ursache auf Android: ein veralteter GATT-Zwischenspeicher.
            // Dann hilft nur, das Gerät in den Bluetooth-Einstellungen zu
            // entfernen und neu zu koppeln.
            this._step(`${this.label}: FTMS-Dienst nicht gefunden (${err.message})`, 'error');
            throw new Error('FTMS-Dienst nicht gefunden. Gerät in den Android-Bluetooth-Einstellungen entfernen und neu koppeln.');
        }
        this._step(`${this.label}: FTMS-Dienst gefunden`);

        try {
            this.controlPoint = await service.getCharacteristic(CONTROL_POINT_UUID);
        } catch (err) {
            this._step(`${this.label}: Steuerkanal nicht gefunden (${err.message})`, 'error');
            throw new Error('Steuerkanal (Control Point) nicht gefunden. Trainer unterstützt womöglich keine ERG-Steuerung.');
        }
        this.controlPoint.addEventListener('characteristicvaluechanged', (e) =>
            this._handleResponse(e.target.value)
        );
        await this.controlPoint.startNotifications();
        this._step(`${this.label}: Steuerkanal bereit`);

        // Indoor Bike Data: Leistung und Trittfrequenz (nicht jedes Gerät sendet das)
        try {
            const bikeData = await service.getCharacteristic(BIKE_DATA_UUID);
            bikeData.addEventListener('characteristicvaluechanged', (e) =>
                this._parseBikeData(e.target.value)
            );
            await bikeData.startNotifications();
        } catch { /* optional */ }

        // Machine Status: meldet u.a., wenn der Trainer selbst pausiert
        try {
            const status = await service.getCharacteristic(MACHINE_STATUS_UUID);
            status.addEventListener('characteristicvaluechanged', (e) =>
                this._parseMachineStatus(e.target.value)
            );
            await status.startNotifications();
        } catch { /* optional */ }

        // Warteschlange aus einer früheren Verbindung verwerfen
        this._flushQueue(new Error('Verbindung neu aufgebaut'));
    }

    /**
     * FTMS-Handschlag - bewusst NACH dem Verbinden und ohne Rückwirkung darauf.
     *
     * Das war der Fehler der vorherigen Fassung: der Handschlag lief mitten im
     * Verbindungsaufbau, und eine ausbleibende Bestätigung riss die längst
     * stehende Bluetooth-Verbindung wieder ein. Der Trainer tauchte im
     * Auswahldialog auf, ließ sich aber nie verbinden.
     */
    async _afterConnect() {
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        await this.takeControl();
        if (this.lastTargetSent != null) {
            await this.setTargetPower(this.lastTargetSent);
        }
    }

    /**
     * Steuerung anfordern und Training starten.
     *
     * Wirft nie. Bleibt die Bestätigung aus, gilt die Steuerung als
     * unbestätigt - Watt-Vorgaben werden trotzdem versucht, weil etliche
     * Trainer sie auch ohne saubere Antwort auf Opcode 0x00 umsetzen.
     * @returns {Promise<boolean>} ob die Steuerung bestätigt wurde
     */
    async takeControl() {
        this.hasControl = false;
        this._handshakeRunning = true;
        this._controlLostDuringHandshake = false;

        // Bewusst eine lokale Variable: this.hasControl kann waehrend des
        // Handschlags von aussen umgelegt werden - etwa wenn der Trainer
        // Start/Resume mit "Steuerung nicht erlaubt" quittiert, weil er
        // ohnehin schon laeuft. Das darf ein zuvor bestaetigtes
        // "Steuerung anfordern" nicht entwerten.
        let bestaetigt = false;

        try {
            for (let versuch = 1; versuch <= 3; versuch++) {
                try {
                    await this._enqueue(new Uint8Array([OP_REQUEST_CONTROL]), OP_REQUEST_CONTROL,
                                        { timeoutMs: HANDSHAKE_TIMEOUT_MS });
                    bestaetigt = true;
                    this._step(`${this.label}: Steuerung übernommen`, 'ok');
                    break;
                } catch (err) {
                    this._step(`${this.label}: Steuerung anfordern, Versuch ${versuch} von 3 fehlgeschlagen (${err.message})`,
                               versuch === 3 ? 'warn' : 'info');
                    if (versuch < 3) await new Promise((r) => setTimeout(r, 700));
                }
            }

            // Start/Resume ist nachrangig: viele Geräte antworten mit einem
            // Fehler, wenn sie bereits laufen.
            try {
                await this._enqueue(new Uint8Array([OP_START_RESUME]), OP_START_RESUME,
                                    { timeoutMs: HANDSHAKE_TIMEOUT_MS });
                this._step(`${this.label}: Training gestartet`);
            } catch (err) {
                this._step(`${this.label}: Start/Resume abgelehnt (${err.message}) - unkritisch`);
            }
        } finally {
            this._handshakeRunning = false;
        }

        // Ein waehrenddessen eingetroffener Reset wiegt schwerer als die
        // Bestaetigung von vorhin.
        if (this._controlLostDuringHandshake) bestaetigt = false;
        this.hasControl = bestaetigt;

        if (!bestaetigt) {
            this._error(`${this.label} bestätigt die Steuerung nicht. Watt-Vorgaben werden trotzdem gesendet - `
                      + 'falls der Trainer nicht reagiert, bitte andere Trainings-Apps schließen und den Trainer kurz vom Strom nehmen.');
        }
        return bestaetigt;
    }

    /**
     * ERG-Watt-Vorgabe setzen.
     * @returns {Promise<boolean>} ob der Trainer bestätigt hat
     */
    async setTargetPower(watts) {
        const w = Math.max(0, Math.min(2000, Math.round(watts)));
        this.lastTargetSent = w;

        // Bewusst nicht an hasControl gekoppelt: bleibt die Bestätigung des
        // Handschlags aus, heißt das nicht, dass der Trainer die Vorgabe
        // ignoriert. Der ERG-Wächter merkt es, falls doch.
        if (!this.isConnected || !this.controlPoint) return false;

        const buf = new Uint8Array(3);
        buf[0] = OP_SET_TARGET_POWER;
        buf[1] = w & 0xff;
        buf[2] = (w >> 8) & 0xff;

        try {
            await this._enqueue(buf, OP_SET_TARGET_POWER, { coalesceKey: 'power' });
            this.lastAckTime = Date.now();
            return true;
        } catch (err) {
            this._error(`Watt-Vorgabe nicht bestätigt: ${err.message}`);
            return false;
        }
    }

    /** Vorgabe erneut senden, ohne sie zu ändern – hält den ERG-Modus wach */
    async refreshTargetPower() {
        if (this.lastTargetSent == null) return false;
        return this.setTargetPower(this.lastTargetSent);
    }

    /** Nach vermutetem Steuerungsverlust: Kontrolle neu anfordern und Vorgabe setzen */
    async reacquireControl() {
        if (!this.isConnected) return false;
        try {
            await this.takeControl();
            if (this.lastTargetSent != null) await this.setTargetPower(this.lastTargetSent);
            return true;
        } catch (err) {
            this._error(`Steuerung konnte nicht zurückgeholt werden: ${err.message}`);
            return false;
        }
    }

    // ── Warteschlange ─────────────────────────────────────────────────────────

    _enqueue(data, opcode, { coalesceKey = null, timeoutMs = WRITE_TIMEOUT_MS } = {}) {
        return new Promise((resolve, reject) => {
            if (coalesceKey) {
                // Noch nicht gestartete Aufträge desselben Typs ersetzen – ein
                // veralteter Watt-Wert muss nicht mehr geschrieben werden.
                for (let i = this._queue.length - 1; i >= 0; i--) {
                    if (this._queue[i].coalesceKey === coalesceKey) {
                        this._queue[i].resolve(false);
                        this._queue.splice(i, 1);
                    }
                }
            }
            this._queue.push({ data, opcode, resolve, reject, timeoutMs, coalesceKey });
            this._drain();
        });
    }

    async _drain() {
        if (this._running) return;
        this._running = true;

        while (this._queue.length) {
            const job = this._queue.shift();

            if (!this.isConnected || !this.controlPoint) {
                job.reject(new Error('nicht verbunden'));
                continue;
            }

            try {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        this._pending = null;
                        reject(new Error('Zeitüberschreitung'));
                    }, job.timeoutMs);

                    this._pending = {
                        opcode: job.opcode,
                        resolve: () => { clearTimeout(timer); this._pending = null; resolve(); },
                        reject:  (e) => { clearTimeout(timer); this._pending = null; reject(e); },
                    };

                    this.controlPoint.writeValueWithResponse(job.data).catch((err) => {
                        clearTimeout(timer);
                        this._pending = null;
                        reject(err);
                    });
                });
                job.resolve(true);
            } catch (err) {
                job.reject(err);
            }
        }

        this._running = false;
    }

    _flushQueue(err) {
        if (this._pending) {
            this._pending.reject(err);
            this._pending = null;
        }
        const queued = this._queue.splice(0);
        for (const job of queued) job.reject(err);
    }

    _handleResponse(data) {
        if (!data || data.byteLength < 3) return;
        this._markData();
        if (data.getUint8(0) !== OP_RESPONSE) return;

        const requestOpcode = data.getUint8(1);
        const resultCode    = data.getUint8(2);

        if (!this._pending || this._pending.opcode !== requestOpcode) return;

        if (resultCode === RESULT_SUCCESS) {
            this._pending.resolve();
        } else {
            // 0x05 = Control Not Permitted. Waehrend des Handschlags ist das
            // kein Steuerungsverlust, sondern haeufig nur die Antwort auf
            // Start/Resume bei einem bereits laufenden Trainer.
            if (resultCode === 0x05 && !this._handshakeRunning) {
                this.hasControl = false;
                this._step(`${this.label}: Steuerung entzogen (Opcode ${requestOpcode})`, 'warn');
                if (this.onControlLost) this.onControlLost();
            }
            this._pending.reject(new Error(this._resultText(resultCode)));
        }
    }

    _resultText(code) {
        switch (code) {
            case 0x02: return 'Befehl nicht unterstützt';
            case 0x03: return 'ungültiger Parameter';
            case 0x04: return 'Ausführung fehlgeschlagen';
            case 0x05: return 'Steuerung nicht erlaubt';
            default:   return `Antwortcode ${code}`;
        }
    }

    // ── Messdaten ─────────────────────────────────────────────────────────────

    _parseBikeData(data) {
        if (!data || data.byteLength < 2) return;
        this._markData();

        const flags = data.getUint16(0, true);
        let offset = 2;

        const need = (bytes) => {
            if (offset + bytes > data.byteLength) return false;
            return true;
        };

        // Reihenfolge und Feldbreiten laut FTMS-Spezifikation
        if (!(flags & 0x0001)) { if (!need(2)) return; offset += 2; }  // Instantaneous Speed
        if (flags & 0x0002)    { if (!need(2)) return; offset += 2; }  // Average Speed

        if (flags & 0x0004) {                                          // Instantaneous Cadence
            if (!need(2)) return;
            const rpm = data.getUint16(offset, true) / 2;              // Einheit 0,5 rpm
            offset += 2;
            if (rpm >= 0 && rpm < 250 && this.onCadence) this.onCadence(Math.round(rpm));
        }
        if (flags & 0x0008) { if (!need(2)) return; offset += 2; }     // Average Cadence
        if (flags & 0x0010) { if (!need(3)) return; offset += 3; }     // Total Distance (uint24)
        if (flags & 0x0020) { if (!need(2)) return; offset += 2; }     // Resistance Level

        if (flags & 0x0040) {                                          // Instantaneous Power
            if (!need(2)) return;
            const watts = data.getInt16(offset, true);
            offset += 2;
            if (this.onPower) this.onPower(Math.max(0, watts));
        }
    }

    _parseMachineStatus(data) {
        if (!data || data.byteLength < 1) return;
        this._markData();
        const opcode = data.getUint8(0);

        // Laut FTMS entzieht nur ein Reset (0x01) die Steuerung. "Gestoppt oder
        // pausiert" (0x02) meldet ein Trainer voellig regulaer, solange niemand
        // tritt - das als Steuerungsverlust zu werten hiesse, bei jeder
        // Trinkpause eine intakte Verbindung zu "retten".
        if (opcode === 0x01) {
            this.hasControl = false;
            this._controlLostDuringHandshake = true;
            this._step(`${this.label}: Trainer zurückgesetzt, Steuerung weg`, 'warn');
            if (this.onControlLost) this.onControlLost();
            if (this.onMachineStatus) this.onMachineStatus('Trainer zurückgesetzt');
        } else if (opcode === 0x02) {
            this._step(`${this.label}: Trainer meldet gestoppt oder pausiert`);
        }
    }

    disconnect() {
        this._flushQueue(new Error('getrennt'));
        this.hasControl = false;
        super.disconnect();
    }
}
