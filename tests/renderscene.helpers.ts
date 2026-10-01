/** Minimal GameState factory for render-scene unit tests. */
import type { Building, BuildingType, GameState } from '../src/core/types';
import { Terrain } from '../src/core/types';

export function makeState(W: number, H: number, height = 1): GameState {
  const n = W * H;
  return {
    version: 1,
    settings: { seed: 1, townName: 'T', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false },
    W,
    H,
    tiles: {
      height: new Float32Array((W + 1) * (H + 1)).fill(height),
      terrain: new Uint8Array(n).fill(Terrain.Grass),
      feature: new Uint8Array(n),
      featureAmount: new Float32Array(n),
      variant: new Uint8Array(n),
      road: new Uint8Array(n),
      building: new Int32Array(n).fill(-1),
      marked: new Uint8Array(n),
      region: new Int32Array(n),
    },
    time: { elapsed: 0, year: 1, month: 0, monthProgress: 0, dayTime: 0.3 },
    weather: { temperature: 10, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0, windStrength: 0 },
    citizens: [],
    buildings: [],
    animals: [],
    nextId: 1,
    unlocked: { crops: [], orchards: [], livestock: [] },
    buildersDesired: 0,
    trade: { merchant: null, nextArrival: 0, requested: null },
    nomads: null,
    nextNomads: 0,
    messages: [],
    history: [],
    tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
    rngState: 1,
    rev: { terrain: 0, features: 0, roads: 0, buildings: 0, fields: 0 },
    unburied: 0,
    gameOver: false,
    tornado: null,
  };
}

export function makeBuilding(id: number, type: BuildingType, x: number, z: number, w: number, h: number, extra: Partial<Building> = {}): Building {
  return {
    id, type, x, z, w, h, rotation: 0, doorX: x, doorZ: z + h, state: 'active', progress: 1,
    cost: {}, delivered: {}, incoming: {}, workRemaining: 0, priority: false, paused: false, workersDesired: 0,
    workerIds: [], residentIds: [], inventory: {}, reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0,
    smoking: false, producedThisYear: {}, producedLastYear: {}, builtAt: 0, ...extra,
  };
}

/** Add a building to the state and stamp its footprint into tiles.building. */
export function addBuilding(s: GameState, b: Building): Building {
  s.buildings.push(b);
  for (let z = b.z; z < b.z + b.h; z++) for (let x = b.x; x < b.x + b.w; x++) s.tiles.building[z * s.W + x] = b.id;
  return b;
}
