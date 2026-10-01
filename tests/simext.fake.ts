/**
 * Minimal fake Game for sim-ext unit tests: a hand-built GameState plus just the Game services sim-ext calls.
 * (Not a test file itself — imported by tests/simext.*.test.ts.)
 */
import { BUILDINGS, FOOD_TYPES, RESOURCES, RESOURCE_TYPES } from '../src/core/defs';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import type {
  Animal, Building, BuildingType, CauseOfDeath, Citizen, GameEvents, GameMessage, GameState, MessageSeverity,
  ResourceType, TileData,
} from '../src/core/types';
import { Feature, Terrain } from '../src/core/types';
import { computeDoor } from '../src/core/world';
import type { Game, SpawnCitizenOptions } from '../src/sim/game';

export interface FakeGame {
  state: GameState;
  events: EventBus<GameEvents>;
  rng: Rng;
  citizenById: Map<number, Citizen>;
  buildingById: Map<number, Building>;
  animalById: Map<number, Animal>;
  killed: { id: number; cause: CauseOfDeath }[];
  removed: { id: number; cause: string }[];
  emitted: { type: string; payload: unknown }[];
  getBuilding(id: number): Building | undefined;
  getCitizen(id: number): Citizen | undefined;
  newId(): number;
  addMessage(text: string, severity: MessageSeverity, target?: GameMessage['target']): GameMessage;
  killCitizen(id: number, cause: CauseOfDeath): void;
  removeBuilding(id: number, cause: 'demolish' | 'fire' | 'tornado' | 'cancel'): void;
  spawnCitizen(opts: SpawnCitizenOptions): Citizen;
  addToStorage(type: ResourceType, amount: number, nearX?: number, nearZ?: number): number;
  takeFromStorage(type: ResourceType, amount: number): number;
  resourceTotals(): Record<ResourceType, number>;
  foodTotal(): number;
  storageUsage(): { stockpileUsed: number; stockpileCap: number; barnUsed: number; barnCap: number };
  bumpFeatures(): void;
  /** Test helpers */
  addCitizen(p?: Partial<Citizen>): Citizen;
  addBuilding(type: BuildingType, x: number, z: number, p?: Partial<Building>): Building;
  asGame(): Game;
}

export function makeTiles(W: number, H: number): TileData {
  const n = W * H;
  const building = new Int32Array(n);
  building.fill(-1);
  return {
    height: new Float32Array((W + 1) * (H + 1)).fill(1),
    terrain: new Uint8Array(n).fill(Terrain.Grass),
    feature: new Uint8Array(n).fill(Feature.None),
    featureAmount: new Float32Array(n),
    variant: new Uint8Array(n),
    road: new Uint8Array(n),
    building,
    marked: new Uint8Array(n),
    region: new Int32Array(n).fill(1),
  };
}

