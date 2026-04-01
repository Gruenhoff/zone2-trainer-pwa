/**
 * Van Rysel D100 – FTMS (Fitness Machine Service, 0x1826)
 * ERG-Steuerung über Fitness Machine Control Point (0x2AD9)
 */

const FTMS_SERVICE_UUID    = 0x1826;
const CONTROL_POINT_UUID   = 0x2ad9;
const MACHINE_STATUS_UUID  = 0x2ada;
const BIKE_DATA_UUID       = 0x2ad2;

// FTMS Control Point Opcodes
const OP_REQUEST_CONTROL   = 0x00;
const OP_RESET             = 0x01;
const OP_SET_TARGET_POWER  = 0x05;
const OP_START_RESUME      = 0x07;
const OP_RESPONSE          = 0x80;

// Response Codes
const RESULT_SUCCESS        = 0x01;

export class D100Bluetooth {
    constructor() {
        this.device = null;
        this.server = null;
        this.controlPoint = null;
        this.isConnected = false;
        this._reconnectTimer = null;
        this._stopReconnect = false;
        this._pendingResponse = null; // { resolve, reject, opcode }

        this.onConnect    = null;
        this.onDisconnect = null;
        this.onError      = null;
        this.onStatus     = null;
        this.onPower      = null;  // (watts) => void (aus Indoor Bike Data, optional)
    }

