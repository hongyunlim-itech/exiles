/**
 * QA copy of tests/simcore.bot.ts with neglect switches (scratch; not shipped).
 * Identical build order to the suite bot unless a flag is set.
 */
import { BUILDINGS, FOOD_TYPES } from '../../src/core/defs';
import type { BuildingType, Inventory, ResourceType } from '../../src/core/types';
import { Feature, Terrain } from '../../src/core/types';
import type { Game } from '../../src/sim/game';
import { bestPlacement } from '../../tests/simcore.helpers';

export interface QaBotOpts {
  neglectFood?: boolean;
  /** never build a woodcutter */
  noWoodcutter?: boolean;
  /** no houses at all until this game time (seconds) */
  housesAfter?: number;
  /** never build houses beyond N */
  maxHouses?: number;
  /** keep every workplace at 1 worker (most adults stay laborers) */
  minimalStaff?: boolean;
  /** never build a blacksmith */
  noBlacksmith?: boolean;
  /** never build a tailor */
  noTailor?: boolean;
  /** never build herbalist / hospital */
  noHealth?: boolean;
  /** build a town hall in year 3 (for nomads) */
  townHall?: boolean;
  /** build a trading post in year 3 */
  tradingPost?: boolean;
  /** stop all food production buildings after this game time (seconds) */
  foodStopAt?: number;
}

interface Order {
  type: BuildingType;
  when?: (g: Game, bot: QaBot) => boolean;
  w?: number;
  h?: number;
  score?: 'trees' | 'water' | 'open' | 'town' | 'deer';
  maxR?: number;
  optional?: boolean;
}

function year(g: Game): number {
  return g.state.time.year;
}

export class QaBot {
  readonly g: Game;
  private queue: Order[];
  readonly placed: BuildingType[] = [];
  readonly skipped: BuildingType[] = [];
  private nextTick = 0;
  readonly o: QaBotOpts;

  constructor(g: Game, opts: QaBotOpts = {}) {
    this.g = g;
    this.o = opts;
    const food: Order[] = opts.neglectFood ? [] : [
      { type: 'gathererHut', score: 'trees' },
      { type: 'hunterCabin', score: 'deer', maxR: 45 },
      { type: 'cropField', w: 8, h: 8, score: 'open', when: (gg) => year(gg) >= 2 || gg.state.buildings.some((b) => b.type === 'gathererHut' && b.state === 'active' && b.workerIds.length > 0) },
      { type: 'fishingDock', score: 'water', maxR: 45, optional: true },
    ];
    const q: Order[] = [
      { type: 'woodenHouse', score: 'town' },
      { type: 'woodenHouse', score: 'town' },
      ...food.slice(0, 1),
      { type: 'woodcutter', score: 'town' },
      ...food.slice(1, 3),
      { type: 'foresterLodge', score: 'trees' },
      { type: 'woodenHouse', score: 'town' },
      ...food.slice(3),
      { type: 'woodenHouse', score: 'town', when: (gg) => gg.state.time.month >= 3 || year(gg) > 1 },
      { type: 'well', score: 'town', when: (gg) => year(gg) >= 2 || gg.state.time.month >= 5 },
      { type: 'stockpile', w: 6, h: 6, score: 'town', when: (gg) => { const u = gg.storageUsage(); return u.stockpileUsed > u.stockpileCap * 0.7; } },
      { type: 'blacksmith', score: 'town', when: (gg) => year(gg) >= 2 },
      ...(opts.neglectFood ? [] : [
        { type: 'gathererHut' as BuildingType, score: 'trees' as const, when: (gg: Game) => year(gg) >= 2 },
        { type: 'cropField' as BuildingType, w: 10, h: 8, score: 'open' as const, when: (gg: Game) => year(gg) >= 2 },
      ]),
      { type: 'herbalist', score: 'trees', when: (gg) => year(gg) >= 2 },
      { type: 'tailor', score: 'town', when: (gg) => year(gg) >= 2 },
      { type: 'cemetery', w: 5, h: 5, score: 'town', when: (gg) => year(gg) >= 2 },
      { type: 'quarry', score: 'open', when: (gg) => year(gg) >= 2, optional: true },
      { type: 'foresterLodge', score: 'trees', when: (gg) => year(gg) >= 3 },
      { type: 'market', score: 'town', when: (gg) => year(gg) >= 3 },
      ...(opts.neglectFood ? [] : [
        { type: 'orchard' as BuildingType, w: 8, h: 8, score: 'open' as const, when: (gg: Game) => year(gg) >= 3 },
        { type: 'hunterCabin' as BuildingType, score: 'deer' as const, maxR: 50, when: (gg: Game) => year(gg) >= 3 },
      ]),
      { type: 'school', score: 'town', when: (gg) => year(gg) >= 3 },
      { type: 'woodcutter', score: 'town', when: (gg) => year(gg) >= 3 },
      { type: 'storageBarn', score: 'town', when: (gg) => { const u = gg.storageUsage(); return u.barnUsed > u.barnCap * 0.7; } },
      { type: 'hospital', score: 'town', when: (gg) => year(gg) >= 4 },
      { type: 'chapel', score: 'town', when: (gg) => year(gg) >= 5 },
    ];
    if (opts.townHall) q.push({ type: 'townHall', score: 'town', when: (gg) => year(gg) >= 3 });
    if (opts.tradingPost) q.push({ type: 'tradingPost', score: 'water', maxR: 45, when: (gg) => year(gg) >= 3, optional: true });
    this.queue = q.filter((o) => {
      if (opts.noWoodcutter && o.type === 'woodcutter') return false;
      if (opts.noBlacksmith && o.type === 'blacksmith') return false;
      if (opts.noTailor && o.type === 'tailor') return false;
      if (opts.noHealth && (o.type === 'herbalist' || o.type === 'hospital')) return false;
      return true;
    });
  }

