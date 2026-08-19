/**
 * Diagramme auf reinem Canvas – ohne externe Bibliothek
 *
 * Der Grund für den Eigenbau ist nicht Sparsamkeit: eine Diagrammbibliothek aus
 * einem fremden Netz ist ein Einzelfehlerpunkt, der im ungünstigen Fall den
 * Start der ganzen App verhindert. Dazu kommt, dass hier über eine Stunde im
 * Sekundentakt neu gezeichnet wird – da lohnt sich das Verdichten der Punkte
 * auf die tatsächliche Pixelbreite.
 *
 * TrendChart  – Verlauf einer Session (HR, Watt, Phasen)
 * HistoryChart – Entwicklung über Sessions hinweg (aerobe Effizienz, Drift)
 */

const COLORS = {
    hr:        '#10b981',
    hrFill:    'rgba(16, 185, 129, 0.10)',
    watt:      '#f97316',
    reduction: 'rgba(239, 68, 68, 0.75)',
    reset:     'rgba(245, 158, 11, 0.45)',
    grid:      'rgba(255, 255, 255, 0.06)',
    axis:      '#6b7e9f',
    text:      '#6b7e9f',
    warmup:    'rgba(59, 130, 246, 0.07)',
    work:      'rgba(16, 185, 129, 0.05)',
    cooldown:  'rgba(148, 163, 184, 0.07)',
};

/** Basis: kümmert sich um Auflösung, Größenänderung und Zeichentakt */
class CanvasBase {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.w = 0;
        this.h = 0;
        this._dirty = true;
        this._frame = null;

        this._observer = null;
        if (typeof ResizeObserver !== 'undefined') {
            this._observer = new ResizeObserver(() => { this._resize(); this.invalidate(); });
            this._observer.observe(canvas.parentElement ?? canvas);
        }
        this._resize();
    }

    resize() { this._resize(); }

    _resize() {
        const host = this.canvas.parentElement ?? this.canvas;
        const rect = host.getBoundingClientRect();
        // Auf Handys bringt mehr als 2 nichts Sichtbares, kostet aber Füllrate
        const dpr  = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        if (w === this.w && h === this.h && this.canvas.width) return;
        this.w = w;
        this.h = h;
        this.canvas.width  = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
        this.canvas.style.width  = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Neuzeichnen anfordern – gebündelt auf das nächste Einzelbild.
     *
     * Die Größe wird hier selbst nachgeführt und nicht dem ResizeObserver
     * überlassen. Dessen Rückrufe hängen wie requestAnimationFrame am
     * Rendertakt: läuft die Seite gerade nicht sichtbar (Tab im Hintergrund,
     * Ansicht eben erst eingeblendet), kommen sie nicht – und das Diagramm
     * bliebe dauerhaft auf seiner Anfangsgröße von einem Pixel stehen.
     */
    invalidate() {
        this._resize();
        this._dirty = true;
        if (this._frame !== null) return;
        this._frame = requestAnimationFrame(() => {
            this._frame = null;
            if (!this._dirty) return;
            this._dirty = false;
            try {
                this.draw();
            } catch { /* ein Zeichenfehler darf nie die Session stören */ }
        });
    }

    destroy() {
        if (this._frame !== null) cancelAnimationFrame(this._frame);
        this._observer?.disconnect();
    }

    draw() { /* von Unterklassen */ }
}

// ══════════════════════════════════════════════════════════════════════════════

export class TrendChart extends CanvasBase {
    constructor(canvas) {
        super(canvas);
        this.points      = [];      // { t, hr, w, ph }
        this.reductionHR = null;
        this.resetHR     = null;
        this.showWatts   = true;
    }

    setData(points) {
        this.points = points ?? [];
        this.invalidate();
    }

    setThresholds(reductionHR, resetHR) {
        this.reductionHR = reductionHR;
        this.resetHR     = resetHR;
        this.invalidate();
    }

