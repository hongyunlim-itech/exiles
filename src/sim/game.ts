/**
 * Game — the simulation root. OWNER: sim-core agent.
 * The PUBLIC API below is a fixed contract used by UI, input, render, sim-ext and tests.
 * Do not change signatures; you may add new public methods/fields.
 *
 * Implementation lives in src/sim/core/*: time & weather, storage, placement, buildings, farming, citizens,
 * households, jobs, the task/behaviour engine (tasks, claims, steps, planner, behavior, work/*) and setup.
 */
import { ADULT_AGE, ELDERLY_AGE, MAX_SIM_STEP } from '../core/constants';
import { BUILDINGS, CROPS, FOOD_TYPES, LIVESTOCK, ORCHARDS, PROFESSION_TYPES } from '../core/defs';
import { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import type {
  Animal, Building, BuildingType, CauseOfDeath, Citizen, CropType, GameEvents, GameMessage, GameSpeed, GameState,
  Inventory, LivestockType, MerchantKind, MessageSeverity, NewGameSettings, OrchardType, PlacementCheck, Profession,
  RemovalFilter, ResourceType, Rotation, Season,
} from '../core/types';
import { Feature } from '../core/types';
import { currentSeason, isWalkable } from '../core/world';
import {
  abortTask as abortTaskImpl, dispatchFirefighters, onJobChanged as onJobChangedImpl, refreshFoodAvailability, updateBehavior,
} from './core/behavior';
import { demolishImpl, makeFieldTiles, placeBuildingImpl, removeBuildingImpl, updateBuildings } from './core/buildings';
import { addCitizen, killCitizenImpl, makeCitizen, updateBirths, updateLifecycle } from './core/citizens';
import { rebuildClaims } from './core/claims';
import { FARM_INTERVAL, updateFarming } from './core/farming';
import { updateHousing } from './core/households';
import { updateJobs } from './core/jobs';
import { nearestWalkable } from './core/movement';
import {
  checkPlacementImpl, checkRoadImpl, markRect, placeRoadImpl, recomputeRegionsSafe, removeRoadImpl, unmarkRect,
} from './core/placement';
import { SimRuntime } from './core/runtime';
import { sweepMarked } from './core/work/laborer';
import { createInitialState, setupSettlement } from './core/setup';
import { addToStorageNow, resourceTotalsOf, storageUsageOf, takeFromStorageNow } from './core/storage';
import { brainOf } from './core/tasks';
import { updateTime } from './core/time';
import { validateGame } from './core/validate';
import { countTreesInRadius, removeAnimal, updateNature } from './nature';
import { findPath, sameRegion } from './pathfinding';
import { deserializeState, serializeState } from './save';
import { updateDisasters } from './disasters';
import { updateNomads, respondToNomads as respondToNomadsImpl } from './nomads';
import { updateStats } from './stats';
import { executeTrade as executeTradeImpl, requestMerchant as requestMerchantImpl, updateTrade } from './trade';
import { updateWellbeing, wellbeingEfficiency } from './wellbeing';
import { persistExtRuntime } from './ext/runtime';

export interface PopulationSummary {
  total: number;
  adults: number;
  children: number;
  students: number;
  elderly: number;
  homeless: number;
  laborers: number;
  builders: number;
  sick: number;
}

export interface TradeTake {
  /** Index into state.trade.merchant.offers. */
  offerIndex: number;
  amount: number;
}

export interface TradeResult {
  ok: boolean;
  reason?: string;
}

export interface SpawnCitizenOptions {
  x: number;
  z: number;
  age?: number;
  gender?: 'M' | 'F';
  name?: string;
  sick?: number;
}

/** Seconds between housing/marriage/birth evaluations. */
const HOUSING_INTERVAL = 2;
/** Max messages kept in state (oldest dropped). */
const MAX_MESSAGES = 250;
/** Sound events: at most this many per second (token bucket), burst up to SOUND_BURST. */
const SOUND_RATE = 4;
const SOUND_BURST = 4;

export class Game {
  state: GameState;
  readonly events = new EventBus<GameEvents>();
  rng: Rng;
  /** 0 = paused. */
  speed: GameSpeed = 1;
  readonly citizenById = new Map<number, Citizen>();
  readonly buildingById = new Map<number, Building>();
  readonly animalById = new Map<number, Animal>();
  /** Runtime-only indexes (claims, building lists, budgets). Not saved. */
  readonly rt: SimRuntime;
  /** Building type lookup for core/world isWalkable. */
  private readonly typeOf = (id: number): BuildingType | undefined => this.buildingById.get(id)?.type;
  private errorLogAt = new Map<string, number>();

  protected constructor(state: GameState) {
    this.state = state;
    this.rng = new Rng(state.rngState);
    this.rt = new SimRuntime(state.W, state.H);
    this.rebuildRuntime();
  }

  /** (Re)build every runtime index from `state` (used on create and load). */
  private rebuildRuntime(): void {
    const s = this.state;
    const N = s.W * s.H;
    const t = s.tiles;
    if (!(t.building instanceof Int32Array) || t.building.length !== N) t.building = new Int32Array(N);
    if (!(t.region instanceof Int32Array) || t.region.length !== N) t.region = new Int32Array(N);
    t.building.fill(-1);
    this.citizenById.clear();
    this.buildingById.clear();
    this.animalById.clear();
    for (const b of s.buildings) {
      this.buildingById.set(b.id, b);
      for (let zz = b.z; zz < b.z + b.h; zz++) {
        for (let xx = b.x; xx < b.x + b.w; xx++) {
          if (xx >= 0 && zz >= 0 && xx < s.W && zz < s.H) t.building[zz * s.W + xx] = b.id;
        }
      }
      b.reservedOut ??= {};
      b.incoming ??= {};
      b.reservedIn ??= 0;
      if ((b.type === 'cropField' || b.type === 'orchard') && (!b.fieldTiles || b.fieldTiles.length !== b.w * b.h)) {
        b.fieldTiles = makeFieldTiles(b.w * b.h, b.type === 'orchard' ? 2 : 0);
      }
    }
    for (const c of s.citizens) {
      this.citizenById.set(c.id, c);
      brainOf(c);
    }
    for (const a of s.animals) this.animalById.set(a.id, a);
    this.rt.reset(s);
    recomputeRegionsSafe(this);
    rebuildClaims(this);
    const e = s.time.elapsed;
    this.rt.lastSlowTick = Math.floor(e);
    this.rt.lastHouseTick = Math.floor(e / HOUSING_INTERVAL);
    this.rt.lastFarmTick = Math.floor(e / FARM_INTERVAL);
    refreshFoodAvailability(this);
  }

  /** Generate a new world and starting settlement. */
  static create(settings: NewGameSettings): Game {
    const { state, startX, startZ } = createInitialState(settings);
    const g = new Game(state);
    setupSettlement(g, startX, startZ);
    refreshFoodAvailability(g);
    g.state.rngState = g.rng.state;
    return g;
  }

  /** Restore from a string produced by save(). Throws on invalid data. */
  static fromSave(json: string): Game {
    const state = deserializeState(json);
    if (!state || typeof state !== 'object' || !Array.isArray(state.citizens) || !Array.isArray(state.buildings) || !state.tiles) {
      throw new Error('Invalid save data');
    }
    return new Game(state);
  }

  save(): string {
    this.state.rngState = this.rng.state;
    persistExtRuntime(this);
    return serializeState(this.state);
  }

  /** Advance the simulation by a real-time delta (seconds), honoring `speed`. Clamp large deltas. */
  update(realDt: number): void {
    const clamped = Math.min(Math.max(Number.isFinite(realDt) ? realDt : 0, 0), 0.1);
    this.rt.soundTokens = Math.min(SOUND_BURST, this.rt.soundTokens + clamped * SOUND_RATE);
    if (this.speed <= 0 || this.state.gameOver) return;
    let gameDt = clamped * this.speed;
    this.rt.realTimeDriven = true;
    try {
      while (gameDt > 1e-9) {
        const d = Math.min(MAX_SIM_STEP, gameDt);
        this.step(d);
        gameDt -= d;
        if (this.state.gameOver) break;
      }
    } finally {
      this.rt.realTimeDriven = false;
    }
  }

  /** Advance exactly `dt` game seconds (<= MAX_SIM_STEP recommended). Used by tests/headless. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    const s = this.state;
    const prof = this.profile;
    let t0 = prof ? performance.now() : 0;
    const lap = (name: string): void => {
      if (this.rngTrace) this.rngTrace.push(`${name}:${this.rng.state}`);
      if (!prof) return;
      const t1 = performance.now();
      prof[name] = (prof[name] ?? 0) + (t1 - t0);
      t0 = t1;
    };
    if (!this.rt.realTimeDriven) this.rt.soundTokens = Math.min(SOUND_BURST, this.rt.soundTokens + dt * SOUND_RATE);
    // 1. time & weather
    updateTime(this, dt);
    // town food caches (rt.foodAvailable / townFood / rationing) are refreshed at a fixed point of EVERY step, so they
    // are a pure function of the state: a game restored from a snapshot then behaves exactly like the original
    // (lockstep co-op). Cheap: one pass over the buildings' inventories.
    this.guard('core.food', () => refreshFoodAvailability(this));
    lap('time');
    // 2. nature (sim-world)
    this.guard('updateNature', () => updateNature(this, dt));
    this.syncAnimals();
    lap('nature');
    const e = s.time.elapsed;
    const sec = Math.floor(e);
    const secondTick = sec !== this.rt.lastSlowTick;
    this.rt.lastSlowTick = sec;
    // 3. buildings (sim-core phases are guarded too: a bug must never freeze the whole game)
    this.guard('core.buildings', () => updateBuildings(this, dt, secondTick));
    const ft = Math.floor(e / FARM_INTERVAL);
    if (ft !== this.rt.lastFarmTick) {
      this.rt.lastFarmTick = ft;
      this.guard('core.farming', () => updateFarming(this, FARM_INTERVAL));
    }
    lap('buildings');
    // 4. lifecycle
    this.guard('core.lifecycle', () => updateLifecycle(this, dt));
    const ht = Math.floor(e / HOUSING_INTERVAL);
    if (ht !== this.rt.lastHouseTick) {
      this.rt.lastHouseTick = ht;
      this.guard('core.housing', () => {
        updateHousing(this);
        updateBirths(this, HOUSING_INTERVAL);
      });
    }
    lap('lifecycle');
    // 5. jobs (1 Hz) & fire dispatch
    if (secondTick) {
      this.guard('core.jobs', () => {
        updateJobs(this);
        dispatchFirefighters(this);
        if (sec % 10 === 0) sweepMarked(this);
      });
    }
    lap('jobs');
    // 6. behaviour
    this.guard('core.behavior', () => updateBehavior(this, dt));
    lap('behavior');
    // 7-10. other modules
    this.guard('updateWellbeing', () => updateWellbeing(this, dt));
    lap('wellbeing');
    this.guard('updateDisasters', () => updateDisasters(this, dt));
    lap('disasters');
    this.guard('updateTrade', () => updateTrade(this, dt));
    this.guard('updateNomads', () => updateNomads(this, dt));
    lap('trade+nomads');
    this.guard('updateStats', () => updateStats(this, dt));
    lap('stats');
    s.rngState = this.rng.state;
  }

  /** When set to an object, step() accumulates per-phase milliseconds into it (perf diagnostics). */
  profile: Record<string, number> | null = null;
  /** When set to an array, step() records the RNG state after each phase (determinism diagnostics). */
  rngTrace: string[] | null = null;

  // ---- queries -------------------------------------------------------------------------------

  getBuilding(id: number): Building | undefined {
    return this.buildingById.get(id);
  }

  getCitizen(id: number): Citizen | undefined {
    return this.citizenById.get(id);
  }

  buildingAtTile(x: number, z: number): Building | undefined {
    const s = this.state;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= s.W || tz >= s.H) return undefined;
    const id = s.tiles.building[tz * s.W + tx];
    return id >= 0 ? this.buildingById.get(id) : undefined;
  }

  /** Totals of every resource across storages (stockpiles, barns, markets, trading posts) — excludes houses & buffers. */
  resourceTotals(): Record<ResourceType, number> {
    return resourceTotalsOf(this);
  }

  /** Total food in storage. */
  foodTotal(): number {
    const t = this.resourceTotals();
    let n = 0;
    for (const r of FOOD_TYPES) n += t[r];
    return n;
  }

  populationSummary(): PopulationSummary {
    const p: PopulationSummary = { total: 0, adults: 0, children: 0, students: 0, elderly: 0, homeless: 0, laborers: 0, builders: 0, sick: 0 };
    for (const c of this.state.citizens) {
      p.total++;
      if (c.profession === 'student') p.students++;
      else if (c.age < ADULT_AGE) p.children++;
      else {
        p.adults++;
        if (c.age >= ELDERLY_AGE) p.elderly++;
      }
      if (c.homeId < 0) p.homeless++;
      if (c.profession === 'laborer') p.laborers++;
      if (c.profession === 'builder') p.builders++;
      if (c.sick > 0) p.sick++;
    }
    return p;
  }

  professionCounts(): Record<Profession, number> {
    const out = {} as Record<Profession, number>;
    for (const p of PROFESSION_TYPES) out[p] = 0;
    for (const c of this.state.citizens) out[c.profession] = (out[c.profession] ?? 0) + 1;
    return out;
  }

  season(): Season {
    return currentSeason(this.state);
  }

  hasBuilding(type: BuildingType, activeOnly = true): boolean {
    return this.rt.ofType(this.state, type).some((b) => !activeOnly || b.state === 'active');
  }

  /** Storage capacity used/total, for UI. */
  storageUsage(): { stockpileUsed: number; stockpileCap: number; barnUsed: number; barnCap: number } {
    return storageUsageOf(this);
  }

  // ---- player commands -----------------------------------------------------------------------

  /** Validate a placement. For resizable zones pass w/h (rotation ignored for sizing). */
  checkPlacement(type: BuildingType, x: number, z: number, rotation: Rotation, w?: number, h?: number): PlacementCheck {
    return checkPlacementImpl(this, type, x, z, rotation, w, h);
  }

  /** Place a building/zone (marks features in the footprint for clearing). Returns null if invalid. */
  placeBuilding(type: BuildingType, x: number, z: number, rotation: Rotation, w?: number, h?: number): Building | null {
    return placeBuildingImpl(this, type, x, z, rotation, w, h);
  }

  /** Which tiles of a proposed road path are valid / blocked. Shallow water tiles become bridges. */
  checkRoad(tiles: number[], kind: 'dirt' | 'stone'): { ok: number[]; blocked: number[] } {
    return checkRoadImpl(this, tiles, kind);
  }

  /**
   * Place roads. Dirt roads are instant and free; stone roads take 1 stone per tile from storage and bridges
   * (roads over shallow water) take ROAD_DEFS.bridge.cost per tile — tiles that cannot be afforded are skipped.
   * Trees/rocks on road tiles are marked for clearing. Returns the number of tiles placed.
   */
  placeRoad(tiles: number[], kind: 'dirt' | 'stone'): number {
    return placeRoadImpl(this, tiles, kind);
  }

  removeRoad(tiles: number[]): number {
    return removeRoadImpl(this, tiles);
  }

  /** Mark trees/rocks/iron in the tile rectangle (inclusive) for removal by laborers. Returns count newly marked. */
  markForRemoval(x0: number, z0: number, x1: number, z1: number, filter: RemovalFilter): number {
    return markRect(this, x0, z0, x1, z1, filter);
  }

  unmarkRemoval(x0: number, z0: number, x1: number, z1: number): number {
    return unmarkRect(this, x0, z0, x1, z1);
  }

  /** Cancel a construction (refund delivered) or order demolition of an active building. */
  demolish(id: number): void {
    demolishImpl(this, id);
  }

  setWorkers(id: number, n: number): void {
    const b = this.buildingById.get(id);
    if (!b) return;
    const max = BUILDINGS[b.type].maxWorkers;
    b.workersDesired = Math.max(0, Math.min(max, Math.round(Number.isFinite(n) ? n : 0)));
  }

  setBuilders(n: number): void {
    this.state.buildersDesired = Math.max(0, Math.min(999, Math.round(Number.isFinite(n) ? n : 0)));
  }

  /** Crop field: CropType; orchard: OrchardType; pasture: LivestockType. Must be unlocked. */
  setCrop(id: number, choice: CropType | OrchardType | LivestockType): void {
    const b = this.buildingById.get(id);
    if (!b) return;
    const un = this.state.unlocked;
    if (b.type === 'cropField') {
      if (!(choice in CROPS) || !un.crops.includes(choice as CropType)) return;
      b.crop = choice as CropType;
    } else if (b.type === 'orchard') {
      if (!(choice in ORCHARDS) || !un.orchards.includes(choice as OrchardType)) return;
      if (b.orchard?.type === choice) return;
      b.orchard = { type: choice as OrchardType, maturity: 0, fruit: 0 };
      b.fieldTiles = makeFieldTiles(b.w * b.h, 2);
      this.state.rev.fields++;
    } else if (b.type === 'pasture') {
      if (!(choice in LIVESTOCK) || !un.livestock.includes(choice as LivestockType)) return;
      const l = b.livestock;
      if (l?.type === choice) return;
      // The old herd is released (no meat) and traded for a breeding pair of the new kind — at most as many animals
      // as there were, so switching back and forth creates neither food nor animals. A pasture stocked for the first
      // time (built before any livestock was unlocked) gets a pair.
      const count = l ? Math.min(2, Math.max(0, Math.floor(l.count))) : 2;
      b.livestock = { type: choice as LivestockType, count, breed: 0, product: 0 };
    } else return;
    this.state.rev.buildings++;
  }

  /** Workshops with several recipes: -1 = automatic. */
  setRecipe(id: number, recipe: number): void {
    const b = this.buildingById.get(id);
    const recipes = b ? BUILDINGS[b.type].recipes : undefined;
    if (!b || !recipes) return;
    const r = Math.round(recipe);
    if (r === -1 || (r >= 0 && r < recipes.length)) b.recipe = r;
  }

  setPaused(id: number, paused: boolean): void {
    const b = this.buildingById.get(id);
    if (!b) return;
    b.paused = !!paused;
    this.state.rev.buildings++;
  }

  setPriority(id: number, priority: boolean): void {
    const b = this.buildingById.get(id);
    if (!b) return;
    b.priority = !!priority;
  }

  executeTrade(give: Inventory, take: TradeTake[]): TradeResult {
    try {
      return executeTradeImpl(this, give, take);
    } catch (err) {
      this.reportModuleError('executeTrade', err);
      return { ok: false, reason: 'Trade failed' };
    }
  }

  requestMerchant(kind: MerchantKind | null): void {
    this.guard('requestMerchant', () => requestMerchantImpl(this, kind));
  }

  respondToNomads(accept: boolean): void {
    this.guard('respondToNomads', () => respondToNomadsImpl(this, accept));
  }

  // ---- services for sim modules (sim-ext, nature) -------------------------------------------

  /** Allocate a new unique entity id. */
  newId(): number {
    return this.state.nextId++;
  }

  spawnCitizen(opts: SpawnCitizenOptions): Citizen {
    const s = this.state;
    let x = Number.isFinite(opts.x) ? opts.x : s.W / 2;
    let z = Number.isFinite(opts.z) ? opts.z : s.H / 2;
    const tx = Math.max(0, Math.min(s.W - 1, Math.floor(x)));
    const tz = Math.max(0, Math.min(s.H - 1, Math.floor(z)));
    if (!this.isWalkableTile(tz * s.W + tx)) {
      const i = nearestWalkable(this, tx, tz, 30);
      if (i >= 0) {
        x = (i % s.W) + 0.5;
        z = Math.floor(i / s.W) + 0.5;
      }
    }
    const gender = opts.gender ?? (this.rng.chance(0.5) ? 'M' : 'F');
    const c = makeCitizen(this, {
      x, z, age: opts.age ?? this.rng.range(16, 36), gender, name: opts.name, sick: opts.sick,
    });
    addCitizen(this, c);
    return c;
  }

  killCitizen(id: number, cause: CauseOfDeath): void {
    killCitizenImpl(this, id, cause);
  }

  /** Immediately remove a building (fire/tornado/cancel). Releases workers/residents, clears tiles. */
  removeBuilding(id: number, cause: 'demolish' | 'fire' | 'tornado' | 'cancel'): void {
    removeBuildingImpl(this, id, cause);
  }

  addMessage(text: string, severity: MessageSeverity, target?: GameMessage['target']): GameMessage {
    const s = this.state;
    const msg: GameMessage = { id: this.newId(), time: s.time.elapsed, year: s.time.year, month: s.time.month, text, severity };
    if (target) msg.target = target;
    s.messages.push(msg);
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
    this.events.emit('message', msg);
    return msg;
  }

  /** Put resources into storage buildings with free capacity (nearest to (nearX, nearZ) first). Returns amount stored. */
  addToStorage(type: ResourceType, amount: number, nearX?: number, nearZ?: number): number {
    return addToStorageNow(this, type, amount, nearX, nearZ);
  }

  /** Remove unreserved resources from storage buildings. Returns amount actually taken. */
  takeFromStorage(type: ResourceType, amount: number): number {
    return takeFromStorageNow(this, type, amount);
  }

  /** Mark tile features dirty etc. Call after changing tiles.feature/featureAmount/marked. */
  bumpFeatures(): void {
    this.state.rev.features++;
  }

  // ---- additional public helpers (sim-core) ---------------------------------------------------

  /** Walkability of tile index i (terrain, bridges, buildings; zones walkable). */
  isWalkableTile(i: number): boolean {
    return isWalkable(this.state, i, this.typeOf);
  }

  isWalkableXZ(x: number, z: number): boolean {
    const s = this.state;
    if (x < 0 || z < 0 || x >= s.W || z >= s.H) return false;
    return isWalkable(s, z * s.W + x, this.typeOf);
  }

  /** Remove the feature on tile i (tree cut, rock depleted) and unmark it. */
  removeFeature(i: number): void {
    const t = this.state.tiles;
    t.feature[i] = Feature.None;
    t.featureAmount[i] = 0;
    t.marked[i] = 0;
    this.rt.marked.delete(i);
    this.bumpFeatures();
  }

  /** Animal lookup that tolerates stale indexes. */
  findAnimal(id: number): Animal | undefined {
    const a = this.animalById.get(id);
    if (a) return a;
    for (const x of this.state.animals) if (x.id === id) return x;
    return undefined;
  }

  /** Centre of the settlement (storage buildings, else citizens), for camera focus. */
  townCenter(): { x: number; z: number } {
    const s = this.state;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const b of this.rt.storages(s)) {
      sx += b.x + b.w / 2;
      sz += b.z + b.h / 2;
      n++;
    }
    if (n === 0) {
      for (const c of s.citizens) {
        sx += c.x;
        sz += c.z;
        n++;
      }
    }
    return n > 0 ? { x: sx / n, z: sz / n } : { x: s.W / 2, z: s.H / 2 };
  }

  /** Invariant check (tests / debugging). Returns a list of problems (empty when consistent). */
  validate(): string[] {
    return validateGame(this);
  }

  /** Emit a throttled sound cue. */
  sound(cue: GameEvents['sound']['cue'], x: number, z: number): void {
    if (this.rt.soundTokens < 1) return;
    this.rt.soundTokens -= 1;
    this.events.emit('sound', { cue, x, z });
  }

  /** A* path (sim-world) guarded against errors; null when unreachable. */
  findPathSafe(sx: number, sz: number, tx: number, tz: number): number[] | null {
    try {
      if (this.profile) {
        const t0 = performance.now();
        const p = findPath(this, sx, sz, tx, tz);
        this.profile['path.ms'] = (this.profile['path.ms'] ?? 0) + performance.now() - t0;
        this.profile['path.n'] = (this.profile['path.n'] ?? 0) + 1;
        if (p) this.profile['path.len'] = (this.profile['path.len'] ?? 0) + p.length;
        return p;
      }
      return findPath(this, sx, sz, tx, tz);
    } catch (err) {
      this.reportModuleError('findPath', err);
      return null;
    }
  }

  sameRegionSafe(ax: number, az: number, bx: number, bz: number): boolean {
    try {
      return sameRegion(this.state, ax, az, bx, bz);
    } catch (err) {
      this.reportModuleError('sameRegion', err);
      return true;
    }
  }

  countTrees(x: number, z: number, r: number): number {
    try {
      return countTreesInRadius(this, x, z, r);
    } catch (err) {
      this.reportModuleError('countTreesInRadius', err);
      return 6;
    }
  }

  removeAnimalSafe(id: number): void {
    try {
      removeAnimal(this, id);
    } catch (err) {
      this.reportModuleError('removeAnimal', err);
    }
    const i = this.state.animals.findIndex((a) => a.id === id);
    if (i >= 0) this.state.animals.splice(i, 1);
    this.animalById.delete(id);
  }

  /** Work speed factor from wellbeing (sim-ext), guarded. */
  wellbeingEff(c: Citizen): number {
    try {
      const e = wellbeingEfficiency(c);
      return Number.isFinite(e) && e > 0 ? e : 1;
    } catch (err) {
      this.reportModuleError('wellbeingEfficiency', err);
      return 1;
    }
  }

  recomputeRegions(): void {
    recomputeRegionsSafe(this);
  }

  /** Abort a citizen's current task, releasing all reservations. */
  abortTask(c: Citizen, dying = false): void {
    abortTaskImpl(this, c, dying);
  }

  /** Called when a citizen's profession / workplace changed. */
  onJobChanged(c: Citizen): void {
    onJobChangedImpl(this, c);
  }

  /** Count of errors thrown by other modules' functions called from the step (by function name). */
  moduleErrors(): Record<string, number> {
    return Object.fromEntries(this.rt.moduleErrors);
  }

  reportModuleError(name: string, err: unknown): void {
    const n = this.rt.countError(name);
    const now = Date.now();
    if (n <= 3 || now - (this.errorLogAt.get(name) ?? 0) > 5000) {
      this.errorLogAt.set(name, now);
      console.error(`[sim] ${name} threw (${n}x)`, err);
    }
  }

  private guard(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.reportModuleError(name, err);
    }
  }

  /** Keep animalById in sync with state.animals (nature adds/removes deer). */
  private syncAnimals(): void {
    const list = this.state.animals;
    if (this.animalById.size === list.length) {
      let ok = true;
      for (let i = 0; i < list.length; i += 7) {
        if (this.animalById.get(list[i].id) !== list[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return;
    }
    this.animalById.clear();
    for (const a of list) this.animalById.set(a.id, a);
  }
}
