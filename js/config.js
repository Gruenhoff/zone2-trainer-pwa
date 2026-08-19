/**
 * Einstellungen – gespeichert in localStorage
 *
 * Werte werden beim Setzen auf zulässige Bereiche begrenzt. Ein kaputter oder
 * von Hand manipulierter Eintrag darf die Regelung nicht in einen Zustand
 * bringen, in dem der Trainer sinnlose Vorgaben bekommt.
 */

const STORAGE_KEY = 'zone2-trainer-config';

const DEFAULTS = {
    // Leistung
    targetWatts:   120,
    cooldownWatts:  60,
    minWatts:       30,

    // Herzfrequenz-Schwellen
    reductionHR:     148,
    hysteresisReset: 144,

    // Blockdauern
    warmupDurationMin:   10,
    workTargetMin:       60,
    cooldownDurationMin: 10,

    // Aufwärm-Stufenprogramm
    warmupSteps:        5,
    warmupStartPercent: 50,

    // Reduktion
    reductionCycleSec:          60,
    reductionStepW:              5,
    reductionStepIntervalSec:   10,
    reductionMinW:              10,
    reductionMaxW:              40,
    cooldownAfterReductionSec:  90,

    // Trendwarnung
    trendEnabled:      true,
    trendWindowSec:      30,
    trendThresholdBpm:    5,

    // Auto-Erhöhung, wenn sich die Herzfrequenz erholt
    increaseEnabled:            true,
    increaseStepW:                 5,
    increaseHoldSec:              90,
    increaseMarginBpm:             3,
    increaseAfterReductionSec:   180,

    // Drift
    driftAbortPercent:  6.5,
    driftWarnPercent:   5.0,

    // Sensorausfall
    hrStaleWarnSec: 10,
    hrStaleSafeSec: 45,
    safetyWatts:    60,

    // ERG-Überwachung
    ergRefreshSec:        15,
    ergDeviationPercent:  25,
    ergDeviationSec:      30,

    // Rückmeldung
    soundEnabled:  true,
    speechEnabled: true,

    // HRV-Status des Tages
    hrvStatus: 'green',
    hrv: {
        green:  { reductionHR: 148, hysteresisReset: 144 },
        yellow: { reductionHR: 145, hysteresisReset: 141 },
        red:    { reductionHR: 142, hysteresisReset: 138 },
    },
};

/** Zulässige Bereiche – alles außerhalb wird beim Setzen zurechtgestutzt */
const RANGES = {
    targetWatts:         [30, 600],
    cooldownWatts:       [20, 300],
    minWatts:            [20, 200],
    reductionHR:         [90, 210],
    hysteresisReset:     [80, 205],
    warmupDurationMin:   [0, 60],
    workTargetMin:       [5, 300],
    cooldownDurationMin: [0, 60],
    warmupSteps:         [1, 20],
    warmupStartPercent:  [20, 100],
    reductionStepW:      [1, 50],
    reductionStepIntervalSec: [2, 120],
    reductionMinW:       [0, 200],
    reductionMaxW:       [5, 300],
    cooldownAfterReductionSec: [10, 600],
    trendWindowSec:      [10, 300],
    trendThresholdBpm:   [1, 40],
    increaseStepW:       [1, 30],
    increaseHoldSec:     [20, 900],
    increaseMarginBpm:   [0, 30],
    increaseAfterReductionSec: [30, 1800],
    driftAbortPercent:   [1, 30],
    driftWarnPercent:    [1, 30],
    hrStaleWarnSec:      [3, 120],
    hrStaleSafeSec:      [10, 600],
    safetyWatts:         [0, 300],
    ergRefreshSec:       [5, 120],
    ergDeviationPercent: [5, 90],
    ergDeviationSec:     [10, 300],
};

export class Config {
    constructor() {
        this._data = this._load();
    }

    _load() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                // hrv-Voreinstellungen kommen immer aus dem Code, nicht aus dem Speicher
                return { ...DEFAULTS, ...parsed, hrv: DEFAULTS.hrv };
            }
        } catch { /* beschädigter Eintrag: Voreinstellungen nehmen */ }
        return { ...DEFAULTS };
    }

    save() {
        try {
            const { hrv, ...saveable } = this._data;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(saveable));
        } catch { /* Speicher voll oder gesperrt – nicht kritisch */ }
    }

    get(key) {
        const v = this._data[key];
        return v === undefined || v === null ? DEFAULTS[key] : v;
    }

    set(key, value) {
        this._data[key] = this._clamp(key, value);
        this.save();
        return this._data[key];
    }

    _clamp(key, value) {
        const range = RANGES[key];
        if (!range || typeof value !== 'number' || !isFinite(value)) return value;
        return Math.min(range[1], Math.max(range[0], value));
    }

    /** Zulässiger Bereich für ein Eingabefeld */
    range(key) { return RANGES[key] ?? null; }

    /** HRV-Status anwenden und die HR-Schwellen entsprechend setzen */
    applyHrvStatus(status) {
        const thresholds = DEFAULTS.hrv[status];
        if (!thresholds) return;
        this._data.hrvStatus       = status;
        this._data.reductionHR     = thresholds.reductionHR;
        this._data.hysteresisReset = thresholds.hysteresisReset;
        this.save();
    }

    getAll() { return { ...this._data }; }
}
