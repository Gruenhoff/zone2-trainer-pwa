/**
 * Polar H10 – Heart Rate Service (0x180D), Characteristic 0x2A37
 *
 * Liefert Herzfrequenz und, wenn das Gerät sie sendet, die RR-Intervalle. Aus
 * den RR-Intervallen lässt sich die Herzfrequenz spürbar schneller ableiten als
 * aus dem geglätteten Wert, den der Gurt selbst schickt.
 */

import { BleDevice } from './ble_base.js';

const HR_SERVICE_UUID        = 0x180d;
const HR_CHARACTERISTIC_UUID = 0x2a37;

export class H10Bluetooth extends BleDevice {
    constructor() {
        super({
            key:      'h10',
            label:    'Polar H10',
            filters:  [{ namePrefix: 'Polar' }, { services: [HR_SERVICE_UUID] }],
            services: [HR_SERVICE_UUID],
        });

        this.onHeartRate  = null;   // (bpm) => void
        this.onRRInterval = null;   // (rrMs) => void
        this.onContactLost = null;  // () => void – Gurt hat keinen Hautkontakt

        this._contactOk = true;
    }

    async _setupServices(server) {
        const service = await server.getPrimaryService(HR_SERVICE_UUID);
        const char    = await service.getCharacteristic(HR_CHARACTERISTIC_UUID);
        // Der Zuhörer hängt an einem bei jedem Verbinden neu geholten Objekt,
        // sammelt sich also nicht an.
        char.addEventListener('characteristicvaluechanged', (e) => this._parseHR(e.target.value));
        await char.startNotifications();
    }

    _parseHR(data) {
        if (!data || data.byteLength < 2) return;
        this._markData();

        const flags     = data.getUint8(0);
        const hr16bit   = flags & 0x01;
        const contactSupported = (flags >> 2) & 0x01;
        const contactDetected  = (flags >> 1) & 0x01;
        const energyExp = (flags >> 3) & 0x01;
        const rrPresent = (flags >> 4) & 0x01;

        let offset = 1;
        if (offset + (hr16bit ? 2 : 1) > data.byteLength) return;
        const hr = hr16bit ? data.getUint16(offset, true) : data.getUint8(offset);
        offset += hr16bit ? 2 : 1;

        // Hautkontakt: nur melden, wenn der Gurt die Information überhaupt liefert
        if (contactSupported) {
            const ok = !!contactDetected;
            if (this._contactOk && !ok && this.onContactLost) this.onContactLost();
            this._contactOk = ok;
        }

        // Ein Wert von 0 heißt "noch kein Messwert", nicht "Herzstillstand"
        if (hr > 0 && this.onHeartRate) this.onHeartRate(hr);

        if (energyExp) offset += 2;

        if (rrPresent) {
            while (offset + 1 < data.byteLength) {
                const rrRaw = data.getUint16(offset, true);
                offset += 2;
                // RR kommt in 1/1024 s
                const rrMs = Math.round(rrRaw * (1000 / 1024));
                if (this.onRRInterval) this.onRRInterval(rrMs);
            }
        }
    }
}