  private housesAllowed(): boolean {
    const s = this.g.state;
    if (this.o.housesAfter !== undefined && s.time.elapsed < this.o.housesAfter) return false;
    const houses = s.buildings.filter((b) => BUILDINGS[b.type].familyHome).length;
    if (this.o.maxHouses !== undefined && houses >= this.o.maxHouses) return false;
    return true;
  }

  private committed(): Inventory {
    const out: Inventory = {};
    for (const b of this.g.state.buildings) {
      if (b.state !== 'construction' && b.state !== 'clearing') continue;
      for (const k in b.cost) {
        const r = k as ResourceType;
        out[r] = (out[r] ?? 0) + Math.max(0, (b.cost[r] ?? 0) - (b.delivered[r] ?? 0));
      }
    }
    return out;
  }

  canAfford(type: BuildingType, w?: number, h?: number): boolean {
    const def = BUILDINGS[type];
    const tot = this.g.resourceTotals();
    const com = this.committed();
    const tiles = (w ?? def.size[0]) * (h ?? def.size[1]);
    for (const k in def.cost) {
      const r = k as ResourceType;
      const need = (def.cost[r] ?? 0) * (def.costPerTile ? tiles : 1);
      if (tot[r] - (com[r] ?? 0) < need) return false;
    }
    return true;
  }

  private sitesPending(): number {
    return this.g.state.buildings.filter((b) => b.state === 'construction' || b.state === 'clearing').length;
  }

