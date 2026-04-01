/**
 * Sessionhistorie – gespeichert in localStorage als JSON
 */

const STORAGE_KEY = 'zone2-trainer-sessions';

export class History {
    constructor() {
        this._sessions = this._load();
    }

    _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._sessions));
        } catch { /* ignorieren */ }
    }

    /**
     * @param {Object} entry
     *   date: string (ISO), hrvStatus: string, workDurationSec: number,
     *   avgHR: number, avgWatts: number, driftAtEnd: number|null
     */
    add(entry) {
        this._sessions.unshift({
            id:              Date.now(),
            date:            entry.date ?? new Date().toISOString(),
            hrvStatus:       entry.hrvStatus ?? 'green',
            workDurationSec: entry.workDurationSec ?? 0,
            avgHR:           entry.avgHR ?? null,
            avgWatts:        entry.avgWatts ?? null,
            driftAtEnd:      entry.driftAtEnd ?? null,
        });
        this._save();
    }

    getAll() {
        return [...this._sessions];
    }

    /** Exportiert als CSV-String */
    toCSV() {
        const header = 'Datum;HRV-Status;Arbeitsblock-Dauer (min);Ø HR (bpm);Ø Watt;Drift bei Abbruch (%)';
        const rows = this._sessions.map((s) => {
            const date = new Date(s.date).toLocaleString('de-DE');
            const dur  = s.workDurationSec ? Math.round(s.workDurationSec / 60) : '-';
            const hr   = s.avgHR    ?? '-';
            const w    = s.avgWatts ?? '-';
            const d    = s.driftAtEnd != null ? s.driftAtEnd.toFixed(1) : '-';
            const hrv  = { green: 'Grün', yellow: 'Gelb', red: 'Rot' }[s.hrvStatus] ?? s.hrvStatus;
            return `${date};${hrv};${dur};${hr};${w};${d}`;
        });
        return [header, ...rows].join('\n');
    }

    /** Trigger CSV-Download im Browser */
    downloadCSV() {
        const csv  = this.toCSV();
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `zone2-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }
}
