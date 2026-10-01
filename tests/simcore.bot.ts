/**
 * A scripted "bot" player used by the sim-core balance tests: follows a sensible Banished-style build order
 * (houses, gatherer, woodcutter, hunter, field, forester, fishing, then industry & services), marks trees/rocks
 * when materials run low and adds houses as the town grows.
 */
import { BUILDINGS, FOOD_TYPES } from '../src/core/defs';
import type { BuildingType, Inventory, ResourceType } from '../src/core/types';
import { Feature, Terrain } from '../src/core/types';
import { wantsOwnHome } from '../src/sim/core/households';
import type { Game } from '../src/sim/game';
import { bestPlacement } from './simcore.helpers';

interface Order {
  type: BuildingType;
  /** Only once this condition holds. */
  when?: (g: Game, bot: Bot) => boolean;
  w?: number;
  h?: number;
  /** Score helper for placement. */
  score?: 'trees' | 'water' | 'open' | 'town' | 'deer';
  maxR?: number;
  optional?: boolean;
  /** While this order waits for materials, nothing else that needs the same materials is built. */
  reserve?: boolean;
  /** Placement attempts so far. */
  tries?: number;
}

function year(g: Game): number {
  return g.state.time.year;
}

export interface BotOptions {
  /** Never build food production. */
  neglectFood?: boolean;
  /** Never build a woodcutter (no firewood production). */
  noWoodcutter?: boolean;
  /** Never build an herbalist or a hospital. */
  noHealth?: boolean;
  /** Never build a blacksmith. */
  noSmith?: boolean;
}

/** Buildings a sensible player gets up first (construction priority, and no new houses while they lack materials). */
const ESSENTIAL = new Set<BuildingType>(['woodcutter', 'gathererHut', 'hunterCabin', 'fishingDock', 'blacksmith', 'storageBarn']);

export class Bot {
  readonly g: Game;
  private queue: Order[];
  readonly placed: BuildingType[] = [];
  readonly skipped: BuildingType[] = [];
  private nextTick = 0;

  private readonly opts: BotOptions;

  constructor(g: Game, opts: BotOptions = {}) {
    this.g = g;
    this.opts = opts;
    const rebuild = new Set<BuildingType>(['woodcutter', 'blacksmith', 'gathererHut', 'fishingDock', 'hunterCabin', 'foresterLodge', 'herbalist', 'tailor']);
    g.events.on('buildingRemoved', (e) => {
      if ((e.cause === 'fire' || e.cause === 'tornado') && rebuild.has(e.type)) this.lost.push(e.type);
    });
    const food: Order[] = opts.neglectFood ? [] : [
      { type: 'gathererHut', score: 'trees' },
      { type: 'hunterCabin', score: 'deer', maxR: 45 },
      // the first field waits for a working gatherer hut: in tiny towns it would otherwise take every free worker
      // long before its first harvest
      { type: 'cropField', w: 8, h: 8, score: 'open', when: (gg) => year(gg) >= 2 || gg.state.buildings.some((b) => b.type === 'gathererHut' && b.state === 'active' && b.workerIds.length > 0) },
      { type: 'fishingDock', score: 'water', maxR: 45, optional: true },
    ];
    const all: Order[] = [
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
      // a Town Hall attracts nomads: the main source of new families before the first children grow up
      { type: 'townHall', score: 'town', when: (gg) => year(gg) >= 3 },
      { type: 'school', score: 'town', when: (gg) => year(gg) >= 3 },
      { type: 'woodcutter', score: 'town', when: (gg) => year(gg) >= 3 },
      { type: 'storageBarn', score: 'town', when: (gg) => { const u = gg.storageUsage(); return u.barnUsed > u.barnCap * 0.7; } },
      { type: 'hospital', score: 'town', when: (gg) => year(gg) >= 4 },

      { type: 'chapel', score: 'town', when: (gg) => year(gg) >= 5 },
    ];
    this.queue = all.filter((o) => !(opts.noWoodcutter && o.type === 'woodcutter') && !(opts.noSmith && o.type === 'blacksmith') &&
      !(opts.noHealth && (o.type === 'herbalist' || o.type === 'hospital')));
  }

