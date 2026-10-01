/**
 * Runtime-only indexes of the simulation (rebuilt from GameState on create/load; never saved). OWNER: sim-core.
 */
import { BUILDINGS } from '../../core/defs';
import type { Building, BuildingType, GameState } from '../../core/types';
import { Feature } from '../../core/types';

export class SimRuntime {
  W: number;
  H: number;
  /** Citizen id holding an exclusive work claim on each tile, -1 none. */
  tileClaim: Int32Array;
  /** House id -> citizen currently fetching household supplies for it. */
  readonly houseFetcher = new Map<number, number>();
  /** Construction / demolition site id -> number of citizens holding a site slot. */
  readonly siteCount = new Map<number, number>();
  /** Tiles whose feature is marked for removal. */
  readonly marked = new Set<number>();
  /** Door tiles of non-walkable buildings (tile -> building id) — kept free of new buildings. */
  readonly doorTiles = new Map<number, number>();

  /** Building lists (rebuilt lazily when `dirty`). */
  private byTypeMap = new Map<BuildingType, Building[]>();
  /** Buildings with a storage def (any state). */
  private storageList: Building[] = [];
  private houseList: Building[] = [];
  private workplaceList: Building[] = [];
  private siteList: Building[] = [];
  dirty = true;

  /** Per-step budgets (reset every step). */
  pathBudget = 0;
  planBudget = 0;
  /** Sound throttle token bucket. */
  soundTokens = 4;
  /** True while inside Game.update (sound tokens are refilled by real time there). */
  realTimeDriven = false;
  /**
   * Integer tick counters derived from elapsed time (so save/load continues identically): farming (2 Hz),
   * housing/births (every 2 s), 1 Hz upkeep (jobs, fire dispatch, clearing checks).
   */
  lastFarmTick = -1;
  lastHouseTick = -1;
  lastSlowTick = -1;
  /** Shore tile cache for fishing docks: building id -> tile indices. */
  readonly shoreCache = new Map<number, number[]>();
  shoreCacheRev = -1;
  /** Error counters for guarded calls into other modules. */
  readonly moduleErrors = new Map<string, number>();
  /** Some storage or workplace buffer holds food (refreshed each second). */
  foodAvailable = true;
  /** All food in town (storage, homes, workplace buffers, salvage in ruins), refreshed each second. */
  townFood = 0;
  /** Food is short (less than about a month left): meals are rationed (refreshed each second). */
  rationing = false;
  /** Last month a frost message was posted per field (avoid spam). */
  readonly frostNotified = new Map<number, number>();

  constructor(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.tileClaim = new Int32Array(W * H).fill(-1);
  }

  reset(state: GameState): void {
    this.W = state.W;
    this.H = state.H;
    this.tileClaim = new Int32Array(state.W * state.H).fill(-1);
    this.houseFetcher.clear();
    this.siteCount.clear();
    this.marked.clear();
    this.doorTiles.clear();
    this.shoreCache.clear();
    this.dirty = true;
    const t = state.tiles;
    for (let i = 0; i < t.marked.length; i++) {
      if (t.marked[i] && t.feature[i] !== Feature.None) this.marked.add(i);
      else if (t.marked[i] && t.feature[i] === Feature.None) t.marked[i] = 0;
    }
    for (const b of state.buildings) this.addDoor(state, b);
  }

  addDoor(state: GameState, b: Building): void {
    if (BUILDINGS[b.type].walkable) return;
    if (b.doorX < 0 || b.doorZ < 0 || b.doorX >= state.W || b.doorZ >= state.H) return;
    this.doorTiles.set(b.doorZ * state.W + b.doorX, b.id);
  }

  removeDoor(state: GameState, b: Building): void {
    const i = b.doorZ * state.W + b.doorX;
    if (this.doorTiles.get(i) === b.id) this.doorTiles.delete(i);
  }

  private rebuild(state: GameState): void {
    this.byTypeMap.clear();
    this.storageList = [];
    this.houseList = [];
    this.workplaceList = [];
    this.siteList = [];
    for (const b of state.buildings) {
      let arr = this.byTypeMap.get(b.type);
      if (!arr) {
        arr = [];
        this.byTypeMap.set(b.type, arr);
      }
      arr.push(b);
      const def = BUILDINGS[b.type];
      if (def.storage) this.storageList.push(b);
      if (def.housing) this.houseList.push(b);
      if (def.maxWorkers > 0) this.workplaceList.push(b);
      if (b.state !== 'active') this.siteList.push(b);
    }
    this.dirty = false;
  }

  ensure(state: GameState): void {
    if (this.dirty) this.rebuild(state);
  }

  /** All buildings of a type (any state). */
  ofType(state: GameState, type: BuildingType): readonly Building[] {
    this.ensure(state);
    return this.byTypeMap.get(type) ?? EMPTY;
  }

  storages(state: GameState): readonly Building[] {
    this.ensure(state);
    return this.storageList;
  }

  houses(state: GameState): readonly Building[] {
    this.ensure(state);
    return this.houseList;
  }

  workplaces(state: GameState): readonly Building[] {
    this.ensure(state);
    return this.workplaceList;
  }

  /** Buildings not yet active (clearing/construction) or being demolished / ruins. */
  sites(state: GameState): readonly Building[] {
    this.ensure(state);
    return this.siteList;
  }

  countError(name: string): number {
    const n = (this.moduleErrors.get(name) ?? 0) + 1;
    this.moduleErrors.set(name, n);
    return n;
  }
}

const EMPTY: readonly Building[] = [];