    draw() {
        const { ctx, w, h } = this;
        ctx.clearRect(0, 0, w, h);
        if (w < 40 || h < 40) return;

        const pad = { l: 34, r: this.showWatts ? 34 : 10, t: 10, b: 18 };
        const pw = w - pad.l - pad.r;
        const ph = h - pad.t - pad.b;
        if (pw <= 0 || ph <= 0) return;

        const usable = this.points.filter((p) => p.hr > 0 || p.w > 0);
        if (usable.length < 2) {
            ctx.fillStyle = COLORS.text;
            ctx.font = '12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Warte auf Messwerte...', w / 2, h / 2);
            return;
        }

        const t0 = usable[0].t;
        const t1 = usable[usable.length - 1].t;
        const span = Math.max(1000, t1 - t0);

        // Punkte auf die Pixelbreite verdichten
        const buckets = this._bucketize(usable, t0, span, Math.max(2, Math.floor(pw)));

        // Wertebereiche
        const hrValues = buckets.filter((b) => b.hr != null).map((b) => b.hr);
        const wValues  = buckets.filter((b) => b.w  != null).map((b) => b.w);
        const refs = [this.reductionHR, this.resetHR].filter((v) => v != null);
        const hrMin = Math.min(...hrValues, ...refs) - 6;
        const hrMax = Math.max(...hrValues, ...refs) + 6;
        const hrLo  = Math.floor(hrMin / 5) * 5;
        const hrHi  = Math.ceil(hrMax / 5) * 5;
        const hrRange = Math.max(10, hrHi - hrLo);

        const wHi = Math.max(50, Math.ceil((Math.max(...wValues, 0) * 1.25) / 10) * 10);

        const xOf  = (t)  => pad.l + ((t - t0) / span) * pw;
        const yHR  = (hr) => pad.t + ph - ((hr - hrLo) / hrRange) * ph;
        const yW   = (wt) => pad.t + ph - (wt / wHi) * ph;

        // ── Phasenbänder ─────────────────────────────────────────────────────
        this._drawPhaseBands(buckets, xOf, pad, ph, pw);

        // ── Gitter und HR-Beschriftung ───────────────────────────────────────
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const stepHR = hrRange > 60 ? 20 : hrRange > 30 ? 10 : 5;
        ctx.lineWidth = 1;
        for (let v = Math.ceil(hrLo / stepHR) * stepHR; v <= hrHi; v += stepHR) {
            const y = yHR(v);
            ctx.strokeStyle = COLORS.grid;
            ctx.beginPath();
            ctx.moveTo(pad.l, Math.round(y) + 0.5);
            ctx.lineTo(pad.l + pw, Math.round(y) + 0.5);
            ctx.stroke();
            ctx.fillStyle = COLORS.text;
            ctx.textAlign = 'right';
            ctx.fillText(String(v), pad.l - 5, y);
        }

        // ── Schwellenlinien ──────────────────────────────────────────────────
        if (this.resetHR != null)     this._dashedLine(pad.l, pad.l + pw, yHR(this.resetHR), COLORS.reset);
        if (this.reductionHR != null) this._dashedLine(pad.l, pad.l + pw, yHR(this.reductionHR), COLORS.reduction);

        // ── Watt-Kurve (hinter der HR) ───────────────────────────────────────
        if (this.showWatts && wValues.length > 1) {
            ctx.strokeStyle = COLORS.watt;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = 1.4;
            this._path(buckets, (b) => b.w, xOf, yW, t0, span);
            ctx.stroke();
            ctx.globalAlpha = 1;

            ctx.fillStyle = COLORS.watt;
            ctx.textAlign = 'left';
            ctx.font = '10px system-ui, sans-serif';
            ctx.fillText(`${wHi} W`, pad.l + pw + 5, yW(wHi));
            ctx.fillText('0', pad.l + pw + 5, yW(0));
        }