  /** Resources still needed by construction sites (not yet delivered). */
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

  /** Called frequently; acts every ~6 game seconds. */
  tick(): void {
    const g = this.g;
    const s = g.state;
    if (s.time.elapsed < this.nextTick) return;
    this.nextTick = s.time.elapsed + 6;
    const center = g.townCenter();
    // builders: more when there is a lot to build
    const adults = s.citizens.filter((c) => c.age >= 10).length;
    // (a tiny town can spare only one builder)
    g.setBuilders(Math.max(adults < 10 ? 1 : 2, Math.min(6, Math.round(adults / 6) + (this.sitesPending() > 2 ? 1 : 0))));

    // materials: cut trees / break rocks near town when low
    const tot = g.resourceTotals();
    if (tot.log < 100 && g.rt.marked.size < 40) this.markNear(Feature.Tree, center.x, center.z, 'trees', 16);
    if (tot.stone < 40 && g.rt.marked.size < 40) this.markNear(Feature.Rock, center.x, center.z, 'stone', 6);
    // iron for the blacksmith (32), tailor, school... and for tools once the starting stock wears out
    if (tot.iron < 40 && g.rt.marked.size < 40) this.markNear(Feature.Iron, center.x, center.z, 'iron', 4);

    this.manageEconomy();

    // tools are running out: the blacksmith (and the iron for it) comes before anything else in the build order
    const adultsNow = s.citizens.filter((c) => c.age >= 10).length;
    if (!this.smithRushed && (s.time.year >= 2 || s.time.month >= 6) && tot.tool < adultsNow * 1.5) {
      const k = this.queue.findIndex((o) => o.type === 'blacksmith');
      if (k > 0) {
        const [o] = this.queue.splice(k, 1);
        this.queue.unshift({ ...o, when: undefined, reserve: true });
      }
      this.smithRushed = true;
    }

    // storage lost to fire/tornado (or full): a sensible player rebuilds it before anything else
    const u = g.storageUsage();
    const siteOf = (t: BuildingType) => s.buildings.some((b) => b.type === t && b.state !== 'active' && b.state !== 'ruin');
    if ((u.barnCap <= 0 || u.barnUsed > u.barnCap * 0.85) && !siteOf('storageBarn') && this.canAfford('storageBarn')) {
      if (this.build({ type: 'storageBarn', score: 'town' })) g.setPriority(s.buildings[s.buildings.length - 1].id, true);
    }
    if ((u.stockpileCap <= 0 || u.stockpileUsed > u.stockpileCap * 0.9) && !siteOf('stockpile') && this.canAfford('stockpile', 6, 6)) {
      this.build({ type: 'stockpile', w: 6, h: 6, score: 'town' });
    }

    // workplaces lost to fire or a tornado are rebuilt (most important first)
    for (const t of this.lost.splice(0)) {
      if ((t === 'woodcutter' && this.opts.noWoodcutter) || (t === 'blacksmith' && this.opts.noSmith)) continue;
      const score: Order['score'] = t === 'fishingDock' ? 'water' : t === 'hunterCabin' ? 'deer' : t === 'gathererHut' || t === 'foresterLodge' || t === 'herbalist' ? 'trees' : 'town';
      this.urgent({ type: t, score, reserve: t === 'woodcutter' || t === 'blacksmith' });
    }

    // more woodcutters as the town grows (about one per 7 homes; a harsh climate burns more)
    const cutters = s.buildings.filter((b) => b.type === 'woodcutter').length;
    const perCutter = s.settings.climate === 'harsh' ? 5 : 7;
    const homesNow = s.buildings.filter((b) => BUILDINGS[b.type].housing && b.residentIds.length > 0).length;
    if (!this.opts.noWoodcutter && cutters === 0 && (s.time.year > 1 || s.time.month >= 3) && !(this.queue[0]?.type === 'woodcutter')) {
      // no firewood production at all: top priority, searching further out each time
      this.woodTries++;
      this.urgent({ type: 'woodcutter', score: 'town', maxR: Math.min(50, 22 + this.woodTries * 4), reserve: true });
    }
    const cuttersBusy = s.buildings.filter((b) => b.type === 'woodcutter' && b.state === 'active').every((b) => b.workerIds.length >= 2);
    const woodShort = tot.firewood < homesNow * (s.time.month >= 6 ? 30 : 15);
    if (cutters > 0 && cutters < Math.ceil(homesNow / perCutter) && woodShort && (cuttersBusy || tot.firewood < homesNow * 10) &&
      !siteOf('woodcutter') && this.canAfford('woodcutter')) {
      this.build({ type: 'woodcutter', score: 'town' });
    }

    // extra houses as the town grows (homeless people or single adults of marrying age)
    const houses = s.buildings.filter((b) => BUILDINGS[b.type].familyHome).length;
    const homeless = s.citizens.filter((c) => c.homeId < 0).length;
    // young adults still living with their parents (or in a boarding house) move out as soon as a house is free
    const singles = s.citizens.filter((c) => wantsOwnHome(g, c)).length;
    // (new households mean children: while food is tight, only the homeless get a house)
    const wantHouses = (homeless > 0 ? 1 : 0) + (this.foodMonths() < 6 && s.time.year >= 2 ? 0 : Math.min(2, Math.ceil(singles / 2)));
    const emptyHouses = s.buildings.filter((b) => BUILDINGS[b.type].familyHome && (b.state !== 'active' || b.residentIds.length === 0)).length;
    // essential sites (firewood, food, tools, storage) waiting for materials come before more houses
    const essentialWaiting = s.buildings.some((b) => (b.state === 'construction' || b.state === 'clearing') && ESSENTIAL.has(b.type) &&
      Object.keys(b.cost).some((k) => {
        const r = k as ResourceType;
        return (b.cost[r] ?? 0) - (b.delivered[r] ?? 0) - (b.incoming[r] ?? 0) > tot[r];
      }));
    const saving = ((this.queue[0]?.reserve && !this.canAfford(this.queue[0].type)) || essentialWaiting) && homeless === 0;
    if (wantHouses > emptyHouses && !saving && this.sitesPending() < 4 && this.canAfford('woodenHouse') && houses < 40) {
      this.build({ type: 'woodenHouse', score: 'town' });
    }

    // next item in the build order
    if (this.sitesPending() >= 3) return;
    const head = this.queue[0];
    const reserved = head?.reserve && !this.canAfford(head.type, head.w, head.h) ? BUILDINGS[head.type].cost : null;
    for (let k = 0; k < this.queue.length; k++) {
      const o = this.queue[k];
      if (o.when && !o.when(g, this)) continue;
      if (!this.canAfford(o.type, o.w, o.h)) continue;
      if (reserved && k > 0 && Object.keys(BUILDINGS[o.type].cost).some((r) => r !== 'log' && r in reserved)) continue;
      this.queue.splice(k, 1);
      if (!this.build(o)) {
        if (o.optional) this.skipped.push(o.type);
        // no room near the centre (yet): try again later, a little further out
        else if ((o.tries ?? 0) < 4) this.queue.push({ ...o, tries: (o.tries ?? 0) + 1, maxR: (o.maxR ?? (o.score === 'town' ? 22 : 30)) + 8 });
      }
      break;
    }
  }

