/**
 * PwHR-Drift (kardiovaskuläre Entkopplung)
 *
 * PwHR = Watt / Herzfrequenz. Sinkt dieses Verhältnis im Lauf des Arbeitsblocks,
 * brauchst du für dieselbe Leistung mehr Schläge – der klassische Marker dafür,
 * dass die Einheit aus dem Grundlagenbereich herausläuft.
 *
 *   Drift (%) = (PwHR_erste_Hälfte − PwHR_zweite_Hälfte) / PwHR_erste_Hälfte × 100
 *
 * Positiv bedeutet also: Effizienz nimmt ab. Unter etwa 5 % gilt eine Einheit
 * gemeinhin als sauber aerob.
 *
 * Entscheidend gegenüber vorher: Messpunkte werden nur übernommen, wenn HR und
 * Leistung beide frisch sind. Ein eingefrorener Wert eines abgerissenen Sensors
 * würde die Rechnung sonst still verfälschen – und zwar in Richtung
 * "alles in Ordnung", also genau falsch herum.
 */

const MAX_WINDOW_MIN  = 30;
const MIN_ELAPSED_MIN = 10;
const MIN_SAMPLES     = 10;

export class PwHRDrift {
    constructor() {
        this.reset();
    }

    reset() {
        this._samples        = [];   // { time, hr, watts }
        this._workBlockStart = null;
        this._rejected       = 0;
    }

    setWorkBlockStart(timeMs = Date.now()) {
        this._workBlockStart = timeMs;
        this._samples  = [];
        this._rejected = 0;
    }

    get workBlockStart() { return this._workBlockStart; }
    get sampleCount()    { return this._samples.length; }

    /**
     * Messpunkt hinzufügen, etwa einmal pro Sekunde.
     * @param {number|null} hr
     * @param {number|null} watts
     * @param {number} now
     * @param {boolean} fresh – sind beide Werte aktuell (keine toten Sensoren)
     */
    addSample(hr, watts, now = Date.now(), fresh = true) {
        if (!this._workBlockStart) return false;
        if (!fresh) { this._rejected++; return false; }
        if (!hr || !watts || hr <= 0 || watts <= 0) { this._rejected++; return false; }
        // Grobe Plausibilität, damit einzelne Ausreißer die Mittelwerte nicht kippen
        if (hr < 40 || hr > 220 || watts > 1000) { this._rejected++; return false; }

        this._samples.push({ time: now, hr, watts });
        return true;
    }

    /** Nach einer Wiederaufnahme: Messpunkte aus den gespeicherten Rohdaten zurückholen */
    restoreFromRecords(records, workBlockStart) {
        this._workBlockStart = workBlockStart;
        this._samples = [];
        for (const r of records ?? []) {
            if (r.t < workBlockStart) continue;
            if (!r.hr || !r.w || r.hr <= 0 || r.w <= 0) continue;
            this._samples.push({ time: r.t, hr: r.hr, watts: r.w });
        }
    }

    /**
     * @returns {{ready:boolean, drift:number|null, elapsedMin:number,
     *             firstHalf:number|null, secondHalf:number|null,
     *             coverage:number}}
     */
    calculate(now = Date.now()) {
        if (!this._workBlockStart) {
            return { ready: false, drift: null, elapsedMin: 0, coverage: 0 };
        }

        const elapsedMin = (now - this._workBlockStart) / 60_000;
        const coverage = this._samples.length + this._rejected > 0
            ? this._samples.length / (this._samples.length + this._rejected)
            : 0;

        if (elapsedMin < MIN_ELAPSED_MIN) {
            return { ready: false, drift: null, elapsedMin, coverage };
        }

        const halfWindowMs = Math.min(elapsedMin / 2, MAX_WINDOW_MIN) * 60_000;

        const firstEnd    = this._workBlockStart + halfWindowMs;
        const secondStart = now - halfWindowMs;

        const first  = this._samples.filter((s) => s.time >= this._workBlockStart && s.time <= firstEnd);
        const second = this._samples.filter((s) => s.time >= secondStart && s.time <= now);

        if (first.length < MIN_SAMPLES || second.length < MIN_SAMPLES) {
            return { ready: false, drift: null, elapsedMin, coverage };
        }

        const avgPwHR = (arr) => arr.reduce((sum, s) => sum + s.watts / s.hr, 0) / arr.length;

        const pwhrFirst  = avgPwHR(first);
        const pwhrSecond = avgPwHR(second);
        if (!pwhrFirst) {
            return { ready: false, drift: null, elapsedMin, coverage };
        }

        const drift = ((pwhrFirst - pwhrSecond) / pwhrFirst) * 100;

        return {
            ready:      true,
            drift:      Math.round(drift * 10) / 10,
            elapsedMin,
            coverage,
            firstHalf:  Math.round(pwhrFirst * 100) / 100,
            secondHalf: Math.round(pwhrSecond * 100) / 100,
        };
    }

    /** Minuten, bis die erste Berechnung möglich ist */
    minutesUntilReady(now = Date.now()) {
        if (!this._workBlockStart) return MIN_ELAPSED_MIN;
        const elapsedMin = (now - this._workBlockStart) / 60_000;
        return Math.max(0, Math.ceil(MIN_ELAPSED_MIN - elapsedMin));
    }
}
