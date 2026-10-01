/**
 * Fake Game for the UI sandbox: plausible GameState (citizens, buildings of many kinds, merchant, nomads, history,
 * messages) plus the Game methods the UI calls. Not a simulation — only enough behaviour to exercise every panel.
 */
import { EventBus } from '../../src/core/events';
import { BUILDINGS, FEMALE_NAMES, FOOD_TYPES, MALE_NAMES, PROFESSION_TYPES, RESOURCE_TYPES, RESOURCES, SURNAMES, seasonOfMonth } from '../../src/core/defs';
import type {
  Building, BuildingType, Citizen, CropType, GameEvents, GameMessage, GameSpeed, GameState, Inventory, LivestockType,
  MessageSeverity, OrchardType, Profession, ResourceType, StatsSample,
} from '../../src/core/types';
import type { Game, PopulationSummary, TradeResult, TradeTake } from '../../src/sim/game';

let seed = 12345;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
function pick<T>(a: readonly T[]): T {
  return a[Math.floor(rnd() * a.length)];
}

export class MockGame {
  state: GameState;
  readonly events = new EventBus<GameEvents>();
  speed: GameSpeed = 1;
  readonly citizenById = new Map<number, Citizen>();
  readonly buildingById = new Map<number, Building>();
  readonly animalById = new Map();

  constructor() {
    const W = 64;
    const H = 64;
    const n = W * H;
    this.state = {
      version: 1,
      settings: { seed: 42, townName: 'Hollowmere', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: true },
      W, H,
      tiles: {
        height: new Float32Array((W + 1) * (H + 1)),
        terrain: new Uint8Array(n), feature: new Uint8Array(n), featureAmount: new Float32Array(n), variant: new Uint8Array(n),
        road: new Uint8Array(n), building: new Int32Array(n).fill(-1), marked: new Uint8Array(n), region: new Int32Array(n),
      },
      time: { elapsed: 3600 * 4.6, year: 5, month: 7, monthProgress: 0.4, dayTime: 0.55 },
      weather: { temperature: 12.4, snow: 0, precipitation: 'rain', precipIntensity: 0.4, windDir: 1, windStrength: 0.4 },
      citizens: [], buildings: [], animals: [], nextId: 1,
      unlocked: { crops: ['wheat', 'beans', 'potato'], orchards: ['apple', 'pear'], livestock: ['sheep', 'chicken'] },
      buildersDesired: 4,
      trade: { merchant: null, nextArrival: 200, requested: 'seeds' },
      nomads: null, nextNomads: 500, messages: [], history: [],
      tally: { births: 23, deaths: { oldAge: 3, starvation: 1, accident: 2, disease: 1 }, monthBirths: 1, monthDeaths: 0 },
      rngState: 1, rev: { terrain: 0, features: 0, roads: 0, buildings: 0, fields: 0 }, unburied: 0, gameOver: false, tornado: null,
    };
    this.populate();
  }

  newId(): number {
    return this.state.nextId++;
  }

  private addBuilding(type: BuildingType, x: number, z: number, patch: Partial<Building> = {}): Building {
    const def = BUILDINGS[type];
    const [w, h] = def.size;
    const b: Building = {
      id: this.newId(), type, x, z, w, h, rotation: 0, doorX: x + Math.floor(w / 2), doorZ: z + h,
      state: 'active', progress: 1, cost: { ...def.cost }, delivered: { ...def.cost }, incoming: {}, workRemaining: 0,
      priority: false, paused: false, workersDesired: def.defaultWorkers, workerIds: [], residentIds: [], inventory: {},
      reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0, smoking: false, producedThisYear: {}, producedLastYear: {},
      builtAt: 0, ...patch,
    };
    this.state.buildings.push(b);
    this.buildingById.set(b.id, b);
    return b;
  }

