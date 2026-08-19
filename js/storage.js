/**
 * Persistenz auf IndexedDB
 *
 * Vier Ablagen:
 *   kv       – Schlüssel/Wert, u.a. der Schnappschuss der laufenden Session
 *   records  – 1-Hz-Messpunkte, fortlaufend angehängt (Index auf sid)
 *   sessions – kleine Zusammenfassung je Session (für Verlauf und Trends)
 *   blobs    – fertige FIT-Dateien, damit nichts durch einen fehlgeschlagenen
 *              Download verloren geht
 *
 * Messpunkte stehen absichtlich NICHT im Schnappschuss: der Schnappschuss läuft
 * 1x/s, die Messpunkte werden gesammelt und alle paar Sekunden als Stapel
 * angehängt. Sonst würde nach einer Stunde jede Sekunde ein Array mit tausenden
 * Objekten serialisiert.
 *
 * Ist IndexedDB nicht verfügbar (privater Modus, blockierter Speicher), fällt
 * alles auf einen Speicher im RAM zurück. Die App läuft dann normal weiter, nur
 * die Wiederaufnahme nach einem Neustart entfällt – das meldet isAvailable().
 */

const DB_NAME    = 'zone2-trainer';
const DB_VERSION = 1;

const STORE_KV       = 'kv';
const STORE_RECORDS  = 'records';
const STORE_SESSIONS = 'sessions';
const STORE_BLOBS    = 'blobs';

const KEY_ACTIVE = 'activeSession';

export class Storage {
    constructor() {
        this._db      = null;
        this._opening = null;
        this._failed  = false;
        this._memory  = new Map();
    }

    _open() {
        if (this._db)      return Promise.resolve(this._db);
        if (this._failed)  return Promise.resolve(null);
        if (this._opening) return this._opening;

        this._opening = new Promise((resolve) => {
            let req;
            try {
                if (typeof indexedDB === 'undefined') throw new Error('kein indexedDB');
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch {
                this._failed = true;
                return resolve(null);
            }

            // Bleibt das Öffnen hängen (kommt auf Android bei blockiertem Speicher
            // vor), nicht ewig warten – lieber ohne Persistenz weiterlaufen.
            const bail = setTimeout(() => {
                if (!this._db) { this._failed = true; resolve(null); }
            }, 4000);

            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_KV)) {
                    db.createObjectStore(STORE_KV, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(STORE_RECORDS)) {
                    const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'n', autoIncrement: true });
                    s.createIndex('sid', 'sid', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
                    db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(STORE_BLOBS)) {
                    db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => {
                clearTimeout(bail);
                this._db = req.result;
                this._db.onversionchange = () => {
                    try { this._db.close(); } catch { /* egal */ }
                    this._db = null;
                };
                resolve(this._db);
            };
            req.onerror   = () => { clearTimeout(bail); this._failed = true; resolve(null); };
            req.onblocked = () => { clearTimeout(bail); this._failed = true; resolve(null); };
        });

        return this._opening;
    }

    async isAvailable() {
        return (await this._open()) !== null;
    }

