/**
 * Zone2 Trainer – Hauptcontroller
 *
 * Ablauf einer Einheit:
 *   Setup-Ansicht → START → Fahr-Ansicht → Aufwärmen → Arbeitsblock →
 *   Abkühlen → Zusammenfassung mit Teilen/Herunterladen
 *
 * Die drei Dinge, die den Betrieb auf einem Android-Handy stabil halten:
 *
 *   1. Ein Sekundentakt, der ausschließlich mit echten Zeitstempeln rechnet.
 *      Wird der Takt gedrosselt oder setzt er aus, stimmen Phasenlängen und
 *      Drift-Fenster trotzdem.
 *   2. Ein Schnappschuss, der jede Sekunde weggeschrieben wird. Startet die App
 *      neu, lässt sich die Einheit ohne Datenverlust fortsetzen.
 *   3. Konsequente Frischeprüfung aller Sensorwerte. Ein eingefrorener Messwert
 *      ist gefährlicher als ein fehlender, weil er wie ein gültiger aussieht.
 */

import { Config }              from './config.js';
import { Storage }             from './storage.js';
import { History }             from './history.js';
import { AudioCoach }          from './audio.js';
import { ScreenLock }          from './wakelock.js';
import { H10Bluetooth }        from './bluetooth/h10.js';
import { PowermeterBluetooth } from './bluetooth/powermeter.js';
import { D100Bluetooth }       from './bluetooth/d100.js';
import { BleState }            from './bluetooth/ble_base.js';
import { HRController }        from './algorithms/hr_controller.js';
import { PwHRDrift }           from './algorithms/pwhr_drift.js';
import { Session, Phase, PHASE_LABEL } from './session.js';
import { TrendChart, HistoryChart }    from './hr_chart.js';
import {
    buildFitFile, downloadFit, shareFit, canShareFit,
    fitFilename, recordsToFit, lapsToFit,
} from './fit_export.js';
import { DemoRig, isDemoRequested } from './demo.js';

const WATTS_STALE_MS    = 6000;    // danach gilt eine Leistungsangabe als tot
const SNAPSHOT_EVERY_MS = 1000;
const FLUSH_EVERY_MS    = 5000;
const CHART_EVERY_MS    = 3000;
const DRIFT_EVERY_MS    = 30_000;
const RESUME_MAX_AGE_MS = 6 * 3600 * 1000;
const STOP_HOLD_MS      = 1200;

const HRV_LABEL = { green: 'Grün', yellow: 'Gelb', red: 'Rot' };

