/**
 * HR-Steuerungslogik
 *
 * Arbeitet im festen Sekundentakt, nicht mehr im Takt eingehender Herzschläge.
 * Das war vorher die Ursache dafür, dass eine laufende Reduktionsrampe stehen
 * blieb, sobald der Brustgurt kurz aussetzte – ausgerechnet in dem Moment, in
 * dem die Absicherung greifen sollte.
 *
 * Vier Mechanismen:
 *   Hysterese      – nach einer Reduktion erst wieder auslösen, wenn die HR
 *                    deutlich unter die Schwelle gefallen ist
 *   Rampe          – Watt gleiten in Stufen nach unten statt in einem Sprung
 *   Trendwarnung   – steigt die HR schnell, wird vorbeugend etwas weggenommen
 *   Auto-Erhöhung  – erholt sich die HR nachhaltig, geht es kontrolliert
 *                    wieder nach oben, höchstens bis zur eingestellten Ziel-Watt
 *
 * Die Auto-Erhöhung ist der Grund, warum die Leistung über eine lange Einheit
 * nicht mehr monoton wegsackt.
 */

export class HRController {
    constructor(config) {
        this.cfg = config;
        this.reset();
    }

    reset() {
        this._inHysteresis      = false;
        this._lastReductionTime = 0;
        this._lastIncreaseTime  = 0;

        this._ramp = {
            active:       false,
            baseWatts:    0,
            totalSteps:   0,
            applied:      0,
            lastStepTime: 0,
        };

        this._hrWindow  = [];      // [{ time, hr }] im Trendfenster
        this._belowSince = null;   // seit wann liegt die HR im Erholungsbereich
    }

    /**
     * Einmal pro Sekunde aufrufen.
     *
     * @param {object} ctx
     * @param {number|null} ctx.hr           – aktuelle Herzfrequenz
     * @param {boolean} ctx.hrValid          – ob der Wert frisch ist
     * @param {number} ctx.targetWatts       – aktuelle Vorgabe
     * @param {number} ctx.ceilingWatts      – Obergrenze für die Auto-Erhöhung
     * @param {number} ctx.now
     * @returns {{watts:number, kind:'down'|'up', reason:string}|null}
     */
    tick({ hr, hrValid, targetWatts, ceilingWatts, now = Date.now() }) {
        // ── Laufende Rampe weiterführen ──────────────────────────────────────
        // Bewusst unabhängig davon, ob gerade HR-Daten ankommen: eine begonnene
        // Absenkung muss zu Ende gehen.
        if (this._ramp.active) {
            const stepMs = this.cfg.get('reductionStepIntervalSec') * 1000;
            if (now - this._ramp.lastStepTime >= stepMs && this._ramp.applied < this._ramp.totalSteps) {
                this._ramp.applied++;
                this._ramp.lastStepTime = now;
                const w = this._floor(this._ramp.baseWatts - this._ramp.applied * this.cfg.get('reductionStepW'));
                if (this._ramp.applied >= this._ramp.totalSteps) this._ramp.active = false;
                if (w !== targetWatts) {
                    return { watts: w, kind: 'down', reason: 'Reduktion läuft' };
                }
            }
            if (this._ramp.applied >= this._ramp.totalSteps) this._ramp.active = false;
            return null;
        }

        // Ohne frische Herzfrequenz keine neuen Entscheidungen treffen.
        if (!hrValid || !hr || hr <= 0) {
            this._belowSince = null;
            return null;
        }

        const reductionHR     = this.cfg.get('reductionHR');
        const hysteresisReset = this.cfg.get('hysteresisReset');
        const cooldownMs      = this.cfg.get('cooldownAfterReductionSec') * 1000;

        // Trendfenster pflegen
        this._hrWindow.push({ time: now, hr });
        const windowMs = this.cfg.get('trendWindowSec') * 1000;
        this._hrWindow = this._hrWindow.filter((p) => now - p.time <= windowMs);

        if (this._inHysteresis && hr < hysteresisReset) this._inHysteresis = false;

        const cooldownElapsed = (now - this._lastReductionTime) >= cooldownMs;

        // ── Haupt-Reduktion ──────────────────────────────────────────────────
        if (hr > reductionHR && !this._inHysteresis && cooldownElapsed) {
            const stepW = this.cfg.get('reductionStepW');
            const steps = this._plannedSteps();
            this._startRamp(targetWatts, steps, now);
            this._inHysteresis = true;
            this._ramp.applied = 1;                  // erster Schritt sofort
            this._ramp.lastStepTime = now;
            if (steps <= 1) this._ramp.active = false;
            this._belowSince = null;
            return {
                watts: this._floor(targetWatts - stepW),
                kind: 'down',
                reason: `HR ${hr} über ${reductionHR}`,
            };
        }

        // ── Vorbeugende Trendreduktion ───────────────────────────────────────
        if (this.cfg.get('trendEnabled') && !this._inHysteresis && cooldownElapsed) {
            const trend = this._calcTrend();
            if (trend >= this.cfg.get('trendThresholdBpm') && hr > hysteresisReset) {
                const stepW = this.cfg.get('reductionStepW');
                this._startRamp(targetWatts, 1, now);
                this._ramp.applied = 1;
                this._ramp.active  = false;          // einmalig, keine Rampe
                this._belowSince = null;
                return {
                    watts: this._floor(targetWatts - stepW),
                    kind: 'down',
                    reason: `HR steigt schnell (+${trend} bpm)`,
                };
            }
        }

        // ── Auto-Erhöhung ────────────────────────────────────────────────────
        const margin = this.cfg.get('increaseMarginBpm');
        if (hr < hysteresisReset - margin) {
            if (this._belowSince === null) this._belowSince = now;
        } else {
            this._belowSince = null;
        }

        if (this._belowSince !== null) {
            const holdMs      = this.cfg.get('increaseHoldSec') * 1000;
            const afterRedMs  = this.cfg.get('increaseAfterReductionSec') * 1000;
            const heldLong    = (now - this._belowSince) >= holdMs;
            const redFarBack  = (now - this._lastReductionTime) >= afterRedMs;
            const incFarBack  = (now - this._lastIncreaseTime)  >= holdMs;
            const ceiling     = Math.max(0, ceilingWatts ?? targetWatts);

            if (heldLong && redFarBack && incFarBack && targetWatts < ceiling) {
                const stepW = this.cfg.get('increaseStepW');
                const next  = Math.min(ceiling, targetWatts + stepW);
                this._lastIncreaseTime = now;
                this._belowSince = now;   // Zähler neu starten, nicht sofort nochmal
                if (next !== targetWatts) {
                    return {
                        watts: next,
                        kind: 'up',
                        reason: `HR erholt (${hr})`,
                    };
                }
            }
        }

        return null;
    }

