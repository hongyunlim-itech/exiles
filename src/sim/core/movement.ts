/**
 * Citizen locomotion: path following along A* tile paths (with a per-step path-search budget), straight-line
 * moves, and nearest-walkable-tile search for unsticking. OWNER: sim-core.
 */
import { ADULT_AGE, ELDERLY_AGE, WALK_SPEED } from '../../core/constants';
import type { Citizen } from '../../core/types';
import { tileCost } from '../../core/world';
import type { Game } from '../game';
import * as dm from './dmath';

export function tileOf(g: Game, c: Citizen): [number, number] {
  const s = g.state;
  const tx = Math.min(s.W - 1, Math.max(0, Math.floor(c.x)));
  const tz = Math.min(s.H - 1, Math.max(0, Math.floor(c.z)));
  return [tx, tz];
}

export function tileIndexOf(g: Game, c: Citizen): number {
  const [tx, tz] = tileOf(g, c);
  return tz * g.state.W + tx;
}

/** Walking speed in tiles/s on cost-1 ground. */
export function walkSpeed(g: Game, c: Citizen): number {
  let v = WALK_SPEED;
  if (c.age < ADULT_AGE) v *= 0.85;
  else if (c.age >= ELDERLY_AGE) v *= 0.8;
  if (c.sick > 0.3) v *= 0.75;
  if (c.carrying) v *= 0.92;
  v *= 1 - 0.2 * g.state.weather.snow;
  return v;
}

export type FollowResult = 'moving' | 'arrived' | 'blocked';

/** Advance along c.path for dt seconds. */
export function followPath(g: Game, c: Citizen, dt: number): FollowResult {
  const path = c.path;
  if (!path || c.pathIndex >= path.length) {
    c.path = null;
    c.pathIndex = 0;
    c.moving = false;
    return 'arrived';
  }
  const s = g.state;
  const W = s.W;
  const base = walkSpeed(g, c);
  let time = dt;
  let guard = 0;
  while (time > 1e-9 && c.pathIndex < path.length && guard++ < 64) {
    const ti = path[c.pathIndex];
    if (!g.isWalkableTile(ti)) {
      c.moving = false;
      return 'blocked';
    }
    const tx = (ti % W) + 0.5;
    const tz = Math.floor(ti / W) + 0.5;
    const dx = tx - c.x;
    const dz = tz - c.z;
    const d = dm.hypot(dx, dz);
    if (d < 1e-6) {
      c.pathIndex++;
      continue;
    }
    const v = base / tileCost(s, ti);
    c.heading = dm.atan2(dz, dx);
    const step = v * time;
    if (step >= d) {
      c.x = tx;
      c.z = tz;
      time -= d / v;
      c.pathIndex++;
    } else {
      c.x += (dx / d) * step;
      c.z += (dz / d) * step;
      time = 0;
    }
  }
  if (c.pathIndex >= path.length) {
    c.path = null;
    c.pathIndex = 0;
    c.moving = false;
    return 'arrived';
  }
  c.moving = true;
  return 'moving';
}

/** Straight-line move toward (x, z). Returns true when arrived. */
export function moveDirect(g: Game, c: Citizen, x: number, z: number, dt: number): boolean {
  const dx = x - c.x;
  const dz = z - c.z;
  const d = dm.hypot(dx, dz);
  if (d < 1e-3) {
    c.moving = false;
    return true;
  }
  const step = walkSpeed(g, c) * dt;
  c.heading = dm.atan2(dz, dx);
  if (step >= d) {
    c.x = x;
    c.z = z;
    c.moving = false;
    return true;
  }
  c.x += (dx / d) * step;
  c.z += (dz / d) * step;
  c.moving = true;
  return false;
}

/** Nearest walkable tile to (tx, tz) within maxR (ring search), or -1. */
export function nearestWalkable(g: Game, tx: number, tz: number, maxR: number, fromX = tx + 0.5, fromZ = tz + 0.5): number {
  const s = g.state;
  const W = s.W;
  if (tx >= 0 && tz >= 0 && tx < W && tz < s.H && g.isWalkableTile(tz * W + tx)) return tz * W + tx;
  for (let r = 1; r <= maxR; r++) {
    let best = -1;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = tx + dx;
        const z = tz + dz;
        if (x < 0 || z < 0 || x >= W || z >= s.H) continue;
        const i = z * W + x;
        if (!g.isWalkableTile(i)) continue;
        const d = dm.sq(x + 0.5 - fromX) + dm.sq(z + 0.5 - fromZ);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

export function faceTowards(c: Citizen, x: number, z: number): void {
  const dx = x - c.x;
  const dz = z - c.z;
  if (dx * dx + dz * dz > 1e-6) c.heading = dm.atan2(dz, dx);
}
