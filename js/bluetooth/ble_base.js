/**
 * Gemeinsame Basis für alle Bluetooth-Geräte
 *
 * Kümmert sich um alles, was bei jedem Sensor gleich ist und vorher dreimal
 * leicht unterschiedlich (und jeweils fehlerhaft) implementiert war:
 *
 *   - Wiederverbinden mit ansteigenden Wartezeiten statt starrer 5 Sekunden
 *   - kein Wettlauf zwischen automatischem Wiederverbinden und manuellem Klick
 *   - Zeitgrenze für gatt.connect(), das auf Android sonst ewig hängen kann
 *   - der gattserverdisconnected-Zuhörer wird pro Gerät genau einmal registriert
 *   - stilles Wiederverbinden beim App-Start über getDevices(), wenn der Browser
 *     das unterstützt – schlägt es fehl, bleibt der normale Knopf der Weg
 *   - ein Zustandsmodell, aus dem die Oberfläche ehrlich ablesen kann, was los ist
 */

export const BleState = {
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    RECONNECTING: 'reconnecting',
};

const CONNECT_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 12_000, 20_000];

/** Merkt sich die zuletzt gekoppelte Geräte-Kennung je Sensortyp */
const ID_STORAGE_PREFIX = 'zone2-device-';

export class BleDevice {
    /**
     * @param {object} opts
     * @param {string} opts.key       – interner Schlüssel (h10, pm, d100)
     * @param {string} opts.label     – Anzeigename für Meldungen
     * @param {object} opts.filters   – Filter für requestDevice
     * @param {Array}  opts.services  – benötigte Dienste (optionalServices)
     */
    constructor({ key, label, filters, services }) {
        this.key      = key;
        this.label    = label;
        this._filters = filters;
        this._services = services;

        this.device = null;
        this.server = null;
        this.state  = BleState.DISCONNECTED;

        this._wanted        = false;  // soll verbunden sein
        this._busy          = false;  // ein Verbindungsversuch läuft gerade
        this._attempt       = 0;
        this._retryTimer    = null;
        this._listenerBound = false;
        this._lastDataTime  = 0;

        // Schrittprotokoll fuer die Fehlersuche. Ohne das laesst sich von aussen
        // nicht unterscheiden, ob schon die Verbindung, das Finden der Dienste
        // oder erst der Handschlag danach gescheitert ist.
        this.log = [];

        this.onConnect      = null;
        this.onDisconnect   = null;
        this.onError        = null;
        this.onStatus       = null;
        this.onStateChange  = null;   // (state, label) => void
    }