  private addCitizen(patch: Partial<Citizen> & { gender: 'M' | 'F' }): Citizen {
    const first = patch.gender === 'M' ? pick(MALE_NAMES) : pick(FEMALE_NAMES);
    const c: Citizen = {
      id: this.newId(), name: `${first} ${pick(SURNAMES)}`, age: 20 + rnd() * 30, lifespan: 70, spouseId: -1, motherId: -1,
      fatherId: -1, childIds: [], homeId: -1, workplaceId: -1, profession: 'laborer', food: 40 + rnd() * 60,
      warmth: 50 + rnd() * 50, health: 35 + rnd() * 65, happiness: 30 + rnd() * 70, education: rnd() * 0.6, sick: 0,
      dietMask: 1 | 2 | (rnd() > 0.5 ? 4 : 0), dietTimers: [100, 100, 0, 0], toolWear: rnd() > 0.2 ? 600 + rnd() * 1000 : 0,
      coatWear: rnd() > 0.4 ? 300 + rnd() * 1000 : 0, x: 20 + rnd() * 20, z: 20 + rnd() * 20, heading: 0, moving: true,
      activity: 'walking', taskLabel: 'Walking home', carrying: null, task: null, path: null, pathIndex: 0, starveTime: 0,
      freezeTime: 0, bornAt: 0, grief: 0, ...patch,
    };
    if (patch.name === undefined && patch.gender) c.name = `${first} ${pick(SURNAMES)}`;
    this.state.citizens.push(c);
    this.citizenById.set(c.id, c);
    return c;
  }