    /**
     * Meldet eine Änderung der Vorgabe, die nicht vom Regler kam (manuelle
     * Taste, Phasenwechsel). Ohne das würde eine laufende Rampe die Änderung
     * beim nächsten Schritt wieder überschreiben.
     */
    noteExternalChange(oldWatts, newWatts) {
        if (!this._ramp.active) return;
        this._ramp.baseWatts += (newWatts - oldWatts);
    }

    /** Nach einer manuellen Erhöhung soll die Auto-Erhöhung nicht sofort nachlegen */
    noteManualIncrease(now = Date.now()) {
        this._lastIncreaseTime = now;
        this._belowSince = null;
    }

    _plannedSteps() {
        const stepW    = this.cfg.get('reductionStepW');
        const cycleSec = this.cfg.get('reductionCycleSec');
        const stepSec  = this.cfg.get('reductionStepIntervalSec');
        const defaultSteps = Math.floor(cycleSec / Math.max(1, stepSec));
        const maxSteps     = Math.floor(this.cfg.get('reductionMaxW') / stepW);
        const minSteps     = Math.ceil(this.cfg.get('reductionMinW') / stepW);
        return Math.max(1, Math.max(minSteps, Math.min(maxSteps, defaultSteps)));
    }

    _startRamp(baseWatts, steps, now) {
        this._ramp = {
            active:       steps > 1,
            baseWatts,
            totalSteps:   steps,
            applied:      0,
            lastStepTime: now,
        };
        this._lastReductionTime = now;
    }

    _floor(watts) {
        return Math.max(this.cfg.get('minWatts'), Math.round(watts));
    }

    /** HR-Anstieg über das Trendfenster in bpm */
    _calcTrend() {
        if (this._hrWindow.length < 2) return 0;
        const spanMs = this._hrWindow[this._hrWindow.length - 1].time - this._hrWindow[0].time;
        // Erst aussagekräftig, wenn das Fenster halbwegs gefüllt ist
        if (spanMs < this.cfg.get('trendWindowSec') * 1000 * 0.6) return 0;
        return this._hrWindow[this._hrWindow.length - 1].hr - this._hrWindow[0].hr;
    }

    // ── Status für die Anzeige ────────────────────────────────────────────────

    isReductionActive() { return this._ramp.active; }
    isInHysteresis()    { return this._inHysteresis; }

    getCooldownRemainingSec(now = Date.now()) {
        const cooldownMs = this.cfg.get('cooldownAfterReductionSec') * 1000;
        return Math.max(0, Math.ceil((cooldownMs - (now - this._lastReductionTime)) / 1000));
    }

    /** Für den Schnappschuss: Zustand sichern und zurückholen */
    toJSON() {
        return {
            inHysteresis:      this._inHysteresis,
            lastReductionTime: this._lastReductionTime,
            lastIncreaseTime:  this._lastIncreaseTime,
            ramp:              { ...this._ramp },
            belowSince:        this._belowSince,
        };
    }

    fromJSON(data) {
        if (!data) return;
        this._inHysteresis      = !!data.inHysteresis;
        this._lastReductionTime = data.lastReductionTime ?? 0;
        this._lastIncreaseTime  = data.lastIncreaseTime ?? 0;
        this._ramp              = { ...this._ramp, ...(data.ramp ?? {}) };
        this._belowSince        = data.belowSince ?? null;
        this._hrWindow          = [];
    }
}
