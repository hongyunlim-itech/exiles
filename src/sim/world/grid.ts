/**
 * Grid helpers for world generation: distance transforms, connected components, integral images.
 * OWNER: sim-world agent. Pure, allocation-light, no DOM.
 */

const SQ2 = Math.SQRT2;

/**
 * Two-pass 8-neighbour chamfer distance transform (weights 1 / √2, max error ~8%).
 * `isSource(i)` cells get distance 0. Returns distances in cell units (Infinity-like 1e9 when no source).
 */
export function distanceTransform(w: number, h: number, isSource: (i: number) => boolean, out?: Float32Array): Float32Array {
  const n = w * h;
  const d = out && out.length >= n ? out : new Float32Array(n);
  const INF = 1e9;
  for (let i = 0; i < n; i++) d[i] = isSource(i) ? 0 : INF;
  // forward pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        const up = i - w;
        if (d[up] + 1 < v) v = d[up] + 1;
        if (x > 0 && d[up - 1] + SQ2 < v) v = d[up - 1] + SQ2;
        if (x < w - 1 && d[up + 1] + SQ2 < v) v = d[up + 1] + SQ2;
      }
      d[i] = v;
    }
  }
  // backward pass
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < h - 1) {
        const dn = i + w;
        if (d[dn] + 1 < v) v = d[dn] + 1;
        if (x < w - 1 && d[dn + 1] + SQ2 < v) v = d[dn + 1] + SQ2;
        if (x > 0 && d[dn - 1] + SQ2 < v) v = d[dn - 1] + SQ2;
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * 4-connected component labelling of cells where `pass(i)` is true.
 * Returns labels (0 = not passable, 1..count) and the size of each component (index = label).
 */
export function labelComponents(w: number, h: number, pass: (i: number) => boolean): { labels: Int32Array; sizes: number[] } {
  const n = w * h;
  const labels = new Int32Array(n);
  const sizes: number[] = [0];
  const q = new Int32Array(n);
  let label = 0;
  for (let s = 0; s < n; s++) {
    if (labels[s] !== 0 || !pass(s)) continue;
    label++;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    labels[s] = label;
    while (head < tail) {
      const i = q[head++];
      const x = i % w;
      if (x > 0 && labels[i - 1] === 0 && pass(i - 1)) {
        labels[i - 1] = label;
        q[tail++] = i - 1;
      }
      if (x < w - 1 && labels[i + 1] === 0 && pass(i + 1)) {
        labels[i + 1] = label;
        q[tail++] = i + 1;
      }
      if (i >= w && labels[i - w] === 0 && pass(i - w)) {
        labels[i - w] = label;
        q[tail++] = i - w;
      }
      if (i < n - w && labels[i + w] === 0 && pass(i + w)) {
        labels[i + w] = label;
        q[tail++] = i + w;
      }
    }
    sizes.push(tail);
  }
  return { labels, sizes };
}

/** Summed-area table over a w×h grid; query any axis-aligned rectangle sum in O(1). */
export class IntegralImage {
  readonly w: number;
  readonly h: number;
  private readonly s: Float64Array;

  constructor(w: number, h: number, value: (i: number) => number) {
    this.w = w;
    this.h = h;
    const s = new Float64Array((w + 1) * (h + 1));
    const W1 = w + 1;
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += value(y * w + x);
        s[(y + 1) * W1 + (x + 1)] = s[y * W1 + (x + 1)] + rowSum;
      }
    }
    this.s = s;
  }

  /** Sum over cells [x0, x1) × [y0, y1), clamped to the grid. */
  sum(x0: number, y0: number, x1: number, y1: number): number {
    x0 = Math.max(0, Math.min(this.w, x0 | 0));
    x1 = Math.max(0, Math.min(this.w, x1 | 0));
    y0 = Math.max(0, Math.min(this.h, y0 | 0));
    y1 = Math.max(0, Math.min(this.h, y1 | 0));
    if (x1 <= x0 || y1 <= y0) return 0;
    const W1 = this.w + 1;
    const s = this.s;
    return s[y1 * W1 + x1] - s[y0 * W1 + x1] - s[y1 * W1 + x0] + s[y0 * W1 + x0];
  }
}