  private populate(): void {
    const houses: Building[] = [];
    for (let i = 0; i < 6; i++) {
      houses.push(this.addBuilding(i < 5 ? 'woodenHouse' : 'stoneHouse', 10 + i * 4, 10, {
        inventory: { wheat: 12 + i, venison: 8, apple: 6, firewood: 18 - i * 2, herbs: 3 }, smoking: i % 2 === 0,
      }));
    }
    this.addBuilding('stoneHouse', 36, 10, {
      state: 'construction', progress: 0.45, delivered: { log: 8, stone: 30, iron: 6 }, incoming: { stone: 10 }, priority: true,
    });
    this.addBuilding('boardingHouse', 42, 10, { state: 'clearing', progress: 0, delivered: {} });
    this.state.tiles.feature[10 * 64 + 43] = 1;
    this.state.tiles.feature[11 * 64 + 44] = 2;
    const stock = this.addBuilding('stockpile', 10, 20, { w: 8, h: 6, inventory: { log: 212, stone: 96, iron: 41, firewood: 384 } });
    void stock;
    this.addBuilding('storageBarn', 20, 20, {
      inventory: { wheat: 420, beans: 180, potato: 96, venison: 140, fish: 88, apple: 120, berries: 64, mushrooms: 30, tool: 31, woolCoat: 12, leatherCoat: 9, herbs: 26, leather: 14, wool: 22, ale: 18, eggs: 40 },
    });
    const field = this.addBuilding('cropField', 30, 20, {
      w: 10, h: 8, crop: 'wheat', fieldTiles: Array.from({ length: 80 }, (_, i) => ({ stage: i < 70 ? 2 : 3, growth: 0.62 + (i % 5) * 0.02 })),
      producedThisYear: { wheat: 0 }, producedLastYear: { wheat: 412 }, workersDesired: 4,
    });
    this.addBuilding('orchard', 42, 20, { w: 8, h: 8, orchard: { type: 'apple', maturity: 0.62, fruit: 0.35 }, producedLastYear: { apple: 96 } });
    this.addBuilding('pasture', 10, 32, { w: 10, h: 10, livestock: { type: 'sheep', count: 9, breed: 0.4, product: 0.7 }, producedThisYear: { wool: 18, mutton: 60 } });
    const tailor = this.addBuilding('tailor', 22, 32, { recipe: 1, inventory: { woolCoat: 4, wool: 6 }, producedThisYear: { woolCoat: 21, leatherCoat: 7 }, producedLastYear: { woolCoat: 30 }, smoking: true, workersDesired: 2 });
    const smith = this.addBuilding('blacksmith', 28, 32, { inventory: { tool: 3, iron: 2, log: 2 }, producedThisYear: { tool: 17 }, producedLastYear: { tool: 26 } });
    const gath = this.addBuilding('gathererHut', 34, 32, { inventory: { berries: 22, mushrooms: 9, roots: 12 }, producedThisYear: { berries: 240, mushrooms: 110, roots: 180 }, producedLastYear: { berries: 300, mushrooms: 90, roots: 150 } });
    const post = this.addBuilding('tradingPost', 40, 32, { inventory: { cherry: 40 }, workersDesired: 1 });
    this.addBuilding('townHall', 48, 32);
    this.addBuilding('cemetery', 10, 44, { w: 6, h: 6, graves: 7 });
    const school = this.addBuilding('school', 20, 44);
    this.addBuilding('woodcutter', 28, 44, { state: 'clearing', progress: 0, delivered: {} });
    const hunter = this.addBuilding('hunterCabin', 34, 44, { fire: 0.42, fireFighters: 3, inventory: { venison: 20, leather: 4 }, producedThisYear: { venison: 160, leather: 22 } });
    this.addBuilding('brewery', 40, 44, { state: 'ruin', progress: 0 });
    this.addBuilding('well', 46, 44);
    this.addBuilding('market', 50, 44, { inventory: { wheat: 60, venison: 30, firewood: 40, tool: 4 }, workersDesired: 3 });

    // families
    const profs: Profession[] = ['farmer', 'farmer', 'farmer', 'tailor', 'blacksmith', 'gatherer', 'gatherer', 'hunter', 'trader', 'teacher', 'builder', 'builder', 'laborer', 'laborer', 'herder'];
    const workplaceFor: Partial<Record<Profession, Building>> = { farmer: field, tailor, blacksmith: smith, gatherer: gath, hunter, trader: post, teacher: school };
    const tasks = ['Hauling 8 Logs to Stockpile', 'Harvesting wheat', 'Sewing a wool coat', 'Gathering berries', 'Eating at home', 'Building Stone House', 'Walking to work', 'Fetching firewood'];
    houses.forEach((house, hi) => {
      const dad = this.addCitizen({ gender: 'M', homeId: house.id, age: 28 + rnd() * 25 });
      const mom = this.addCitizen({ gender: 'F', homeId: house.id, age: 25 + rnd() * 20, spouseId: dad.id });
      dad.spouseId = mom.id;
      mom.name = `${mom.name.split(' ')[0]} ${dad.name.split(' ')[1]}`;
      for (const p of [dad, mom]) {
        p.profession = profs[(hi * 2 + (p === mom ? 1 : 0)) % profs.length];
        const wp = workplaceFor[p.profession];
        if (wp) {
          p.workplaceId = wp.id;
          wp.workerIds.push(p.id);
        }
        p.taskLabel = pick(tasks);
        p.activity = pick(['walking', 'working', 'hauling', 'farming', 'gathering'] as const);
        house.residentIds.push(p.id);
      }
      const kids = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < kids; k++) {
        const kid = this.addCitizen({
          gender: rnd() > 0.5 ? 'M' : 'F', age: 1 + rnd() * 13, homeId: house.id, motherId: mom.id, fatherId: dad.id,
          profession: 'child', taskLabel: 'Playing near home', activity: 'playing', toolWear: 0,
        });
        kid.name = `${kid.name.split(' ')[0]} ${dad.name.split(' ')[1]}`;
        if (kid.age >= 10) {
          kid.profession = 'student';
          kid.taskLabel = 'Studying at school';
          kid.activity = 'studying';
        }
        dad.childIds.push(kid.id);
        mom.childIds.push(kid.id);
        house.residentIds.push(kid.id);
      }
    });
    // a few homeless singles, one sick elder, a grieving widow
    for (let i = 0; i < 5; i++) {
      const c = this.addCitizen({ gender: i % 2 ? 'F' : 'M', profession: i < 3 ? 'laborer' : 'builder', taskLabel: i < 3 ? 'Clearing trees' : 'Delivering stone to Stone House', activity: i < 3 ? 'chopping' : 'building' });
      if (i === 0) c.carrying = { type: 'log', amount: 8 };
    }
    const elder = this.state.citizens.find((c) => c.profession !== 'child' && c.profession !== 'student' && c.id !== this.state.citizens[0].id && c.spouseId < 0) ?? this.state.citizens[1];
    elder.age = 66;
    elder.sick = 0.4;
    elder.health = 24;
    elder.grief = 60;
    const c0 = this.state.citizens[0];
    c0.carrying = { type: 'wheat', amount: 10 };
    c0.taskLabel = 'Hauling 10 Wheat to Storage Barn';
    c0.activity = 'hauling';
    c0.health = 82;
    c0.happiness = 64;
    c0.education = 0.35;
    c0.dietMask = 1 | 2 | 8;

