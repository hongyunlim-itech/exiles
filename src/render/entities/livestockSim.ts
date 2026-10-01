/**
 * Render-side wandering of pasture livestock (pure logic, deterministic per pasture). The simulation only tracks
 * how many animals a pasture holds; positions/heading/grazing are purely visual and live here.
 */
import { Rng } from '../../core/rng';
import type { LivestockType } from '../../core/types';
import { clamp, lerpAngle, damp } from './math';

export interface Grazer {
  x: number;
  z: number;
  heading: number;
  tx: number;
  tz: number;
  /** Seconds left standing still (grazing). */
  wait: number;
  moving: boolean;
  /** Walk cycle phase (radians). */
  phase: number;
  /** 0..1 how far the head is lowered (smoothed). */
  headDown: number;
  seed: number;
  /** Per-animal coat variant 0..1. */
  variant: number;
}

export interface PastureBounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface HerdParams {
  speed: number;
  /** Max wander distance per leg of travel. */
  range: number;
  waitMin: number;
  waitMax: number;
  stride: number;
}

export const HERD_PARAMS: Record<LivestockType, HerdParams> = {
  sheep: { speed: 0.32, range: 2.6, waitMin: 2.5, waitMax: 9, stride: 0.36 },
  cattle: { speed: 0.28, range: 3.2, waitMin: 4, waitMax: 12, stride: 0.65 },
  chicken: { speed: 0.55, range: 1.6, waitMin: 0.6, waitMax: 3.5, stride: 0.1 },
};

export class Herd {
  readonly grazers: Grazer[] = [];
  readonly rng: Rng;

  constructor(readonly type: LivestockType, seed: number) {
    this.rng = new Rng(seed >>> 0);
  }

  /** Add/remove animals so the herd has exactly `count` members. */
  sync(count: number, b: PastureBounds): void {
    const n = Math.max(0, Math.floor(count));
    while (this.grazers.length > n) this.grazers.pop();
    while (this.grazers.length < n) {
      const r = this.rng;
      const x = r.range(b.x0, b.x1);
      const z = r.range(b.z0, b.z1);
      this.grazers.push({
        x, z, heading: r.range(0, Math.PI * 2), tx: x, tz: z, wait: r.range(0, 4), moving: false, phase: r.range(0, 6.28),
        headDown: 1, seed: r.next(), variant: r.next(),
      });
    }
  }

  /** Advance the wander simulation by dt game seconds. */
  step(dt: number, b: PastureBounds): void {
    if (dt <= 0) return;
    const p = HERD_PARAMS[this.type];
    const r = this.rng;
    for (let i = 0; i < this.grazers.length; i++) {
      const g = this.grazers[i];
      // Keep inside the (possibly resized) pasture.
      g.x = clamp(g.x, b.x0, b.x1);
      g.z = clamp(g.z, b.z0, b.z1);
      if (g.wait > 0) {
        g.wait -= dt;
        g.moving = false;
        if (g.wait <= 0) {
          const a = r.range(0, Math.PI * 2);
          const d = r.range(0.4, p.range);
          g.tx = clamp(g.x + Math.cos(a) * d, b.x0, b.x1);
          g.tz = clamp(g.z + Math.sin(a) * d, b.z0, b.z1);
        }
      } else {
        const dx = g.tx - g.x;
        const dz = g.tz - g.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const stepLen = p.speed * dt;
        if (dist <= stepLen || dist < 0.02) {
          g.x = g.tx;
          g.z = g.tz;
          g.wait = r.range(p.waitMin, p.waitMax);
          g.moving = false;
        } else {
          const want = Math.atan2(dz, dx);
          g.heading = lerpAngle(g.heading, want, damp(5, dt));
          // Walk mostly along the facing direction so turns look natural.
          const fx = Math.cos(g.heading);
          const fz = Math.sin(g.heading);
          const along = Math.max(0.2, (fx * dx + fz * dz) / dist);
          g.x = clamp(g.x + fx * stepLen * along, b.x0, b.x1);
          g.z = clamp(g.z + fz * stepLen * along, b.z0, b.z1);
          g.phase += (stepLen * along * Math.PI * 2) / p.stride;
          g.moving = true;
        }
      }
      const targetDown = g.moving ? 0 : grazeCycle(g, this.type);
      g.headDown += (targetDown - g.headDown) * damp(this.type === 'chicken' ? 14 : 4, dt);
    }
  }
}

/** While standing: mostly grazing with the head down, occasionally looking up. */
function grazeCycle(g: Grazer, type: LivestockType): number {
  // Chickens peck in quick bursts; others graze with occasional look-ups.
  if (type === 'chicken') return Math.sin(g.wait * 9 + g.seed * 20) > 0.2 ? 1 : 0.1;
  return Math.sin(g.wait * 0.9 + g.seed * 10) > -0.55 ? 1 : 0;
}