  /** Put an order at the front of the build order now (taking over a later order of the same type, if queued). */
  private urgent(o: Order): void {
    const k = this.queue.findIndex((x) => x.type === o.type);
    if (k >= 0) this.queue.splice(k, 1);
    this.queue.unshift(o);
  }

  /** Months of food left (storage + houses) at the current population. */
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

  /**
   * A sensible player plans the staffing of every workplace from the adults available (minus builders), most
   * important first: firewood, food (fewer foragers once a year of food is stored), tools when they run short, logs
   * when they run short, then everything else (luxuries get nobody while food is critically low). Nothing is asked
   * for that nobody could fill, so essential jobs never wait behind unstaffable ones.
   */
  private manageEconomy(): void {
    const g = this.g;
    const s = g.state;
    const months = this.foodMonths();
    const critical = months < 5 && s.time.year >= 2;
    const plenty = months > 15 && s.time.year >= 2;
    const tot = g.resourceTotals();
    const homes = s.buildings.filter((b) => BUILDINGS[b.type].housing && b.state === 'active' && b.residentIds.length > 0).length;
    const adults = s.citizens.filter((c) => c.age >= 10 && c.profession !== 'student').length;
    const builders = s.citizens.filter((c) => c.profession === 'builder').length;
    const lowWood = tot.firewood < homes * 30;
    const lowLogs = tot.log < 80;
    const lowTools = tot.tool < Math.max(3, adults * 0.3) && tot.iron >= 1;
    const active = s.buildings.filter((b) => b.state === 'active' && BUILDINGS[b.type].maxWorkers > 0);
    const base = (b: (typeof active)[number]) => this.baseWorkers.get(b.id) ?? BUILDINGS[b.type].defaultWorkers;
    const of = (...types: BuildingType[]) => active.filter((b) => types.includes(b.type));
    const plan: [(typeof active)[number], number][] = [];
    const first = new Set<number>();
    const add = (b: (typeof active)[number], n: number) => {
      plan.push([b, n]);
      first.add(b.id);
    };
    // food workers: enough to feed everybody with a margin; more while stocks are low, fewer once a year is stored
    // (a food worker makes about 200 food a year; an adult eats ~48, a child ~34)
    const kids = s.citizens.length - adults;
    const need = (adults * 48 + kids * 34) / 200;
    let foodCap = months < 8 || s.time.year < 2 ? Infinity : Math.ceil(need * (plenty ? 1.0 : 1.3)) + 1;
    const food = (b: (typeof active)[number], n: number) => {
      const k = Math.max(0, Math.min(n, foodCap));
      foodCap -= k;
      add(b, k);
    };
    for (const b of of('woodcutter')) add(b, 1);
    if (lowTools) for (const b of of('blacksmith')) add(b, 1);
    // firewood running out with winter coming: the second woodcutter comes before anything else
    const woodFirst = lowWood && (s.time.month >= 6 || tot.firewood < homes * 15);
    if (woodFirst) for (const b of of('woodcutter')) plan.push([b, 1]);
    // year-round foragers first, then fields, hunters, pastures; young orchards get a single tender
    for (const b of of('gathererHut', 'fishingDock')) food(b, base(b));
    for (const b of of('cropField')) food(b, base(b));
    for (const b of of('hunterCabin')) food(b, base(b));
    for (const b of of('pasture')) food(b, base(b));
    for (const b of of('orchard')) food(b, (b.orchard?.maturity ?? 0) < 0.3 ? 1 : base(b));
    if (lowWood && !woodFirst) for (const b of of('woodcutter')) plan.push([b, 1]);
    if (lowLogs) for (const b of of('foresterLodge')) add(b, base(b));
    // stone for houses and town buildings (and the blacksmith while it waits for its stone)
    const smithWaiting = this.queue[0]?.type === 'blacksmith';
    if (tot.stone < 60 || smithWaiting) for (const b of of('quarry')) add(b, 2);
    // a teacher once children are about to come of age (students don't work, but learn to work better)
    const pupils = s.citizens.filter((c) => c.age >= 8 && c.age < 14 && c.profession !== 'laborer').length;
    if (!critical && pupils >= 3) for (const b of of('school')) add(b, 1);
    for (const b of of('blacksmith')) if (!first.has(b.id) && tot.tool < adults) add(b, 1);
    for (const b of active) {
      if (first.has(b.id)) continue;
      const def = BUILDINGS[b.type];
      if (critical && b.type !== 'foresterLodge') plan.push([b, 0]);
      else plan.push([b, b.type === 'quarry' ? 2 : b.type === 'foresterLodge' ? base(b) : def.defaultWorkers]);
    }
    // keep a few laborers free: they clear trees/rocks/iron, haul buffers to storage and carry materials
    const laborers = adults < 15 ? 0 : Math.round(adults * 0.08);
    let left = Math.max(0, adults - builders - laborers);
    const want = new Map<number, number>();
    for (const [b, n] of plan) {
      const give = Math.min(n, left);
      left -= give;
      want.set(b.id, (want.get(b.id) ?? 0) + give);
    }
    for (const b of active) {
      const w = Math.min(BUILDINGS[b.type].maxWorkers, want.get(b.id) ?? 0);
      if (b.workersDesired !== w) g.setWorkers(b.id, w);
      if (b.priority) g.setPriority(b.id, false);
    }
    // nomads at the Town Hall: take them in while there is food to spare
    if (s.nomads) {
      const pop = s.citizens.length;
      const after = (months * pop) / Math.max(1, pop + s.nomads.count);
      // ...and there is time to build them homes before winter (homeless people freeze)
      const m = s.time.month;
      const empty = s.buildings.filter((b) => BUILDINGS[b.type].familyHome && b.state === 'active' && b.residentIds.length === 0).length;
      const housed = empty * 5 >= s.nomads.count || (m >= 1 && m <= 5);
      const warmth = tot.firewood >= homes * 20 || (m >= 1 && m <= 4);
      g.respondToNomads(after > 6 && housed && warmth && s.citizens.filter((c) => c.homeId < 0).length <= 2);
    }
    // food is running low: queue another food building near the front of the build order
    const key = s.time.year * 12 + s.time.month;
    // (only if the food workplaces there are have their workers: an unstaffed hut feeds nobody)
    const unstaffed = s.buildings.some((b) => b.state === 'active' && ['gathererHut', 'fishingDock', 'cropField', 'hunterCabin'].includes(b.type) &&
      b.workerIds.length === 0);
    if (months < 7 && s.time.year >= 2 && key - this.lastFoodBuild >= 6 && !unstaffed) {
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

  private smithRushed = false;
  private woodTries = 0;
  /** Workplaces destroyed by fire / tornado, waiting to be rebuilt. */
  private readonly lost: BuildingType[] = [];
  /** Workers the bot assigned when it built a workplace (restored when food gets short again). */
  private readonly baseWorkers = new Map<number, number>();
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
      if (ESSENTIAL.has(o.type)) g.setPriority(b.id, true);
      // sensible early staffing: few foresters, food first
      if (o.type === 'foresterLodge') g.setWorkers(b.id, 2);
      if (o.type === 'hunterCabin') g.setWorkers(b.id, 2);
      if (o.type === 'fishingDock') g.setWorkers(b.id, 3);
      if (o.type === 'cropField') g.setWorkers(b.id, g.state.citizens.filter((c) => c.age >= 10).length < 10 ? 2 : 3);
      // tiny towns: keep someone free for firewood
      if (o.type === 'gathererHut' && g.state.citizens.filter((c) => c.age >= 10).length < 10) g.setWorkers(b.id, 2);
      this.baseWorkers.set(b.id, b.workersDesired);
    }
    return !!b;
  }