    static isAvailable() {
        return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    get isConnected() {
        return this.state === BleState.CONNECTED && !!this.device?.gatt?.connected;
    }

    /** Millisekunden seit dem letzten empfangenen Messwert (Infinity = noch nie) */
    dataAgeMs(now = Date.now()) {
        return this._lastDataTime ? now - this._lastDataTime : Infinity;
    }

    _markData() { this._lastDataTime = Date.now(); }

    // ── Verbinden ─────────────────────────────────────────────────────────────

    /** Mit Geräteauswahl – braucht eine Nutzergeste */
    async connect() {
        if (!BleDevice.isAvailable()) {
            this._error('Web Bluetooth ist hier nicht verfügbar. Bitte Chrome für Android verwenden.');
            return false;
        }
        if (this._busy) {
            this._status(`${this.label}: Verbindungsversuch läuft bereits`);
            return false;
        }

        // Ein laufender Wiederverbinden-Versuch darf dem Nutzerklick nicht
        // dazwischenfunken.
        this._cancelRetry();
        this._wanted = true;
        this._busy   = true;

        try {
            this._setState(BleState.CONNECTING);
            this._status(`Suche ${this.label}...`);
            this.device = await navigator.bluetooth.requestDevice({
                filters: this._filters,
                optionalServices: this._services,
            });
            this._rememberDevice();
            this._bindDisconnectListener();
            await this._connectGatt();
            return true;
        } catch (err) {
            this._busy = false;
            this._setState(BleState.DISCONNECTED);
            if (err.name === 'NotFoundError') {
                this._error(`${this.label}: kein Gerät ausgewählt.`);
            } else {
                this._error(this._humanError(err));
            }
            return false;
        } finally {
            this._busy = false;
        }
    }

    /**
     * Stiller Verbindungsversuch ohne Auswahldialog.
     * Setzt voraus, dass der Browser getDevices() unterstützt und das Gerät
     * bereits einmal erlaubt wurde. Schlägt es fehl, passiert nichts Sichtbares.
     */
    async tryAutoConnect() {
        if (!BleDevice.isAvailable()) return false;
        if (this.isConnected || this._busy) return false;
        if (typeof navigator.bluetooth.getDevices !== 'function') return false;

        let known = [];
        try {
            known = await navigator.bluetooth.getDevices();
        } catch {
            return false;
        }
        if (!known.length) return false;

        const savedId = this._savedDeviceId();
        const match = known.find((d) => d.id === savedId)
                   ?? known.find((d) => this._matchesFilters(d));
        if (!match) return false;

        this._wanted = true;
        this._busy   = true;
        this.device  = match;
        this._bindDisconnectListener();
        try {
            this._setState(BleState.CONNECTING);
            this._status(`${this.label}: verbinde automatisch...`);
            await this._connectGatt();
            this._rememberDevice();
            return true;
        } catch {
            // Gerät ist vermutlich aus oder außer Reichweite – kein Fehler für den Nutzer
            this._setState(BleState.DISCONNECTED);
            this._status(`${this.label}: nicht gefunden`);
            this._wanted = false;
            return false;
        } finally {
            this._busy = false;
        }
    }

    async _connectGatt() {
        if (!this.device?.gatt) throw new Error('Kein GATT-Server verfügbar');

        this._step(`${this.label}: verbinde...`);

        // gatt.connect() kann auf Android ohne Rückmeldung hängen bleiben.
        try {
            this.server = await this._withTimeout(
                this.device.gatt.connect(),
                CONNECT_TIMEOUT_MS,
                `${this.label}: Zeitüberschreitung beim Verbinden`
            );
        } catch (err) {
            // Die Zeitgrenze bricht nur unser Warten ab, nicht den Versuch
            // selbst. Ohne das Trennen bliebe womöglich eine halbfertige
            // Verbindung stehen, die jeden neuen Versuch blockiert.
            try { this.device.gatt.disconnect(); } catch { /* egal */ }
            this._step(`${this.label}: Verbinden fehlgeschlagen (${err.message})`, 'error');
            throw err;
        }

        this._step(`${this.label}: Verbindung steht, suche Dienste`);
        await this._setupServices(this.server);
        this._step(`${this.label}: Dienste bereit`);

        this._attempt = 0;
        this._markData();
        this._setState(BleState.CONNECTED);
        this._step(`${this.label} verbunden`, 'ok');
        if (this.onConnect) this.onConnect();

        // Alles ab hier ist Nachbereitung. Sie darf die bestehende Verbindung
        // nicht zu Fall bringen - und sie wird bewusst NICHT abgewartet: ein
        // Trainer, der den Handschlag nicht beantwortet, haelt sonst den
        // Kopplungsablauf eine halbe Minute lang auf, obwohl die Verbindung
        // laengst steht.
        this._afterConnect().catch((err) => {
            this._step(`${this.label}: Nachbereitung unvollständig (${err.message})`, 'warn');
        });
    }

    /** Nachbereitung nach hergestellter Verbindung. Fehler sind hier folgenlos. */
    async _afterConnect() { /* von Unterklassen */ }

    /** Von den Unterklassen zu implementieren: Dienste und Benachrichtigungen einrichten */
    async _setupServices(_server) {
        throw new Error('_setupServices muss überschrieben werden');
    }

    _withTimeout(promise, ms, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), ms);
            promise.then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); }
            );
        });
    }

    // ── Trennen und Wiederverbinden ───────────────────────────────────────────

    _bindDisconnectListener() {
        if (this._listenerBound || !this.device) return;
        this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
        this._listenerBound = true;
    }

    _onDisconnected() {
        this.server = null;
        const wasConnected = this.state === BleState.CONNECTED;
        this._setState(this._wanted ? BleState.RECONNECTING : BleState.DISCONNECTED);
        if (wasConnected) {
            this._status(`${this.label} getrennt`);
            if (this.onDisconnect) this.onDisconnect();
        }
        if (this._wanted) this._scheduleRetry();
    }

    _scheduleRetry() {
        if (!this._wanted || this._busy) return;
        this._cancelRetry();

        const delay = BACKOFF_MS[Math.min(this._attempt, BACKOFF_MS.length - 1)];
        this._attempt++;
        this._setState(BleState.RECONNECTING);
        this._status(`${this.label}: neuer Versuch in ${Math.round(delay / 1000)} s (${this._attempt}.)`);

        this._retryTimer = setTimeout(async () => {
            this._retryTimer = null;
            if (!this._wanted || this._busy) return;
            if (!this.device) { this._setState(BleState.DISCONNECTED); return; }

            this._busy = true;
            try {
                this._status(`${this.label}: verbinde erneut...`);
                await this._connectGatt();
            } catch {
                this._busy = false;
                this._scheduleRetry();
                return;
            }
            this._busy = false;
        }, delay);
    }

    _cancelRetry() {
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
    }

    /** Nutzer will das Gerät los – kein automatisches Wiederverbinden mehr */
    disconnect() {
        this._wanted = false;
        this._cancelRetry();
        this._attempt = 0;
        try {
            if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        } catch { /* egal */ }
        this._setState(BleState.DISCONNECTED);
    }

    /** Verbindung erzwungen neu aufbauen (z.B. nach Steuerungsverlust) */
    async forceReconnect() {
        if (!this.device) return false;
        this._cancelRetry();
        try {
            if (this.device.gatt?.connected) this.device.gatt.disconnect();
        } catch { /* egal */ }
        this._attempt = 0;
        this._wanted  = true;
        // gattserverdisconnected stößt das Wiederverbinden selbst an
        return true;
    }

    // ── Gerätekennung merken ──────────────────────────────────────────────────

    _savedDeviceId() {
        try { return localStorage.getItem(ID_STORAGE_PREFIX + this.key); } catch { return null; }
    }

    _rememberDevice() {
        try {
            if (this.device?.id) localStorage.setItem(ID_STORAGE_PREFIX + this.key, this.device.id);
        } catch { /* egal */ }
    }

    _matchesFilters(device) {
        const name = device.name ?? '';
        return this._filters.some((f) => {
            if (f.namePrefix) return name.startsWith(f.namePrefix);
            if (f.name)       return name === f.name;
            return false;
        });
    }

    // ── Meldungen ─────────────────────────────────────────────────────────────

    _humanError(err) {
        const msg = (err?.message ?? '').toLowerCase();
        if (err?.name === 'SecurityError') {
            return `${this.label}: Zugriff verweigert. Die Seite muss über HTTPS laufen.`;
        }
        if (err?.name === 'NetworkError' || msg.includes('already') || msg.includes('in use')) {
            return `${this.label} ist belegt – andere Apps (Zwift, MyWhoosh, Polar Flow) schließen und Bluetooth kurz aus- und wieder einschalten.`;
        }
        if (msg.includes('zeitüberschreitung')) {
            return `${this.label}: Zeitüberschreitung. Gerät wach? Bei Brustgurten hilft es, die Elektroden anzufeuchten.`;
        }
        return `${this.label}: ${err?.message ?? 'Verbindungsfehler'}`;
    }

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        if (this.onStateChange) this.onStateChange(state, this.label);
    }

    /** Schritt protokollieren und zugleich als Status melden */
    _step(msg, level = 'info') {
        this.log.push({ t: Date.now(), msg, level });
        if (this.log.length > 40) this.log.shift();
        this._status(msg);
    }

    _status(msg) { if (this.onStatus) this.onStatus(msg); }
    _error(msg)  { if (this.onError)  this.onError(msg);  }
}
