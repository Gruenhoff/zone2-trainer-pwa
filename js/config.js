/**
 * Konfigurationsmodul – lädt/speichert Einstellungen in localStorage
 */

const STORAGE_KEY = 'zone2-trainer-config';

const DEFAULTS = {
    targetWatts: 120,
    reductionHR: 148,
    hysteresisReset: 144,
    warmupDurationMin: 10,
    cooldownDurationMin: 10,
    cooldownWatts: 60,
    warmupSteps: 5,
    warmupStartPercent: 50,
    driftAbortPercent: 6.5,
    trendEnabled: true,
    trendWindowSec: 30,
    trendThresholdBpm: 5,
    reductionCycleSec: 60,       // Gesamtdauer einer Reduktionsrampe
    reductionStepW: 5,           // Watt pro Schritt
    reductionStepIntervalSec: 10, // Sekunden pro Schritt
    reductionMinW: 10,
    reductionMaxW: 40,
    cooldownAfterReductionSec: 90,
    hrvStatus: 'green',
    hrv: {
        green:  { reductionHR: 148, hysteresisReset: 144 },
        yellow: { reductionHR: 145, hysteresisReset: 141 },
        red:    { reductionHR: 142, hysteresisReset: 138 },
    },
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
                return { ...DEFAULTS, ...parsed, hrv: DEFAULTS.hrv };
            }
        } catch { /* ignorieren */ }
        return { ...DEFAULTS };
    }

    save() {
        try {
            const { hrv, ...saveable } = this._data;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(saveable));
        } catch { /* ignorieren */ }
    }

    get(key) {
        return this._data[key] ?? DEFAULTS[key];
    }

    set(key, value) {
        this._data[key] = value;
        this.save();
    }

    /** Wendet HRV-Status an und überschreibt HR-Schwellen */
    applyHrvStatus(status) {
        const thresholds = DEFAULTS.hrv[status];
        if (!thresholds) return;
        this._data.hrvStatus = status;
        this._data.reductionHR = thresholds.reductionHR;
        this._data.hysteresisReset = thresholds.hysteresisReset;
        this.save();
    }

    /** Alle Werte als flaches Objekt */
    getAll() {
        return { ...this._data };
    }
}