    // merchant & nomads
    this.state.trade.merchant = {
      id: this.newId(), kind: 'seeds', name: 'Osric the Seed-Monger', postId: post.id, leavesIn: 84, arrive: 1,
      offers: [
        { kind: 'crop', id: 'corn', amount: 1, price: 60 },
        { kind: 'orchard', id: 'cherry', amount: 1, price: 90 },
        { kind: 'livestock', id: 'cattle', amount: 1, price: 120 },
        { kind: 'crop', id: 'wheat', amount: 1, price: 40 },
        { kind: 'resource', id: 'pear', amount: 150, price: 1.5 },
        { kind: 'resource', id: 'tool', amount: 20, price: 9 },
        { kind: 'resource', id: 'woolCoat', amount: 12, price: 11 },
        { kind: 'resource', id: 'iron', amount: 80, price: 2.5 },
      ],
    };
    this.state.nomads = { count: 7, expiresIn: 42, diseaseRisk: 0.22 };

    // history: 5 years of monthly samples
    const hist: StatsSample[] = [];
    for (let i = 0; i < 55; i++) {
      const y = 1 + Math.floor(i / 12);
      const m = i % 12;
      const pop = Math.round(22 + i * 0.5 + Math.sin(i / 4) * 2);
      const season = Math.sin(((m - 3) / 12) * Math.PI * 2);
      hist.push({
        year: y, month: m, population: pop, adults: Math.round(pop * 0.6), children: Math.round(pop * 0.25), students: Math.round(pop * 0.08),
        elderly: Math.round(pop * 0.07), births: rnd() > 0.6 ? 1 + Math.floor(rnd() * 2) : 0, deaths: rnd() > 0.85 ? 1 : 0,
        food: Math.max(80, 900 + i * 12 + season * 300), firewood: Math.max(20, 300 + i * 4 - season * 120), logs: 150 + i * 2 + Math.sin(i) * 20,
        stone: 60 + i * 0.8, iron: 20 + i * 0.4, tools: 25 + Math.sin(i / 6) * 6, clothing: 18 + i * 0.1, herbs: 20 + Math.sin(i / 3) * 5, ale: i > 30 ? (i - 30) * 1.2 : 0,
        avgHealth: 70 + Math.sin(i / 5) * 8, avgHappiness: 55 + Math.sin(i / 7) * 12, avgEducation: Math.min(0.4, i * 0.008),
      });
    }
    this.state.history = hist;

