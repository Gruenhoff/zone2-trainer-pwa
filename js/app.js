/**
 * Zone2 Trainer – Haupt-Controller
 */

import { Config }             from './config.js';
import { H10Bluetooth }       from './bluetooth/h10.js';
import { PowermeterBluetooth } from './bluetooth/powermeter.js';
import { D100Bluetooth }      from './bluetooth/d100.js';
import { HRController }       from './algorithms/hr_controller.js';
import { PwHRDrift }          from './algorithms/pwhr_drift.js';
import { Session, Phase }     from './session.js';
import { History }            from './history.js';
import { buildFitFile, downloadFit } from './fit_export.js';

// ── Audio ─────────────────────────────────────────────────────────────────────

class AudioHelper {
    constructor() {
        this._ctx = null;
    }
    _ensureCtx() {
        if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        return this._ctx;
    }
    _beep(freq, duration, volume = 0.3) {
        try {
            const ctx = this._ensureCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(volume, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + duration);
        } catch { /* ignorieren */ }
    }
    beepShort() { this._beep(880, 0.15); }
    beepLong()  { this._beep(660, 0.5);  this._beep(880, 0.5); }
    beepWarn()  { this._beep(440, 0.3, 0.4); }
}

// ── App ───────────────────────────────────────────────────────────────────────

class Zone2App {
    constructor() {
        this.cfg         = new Config();
        this.audio       = new AudioHelper();
        this.h10         = new H10Bluetooth();
        this.pm          = new PowermeterBluetooth();
        this.d100        = new D100Bluetooth();
        this.controller  = new HRController(this.cfg);
        this.drift       = new PwHRDrift();
        this.session     = new Session(this.cfg, this.audio);
        this.history     = new History();

        // Datenpuffer
        this._rrBuffer     = [];  // letzte 5 RR-Intervalle für HR-Berechnung
        this._wattsBuffer  = [];  // letzte 5 Watt-Samples für Glättung

        // Live-Werte
        this.currentHR      = null;
        this.currentWatts   = null;
        this.targetWatts    = this.cfg.get('targetWatts');
        this.lastDrift      = null;
        this.lastDriftTime  = 0;

        // Steuerung
        this._mainLoop     = null;
        this._lastEventMsg = '';
        this._lastEventTime = 0;
        this._driftAborted = false;

        // Chart
        this._chart        = null;
        this._chartLabels  = [];
        this._chartHR      = [];
        this._chartRefLine = []; // Reduktions-HR Referenzlinie
        this._phaseMarkers = []; // Phasenwechsel

        this._initBluetooth();
        this._initUI();
        this._initChart();
        this._updateHistoryTable();
    }

    // ── Bluetooth Setup ───────────────────────────────────────────────────────

    _initBluetooth() {
        // H10 – RR-Intervalle für niedriglatente HR-Berechnung
        this.h10.onRRInterval = (rrMs) => {
            // Plausibilitätscheck: RR zwischen 273ms (220bpm) und 1500ms (40bpm)
            if (rrMs < 273 || rrMs > 1500) return;
            this._rrBuffer.push(rrMs);
            if (this._rrBuffer.length > 5) this._rrBuffer.shift();
            // Ab 3 Schlägen: HR aus RR berechnen (deutlich niedrigere Latenz als H10-intern)
            if (this._rrBuffer.length >= 3) {
                const avgRR = this._rrBuffer.reduce((a, b) => a + b, 0) / this._rrBuffer.length;
                const computedHR = Math.round(60000 / avgRR);
                this._onNewHR(computedHR);
            }
        };
        // H10-eigene HR nur als Fallback, solange RR-Buffer noch leer ist
        this.h10.onHeartRate  = (bpm) => {
            if (this._rrBuffer.length < 3) this._onNewHR(bpm);
        };
        this.h10.onConnect    = () => this._setConnStatus('h10', true);
        this.h10.onDisconnect = () => { this._setConnStatus('h10', false); this._rrBuffer = []; };
        this.h10.onStatus     = (m) => this._setConnStatus('h10', false, m);
        this.h10.onError      = (m) => this._showError(m);

        // Powermeter – gleitender Mittelwert über 5 Samples gegen Rauschen
        this.pm.onPower      = (w) => {
            this._wattsBuffer.push(Math.max(0, w));
            if (this._wattsBuffer.length > 5) this._wattsBuffer.shift();
            this.currentWatts = Math.round(
                this._wattsBuffer.reduce((a, b) => a + b, 0) / this._wattsBuffer.length
            );
        };
        this.pm.onConnect    = () => this._setConnStatus('pm', true);
        this.pm.onDisconnect = () => this._setConnStatus('pm', false);
        this.pm.onStatus     = (m) => this._setConnStatus('pm', false, m);
        this.pm.onError      = (m) => this._showError(m);

        // D100
        this.d100.onConnect    = () => {
            this._setConnStatus('d100', true);
            this._sendTargetWatts();
        };
        this.d100.onDisconnect = () => this._setConnStatus('d100', false);
        this.d100.onStatus     = (m) => this._setConnStatus('d100', false, m);
        this.d100.onError      = (m) => this._showError(m);
    }

