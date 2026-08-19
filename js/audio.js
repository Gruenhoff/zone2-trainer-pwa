/**
 * Akustische Rückmeldung: Töne und deutsche Sprachansagen
 *
 * Wichtig für Android: ein AudioContext startet im Zustand "suspended" und wird
 * nur durch eine echte Nutzergeste freigegeben. Vorher erzeugte Töne sind
 * lautlos. unlock() muss deshalb aus einem Klick-Handler heraus laufen –
 * passiert beim ersten Tippen irgendwo in der App.
 *
 * Sprachansagen laufen über die eingebaute Sprachausgabe des Geräts: kein
 * Download, keine Audiodateien, funktioniert offline.
 */

export class AudioCoach {
    constructor() {
        this._ctx        = null;
        this._unlocked   = false;
        this._voice      = null;
        this._voiceReady = false;
        this._lastSpoken = { text: '', time: 0 };

        this.soundEnabled  = true;
        this.speechEnabled = true;

        this._loadVoices();
    }

    // ── Freigabe ──────────────────────────────────────────────────────────────

    /** Aus einem Klick-Handler aufrufen. Mehrfachaufruf ist unschädlich. */
    unlock() {
        try {
            if (!this._ctx) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                this._ctx = new Ctx();
            }
            if (this._ctx.state === 'suspended') this._ctx.resume();

            // Ein unhörbarer Ton hängt die Audio-Pipeline auf manchen Android-
            // Geräten überhaupt erst ein.
            if (!this._unlocked) {
                const osc  = this._ctx.createOscillator();
                const gain = this._ctx.createGain();
                gain.gain.value = 0.0001;
                osc.connect(gain);
                gain.connect(this._ctx.destination);
                osc.start();
                osc.stop(this._ctx.currentTime + 0.02);
                this._unlocked = true;
            }

            // Sprachausgabe ebenfalls anstoßen, damit sie später ohne Geste darf
            if (typeof speechSynthesis !== 'undefined' && this.speechEnabled) {
                const u = new SpeechSynthesisUtterance('');
                u.volume = 0;
                try { speechSynthesis.speak(u); } catch { /* egal */ }
            }
        } catch { /* Audio ist nie kritisch */ }
    }

    get isUnlocked() { return this._unlocked; }

    // ── Töne ──────────────────────────────────────────────────────────────────

    _tone(freq, duration, volume = 0.3, delay = 0) {
        if (!this.soundEnabled) return;
        try {
            if (!this._ctx) return;
            if (this._ctx.state === 'suspended') this._ctx.resume();
            const t0   = this._ctx.currentTime + delay;
            const osc  = this._ctx.createOscillator();
            const gain = this._ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t0);
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
            osc.connect(gain);
            gain.connect(this._ctx.destination);
            osc.start(t0);
            osc.stop(t0 + duration + 0.02);
        } catch { /* egal */ }
    }

    /** Warmup-Stufe: kurz und hell */
    beepStep()      { this._tone(880, 0.12, 0.25); }
    /** Blockwechsel: aufsteigender Dreiklang */
    beepPhase()     { this._tone(660, 0.16, 0.3); this._tone(880, 0.16, 0.3, 0.18); this._tone(1100, 0.28, 0.3, 0.36); }
    /** Watt runter: absteigend */
    beepDown()      { this._tone(700, 0.13, 0.28); this._tone(520, 0.2, 0.28, 0.14); }
    /** Watt hoch: aufsteigend */
    beepUp()        { this._tone(560, 0.13, 0.26); this._tone(780, 0.18, 0.26, 0.14); }
    /** Warnung: tief und doppelt */
    beepWarn()      { this._tone(392, 0.22, 0.42); this._tone(392, 0.22, 0.42, 0.3); }
    /** Alarm: dringlicher, dreifach */
    beepAlarm()     { for (let i = 0; i < 3; i++) this._tone(330, 0.24, 0.5, i * 0.32); }
    /** Session fertig */
    beepFinish()    { this._tone(523, 0.2, 0.32); this._tone(659, 0.2, 0.32, 0.2); this._tone(784, 0.45, 0.34, 0.4); }

    // ── Sprache ───────────────────────────────────────────────────────────────

    _loadVoices() {
        if (typeof speechSynthesis === 'undefined') return;
        const pick = () => {
            const voices = speechSynthesis.getVoices();
            if (!voices.length) return;
            this._voice = voices.find((v) => v.lang === 'de-DE')
                       ?? voices.find((v) => v.lang?.startsWith('de'))
                       ?? null;
            this._voiceReady = true;
        };
        pick();
        speechSynthesis.addEventListener?.('voiceschanged', pick);
    }

    /**
     * Ansage. Kurze Sätze, keine Satzzeichen-Akrobatik.
     * @param {string} text
     * @param {boolean} urgent – bricht eine laufende Ansage ab
     */
    say(text, urgent = false) {
        if (!this.speechEnabled || !text) return;
        if (typeof speechSynthesis === 'undefined') return;

        // Dieselbe Ansage nicht innerhalb von 5 s wiederholen
        const now = Date.now();
        if (text === this._lastSpoken.text && now - this._lastSpoken.time < 5000) return;
        this._lastSpoken = { text, time: now };

        try {
            // Läuft schon eine Warteschlange, nicht endlos auflaufen lassen –
            // während der Fahrt sind alte Ansagen wertlos.
            if (urgent || speechSynthesis.pending) speechSynthesis.cancel();

            const u = new SpeechSynthesisUtterance(text);
            u.lang   = 'de-DE';
            u.rate   = 1.05;
            u.pitch  = 1.0;
            u.volume = 1.0;
            if (this._voice) u.voice = this._voice;
            speechSynthesis.speak(u);
        } catch { /* egal */ }
    }

    /** Ton und Ansage in einem Aufruf */
    announce(kind, text) {
        switch (kind) {
            case 'step':   this.beepStep();   break;
            case 'phase':  this.beepPhase();  break;
            case 'down':   this.beepDown();   break;
            case 'up':     this.beepUp();     break;
            case 'warn':   this.beepWarn();   break;
            case 'alarm':  this.beepAlarm();  break;
            case 'finish': this.beepFinish(); break;
            default: break;
        }
        if (text) {
            // Der Ton soll zuerst durchkommen, dann die Stimme
            setTimeout(() => this.say(text, kind === 'alarm'), 420);
        }
    }

    stopSpeech() {
        try { speechSynthesis?.cancel(); } catch { /* egal */ }
    }
}