    static isAvailable() {
        return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    async connect() {
        if (!D100Bluetooth.isAvailable()) {
            this._error('Web Bluetooth nicht verfügbar.');
            return false;
        }
        this._stopReconnect = false;
        try {
            this._status('Suche D100 Smart Trainer...');
            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'D100' },
                    { namePrefix: 'Van Rysel' },
                    { services: [FTMS_SERVICE_UUID] },
                ],
                optionalServices: [FTMS_SERVICE_UUID],
            });
            this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
            await this._connectGatt();
            return true;
        } catch (err) {
            if (err.name === 'NotFoundError') {
                this._error('Kein D100 ausgewählt.');
            } else if (err.message?.toLowerCase().includes('already')) {
                this._error('D100 bereits belegt – bitte Zwift/Sufferfest/MyWhoosh schliessen.');
            } else {
                this._error(`D100 Verbindungsfehler: ${err.message}`);
            }
            return false;
        }
    }

    async _connectGatt() {
        this._status('Verbinde D100...');
        try {
            this.server = await this.device.gatt.connect();
        } catch (err) {
            if (err.name === 'NetworkError' || err.message?.toLowerCase().includes('already')) {
                throw new Error('D100 bereits belegt – bitte Zwift/Sufferfest/MyWhoosh schliessen.');
            }
            throw err;
        }

        const service = await this.server.getPrimaryService(FTMS_SERVICE_UUID);
        this.controlPoint = await service.getCharacteristic(CONTROL_POINT_UUID);

        // Notifications auf Control Point aktivieren (für Antworten)
        this.controlPoint.addEventListener('characteristicvaluechanged', (e) =>
            this._handleResponse(e.target.value)
        );
        await this.controlPoint.startNotifications();

        // Optional: Indoor Bike Data lesen
        try {
            const bikeData = await service.getCharacteristic(BIKE_DATA_UUID);
            bikeData.addEventListener('characteristicvaluechanged', (e) =>
                this._parseBikeData(e.target.value)
            );
            await bikeData.startNotifications();
        } catch { /* nicht alle D100 senden Bike Data */ }

        // FTMS Steuerung übernehmen
        await this._requestControl();
        await this._startTraining();

        this.isConnected = true;
        this._status('D100 verbunden');
        if (this.onConnect) this.onConnect();
    }

    /** Opcode 0x00: Steuerung anfordern */
    async _requestControl() {
        await this._writeAndWait(new Uint8Array([OP_REQUEST_CONTROL]), OP_REQUEST_CONTROL);
    }

    /** Opcode 0x07: Training starten */
    async _startTraining() {
        await this._writeAndWait(new Uint8Array([OP_START_RESUME]), OP_START_RESUME);
    }

    /**
     * ERG-Watt-Vorgabe setzen
     * @param {number} watts – Ziel-Watt (0–2000)
     */
    async setTargetPower(watts) {
        if (!this.isConnected || !this.controlPoint) return;
        const w = Math.max(0, Math.min(2000, Math.round(watts)));
        const buf = new Uint8Array(3);
        buf[0] = OP_SET_TARGET_POWER;
        // int16 LE
        buf[1] = w & 0xff;
        buf[2] = (w >> 8) & 0xff;
        try {
            await this._writeAndWait(buf, OP_SET_TARGET_POWER, 2000);
        } catch (err) {
            this._error(`Watt-Vorgabe fehlgeschlagen: ${err.message}`);
        }
    }

    /** Schreibt auf Control Point und wartet auf Antwort */
    _writeAndWait(data, expectedOpcode, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingResponse = null;
                // Timeout ist nicht fatal – weiter machen
                resolve();
            }, timeoutMs);

            this._pendingResponse = {
                opcode: expectedOpcode,
                resolve: () => { clearTimeout(timer); resolve(); },
                reject: (reason) => { clearTimeout(timer); reject(reason); },
            };

            this.controlPoint.writeValueWithResponse(data).catch((err) => {
                clearTimeout(timer);
                this._pendingResponse = null;
                reject(err);
            });
        });
    }

    _handleResponse(data) {
        if (data.byteLength < 3) return;
        if (data.getUint8(0) !== OP_RESPONSE) return;

        const requestOpcode = data.getUint8(1);
        const resultCode    = data.getUint8(2);

        if (this._pendingResponse?.opcode === requestOpcode) {
            const pending = this._pendingResponse;
            this._pendingResponse = null;
            if (resultCode === RESULT_SUCCESS) {
                pending.resolve();
            } else {
                pending.reject(new Error(`FTMS Fehler: opcode ${requestOpcode}, code ${resultCode}`));
            }
        }
    }

    _parseBikeData(data) {
        // Bit 6 der Flags = Instantaneous Power vorhanden (wenn 0 = mehr Data)
        // Vereinfacht: lesen wenn genug Bytes vorhanden
        if (data.byteLength < 6) return;
        const flags = data.getUint16(0, true);
        let offset = 2;
        // Bit 0: wenn gesetzt, kein Instantaneous Speed
        const hasSpeed    = !(flags & 0x0001);
        if (hasSpeed) offset += 2;
        // Bit 2: Instantaneous Cadence
        const hasCadence  = !!(flags & 0x0004);
        if (hasCadence) offset += 2;
        // Bit 4: Total Distance
        const hasDist     = !!(flags & 0x0010);
        if (hasDist) offset += 3;
        // Bit 5: Resistance
        const hasRes      = !!(flags & 0x0020);
        if (hasRes) offset += 2;
        // Bit 6: Instantaneous Power
        const hasPower    = !!(flags & 0x0040);
        if (hasPower && data.byteLength >= offset + 2) {
            const watts = data.getInt16(offset, true);
            if (this.onPower) this.onPower(Math.max(0, watts));
        }
    }

    async _onDisconnected() {
        this.isConnected = false;
        this._status('D100 getrennt');
        if (this.onDisconnect) this.onDisconnect();
        if (!this._stopReconnect) this._scheduleReconnect();
    }

    _scheduleReconnect() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(async () => {
            if (this._stopReconnect || !this.device) return;
            this._status('D100 Reconnect...');
            try {
                await this._connectGatt();
            } catch {
                this._scheduleReconnect();
            }
        }, 5000);
    }

    disconnect() {
        this._stopReconnect = true;
        clearTimeout(this._reconnectTimer);
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        this.isConnected = false;
    }

    _status(msg) { if (this.onStatus) this.onStatus(msg); }
    _error(msg)  { if (this.onError)  this.onError(msg);  }
}
