/**
 * Seasonal foliage curves for trees & orchards (pure — no three.js), evaluated from the year progress (0..1).
 *
 * Every curve has 12 keys sampled at month centres (key m ↔ month m + 0.5) and wraps around the year.
 * Months: 0-2 spring, 3-5 summer, 6-8 autumn, 9-11 winter.
 */

export type FoliageSpecies = 'conifer' | 'deciduous' | 'birch' | 'orchard';

export type RGB = [number, number, number];

export interface FoliageParams {
  /** 0..1 canopy amount (0 = bare branches). */
  leaf: number;
  /** Current base leaf colour (sRGB 0..1). */
  green: RGB;
  /** 0..1 fraction of the autumn colour turn. */
  autumn: number;
  /** 0..1 late-autumn browning of the turned leaves. */
  brown: number;
  /** 0..1 blossom (orchards). */
  blossom: number;
  /** Autumn colours (sRGB 0..1) — each tree picks one. */
  autA: RGB;
  autB: RGB;
  autC: RGB;
  brownCol: RGB;
}

interface SpeciesCurves {
  leaf: number[];
  autumn: number[];
  brown: number[];
  blossom: number[];
  green: number[];
  autA: number;
  autB: number;
  autC: number;
  brownCol: number;
}

const ZERO12 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export const FOLIAGE_CURVES: Record<FoliageSpecies, SpeciesCurves> = {
  conifer: {
    leaf: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    autumn: ZERO12,
    brown: ZERO12,
    blossom: ZERO12,
    green: [
      0x4f7f45, 0x4c7f43, 0x477a40, 0x42743c, 0x3f703a, 0x3e6c3a,
      0x3d6939, 0x3c6639, 0x3a6239, 0x365b3c, 0x34573d, 0x3f6841,
    ],
    autA: 0x3c6639, autB: 0x3c6639, autC: 0x3c6639, brownCol: 0x3c6639,
  },
  deciduous: {
    leaf: [0.42, 0.8, 1, 1, 1, 1, 1, 1, 0.55, 0, 0, 0],
    autumn: [0, 0, 0, 0, 0, 0.05, 0.5, 0.95, 1, 1, 1, 0.5],
    brown: [0, 0, 0, 0, 0, 0, 0, 0.1, 0.5, 0.9, 1, 1],
    blossom: ZERO12,
    green: [
      0xa6c162, 0x8cb452, 0x76a246, 0x68963e, 0x62903a, 0x5f8a38,
      0x648a3a, 0x6a8a3a, 0x6a8a3a, 0x6a8a3a, 0x8aab52, 0xa6c162,
    ],
    autA: 0xa8452c, autB: 0xc8772e, autC: 0xcfa23e, brownCol: 0x8a6038,
  },
  birch: {
    leaf: [0.45, 0.85, 1, 1, 1, 1, 1, 0.95, 0.45, 0, 0, 0],
    autumn: [0, 0, 0, 0, 0, 0.1, 0.6, 1, 1, 1, 1, 0.5],
    brown: [0, 0, 0, 0, 0, 0, 0, 0.05, 0.4, 0.9, 1, 1],
    blossom: ZERO12,
    green: [
      0xb6cd6e, 0x9fc05a, 0x8fb450, 0x86ac4a, 0x82a848, 0x80a246,
      0x86a446, 0x8aa446, 0x8aa446, 0x8aa446, 0xa8c264, 0xb6cd6e,
    ],
    autA: 0xe4c23e, autB: 0xd8a92c, autC: 0xcfb84a, brownCol: 0xa88a4a,
  },
  orchard: {
    leaf: [0.45, 0.85, 1, 1, 1, 1, 1, 0.9, 0.5, 0, 0, 0],
    autumn: [0, 0, 0, 0, 0, 0, 0.1, 0.6, 1, 1, 1, 0.5],
    brown: [0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.9, 1, 1],
    blossom: [0.85, 1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    green: [
      0x9cbc5c, 0x86b04e, 0x74a044, 0x68963e, 0x62903a, 0x5f8a38,
      0x648a3a, 0x6a8a3a, 0x6a8a3a, 0x6a8a3a, 0x8aab52, 0x9cbc5c,
    ],
    autA: 0xd9a13a, autB: 0xc77a2e, autC: 0xd4b448, brownCol: 0x9a7040,
  },
};

// Scratch result of curvePos (avoids allocating tuples every frame).
let _i0 = 0;
let _i1 = 0;
let _t = 0;

/** Index pair + blend factor for a cyclic month-centre curve at year progress p (0..1) → _i0, _i1, _t. */
function curvePos(p: number): void {
  let f = (((p % 1) + 1) % 1) * 12 - 0.5;
  if (f < 0) f += 12;
  _i0 = Math.floor(f) % 12;
  _i1 = (_i0 + 1) % 12;
  _t = f - Math.floor(f);
}

/** Evaluate a 12-key cyclic scalar curve at year progress p. */
export function evalCurve(keys: readonly number[], p: number): number {
  curvePos(p);
  return keys[_i0] + (keys[_i1] - keys[_i0]) * _t;
}

export function hexToRgb(hex: number, out: RGB): RGB {
  out[0] = ((hex >> 16) & 255) / 255;
  out[1] = ((hex >> 8) & 255) / 255;
  out[2] = (hex & 255) / 255;
  return out;
}

const _a: RGB = [0, 0, 0];
const _b: RGB = [0, 0, 0];

/** Evaluate a 12-key cyclic colour curve (hex keys, sRGB interpolation) at year progress p. */
export function evalColorCurve(keys: readonly number[], p: number, out: RGB): RGB {
  curvePos(p);
  const t = _t;
  hexToRgb(keys[_i0], _a);
  hexToRgb(keys[_i1], _b);
  out[0] = _a[0] + (_b[0] - _a[0]) * t;
  out[1] = _a[1] + (_b[1] - _a[1]) * t;
  out[2] = _a[2] + (_b[2] - _a[2]) * t;
  return out;
}

export function createFoliageParams(): FoliageParams {
  return {
    leaf: 1, green: [0, 0, 0], autumn: 0, brown: 0, blossom: 0,
    autA: [0, 0, 0], autB: [0, 0, 0], autC: [0, 0, 0], brownCol: [0, 0, 0],
  };
}

/** Fill `out` with the foliage state of a species at year progress p (0..1). Allocation-free. */
export function foliageAt(species: FoliageSpecies, p: number, out: FoliageParams): FoliageParams {
  const c = FOLIAGE_CURVES[species];
  out.leaf = evalCurve(c.leaf, p);
  out.autumn = evalCurve(c.autumn, p);
  out.brown = evalCurve(c.brown, p);
  out.blossom = evalCurve(c.blossom, p);
  evalColorCurve(c.green, p, out.green);
  hexToRgb(c.autA, out.autA);
  hexToRgb(c.autB, out.autB);
  hexToRgb(c.autC, out.autC);
  hexToRgb(c.brownCol, out.brownCol);
  return out;
}
