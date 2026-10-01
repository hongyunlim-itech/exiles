/**
 * Test fixtures for sim-core regression tests: instant buildings, hand-placed citizens and families.
 * Not a test file (no `.test.ts`).
 */
import { BUILDINGS } from '../src/core/defs';
import type { Building, BuildingType, Citizen, Gender, NewGameSettings } from '../src/core/types';
import { completeConstruction } from '../src/sim/core/buildings';
import { addCitizen, makeCitizen } from '../src/sim/core/citizens';
import { moveIn } from '../src/sim/core/households';
import { findSpot } from '../src/sim/core/setup';
import { Game } from '../src/sim/game';

export function fixtureSettings(over: Partial<NewGameSettings> = {}): NewGameSettings {
  return { seed: 4242, townName: 'Fixture', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false, ...over };
}

/** Place a building near (cx, cz) (town centre by default), clear its footprint and complete it instantly. */
export function forceBuild(g: Game, type: BuildingType, cx?: number, cz?: number, w?: number, h?: number): Building {
  const c = g.townCenter();
  const spot = findSpot(g, type, cx ?? c.x, cz ?? c.z, 60, w, h, true);
  if (!spot) throw new Error(`no spot for ${type}`);
  const b = g.placeBuilding(type, spot.x, spot.z, 0, w, h);
  if (!b) throw new Error(`placement failed for ${type}`);
  const s = g.state;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const i = zz * s.W + xx;
      if (s.tiles.feature[i]) g.removeFeature(i);
    }
  }
  b.delivered = { ...b.cost };
  b.workRemaining = 0;
  if (b.state !== 'active') completeConstruction(g, b);
  return b;
}

/** Add a citizen standing at building b's door (or the town centre), optionally living in b. */
export function spawnAt(
  g: Game, b: Building | null, o: { age: number; gender: Gender; motherId?: number; fatherId?: number; name?: string; home?: boolean },
): Citizen {
  const x = b ? b.doorX + 0.5 : g.townCenter().x;
  const z = b ? b.doorZ + 0.5 : g.townCenter().z;
  const c = makeCitizen(g, { x, z, age: o.age, gender: o.gender, motherId: o.motherId, fatherId: o.fatherId, name: o.name });
  addCitizen(g, c);
  if (o.motherId !== undefined && o.motherId >= 0) g.getCitizen(o.motherId)?.childIds.push(c.id);
  if (o.fatherId !== undefined && o.fatherId >= 0) g.getCitizen(o.fatherId)?.childIds.push(c.id);
  if (b && o.home !== false && BUILDINGS[b.type].housing) moveIn(g, c, b);
  return c;
}

/** Remove every citizen (a blank town for hand-made households). */
export function emptyTown(g: Game): void {
  for (const c of [...g.state.citizens]) {
    const h = c.homeId >= 0 ? g.getBuilding(c.homeId) : undefined;
    if (h) h.residentIds = h.residentIds.filter((x) => x !== c.id);
    const w = c.workplaceId >= 0 ? g.getBuilding(c.workplaceId) : undefined;
    if (w) w.workerIds = w.workerIds.filter((x) => x !== c.id);
  }
  g.state.citizens = [];
  g.citizenById.clear();
}

/** A married couple (optionally living in `home`). */
export function couple(g: Game, home: Building | null, ages: [number, number] = [30, 28]): [Citizen, Citizen] {
  const m = spawnAt(g, home, { age: ages[0], gender: 'M' });
  const f = spawnAt(g, home, { age: ages[1], gender: 'F' });
  m.spouseId = f.id;
  f.spouseId = m.id;
  return [m, f];
}

export function steps(g: Game, seconds: number, dt = 0.25, each?: () => void): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    g.step(dt);
    each?.();
    if (g.state.gameOver) break;
  }
}

/** Freeze the calendar at a month (e.g. deep winter) while stepping. */
export function holdMonth(g: Game, month: number, progress = 0.3): void {
  g.state.time.month = month;
  g.state.time.monthProgress = progress;
}

export { Game };
