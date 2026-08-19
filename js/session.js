/**
 * Session-Zustandsmaschine
 *
 * Aufwärmen → Arbeitsblock → Abkühlen → fertig
 *
 * Zwei Dinge sind gegenüber der ersten Fassung neu:
 *
 *   Ziel-Dauer   Der Arbeitsblock lief vorher unbegrenzt. Jetzt gibt es eine
 *                geplante Dauer, an der sich Fortschrittsanzeige und Ansagen
 *                orientieren. Der Drift-Abbruch bleibt vorrangig – erreicht die
 *                Entkopplung die Schwelle, endet der Block sofort, egal wie
 *                viel Zeit noch übrig wäre.
 *
 *   Schnappschuss Der komplette Zustand lässt sich serialisieren und über die
 *                echte Uhrzeit wiederherstellen. Deshalb werden Statistiken als
 *                laufende Summen geführt und nicht als wachsende Arrays: der
 *                Schnappschuss bleibt so auch nach zwei Stunden winzig.
 */

export const Phase = {
    IDLE:     'idle',
    WARMUP:   'warmup',
    WORK:     'work',
    COOLDOWN: 'cooldown',
    FINISHED: 'finished',
};

export const PHASE_LABEL = {
    [Phase.IDLE]:     'Bereit',
    [Phase.WARMUP]:   'Aufwärmen',
    [Phase.WORK]:     'Arbeitsblock',
    [Phase.COOLDOWN]: 'Abkühlen',
    [Phase.FINISHED]: 'Fertig',
};

export class Session {
    constructor(config) {
        this.cfg = config;
        this.reset();
    }

    reset() {
        this.id            = null;
        this.phase         = Phase.IDLE;
        this.sessionStart  = null;
        this.phaseStart    = null;
        this.warmupEndTime = null;
        this.workEndTime   = null;
        this.endReason     = null;    // 'ziel' | 'drift' | 'manuell' | 'gestoppt'

        this.currentWarmupStep = -1;
        this.plannedTargetWatts = this.cfg.get('targetWatts');

        // Laufende Summen statt Arrays – hält den Schnappschuss klein
        this._hrSum = 0; this._hrCount = 0;
        this._wSum  = 0; this._wCount  = 0;
        this._hrMax = 0;

        this.records = [];      // vollständig, für den FIT-Export
        this._pending = [];     // noch nicht auf die Platte geschriebene Punkte
        this.laps    = [];

        this.summary = null;
    }

    // ── Start und Übergänge ───────────────────────────────────────────────────

    start(targetWatts, now = Date.now()) {
        this.reset();
        this.id                 = now;
        this.sessionStart       = now;
        this.phaseStart         = now;
        this.plannedTargetWatts = targetWatts;

        const warmupMs = this.cfg.get('warmupDurationMin') * 60_000;
        if (warmupMs <= 0) {
            this.phase = Phase.WORK;
            return targetWatts;
        }
        this.phase = Phase.WARMUP;
        return this._warmupWattsForStep(0, targetWatts);
    }

    /**
     * Sekundentakt.
     * @returns {{targetWatts:number|null, phaseChange:{from,to}|null, warmupStep:number|null}}
     */
    tick({ hr, hrValid, watts, wattsValid, cadence, targetWatts, now = Date.now() }) {
        const result = { targetWatts: null, phaseChange: null, warmupStep: null };
        if (this.phase === Phase.IDLE || this.phase === Phase.FINISHED) return result;

        this._record(now, hr, hrValid, watts, wattsValid, cadence, targetWatts);

        if (this.phase === Phase.WARMUP) {
            const warmupMs = this.cfg.get('warmupDurationMin') * 60_000;
            if (now - this.phaseStart >= warmupMs) {
                result.phaseChange = this._toWork(now);
                result.targetWatts = this.plannedTargetWatts;
                return result;
            }
            const step = this._currentWarmupStep(now);
            if (step !== this.currentWarmupStep) {
                this.currentWarmupStep = step;
                result.warmupStep = step;
                const w = this._warmupWattsForStep(step, this.plannedTargetWatts);
                if (w !== targetWatts) result.targetWatts = w;
            }
            return result;
        }

        if (this.phase === Phase.WORK) {
            if (hrValid && hr > 0)          { this._hrSum += hr;    this._hrCount++; this._hrMax = Math.max(this._hrMax, hr); }
            if (wattsValid && watts > 0)    { this._wSum  += watts; this._wCount++; }

            const targetMs = this.cfg.get('workTargetMin') * 60_000;
            if (targetMs > 0 && now - this.phaseStart >= targetMs) {
                result.phaseChange = this.toCooldown('ziel', now);
                result.targetWatts = this.cfg.get('cooldownWatts');
            }
            return result;
        }

        if (this.phase === Phase.COOLDOWN) {
            const durationMs = this.cfg.get('cooldownDurationMin') * 60_000;
            if (now - this.phaseStart >= durationMs) {
                result.phaseChange = this._finish(now);
            }
            return result;
        }

        return result;
    }

