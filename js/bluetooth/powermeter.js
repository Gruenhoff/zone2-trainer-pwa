/**
 * Kurbel-Leistungsmesser – Cycling Power Service (0x1818)
 * Characteristic: Cycling Power Measurement (0x2A63)
 *
 * Neben der Momentanleistung wird, wenn vorhanden, die Trittfrequenz aus den
 * Kurbelumdrehungen berechnet. Angezeigt wird sie nicht – sie dient dem
 * ERG-Wächter als Antwort auf die Frage "tritt überhaupt jemand?".
 */

import { BleDevice } from './ble_base.js';

const CP_SERVICE_UUID     = 0x1818;
const CP_MEASUREMENT_UUID = 0x2a63;

export class PowermeterBluetooth extends BleDevice {
    constructor() {
        super({
            key:      'pm',
            label:    'Powermeter',
            filters:  [{ services: [CP_SERVICE_UUID] }],
            services: [CP_SERVICE_UUID],
        });

        this.onPower   = null;   // (watt) => void
        this.onCadence = null;   // (rpm) => void

        this._lastCrankRevs = null;
        this._lastCrankTime = null;
    }

    async _setupServices(server) {
        const service = await server.getPrimaryService(CP_SERVICE_UUID);
        const char    = await service.getCharacteristic(CP_MEASUREMENT_UUID);
        char.addEventListener('characteristicvaluechanged', (e) => this._parse(e.target.value));
        await char.startNotifications();
        this._lastCrankRevs = null;
        this._lastCrankTime = null;
    }

    _parse(data) {
        if (!data || data.byteLength < 4) return;
        this._markData();

        const flags = data.getUint16(0, true);
        const watts = data.getInt16(2, true);
        if (this.onPower) this.onPower(Math.max(0, watts));

        // Optionale Felder in der vom Standard vorgegebenen Reihenfolge überspringen
        let offset = 4;
        if (flags & 0x0001) offset += 1;   // Pedal Power Balance
        if (flags & 0x0004) offset += 2;   // Accumulated Torque
        if (flags & 0x0010) offset += 6;   // Wheel Revolution Data (uint32 + uint16)

        // Crank Revolution Data
        if ((flags & 0x0020) && data.byteLength >= offset + 4) {
            const revs = data.getUint16(offset, true);
            const time = data.getUint16(offset + 2, true);  // Einheit 1/1024 s
            this._computeCadence(revs, time);
        }
    }

    _computeCadence(revs, time) {
        if (this._lastCrankRevs !== null) {
            // Beide Werte laufen bei 65536 über
            let dRevs = (revs - this._lastCrankRevs + 0x10000) % 0x10000;
            let dTime = (time - this._lastCrankTime + 0x10000) % 0x10000;
            if (dTime > 0 && dRevs >= 0 && dRevs < 20) {
                const seconds = dTime / 1024;
                const rpm = Math.round((dRevs / seconds) * 60);
                if (rpm >= 0 && rpm < 250 && this.onCadence) this.onCadence(rpm);
            } else if (dTime === 0 && dRevs === 0) {
                // Keine neue Umdrehung – wird vom Aufrufer über die Zeit als
                // "steht" gewertet, hier nichts melden.
            }
        }
        this._lastCrankRevs = revs;
        this._lastCrankTime = time;
    }
}
