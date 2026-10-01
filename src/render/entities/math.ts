/**
 * Small allocation-free math helpers shared by the entity renderers (render-entities).
 * Pure functions only — no three.js imports so they can be unit-tested headlessly.
 */
import { hash2 } from '../../core/rng';

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Ease-in quad. */
export function easeIn(t: number): number {
  return t * t;
}

/** Ease-out quad. */
export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Smooth ease in/out (cubic). */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Fractional part (always positive). */
export function fract(v: number): number {
  return v - Math.floor(v);
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Exponential smoothing factor for a rate (1/s) over dt seconds. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Deterministic [0,1) hash of an entity id and a salt (render-side variation). */
export function hashId(id: number, salt: number): number {
  return hash2(id, salt, 0x51f3);
}

/** Deterministic [0,1) hash of a tile and a salt. */
export function hashTile(x: number, z: number, salt: number): number {
  return hash2(x, z, salt);
}

/** Cheap smooth 1D value noise in [-1, 1] (sum of sines, deterministic). */
export function wobble(t: number, seed: number): number {
  return (
    Math.sin(t * 1.7 + seed * 12.9898) * 0.5 +
    Math.sin(t * 2.9 + seed * 78.233) * 0.3 +
    Math.sin(t * 5.3 + seed * 37.719) * 0.2
  );
}