    _toWork(now) {
        this.warmupEndTime = now;
        this.laps.push({ startTime: this.phaseStart, endTime: now, name: 'Aufwärmen' });
        const from = this.phase;
        this.phase      = Phase.WORK;
        this.phaseStart = now;
        return { from, to: Phase.WORK };
    }

    /** Vorzeitig ins Abkühlen – durch Drift, Ziel-Dauer oder Nutzerentscheidung */
    toCooldown(reason = 'manuell', now = Date.now()) {
        if (this.phase !== Phase.WORK) return null;
        this.workEndTime = now;
        this.endReason   = reason;
        this.laps.push({ startTime: this.phaseStart, endTime: now, name: 'Arbeitsblock' });
        this.phase      = Phase.COOLDOWN;
        this.phaseStart = now;
        return { from: Phase.WORK, to: Phase.COOLDOWN };
    }

    _finish(now) {
        const from = this.phase;
        this.laps.push({ startTime: this.phaseStart, endTime: now, name: PHASE_LABEL[from] ?? from });
        this.phase = Phase.FINISHED;
        this.summary = this._buildSummary(now);
        return { from, to: Phase.FINISHED };
    }

    /** Vom Nutzer abgebrochen */
    stop(now = Date.now()) {
        if (this.phase === Phase.IDLE || this.phase === Phase.FINISHED) return null;
        if (this.phase === Phase.WORK) {
            this.workEndTime = now;
            this.endReason   = 'gestoppt';
        }
        return this._finish(now);
    }

    _buildSummary(now) {
        const avgHR    = this._hrCount ? Math.round(this._hrSum / this._hrCount) : null;
        const avgWatts = this._wCount  ? Math.round(this._wSum  / this._wCount)  : null;
        const workStart = this.warmupEndTime ?? this.sessionStart;
        const workEnd   = this.workEndTime ?? now;

        return {
            id:              this.id,
            date:            new Date(this.sessionStart),
            endDate:         new Date(now),
            workDurationSec: Math.max(0, Math.round((workEnd - workStart) / 1000)),
            totalDurationSec: Math.max(0, Math.round((now - this.sessionStart) / 1000)),
            avgHR,
            avgWatts,
            maxHR:           this._hrMax || null,
            // Aerobe Effizienz: Watt je Herzschlag. Steigt sie über Wochen,
            // wird die Grundlage besser – die eigentliche Zielgröße.
            ef:              (avgHR && avgWatts) ? Math.round((avgWatts / avgHR) * 1000) / 1000 : null,
            endReason:       this.endReason,
            targetWatts:     this.plannedTargetWatts,
        };
    }

    // ── Messpunkte ────────────────────────────────────────────────────────────

    _record(now, hr, hrValid, watts, wattsValid, cadence, targetWatts) {
        const point = {
            t:   now,
            hr:  hrValid    && hr    > 0 ? hr    : 0,
            w:   wattsValid && watts > 0 ? watts : 0,
            tw:  targetWatts ?? 0,
            cad: cadence ?? 0,
            ph:  this.phase,
        };
        this.records.push(point);
        this._pending.push(point);
    }

    /** Noch nicht gespeicherte Messpunkte abholen und den Puffer leeren */
    drainPending() {
        if (!this._pending.length) return [];
        const out = this._pending;
        this._pending = [];
        return out;
    }

    // ── Aufwärmprogramm ───────────────────────────────────────────────────────

    _currentWarmupStep(now) {
        const durationMs = this.cfg.get('warmupDurationMin') * 60_000;
        const steps      = this.cfg.get('warmupSteps');
        if (durationMs <= 0 || steps <= 0) return 0;
        const stepMs = durationMs / steps;
        return Math.min(Math.floor((now - this.phaseStart) / stepMs), steps - 1);
    }

