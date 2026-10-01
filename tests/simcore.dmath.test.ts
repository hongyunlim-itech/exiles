/**
 * Deterministic math (lockstep co-op across browsers): the replacements for Math.hypot / sin / cos / atan2 / exp used
 * by the simulation step agree with the engine's functions to ~1e-14 and handle the special values.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import * as dm from '../src/sim/core/dmath';

describe('dmath', () => {
  it('matches Math.* closely over the ranges the sim uses', () => {
    const rng = new Rng(1234);
    let worst = { sin: 0, cos: 0, atan2: 0, exp: 0, hypot: 0 };
    for (let i = 0; i < 20000; i++) {
      const a = (rng.next() - 0.5) * 200; // angles incl. multiple turns
      const y = (rng.next() - 0.5) * 400;
      const x = (rng.next() - 0.5) * 400;
      const e = (rng.next() - 0.8) * 60;
      worst = {
        sin: Math.max(worst.sin, Math.abs(dm.sin(a) - Math.sin(a))),
        cos: Math.max(worst.cos, Math.abs(dm.cos(a) - Math.cos(a))),
        atan2: Math.max(worst.atan2, Math.abs(dm.atan2(y, x) - Math.atan2(y, x))),
        exp: Math.max(worst.exp, Math.abs(dm.exp(e) - Math.exp(e)) / Math.exp(e)),
        hypot: Math.max(worst.hypot, Math.abs(dm.hypot(x, y) - Math.hypot(x, y)) / Math.max(1e-300, Math.hypot(x, y))),
      };
    }
    expect(worst.sin).toBeLessThan(1e-13);
    expect(worst.cos).toBeLessThan(1e-13);
    expect(worst.atan2).toBeLessThan(1e-14);
    expect(worst.exp).toBeLessThan(1e-14);
    expect(worst.hypot).toBeLessThan(1e-15);
  });

  it('handles special values like Math', () => {
    expect(dm.sin(0)).toBe(0);
    expect(dm.cos(0)).toBe(1);
    expect(dm.exp(0)).toBe(1);
    expect(dm.exp(1)).toBeCloseTo(Math.E, 15);
    expect(dm.exp(-800)).toBe(0);
    expect(dm.exp(800)).toBe(Infinity);
    expect(dm.exp(-708)).toBeCloseTo(Math.exp(-708), 320);
    expect(dm.atan2(0, 0)).toBe(0);
    expect(dm.atan2(0, -1)).toBeCloseTo(Math.PI, 15);
    expect(dm.atan2(-0, -1)).toBeCloseTo(-Math.PI, 15);
    expect(dm.atan2(1, 0)).toBeCloseTo(Math.PI / 2, 15);
    expect(dm.atan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 15);
    expect(dm.atan2(Infinity, 1)).toBeCloseTo(Math.PI / 2, 15);
    expect(Number.isNaN(dm.sin(Infinity))).toBe(true);
    expect(dm.hypot(3, 4)).toBe(5);
    expect(dm.sq(-3)).toBe(9);
  });
});
