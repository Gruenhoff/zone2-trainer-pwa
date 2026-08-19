/**
 * Bildschirmsperre verhindern
 *
 * Android gibt einen Wake Lock kommentarlos zurück, sobald der Tab die
 * Sichtbarkeit verliert – ein eingehender Anruf, eine Benachrichtigung oder ein
 * kurzer App-Wechsel reichen. Deshalb wird der Lock bei jedem Zurückkommen neu
 * angefordert, solange ihn jemand haben will.
 *
 * Eine Garantie ist das nicht: im Energiesparmodus verweigert Android die
 * Anforderung. Genau dafür gibt es onChange – die Oberfläche zeigt dann an,
 * dass der Bildschirm ausgehen kann.
 */

export class ScreenLock {
    constructor() {
        this._sentinel = null;
        this._wanted   = false;
        this._retry    = null;

        this.onChange = null;   // (aktiv: boolean, grund: string|null) => void
    }

    static isSupported() {
        return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    }

    get isActive() {
        return !!this._sentinel && !this._sentinel.released;
    }

    /** Einmalig aufrufen – hängt sich an Sichtbarkeitswechsel */
    init() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this._wanted) {
                this._acquire();
            }
        });
        // Manche Android-Builds feuern nur pageshow nach einem Wiederherstellen
        window.addEventListener('pageshow', () => {
            if (this._wanted) this._acquire();
        });
    }

    async enable() {
        this._wanted = true;
        await this._acquire();
    }

    async disable() {
        this._wanted = false;
        clearTimeout(this._retry);
        this._retry = null;
        if (this._sentinel) {
            try { await this._sentinel.release(); } catch { /* egal */ }
            this._sentinel = null;
        }
        this._notify(false, null);
    }

    async _acquire() {
        if (!ScreenLock.isSupported()) {
            this._notify(false, 'Dieser Browser kann den Bildschirm nicht wachhalten.');
            return;
        }
        if (this.isActive) return;
        if (document.visibilityState !== 'visible') return;

        try {
            this._sentinel = await navigator.wakeLock.request('screen');
            this._sentinel.addEventListener('release', () => {
                this._sentinel = null;
                this._notify(false, 'Bildschirmsperre wurde vom System zurückgenommen.');
                // Sichtbar geblieben? Dann sofort erneut versuchen.
                if (this._wanted && document.visibilityState === 'visible') {
                    this._scheduleRetry(1000);
                }
            });
            clearTimeout(this._retry);
            this._retry = null;
            this._notify(true, null);
        } catch (err) {
            this._sentinel = null;
            this._notify(false, `Bildschirm bleibt eventuell nicht an (${err.name ?? 'Fehler'}). Energiesparmodus prüfen.`);
            if (this._wanted) this._scheduleRetry(15000);
        }
    }

    _scheduleRetry(delayMs) {
        clearTimeout(this._retry);
        this._retry = setTimeout(() => this._acquire(), delayMs);
    }

    _notify(active, reason) {
        if (this.onChange) this.onChange(active, reason);
    }
}