    _warmupWattsForStep(step, targetFinal) {
        const steps    = this.cfg.get('warmupSteps');
        const startPct = this.cfg.get('warmupStartPercent') / 100;
        const stepSize = (1 - startPct) / Math.max(1, steps - 1);
        const pct      = Math.min(1, startPct + step * stepSize);
        return Math.max(this.cfg.get('minWatts'), Math.round(targetFinal * pct));
    }

    // ── Abfragen für die Anzeige ──────────────────────────────────────────────

    getPhaseElapsedMs(now = Date.now()) {
        return this.phaseStart ? Math.max(0, now - this.phaseStart) : 0;
    }

    getElapsedMs(now = Date.now()) {
        return this.sessionStart ? Math.max(0, now - this.sessionStart) : 0;
    }

    /** Geplante Dauer der aktuellen Phase, null wenn offen */
    getPhaseTotalMs() {
        if (this.phase === Phase.WARMUP)   return this.cfg.get('warmupDurationMin')   * 60_000;
        if (this.phase === Phase.COOLDOWN) return this.cfg.get('cooldownDurationMin') * 60_000;
        if (this.phase === Phase.WORK) {
            const t = this.cfg.get('workTargetMin') * 60_000;
            return t > 0 ? t : null;
        }
        return null;
    }

    getPhaseRemainingMs(now = Date.now()) {
        const total = this.getPhaseTotalMs();
        if (total === null) return null;
        return Math.max(0, total - this.getPhaseElapsedMs(now));
    }

    getPhaseProgress(now = Date.now()) {
        const total = this.getPhaseTotalMs();
        if (!total) return 0;
        return Math.min(1, this.getPhaseElapsedMs(now) / total);
    }

    getWorkStats() {
        return {
            avgHR:    this._hrCount ? Math.round(this._hrSum / this._hrCount) : null,
            avgWatts: this._wCount  ? Math.round(this._wSum  / this._wCount)  : null,
            maxHR:    this._hrMax || null,
        };
    }

    get isRunning() {
        return this.phase !== Phase.IDLE && this.phase !== Phase.FINISHED;
    }

    // ── Schnappschuss ─────────────────────────────────────────────────────────

    toJSON() {
        return {
            id:            this.id,
            phase:         this.phase,
            sessionStart:  this.sessionStart,
            phaseStart:    this.phaseStart,
            warmupEndTime: this.warmupEndTime,
            workEndTime:   this.workEndTime,
            endReason:     this.endReason,
            warmupStep:    this.currentWarmupStep,
            plannedTargetWatts: this.plannedTargetWatts,
            hrSum: this._hrSum, hrCount: this._hrCount, hrMax: this._hrMax,
            wSum:  this._wSum,  wCount:  this._wCount,
            laps:  this.laps,
        };
    }

    /**
     * Zustand wiederherstellen. Die Zeitpunkte sind echte Uhrzeiten, dadurch
     * laufen alle Timer nach einem Neustart korrekt weiter – auch wenn die App
     * zwischendurch minutenlang gar nicht lief.
     */
    fromJSON(data, records = []) {
        if (!data) return false;
        this.reset();
        this.id            = data.id ?? Date.now();
        this.phase         = data.phase ?? Phase.IDLE;
        this.sessionStart  = data.sessionStart ?? null;
        this.phaseStart    = data.phaseStart ?? null;
        this.warmupEndTime = data.warmupEndTime ?? null;
        this.workEndTime   = data.workEndTime ?? null;
        this.endReason     = data.endReason ?? null;
        this.currentWarmupStep  = data.warmupStep ?? -1;
        this.plannedTargetWatts = data.plannedTargetWatts ?? this.cfg.get('targetWatts');
        this._hrSum  = data.hrSum  ?? 0;
        this._hrCount = data.hrCount ?? 0;
        this._hrMax  = data.hrMax  ?? 0;
        this._wSum   = data.wSum   ?? 0;
        this._wCount = data.wCount ?? 0;
        this.laps    = data.laps ?? [];
        this.records = (records ?? []).map((r) => ({
            t: r.t, hr: r.hr, w: r.w, tw: r.tw, cad: r.cad, ph: r.ph,
        }));
        this._pending = [];
        return true;
    }
}
