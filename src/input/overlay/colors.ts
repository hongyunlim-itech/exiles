/**
 * Overlay palette (sRGB hex) and alphas. Converted to linear once at load via THREE.Color.
 */
import * as THREE from 'three';

export const OverlayColor = {
  ok: 0x5fd35a,
  clearing: 0xf0c73c,
  blocked: 0xe8453c,
  door: 0x7cc8f0,
  road: 0xd9b27a,
  stoneRoad: 0xc9c6bf,
  bridge: 0x6cb6e8,
  mark: 0xf09a2e,
  marked: 0xb07a3a,
  unmark: 0x8fd0ff,
  remove: 0xe8453c,
  rectFill: 0xf4ead2,
  demolish: 0xe8453c,
} as const;

export const OverlayAlpha = {
  strong: 0.55,
  normal: 0.42,
  soft: 0.28,
  faint: 0.12,
} as const;

export const RingColor = {
  cursor: 0xf6e7b4,
  selection: 0xffd27a,
  faint: 0xf6e7b4,
} as const;

const cache = new Map<number, [number, number, number]>();
const tmp = new THREE.Color();

/** Linear-space RGB for an sRGB hex colour (cached). */
export function linearRgb(hex: number): [number, number, number] {
  let c = cache.get(hex);
  if (!c) {
    tmp.setHex(hex);
    c = [tmp.r, tmp.g, tmp.b];
    cache.set(hex, c);
  }
  return c;
}