    /**
     * Führt fn(objectStore) aus und löst mit dem Ergebnis der zurückgegebenen
     * IDBRequest auf, sobald die Transaktion abgeschlossen ist.
     * Gibt null zurück, wenn keine Datenbank verfügbar ist.
     */
    async _run(store, mode, fn) {
        const db = await this._open();
        if (!db) return { noDb: true };
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(store, mode);
            } catch (err) {
                return reject(err);
            }
            let req = null;
            try {
                req = fn(tx.objectStore(store));
            } catch (err) {
                try { tx.abort(); } catch { /* egal */ }
                return reject(err);
            }
            tx.oncomplete = () => resolve({ value: req ? req.result : undefined });
            tx.onerror    = () => reject(tx.error ?? new Error('Transaktion fehlgeschlagen'));
            tx.onabort    = () => reject(tx.error ?? new Error('Transaktion abgebrochen'));
        });
    }

    // ── Schlüssel/Wert ────────────────────────────────────────────────────────

    async kvSet(key, value) {
        try {
            const r = await this._run(STORE_KV, 'readwrite', (os) => os.put({ key, value }));
            if (r.noDb) this._memory.set(key, value);
        } catch {
            this._memory.set(key, value);
        }
    }

    async kvGet(key) {
        try {
            const r = await this._run(STORE_KV, 'readonly', (os) => os.get(key));
            if (r.noDb) return this._memory.get(key);
            return r.value ? r.value.value : undefined;
        } catch {
            return this._memory.get(key);
        }
    }

    async kvDelete(key) {
        this._memory.delete(key);
        try {
            await this._run(STORE_KV, 'readwrite', (os) => os.delete(key));
        } catch { /* egal */ }
    }

    // ── Schnappschuss der laufenden Session ───────────────────────────────────

    saveSnapshot(snapshot) { return this.kvSet(KEY_ACTIVE, snapshot); }
    loadSnapshot()         { return this.kvGet(KEY_ACTIVE); }
    clearSnapshot()        { return this.kvDelete(KEY_ACTIVE); }

    // ── Messpunkte ────────────────────────────────────────────────────────────

    /** Stapel von Messpunkten anhängen – eine Transaktion für alle */
    async appendRecords(sid, records) {
        if (!records || !records.length) return;
        try {
            await this._run(STORE_RECORDS, 'readwrite', (os) => {
                for (const r of records) {
                    os.put({ sid, t: r.t, hr: r.hr, w: r.w, tw: r.tw, cad: r.cad, ph: r.ph });
                }
                return null;
            });
        } catch { /* Rohdatenverlust ist verschmerzbar, die App läuft weiter */ }
    }

    async getRecords(sid) {
        try {
            const r = await this._run(STORE_RECORDS, 'readonly', (os) => os.index('sid').getAll(sid));
            if (r.noDb) return [];
            return (r.value ?? []).sort((a, b) => a.t - b.t);
        } catch {
            return [];
        }
    }

    async deleteRecords(sid) {
        try {
            await this._run(STORE_RECORDS, 'readwrite', (os) => {
                const req = os.index('sid').openKeyCursor(IDBKeyRange.only(sid));
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) return;
                    os.delete(cur.primaryKey);
                    cur.continue();
                };
                return null;
            });
        } catch { /* egal */ }
    }

    // ── Session-Zusammenfassungen ─────────────────────────────────────────────

    async putSession(meta) {
        try {
            const r = await this._run(STORE_SESSIONS, 'readwrite', (os) => os.put(meta));
            if (r.noDb) {
                const list = this._memory.get('sessions') ?? [];
                this._memory.set('sessions', [meta, ...list.filter((s) => s.id !== meta.id)]);
            }
        } catch { /* Verlauf ist für den laufenden Betrieb nicht kritisch */ }
    }

    async getSessions() {
        try {
            const r = await this._run(STORE_SESSIONS, 'readonly', (os) => os.getAll());
            const list = r.noDb ? (this._memory.get('sessions') ?? []) : (r.value ?? []);
            return list.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
        } catch {
            return [];
        }
    }

    async deleteSession(id) {
        try {
            await this._run(STORE_SESSIONS, 'readwrite', (os) => os.delete(id));
            await this._run(STORE_BLOBS,    'readwrite', (os) => os.delete(id));
            await this.deleteRecords(id);
        } catch { /* egal */ }
    }

    // ── FIT-Dateien ───────────────────────────────────────────────────────────

    async putFit(id, bytes, filename) {
        try {
            const r = await this._run(STORE_BLOBS, 'readwrite', (os) => os.put({ id, bytes, filename }));
            return !r.noDb;
        } catch {
            return false;
        }
    }

    async getFit(id) {
        try {
            const r = await this._run(STORE_BLOBS, 'readonly', (os) => os.get(id));
            return r.noDb ? null : (r.value ?? null);
        } catch {
            return null;
        }
    }

    /** Hält die Ablage klein: Rohdaten und FIT-Dateien alter Sessions entfernen */
    async prune(keepDetailed = 20) {
        const sessions = await this.getSessions();
        for (const s of sessions.slice(keepDetailed)) {
            if (s.detailPurged) continue;
            await this.deleteRecords(s.id);
            try {
                await this._run(STORE_BLOBS, 'readwrite', (os) => os.delete(s.id));
            } catch { /* egal */ }
            await this.putSession({ ...s, detailPurged: true });
        }
    }
}