    _onNewHR(bpm) {
        this.currentHR = bpm;
        this._updateHRDisplay(bpm);
        if (this.session.phase === Phase.WORK) {
            const newW = this.controller.processTick(bpm, this.targetWatts);
            if (newW !== null) {
                this._setTargetWatts(newW, `Reduktion auf ${newW} W`);
            }
        }
    }

    // ── UI Setup ──────────────────────────────────────────────────────────────

    _initUI() {
        // Verbindungs-Buttons
        this.$('btn-connect-h10').addEventListener('click', () => this.h10.connect());
        this.$('btn-connect-pm').addEventListener('click',  () => this.pm.connect());
        this.$('btn-connect-d100').addEventListener('click', () => this.d100.connect());

        // HRV Status
        ['green', 'yellow', 'red'].forEach((s) => {
            this.$(`hrv-${s}`).addEventListener('click', () => this._applyHrvStatus(s));
        });

        // Session Buttons
        this.$('btn-start').addEventListener('click',    () => this._startSession());
        this.$('btn-cooldown').addEventListener('click', () => this._triggerManualCooldown());
        this.$('btn-stop').addEventListener('click',     () => this._stopSession());

        // Manuelle Watt-Erhöhung
        this.$('btn-plus5').addEventListener('click',  () => this._manualWattIncrease(5));
        this.$('btn-plus10').addEventListener('click', () => this._manualWattIncrease(10));

        // Settings
        const twInput = this.$('input-target-watts');
        twInput.value = this.cfg.get('targetWatts');
        twInput.addEventListener('change', () => {
            const v = parseInt(twInput.value, 10);
            if (!isNaN(v) && v > 0) {
                this.cfg.set('targetWatts', v);
                if (this.session.phase === Phase.IDLE) {
                    this.targetWatts = v;
                    this._updateTargetWattsDisplay();
                }
            }
        });

        const rhInput = this.$('input-reduction-hr');
        rhInput.value = this.cfg.get('reductionHR');
        rhInput.addEventListener('change', () => {
            const v = parseInt(rhInput.value, 10);
            if (!isNaN(v)) {
                this.cfg.set('reductionHR', v);
                this._updateChartRefLine();
            }
        });

        const hyInput = this.$('input-hysteresis-reset');
        hyInput.value = this.cfg.get('hysteresisReset');
        hyInput.addEventListener('change', () => {
            const v = parseInt(hyInput.value, 10);
            if (!isNaN(v)) this.cfg.set('hysteresisReset', v);
        });

        const trendCb = this.$('cb-trend');
        trendCb.checked = this.cfg.get('trendEnabled');
        trendCb.addEventListener('change', () => this.cfg.set('trendEnabled', trendCb.checked));

        // Tab Navigation
        document.querySelectorAll('.tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
        });

        // CSV Export
        this.$('btn-export-csv').addEventListener('click', () => this.history.downloadCSV());

        // HRV-Status aus Config anzeigen
        this._applyHrvStatus(this.cfg.get('hrvStatus'), false);

