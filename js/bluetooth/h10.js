/**
 * Polar H10 – Web Bluetooth Verbindung
 * Heart Rate Service (0x180D), Characteristic 0x2A37
 */

const HR_SERVICE_UUID        = 0x180d;
const HR_CHARACTERISTIC_UUID = 0x2a37;

export class H10Bluetooth {
    constructor() {
        this.device = null;
        this.server = null;
        this.hrCharacteristic = null;
        this.isConnected = false;
        this._reconnectTimer = null;
        this._stopReconnect = false;

        this.onHeartRate   = null;  // (bpm: number) => void
        this.onRRInterval  = null;  // (rrMs: number) => void
        this.onConnect     = null;  // () => void
        this.onDisconnect  = null;  // () => void
        this.onError       = null;  // (msg: string) => void
        this.onStatus      = null;  // (msg: string) => void
    }

    static isAvailable() {
        return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    async connect() {
        if (!H10Bluetooth.isAvailable()) {
            this._error('Web Bluetooth wird nicht unterstützt. Bitte Chrome verwenden.');
            return false;
        }
        this._stopReconnect = false;
        try {
            this._status('Suche Polar H10...');
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'Polar' }],
                optionalServices: [HR_SERVICE_UUID],
            });
            this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
            await this._connectGatt();
            return true;
        } catch (err) {
            if (err.name === 'NotFoundError') {
                this._error('Kein Gerät ausgewählt.');
            } else {
                this._error(`H10 Verbindungsfehler: ${err.message}`);
            }
            return false;
        }
    }

    async _connectGatt() {
        this._status('Verbinde H10...');
        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService(HR_SERVICE_UUID);
        this.hrCharacteristic = await service.getCharacteristic(HR_CHARACTERISTIC_UUID);
        this.hrCharacteristic.addEventListener('characteristicvaluechanged', (e) =>
            this._parseHR(e.target.value)
        );
        await this.hrCharacteristic.startNotifications();
        this.isConnected = true;
        this._status('H10 verbunden');
        if (this.onConnect) this.onConnect();
    }

    _parseHR(data) {
        const flags = data.getUint8(0);
        const hr16bit   = flags & 0x01;
        const energyExp = (flags >> 3) & 0x01;
        const rrPresent = (flags >> 4) & 0x01;

        let offset = 1;
        const hr = hr16bit ? data.getUint16(offset, true) : data.getUint8(offset);
        offset += hr16bit ? 2 : 1;

        if (this.onHeartRate) this.onHeartRate(hr);
        if (energyExp) offset += 2;

        if (rrPresent) {
            while (offset + 1 < data.byteLength) {
                const rrRaw = data.getUint16(offset, true);
                offset += 2;
                const rrMs = Math.round(rrRaw * (1000 / 1024));
                if (this.onRRInterval) this.onRRInterval(rrMs);
            }
        }
    }

    async _onDisconnected() {
        this.isConnected = false;
        this._status('H10 getrennt');
        if (this.onDisconnect) this.onDisconnect();
        if (!this._stopReconnect) {
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(async () => {
            if (this._stopReconnect || !this.device) return;
            this._status('H10 Reconnect...');
            try {
                await this._connectGatt();
            } catch {
                this._scheduleReconnect();
            }
        }, 5000);
    }

    disconnect() {
        this._stopReconnect = true;
        clearTimeout(this._reconnectTimer);
        if (this.device?.gatt?.connected) {
            this.device.gatt.disconnect();
        }
        this.isConnected = false;
    }

    _status(msg) { if (this.onStatus) this.onStatus(msg); }
    _error(msg)  { if (this.onError)  this.onError(msg);  }
}