export function makeState(W = 48, H = 48, disasters = true): GameState {
  return {
    version: 1,
    settings: { seed: 1, townName: 'Testford', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters },
    W,
    H,
    tiles: makeTiles(W, H),
    time: { elapsed: 0, year: 1, month: 0, monthProgress: 0, dayTime: 0.3 },
    weather: { temperature: 12, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0, windStrength: 0.2 },
    citizens: [],
    buildings: [],
    animals: [],
    nextId: 1,
    unlocked: { crops: ['wheat'], orchards: [], livestock: [] },
    buildersDesired: 2,
    trade: { merchant: null, nextArrival: 0, requested: null },
    nomads: null,
    nextNomads: 0,
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

function capacityOf(b: Building): number {
  const st = BUILDINGS[b.type].storage;
  if (!st) return 0;
  return st.perTile ? st.capacity * b.w * b.h : st.capacity;
}

function used(b: Building): number {
  let n = 0;
  for (const k of Object.keys(b.inventory) as ResourceType[]) n += b.inventory[k] ?? 0;
  return n;
}

export function createFakeGame(opts: { W?: number; H?: number; disasters?: boolean; seed?: number } = {}): FakeGame {
  const state = makeState(opts.W ?? 48, opts.H ?? 48, opts.disasters ?? true);
  const g: FakeGame = {
    state,
    events: new EventBus<GameEvents>(),
    rng: new Rng(opts.seed ?? 42),
    citizenById: new Map(),
    buildingById: new Map(),
    animalById: new Map(),
    killed: [],
    removed: [],
    emitted: [],
    getBuilding(id) {
      return this.buildingById.get(id);
    },
    getCitizen(id) {
      return this.citizenById.get(id);
    },
    newId() {
      return this.state.nextId++;
    },
    addMessage(text, severity, target) {
      const m: GameMessage = { id: this.newId(), time: this.state.time.elapsed, year: this.state.time.year, month: this.state.time.month, text, severity, target };
      this.state.messages.push(m);
      return m;
    },
    killCitizen(id, cause) {
      const c = this.citizenById.get(id);
      if (!c) return;
      this.killed.push({ id, cause });
      this.citizenById.delete(id);
      this.state.citizens = this.state.citizens.filter((x) => x.id !== id);
      for (const b of this.state.buildings) {
        b.residentIds = b.residentIds.filter((x) => x !== id);
        b.workerIds = b.workerIds.filter((x) => x !== id);
      }
      this.state.tally.monthDeaths++;
      this.state.tally.deaths[cause] = (this.state.tally.deaths[cause] ?? 0) + 1;
      this.state.unburied++;
    },
    removeBuilding(id, cause) {
      const b = this.buildingById.get(id);
      if (!b) return;
      this.removed.push({ id, cause });
      this.buildingById.delete(id);
      this.state.buildings = this.state.buildings.filter((x) => x.id !== id);
      for (let z = b.z; z < b.z + b.h; z++) for (let x = b.x; x < b.x + b.w; x++) this.state.tiles.building[z * this.state.W + x] = -1;
      for (const c of this.state.citizens) if (c.homeId === id) c.homeId = -1;
      this.state.rev.buildings++;
      this.events.emit('buildingRemoved', { id, type: b.type, cause });
    },
    spawnCitizen(o) {
      return this.addCitizen({ x: o.x, z: o.z, age: o.age ?? 20, gender: o.gender ?? 'M', name: o.name ?? 'Nomad', sick: o.sick ?? 0 });
    },
    addToStorage(type, amount) {
      let left = amount;
      const kind = RESOURCES[type].storage;
      for (const b of this.state.buildings) {
        const st = BUILDINGS[b.type].storage;
        if (!st || b.state !== 'active' || !st.kinds.includes(kind)) continue;
        const free = capacityOf(b) - used(b);
        const put = Math.min(free, left);
        if (put <= 0) continue;
        b.inventory[type] = (b.inventory[type] ?? 0) + put;
        left -= put;
        if (left <= 0) break;
      }
      return amount - left;
    },
    takeFromStorage(type, amount) {
      let left = amount;
      for (const b of this.state.buildings) {
        if (!BUILDINGS[b.type].storage || b.state !== 'active') continue;
        const have = (b.inventory[type] ?? 0) - (b.reservedOut[type] ?? 0);
        const take = Math.min(have, left);
        if (take <= 0) continue;
        b.inventory[type] = (b.inventory[type] ?? 0) - take;
        left -= take;
        if (left <= 0) break;
      }
      return amount - left;
    },
    resourceTotals() {
      const t = {} as Record<ResourceType, number>;
      for (const r of RESOURCE_TYPES) t[r] = 0;
      for (const b of this.state.buildings) {
        if (!BUILDINGS[b.type].storage || b.state !== 'active') continue;
        for (const k of Object.keys(b.inventory) as ResourceType[]) t[k] += b.inventory[k] ?? 0;
      }
      return t;
    },
    foodTotal() {
      const t = this.resourceTotals();
      return FOOD_TYPES.reduce((a, k) => a + t[k], 0);
    },
    storageUsage() {
      let stockpileUsed = 0;
      let stockpileCap = 0;
      let barnUsed = 0;
      let barnCap = 0;
      for (const b of this.state.buildings) {
        const st = BUILDINGS[b.type].storage;
        if (!st || b.state !== 'active') continue;
        if (st.kinds.includes('barn')) {
          barnCap += capacityOf(b);
          barnUsed += used(b);
        } else {
          stockpileCap += capacityOf(b);
          stockpileUsed += used(b);
        }
      }
      return { stockpileUsed, stockpileCap, barnUsed, barnCap };
    },
    bumpFeatures() {
      this.state.rev.features++;
    },
    addCitizen(p = {}) {
      const id = this.newId();
      const c: Citizen = {
        id, name: `Citizen ${id}`, gender: 'M', age: 25, lifespan: 70, spouseId: -1, motherId: -1, fatherId: -1, childIds: [],
        homeId: -1, workplaceId: -1, profession: 'laborer', food: 80, warmth: 90, health: 80, happiness: 60, education: 0,
        sick: 0, dietMask: 3, dietTimers: [100, 100, 0, 0], toolWear: 500, coatWear: 500, x: 10.5, z: 10.5, heading: 0,
        moving: false, activity: 'idle', taskLabel: '', carrying: null, task: null, path: null, pathIndex: 0, starveTime: 0,
        freezeTime: 0, bornAt: 0, grief: 0,
        ...p,
      };
      this.state.citizens.push(c);
      this.citizenById.set(c.id, c);
      if (c.homeId >= 0) this.buildingById.get(c.homeId)?.residentIds.push(c.id);
      return c;
    },
    addBuilding(type, x, z, p = {}) {
      const def = BUILDINGS[type];
      const [w, h] = def.size;
      const [doorX, doorZ] = computeDoor(type, x, z, p.w ?? w, p.h ?? h, 0);
      const b: Building = {
        id: this.newId(), type, x, z, w, h, rotation: 0, doorX, doorZ, state: 'active', progress: 1, cost: { ...def.cost },
        delivered: {}, incoming: {}, workRemaining: 0, priority: false, paused: false, workersDesired: def.defaultWorkers,
        workerIds: [], residentIds: [], inventory: {}, reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0,
        smoking: false, producedThisYear: {}, producedLastYear: {}, builtAt: 0,
        ...p,
      };
      if (type === 'cemetery' && b.graves === undefined) b.graves = 0;
      this.state.buildings.push(b);
      this.buildingById.set(b.id, b);
      for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) this.state.tiles.building[zz * this.state.W + xx] = b.id;
      this.state.rev.buildings++;
      return b;
    },
    asGame() {
      return this as unknown as Game;
    },
  };
  // Record every emitted event.
  const origEmit = g.events.emit.bind(g.events);
  g.events.emit = ((type: keyof GameEvents, payload: unknown) => {
    g.emitted.push({ type: String(type), payload });
    origEmit(type, payload as never);
  }) as typeof g.events.emit;
  return g;
}

/** Advance fake time (elapsed / month / year) by dt seconds. */
export function advanceTime(g: FakeGame, dt: number): void {
  const t = g.state.time;
  t.elapsed += dt;
  const monthF = t.elapsed / 60;
  const totalMonths = Math.floor(monthF);
  t.month = totalMonths % 12;
  t.year = 1 + Math.floor(totalMonths / 12);
  t.monthProgress = monthF - totalMonths;
}
