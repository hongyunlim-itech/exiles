/** Shared helpers for sim-world tests (not a test file itself). */
import { Rng } from '../src/core/rng';
import type { Building, BuildingType, GameState, NewGameSettings } from '../src/core/types';
import { Terrain } from '../src/core/types';
import type { Game } from '../src/sim/game';
import { generateWorld } from '../src/sim/worldgen';

export function makeSettings(over: Partial<NewGameSettings> = {}): NewGameSettings {
  return { seed: 1, townName: 'Testmere', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: true, ...over };
}

/** Flat all-grass state (heights 0.5) of the given size. */
export function makeState(W: number, H: number): GameState {
  const N = W * H;
  return {
    version: 1,
    settings: makeSettings(),
    W,
    H,
    tiles: {
      height: new Float32Array((W + 1) * (H + 1)).fill(0.5),
      terrain: new Uint8Array(N).fill(Terrain.Grass),
      feature: new Uint8Array(N),
      featureAmount: new Float32Array(N),
      variant: new Uint8Array(N),
      road: new Uint8Array(N),
      building: new Int32Array(N).fill(-1),
      marked: new Uint8Array(N),
      region: new Int32Array(N),
    },
    time: { elapsed: 0, year: 1, month: 0, monthProgress: 0, dayTime: 0.3 },
    weather: { temperature: 10, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0, windStrength: 0 },
    citizens: [],
    buildings: [],
    animals: [],
    nextId: 1,
    unlocked: { crops: ['wheat'], orchards: [], livestock: [] },
    buildersDesired: 0,
    trade: { merchant: null, nextArrival: 100, requested: null },
    nomads: null,
    nextNomads: 100,
    messages: [],
    history: [],
    tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
    rngState: 12345,
    rev: { terrain: 0, features: 0, roads: 0, buildings: 0, fields: 0 },
    unburied: 0,
    gameOver: false,
    tornado: null,
  };
}

/** State built from a generated world (as Game.create would, minus the settlement). */
export function makeWorldState(settings: NewGameSettings): { state: GameState; startX: number; startZ: number } {
  let nextId = 1;
  const res = generateWorld(settings, new Rng(settings.seed), () => nextId++);
  const s = makeState(res.W, res.H);
  s.settings = settings;
  s.tiles = res.tiles;
  s.animals = res.animals;
  s.nextId = nextId;
  return { state: s, startX: res.startX, startZ: res.startZ };
}

/** Minimal Game stand-in exposing what sim-world code uses. */
export function mockGame(state: GameState): Game {
  const buildingById = new Map<number, Building>();
  for (const b of state.buildings) buildingById.set(b.id, b);
  const animalById = new Map(state.animals.map((a) => [a.id, a] as const));
  const messages: string[] = [];
  const game = {
    state,
    rng: new Rng(state.rngState),
    speed: 1,
    buildingById,
    citizenById: new Map(),
    animalById,
    newId: () => state.nextId++,
    addMessage: (text: string) => {
      messages.push(text);
      return { id: 0, time: 0, year: 1, month: 0, text, severity: 'info' };
    },
    bumpFeatures: () => {
      state.rev.features++;
    },
    messages,
  };
  return game as unknown as Game;
}

/** Add a building occupying [x, x+w) × [z, z+h) to state + game index. */
export function addBuilding(game: Game, type: BuildingType, x: number, z: number, w: number, h: number): Building {
  const s = game.state;
  const b = { id: s.nextId++, type, x, z, w, h, rotation: 0, doorX: x, doorZ: z + h, state: 'active' } as unknown as Building;
  s.buildings.push(b);
  game.buildingById.set(b.id, b);
  for (let zz = z; zz < z + h; zz++) for (let xx = x; xx < x + w; xx++) s.tiles.building[zz * s.W + xx] = b.id;
  s.rev.buildings++;
  return b;
}

export function setTerrain(s: GameState, x: number, z: number, t: Terrain): void {
  s.tiles.terrain[z * s.W + x] = t;
}