        // ── HR-Fläche und Kurve ──────────────────────────────────────────────
        if (hrValues.length > 1) {
            // Fläche
            ctx.beginPath();
            let started = false;
            let firstX = 0, lastX = 0;
            for (const b of buckets) {
                if (b.hr == null) continue;
                const x = xOf(b.t);
                const y = yHR(b.hr);
                if (!started) { ctx.moveTo(x, y); firstX = x; started = true; }
                else ctx.lineTo(x, y);
                lastX = x;
            }
            if (started) {
                ctx.lineTo(lastX, pad.t + ph);
                ctx.lineTo(firstX, pad.t + ph);
                ctx.closePath();
                ctx.fillStyle = COLORS.hrFill;
                ctx.fill();
            }

            ctx.strokeStyle = COLORS.hr;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            this._path(buckets, (b) => b.hr, xOf, yHR, t0, span);
            ctx.stroke();

            // Aktueller Punkt
            const last = [...buckets].reverse().find((b) => b.hr != null);
            if (last) {
                ctx.fillStyle = COLORS.hr;
                ctx.beginPath();
                ctx.arc(xOf(last.t), yHR(last.hr), 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // ── Zeitachse ────────────────────────────────────────────────────────
        ctx.fillStyle = COLORS.text;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const ticks = Math.min(5, Math.max(2, Math.floor(pw / 70)));
        for (let i = 0; i <= ticks; i++) {
            const t = t0 + (span * i) / ticks;
            const mins = Math.round((t - t0) / 60000);
            ctx.fillText(`${mins}′`, xOf(t), pad.t + ph + 4);
        }
    }

    _drawPhaseBands(buckets, xOf, pad, ph, pw) {
        const { ctx } = this;
        const colorFor = (p) => p === 'warmup' ? COLORS.warmup
                              : p === 'work'   ? COLORS.work
                              : p === 'cooldown' ? COLORS.cooldown : null;
        let runStart = null;
        let runPhase = null;
        const flush = (endX) => {
            if (runStart === null) return;
            const c = colorFor(runPhase);
            if (c) {
                ctx.fillStyle = c;
                ctx.fillRect(runStart, pad.t, Math.max(1, endX - runStart), ph);
            }
            runStart = null;
        };
        for (const b of buckets) {
            const x = xOf(b.t);
            if (b.ph !== runPhase) {
                flush(x);
                runPhase = b.ph;
                runStart = x;
            }
        }
        flush(pad.l + pw);
    }

    _path(buckets, valueOf, xOf, yOf) {
        const { ctx } = this;
        ctx.beginPath();
        let started = false;
        for (const b of buckets) {
            const v = valueOf(b);
            if (v == null) { started = false; continue; }   // Lücke lassen
            const x = xOf(b.t);
            const y = yOf(v);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
    }

    _dashedLine(x0, x1, y, color) {
        const { ctx } = this;
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(y) + 0.5);
        ctx.lineTo(x1, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.restore();
    }

    /** Mittelt die Messpunkte auf n Zeitfenster – null, wo keine Daten liegen */
    _bucketize(points, t0, span, n) {
        const acc = new Array(n);
        for (const p of points) {
            let i = Math.floor(((p.t - t0) / span) * n);
            if (i < 0) i = 0;
            if (i >= n) i = n - 1;
            let b = acc[i];
            if (!b) { b = acc[i] = { hrSum: 0, hrN: 0, wSum: 0, wN: 0, ph: p.ph, t: p.t }; }
            if (p.hr > 0) { b.hrSum += p.hr; b.hrN++; }
            if (p.w  > 0) { b.wSum  += p.w;  b.wN++;  }
            b.ph = p.ph;
            b.t  = p.t;
        }
        const out = [];
        for (let i = 0; i < n; i++) {
            const b = acc[i];
            if (!b) continue;
            out.push({
                t:  b.t,
                hr: b.hrN ? b.hrSum / b.hrN : null,
                w:  b.wN  ? b.wSum  / b.wN  : null,
                ph: b.ph,
            });
        }
        return out;
    }
}

// ══════════════════════════════════════════════════════════════════════════════

/**
 * Entwicklung über Sessions: aerobe Effizienz als Balken, Drift als Linie.
 * Links steht die älteste Einheit, rechts die neueste.
 */
export class HistoryChart extends CanvasBase {
    constructor(canvas) {
        super(canvas);
        this.sessions = [];
    }

    setData(sessions) {
        // Chronologisch: älteste links
        this.sessions = (sessions ?? []).slice().reverse();
        this.invalidate();
    }

    draw() {
        const { ctx, w, h } = this;
        ctx.clearRect(0, 0, w, h);
        if (w < 40 || h < 40) return;

        const withEf = this.sessions.filter((s) => s.ef != null);
        if (withEf.length < 2) {
            ctx.fillStyle = COLORS.text;
            ctx.font = '12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Ab der zweiten Einheit siehst du hier den Trend.', w / 2, h / 2);
            return;
        }

        const pad = { l: 38, r: 34, t: 12, b: 20 };
        const pw = w - pad.l - pad.r;
        const ph = h - pad.t - pad.b;
        if (pw <= 0 || ph <= 0) return;

        const efs = withEf.map((s) => s.ef);
        const efLo = Math.max(0, Math.min(...efs) * 0.92);
        const efHi = Math.max(...efs) * 1.06;
        const efRange = Math.max(0.01, efHi - efLo);

        const n = withEf.length;
        const slot = pw / n;
        const barW = Math.max(3, Math.min(26, slot * 0.6));

        const xOf  = (i)  => pad.l + slot * (i + 0.5);
        const yEf  = (ef) => pad.t + ph - ((ef - efLo) / efRange) * ph;

        // Gitter
        ctx.lineWidth = 1;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= 3; i++) {
            const v = efLo + (efRange * i) / 3;
            const y = yEf(v);
            ctx.strokeStyle = COLORS.grid;
            ctx.beginPath();
            ctx.moveTo(pad.l, Math.round(y) + 0.5);
            ctx.lineTo(pad.l + pw, Math.round(y) + 0.5);
            ctx.stroke();
            ctx.fillStyle = COLORS.text;
            ctx.textAlign = 'right';
            ctx.fillText(v.toFixed(2), pad.l - 5, y);
        }

        // Balken: aerobe Effizienz
        withEf.forEach((s, i) => {
            const x = xOf(i);
            const y = yEf(s.ef);
            ctx.fillStyle = COLORS.hr;
            ctx.globalAlpha = 0.75;
            ctx.fillRect(x - barW / 2, y, barW, pad.t + ph - y);
            ctx.globalAlpha = 1;
        });

        // Linie: Drift, eigene Skala 0…10 %
        const driftPts = withEf.map((s, i) => ({ i, d: s.driftAtEnd }))
                               .filter((p) => p.d != null);
        if (driftPts.length > 1) {
            const yD = (d) => pad.t + ph - (Math.min(10, Math.max(0, d)) / 10) * ph;
            ctx.strokeStyle = COLORS.reduction;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            driftPts.forEach((p, k) => {
                const x = xOf(p.i);
                const y = yD(p.d);
                if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.stroke();

            ctx.fillStyle = COLORS.reduction;
            for (const p of driftPts) {
                ctx.beginPath();
                ctx.arc(xOf(p.i), yD(p.d), 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.textAlign = 'left';
            ctx.fillText('10 %', pad.l + pw + 5, yD(10));
            ctx.fillText('0 %',  pad.l + pw + 5, yD(0));
        }

        // Datum der ersten und letzten Einheit
        ctx.fillStyle = COLORS.text;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        const fmt = (d) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        ctx.fillText(fmt(withEf[0].date), pad.l, pad.t + ph + 5);
        ctx.textAlign = 'right';
        ctx.fillText(fmt(withEf[n - 1].date), pad.l + pw, pad.t + ph + 5);
    }
}
