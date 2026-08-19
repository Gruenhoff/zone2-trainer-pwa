/**
 * Demo-Modus – Training ohne Rad und ohne Sensoren
 *
 * Aktivierung über ?demo=1 in der Adresszeile.
 *
 * Der Zweck ist nicht Spielerei: Bluetooth, Reglerverhalten, Drift-Abbruch,
 * Sensorausfall und die Wiederaufnahme nach einem Neustart lassen sich sonst
 * nur in echten Trainingseinheiten prüfen – ein Fehler in der Wiederaufnahme
 * fällt dann erst auf, wenn eine Stunde Daten weg ist.
 *
 * Enthalten sind:
 *   - ein einfaches physiologisches Modell (Herzfrequenz folgt der Leistung
 *     verzögert und driftet über die Zeit nach oben)
 *   - ein Zeitraffer, damit eine 80-Minuten-Einheit in gut einer Minute läuft
 *   - auslösbare Störungen: Brustgurt weg, Trainer getrennt, ERG verloren
 */

// ── Zeitraffer ────────────────────────────────────────────────────────────────

/**
 * Ersetzt Date.now() durch eine beschleunigte Uhr. Alles in der App rechnet
 * mit echten Zeitstempeln, dadurch verhalten sich Phasenlängen, Hysterese und
 * Drift-Fenster im Zeitraffer genauso wie in Echtzeit.
 */
const CLOCK_STORAGE_KEY = 'zone2-demo-clock';

export class DemoClock {
    constructor() {
        this._real  = Date.now.bind(Date);
        this._speed = 1;
        this._anchorReal = this._real();
        this._anchorFake = this._real();
        this._installed = false;
        this._restore();
    }

    /**
     * Die beschleunigte Uhr überlebt ein Neuladen der Seite.
     *
     * Ohne das spränge sie beim Neustart auf die echte Zeit zurück, und
     * ausgerechnet die Wiederaufnahme nach einem Absturz – der wichtigste Fall,
     * den der Demo-Modus prüfen soll – ließe sich nicht sinnvoll testen: die
     * gespeicherte Session läge dann in der Zukunft.
     */
    _restore() {
        try {
            const raw = sessionStorage.getItem(CLOCK_STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (typeof s.anchorFake !== 'number' || typeof s.anchorReal !== 'number') return;
            this._speed      = Math.max(1, s.speed ?? 1);
            this._anchorFake = s.anchorFake;
            this._anchorReal = s.anchorReal;
        } catch { /* Voreinstellung behalten */ }
    }

    _persist() {
        try {
            sessionStorage.setItem(CLOCK_STORAGE_KEY, JSON.stringify({
                anchorFake: this._anchorFake,
                anchorReal: this._anchorReal,
                speed:      this._speed,
            }));
        } catch { /* egal */ }
    }

    install() {
        if (this._installed) return;
        this._installed = true;
        this._persist();
        Date.now = () => this.now();
    }

    uninstall() {
        if (!this._installed) return;
        Date.now = this._real;
        this._installed = false;
    }

    now() {
        return Math.round(this._anchorFake + (this._real() - this._anchorReal) * this._speed);
    }

    get speed() { return this._speed; }

    setSpeed(factor) {
        // Beim Umschalten den aktuellen Stand festhalten, damit die Uhr nicht springt
        this._anchorFake = this.now();
        this._anchorReal = this._real();
        this._speed = Math.max(1, factor);
        this._persist();
    }
}

// ── Gefälschte Geräte ─────────────────────────────────────────────────────────

const State = {
    DISCONNECTED: 'disconnected',
    CONNECTED:    'connected',
    RECONNECTING: 'reconnecting',
};

class FakeDevice {
    constructor(key, label) {
        this.key   = key;
        this.label = label;
        this.state = State.DISCONNECTED;
        this._lastDataTime = 0;
        this.log = [];

        this.onConnect = null;
        this.onDisconnect = null;
        this.onError = null;
        this.onStatus = null;
        this.onStateChange = null;
    }

    static isAvailable() { return true; }
    get isConnected() { return this.state === State.CONNECTED; }
    dataAgeMs(now = Date.now()) { return this._lastDataTime ? now - this._lastDataTime : Infinity; }
    _markData() { this._lastDataTime = Date.now(); }

    async connect() {
        this._setState(State.CONNECTED);
        this._markData();
        this._step(`${this.label} verbunden (Demo)`, 'ok');
        this.onConnect?.();
        return true;
    }

    async tryAutoConnect() { return this.connect(); }

    disconnect() {
        this._setState(State.DISCONNECTED);
        this.onDisconnect?.();
    }

