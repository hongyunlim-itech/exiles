/**
 * Colour palette for the world scene (terrain, water, sky). All values are sRGB hex.
 * Pure data + tiny helpers — no three.js import so it can be used from tests.
 * OWNER: render-scene.
 */

export type RGB = [number, number, number];

/** Terrain & ground colours (sRGB). */
export const PAL = {
  // natural ground
  grass: 0x6f8f45,
  grassLush: 0x67834a,
  grassDry: 0x7c8251,
  forestFloor: 0x4d6138,
  stony: 0x8a8272,
  scrub: 0x5d6040,
  sand: 0xc9b98a,
  wetSand: 0xa8996f,
  riverbed: 0x8c7d5c,
  riverbedDeep: 0x4c4a3a,
  mountain: 0x7d766c,
  mountainDark: 0x686158,
  mountainLight: 0x958c7e,
  rock: 0x7f7564,
  snow: 0xe8eef2,
  skirt: 0x4a3b2c,

  // overlays (roads, zones, building pads)
  dirtRoad: 0x8a7050,
  stoneRoad: 0x8e8b84,
  soil: 0x6b5236,
  soilPlowed: 0x5c4530,
  stubble: 0x9c8850,
  packedEarth: 0x8b7658,
  quarry: 0x8a8174,
  pasture: 0x7c8a4a,
  orchard: 0x74884a,
  cemetery: 0x5d8040,
  charred: 0x3a322b,
  trodden: 0x7f8750,

  // water
  waterDeep: 0x2d5566,
  waterShallow: 0x4f7f86,
  waterWinter: 0x5d7c88,
  foam: 0xe6efee,
  ice: 0xd2e0e6,
} as const;

/**
 * Seasonal grass colour keyframes at month centres (index = month 0..11, sampled at (month + 0.5) / 12).
 * Summer months equal the base grass colour so the tint is identity in summer.
 */
export const GRASS_SEASON_KEYS: readonly number[] = [
  0x7c9147, // Early Spring — pale after the thaw
  0x74a049, // Spring — fresh
  0x6d9a45, // Late Spring
  0x6f8f45, // Early Summer — base
  0x718d44, // Summer
  0x7a8b43, // Late Summer — drying
  0x838b42, // Early Autumn
  0x938b46, // Autumn (renders close to the #9a8a45 target once meadow hue variation is applied)
  0x8b814c, // Late Autumn
  0x827b52, // Early Winter — dormant
  0x7c7955, // Winter
  0x7a7f50, // Late Winter
];

export function hexToRgb(hex: number): RGB {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function lerpRgb(a: RGB, b: RGB, t: number, out: RGB = [0, 0, 0]): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Seasonal grass colour (sRGB 0..1) for a year progress 0..1 (smooth, wraps around the year). */
export function grassColorAt(yearProgress: number, out: RGB = [0, 0, 0]): RGB {
  const n = GRASS_SEASON_KEYS.length;
  const m = (((yearProgress * n - 0.5) % n) + n) % n;
  const i0 = Math.floor(m);
  const i1 = (i0 + 1) % n;
  const f = m - i0;
  const t = f * f * (3 - 2 * f);
  return lerpRgb(hexToRgb(GRASS_SEASON_KEYS[i0]), hexToRgb(GRASS_SEASON_KEYS[i1]), t, out);
}

/** Exact sRGB -> linear transfer for one channel. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
