/**
 * Shared helpers for sim-core tests: game creation, stepping, a placement finder and a scripted "bot" player.
 */
import { YEAR_SECONDS } from '../src/core/constants';
import { BUILDINGS, FOOD_TYPES } from '../src/core/defs';
import type { Building, BuildingType, NewGameSettings, Rotation } from '../src/core/types';
import { Game } from '../src/sim/game';

export function settings(over: Partial<NewGameSettings> = {}): NewGameSettings {
  return {
    seed: 12345,
    townName: 'Testvale',
    mapSize: 'small',
    terrain: 'valleys',
    climate: 'fair',
    difficulty: 'medium',
    disasters: false,
    ...over,
  };
}

export function run(g: Game, seconds: number, dt = 0.25, each?: (g: Game) => void): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    g.step(dt);
    each?.(g);
    if (g.state.gameOver) break;
  }
}

/** Spiral search around (cx, cz) for a valid placement; prefers spots that need no clearing. */
export function findPlacement(
  g: Game, type: BuildingType, cx: number, cz: number, opts: { maxR?: number; w?: number; h?: number; allowClearing?: boolean; gap?: number } = {},
): { x: number; z: number; rot: Rotation } | null {
  const maxR = opts.maxR ?? 40;
  const def = BUILDINGS[type];
  const w = opts.w ?? def.size[0];
  const h = opts.h ?? def.size[1];
  const gap = opts.gap ?? 1;
  const offsets: [number, number][] = [];
  for (let dz = -maxR; dz <= maxR; dz++) for (let dx = -maxR; dx <= maxR; dx++) offsets.push([dx, dz]);
  offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
  const s = g.state;
  for (const pass of opts.allowClearing ? [false, true] : [false]) {
    for (const [dx, dz] of offsets) {
      for (const rot of [0, 1, 2, 3] as Rotation[]) {
        if (def.resizable && rot !== 0) continue;
        const x = Math.round(cx + dx - w / 2);
        const z = Math.round(cz + dz - h / 2);
        const chk = g.checkPlacement(type, x, z, rot, def.resizable ? w : undefined, def.resizable ? h : undefined);
        if (!chk.ok) continue;
        if (!pass && chk.clearing.length > 0) continue;
        const [fw, fh] = def.resizable ? [w, h] : rot % 2 === 1 ? [h, w] : [w, h];
        let clear = true;
        for (let zz = z - gap; zz < z + fh + gap && clear; zz++) {
          for (let xx = x - gap; xx < x + fw + gap; xx++) {
            if (xx < 0 || zz < 0 || xx >= s.W || zz >= s.H) { clear = false; break; }
            const i = zz * s.W + xx;
            if (s.tiles.building[i] >= 0 || g.rt.doorTiles.has(i)) { clear = false; break; }
          }
        }
        if (!clear) continue;
        if (!g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
        if (!g.sameRegionSafe(chk.doorX, chk.doorZ, Math.floor(cx), Math.floor(cz))) continue;
        return { x, z, rot };
      }
    }
  }
  return null;
}

export function place(g: Game, type: BuildingType, cx: number, cz: number, opts: Parameters<typeof findPlacement>[4] = {}): Building | null {
  const p = findPlacement(g, type, cx, cz, { allowClearing: true, ...opts });
  if (!p) return null;
  const def = BUILDINGS[type];
  return g.placeBuilding(type, p.x, p.z, p.rot, def.resizable ? opts.w ?? def.size[0] : undefined, def.resizable ? opts.h ?? def.size[1] : undefined);
}

export function foodTotal(g: Game): number {
  return g.foodTotal() + houseFood(g);
}

export function houseFood(g: Game): number {
  let n = 0;
  for (const b of g.state.buildings) {
    if (!BUILDINGS[b.type].housing) continue;
    for (const r of FOOD_TYPES) n += b.inventory[r] ?? 0;
  }
  return n;
}

export function yearOf(g: Game): number {
  return g.state.time.elapsed / YEAR_SECONDS;
}

export function stuckReport(g: Game): string[] {
  const out: string[] = [];
  for (const c of g.state.citizens) {
    const t = (c.task as { cur?: { kind: string; age: number; label: string } | null })?.cur;
    if (t && t.age > 120) out.push(`${c.name} stuck in ${t.kind} (${t.label}) for ${t.age.toFixed(0)}s`);
  }
  return out;
}

/** Test diagnostics: vitest swallows console output of passing tests, so write straight to stderr. */
export function log(...args: unknown[]): void {
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}

/** Best valid placement on a coarse grid around (cx, cz) maximising `score(centerX, centerZ) - dist * distWeight`. */
export function bestPlacement(
  g: Game, type: BuildingType, cx: number, cz: number, score: (x: number, z: number) => number,
  opts: { maxR?: number; w?: number; h?: number; distWeight?: number; step?: number } = {},
): { x: number; z: number; rot: Rotation } | null {
  const def = BUILDINGS[type];
  const maxR = opts.maxR ?? 32;
  const step = opts.step ?? 2;
  const w = opts.w ?? def.size[0];
  const h = opts.h ?? def.size[1];
  const s = g.state;
  let best: { x: number; z: number; rot: Rotation } | null = null;
  let bestScore = -Infinity;
  for (let dz = -maxR; dz <= maxR; dz += step) {
    for (let dx = -maxR; dx <= maxR; dx += step) {
      const d = Math.hypot(dx, dz);
      if (d > maxR) continue;
      for (const rot of (def.resizable ? [0] : [0, 1, 2, 3]) as Rotation[]) {
        const [fw, fh] = def.resizable ? [w, h] : rot % 2 === 1 ? [h, w] : [w, h];
        const x = Math.round(cx + dx - fw / 2);
        const z = Math.round(cz + dz - fh / 2);
        const chk = g.checkPlacement(type, x, z, rot, def.resizable ? w : undefined, def.resizable ? h : undefined);
        if (!chk.ok) continue;
        let clear = true;
        for (let zz = z - 1; zz < z + fh + 1 && clear; zz++) {
          for (let xx = x - 1; xx < x + fw + 1; xx++) {
            if (xx < 0 || zz < 0 || xx >= s.W || zz >= s.H) { clear = false; break; }
            const i = zz * s.W + xx;
            if (s.tiles.building[i] >= 0 || g.rt.doorTiles.has(i)) { clear = false; break; }
          }
        }
        if (!clear || !g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
        if (!g.sameRegionSafe(chk.doorX, chk.doorZ, Math.floor(cx), Math.floor(cz))) continue;
        const sc = score(x + fw / 2, z + fh / 2) - d * (opts.distWeight ?? 0.5) - chk.clearing.length * 0.3;
        if (sc > bestScore) {
          bestScore = sc;
          best = { x, z, rot };
        }
      }
    }
  }
  return best;
}