  private markNear(f: Feature, cx: number, cz: number, filter: 'trees' | 'stone' | 'iron', size: number): void {
    const g = this.g;
    const s = g.state;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    // keep the forests of gatherers / hunters / herbalists / foresters intact
    const keep = s.buildings.filter((b) => ['gathererHut', 'hunterCabin', 'herbalist', 'foresterLodge'].includes(b.type))
      .map((b) => [b.x + b.w / 2, b.z + b.h / 2, (BUILDINGS[b.type].workRadius ?? 12) + 4] as const);
    for (let z = 1; z < s.H - 1; z += 2) {
      for (let x = 1; x < s.W - 1; x += 2) {
        const i = z * s.W + x;
        if (s.tiles.feature[i] !== f || s.tiles.marked[i]) continue;
        if (s.tiles.building[i] >= 0) continue;
        if (f === Feature.Tree && s.tiles.featureAmount[i] < 0.8) continue;
        const d = Math.hypot(x - cx, z - cz);
        if (d < 8) continue; // keep the town centre
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

export function yearlyProduction(g: Game): Inventory {
  const out: Inventory = {};
  for (const b of g.state.buildings) {
    for (const k in b.producedLastYear) {
      const r = k as ResourceType;
      out[r] = Math.round((out[r] ?? 0) + (b.producedLastYear[r] ?? 0));
    }
  }
  return out;
}

export function foodProducedLastYear(g: Game): number {
  const p = yearlyProduction(g);
  let n = 0;
  for (const r of FOOD_TYPES) n += p[r] ?? 0;
  return n;
}
