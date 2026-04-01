/**
 * Session-Zustandsmaschine
 * Verwaltet die drei Blöcke: Aufwärmen → Arbeitsblock → Abkühlen
 */

export const Phase = {
    IDLE:     'idle',
    WARMUP:   'warmup',
    WORK:     'work',
    COOLDOWN: 'cooldown',
    FINISHED: 'finished',
};

export class Session {
    constructor(config, audio) {
        this.cfg   = config;
        this.audio = audio;
        this.reset();
    }

    reset() {
        this.phase          = Phase.IDLE;
        this.sessionStart   = null;
        this.phaseStart     = null;
        this.warmupEndTime  = null;
        this.workEndTime    = null;

        // Aufwärm-Stufenprogramm
        this.currentWarmupStep = -1;

        // Arbeitsblock-Statistiken
        this.workHrSamples    = [];
        this.workWattsSamples = [];

        // Für FIT-Export: gesammelte Records
        this.records = []; // { timestamp: Date, hr, watts, targetWatts }
        this.laps    = []; // { startTime: Date, endTime: Date, name }

        // Zusammenfassung nach Abschluss
        this.summary = null;
    }

    start(initialTargetWatts) {
        this.reset();
        this.sessionStart = Date.now();
        this.phaseStart   = Date.now();
        this._transitionTo(Phase.WARMUP);
        return this._calcWarmupTargetWatts(0, initialTargetWatts);
    }

    /** Haupt-Tick: jede Sekunde aufrufen. Gibt neuen targetWatts zurück (oder null). */
    tick(hr, currentWatts, currentTargetWatts, now = Date.now()) {
        if (this.phase === Phase.IDLE || this.phase === Phase.FINISHED) return null;

        // Record erfassen
        this.records.push({
            timestamp: new Date(now),
            hr: hr ?? 0,
            watts: currentWatts ?? 0,
            targetWatts: currentTargetWatts,
        });

        if (this.phase === Phase.WARMUP) {
            return this._tickWarmup(currentTargetWatts, now);
        }
        if (this.phase === Phase.WORK) {
            this._tickWorkStats(hr, currentWatts);
            return null;
        }
        if (this.phase === Phase.COOLDOWN) {
            return this._tickCooldown(now);
        }
        return null;
    }

    /** Warmup: Stufenprogramm + Übergangsprüfung */
    _tickWarmup(currentTargetWatts, now) {
        const durationMs = this.cfg.get('warmupDurationMin') * 60_000;
        const elapsed    = now - this.phaseStart;

        if (elapsed >= durationMs) {
            this._transitionWarmupToWork(now);
            return this.cfg.get('targetWatts');
        }

        // Stufenprogramm
        const steps         = this.cfg.get('warmupSteps');
        const stepMs        = durationMs / steps;
        const stepIndex     = Math.floor(elapsed / stepMs);
        const clamped       = Math.min(stepIndex, steps - 1);
        const startPct      = this.cfg.get('warmupStartPercent') / 100;
        const targetFinal   = this.cfg.get('targetWatts');
        const stepSize      = (1 - startPct) / Math.max(1, steps - 1);
        const pct           = startPct + clamped * stepSize;
        const newTarget     = Math.round(targetFinal * pct);

        if (clamped !== this.currentWarmupStep) {
            this.currentWarmupStep = clamped;
            if (this.audio && clamped > 0) this.audio.beepShort();
        }

        return newTarget !== currentTargetWatts ? newTarget : null;
    }

    _transitionWarmupToWork(now) {
        this.warmupEndTime = now;
        this.laps.push({ startTime: new Date(this.phaseStart), endTime: new Date(now), name: 'Aufwärmen' });
        this._transitionTo(Phase.WORK);
        this.phaseStart = now;
        if (this.audio) this.audio.beepLong();
    }

    _tickWorkStats(hr, watts) {
        if (hr && hr > 0) this.workHrSamples.push(hr);
        if (watts && watts > 0) this.workWattsSamples.push(watts);
    }

    /** Abbruch durch Drift-Schwelle oder manuell */
    triggerCooldown(reason = 'manual', now = Date.now()) {
        if (this.phase !== Phase.WORK) return;
        this.workEndTime = now;
        this.laps.push({ startTime: new Date(this.phaseStart), endTime: new Date(now), name: 'Arbeitsblock' });
        this._transitionTo(Phase.COOLDOWN);
        this.phaseStart = now;
        if (this.audio) this.audio.beepLong();
        return this.cfg.get('cooldownWatts');
    }

    _tickCooldown(now) {
        const durationMs = this.cfg.get('cooldownDurationMin') * 60_000;
        const elapsed    = now - this.phaseStart;

        if (elapsed >= durationMs) {
            this._finish(now);
        }
        return null;
    }

    _finish(now) {
        this.laps.push({ startTime: new Date(this.phaseStart), endTime: new Date(now), name: 'Abkühlen' });
        this._transitionTo(Phase.FINISHED);

        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        this.summary = {
            date:              new Date(this.sessionStart),
            workDurationSec:   this.workEndTime ? Math.round((this.workEndTime - (this.warmupEndTime ?? this.sessionStart)) / 1000) : 0,
            avgHR:             avg(this.workHrSamples),
            avgWatts:          avg(this.workWattsSamples),
        };

        if (this.audio) this.audio.beepLong();
    }

    /** Manueller Stop */
    stop(now = Date.now()) {
        if (this.phase === Phase.IDLE || this.phase === Phase.FINISHED) return;

        if (this.phase === Phase.WORK) {
            this.workEndTime = now;
        }
        this.laps.push({ startTime: new Date(this.phaseStart), endTime: new Date(now), name: this.phase });
        this._finish(now);
    }

    _transitionTo(phase) {
        this.phase = phase;
    }

    // ── Hilfsmethoden ─────────────────────────────────────────────────────────

    _calcWarmupTargetWatts(elapsed, targetFinal) {
        const startPct = this.cfg.get('warmupStartPercent') / 100;
        return Math.round(targetFinal * startPct);
    }

    getElapsedMs(now = Date.now()) {
        if (!this.sessionStart) return 0;
        return now - this.sessionStart;
    }

    getPhaseElapsedMs(now = Date.now()) {
        if (!this.phaseStart) return 0;
        return now - this.phaseStart;
    }

    getPhaseTotalMs() {
        if (this.phase === Phase.WARMUP)   return this.cfg.get('warmupDurationMin')   * 60_000;
        if (this.phase === Phase.COOLDOWN) return this.cfg.get('cooldownDurationMin') * 60_000;
        return null;
    }

    getPhaseRemainingMs(now = Date.now()) {
        const total = this.getPhaseTotalMs();
        if (total === null) return null;
        return Math.max(0, total - this.getPhaseElapsedMs(now));
    }

    getWorkStats() {
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        return {
            avgHR:    avg(this.workHrSamples),
            avgWatts: avg(this.workWattsSamples),
        };
    }
}
