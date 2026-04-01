/**
 * PwHR Drift Berechnung
 *
 * Expandierendes Fenster:
 * - 0–10 min: kein Drift ("Warte auf Daten...")
 * - Ab 10 min: erste Anzeige (erste 5 min vs. zweite 5 min)
 * - Fenster wächst kontinuierlich (erste Hälfte vs. zweite Hälfte der Arbeitszeit)
 * - Maximum: 30 min Referenzfenster (erste 30 min fix, zweite Hälfte = rollend letzte 30 min)
 *
 * PwHR = Watt / HR
 * Drift (%) = (PwHR_zweite - PwHR_erste) / PwHR_erste * -100
 * (negativ = Drift nach oben = HR steigt für gleiche Leistung)
 */

const MAX_WINDOW_MIN = 30;
const MIN_ELAPSED_MIN = 10;

export class PwHRDrift {
    constructor() {
        this._samples = []; // { time: ms, hr: number, watts: number }
        this._workBlockStart = null;
        this._lastUpdateTime = 0;
        this._updateIntervalMs = 30_000; // alle 30s neu berechnen
    }

    /** Setzt den Startpunkt des Arbeitsblocks */
    setWorkBlockStart(timeMs = Date.now()) {
        this._workBlockStart = timeMs;
        this._samples = [];
        this._lastUpdateTime = 0;
    }

    /** Neues Sample hinzufügen (sollte ~1x/s aufgerufen werden) */
    addSample(hr, watts, now = Date.now()) {
        if (!this._workBlockStart) return;
        if (!hr || !watts || hr <= 0 || watts <= 0) return;
        this._samples.push({ time: now, hr, watts });
    }

    /**
     * Aktuellen Drift berechnen.
     * @returns {{ drift: number|null, ready: boolean, firstHalf: number, secondHalf: number }}
     */
    calculate(now = Date.now()) {
        if (!this._workBlockStart) return { drift: null, ready: false };

        const elapsedMin = (now - this._workBlockStart) / 60_000;

        if (elapsedMin < MIN_ELAPSED_MIN) {
            return { drift: null, ready: false, elapsedMin };
        }

        // Fenstergröße: min(elapsedMin/2, MAX_WINDOW_MIN) Minuten
        const halfWindowMin = Math.min(elapsedMin / 2, MAX_WINDOW_MIN);
        const halfWindowMs  = halfWindowMin * 60_000;

        // Erstes Fenster: ab Arbeitsblock-Start bis +halfWindowMs
        // Zweites Fenster: letzte halfWindowMs bis jetzt
        const firstStart  = this._workBlockStart;
        const firstEnd    = this._workBlockStart + halfWindowMs;
        const secondStart = now - halfWindowMs;
        const secondEnd   = now;

        const firstSamples  = this._samples.filter((s) => s.time >= firstStart && s.time <= firstEnd);
        const secondSamples = this._samples.filter((s) => s.time >= secondStart && s.time <= secondEnd);

        if (firstSamples.length < 10 || secondSamples.length < 10) {
            return { drift: null, ready: false, elapsedMin };
        }

        const avgPwHR = (samples) => {
            const ratios = samples.map((s) => s.watts / s.hr);
            return ratios.reduce((a, b) => a + b, 0) / ratios.length;
        };

        const pwhrFirst  = avgPwHR(firstSamples);
        const pwhrSecond = avgPwHR(secondSamples);

        // Drift: wenn HR für gleiche Leistung steigt, sinkt PwHR → Drift positiv
        const drift = ((pwhrFirst - pwhrSecond) / pwhrFirst) * 100;

        return {
            drift: Math.round(drift * 10) / 10,
            ready: true,
            elapsedMin,
            firstHalf: Math.round(pwhrFirst * 100) / 100,
            secondHalf: Math.round(pwhrSecond * 100) / 100,
        };
    }

    reset() {
        this._workBlockStart = null;
        this._samples = [];
    }
}
