/**
 * Sessionverlauf
 *
 * Liegt in IndexedDB statt in localStorage: dort passen auch die Rohdaten und
 * die fertigen FIT-Dateien daneben, und der Verlauf überlebt einen
 * fehlgeschlagenen Download.
 *
 * Die interessante Kennzahl ist nicht die einzelne Einheit, sondern die
 * Entwicklung: aerobe Effizienz (Watt je Herzschlag) steigend und Drift
 * fallend heißt, dass die Grundlagenarbeit greift.
 */

export class History {
    constructor(storage) {
        this.storage   = storage;
        this._sessions = [];
    }

    async load() {
        this._sessions = await this.storage.getSessions();
        return this._sessions;
    }

    getAll() { return this._sessions.slice(); }

    async add(meta) {
        await this.storage.putSession(meta);
        await this.load();
        // Rohdaten und FIT-Dateien alter Einheiten aufräumen
        this.storage.prune(20).catch(() => {});
        return meta;
    }

    async remove(id) {
        await this.storage.deleteSession(id);
        await this.load();
    }

    getById(id) {
        return this._sessions.find((s) => s.id === id) ?? null;
    }

    // ── Auswertung ────────────────────────────────────────────────────────────

    /**
     * Wochenübersicht: Einheiten und Dauer dieser Woche plus die Serie
     * aufeinanderfolgender Wochen mit mindestens einer Einheit.
     */
    getWeekStats(now = new Date()) {
        const thisWeek = weekKey(now);
        const byWeek = new Map();

        for (const s of this._sessions) {
            const k = weekKey(new Date(s.date));
            const e = byWeek.get(k) ?? { count: 0, sec: 0 };
            e.count += 1;
            e.sec   += s.totalDurationSec ?? s.workDurationSec ?? 0;
            byWeek.set(k, e);
        }

        const current = byWeek.get(thisWeek) ?? { count: 0, sec: 0 };

        // Serie: von dieser Woche rückwärts zählen. Ist die laufende Woche noch
        // leer, darf die Serie trotzdem stehen – sie bricht erst, wenn eine
        // ganze Woche ohne Einheit vergangen ist.
        let streak = 0;
        let cursor = new Date(now);
        if (!byWeek.has(thisWeek)) cursor = addDays(cursor, -7);
        while (byWeek.has(weekKey(cursor))) {
            streak++;
            cursor = addDays(cursor, -7);
        }

        return {
            count:  current.count,
            sec:    current.sec,
            streak,
            weekLabel: thisWeek,
        };
    }

    /** Daten für die Trendkurve: neueste zuerst, wie getAll() */
    getTrend(limit = 30) {
        return this._sessions
            .filter((s) => s.ef != null)
            .slice(0, limit);
    }

    /** Veränderung der aeroben Effizienz gegenüber dem Mittel der Vorwochen */
    getEfDelta() {
        const withEf = this._sessions.filter((s) => s.ef != null);
        if (withEf.length < 4) return null;
        const recent = withEf.slice(0, 3);
        const older  = withEf.slice(3, 9);
        if (!older.length) return null;
        const avg = (a) => a.reduce((s, x) => s + x.ef, 0) / a.length;
        const now = avg(recent);
        const before = avg(older);
        if (!before) return null;
        return Math.round(((now - before) / before) * 1000) / 10;   // Prozent
    }

    // ── Export ────────────────────────────────────────────────────────────────

    toCSV() {
        const header = [
            'Datum', 'HRV-Status', 'Ziel-Watt', 'Arbeitsblock (min)', 'Gesamt (min)',
            'Ø HR (bpm)', 'Max HR (bpm)', 'Ø Watt', 'Aerobe Effizienz (W/bpm)',
            'Drift (%)', 'Ende',
        ].join(';');

        const rows = this._sessions.map((s) => {
            const d   = new Date(s.date).toLocaleString('de-DE');
            const hrv = { green: 'Grün', yellow: 'Gelb', red: 'Rot' }[s.hrvStatus] ?? (s.hrvStatus ?? '-');
            const num = (v, dec = 0) => v == null ? '-' : v.toFixed(dec).replace('.', ',');
            return [
                d, hrv,
                s.targetWatts ?? '-',
                s.workDurationSec  ? Math.round(s.workDurationSec / 60)  : '-',
                s.totalDurationSec ? Math.round(s.totalDurationSec / 60) : '-',
                s.avgHR ?? '-', s.maxHR ?? '-', s.avgWatts ?? '-',
                num(s.ef, 3),
                num(s.driftAtEnd, 1),
                s.endReason ?? '-',
            ].join(';');
        });

        return [header, ...rows].join('\r\n');
    }

    downloadCSV() {
        const blob = new Blob(['﻿' + this.toCSV()], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `zone2-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            try { document.body.removeChild(a); } catch { /* egal */ }
            URL.revokeObjectURL(url);
        }, 30_000);
    }
}

// ── Hilfsfunktionen für Kalenderwochen ────────────────────────────────────────

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

/** ISO-Kalenderwoche als "2026-KW34" – Wochen beginnen am Montag */
function weekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;          // Sonntag = 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);  // auf den Donnerstag der Woche
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-KW${String(week).padStart(2, '0')}`;
}
