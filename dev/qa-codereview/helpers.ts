import { BUILDINGS } from '../../src/core/defs';
import type { Building, BuildingType, Citizen, Gender, NewGameSettings } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { completeConstruction } from '../../src/sim/core/buildings';
import { findSpot } from '../../src/sim/core/setup';
import { addCitizen, makeCitizen } from '../../src/sim/core/citizens';
import { moveIn } from '../../src/sim/core/households';

export function settings(over: Partial<NewGameSettings> = {}): NewGameSettings {
  return { seed: 4242, townName: 'QA', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false, ...over };
}

/** Place a building near (cx,cz), clear its footprint instantly and complete it. */
export function forceBuild(g: Game, type: BuildingType, cx?: number, cz?: number, w?: number, h?: number): Building {
  const c = g.townCenter();
  const spot = findSpot(g, type, cx ?? c.x, cz ?? c.z, 60, w, h, true);
  if (!spot) throw new Error('no spot for ' + type);
  const b = g.placeBuilding(type, spot.x, spot.z, 0, w, h);
  if (!b) throw new Error('place failed ' + type);
  const s = g.state;
  for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) {
    const i = zz * s.W + xx;
    if (s.tiles.feature[i]) g.removeFeature(i);
  }
  b.delivered = { ...b.cost };
  b.workRemaining = 0;
  completeConstruction(g, b);
  return b;
}

export function spawnAt(g: Game, b: Building | null, o: { age: number; gender: Gender; motherId?: number; fatherId?: number; name?: string }): Citizen {
  const x = b ? b.doorX + 0.5 : g.townCenter().x;
  const z = b ? b.doorZ + 0.5 : g.townCenter().z;
  const c = makeCitizen(g, { x, z, age: o.age, gender: o.gender, motherId: o.motherId, fatherId: o.fatherId, name: o.name });
  addCitizen(g, c);
  if (o.motherId !== undefined && o.motherId >= 0) g.getCitizen(o.motherId)?.childIds.push(c.id);
  if (o.fatherId !== undefined && o.fatherId >= 0) g.getCitizen(o.fatherId)?.childIds.push(c.id);
  if (b) moveIn(g, c, b);
  return c;
}

export function steps(g: Game, seconds: number, dt = 0.25, each?: () => void): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) { g.step(dt); each?.(); }
}

export { BUILDINGS, Game };

export function log(...args: unknown[]): void {
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}
