/**
 * Minimal canvas line chart (HiDPI aware) with year gridlines, nice y ticks, series toggles and a hover readout.
 * Redraws only when data, size or hover change.
 */
import { h } from '../dom';
import { fmtCompact, monthName } from '../format';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  visible: boolean;
}

export interface ChartPoint {
  year: number;
  month: number;
}

const FONT = '500 12px "Alegreya Sans", "Segoe UI", system-ui, sans-serif';

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export class LineChart {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private points: ChartPoint[] = [];
  private series: ChartSeries[] = [];
  private hover = -1;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private yFormat: (v: number) => string = fmtCompact;
  private emptyText = 'No data yet — statistics are recorded every month.';
  private ro: ResizeObserver | null = null;

  constructor() {
    this.canvas = h('canvas', { class: 'chart-canvas', role: 'img', 'aria-label': 'Chart' });
    this.ctx = this.canvas.getContext('2d');
    this.el = h('div', { class: 'chart' }, this.canvas);
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const idx = this.indexAt(e.clientX - r.left);
      if (idx !== this.hover) {
        this.hover = idx;
        this.draw();
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (this.hover !== -1) {
        this.hover = -1;
        this.draw();
      }
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        this.draw();
      });
      this.ro.observe(this.el);
    }
  }

  setData(points: ChartPoint[], series: ChartSeries[], opts: { yFormat?: (v: number) => string; empty?: string } = {}): void {
    this.points = points;
    this.series = series;
    if (opts.yFormat) this.yFormat = opts.yFormat;
    if (opts.empty) this.emptyText = opts.empty;
    if (this.hover >= points.length) this.hover = -1;
    this.draw();
  }

  private plotRect(): { l: number; t: number; r: number; b: number } {
    return { l: 46, t: 12, r: this.cssW - 12, b: this.cssH - 24 };
  }

  private indexAt(x: number): number {
    const n = this.points.length;
    if (n === 0) return -1;
    const p = this.plotRect();
    if (x < p.l - 6 || x > p.r + 6) return -1;
    if (n === 1) return 0;
    const f = (x - p.l) / Math.max(1, p.r - p.l);
    return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  }

  draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    if (w <= 0 || hgt <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w !== this.cssW || hgt !== this.cssH || dpr !== this.dpr) {
      this.cssW = w;
      this.cssH = hgt;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hgt * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${hgt}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.font = FONT;
    const p = this.plotRect();
    const n = this.points.length;
    const vis = this.series.filter((s) => s.visible);

    if (n === 0 || vis.length === 0) {
      ctx.fillStyle = 'rgba(232,220,192,0.55)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n === 0 ? this.emptyText : 'Select a series below.', w / 2, hgt / 2);
      return;
    }

    let max = 0;
    let min = 0;
    for (const s of vis) {
      for (const v of s.values) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    if (max - min < 1e-9) max = min + 1;
    const step = niceStep(max - min, 4);
    const yMax = Math.ceil(max / step) * step;
    const yMin = Math.floor(min / step) * step;
    const X = (i: number) => (n === 1 ? (p.l + p.r) / 2 : p.l + (i / (n - 1)) * (p.r - p.l));
    const Y = (v: number) => p.b - ((v - yMin) / (yMax - yMin)) * (p.b - p.t);

    // grid + y labels
    ctx.strokeStyle = 'rgba(201,164,92,0.12)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(232,220,192,0.6)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = yMin; v <= yMax + step * 0.01; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p.l, y);
      ctx.lineTo(p.r, y);
      ctx.stroke();
      ctx.fillText(this.yFormat(v), p.l - 6, y);
    }

    // year markers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const years = new Set<number>();
    for (let i = 0; i < n; i++) if (this.points[i].month === 0) years.add(i);
    const labelEvery = Math.max(1, Math.ceil(years.size / Math.max(1, Math.floor((p.r - p.l) / 44))));
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!years.has(i)) continue;
      const x = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = 'rgba(201,164,92,0.08)';
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b);
      ctx.stroke();
      if (k++ % labelEvery === 0) ctx.fillText(`Y${this.points[i].year}`, x, p.b + 6);
    }
    if (years.size === 0) {
      ctx.fillText(`Y${this.points[0].year}`, X(0), p.b + 6);
      if (n > 1) ctx.fillText(`Y${this.points[n - 1].year}`, X(n - 1), p.b + 6);
    }
    // axis
    ctx.strokeStyle = 'rgba(201,164,92,0.35)';
    ctx.beginPath();
    ctx.moveTo(p.l, Math.round(p.b) + 0.5);
    ctx.lineTo(p.r, Math.round(p.b) + 0.5);
    ctx.stroke();

    // series lines (with soft area under the first visible series)
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    vis.forEach((s, si) => {
      if (si === 0 && n > 1) {
        const grad = ctx.createLinearGradient(0, p.t, 0, p.b);
        grad.addColorStop(0, hexA(s.color, 0.22));
        grad.addColorStop(1, hexA(s.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(Math.max(yMin, 0)));
        for (let i = 0; i < n; i++) ctx.lineTo(X(i), Y(s.values[i] ?? 0));
        ctx.lineTo(X(n - 1), Y(Math.max(yMin, 0)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = X(i);
        const y = Y(s.values[i] ?? 0);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (n === 1) {
        ctx.arc(X(0), Y(s.values[0] ?? 0), 2.5, 0, Math.PI * 2);
      }
      ctx.stroke();
    });

    // hover readout
    if (this.hover >= 0 && this.hover < n) {
      const i = this.hover;
      const x = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = 'rgba(232,220,192,0.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const s of vis) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(X(i), Y(s.values[i] ?? 0), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      const pt = this.points[i];
      const lines = [`Year ${pt.year}, ${monthName(pt.month)}`, ...vis.map((s) => `${s.label}: ${this.yFormat(s.values[i] ?? 0)}`)];
      ctx.font = FONT;
      const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 22;
      const bh = lines.length * 15 + 10;
      let bx = x + 10;
      if (bx + bw > p.r) bx = x - 10 - bw;
      const by = p.t + 4;
      ctx.fillStyle = 'rgba(20,15,10,0.92)';
      ctx.strokeStyle = 'rgba(201,164,92,0.5)';
      roundRect(ctx, bx, by, bw, bh, 5);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, li) => {
        if (li === 0) ctx.fillStyle = '#e0c078';
        else {
          ctx.fillStyle = vis[li - 1].color;
          ctx.fillRect(bx + 8, by + 6 + li * 15 + 4, 6, 6);
          ctx.fillStyle = '#eadfc8';
        }
        ctx.fillText(l, bx + (li === 0 ? 8 : 18), by + 6 + li * 15);
      });
    }
  }

  dispose(): void {
    this.ro?.disconnect();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