        // Initial-Anzeige
        this._updateTargetWattsDisplay();
        this._updateBlockIndicator();
    }

    _initChart() {
        const ctx = this.$('hr-chart').getContext('2d');
        this._chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this._chartLabels,
                datasets: [
                    {
                        label: 'Herzfrequenz',
                        data: this._chartHR,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.08)',
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        fill: true,
                        order: 1,
                    },
                    {
                        label: 'Reduktions-HR',
                        data: this._chartRefLine,
                        borderColor: 'rgba(239, 68, 68, 0.7)',
                        borderWidth: 1.5,
                        borderDash: [6, 3],
                        pointRadius: 0,
                        fill: false,
                        order: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { intersect: false },
                scales: {
                    x: {
                        ticks: {
                            color: '#64748b',
                            maxTicksLimit: 6,
                            maxRotation: 0,
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                    y: {
                        min: 100,
                        max: 185,
                        ticks: { color: '#64748b', stepSize: 10 },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                },
                plugins: {
                    legend: { display: false },
                },
            },
        });
    }

    // ── Session ───────────────────────────────────────────────────────────────

    _startSession() {
        if (this.session.phase !== Phase.IDLE) return;

        // Config aus Inputs lesen
        const tw = parseInt(this.$('input-target-watts').value, 10);
        if (!isNaN(tw) && tw > 0) {
            this.cfg.set('targetWatts', tw);
            this.targetWatts = tw;
        }

        this.controller.reset();
        this.drift.reset();
        this._rrBuffer    = [];
        this._wattsBuffer = [];
        this._driftAborted = false;
        this._chartLabels  = [];
        this._chartHR      = [];
        this._chartRefLine = [];
        this._chart.data.labels   = this._chartLabels;
        this._chart.data.datasets[0].data = this._chartHR;
        this._chart.data.datasets[1].data = this._chartRefLine;
        this._chart.update('none');

        const initialWatts = this.session.start(this.targetWatts);
        this.targetWatts = initialWatts;
        this._sendTargetWatts();

        this.$('btn-start').disabled = true;
        this.$('btn-stop').disabled  = false;
        this.$('hrv-section').classList.add('hidden');
        this._disableSettingsInputs(true);
        this._setEvent('Session gestartet');

        this._mainLoop = setInterval(() => this._tick(), 1000);
        this._updateBlockIndicator();
    }

    _triggerManualCooldown() {
        if (this.session.phase !== Phase.WORK) return;
        const now = Date.now();
        const coolWatts = this.session.triggerCooldown('manual', now);
        if (coolWatts !== undefined) {
            this.targetWatts = coolWatts;
            this._sendTargetWatts();
        }
        this._setEvent('Manuell zu Abkühlen gewechselt');
        this._onPhaseChanged(Phase.WORK, Phase.COOLDOWN, now);
    }

    _stopSession() {
        if (this.session.phase === Phase.IDLE || this.session.phase === Phase.FINISHED) return;
        this.session.stop();
        this._onSessionFinished();
    }

    _tick() {
        const now = Date.now();
        const phase = this.session.phase;

        if (phase === Phase.FINISHED) {
            clearInterval(this._mainLoop);
            this._mainLoop = null;
            return;
        }

        // Session-Tick (Stufenprogramm + Blockübergänge)
        const newWatts = this.session.tick(this.currentHR, this.currentWatts, this.targetWatts, now);
        if (newWatts !== null) {
            this.targetWatts = newWatts;
            this._sendTargetWatts();
        }

        // Blockübergang erkennen
        if (this.session.phase !== phase) {
            this._onPhaseChanged(phase, this.session.phase, now);
        }

        // Drift-Berechnung (Arbeitsblock)
        if (this.session.phase === Phase.WORK) {
            this.drift.addSample(this.currentHR, this.currentWatts, now);
            if (now - this.lastDriftTime >= 30_000) {
                const result = this.drift.calculate(now);
                this.lastDriftTime = now;
                if (result.ready) {
                    this.lastDrift = result.drift;
                    this._updateDriftDisplay(result);
                    // Abbruchkriterium
                    if (!this._driftAborted && result.drift >= this.cfg.get('driftAbortPercent')) {
                        this._driftAborted = true;
                        this._setEvent(`Drift ${result.drift}% – Abkühlen gestartet`);
                        this.audio.beepWarn();
                        const coolWatts = this.session.triggerCooldown('drift', now);
                        if (coolWatts !== undefined) {
                            this.targetWatts = coolWatts;
                            this._sendTargetWatts();
                        }
                        this._onPhaseChanged(Phase.WORK, Phase.COOLDOWN, now);
                    }
                } else {
                    this._updateDriftWaiting(result);
                }
            }
        }

        // Session beendet?
        if (this.session.phase === Phase.FINISHED) {
            this._onSessionFinished();
        }

        // UI aktualisieren
        this._updateTimerDisplay(now);
        this._updateWattsDisplay();
        this._updateChartPoint(now);
        this._updateBlockIndicator();
        this._updateLastEventAge(now);
    }

    _onPhaseChanged(from, to, now) {
        this._updateBlockIndicator();
        this._addChartPhaseMarker(now);

        if (to === Phase.WORK) {
            this.drift.setWorkBlockStart(now);
            this._setEvent('Arbeitsblock gestartet');
            this.$('drift-section').classList.remove('hidden');
        } else if (to === Phase.COOLDOWN) {
            const w = this.cfg.get('cooldownWatts');
            this.targetWatts = w;
            this._sendTargetWatts();
        } else if (to === Phase.FINISHED) {
            this._onSessionFinished();
        }
    }

    _onSessionFinished() {
        clearInterval(this._mainLoop);
        this._mainLoop = null;

        const summary = this.session.summary;
        if (!summary) return;

        // Historie speichern
        this.history.add({
            date:            summary.date.toISOString(),
            hrvStatus:       this.cfg.get('hrvStatus'),
            workDurationSec: summary.workDurationSec,
            avgHR:           summary.avgHR,
            avgWatts:        summary.avgWatts,
            driftAtEnd:      this.lastDrift,
        });
        this._updateHistoryTable();

        // FIT-File exportieren
        if (this.session.records.length > 0) {
            const records = this.session.records;
            const laps    = this.session.laps;
            const start   = summary.date;
            const end     = new Date();
            const fitBytes = buildFitFile(
                records, laps, start, end, summary.avgHR, summary.avgWatts
            );
            downloadFit(fitBytes);
        }

        // UI zurücksetzen
        this.$('btn-start').disabled = false;
        this.$('btn-stop').disabled  = true;
        this.$('hrv-section').classList.remove('hidden');
        this._disableSettingsInputs(false);
        this.session.reset();
        this.controller.reset();
        this.drift.reset();
        this.lastDrift = null;
        this._updateBlockIndicator();

        this._setEvent('Session beendet – FIT-Datei gespeichert');
        this._showSessionSummary(summary);
    }

    // ── Watt-Steuerung ────────────────────────────────────────────────────────

    _setTargetWatts(watts, eventMsg = null) {
        this.targetWatts = Math.max(30, watts);
        this._sendTargetWatts();
        this._updateTargetWattsDisplay();
        if (eventMsg) this._setEvent(eventMsg);
    }

    _manualWattIncrease(delta) {
        if (this.session.phase === Phase.IDLE) return;
        const newW = this.targetWatts + delta;
        this._setTargetWatts(newW, `+${delta} W manuell`);
    }

    async _sendTargetWatts() {
        this._updateTargetWattsDisplay();
        if (this.d100.isConnected) {
            await this.d100.setTargetPower(this.targetWatts);
        }
    }

    // ── HRV Status ────────────────────────────────────────────────────────────

    _applyHrvStatus(status, updateCfg = true) {
        if (updateCfg) {
            this.cfg.applyHrvStatus(status);
            this.$('input-reduction-hr').value    = this.cfg.get('reductionHR');
            this.$('input-hysteresis-reset').value = this.cfg.get('hysteresisReset');
            this._updateChartRefLine();
        }
        document.querySelectorAll('.hrv-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.status === status);
        });
        const labels = { green: 'Grün', yellow: 'Gelb', red: 'Rot' };
        this.$('hrv-badge').textContent = `HRV: ${labels[status] ?? status}`;
        this.$('hrv-badge').className   = `hrv-badge hrv-${status}`;
    }

    // ── Chart ─────────────────────────────────────────────────────────────────

    _updateChartPoint(now) {
        const maxPoints = 600; // 10 Minuten bei 1Hz
        const label = new Date(now).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const refHR = this.cfg.get('reductionHR');

        this._chartLabels.push(label);
        this._chartHR.push(this.currentHR ?? null);
        this._chartRefLine.push(refHR);

        if (this._chartLabels.length > maxPoints) {
            this._chartLabels.shift();
            this._chartHR.shift();
            this._chartRefLine.shift();
        }

        this._chart.update('none');
    }

    _updateChartRefLine() {
        const refHR = this.cfg.get('reductionHR');
        this._chartRefLine.fill(refHR);
        this._chart.update('none');
    }

    _addChartPhaseMarker(now) {
        // Markierung als letzten Punkt mit null-Lücke nicht notwendig bei Chart.js 4
        // Wir nutzen stattdessen einen Annotation-Marker im Label (visuell via Hintergrundfarbe)
        // Hier: einfach nichts – Phasen sind aus Blockindikator erkennbar
    }

    // ── Display Updates ───────────────────────────────────────────────────────

    _updateHRDisplay(bpm) {
        const el = this.$('hr-value');
        el.textContent = bpm;
        const reductionHR = this.cfg.get('reductionHR');
        const hysteresisReset = this.cfg.get('hysteresisReset');
        el.className = 'hr-value ' + (
            bpm >= reductionHR    ? 'hr-danger' :
            bpm >= hysteresisReset ? 'hr-warn'   : 'hr-ok'
        );
    }

    _updateWattsDisplay() {
        const curEl = this.$('current-watts');
        const tarEl = this.$('target-watts-display');
        curEl.textContent = this.currentWatts != null ? this.currentWatts : '--';
        tarEl.textContent = this.targetWatts;
    }

    _updateTargetWattsDisplay() {
        const tarEl = this.$('target-watts-display');
        if (tarEl) tarEl.textContent = this.targetWatts;
    }

    _updateTimerDisplay(now) {
        const phase = this.session.phase;
        const timerEl = this.$('phase-timer');

        if (phase === Phase.WARMUP || phase === Phase.COOLDOWN) {
            const remainMs = this.session.getPhaseRemainingMs(now);
            timerEl.textContent = this._formatTime(remainMs);
        } else if (phase === Phase.WORK) {
            const elapsedMs = this.session.getPhaseElapsedMs(now);
            timerEl.textContent = this._formatTime(elapsedMs);
            // Statistiken anzeigen
            const stats = this.session.getWorkStats();
            const avgHrEl = this.$('avg-hr');
            const avgWEl  = this.$('avg-watts');
            if (avgHrEl) avgHrEl.textContent = stats.avgHR    ?? '--';
            if (avgWEl)  avgWEl.textContent  = stats.avgWatts ?? '--';
        } else {
            timerEl.textContent = '--:--';
        }
    }

    _updateDriftDisplay(result) {
        const pct = result.drift;
        const label = this.$('drift-value');
        const bar   = this.$('drift-bar');
        const info  = this.$('drift-info');

        label.textContent = `${pct.toFixed(1)} %`;
        label.className   = 'drift-value ' + (pct >= 6.5 ? 'drift-red' : pct >= 5 ? 'drift-yellow' : 'drift-green');

        const fillPct = Math.min(100, (pct / 8) * 100);
        bar.style.width     = `${fillPct}%`;
        bar.className       = 'drift-fill ' + (pct >= 6.5 ? 'drift-red' : pct >= 5 ? 'drift-yellow' : 'drift-green');

        if (info) info.textContent = `PwHR: ${result.firstHalf?.toFixed(2) ?? '--'} → ${result.secondHalf?.toFixed(2) ?? '--'}`;
    }

    _updateDriftWaiting(result) {
        const label = this.$('drift-value');
        const elMin = result.elapsedMin ? Math.floor(result.elapsedMin) : 0;
        const remain = Math.max(0, 10 - elMin);
        label.textContent = remain > 0 ? `Warte auf Daten (${remain} min)` : 'Berechne...';
        label.className   = 'drift-value';
    }

    _updateBlockIndicator() {
        const phase = this.session.phase;
        ['warmup', 'work', 'cooldown'].forEach((p) => {
            const el = this.$(`block-${p}`);
            if (!el) return;
            el.classList.toggle('active',   phase === p);
            el.classList.toggle('done',     this._isPhaseDone(p, phase));
        });
        const labelEl = this.$('phase-label');
        if (labelEl) {
            const labels = {
                idle:     '',
                warmup:   'Aufwarmen',
                work:     'Arbeitsblock',
                cooldown: 'Abkuhlen',
                finished: 'Fertig',
            };
            labelEl.textContent = labels[phase] ?? '';
        }
        const cooldownBtn = this.$('btn-cooldown');
        if (cooldownBtn) cooldownBtn.disabled = (phase !== Phase.WORK);
    }

    _isPhaseDone(phaseId, currentPhase) {
        const order = [Phase.IDLE, Phase.WARMUP, Phase.WORK, Phase.COOLDOWN, Phase.FINISHED];
        return order.indexOf(currentPhase) > order.indexOf(phaseId);
    }

    _updateLastEventAge(now) {
        if (!this._lastEventTime) return;
        const sec = Math.round((now - this._lastEventTime) / 1000);
        const el  = this.$('last-event');
        if (el && this._lastEventMsg) {
            el.textContent = `${this._lastEventMsg} (vor ${sec}s)`;
        }
    }

    _setEvent(msg) {
        this._lastEventMsg  = msg;
        this._lastEventTime = Date.now();
        const el = this.$('last-event');
        if (el) el.textContent = msg;
    }

    _setConnStatus(device, connected, statusMsg = null) {
        const el = this.$(`status-${device}`);
        if (!el) return;
        el.classList.toggle('connected',    connected);
        el.classList.toggle('disconnected', !connected);
        if (statusMsg) el.title = statusMsg;
    }

    _showError(msg) {
        const el = this.$('error-banner');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 8000);
    }

    _showSessionSummary(summary) {
        const el = this.$('session-summary');
        if (!el) return;
        const min = Math.floor(summary.workDurationSec / 60);
        const sec = summary.workDurationSec % 60;
        el.innerHTML = `
            <strong>Session beendet</strong><br>
            Arbeitsblock: ${min}:${String(sec).padStart(2,'0')} min<br>
            Ø HR: ${summary.avgHR ?? '--'} bpm &nbsp;|&nbsp;
            Ø Watt: ${summary.avgWatts ?? '--'} W<br>
            Drift: ${this.lastDrift != null ? this.lastDrift.toFixed(1) + '%' : '--'}
        `;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 15_000);
    }

    _disableSettingsInputs(disabled) {
        ['input-target-watts', 'input-reduction-hr', 'input-hysteresis-reset'].forEach((id) => {
            const el = this.$(id);
            if (el) el.disabled = disabled;
        });
    }

    // ── Historie ──────────────────────────────────────────────────────────────

    _updateHistoryTable() {
        const tbody = this.$('history-tbody');
        if (!tbody) return;
        const sessions = this.history.getAll();
        if (sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Noch keine Sessions</td></tr>';
            return;
        }
        const statusLabels = { green: 'Grün', yellow: 'Gelb', red: 'Rot' };
        tbody.innerHTML = sessions.map((s) => {
            const date = new Date(s.date).toLocaleString('de-DE', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
            const dur   = s.workDurationSec ? `${Math.floor(s.workDurationSec / 60)} min` : '–';
            const hr    = s.avgHR    ? `${s.avgHR} bpm`  : '–';
            const watts = s.avgWatts ? `${s.avgWatts} W` : '–';
            const drift = s.driftAtEnd != null ? `${s.driftAtEnd.toFixed(1)}%` : '–';
            const hrv   = statusLabels[s.hrvStatus] ?? s.hrvStatus;
            return `<tr>
                <td>${date}</td>
                <td><span class="hrv-dot hrv-${s.hrvStatus}"></span> ${hrv}</td>
                <td>${dur}</td>
                <td>${hr}</td>
                <td>${watts}</td>
                <td>${drift}</td>
            </tr>`;
        }).join('');
    }

    // ── Tab Navigation ────────────────────────────────────────────────────────

    _switchTab(tab) {
        document.querySelectorAll('.tab-view').forEach((el) => el.classList.add('hidden'));
        document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
        const view = this.$(`view-${tab}`);
        if (view) view.classList.remove('hidden');
        const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
        if (btn) btn.classList.add('active');
        if (tab === 'history') this._updateHistoryTable();
    }

    // ── Hilfsmethoden ─────────────────────────────────────────────────────────

    $(id) { return document.getElementById(id); }

    _formatTime(ms) {
        if (ms == null || ms < 0) return '--:--';
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Service Worker registrieren
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    window._app = new Zone2App();
});
