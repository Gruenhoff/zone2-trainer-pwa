/**
 * Kurbelleistungsmesser – Cycling Power Service (0x1818)
 * Characteristic: Cycling Power Measurement (0x2A63)
 */

const CP_SERVICE_UUID = 0x1818;
const CP_MEASUREMENT_UUID = 0x2a63;

export class PowermeterBluetooth {
    constructor() {
        this.device = null;
        this.server = null;
        this.isConnected = false;
        this._reconnectTimer = null;
        this._stopReconnect = false;

        this.onPower      = null;  // (watts: number) => void
        this.onConnect    = null;
        this.onDisconnect = null;
        this.onError      = null;
        this.onStatus     = null;
    }

    static isAvailable() {
        return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    async connect() {
        if (!PowermeterBluetooth.isAvailable()) {
            this._error('Web Bluetooth nicht verfügbar.');
            return false;
        }
        this._stopReconnect = false;
        try {
            this._status('Suche Powermeter...');
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [CP_SERVICE_UUID] }],
                optionalServices: [CP_SERVICE_UUID],
            });
            this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
            await this._connectGatt();
            return true;
        } catch (err) {
            if (err.name === 'NotFoundError') {
                this._error('Kein Powermeter ausgewählt.');
            } else {
                this._error(`Powermeter Verbindungsfehler: ${err.message}`);
            }
            return false;
        }
    }

    async _connectGatt() {
        this._status('Verbinde Powermeter...');
        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService(CP_SERVICE_UUID);
        const char = await service.getCharacteristic(CP_MEASUREMENT_UUID);
        char.addEventListener('characteristicvaluechanged', (e) => this._parsePower(e.target.value));
        await char.startNotifications();
        this.isConnected = true;
        this._status('Powermeter verbunden');
        if (this.onConnect) this.onConnect();
    }

    _parsePower(data) {
        // Cycling Power Measurement:
        // Byte 0-1: Flags (uint16 LE)
        // Byte 2-3: Instantaneous Power (sint16 LE, Watt)
        if (data.byteLength < 4) return;
        const watts = data.getInt16(2, true);
        if (this.onPower) this.onPower(Math.max(0, watts));
    }

    async _onDisconnected() {
        this.isConnected = false;
        this._status('Powermeter getrennt');
        if (this.onDisconnect) this.onDisconnect();
        if (!this._stopReconnect) this._scheduleReconnect();
    }

    _scheduleReconnect() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(async () => {
            if (this._stopReconnect || !this.device) return;
            this._status('Powermeter Reconnect...');
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
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        this.isConnected = false;
    }

    _status(msg) { if (this.onStatus) this.onStatus(msg); }
    _error(msg)  { if (this.onError)  this.onError(msg);  }
}