    /** Störung: Verbindung bricht weg und kommt nach einer Weile zurück */
    simulateDropout(reconnectAfterMs = 8000) {
        if (!this.isConnected) return;
        this._setState(State.RECONNECTING);
        this._status(`${this.label} getrennt (Demo-Störung)`);
        this.onDisconnect?.();
        setTimeout(() => {
            this._setState(State.CONNECTED);
            this._markData();
            this._status(`${this.label} wieder verbunden`);
            this.onConnect?.();
        }, reconnectAfterMs);
    }

    _setState(s) {
        if (this.state === s) return;
        this.state = s;
        this.onStateChange?.(s, this.label);
    }
    _step(msg, level = 'info') {
        this.log.push({ t: Date.now(), msg, level });
        if (this.log.length > 40) this.log.shift();
        this._status(msg);
    }

    _status(m) { this.onStatus?.(m); }
    _error(m)  { this.onError?.(m); }
}

class FakeH10 extends FakeDevice {
    constructor() {
        super('h10', 'Polar H10');
        this.onHeartRate = null;
        this.onRRInterval = null;
        this.onContactLost = null;
    }
    emit(hr) {
        if (!this.isConnected) return;
        this._markData();
        this.onHeartRate?.(Math.round(hr));
        this.onRRInterval?.(Math.round(60000 / hr));
    }
}

class FakePowermeter extends FakeDevice {
    constructor() {
        super('pm', 'Powermeter');
        this.onPower = null;
        this.onCadence = null;
    }
    emit(watts, cadence) {
        if (!this.isConnected) return;
        this._markData();
        this.onPower?.(Math.round(watts));
        this.onCadence?.(Math.round(cadence));
    }
}

class FakeD100 extends FakeDevice {
    constructor() {
        super('d100', 'D100');
        this.onPower = null;
        this.onCadence = null;
        this.onControlLost = null;
        this.onMachineStatus = null;

        this.lastTargetSent = null;
        this.lastAckTime = 0;
        this.hasControl = false;
        this.ergBroken = false;   // Störung: nimmt Vorgaben an, setzt sie aber nicht um
    }

    async takeControl() { this.hasControl = true; return true; }

    async setTargetPower(watts) {
        this.lastTargetSent = Math.round(watts);
        this.lastAckTime = Date.now();
        return this.isConnected;
    }
    async refreshTargetPower() { return this.setTargetPower(this.lastTargetSent ?? 0); }
    async reacquireControl() {
        this.ergBroken = false;
        this.hasControl = true;
        this.onMachineStatus?.('Steuerung zurückgeholt (Demo)');
        return true;
    }

    emit(watts, cadence) {
        if (!this.isConnected) return;
        this._markData();
        this.onPower?.(Math.round(watts));
        this.onCadence?.(Math.round(cadence));
    }

    /**
     * Störung: Trainer fällt aus dem ERG-Modus.
     * @param {boolean} silent – ohne Meldung an die App. Das ist der gefährliche
     *   Fall: der Trainer nimmt Befehle weiter entgegen, setzt sie aber nicht
     *   um. Nur der Abweichungs-Wächter kann das noch bemerken.
     */
    breakErg(silent = true) {
        this.ergBroken = true;
        this.hasControl = false;
        if (!silent) {
            this.onControlLost?.();
            this.onMachineStatus?.('ERG-Modus verloren (Demo-Störung)');
        }
    }
}

// ── Physiologisches Modell ────────────────────────────────────────────────────

/**
 * Herzfrequenz folgt der Leistung verzögert (Zeitkonstante ~40 s) und driftet
 * mit zunehmender Dauer nach oben. Der Driftanteil wächst schneller, je näher
 * die Leistung an der Schwelle liegt – dadurch erreicht eine zu harte Einheit
 * die Abbruchschwelle wirklich, eine ruhige dagegen nicht.
 */
class Rider {
    constructor() {
        this.restHR      = 62;
        this.wattPerBpm  = 1.55;     // Steigung der HR-Leistungs-Kurve
        this.hr          = 68;
        this.power       = 0;
        this.cadence     = 0;
        this.driftBpm    = 0;
        this.workSeconds = 0;
    }

