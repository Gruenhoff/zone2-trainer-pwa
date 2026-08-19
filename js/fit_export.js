/**
 * FIT File Export (Browser)
 * Erzeugt valide .fit-Dateien (little-endian) kompatibel mit Garmin Connect / intervals.icu
 *
 * Implementierte Messages:
 *   0  – file_id
 *   18 – session
 *   19 – lap
 *   20 – record (HR, Power, 1Hz)
 *   34 – activity
 */

// FIT Epoch: 1989-12-31T00:00:00Z → Unix ms
const FIT_EPOCH_MS = 631065600000;

const CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
];

function fitCRC(data, start = 0, end = data.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        const byte = data[i];
        let tmp = CRC_TABLE[crc & 0x0f];
        crc = (crc >> 4) & 0x0fff;
        crc ^= tmp ^ CRC_TABLE[byte & 0x0f];
        tmp = CRC_TABLE[crc & 0x0f];
        crc = (crc >> 4) & 0x0fff;
        crc ^= tmp ^ CRC_TABLE[(byte >> 4) & 0x0f];
    }
    return crc;
}

function toFitTime(date) {
    return Math.round((date.getTime() - FIT_EPOCH_MS) / 1000);
}

// ── Byte-Builder ─────────────────────────────────────────────────────────────

class ByteBuilder {
    constructor() { this._bytes = []; }

    u8(v)  { this._bytes.push(v & 0xff); }
    u16(v) { this._bytes.push(v & 0xff, (v >> 8) & 0xff); }
    u32(v) { this._bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); }
    i16(v) { this.u16(v < 0 ? v + 65536 : v); }

    append(other) { for (const b of other) this._bytes.push(b); }
    toUint8Array() { return new Uint8Array(this._bytes); }
    get length() { return this._bytes.length; }
}

// ── Definition Messages ───────────────────────────────────────────────────────

function defMsg(localMesgNum, globalMesgNum, fields) {
    // fields: [{num, size, baseType}]
    const b = new ByteBuilder();
    b.u8(0x40 | localMesgNum); // definition header
    b.u8(0x00);                // reserved
    b.u8(0x00);                // architecture: little-endian
    b.u16(globalMesgNum);
    b.u8(fields.length);
    for (const f of fields) {
        b.u8(f.num);
        b.u8(f.size);
        b.u8(f.baseType);
    }
    return b.toUint8Array();
}

// base types
const BT_ENUM   = 0x00; // uint8
const BT_UINT8  = 0x02;
const BT_UINT16 = 0x84;
const BT_UINT32 = 0x86;

// Local message numbers
const LM_FILE_ID  = 0;
const LM_RECORD   = 1;
const LM_LAP      = 2;
const LM_SESSION  = 3;
const LM_ACTIVITY = 4;

// ── FIT File Builder ──────────────────────────────────────────────────────────

