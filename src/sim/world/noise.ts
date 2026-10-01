/**
 * Seeded 2D simplex noise + fractal helpers for world generation. OWNER: sim-world agent.
 * Based on Stefan Gustavson's public-domain simplex noise; permutation table shuffled by the seeded Rng.
 */
import type { Rng } from '../../core/rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD_X = new Float64Array([1, -1, 1, -1, 1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071]);
const GRAD_Y = new Float64Array([1, 1, -1, -1, 0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071]);

export class Noise2D {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);
  /** Random offsets so that different Noise2D instances sample unrelated areas. */
  private readonly ox: number;
  private readonly oy: number;

  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
    this.ox = rng.range(-1000, 1000);
    this.oy = rng.range(-1000, 1000);
  }

  /** Simplex noise in approximately [-1, 1]. */
  noise(xin: number, yin: number): number {
    xin += this.ox;
    yin += this.oy;
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1: number;
    let j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (GRAD_X[g] * x0 + GRAD_Y[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (GRAD_X[g] * x1 + GRAD_Y[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (GRAD_X[g] * x2 + GRAD_Y[g] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion, normalised to approximately [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq + o * 17.31, y * freq - o * 9.73);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** fBm remapped to [0, 1]. */
  fbm01(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    const v = this.fbm(x, y, octaves, lacunarity, gain) * 0.5 + 0.5;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** Ridged multifractal in [0, 1] (sharp crests — good for mountain ridges). */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * freq + o * 31.7, y * freq + o * 11.1));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Derive a well-mixed 32-bit seed from a base seed and a salt (splitmix-style). */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