    /**
     * @param {number} targetWatts – ERG-Vorgabe
     * @param {number} dtSec       – vergangene Simulationszeit
     * @param {boolean} pedaling
     * @param {boolean} counting   – zählt diese Zeit als Belastung (Arbeitsblock)
     */
    step(targetWatts, dtSec, pedaling, counting) {
        const wanted = pedaling ? targetWatts : 0;

        // Der Trainer regelt die Leistung in wenigen Sekunden ein
        const pTau = 3;
        this.power += (wanted - this.power) * Math.min(1, dtSec / pTau);
        if (pedaling) this.power += (Math.random() - 0.5) * 4;
        this.power = Math.max(0, this.power);

        this.cadence = pedaling ? 84 + (Math.random() - 0.5) * 6 : 0;

        if (counting) {
            this.workSeconds += dtSec;
            // Drift: etwa 1 bpm je 8 Minuten bei ruhiger Fahrt, deutlich mehr,
            // wenn die Leistung hoch liegt
            const load = Math.max(0, (this.power - 90) / 60);
            this.driftBpm += dtSec * (0.0016 + 0.0042 * load);
        }

        const steadyHR = this.restHR + this.power / this.wattPerBpm + this.driftBpm;
        const hrTau = this.power > this.hrToWatt(this.hr) ? 32 : 55;   // rauf schneller als runter
        this.hr += (steadyHR - this.hr) * Math.min(1, dtSec / hrTau);
        this.hr += (Math.random() - 0.5) * 0.7;
        this.hr = Math.max(45, Math.min(205, this.hr));
    }

    hrToWatt(hr) { return Math.max(0, (hr - this.restHR - this.driftBpm) * this.wattPerBpm); }
}

// ── Zusammenbau ───────────────────────────────────────────────────────────────

export class DemoRig {
    constructor() {
        this.clock = new DemoClock();
        this.h10   = new FakeH10();
        this.pm    = new FakePowermeter();
        this.d100  = new FakeD100();
        this.rider = new Rider();

        this._timer = null;
        this._lastTick = 0;
        this._hrSuppressedUntil = 0;
        this._ergAppliedWatts = 0;

        this.isWorkPhase = () => false;   // wird von der App gesetzt
    }

    start() {
        this.clock.install();
        this._lastTick = Date.now();
        this._restartTimer();
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        this.clock.uninstall();
    }

    /**
     * Der Sendetakt richtet sich nach der Simulationszeit, nicht nach der
     * Echtzeit. Sonst läge zwischen zwei Messwerten im 30-fachen Zeitraffer
     * eine halbe simulierte Minute – die App würde jeden Wert zu Recht als
     * veraltet verwerfen und im Zeitraffer wäre nichts zu testen.
     */
    _restartTimer() {
        clearInterval(this._timer);
        const intervalMs = Math.max(40, Math.round(1000 / this.clock.speed));
        this._timer = setInterval(() => this._tick(), intervalMs);
    }

    setSpeed(factor) {
        this.clock.setSpeed(factor);
        if (this._timer) this._restartTimer();
    }
    get speed() { return this.clock.speed; }

    _tick() {
        const now = Date.now();
        const dtSec = Math.max(0, (now - this._lastTick) / 1000);
        this._lastTick = now;
        if (dtSec <= 0) return;

        const target = this.d100.lastTargetSent ?? 0;

        // Bei gestörtem ERG bleibt der Trainer auf dem alten Wert stehen –
        // genau das soll der Wächter erkennen.
        if (!this.d100.ergBroken) this._ergAppliedWatts = target;

        const pedaling = this._ergAppliedWatts > 0;
        this.rider.step(this._ergAppliedWatts, dtSec, pedaling, this.isWorkPhase());

        if (now >= this._hrSuppressedUntil) {
            this.h10.emit(this.rider.hr);
        }
        this.pm.emit(this.rider.power, this.rider.cadence);
        this.d100.emit(this.rider.power * 0.98, this.rider.cadence);
    }

    // ── Störungen ─────────────────────────────────────────────────────────────

    /** Brustgurt sendet für n Sekunden (Simulationszeit) nichts mehr */
    faultHrDropout(seconds = 60) {
        this._hrSuppressedUntil = Date.now() + seconds * 1000;
    }

    faultTrainerDropout() { this.d100.simulateDropout(8000); }
    faultPowermeterDropout() { this.pm.simulateDropout(8000); }

    /**
     * Stiller ERG-Verlust: Der Trainer bestätigt weiter jede Vorgabe, hält die
     * Leistung aber auf einem eingefrorenen, deutlich niedrigeren Wert fest.
     * Genau dafür gibt es den Abweichungs-Wächter.
     */
    faultErgLost() {
        this.d100.breakErg(true);
        this._ergAppliedWatts = Math.max(20, Math.round(this._ergAppliedWatts * 0.55));
    }

    /** Setzt den Fahrer auf einen ermüdeten Zustand – Drift ist dann schnell da */
    fastForwardFatigue(bpm = 8) {
        this.rider.driftBpm += bpm;
    }
}

export function isDemoRequested() {
    try {
        return new URLSearchParams(location.search).get('demo') === '1';
    } catch {
        return false;
    }
}
