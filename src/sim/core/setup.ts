/**
 * New game: initial GameState from the world generator and the starting settlement per difficulty
 * (ARCHITECTURE §3.10). OWNER: sim-core.
 */
import { COAT_LIFETIME, MONTH_SECONDS, SAVE_VERSION, TOOL_LIFETIME, YEAR_SECONDS } from '../../core/constants';
import { BUILDINGS } from '../../core/defs';
import { Rng } from '../../core/rng';
import type {
  BuildingType, CropType, Difficulty, GameState, Inventory, LivestockType, NewGameSettings, OrchardType, ResourceType,
} from '../../core/types';
import { Feature } from '../../core/types';
import type { Game } from '../game';
import { generateWorld } from '../worldgen';
import { createBuilding, registerBuilding } from './buildings';
import { addCitizen, makeCitizen } from './citizens';
import { updateHousing } from './households';
import { nearestWalkable } from './movement';
import { checkPlacementImpl, flattenFootprint } from './placement';
import { initialWeather } from './time';
import { invGet, invKeys } from './util';

interface DifficultyDef {
  families: number;
  houses: number;
  stockpile: number;
  supplies: Inventory;
  food: number;
  foodMix: Partial<Record<ResourceType, number>>;
  coats: boolean;
  builders: number;
  /** Children per family: kidsMin..kidsMax, plus one more with chance kidsExtra. */
  kids: [number, number, number];
  unlocked: { crops: CropType[]; orchards: OrchardType[]; livestock: LivestockType[] };
}

export const DIFFICULTY: Record<Difficulty, DifficultyDef> = {
  easy: {
    families: 7, houses: 4, stockpile: 6, builders: 4, coats: true, kids: [1, 2, 0.35],
    food: 900, foodMix: { wheat: 0.28, beans: 0.22, berries: 0.2, venison: 0.3 },
    supplies: { firewood: 300, log: 200, stone: 100, iron: 60, tool: 30, woolCoat: 15, leatherCoat: 15, herbs: 30 },
    unlocked: { crops: ['wheat', 'corn', 'beans', 'potato'], orchards: ['apple', 'pear'], livestock: ['chicken', 'sheep'] },
  },
  medium: {
    families: 5, houses: 0, stockpile: 5, builders: 3, coats: true, kids: [1, 2, 0.35],
    food: 600, foodMix: { wheat: 0.3, beans: 0.25, berries: 0.2, venison: 0.25 },
    supplies: { firewood: 200, log: 150, stone: 60, iron: 30, tool: 20, woolCoat: 10, leatherCoat: 10, herbs: 20 },
    unlocked: { crops: ['wheat', 'beans'], orchards: ['apple'], livestock: ['chicken'] },
  },
  hard: {
    families: 4, houses: 0, stockpile: 4, builders: 2, coats: false, kids: [0, 1, 0.35],
    food: 450, foodMix: { wheat: 0.4, roots: 0.3, venison: 0.3 },
    supplies: { firewood: 100, log: 80, stone: 45, iron: 20, tool: 16, woolCoat: 5, leatherCoat: 5 },
    unlocked: { crops: ['wheat'], orchards: [], livestock: [] },
  },
};

export function createInitialState(settings: NewGameSettings): { state: GameState; startX: number; startZ: number } {
  const rng = new Rng(settings.seed >>> 0);
  let nextId = 1;
  const world = generateWorld(settings, rng, () => nextId++);
  const diff = DIFFICULTY[settings.difficulty] ?? DIFFICULTY.medium;
  const state: GameState = {
    version: SAVE_VERSION,
    settings: { ...settings },
    W: world.W,
    H: world.H,
    tiles: world.tiles,
    time: { elapsed: 0, year: 1, month: 0, monthProgress: 0, dayTime: 0.3 },
    weather: { temperature: 10, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0, windStrength: 0.3 },
    citizens: [],
    buildings: [],
    animals: world.animals,
    nextId,
    unlocked: { crops: [...diff.unlocked.crops], orchards: [...diff.unlocked.orchards], livestock: [...diff.unlocked.livestock] },
    buildersDesired: diff.builders,
    trade: { merchant: null, nextArrival: MONTH_SECONDS * 6, requested: null },
    nomads: null,
    nextNomads: YEAR_SECONDS * 2,
    messages: [],
    history: [],
    tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
    rngState: rng.state,
    rev: { terrain: 1, features: 1, roads: 1, buildings: 1, fields: 1 },
    unburied: 0,
    gameOver: false,
    tornado: null,
  };
  state.weather = initialWeather(state);
  return { state, startX: world.startX, startZ: world.startZ };
}

/** Spiral search for a placement near (cx, cz); prefers spots needing no clearing and keeps a 1-tile gap. */
export function findSpot(
  g: Game, type: BuildingType, cx: number, cz: number, maxR: number, w?: number, h?: number, allowClearing = false,
): { x: number; z: number } | null {
  const def = BUILDINGS[type];
  const fw = w ?? def.size[0];
  const fh = h ?? def.size[1];
  const offsets: [number, number, number][] = [];
  for (let dz = -maxR; dz <= maxR; dz++) {
    for (let dx = -maxR; dx <= maxR; dx++) offsets.push([dx, dz, dx * dx + dz * dz]);
  }
  offsets.sort((a, b) => a[2] - b[2]);
  for (const [dx, dz] of offsets) {
    const x = Math.round(cx + dx - fw / 2);
    const z = Math.round(cz + dz - fh / 2);
    const chk = checkPlacementImpl(g, type, x, z, 0, w, h);
    if (!chk.ok) continue;
    if (!allowClearing && chk.clearing.length > 0) continue;
    if (!gapFree(g, x, z, fw, fh)) continue;
    // entrance must be walkable and connected
    if (!g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
    return { x, z };
  }
  return null;
}

function gapFree(g: Game, x: number, z: number, w: number, h: number): boolean {
  const s = g.state;
  for (let zz = z - 1; zz <= z + h; zz++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      if (xx < 0 || zz < 0 || xx >= s.W || zz >= s.H) return false;
      if (s.tiles.building[zz * s.W + xx] >= 0) return false;
      if (g.rt.doorTiles.has(zz * s.W + xx)) return false;
    }
  }
  return true;
}