    // messages
    const msgs: [string, MessageSeverity, GameMessage['target']?][] = [
      ['The exiles have arrived at Hollowmere.', 'info'],
      ['A child was born: Edith Marsh.', 'good', { kind: 'citizen', id: this.state.citizens[4].id }],
      ['Stone House construction is waiting for builders.', 'warning', { kind: 'building', id: 7 }],
      ['Firewood is running low before winter!', 'warning'],
      ['A merchant has arrived at the trading post.', 'good', { kind: 'building', id: post.id }],
      ['Wulfric Hollis died of old age.', 'info'],
      ['Fire! The Hunting Cabin is burning!', 'danger', { kind: 'building', id: hunter.id }],
      ['7 nomads have arrived at the Town Hall.', 'info', { kind: 'building', id: 21 }],
      ['Frost has destroyed unharvested crops.', 'danger', { kind: 'building', id: field.id }],
      ['Storage is almost full.', 'warning'],
    ];
    msgs.forEach(([text, severity, target], i) => {
      this.state.messages.push({ id: this.newId(), time: i * 400, year: 1 + Math.floor(i / 2), month: (i * 5) % 12, text, severity, target });
    });
  }

  // ---- queries ----
  getBuilding(id: number): Building | undefined {
    return this.buildingById.get(id);
  }
  getCitizen(id: number): Citizen | undefined {
    return this.citizenById.get(id);
  }
  buildingAtTile(): Building | undefined {
    return undefined;
  }
  resourceTotals(): Record<ResourceType, number> {
    const r = {} as Record<ResourceType, number>;
    for (const t of RESOURCE_TYPES) r[t] = 0;
    for (const b of this.state.buildings) {
      if (b.state !== 'active' || !BUILDINGS[b.type].storage) continue;
      for (const k in b.inventory) r[k as ResourceType] += b.inventory[k as ResourceType] ?? 0;
    }
    return r;
  }
  foodTotal(): number {
    const t = this.resourceTotals();
    return FOOD_TYPES.reduce((a, f) => a + t[f], 0);
  }
  populationSummary(): PopulationSummary {
    const p: PopulationSummary = { total: 0, adults: 0, children: 0, students: 0, elderly: 0, homeless: 0, laborers: 0, builders: 0, sick: 0 };
    for (const c of this.state.citizens) {
      p.total++;
      if (c.profession === 'student') p.students++;
      else if (c.age < 10) p.children++;
      else if (c.age >= 60) p.elderly++;
      else p.adults++;
      if (c.homeId < 0) p.homeless++;
      if (c.profession === 'laborer') p.laborers++;
      if (c.profession === 'builder') p.builders++;
      if (c.sick > 0) p.sick++;
    }
    return p;
  }
  professionCounts(): Record<Profession, number> {
    const r = {} as Record<Profession, number>;
    for (const p of PROFESSION_TYPES) r[p] = 0;
    for (const c of this.state.citizens) r[c.profession]++;
    return r;
  }
  season() {
    return seasonOfMonth(this.state.time.month);
  }
  hasBuilding(type: BuildingType): boolean {
    return this.state.buildings.some((b) => b.type === type && b.state === 'active');
  }
  storageUsage() {
    let su = 0, sc = 0, bu = 0, bc = 0;
    for (const b of this.state.buildings) {
      const st = BUILDINGS[b.type].storage;
      if (!st || b.state !== 'active') continue;
      const cap = st.perTile ? st.capacity * b.w * b.h : st.capacity;
      let used = 0;
      for (const k in b.inventory) used += b.inventory[k as ResourceType] ?? 0;
      if (st.kinds.includes('stockpile') && !st.kinds.includes('barn')) {
        su += used;
        sc += cap;
      } else {
        bu += used;
        bc += cap;
      }
    }
    return { stockpileUsed: su, stockpileCap: sc, barnUsed: bu, barnCap: bc };
  }

  // ---- commands ----
  setWorkers(id: number, n: number): void {
    const b = this.getBuilding(id);
    if (b) b.workersDesired = Math.max(0, Math.min(BUILDINGS[b.type].maxWorkers, n));
  }
  setBuilders(n: number): void {
    this.state.buildersDesired = Math.max(0, n);
  }
  setCrop(id: number, choice: CropType | OrchardType | LivestockType): void {
    const b = this.getBuilding(id);
    if (!b) return;
    if (b.type === 'cropField') b.crop = choice as CropType;
    if (b.type === 'orchard') b.orchard = { type: choice as OrchardType, maturity: 0, fruit: 0 };
    if (b.type === 'pasture') b.livestock = { type: choice as LivestockType, count: 2, breed: 0, product: 0 };
  }
  setRecipe(id: number, r: number): void {
    const b = this.getBuilding(id);
    if (b) b.recipe = r;
  }
  setPaused(id: number, p: boolean): void {
    const b = this.getBuilding(id);
    if (b) b.paused = p;
  }
  setPriority(id: number, p: boolean): void {
    const b = this.getBuilding(id);
    if (b) b.priority = p;
  }
  demolish(id: number): void {
    const b = this.getBuilding(id);
    if (!b) return;
    if (b.state === 'active') b.state = 'demolishing';
    else {
      this.state.buildings = this.state.buildings.filter((x) => x !== b);
      this.buildingById.delete(id);
    }
  }
  executeTrade(give: Inventory, take: TradeTake[]): TradeResult {
    const m = this.state.trade.merchant;
    if (!m) return { ok: false, reason: 'No merchant' };
    let gv = 0;
    for (const k in give) gv += (give[k as ResourceType] ?? 0) * RESOURCES[k as ResourceType].value;
    let tv = 0;
    for (const t of take) tv += m.offers[t.offerIndex].price * t.amount;
    if (gv < tv) return { ok: false, reason: 'The merchant wants more for that.' };
    for (const t of take) m.offers[t.offerIndex].amount -= t.amount;
    return { ok: true };
  }
  requestMerchant(kind: GameState['trade']['requested']): void {
    this.state.trade.requested = kind;
  }
  respondToNomads(): void {
    this.state.nomads = null;
  }
  addMessage(text: string, severity: MessageSeverity, target?: GameMessage['target']): GameMessage {
    const s = this.state;
    const m: GameMessage = { id: this.newId(), time: s.time.elapsed, year: s.time.year, month: s.time.month, text, severity, target };
    s.messages.push(m);
    this.events.emit('message', m);
    return m;
  }
  update(): void {}
  step(): void {}
  save(): string {
    return '{}';
  }
}

export function asGame(m: MockGame): Game {
  return m as unknown as Game;
}