  private scoreFn(kind: Order['score']): (x: number, z: number) => number {
    const g = this.g;
    const s = g.state;
    switch (kind) {
      case 'trees':
        return (x, z) => Math.min(60, g.countTrees(x, z, 12)) * 0.6;
      case 'water':
        return (x, z) => {
          let n = 0;
          for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
            const tx = Math.floor(x + dx);
            const tz = Math.floor(z + dz);
            if (tx < 0 || tz < 0 || tx >= s.W || tz >= s.H) continue;
            const t = s.tiles.terrain[tz * s.W + tx];
            if (t === Terrain.Water || t === Terrain.DeepWater) n++;
          }
          return Math.min(n, 80) * 0.2;
        };
      case 'deer':
        return (x, z) => {
          let n = 0;
          for (const a of s.animals) if (Math.hypot(a.x - x, a.z - z) < 22) n++;
          return Math.min(n, 12) * 3 + Math.min(40, g.countTrees(x, z, 12)) * 0.2;
        };
      case 'open':
        return (x, z) => -g.countTrees(x, z, 6) * 0.8;
      default:
        return () => 0;
    }
  }

  tick(): void {
    const g = this.g;
    const s = g.state;
    if (s.time.elapsed < this.nextTick) return;
    this.nextTick = s.time.elapsed + 6;
    const center = g.townCenter();
    const adults = s.citizens.filter((c) => c.age >= 10).length;
    g.setBuilders(Math.max(2, Math.min(6, Math.round(adults / 6) + (this.sitesPending() > 2 ? 1 : 0))));

    const tot = g.resourceTotals();
    if (tot.log < 60 && g.rt.marked.size < 30) this.markNear(Feature.Tree, center.x, center.z, 'trees', 16);
    if (tot.stone < 40 && g.rt.marked.size < 40) this.markNear(Feature.Rock, center.x, center.z, 'stone', 6);
    if (tot.iron < 25 && g.rt.marked.size < 40) this.markNear(Feature.Iron, center.x, center.z, 'iron', 4);

    this.manageEconomy();

    const u = g.storageUsage();
    const siteOf = (t: BuildingType) => s.buildings.some((b) => b.type === t && b.state !== 'active' && b.state !== 'ruin');
    if ((u.barnCap <= 0 || u.barnUsed > u.barnCap * 0.85) && !siteOf('storageBarn') && this.canAfford('storageBarn')) {
      if (this.build({ type: 'storageBarn', score: 'town' })) g.setPriority(s.buildings[s.buildings.length - 1].id, true);
    }
    if ((u.stockpileCap <= 0 || u.stockpileUsed > u.stockpileCap * 0.9) && !siteOf('stockpile') && this.canAfford('stockpile', 6, 6)) {
      this.build({ type: 'stockpile', w: 6, h: 6, score: 'town' });
    }

    const houses = s.buildings.filter((b) => BUILDINGS[b.type].familyHome).length;
    const homeless = s.citizens.filter((c) => c.homeId < 0).length;
    const marryAge = (globalThis as any).__QA?.MARRY_AGE ?? 16;
    const singles = s.citizens.filter((c) => c.age >= marryAge && c.spouseId < 0).length;
    const wantHouses = (homeless > 0 ? 1 : 0) + (singles >= 2 ? 1 : 0);
    const emptyHouses = s.buildings.filter((b) => BUILDINGS[b.type].familyHome && (b.state !== 'active' || b.residentIds.length === 0)).length;
    if (this.housesAllowed() && wantHouses > emptyHouses && this.sitesPending() < 4 && this.canAfford('woodenHouse') && houses < 40) {
      this.build({ type: 'woodenHouse', score: 'town' });
    }

    if (this.sitesPending() >= 3) return;
    for (let k = 0; k < this.queue.length; k++) {
      const o = this.queue[k];
      if (o.type === 'woodenHouse' && !this.housesAllowed()) continue;
      if (o.when && !o.when(g, this)) continue;
      if (!this.canAfford(o.type, o.w, o.h)) continue;
      this.queue.splice(k, 1);
      if (!this.build(o) && o.optional) this.skipped.push(o.type);
      break;
    }
  }

  foodMonths(): number {
    const g = this.g;
    let food = g.foodTotal();
    for (const b of g.state.buildings) {
      if (!BUILDINGS[b.type].housing && !BUILDINGS[b.type].bufferCapacity) continue;
      for (const r of FOOD_TYPES) food += b.inventory[r] ?? 0;
    }
    const perMonth = (g.state.citizens.length * 45) / 12;
    return food / Math.max(1, perMonth);
  }

  private manageEconomy(): void {
    const g = this.g;
    const s = g.state;
    const months = this.foodMonths();
    const critical = months < 5 && s.time.year >= 2;
    const food = new Set<BuildingType>(['gathererHut', 'hunterCabin', 'fishingDock', 'cropField', 'orchard', 'pasture', 'woodcutter']);
    const luxury = new Set<BuildingType>(['quarry', 'tailor', 'herbalist', 'blacksmith', 'school', 'chapel', 'hospital', 'market', 'brewery', 'tavern']);
    const stopFood = this.o.foodStopAt !== undefined && s.time.elapsed >= this.o.foodStopAt;
    for (const b of s.buildings) {
      if (b.state !== 'active') continue;
      const def = BUILDINGS[b.type];
      if (stopFood && ['gathererHut', 'hunterCabin', 'fishingDock', 'cropField', 'orchard', 'pasture'].includes(b.type)) {
        if (b.workersDesired !== 0) g.setWorkers(b.id, 0);
        continue;
      }
      if (this.o.minimalStaff && def.maxWorkers > 0) {
        if (b.workersDesired !== 1) g.setWorkers(b.id, 1);
        continue;
      }
      if (food.has(b.type) && !b.priority) g.setPriority(b.id, true);
      if (luxury.has(b.type)) {
        const want = critical ? 0 : Math.min(def.defaultWorkers, b.type === 'quarry' ? 2 : def.defaultWorkers);
        if (b.workersDesired !== want) g.setWorkers(b.id, want);
      }
    }
    const key = s.time.year * 12 + s.time.month;
    if (!this.o.neglectFood && !stopFood && months < 7 && s.time.year >= 2 && key - this.lastFoodBuild >= 6) {
      this.lastFoodBuild = key;
      const hasWater = g.state.buildings.some((b) => b.type === 'fishingDock');
      const opts: Order[] = [
        { type: 'gathererHut', score: 'trees' },
        { type: 'cropField', w: 9, h: 9, score: 'open' },
        ...(hasWater ? [] : [{ type: 'fishingDock' as BuildingType, score: 'water' as const, maxR: 45, optional: true }]),
      ];
      this.queue.unshift(opts[this.foodRound++ % opts.length]);
    }
  }

  private lastFoodBuild = -100;
  private foodRound = 0;

  build(o: Order): boolean {
    const g = this.g;
    const c = g.townCenter();
    const p = bestPlacement(g, o.type, c.x, c.z, this.scoreFn(o.score), {
      w: o.w, h: o.h, maxR: o.maxR ?? (o.score === 'town' ? 22 : 30), distWeight: o.score === 'town' ? 1 : 0.4,
    });
    if (!p) {
      this.skipped.push(o.type);
      return false;
    }
    const def = BUILDINGS[o.type];
    const b = g.placeBuilding(o.type, p.x, p.z, p.rot, def.resizable ? o.w ?? def.size[0] : undefined, def.resizable ? o.h ?? def.size[1] : undefined);
    if (b) {
      this.placed.push(o.type);
      if (o.type === 'foresterLodge') g.setWorkers(b.id, 2);
      if (o.type === 'hunterCabin') g.setWorkers(b.id, 2);
      if (o.type === 'fishingDock') g.setWorkers(b.id, 3);
      if (o.type === 'cropField') g.setWorkers(b.id, g.state.citizens.filter((c) => c.age >= 10).length < 10 ? 2 : 3);
      if (o.type === 'gathererHut' && g.state.citizens.filter((c) => c.age >= 10).length < 10) g.setWorkers(b.id, 2);
    }
    return !!b;
  }

  private markNear(f: Feature, cx: number, cz: number, filter: 'trees' | 'stone' | 'iron', size: number): void {
    const g = this.g;
    const s = g.state;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    const keep = s.buildings.filter((b) => ['gathererHut', 'hunterCabin', 'herbalist', 'foresterLodge'].includes(b.type))
      .map((b) => [b.x + b.w / 2, b.z + b.h / 2, (BUILDINGS[b.type].workRadius ?? 12) + 4] as const);
    for (let z = 1; z < s.H - 1; z += 2) {
      for (let x = 1; x < s.W - 1; x += 2) {
        const i = z * s.W + x;
        if (s.tiles.feature[i] !== f || s.tiles.marked[i]) continue;
        if (s.tiles.building[i] >= 0) continue;
        if (f === Feature.Tree && s.tiles.featureAmount[i] < 0.8) continue;
        const d = Math.hypot(x - cx, z - cz);
        if (d < 8) continue;
        if (f === Feature.Tree && keep.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr)) continue;
        if (d < bestD && g.sameRegionSafe(x, z, Math.floor(cx), Math.floor(cz))) {
          bestD = d;
          best = [x, z];
        }
      }
    }
    if (!best) return;
    const h = Math.floor(size / 2);
    g.markForRemoval(best[0] - h, best[1] - h, best[0] + h, best[1] + h, filter);
  }
}