class Zone2App {
    constructor() {
        this.cfg     = new Config();
        this.storage = new Storage();
        this.history = new History(this.storage);
        this.audio   = new AudioCoach();
        this.lock    = new ScreenLock();

        this.demo = isDemoRequested() ? new DemoRig() : null;
        if (this.demo) {
            this.h10  = this.demo.h10;
            this.pm   = this.demo.pm;
            this.d100 = this.demo.d100;
        } else {
            this.h10  = new H10Bluetooth();
            this.pm   = new PowermeterBluetooth();
            this.d100 = new D100Bluetooth();
        }

        this.controller = new HRController(this.cfg);
        this.drift      = new PwHRDrift();
        this.session    = new Session(this.cfg);

        // Live-Werte mit Zeitstempel – ohne den lässt sich nicht unterscheiden,
        // ob ein Wert aktuell ist oder seit Minuten festhängt.
        this.hr = null;         this.hrTime = 0;
        this.pmWatts = null;    this.pmTime = 0;
        this.trWatts = null;    this.trTime = 0;
        this.cadence = 0;       this.cadTime = 0;

        this._hrBuf = [];
        this._pmBuf = [];
        this._trBuf = [];

        this.targetWatts   = this.cfg.get('targetWatts');
        this.wattSource    = null;
        this.effWatts      = null;

        this.safetyActive    = false;
        this.preSafetyWatts  = null;
        this.hrWarned        = false;
        this.driftAborted    = false;
        this.lastDrift       = null;
        this.driftResult     = null;

        this._loop       = null;
        this._lastSnapshot = 0;
        this._lastFlush    = 0;
        this._snapshotInFlight = false;
        this._flushInFlight    = false;
        this._recordBacklog    = [];
        this._lastChart    = 0;
        this._lastDriftCalc = 0;
        this._lastErgRefresh = 0;
        this._ergDeviationSince = 0;
        this._lastReacquire = 0;
        this._eventText = '';

        this._pendingFit = null;   // { bytes, filename, summary }
        this._resumeSnapshot = null;

        this.rideChart    = null;
        this.historyChart = null;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Start
    // ══════════════════════════════════════════════════════════════════════

    async init() {
        this._bindDom();
        this._bindSensors();
        this._loadSettingsIntoForm();

        this.rideChart    = new TrendChart(this.$('ride-chart'));
        this.historyChart = new HistoryChart(this.$('history-chart'));
        this._applyThresholdsToChart();

        this.lock.init();
        this.lock.onChange = (active, reason) => {
            this.$('rdot-lock').classList.toggle('connected', active);
            this._renderLockWarning();
            if (!active && this.session.isRunning) {
                if (reason) this._toast(reason, 'warn');
                this.audio.announce('warn', 'Achtung, Bildschirm bleibt nicht an');
            }
        };

        const storageOk = await this.storage.isAvailable();
        this.$('storage-hint').textContent = storageOk
            ? 'Sitzungsdaten werden laufend gesichert – ein Neustart der App kostet dich keine Einheit.'
            : 'Achtung: Dieser Browser erlaubt keinen dauerhaften Speicher. Eine unterbrochene Session lässt sich dann nicht wiederherstellen.';

        await this.history.load();
        this._renderHistory();
        this._renderWeek();

        if (this.demo) this._startDemo();

        await this._checkForInterruptedSession();

        // Stiller Verbindungsversuch – klappt nur, wenn der Browser bereits
        // erlaubte Geräte wiederfindet. Schlägt er fehl, passiert nichts.
        this._autoConnect();

        this._registerServiceWorker();
    }

    // ══════════════════════════════════════════════════════════════════════
    // Oberfläche verdrahten
    // ══════════════════════════════════════════════════════════════════════

    $(id) { return document.getElementById(id); }

    _bindDom() {
        // Die erste Berührung gibt Ton und Sprache frei – auf Android geht das
        // ausschließlich aus einer echten Nutzergeste heraus.
        const unlock = () => this.audio.unlock();
        document.addEventListener('pointerdown', unlock, { once: true });
        document.addEventListener('keydown', unlock, { once: true });

        this.$('btn-connect-all').addEventListener('click', () => this._connectAll());
        this.$('btn-connect-h10').addEventListener('click',  () => this.h10.connect());
        this.$('btn-connect-pm').addEventListener('click',   () => this.pm.connect());
        this.$('btn-connect-d100').addEventListener('click', () => this.d100.connect());

        document.querySelectorAll('.tab-btn').forEach((b) => {
            b.addEventListener('click', () => this._switchTab(b.dataset.tab));
        });

        document.querySelectorAll('#hrv-group .seg').forEach((b) => {
            b.addEventListener('click', () => this._setHrv(b.dataset.status));
        });

        this._bindNumber('in-target-watts',  'targetWatts',        () => this._syncTargetFromForm());
        this._bindNumber('in-work-min',      'workTargetMin');
        this._bindNumber('in-warmup-min',    'warmupDurationMin');
        this._bindNumber('in-cooldown-min',  'cooldownDurationMin');
        this._bindNumber('in-reduction-hr',  'reductionHR',        () => this._applyThresholdsToChart());
        this._bindNumber('in-hysteresis',    'hysteresisReset',    () => this._applyThresholdsToChart());
        this._bindNumber('in-drift-abort',   'driftAbortPercent',  null, true);
        this._bindNumber('in-safety-watts',  'safetyWatts');

        this._bindCheck('cb-trend',    'trendEnabled');
        this._bindCheck('cb-increase', 'increaseEnabled');
        this._bindCheck('cb-sound',    'soundEnabled', (v) => { this.audio.soundEnabled = v; });
        this._bindCheck('cb-speech',   'speechEnabled', (v) => {
            this.audio.speechEnabled = v;
            if (!v) this.audio.stopSpeech();
        });

        this.$('btn-start').addEventListener('click', () => this._startSession());
        this.$('btn-plus5').addEventListener('click',  () => this._manualWatt(+5));
        this.$('btn-plus10').addEventListener('click', () => this._manualWatt(+10));
        this.$('btn-minus5').addEventListener('click', () => this._manualWatt(-5));
        this.$('btn-cooldown').addEventListener('click', () => this._manualCooldown());
        this._bindStopButton();

        this.$('btn-export-csv').addEventListener('click', () => this.history.downloadCSV());
        this.$('btn-copy-diag').addEventListener('click', () => this._copyDiagnostics());

        this.$('btn-resume').addEventListener('click',      () => this._resumeSession());
        this.$('btn-resume-save').addEventListener('click', () => this._salvageSession());
        this.$('btn-resume-drop').addEventListener('click', () => this._discardSnapshot());

        this.$('btn-share-fit').addEventListener('click',    () => this._shareFit());
        this.$('btn-download-fit').addEventListener('click', () => this._downloadFit());
        this.$('btn-summary-close').addEventListener('click', () => this.$('summary-overlay').classList.add('hidden'));

        this.$('fatal-reload').addEventListener('click', () => location.reload());
        this.$('fatal-reset').addEventListener('click',  () => this._hardReset());

        // Verlassen der Seite während einer Einheit absichern
        window.addEventListener('beforeunload', (e) => {
            if (this.session.isRunning) { e.preventDefault(); e.returnValue = ''; }
        });

        // Beim Wegblenden sofort sichern, statt auf den nächsten Takt zu warten
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && this.session.isRunning) {
                this._saveSnapshot(true);
            }
        });
    }

    _bindNumber(id, key, after = null, decimal = false) {
        const el = this.$(id);
        if (!el) return;
        el.addEventListener('change', () => {
            const raw = decimal ? parseFloat(el.value) : parseInt(el.value, 10);
            if (isNaN(raw)) { el.value = this.cfg.get(key); return; }
            const applied = this.cfg.set(key, raw);
            el.value = applied;
            if (after) after(applied);
        });
    }

    _bindCheck(id, key, after = null) {
        const el = this.$(id);
        if (!el) return;
        el.addEventListener('change', () => {
            this.cfg.set(key, el.checked);
            if (after) after(el.checked);
        });
    }

    _loadSettingsIntoForm() {
        const set = (id, v) => { const el = this.$(id); if (el) el.value = v; };
        set('in-target-watts', this.cfg.get('targetWatts'));
        set('in-work-min',     this.cfg.get('workTargetMin'));
        set('in-warmup-min',   this.cfg.get('warmupDurationMin'));
        set('in-cooldown-min', this.cfg.get('cooldownDurationMin'));
        set('in-reduction-hr', this.cfg.get('reductionHR'));
        set('in-hysteresis',   this.cfg.get('hysteresisReset'));
        set('in-drift-abort',  this.cfg.get('driftAbortPercent'));
        set('in-safety-watts', this.cfg.get('safetyWatts'));

        const chk = (id, v) => { const el = this.$(id); if (el) el.checked = !!v; };
        chk('cb-trend',    this.cfg.get('trendEnabled'));
        chk('cb-increase', this.cfg.get('increaseEnabled'));
        chk('cb-sound',    this.cfg.get('soundEnabled'));
        chk('cb-speech',   this.cfg.get('speechEnabled'));

        this.audio.soundEnabled  = !!this.cfg.get('soundEnabled');
        this.audio.speechEnabled = !!this.cfg.get('speechEnabled');

        this.targetWatts = this.cfg.get('targetWatts');
        this._setHrv(this.cfg.get('hrvStatus'), false);
    }

    _syncTargetFromForm() {
        if (!this.session.isRunning) this.targetWatts = this.cfg.get('targetWatts');
    }

    _bindStopButton() {
        const btn  = this.$('btn-stop');
        const fill = this.$('stop-fill');
        let timer = null;
        let start = 0;
        let raf   = null;

        const cancel = () => {
            clearTimeout(timer); timer = null;
            if (raf) cancelAnimationFrame(raf);
            raf = null;
            fill.style.width = '0%';
        };
        const animate = () => {
            const pct = Math.min(100, ((performance.now() - start) / STOP_HOLD_MS) * 100);
            fill.style.width = pct + '%';
            if (pct < 100) raf = requestAnimationFrame(animate);
        };

        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            start = performance.now();
            raf = requestAnimationFrame(animate);
            timer = setTimeout(() => { cancel(); this._stopSession('gestoppt'); }, STOP_HOLD_MS);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
            btn.addEventListener(ev, cancel)
        );
    }

    _switchTab(tab) {
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        this.$(`tab-${tab}`)?.classList.remove('hidden');
        document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
        if (tab === 'history') { this._renderHistory(); this.historyChart?.invalidate(); }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Sensoren
    // ══════════════════════════════════════════════════════════════════════

    _bindSensors() {
        // ── Herzfrequenz ──────────────────────────────────────────────────
        this.h10.onRRInterval = (rrMs) => {
            if (rrMs < 273 || rrMs > 1500) return;      // 40–220 bpm
            this._hrBuf.push(rrMs);
            if (this._hrBuf.length > 4) this._hrBuf.shift();
            if (this._hrBuf.length >= 3) {
                const avg = this._hrBuf.reduce((a, b) => a + b, 0) / this._hrBuf.length;
                this._acceptHR(Math.round(60000 / avg));
            }
        };
        this.h10.onHeartRate = (bpm) => {
            // Nur solange noch keine RR-Intervalle vorliegen – die sind schneller
            if (this._hrBuf.length < 3) this._acceptHR(bpm);
        };
        this.h10.onContactLost = () => this._toast('H10 meldet keinen Hautkontakt – Elektroden anfeuchten.', 'warn');

        // ── Leistung ──────────────────────────────────────────────────────
        this.pm.onPower = (w) => {
            this._pmBuf.push(Math.max(0, w));
            if (this._pmBuf.length > 3) this._pmBuf.shift();
            this.pmWatts = Math.round(this._pmBuf.reduce((a, b) => a + b, 0) / this._pmBuf.length);
            this.pmTime  = Date.now();
        };
        this.pm.onCadence = (rpm) => { this.cadence = rpm; this.cadTime = Date.now(); };

        this.d100.onPower = (w) => {
            this._trBuf.push(Math.max(0, w));
            if (this._trBuf.length > 3) this._trBuf.shift();
            this.trWatts = Math.round(this._trBuf.reduce((a, b) => a + b, 0) / this._trBuf.length);
            this.trTime  = Date.now();
        };
        this.d100.onCadence = (rpm) => {
            // Der Kurbelmesser hat Vorrang, wenn er gerade liefert
            if (Date.now() - this.cadTime > 4000) { this.cadence = rpm; this.cadTime = Date.now(); }
        };

        this.d100.onControlLost = () => {
            if (this.session.isRunning) this._reacquireErg('Trainer meldet Steuerungsverlust');
        };
        this.d100.onMachineStatus = (text) => this._toast(text, 'warn');
        this.d100.onConnect = () => {
            this._updateDeviceRow('d100');
            // Nach dem Verbinden sofort die aktuelle Vorgabe setzen
            if (this.session.isRunning) this.d100.setTargetPower(this.targetWatts);
        };

        // ── Zustand und Meldungen für alle drei ───────────────────────────
        for (const [key, dev] of Object.entries({ h10: this.h10, pm: this.pm, d100: this.d100 })) {
            dev.onStateChange = () => this._updateDeviceRow(key);
            dev.onStatus      = (m) => { this._updateDeviceRow(key, m); };
            dev.onError       = (m) => this._toast(m, 'error');
            if (key !== 'd100') {
                dev.onConnect    = () => this._updateDeviceRow(key);
            }
            dev.onDisconnect = () => {
                this._updateDeviceRow(key);
                if (key === 'h10') this._hrBuf = [];
                if (this.session.isRunning) {
                    this._toast(`${dev.label} getrennt – die App verbindet automatisch weiter.`, 'warn');
                }
            };
        }
    }

    _acceptHR(bpm) {
        if (!bpm || bpm < 30 || bpm > 230) return;
        this.hr     = bpm;
        this.hrTime = Date.now();
    }

    /** Reihenfolge der geführten Kopplung: erst das Nötige, dann das Optionale */
    _connectOrder() {
        return [
            ['h10',  this.h10],
            ['d100', this.d100],
            ['pm',   this.pm],
        ];
    }

    /**
     * Geführte Kopplung.
     *
     * Chrome verlangt für jeden Geräteauswahl-Dialog eine frische Nutzergeste;
     * eine Schleife über alle drei Geräte in einem einzigen Klick scheitert
     * deshalb ab dem zweiten Dialog. Stattdessen koppelt ein Tipp genau ein
     * Gerät, und der Knopf sagt danach an, was als Nächstes kommt.
     */
    async _connectAll() {
        this.audio.unlock();
        const next = this._connectOrder().find(([, d]) => !d.isConnected);
        if (!next) { this._updateConnectAllButton(); return; }

        const [key, dev] = next;
        const btn = this.$('btn-connect-all');
        btn.disabled = true;
        try {
            const ok = await dev.connect();
            if (!ok && key === 'h10') {
                this._toast('Ohne Herzfrequenz kann die App nicht regeln.', 'warn');
            }
        } finally {
            btn.disabled = false;
            this._updateConnectAllButton();
        }
    }

    _updateConnectAllButton() {
        const btn = this.$('btn-connect-all');
        if (!btn) return;
        const order   = this._connectOrder();
        const missing = order.filter(([, d]) => !d.isConnected);
        const done    = order.length - missing.length;

        if (!missing.length) {
            btn.textContent = 'Alle Sensoren verbunden';
            btn.disabled = true;
            return;
        }
        btn.disabled = false;
        const label = { h10: 'Polar H10', d100: 'D100 Trainer', pm: 'Powermeter' }[missing[0][0]];
        btn.textContent = done === 0
            ? `Alle verbinden – Schritt 1: ${label}`
            : `Weiter (${done + 1}/3): ${label}`;
    }

    async _autoConnect() {
        for (const dev of [this.h10, this.d100, this.pm]) {
            try { await dev.tryAutoConnect(); } catch { /* still bleiben */ }
        }
    }

    _updateDeviceRow(key, statusMsg = null) {
        const dev = { h10: this.h10, pm: this.pm, d100: this.d100 }[key];
        if (!dev) return;

        const label = {
            [BleState.CONNECTED]:    'verbunden',
            [BleState.CONNECTING]:   'verbinde…',
            [BleState.RECONNECTING]: 'verbinde neu…',
            [BleState.DISCONNECTED]: 'nicht verbunden',
        }[dev.state] ?? dev.state;

        const stateEl = this.$(`state-${key}`);
        if (stateEl) stateEl.textContent = statusMsg ?? label;

        for (const id of [`dot-${key}`, `rdot-${key}`]) {
            const dot = this.$(id);
            if (!dot) continue;
            dot.className = 'dot' + (id.startsWith('rdot') ? '' : '');
            dot.classList.remove('connected', 'connecting', 'reconnecting', 'stale');
            if (dev.state === BleState.CONNECTED)         dot.classList.add('connected');
            else if (dev.state === BleState.CONNECTING)   dot.classList.add('connecting');
            else if (dev.state === BleState.RECONNECTING) dot.classList.add('reconnecting');
        }

        const btn = this.$(`btn-connect-${key}`);
        if (btn) btn.textContent = dev.isConnected ? 'trennen' : 'verbinden';

        this._updateWattSourceHint();
        this._updateConnectAllButton();
        this._renderDiagnostics();
    }

    /**
     * Verbindungsprotokoll aller drei Geräte.
     *
     * Ohne das ist von außen nicht zu unterscheiden, ob eine fehlgeschlagene
     * Kopplung schon an der Bluetooth-Verbindung, am Finden des FTMS-Dienstes
     * oder erst am Handschlag danach scheitert – und genau diese Unterscheidung
     * entscheidet, was zu tun ist.
     */
    _renderDiagnostics() {
        const el = this.$('diag-log');
        if (!el) return;

        const eintraege = [];
        for (const dev of [this.h10, this.pm, this.d100]) {
            for (const e of (dev.log ?? [])) eintraege.push(e);
        }
        if (!eintraege.length) { el.textContent = 'Noch keine Einträge.'; return; }

        eintraege.sort((a, b) => a.t - b.t);

        el.innerHTML = eintraege.slice(-60).map((e) => {
            const zeit = new Date(e.t).toLocaleTimeString('de-DE', { hour12: false });
            const cls  = e.level && e.level !== 'info' ? ` class="lvl-${e.level}"` : '';
            const text = String(e.msg)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<span${cls}>${zeit}  ${text}</span>`;
        }).join('\n');
    }

    async _copyDiagnostics() {
        const zeilen = [];
        zeilen.push('Zone2 Trainer – Verbindungsprotokoll');
        zeilen.push(new Date().toLocaleString('de-DE'));
        zeilen.push(navigator.userAgent);
        zeilen.push(`Web Bluetooth: ${!!navigator.bluetooth}, getDevices: ${typeof navigator.bluetooth?.getDevices === 'function'}`);
        zeilen.push('');
        for (const dev of [this.h10, this.pm, this.d100]) {
            zeilen.push(`--- ${dev.label} (${dev.state}) ---`);
            for (const e of (dev.log ?? [])) {
                zeilen.push(`${new Date(e.t).toLocaleTimeString('de-DE', { hour12: false })}  [${e.level ?? 'info'}] ${e.msg}`);
            }
            zeilen.push('');
        }
        const text = zeilen.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            this._toast('Protokoll kopiert.', 'ok');
        } catch {
            // Ohne Zwischenablage-Freigabe wenigstens sichtbar machen
            this.$('diag-log').textContent = text;
            this._toast('Zwischenablage nicht erlaubt – Text steht oben zum Markieren.', 'warn');
        }
    }

    _updateWattSourceHint() {
        const el = this.$('watt-source-hint');
        if (!el) return;
        el.textContent = this.pm.isConnected
            ? 'Leistung kommt vom Kurbel-Powermeter.'
            : 'Ohne Powermeter wird die Leistung des D100 verwendet.';
    }

    // ══════════════════════════════════════════════════════════════════════
    // Session starten, fortsetzen, beenden
    // ══════════════════════════════════════════════════════════════════════

    _startSession() {
        if (this.session.isRunning) return;
        this.audio.unlock();

        if (!this.h10.isConnected && !this.demo) {
            this._toast('Kein Brustgurt verbunden – die HR-Regelung bleibt aus.', 'warn');
        }
        if (!this.d100.isConnected && !this.demo) {
            this._toast('Kein Trainer verbunden – die Watt-Vorgabe wird nirgends gesetzt.', 'warn');
        }

        const now = Date.now();
        this.controller.reset();
        this.drift.reset();
        this._resetRuntimeState();

        this.targetWatts = this.session.start(this.cfg.get('targetWatts'), now);
        this._sendTarget();

        if (this.session.phase === Phase.WORK) this.drift.setWorkBlockStart(now);

        this._enterRideView();
        this.lock.enable();
        this._startLoop();

        this._event('Session gestartet');
        this.audio.announce('phase', this.session.phase === Phase.WARMUP
            ? 'Aufwärmen startet'
            : 'Arbeitsblock startet');
    }

    _resetRuntimeState() {
        this._hrBuf = []; this._pmBuf = []; this._trBuf = [];
        this.safetyActive   = false;
        this.preSafetyWatts = null;
        this.hrWarned       = false;
        this.driftAborted   = false;
        this.lastDrift      = null;
        this.driftResult    = null;
        this._lastSnapshot = 0; this._lastFlush = 0; this._lastChart = 0;
        this._snapshotInFlight = false; this._flushInFlight = false;
        this._recordBacklog = [];
        this._lastDriftCalc = 0; this._lastErgRefresh = 0;
        this._ergDeviationSince = 0;
        this.rideChart?.setData([]);
    }

    _startLoop() {
        clearInterval(this._loop);
        this._loop = setInterval(() => {
            try {
                this._tick();
            } catch (err) {
                // Ein Fehler im Takt darf die Einheit nicht beenden
                console.error('[tick]', err);
                this._toast(`Fehler im Ablauf: ${err.message}`, 'error');
            }
        }, 1000);
    }

    _stopLoop() {
        clearInterval(this._loop);
        this._loop = null;
    }

    _manualCooldown() {
        if (this.session.phase !== Phase.WORK) return;
        const now = Date.now();
        const change = this.session.toCooldown('manuell', now);
        if (change) this._onPhaseChange(change, now);
    }

    _stopSession(reason = 'gestoppt') {
        if (!this.session.isRunning) return;
        const now = Date.now();
        this.session.stop(now);
        this._finishSession(now, reason);
    }

    async _finishSession(now, reason) {
        // Der Abschluss kann aus zwei Richtungen kommen (Phasenwechsel und
        // Stop-Taste). Ohne diese Sperre landete die Einheit doppelt im Verlauf.
        if (this._finishing) return;
        this._finishing = true;

        this._stopLoop();
        this.lock.disable();
        this.audio.announce('finish', 'Einheit beendet');

        const summary = this.session.summary;
        this._leaveRideView();

        try {
            if (!summary) { await this._discardSnapshot(); return; }

            // Restliche Messpunkte sichern, samt eines Stapels, dessen
            // Schreibvorgang zuvor nicht durchgekommen war
            const rest = this._recordBacklog.concat(this.session.drainPending());
            this._recordBacklog = [];
            await this.storage.appendRecords(this.session.id, rest);

            const meta = {
                id:               this.session.id,
                date:             summary.date.toISOString(),
                hrvStatus:        this.cfg.get('hrvStatus'),
                workDurationSec:  summary.workDurationSec,
                totalDurationSec: summary.totalDurationSec,
                avgHR:            summary.avgHR,
                maxHR:            summary.maxHR,
                avgWatts:         summary.avgWatts,
                ef:               summary.ef,
                driftAtEnd:       this.lastDrift,
                endReason:        summary.endReason ?? reason,
                targetWatts:      summary.targetWatts,
            };

            await this.history.add(meta);
            this._renderHistory();
            this._renderWeek();

            // Erst die Datei bauen, dann den Schnappschuss löschen – andersherum
            // wäre bei einem Fehler beides weg.
            await this._buildAndStoreFit(summary, meta);
            await this.storage.clearSnapshot();

            this._showSummary(meta);
        } catch (err) {
            this._toast(`Session konnte nicht vollständig gesichert werden: ${err.message}`, 'error');
            console.error('[finish]', err);
        } finally {
            this.session.reset();
            this.controller.reset();
            this.drift.reset();
            this._finishing = false;
        }
    }

    async _buildAndStoreFit(summary, meta) {
        try {
            const records = recordsToFit(this.session.records);
            if (!records.length) { this._pendingFit = null; return; }

            const bytes = buildFitFile(
                records,
                lapsToFit(this.session.laps),
                summary.date,
                summary.endDate,
                summary.avgHR,
                summary.avgWatts
            );
            const filename = fitFilename(summary.date);
            await this.storage.putFit(meta.id, bytes, filename);
            this._pendingFit = { bytes, filename, id: meta.id };
        } catch (err) {
            this._pendingFit = null;
            this._toast(`FIT-Datei konnte nicht erzeugt werden: ${err.message}`, 'error');
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Sekundentakt
    // ══════════════════════════════════════════════════════════════════════

    _tick() {
        const now   = Date.now();
        const phase = this.session.phase;
        if (phase === Phase.IDLE || phase === Phase.FINISHED) { this._stopLoop(); return; }

        // ── Frische der Sensorwerte bestimmen ─────────────────────────────
        const hrAge   = this.hrTime ? now - this.hrTime : Infinity;
        const hrValid = hrAge < this.cfg.get('hrStaleWarnSec') * 1000;

        this._resolveWattSource(now);
        const wattsValid = this.effWatts != null;
        const pedaling   = (now - this.cadTime < 6000 && this.cadence > 25)
                        || (wattsValid && this.effWatts > 20);

        // ── Ausfallabsicherung ────────────────────────────────────────────
        this._handleHrLoss(hrAge, now);

        // ── Session-Zustandsmaschine ──────────────────────────────────────
        const res = this.session.tick({
            hr: this.hr, hrValid,
            watts: this.effWatts, wattsValid,
            cadence: this.cadence,
            targetWatts: this.targetWatts,
            now,
        });

        if (res.warmupStep !== null && res.warmupStep > 0) {
            this.audio.announce('step', `Stufe ${res.warmupStep + 1}`);
        }
        if (res.targetWatts !== null && !this.safetyActive) {
            this._setTargetExternal(res.targetWatts, null);
        }
        if (res.phaseChange) {
            this._onPhaseChange(res.phaseChange, now);
            // Ist die Einheit damit beendet, hat _finishSession bereits
            // aufgeräumt – der Rest des Takts würde auf leerem Zustand laufen.
            if (this.session.phase === Phase.FINISHED || this.session.phase === Phase.IDLE) return;
        }

        // ── Regelung (nur im Arbeitsblock, nicht im Sicherheitsmodus) ─────
        if (this.session.phase === Phase.WORK && !this.safetyActive) {
            const decision = this.controller.tick({
                hr: this.hr,
                hrValid,
                targetWatts: this.targetWatts,
                ceilingWatts: this.cfg.get('increaseEnabled') ? this.session.plannedTargetWatts : 0,
                now,
            });
            if (decision) {
                this._applyControllerWatts(decision);
            }
        }

        // ── Drift ─────────────────────────────────────────────────────────
        if (this.session.phase === Phase.WORK) {
            this.drift.addSample(this.hr, this.effWatts, now, hrValid && wattsValid);
            if (now - this._lastDriftCalc >= DRIFT_EVERY_MS) {
                this._lastDriftCalc = now;
                this._evaluateDrift(now);
            }
        }

        // ── ERG-Überwachung ───────────────────────────────────────────────
        this._watchErg(now, pedaling, wattsValid);

        // ── Sichern ───────────────────────────────────────────────────────
        if (now - this._lastSnapshot >= SNAPSHOT_EVERY_MS) this._saveSnapshot();
        if (now - this._lastFlush >= FLUSH_EVERY_MS) {
            this._lastFlush = now;
            this._flushRecords();
        }

        // ── Anzeige ───────────────────────────────────────────────────────
        this._renderRide(now, hrValid, hrAge);
        if (now - this._lastChart >= CHART_EVERY_MS) {
            this._lastChart = now;
            this.rideChart?.setData(this.session.records);
        }
    }

    /** Kurbel bevorzugt, Trainer als Rückfall – jeweils nur mit frischen Daten */
    _resolveWattSource(now) {
        const pmFresh = this.pmTime && (now - this.pmTime) < WATTS_STALE_MS;
        const trFresh = this.trTime && (now - this.trTime) < WATTS_STALE_MS;

        if (pmFresh) {
            this.effWatts   = this.pmWatts;
            this.wattSource = 'Kurbel';
        } else if (trFresh) {
            this.effWatts   = this.trWatts;
            this.wattSource = 'D100';
        } else {
            this.effWatts   = null;
            this.wattSource = null;
        }
    }

    /**
     * Gestufte Reaktion auf fehlende Herzfrequenz:
     * warnen, dann auf ein Sicherheits-Watt absichern, bei Rückkehr zurück.
     */
    _handleHrLoss(hrAge, now) {
        const warnMs = this.cfg.get('hrStaleWarnSec') * 1000;
        const safeMs = this.cfg.get('hrStaleSafeSec') * 1000;
        const phase  = this.session.phase;

        if (hrAge < warnMs) {
            if (this.safetyActive) {
                // Herzfrequenz ist zurück – wieder auf den vorherigen Wert
                this.safetyActive = false;
                const back = this.preSafetyWatts ?? this.session.plannedTargetWatts;
                this.preSafetyWatts = null;
                this._setTargetExternal(back, 'Herzfrequenz zurück');
                this.audio.announce('up', 'Herzfrequenz wieder da');
                this._alert(null);
            } else if (this.hrWarned) {
                this._alert(null);
            }
            this.hrWarned = false;
            return;
        }

        if (phase !== Phase.WARMUP && phase !== Phase.WORK) return;

        if (!this.hrWarned) {
            this.hrWarned = true;
            this.audio.announce('warn', 'Keine Herzfrequenz');
        }

        if (hrAge >= safeMs && phase === Phase.WORK && !this.safetyActive) {
            this.safetyActive   = true;
            this.preSafetyWatts = this.targetWatts;
            const safe = Math.min(this.targetWatts, this.cfg.get('safetyWatts'));
            this._setTargetExternal(safe, 'Sicherheitsmodus');
            this.audio.announce('alarm', `Keine Herzfrequenz. Leistung auf ${safe} Watt reduziert.`);
            this._toast('Keine Herzfrequenz – Leistung abgesenkt. Gurt und Sitz prüfen.', 'error');
        }

        const sec = Math.round(hrAge / 1000);
        this._alert(this.safetyActive
            ? `Keine Herzfrequenz seit ${sec} s – Sicherheitsmodus, ${this.targetWatts} W`
            : `Keine Herzfrequenz seit ${sec} s`, this.safetyActive ? 'error' : 'warn');
    }

    _evaluateDrift(now) {
        const result = this.drift.calculate(now);
        this.driftResult = result;
        if (!result.ready) return;

        this.lastDrift = result.drift;

        const abort = this.cfg.get('driftAbortPercent');
        if (!this.driftAborted && result.drift >= abort) {
            this.driftAborted = true;
            this._toast(`Drift ${result.drift.toFixed(1)} % – Arbeitsblock beendet.`, 'warn');
            this.audio.announce('alarm', `Drift ${Math.round(result.drift)} Prozent. Abkühlen beginnt.`);
            const change = this.session.toCooldown('drift', now);
            if (change) this._onPhaseChange(change, now);
        }
    }

    /**
     * Hält den Trainer im ERG-Modus und erkennt, wenn er die Vorgabe
     * stillschweigend nicht mehr umsetzt.
     */
    _watchErg(now, pedaling, wattsValid) {
        if (!this.d100.isConnected) { this._ergDeviationSince = 0; return; }

        // Vorsorglich erneut senden
        if (now - this._lastErgRefresh >= this.cfg.get('ergRefreshSec') * 1000) {
            this._lastErgRefresh = now;
            this.d100.refreshTargetPower();
        }

        if (!pedaling || !wattsValid || this.targetWatts <= 0) {
            this._ergDeviationSince = 0;
            return;
        }

        const deviation = Math.abs(this.effWatts - this.targetWatts) / this.targetWatts * 100;
        if (deviation < this.cfg.get('ergDeviationPercent')) {
            this._ergDeviationSince = 0;
            return;
        }

        if (!this._ergDeviationSince) { this._ergDeviationSince = now; return; }

        if (now - this._ergDeviationSince >= this.cfg.get('ergDeviationSec') * 1000) {
            this._ergDeviationSince = 0;
            this._reacquireErg(`Leistung weicht ${Math.round(deviation)} % von der Vorgabe ab`);
        }
    }

    async _reacquireErg(why) {
        const now = Date.now();
        if (now - this._lastReacquire < 20_000) return;   // nicht im Sekundentakt hämmern
        this._lastReacquire = now;
        this._event(`ERG wird neu gesetzt (${why})`);
        const ok = await this.d100.reacquireControl();
        this._toast(ok ? 'ERG-Steuerung neu gesetzt.' : 'ERG-Steuerung konnte nicht zurückgeholt werden.',
                    ok ? 'ok' : 'error');
    }

    // ══════════════════════════════════════════════════════════════════════
    // Watt-Vorgabe
    // ══════════════════════════════════════════════════════════════════════

    _applyControllerWatts(decision) {
        // Kommt vom Regler – dessen Rampe führt ihren Bezugswert selbst nach,
        // deshalb hier ausdrücklich kein noteExternalChange().
        const old  = this.targetWatts;
        const next = this._clampWatts(decision.watts);
        if (next === old) return;

        this.targetWatts = next;
        this._sendTarget();

        const delta = next - old;
        this._event(`${delta > 0 ? '+' : '−'}${Math.abs(delta)} W · ${decision.reason}`);
        this.audio.announce(decision.kind, `${next} Watt`);
        this._renderTarget();
    }

    /** Änderung von außerhalb des Reglers – die laufende Rampe muss mitziehen */
    _setTargetExternal(watts, reason) {
        const old = this.targetWatts;
        const next = this._clampWatts(watts);
        if (next === old) return;
        this.targetWatts = next;
        this.controller.noteExternalChange(old, next);
        this._sendTarget();
        if (reason) this._event(`${reason}: ${next} W`);
        this._renderTarget();
    }

    _manualWatt(delta) {
        if (!this.session.isRunning) return;
        this.audio.unlock();
        if (this.safetyActive) {
            this._toast('Im Sicherheitsmodus keine manuelle Änderung.', 'warn');
            return;
        }
        const old = this.targetWatts;
        this._setTargetExternal(old + delta, `${delta > 0 ? '+' : ''}${delta} W manuell`);
        if (delta > 0) this.controller.noteManualIncrease();
        // Eine manuelle Erhöhung hebt auch die Obergrenze der Auto-Erhöhung an
        if (this.targetWatts > this.session.plannedTargetWatts) {
            this.session.plannedTargetWatts = this.targetWatts;
        }
    }

    _clampWatts(w) {
        return Math.max(this.cfg.get('minWatts'), Math.min(600, Math.round(w)));
    }

    _sendTarget() {
        if (this.d100.isConnected) {
            this.d100.setTargetPower(this.targetWatts).catch(() => {});
        }
        this._lastErgRefresh = Date.now();
    }

    _onPhaseChange(change, now) {
        const { to } = change;

        if (to === Phase.WORK) {
            this.drift.setWorkBlockStart(now);
            this._setTargetExternal(this.session.plannedTargetWatts, null);
            this._event('Arbeitsblock gestartet');
            this.audio.announce('phase', 'Arbeitsblock startet');
        } else if (to === Phase.COOLDOWN) {
            this.safetyActive = false;
            this._setTargetExternal(this.cfg.get('cooldownWatts'), null);
            this._event('Abkühlen gestartet');
            this.audio.announce('phase', 'Abkühlen beginnt');
        } else if (to === Phase.FINISHED) {
            this._finishSession(now, this.session.endReason ?? 'ziel');
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Wiederaufnahme
    // ══════════════════════════════════════════════════════════════════════

    async _checkForInterruptedSession() {
        let snap = null;
        try { snap = await this.storage.loadSnapshot(); } catch { return; }
        if (!snap || !snap.session) return;

        const phase = snap.session.phase;
        if (phase === Phase.IDLE || phase === Phase.FINISHED) {
            await this.storage.clearSnapshot();
            return;
        }
        if (!snap.savedAt || Date.now() - snap.savedAt > RESUME_MAX_AGE_MS) {
            await this.storage.clearSnapshot();
            return;
        }

        this._resumeSnapshot = snap;
        const started = new Date(snap.session.sessionStart);
        const minsAgo = Math.max(0, Math.round((Date.now() - snap.savedAt) / 60000));
        this.$('resume-detail').textContent =
            `${PHASE_LABEL[phase] ?? phase}, gestartet ${started.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
            + ` · Unterbrechung vor ${minsAgo} min`;
        this.$('resume-banner').classList.remove('hidden');
    }

    async _resumeSession() {
        const snap = this._resumeSnapshot;
        if (!snap) return;
        this.audio.unlock();

        const now  = Date.now();
        // Die Zeit, in der die App nicht lief, war keine Trainingszeit. Alle
        // Zeitstempel wandern deshalb um genau diese Lücke nach vorn – die
        // Einheit läuft weiter, als hätte es die Unterbrechung nicht gegeben.
        //
        // Der Wert darf ausdrücklich auch negativ sein: stellt das Gerät seine
        // Uhr zurück (Zeitzone, Zeitabgleich), liegt der Schnappschuss in der
        // Zukunft. Die Verschiebung hängt die Session dann korrekt an die neue
        // Uhr an, statt sie mit eingefrorenem Timer weiterlaufen zu lassen.
        const gap = now - snap.savedAt;

        const rawRecords = await this.storage.getRecords(snap.session.id);
        const records = rawRecords.map((r) => ({ ...r, t: r.t + gap }));

        const s = { ...snap.session };
        for (const k of ['sessionStart', 'phaseStart', 'warmupEndTime', 'workEndTime']) {
            if (s[k]) s[k] += gap;
        }
        s.laps = (s.laps ?? []).map((l) => ({ ...l, startTime: l.startTime + gap, endTime: l.endTime + gap }));

        this._resetRuntimeState();
        this.session.fromJSON(s, records);

        const ctrl = snap.controller ? { ...snap.controller } : null;
        if (ctrl) {
            if (ctrl.lastReductionTime) ctrl.lastReductionTime += gap;
            if (ctrl.lastIncreaseTime)  ctrl.lastIncreaseTime  += gap;
            if (ctrl.belowSince)        ctrl.belowSince        += gap;
            if (ctrl.ramp?.lastStepTime) ctrl.ramp.lastStepTime += gap;
            this.controller.fromJSON(ctrl);
        }

        if (snap.driftWorkStart) {
            this.drift.restoreFromRecords(records, snap.driftWorkStart + gap);
        }
        this.targetWatts  = snap.targetWatts ?? this.session.plannedTargetWatts;
        this.lastDrift    = snap.lastDrift ?? null;
        this.driftAborted = !!snap.driftAborted;

        this.$('resume-banner').classList.add('hidden');
        this._resumeSnapshot = null;

        this._enterRideView();
        this.lock.enable();
        this.rideChart?.setData(this.session.records);
        this._startLoop();
        this._sendTarget();

        this._event('Session fortgesetzt');
        this._toast('Session fortgesetzt. Sensoren verbinden, falls die Punkte grau sind.', 'ok');
        this.audio.announce('phase', 'Session fortgesetzt');

        this._autoConnect();
    }

    /** Abgebrochene Session nicht fortsetzen, aber als Einheit sichern */
    async _salvageSession() {
        const snap = this._resumeSnapshot;
        if (!snap) return;

        const records = await this.storage.getRecords(snap.session.id);
        this.session.fromJSON(snap.session, records);
        this.session.stop(snap.savedAt);
        this.lastDrift = snap.lastDrift ?? null;

        const summary = this.session.summary;
        this.$('resume-banner').classList.add('hidden');
        this._resumeSnapshot = null;

        if (!summary) { await this._discardSnapshot(); return; }

        const meta = {
            id:               this.session.id,
            date:             summary.date.toISOString(),
            hrvStatus:        snap.hrvStatus ?? this.cfg.get('hrvStatus'),
            workDurationSec:  summary.workDurationSec,
            totalDurationSec: summary.totalDurationSec,
            avgHR:            summary.avgHR,
            maxHR:            summary.maxHR,
            avgWatts:         summary.avgWatts,
            ef:               summary.ef,
            driftAtEnd:       this.lastDrift,
            endReason:        'unterbrochen',
            targetWatts:      summary.targetWatts,
        };
        await this.history.add(meta);
        await this._buildAndStoreFit(summary, meta);
        await this.storage.clearSnapshot();

        this._renderHistory();
        this._renderWeek();
        this._showSummary(meta);
        this.session.reset();
    }

    async _discardSnapshot() {
        const snap = this._resumeSnapshot;
        this._resumeSnapshot = null;
        this.$('resume-banner').classList.add('hidden');
        if (snap?.session?.id) await this.storage.deleteRecords(snap.session.id);
        await this.storage.clearSnapshot();
    }

    /**
     * Messpunkte wegschreiben.
     *
     * Der Stapel wird erst verworfen, wenn der Schreibvorgang bestaetigt ist.
     * Vorher leerte der Takt den Puffer sofort - schlug das Schreiben fehl,
     * waren die Rohdaten dieser fuenf Sekunden endgueltig weg. Die Sperre
     * verhindert ausserdem, dass sich bei traeger Datenbank Transaktionen
     * ueberlagern.
     */
    _flushRecords() {
        if (this._flushInFlight) return;

        const batch = this._recordBacklog.concat(this.session.drainPending());
        if (!batch.length) return;

        // Sollte der Speicher dauerhaft klemmen, darf der Rueckstand nicht
        // unbegrenzt wachsen. Die aeltesten Punkte fallen dann heraus.
        this._recordBacklog = batch.length > 5000 ? batch.slice(-5000) : batch;
        this._flushInFlight = true;

        const sid = this.session.id;
        this.storage.appendRecords(sid, this._recordBacklog)
            .then((ok) => { if (ok) this._recordBacklog = []; })
            .catch(() => { /* Stapel bleibt liegen und wird erneut versucht */ })
            .finally(() => { this._flushInFlight = false; });
    }

    /**
     * Schnappschuss sichern.
     *
     * Die Sperre ist kein Schoenheitsfehler: der Aufruf kommt jede Sekunde und
     * wartet nicht auf sein Ergebnis. Wird IndexedDB traege - volle Datenbank,
     * Speicherdruck, langsamer Flash - stapeln sich sonst ueber eine Stunde
     * hinweg Schreibvorgaenge samt ihrer Nutzlast im Speicher. Genau diese
     * Sorte Fehler faellt erst nach mehreren Einheiten auf.
     */
    _saveSnapshot(force = false) {
        const now = Date.now();
        if (!force && now - this._lastSnapshot < SNAPSHOT_EVERY_MS) return;
        this._lastSnapshot = now;
        if (!this.session.isRunning) return;
        if (this._snapshotInFlight) return;

        this._snapshotInFlight = true;
        this.storage.saveSnapshot({
            version:        1,
            savedAt:        now,
            session:        this.session.toJSON(),
            controller:     this.controller.toJSON(),
            targetWatts:    this.targetWatts,
            safetyActive:   this.safetyActive,
            preSafetyWatts: this.preSafetyWatts,
            hrvStatus:      this.cfg.get('hrvStatus'),
            lastDrift:      this.lastDrift,
            driftAborted:   this.driftAborted,
            driftWorkStart: this.drift.workBlockStart,
        }).catch(() => {}).finally(() => { this._snapshotInFlight = false; });
    }

    // ══════════════════════════════════════════════════════════════════════
    // Anzeige
    // ══════════════════════════════════════════════════════════════════════

    _enterRideView() {
        this.$('view-setup').classList.add('hidden');
        this.$('view-ride').classList.remove('hidden');
        this.$('summary-overlay').classList.add('hidden');
        this._setFormEnabled(false);
        // Direkt nach dem Einblenden vermessen. Nicht über requestAnimationFrame:
        // der Rückruf käme erst, wenn die Seite wieder Bilder erzeugt.
        this.rideChart?.resize();
        this.rideChart?.invalidate();
    }

    _leaveRideView() {
        this.$('view-ride').classList.add('hidden');
        this.$('view-setup').classList.remove('hidden');
        this._setFormEnabled(true);
        this._alert(null);
        this.$('ride-lockwarn')?.classList.add('hidden');
    }

    _setFormEnabled(enabled) {
        document.querySelectorAll('#tab-start input, #tab-start select').forEach((el) => {
            el.disabled = !enabled;
        });
        this.$('btn-start').disabled = !enabled;
    }

    _renderRide(now, hrValid, hrAge) {
        const phase = this.session.phase;

        this.$('ride-phase').textContent = PHASE_LABEL[phase] ?? phase;

        const remaining = this.session.getPhaseRemainingMs(now);
        const elapsed   = this.session.getPhaseElapsedMs(now);
        this.$('ride-timer').textContent = remaining !== null
            ? this._fmt(remaining)
            : this._fmt(elapsed);
        this.$('ride-progress').style.width = `${Math.round(this.session.getPhaseProgress(now) * 100)}%`;

        // Herzfrequenz mit Zonenfarbe
        const hrEl = this.$('ride-hr');
        const hrBox = hrEl.parentElement;
        hrBox.classList.remove('zone-warn', 'zone-danger', 'zone-stale');
        if (!hrValid || this.hr == null) {
            hrEl.textContent = '--';
            hrBox.classList.add('zone-stale');
        } else {
            hrEl.textContent = this.hr;
            if (this.hr >= this.cfg.get('reductionHR'))          hrBox.classList.add('zone-danger');
            else if (this.hr >= this.cfg.get('hysteresisReset')) hrBox.classList.add('zone-warn');
        }

        this.$('ride-watt').textContent     = this.effWatts != null ? this.effWatts : '--';
        this.$('ride-watt-src').textContent = this.wattSource ? `· ${this.wattSource}` : '';
        this._renderTarget();

        const stats = this.session.getWorkStats();
        this.$('ride-avg-hr').textContent   = stats.avgHR ?? '–';
        this.$('ride-avg-watt').textContent = stats.avgWatts ?? '–';
        this.$('ride-total').textContent    = this._fmt(this.session.getElapsedMs(now));

        // Drift
        const d = this.$('ride-drift');
        if (this.lastDrift != null) {
            d.textContent = `${this.lastDrift.toFixed(1)} %`;
            d.className = 'strip-value ' + (
                this.lastDrift >= this.cfg.get('driftAbortPercent') ? 'drift-bad' :
                this.lastDrift >= this.cfg.get('driftWarnPercent')  ? 'drift-warn' : 'drift-ok');
        } else if (phase === Phase.WORK) {
            const min = this.drift.minutesUntilReady(now);
            d.textContent = min > 0 ? `${min} min` : '…';
            d.className = 'strip-value';
        } else {
            d.textContent = '–';
            d.className = 'strip-value';
        }

        this.$('ride-event').textContent = this._eventText;
        this._renderLockWarning();
    }

    /**
     * Dauerhafter Hinweis, wenn der Bildschirm nicht wachgehalten wird.
     *
     * Das ist die wichtigste Warnung der ganzen Anwendung. Geht der Bildschirm
     * aus, wandert die Seite in den Hintergrund und Android beendet sie bei
     * Speicherdruck - der Nutzer sieht dann nur, dass die App "einfach zu
     * war". Dagegen laeuft in der App selbst kein Code mehr, es gibt also
     * auch keine Fehlermeldung. Deshalb muss der Hinweis vorher kommen und
     * stehen bleiben, nicht kurz aufblitzen.
     */
    _renderLockWarning() {
        const el = this.$('ride-lockwarn');
        if (!el) return;

        if (this.lock.isActive) { el.classList.add('hidden'); return; }

        el.textContent = ScreenLock.isSupported()
            ? 'Bildschirm wird nicht wachgehalten. Energiesparmodus aus, Bildschirm-Zeitsperre hoch – sonst beendet Android die App.'
            : 'Dieser Browser kann den Bildschirm nicht wachhalten. Bildschirm-Zeitsperre am Gerät hochsetzen.';
        el.classList.remove('hidden');
    }

    _renderTarget() {
        const el = this.$('ride-target');
        if (el) el.textContent = this.targetWatts;
    }

    _alert(text, kind = 'warn') {
        const el = this.$('ride-alert');
        if (!el) return;
        if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
        el.textContent = text;
        el.classList.remove('hidden', 'warn');
        if (kind === 'warn') el.classList.add('warn');
    }

    _event(text) {
        this._eventText = `${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · ${text}`;
        const el = this.$('ride-event');
        if (el) el.textContent = this._eventText;
    }

    _applyThresholdsToChart() {
        this.rideChart?.setThresholds(this.cfg.get('reductionHR'), this.cfg.get('hysteresisReset'));
    }

    _setHrv(status, persist = true) {
        if (persist) {
            this.cfg.applyHrvStatus(status);
            this.$('in-reduction-hr').value = this.cfg.get('reductionHR');
            this.$('in-hysteresis').value   = this.cfg.get('hysteresisReset');
            this._applyThresholdsToChart();
        }
        document.querySelectorAll('#hrv-group .seg').forEach((b) => {
            b.classList.toggle('active', b.dataset.status === status);
        });
        this.$('hrv-hint').textContent =
            `Reduktion ab ${this.cfg.get('reductionHR')} bpm, Freigabe unter ${this.cfg.get('hysteresisReset')} bpm.`;
    }

    _showSummary(meta) {
        const grid = this.$('summary-grid');
        const min = (sec) => sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '–';
        const item = (v, l) => `<div class="summary-item"><span class="sv">${v}</span><span class="sl">${l}</span></div>`;

        grid.innerHTML =
            item(min(meta.workDurationSec), 'Arbeitsblock') +
            item(min(meta.totalDurationSec), 'Gesamt') +
            item(meta.avgHR ?? '–', 'Ø HR') +
            item(meta.avgWatts ?? '–', 'Ø Watt') +
            item(meta.ef != null ? meta.ef.toFixed(3) : '–', 'W/bpm') +
            item(meta.driftAtEnd != null ? meta.driftAtEnd.toFixed(1) + ' %' : '–', 'Drift');

        const reasons = {
            ziel:         'Geplante Dauer erreicht.',
            drift:        'Beendet, weil die Entkopplung die Schwelle erreicht hat.',
            manuell:      'Von dir ins Abkühlen geschickt.',
            gestoppt:     'Vorzeitig gestoppt.',
            unterbrochen: 'Aus einer unterbrochenen Session gesichert.',
        };
        this.$('summary-note').textContent = reasons[meta.endReason] ?? '';

        this.$('btn-share-fit').classList.toggle('hidden', !canShareFit() || !this._pendingFit);
        this.$('btn-download-fit').classList.toggle('hidden', !this._pendingFit);
        this.$('summary-overlay').classList.remove('hidden');
    }

    async _shareFit(id = null) {
        const fit = await this._resolveFit(id);
        if (!fit) { this._toast('Keine FIT-Datei vorhanden.', 'warn'); return; }
        const result = await shareFit(fit.bytes, fit.filename);
        if (result === 'nicht-moeglich') {
            this._toast('Teilen geht hier nicht – die Datei wird stattdessen heruntergeladen.', 'warn');
            downloadFit(fit.bytes, fit.filename);
        }
    }

    async _downloadFit(id = null) {
        const fit = await this._resolveFit(id);
        if (!fit) { this._toast('Keine FIT-Datei vorhanden.', 'warn'); return; }
        const name = downloadFit(fit.bytes, fit.filename);
        this._toast(`${name} gespeichert.`, 'ok');
    }

    async _resolveFit(id) {
        if (!id && this._pendingFit) return this._pendingFit;
        const wanted = id ?? this._pendingFit?.id;
        if (!wanted) return null;
        const rec = await this.storage.getFit(wanted);
        if (!rec) return null;
        return { bytes: rec.bytes, filename: rec.filename };
    }

    // ══════════════════════════════════════════════════════════════════════
    // Verlauf und Wochenübersicht
    // ══════════════════════════════════════════════════════════════════════

    _renderWeek() {
        const w = this.history.getWeekStats();
        this.$('week-count').textContent  = w.count;
        this.$('week-hours').textContent  = `${Math.floor(w.sec / 3600)}:${String(Math.floor((w.sec % 3600) / 60)).padStart(2, '0')}`;
        this.$('week-streak').textContent = w.streak;
    }

    _renderHistory() {
        const sessions = this.history.getAll();
        const tbody = this.$('history-tbody');

        this.historyChart?.setData(this.history.getTrend());

        const delta = this.history.getEfDelta();
        this.$('ef-delta').textContent = delta === null
            ? 'Ab etwa vier Einheiten siehst du hier, wohin sich deine aerobe Effizienz bewegt.'
            : delta >= 0
                ? `Aerobe Effizienz der letzten drei Einheiten: ${delta.toFixed(1)} % über dem Mittel davor. Die Grundlage trägt.`
                : `Aerobe Effizienz der letzten drei Einheiten: ${Math.abs(delta).toFixed(1)} % unter dem Mittel davor. Kann Erholung, Hitze oder Reizsetzung sein.`;

        if (!sessions.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Noch keine Sessions</td></tr>';
            return;
        }

        tbody.innerHTML = sessions.map((s) => {
            const date  = new Date(s.date).toLocaleString('de-DE',
                { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const dur   = s.workDurationSec ? `${Math.round(s.workDurationSec / 60)} min` : '–';
            const drift = s.driftAtEnd != null ? s.driftAtEnd.toFixed(1) : null;
            const dCls  = drift == null ? '' :
                s.driftAtEnd >= this.cfg.get('driftAbortPercent') ? 'drift-bad' :
                s.driftAtEnd >= this.cfg.get('driftWarnPercent')  ? 'drift-warn' : 'drift-ok';
            return `<tr>
                <td>${date}</td>
                <td>${dur}</td>
                <td>${s.avgHR ?? '–'}</td>
                <td>${s.avgWatts ?? '–'}</td>
                <td>${s.ef != null ? s.ef.toFixed(3) : '–'}</td>
                <td class="${dCls}">${drift != null ? drift + ' %' : '–'}</td>
                <td>${s.detailPurged ? '' : `<button class="btn btn-ghost btn-xs" data-share="${s.id}">teilen</button>`}</td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('[data-share]').forEach((b) => {
            b.addEventListener('click', () => this._shareFit(Number(b.dataset.share)));
        });
    }

    // ══════════════════════════════════════════════════════════════════════
    // Meldungen, Service Worker, Demo
    // ══════════════════════════════════════════════════════════════════════

    _toast(text, kind = '') {
        const stack = this.$('toast-stack');
        if (!stack) return;
        const el = document.createElement('div');
        el.className = 'toast' + (kind ? ' ' + kind : '');
        el.textContent = text;
        stack.appendChild(el);
        // Nicht mehr als vier gleichzeitig, sonst verdeckt es die Anzeige
        while (stack.children.length > 4) stack.removeChild(stack.firstChild);
        setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
    }

    _fmt(ms) {
        if (ms == null || ms < 0) return '--:--';
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').then((reg) => {
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        // Während einer Einheit wird nichts neu geladen
                        this._pendingUpdate = sw;
                        if (!this.session.isRunning) this._offerUpdate();
                    }
                });
            });
        }).catch(() => {});

        this.$('btn-update').addEventListener('click', () => {
            this._pendingUpdate?.postMessage({ type: 'SKIP_WAITING' });
            location.reload();
        });
    }

    _offerUpdate() {
        this.$('update-banner').classList.remove('hidden');
    }

    async _hardReset() {
        try {
            const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
            await Promise.all(regs.map((r) => r.unregister()));
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        } catch { /* egal */ }
        location.reload();
    }

    _startDemo() {
        document.body.classList.add('demo-active');
        this.$('demo-bar').classList.remove('hidden');
        this.demo.isWorkPhase = () => this.session.phase === Phase.WORK;
        this.demo.setSpeed(Number(this.$('demo-speed').value) || 10);
        this.demo.start();

        this.$('demo-speed').addEventListener('change', (e) => this.demo.setSpeed(Number(e.target.value)));
        this.$('demo-hr').addEventListener('click',      () => { this.demo.faultHrDropout(90); this._toast('Demo: HR fällt aus', 'warn'); });
        this.$('demo-trainer').addEventListener('click', () => { this.demo.faultTrainerDropout(); this._toast('Demo: D100 getrennt', 'warn'); });
        this.$('demo-erg').addEventListener('click',     () => { this.demo.faultErgLost(); this._toast('Demo: ERG verloren', 'warn'); });
        this.$('demo-fatigue').addEventListener('click', () => { this.demo.fastForwardFatigue(9); this._toast('Demo: Ermüdung erhöht', 'warn'); });

        this._toast('Demo-Modus aktiv – keine echten Sensoren.', 'ok');
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Start mit Auffangnetz
// ══════════════════════════════════════════════════════════════════════════

function showFatal(message) {
    const box = document.getElementById('fatal');
    const msg = document.getElementById('fatal-msg');
    if (!box || !msg) return;
    msg.textContent = message;
    box.classList.remove('hidden');
}

let appStarted = false;

// Ein Fehler vor dem Start hinterließ vorher eine weiße Seite ohne jeden Hinweis.
window.addEventListener('error', (e) => {
    if (!appStarted) showFatal(e.message ?? 'Unbekannter Fehler beim Laden.');
    else console.error('[error]', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason?.message ?? String(e.reason ?? 'Unbekannt');
    if (!appStarted) showFatal(reason);
    else console.error('[promise]', e.reason);
});

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const app = new Zone2App();
        window._app = app;
        await app.init();
        appStarted = true;
    } catch (err) {
        showFatal(err?.message ?? String(err));
        console.error(err);
    }
});
