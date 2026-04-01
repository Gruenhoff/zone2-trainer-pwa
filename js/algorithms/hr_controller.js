/**
 * HR-Steuerungslogik
 * - Hysterese: verhindert Watt-Zittern
 * - Graduell gleitende Reduktion: -5W alle 10s
 * - Trend-Erkennung: präventive Reduktion bei schnellem HR-Anstieg
 * - 90s Cooldown nach jeder Reduktion
 */

export class HRController {
    constructor(config) {
        this.cfg = config;
        this.reset();
    }

    reset() {
        this._inHysteresis       = false;
        this._lastReductionTime  = 0;   // ms timestamp
        this._reductionActive    = false;
        this._reductionStartTime = 0;
        this._reductionBaseWatts = 0;   // Watt vor der Reduktion
        this._reductionTarget    = 0;   // Ziel-Watt nach vollst. Reduktion
        this._lastStepTime       = 0;
        this._stepsApplied       = 0;
        this._totalSteps         = 0;
        this._hrWindow           = [];  // [{time, hr}] letzte 30s
    }

    /** Neues HR-Sample einspeisen. Gibt neuen targetWatts zurück (oder null = keine Änderung). */
    processTick(hr, currentTargetWatts, now = Date.now()) {
        const reductionHR    = this.cfg.get('reductionHR');
        const hysteresisReset = this.cfg.get('hysteresisReset');
        const cooldownMs     = this.cfg.get('cooldownAfterReductionSec') * 1000;
        const trendEnabled   = this.cfg.get('trendEnabled');

        // HR-Fenster aktualisieren (letzte 30s)
        this._hrWindow.push({ time: now, hr });
        const windowMs = this.cfg.get('trendWindowSec') * 1000;
        this._hrWindow = this._hrWindow.filter((p) => now - p.time <= windowMs);

        let newWatts = currentTargetWatts;

        // ── Laufende Reduktion weiterfuhren ─────────────────────────────────
        if (this._reductionActive) {
            const stepIntervalMs = this.cfg.get('reductionStepIntervalSec') * 1000;
            if (now - this._lastStepTime >= stepIntervalMs && this._stepsApplied < this._totalSteps) {
                this._stepsApplied++;
                this._lastStepTime = now;
                newWatts = Math.max(30, this._reductionBaseWatts - this._stepsApplied * this.cfg.get('reductionStepW'));
            }
            if (this._stepsApplied >= this._totalSteps) {
                this._reductionActive = false;
            }
            return newWatts !== currentTargetWatts ? newWatts : null;
        }

        // ── Hysterese-Reset ──────────────────────────────────────────────────
        if (this._inHysteresis && hr < hysteresisReset) {
            this._inHysteresis = false;
        }

        const cooldownElapsed = (now - this._lastReductionTime) >= cooldownMs;

        // ── Trendbasierte Präventivreduktion ─────────────────────────────────
        if (trendEnabled && !this._inHysteresis && cooldownElapsed) {
            const trend = this._calcTrend();
            const trendThreshold = this.cfg.get('trendThresholdBpm');
            if (trend >= trendThreshold && hr > hysteresisReset) {
                this._startReduction(currentTargetWatts, 1, now); // -5W präventiv
                return Math.max(30, currentTargetWatts - this.cfg.get('reductionStepW'));
            }
        }

        // ── Haupt-Reduktion ──────────────────────────────────────────────────
        if (hr > reductionHR && !this._inHysteresis && cooldownElapsed) {
            const reductionMaxW = this.cfg.get('reductionMaxW');
            const reductionMinW = this.cfg.get('reductionMinW');
            const stepW         = this.cfg.get('reductionStepW');
            const cycleSec      = this.cfg.get('reductionCycleSec');
            const stepIntervalSec = this.cfg.get('reductionStepIntervalSec');

            // Schritte die in einer Reduktions-Rampe gemacht werden (Standard: 60s / 10s = 6 Schritte = 30W)
            const defaultSteps = Math.floor(cycleSec / stepIntervalSec);
            const maxSteps     = Math.floor(reductionMaxW / stepW);
            const minSteps     = Math.ceil(reductionMinW / stepW);
            const steps        = Math.max(minSteps, Math.min(maxSteps, defaultSteps));

            this._startReduction(currentTargetWatts, steps, now);
            this._inHysteresis = true;

            // Ersten Schritt sofort anwenden
            this._stepsApplied = 1;
            this._lastStepTime = now;
            return Math.max(30, currentTargetWatts - stepW);
        }

        return null; // keine Änderung
    }

    _startReduction(baseWatts, steps, now) {
        this._reductionActive    = true;
        this._reductionStartTime = now;
        this._lastReductionTime  = now;
        this._reductionBaseWatts = baseWatts;
        this._stepsApplied       = 0;
        this._totalSteps         = steps;
        this._lastStepTime       = now;
    }

    /** HR-Anstieg über das Trendfenster in bpm/Fenster */
    _calcTrend() {
        if (this._hrWindow.length < 2) return 0;
        const oldest = this._hrWindow[0].hr;
        const newest = this._hrWindow[this._hrWindow.length - 1].hr;
        return newest - oldest;
    }

    /** Letzte Reduktions-Infos für Statusanzeige */
    getLastReductionInfo() {
        return {
            time: this._lastReductionTime,
            active: this._reductionActive,
        };
    }

    isReductionActive() {
        return this._reductionActive;
    }

    isInHysteresis() {
        return this._inHysteresis;
    }

    getCooldownRemainingSec(now = Date.now()) {
        const cooldownMs = this.cfg.get('cooldownAfterReductionSec') * 1000;
        const elapsed = now - this._lastReductionTime;
        return Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000));
    }
}
