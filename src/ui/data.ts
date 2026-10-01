/**
 * Per-refresh cache of derived game data shared by all UI components. `invalidate()` is called once per UI tick
 * (~4 Hz) so several widgets asking for resource totals only trigger one `game.resourceTotals()` scan.
 * Every game call is guarded: a failing query logs (throttled) and returns neutral data instead of breaking the HUD.
 */
import { BUILDINGS, FOOD_TYPES, PROFESSION_TYPES, RESOURCE_TYPES } from '../core/defs';
import type { Building, BuildingType, Profession, ResourceType } from '../core/types';
import type { Game, PopulationSummary } from '../sim/game';

export interface StorageUsage {
  stockpileUsed: number;
  stockpileCap: number;
  barnUsed: number;
  barnCap: number;
}

export interface HousingInfo {
  /** Total resident slots in active houses. */
  capacity: number;
  residents: number;
  houses: number;
  /** Active houses with no residents. */
  emptyHouses: number;
  /** Houses still being built. */
  planned: number;
}

const lastLog = new Map<string, number>();

export function logThrottled(label: string, err: unknown): void {
  const now = performance.now();
  if ((lastLog.get(label) ?? -1e9) + 5000 > now) return;
  lastLog.set(label, now);
  console.warn(`[ui] ${label} failed`, err);
}

export function guard<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    logThrottled(label, err);
    return fallback;
  }
}

export function emptyTotals(): Record<ResourceType, number> {
  const r = {} as Record<ResourceType, number>;
  for (const t of RESOURCE_TYPES) r[t] = 0;
  return r;
}

function emptyPopulation(): PopulationSummary {
  return { total: 0, adults: 0, children: 0, students: 0, elderly: 0, homeless: 0, laborers: 0, builders: 0, sick: 0 };
}

function emptyProfessions(): Record<Profession, number> {
  const r = {} as Record<Profession, number>;
  for (const p of PROFESSION_TYPES) r[p] = 0;
  return r;
}

export class DataCache {
  private _totals: Record<ResourceType, number> | null = null;
  private _food = -1;
  private _pop: PopulationSummary | null = null;
  private _prof: Record<Profession, number> | null = null;
  private _storage: StorageUsage | null = null;
  private _housing: HousingInfo | null = null;
  private _byType: Map<BuildingType, Building[]> | null = null;

  constructor(private readonly getGame: () => Game) {}

  get game(): Game {
    return this.getGame();
  }

  invalidate(): void {
    this._totals = null;
    this._food = -1;
    this._pop = null;
    this._prof = null;
    this._storage = null;
    this._housing = null;
    this._byType = null;
  }

  totals(): Record<ResourceType, number> {
    if (!this._totals) {
      const t = guard('resourceTotals', () => this.game.resourceTotals(), null);
      const out = emptyTotals();
      if (t) for (const k of RESOURCE_TYPES) out[k] = t[k] ?? 0;
      this._totals = out;
    }
    return this._totals;
  }

  /** Total food in storage (sum of food resources in totals). */
  food(): number {
    if (this._food < 0) {
      const t = this.totals();
      let f = 0;
      for (const k of FOOD_TYPES) f += t[k];
      this._food = f;
    }
    return this._food;
  }

  coats(): number {
    const t = this.totals();
    return t.woolCoat + t.leatherCoat;
  }

  population(): PopulationSummary {
    if (!this._pop) this._pop = guard('populationSummary', () => this.game.populationSummary(), emptyPopulation());
    return this._pop;
  }

  professions(): Record<Profession, number> {
    if (!this._prof) {
      const p = guard('professionCounts', () => this.game.professionCounts(), null);
      const out = emptyProfessions();
      if (p) for (const k of PROFESSION_TYPES) out[k] = p[k] ?? 0;
      this._prof = out;
    }
    return this._prof;
  }

  storage(): StorageUsage {
    if (!this._storage) {
      this._storage = guard('storageUsage', () => this.game.storageUsage(), {
        stockpileUsed: 0, stockpileCap: 0, barnUsed: 0, barnCap: 0,
      });
    }
    return this._storage;
  }

  housing(): HousingInfo {
    if (!this._housing) {
      const h: HousingInfo = { capacity: 0, residents: 0, houses: 0, emptyHouses: 0, planned: 0 };
      for (const b of this.game.state.buildings) {
        const def = BUILDINGS[b.type];
        if (!def?.housing) continue;
        if (b.state === 'active') {
          h.houses++;
          h.capacity += def.housing;
          h.residents += b.residentIds.length;
          if (b.residentIds.length === 0) h.emptyHouses++;
        } else if (b.state === 'clearing' || b.state === 'construction') h.planned++;
      }
      this._housing = h;
    }
    return this._housing;
  }

  /** All buildings of a type (any state). */
  buildingsOfType(type: BuildingType): Building[] {
    if (!this._byType) {
      const m = new Map<BuildingType, Building[]>();
      for (const b of this.game.state.buildings) {
        let arr = m.get(b.type);
        if (!arr) m.set(b.type, (arr = []));
        arr.push(b);
      }
      this._byType = m;
    }
    return this._byType.get(type) ?? [];
  }

  /** Whether the town can afford a cost right now (storage totals). */
  canAfford(cost: Partial<Record<ResourceType, number>>, mult = 1): boolean {
    const t = this.totals();
    for (const k in cost) {
      const need = (cost[k as ResourceType] ?? 0) * mult;
      if (need > 0 && t[k as ResourceType] + 1e-6 < need) return false;
    }
    return true;
  }
}