/** Place a finished building (starting settlement). */
function prebuild(g: Game, type: BuildingType, cx: number, cz: number, w?: number, h?: number): ReturnType<typeof createBuilding> | null {
  const spot = findSpot(g, type, cx, cz, 28, w, h, false) ?? findSpot(g, type, cx, cz, 40, w, h, true);
  if (!spot) return null;
  const chk = checkPlacementImpl(g, type, spot.x, spot.z, 0, w, h);
  const def = BUILDINGS[type];
  const b = createBuilding(g, type, spot.x, spot.z, w ?? def.size[0], h ?? def.size[1], 0, chk.doorX, chk.doorZ);
  registerBuilding(g, b);
  if (!def.walkable) flattenFootprint(g, b);
  // clear the footprint instantly
  const s = g.state;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const i = zz * s.W + xx;
      if (s.tiles.feature[i] !== Feature.None) g.removeFeature(i);
    }
  }
  b.state = 'active';
  b.progress = 1;
  b.workRemaining = 0;
  b.delivered = { ...b.cost };
  b.builtAt = 0;
  g.rt.dirty = true;
  return b;
}

export function setupSettlement(g: Game, startX: number, startZ: number): void {
  const s = g.state;
  const diff = DIFFICULTY[s.settings.difficulty] ?? DIFFICULTY.medium;
  const rng = g.rng;
  const barn = prebuild(g, 'storageBarn', startX, startZ);
  const pile = prebuild(g, 'stockpile', startX + (barn ? 1 : 0), startZ + 6, diff.stockpile, diff.stockpile);
  for (let k = 0; k < diff.houses; k++) prebuild(g, 'woodenHouse', startX - 2, startZ - 2);
  // supplies
  const foodMix = diff.foodMix;
  let foodLeft = diff.food;
  const foodKeys = invKeys(foodMix as Inventory);
  foodKeys.forEach((r, idx) => {
    const n = idx === foodKeys.length - 1 ? foodLeft : Math.round(diff.food * invGet(foodMix as Inventory, r));
    foodLeft -= n;
    g.addToStorage(r, n, startX, startZ);
  });
  for (const r of invKeys(diff.supplies)) g.addToStorage(r, invGet(diff.supplies, r), startX, startZ);

  // families
  const anchor = barn ?? pile;
  const ax = anchor ? anchor.doorX : startX;
  const az = anchor ? anchor.doorZ : startZ;
  const place = (): [number, number] => {
    for (let k = 0; k < 20; k++) {
      const x = Math.floor(ax + rng.range(-5, 5));
      const z = Math.floor(az + rng.range(-5, 5));
      if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
      if (g.isWalkableTile(z * s.W + x) && g.sameRegionSafe(x, z, ax, az)) return [x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8)];
    }
    const i = nearestWalkable(g, ax, az, 30);
    return i >= 0 ? [(i % s.W) + 0.5, Math.floor(i / s.W) + 0.5] : [ax + 0.5, az + 0.5];
  };
  for (let f = 0; f < diff.families; f++) {
    const [fx, fz] = place();
    const father = makeCitizen(g, { x: fx, z: fz, age: rng.range(22, 40), gender: 'M' });
    const surname = father.name.split(' ').slice(-1)[0];
    const [mx, mz] = place();
    const mother = makeCitizen(g, { x: mx, z: mz, age: Math.max(18, father.age + rng.range(-6, 3)), gender: 'F', surname });
    father.spouseId = mother.id;
    mother.spouseId = father.id;
    addCitizen(g, father);
    addCitizen(g, mother);
    const kids = rng.int(diff.kids[0], diff.kids[1]) + (rng.chance(diff.kids[2]) ? 1 : 0);
    // families bring their children, the eldest often a teenager: the first young adults start households of their
    // own in the first years (children born in town only come of age after MARRY_AGE years)
    const maxKidAge = Math.min(13.5, mother.age - 16);
    let eldest = maxKidAge;
    for (let k = 0; k < kids && eldest > 0.5; k++) {
      const [kx, kz] = place();
      const age = k === 0 ? rng.range(Math.max(0.5, maxKidAge - 6), maxKidAge) : rng.range(0.5, eldest);
      eldest = Math.max(0.5, age - 1);
      const kid = makeCitizen(g, {
        x: kx, z: kz, age, gender: rng.chance(0.5) ? 'M' : 'F', surname,
        motherId: mother.id, fatherId: father.id,
      });
      addCitizen(g, kid);
      father.childIds.push(kid.id);
      mother.childIds.push(kid.id);
    }
  }
  for (const c of s.citizens) {
    if (c.age >= 10) {
      c.toolWear = TOOL_LIFETIME * rng.range(0.5, 1);
      if (diff.coats) c.coatWear = COAT_LIFETIME * rng.range(0.4, 0.9);
    }
    c.happiness = 60;
  }
  updateHousing(g);
  g.addMessage(
    `The exiles have arrived at ${s.settings.townName}. Build homes, gather food and firewood before winter comes.`,
    'info', anchor ? { kind: 'building', id: anchor.id } : undefined,
  );
}