export function buildFitFile(records, laps, sessionStart, sessionEnd, avgHR, avgPower) {
    const data = new ByteBuilder();

    // ── Definitionen ────────────────────────────────────────────────────────
    // file_id (global 0)
    data.append(defMsg(LM_FILE_ID, 0, [
        { num: 0, size: 1, baseType: BT_ENUM   }, // type: 4 = activity
        { num: 1, size: 2, baseType: BT_UINT16 }, // manufacturer
        { num: 4, size: 4, baseType: BT_UINT32 }, // time_created
    ]));

    // record (global 20)
    data.append(defMsg(LM_RECORD, 20, [
        { num: 253, size: 4, baseType: BT_UINT32 }, // timestamp
        { num: 3,   size: 1, baseType: BT_UINT8  }, // heart_rate
        { num: 7,   size: 2, baseType: BT_UINT16 }, // power
    ]));

    // lap (global 19)
    data.append(defMsg(LM_LAP, 19, [
        { num: 253, size: 4, baseType: BT_UINT32 }, // timestamp
        { num: 2,   size: 4, baseType: BT_UINT32 }, // start_time
        { num: 7,   size: 4, baseType: BT_UINT32 }, // total_elapsed_time (× 1000)
        { num: 25,  size: 1, baseType: BT_UINT8  }, // sport (2 = cycling)
    ]));

    // session (global 18)
    data.append(defMsg(LM_SESSION, 18, [
        { num: 253, size: 4, baseType: BT_UINT32 }, // timestamp
        { num: 2,   size: 4, baseType: BT_UINT32 }, // start_time
        { num: 7,   size: 4, baseType: BT_UINT32 }, // total_elapsed_time (× 1000)
        { num: 5,   size: 1, baseType: BT_ENUM   }, // sport (2 = cycling)
        { num: 16,  size: 1, baseType: BT_UINT8  }, // avg_heart_rate
        { num: 20,  size: 2, baseType: BT_UINT16 }, // avg_power
    ]));

    // activity (global 34)
    data.append(defMsg(LM_ACTIVITY, 34, [
        { num: 253, size: 4, baseType: BT_UINT32 }, // timestamp
        { num: 1,   size: 4, baseType: BT_UINT32 }, // total_timer_time (× 1000)
        { num: 5,   size: 1, baseType: BT_UINT8  }, // num_sessions
        { num: 2,   size: 1, baseType: BT_ENUM   }, // type (0 = manual)
    ]));

    // ── file_id Data ─────────────────────────────────────────────────────────
    const b = new ByteBuilder();
    b.u8(LM_FILE_ID);
    b.u8(4);                           // type = activity
    b.u16(255);                        // manufacturer = development
    b.u32(toFitTime(sessionStart));    // time_created
    data.append(b.toUint8Array());

    // ── Record Data ──────────────────────────────────────────────────────────
    for (const rec of records) {
        const rb = new ByteBuilder();
        rb.u8(LM_RECORD);
        rb.u32(toFitTime(rec.timestamp));
        rb.u8(Math.min(255, Math.max(0, rec.hr ?? 0)));
        rb.u16(Math.min(65534, Math.max(0, rec.watts ?? 0)));
        data.append(rb.toUint8Array());
    }

    // ── Lap Data ─────────────────────────────────────────────────────────────
    for (const lap of laps) {
        const lb = new ByteBuilder();
        const elapsedSec = Math.round((lap.endTime - lap.startTime) / 1000);
        lb.u8(LM_LAP);
        lb.u32(toFitTime(lap.endTime));
        lb.u32(toFitTime(lap.startTime));
        lb.u32(elapsedSec * 1000);
        lb.u8(2); // cycling
        data.append(lb.toUint8Array());
    }

    // ── Session Data ─────────────────────────────────────────────────────────
    {
        const sb = new ByteBuilder();
        const totalSec = Math.round((sessionEnd.getTime() - sessionStart.getTime()) / 1000);
        sb.u8(LM_SESSION);
        sb.u32(toFitTime(sessionEnd));
        sb.u32(toFitTime(sessionStart));
        sb.u32(totalSec * 1000);
        sb.u8(2);  // cycling
        sb.u8(Math.min(255, Math.max(0, avgHR ?? 0)));
        sb.u16(Math.min(65534, Math.max(0, avgPower ?? 0)));
        data.append(sb.toUint8Array());
    }

    // ── Activity Data ─────────────────────────────────────────────────────────
    {
        const ab = new ByteBuilder();
        const totalSec = Math.round((sessionEnd.getTime() - sessionStart.getTime()) / 1000);
        ab.u8(LM_ACTIVITY);
        ab.u32(toFitTime(sessionEnd));
        ab.u32(totalSec * 1000);
        ab.u8(1);   // num_sessions
        ab.u8(0);   // type = manual
        data.append(ab.toUint8Array());
    }

    // ── File Header + CRC ─────────────────────────────────────────────────────
    const dataBytes = data.toUint8Array();
    const header = new ByteBuilder();
    header.u8(14);          // header size
    header.u8(0x10);        // protocol version 1.0
    header.u16(2132);       // profile version 21.32
    header.u32(dataBytes.length);
    // ".FIT" magic
    header.u8(0x2e); header.u8(0x46); header.u8(0x49); header.u8(0x54);
    const headerBytes = header.toUint8Array();
    const headerCRC = fitCRC(headerBytes);
    const headerCRCBytes = new Uint8Array([headerCRC & 0xff, (headerCRC >> 8) & 0xff]);

    // File CRC über Header + Data
    const combined = new Uint8Array(headerBytes.length + 2 + dataBytes.length);
    combined.set(headerBytes, 0);
    combined.set(headerCRCBytes, headerBytes.length);
    combined.set(dataBytes, headerBytes.length + 2);
    const fileCRC = fitCRC(combined);

    const result = new Uint8Array(combined.length + 2);
    result.set(combined, 0);
    result[combined.length]     = fileCRC & 0xff;
    result[combined.length + 1] = (fileCRC >> 8) & 0xff;

    return result;
}

/** Standardname aus dem Startzeitpunkt */
export function fitFilename(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `zone2-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
         + `_${p(date.getHours())}${p(date.getMinutes())}.fit`;
}

/**
 * FIT-Datei herunterladen.
 *
 * Der Anker muss im Dokument hängen, sonst ignorieren manche Android-Browser
 * den Klick. Und die Objekt-URL darf erst später freigegeben werden – wird sie
 * direkt nach click() zurückgenommen, bricht der Download ab, bevor er begonnen
 * hat.
 */
export function downloadFit(fitBytes, filename = null) {
    const name = filename ?? fitFilename();
    const blob = new Blob([fitBytes], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href          = url;
    a.download      = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        try { document.body.removeChild(a); } catch { /* egal */ }
        URL.revokeObjectURL(url);
    }, 30_000);
    return name;
}

/** Kann das Gerät Dateien über den Teilen-Dialog weitergeben? */
export function canShareFit() {
    if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
    try {
        const probe = new File([new Uint8Array([0])], 'p.fit', { type: 'application/octet-stream' });
        return navigator.canShare({ files: [probe] });
    } catch {
        return false;
    }
}

/**
 * FIT-Datei über den Teilen-Dialog weitergeben (Strava, intervals.icu, Drive, Mail).
 * @returns {Promise<'geteilt'|'abgebrochen'|'nicht-moeglich'>}
 */
export async function shareFit(fitBytes, filename = null, title = 'Zone2 Training') {
    if (!canShareFit()) return 'nicht-moeglich';
    const name = filename ?? fitFilename();
    try {
        const file = new File([fitBytes], name, { type: 'application/octet-stream' });
        await navigator.share({ files: [file], title, text: title });
        return 'geteilt';
    } catch (err) {
        // AbortError heißt schlicht: Nutzer hat den Dialog geschlossen
        if (err?.name === 'AbortError') return 'abgebrochen';
        return 'nicht-moeglich';
    }
}

/** Interne Messpunkte in das von buildFitFile erwartete Format bringen */
export function recordsToFit(records) {
    return (records ?? [])
        .filter((r) => r.hr > 0 || r.w > 0)
        .map((r) => ({ timestamp: new Date(r.t), hr: r.hr, watts: r.w }));
}

/** Laps werden intern als Zahlen geführt, der Export erwartet Date-Objekte */
export function lapsToFit(laps) {
    return (laps ?? [])
        .filter((l) => l.endTime > l.startTime)
        .map((l) => ({
            startTime: new Date(l.startTime),
            endTime:   new Date(l.endTime),
            name:      l.name,
        }));
}
