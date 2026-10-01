/**
 * Fake minimal game state for the render-entities sandbox: trees of every species & growth, rocks/iron (some marked),
 * citizens of all professions/ages/activities, deer, pastures with livestock, fields at all stages, orchards,
 * houses with chimneys and a burning building. Not shipped.
 */
import { EventBus } from '../../src/core/events';
import { Rng } from '../../src/core/rng';
import type {
  Activity, Animal, Building, BuildingType, Citizen, CropType, FieldTile, GameEvents, GameState, LivestockType,
  OrchardType, Profession, ResourceType,
} from '../../src/core/types';
import { Feature, Road, Terrain } from '../../src/core/types';
import type { Game } from '../../src/sim/game';

export interface Walker {
  id: number;
  cx: number;
  cz: number;
  r: number;
  w: number;
  a: number;
}

export interface FakeWorld {
  game: Game;
  state: GameState;
  walkers: Walker[];
  deerWalkers: Walker[];
  houses: { x: number; z: number; w: number; h: number; id: number; burning: number }[];
  step(dt: number): void;
}

export function createFakeWorld(opts: { stress?: boolean } = {}): FakeWorld {
  const W = opts.stress ? 160 : 96;
  const H = W;
  const rng = new Rng(1234);
  const height = new Float32Array((W + 1) * (H + 1));
  const riverX0 = W - 8;
  const riverX1 = W - 5;
  for (let z = 0; z <= H; z++) {
    for (let x = 0; x <= W; x++) {
      let h = 0.55 + 0.28 * Math.sin(x * 0.11) * Math.cos(z * 0.09) + 0.12 * Math.sin(z * 0.23 + 1);
      if (x >= riverX0 && x <= riverX1) h = -0.6;
      else if (x === riverX0 - 1 || x === riverX1 + 1) h = 0.15;
      height[z * (W + 1) + x] = h;
    }
  }
  const N = W * H;
  const tiles = {
    height,
    terrain: new Uint8Array(N),
    feature: new Uint8Array(N),
    featureAmount: new Float32Array(N),
    variant: new Uint8Array(N),
    road: new Uint8Array(N),
    building: new Int32Array(N).fill(-1),
    marked: new Uint8Array(N),
    region: new Int32Array(N).fill(1),
  };
  for (let z = 0; z < H; z++) {
    for (let x = riverX0; x < riverX1; x++) tiles.terrain[z * W + x] = Terrain.Water;
    tiles.terrain[z * W + riverX0 - 1] = Terrain.Sand;
    tiles.terrain[z * W + riverX1] = Terrain.Sand;
  }
  // Bridge across the river at z = 50.
  for (let x = riverX0 - 2; x <= riverX1 + 1; x++) tiles.road[50 * W + x] = x >= riverX0 && x < riverX1 ? Road.Bridge : Road.Dirt;

  const tree = (x: number, z: number, species: number, growth: number, marked = false) => {
    const i = z * W + x;
    tiles.feature[i] = Feature.Tree;
    tiles.featureAmount[i] = growth;
    tiles.variant[i] = species;
    tiles.marked[i] = marked ? 1 : 0;
  };
  // Species rows with growth ramping along x.
  for (let x = 4; x <= 36; x++) {
    const g = Math.min(1, 0.03 + (x - 4) / 30);
    for (let z = 4; z < 8; z++) tree(x, z, 0, g, x > 32 && (x + z) % 3 === 0);
    for (let z = 8; z < 12; z++) tree(x, z, 1, g, x > 32 && (x + z) % 3 === 0);
    for (let z = 12; z < 16; z++) tree(x, z, 2, g, x > 32 && (x + z) % 3 === 0);
  }
  // Dense mixed forest.
  for (let z = 18; z < 32; z++) {
    for (let x = 3; x < 38; x++) {
      if (rng.next() < 0.78) tree(x, z, Math.floor(rng.next() * 3), 0.65 + rng.next() * 0.35);
    }
  }
  // Rocks & iron with varying amounts.
  for (let z = 4; z < 15; z += 2) {
    for (let x = 42; x < 60; x += 2) {
      const i = z * W + x + (z % 4 === 0 ? 0 : 1);
      tiles.feature[i] = z >= 10 ? Feature.Iron : Feature.Rock;
      tiles.featureAmount[i] = 3 + ((x - 42) / 18) * 37;
      tiles.variant[i] = (x * 7 + z) & 255;
      tiles.marked[i] = x >= 56 ? 1 : 0;
    }
  }
  // Stress: fill the rest of a big map with forest (≈10k trees).
  if (opts.stress) {
    for (let z = 76; z < H - 4; z++) {
      for (let x = 4; x < W - 12; x++) if (rng.next() < 0.8) tree(x, z, Math.floor(rng.next() * 3), 0.5 + rng.next() * 0.5);
    }
  }

  const state = {
    version: 1,
    settings: { seed: 1, townName: 'Sandbox', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: true },
    W, H, tiles,
    time: { elapsed: 0, year: 1, month: 3, monthProgress: 0.5, dayTime: 0.45 },
    weather: { temperature: 15, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0.6, windStrength: 0.35 },
    citizens: [] as Citizen[],
    buildings: [] as Building[],
    animals: [] as Animal[],
    nextId: 1,
    unlocked: { crops: ['wheat', 'corn', 'potato', 'beans'], orchards: ['apple', 'pear', 'cherry'], livestock: ['sheep', 'cattle', 'chicken'] },
    buildersDesired: 2,
    trade: { merchant: null, nextArrival: 100, requested: null },
    nomads: null,
    nextNomads: 1000,
    messages: [],
    history: [],
    tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
    rngState: 1,
    rev: { terrain: 1, features: 1, roads: 1, buildings: 1, fields: 1 },
    unburied: 0,
    gameOver: false,
    tornado: null,
  } as unknown as GameState;

  const newId = () => state.nextId++;
  const buildingById = new Map<number, Building>();
  const citizenById = new Map<number, Citizen>();
  const animalById = new Map<number, Animal>();

  const addBuilding = (type: BuildingType, x: number, z: number, w: number, h: number, extra: Partial<Building> = {}): Building => {
    const b: Building = {
      id: newId(), type, x, z, w, h, rotation: 0, doorX: x + Math.floor(w / 2), doorZ: z + h, state: 'active', progress: 1,
      cost: {}, delivered: {}, incoming: {}, workRemaining: 0, priority: false, paused: false, workersDesired: 0,
      workerIds: [], residentIds: [], inventory: {}, reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0,
      smoking: false, producedThisYear: {}, producedLastYear: {}, builtAt: 0, ...extra,
    };
    state.buildings.push(b);
    buildingById.set(b.id, b);
    for (let zz = z; zz < z + h; zz++) for (let xx = x; xx < x + w; xx++) tiles.building[zz * W + xx] = b.id;
    return b;
  };

  // Fields at every stage (rows: plowed, sprout, young, growing, ripe, stubble).
  const crops: CropType[] = ['wheat', 'corn', 'potato', 'beans'];
  crops.forEach((crop, k) => {
    const fw = 8;
    const fh = 6;
    const tilesF: FieldTile[] = [];
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw; i++) {
        const jitter = i * 0.02;
        const row: FieldTile[] = [
          { stage: 1, growth: 0 },
          { stage: 2, growth: 0.1 + jitter },
          { stage: 2, growth: 0.4 + jitter },
          { stage: 2, growth: 0.75 + jitter },
          { stage: 3, growth: 1 },
          { stage: 4, growth: 0 },
        ];
        tilesF.push(row[j]);
      }
    }
    addBuilding('cropField', 4 + k * 10, 40, fw, fh, { crop, fieldTiles: tilesF });
  });
  // Orchards (maturity 1 / 0.65 / 0.3).
  const orchards: [OrchardType, number, number][] = [['apple', 1, 0.85], ['pear', 0.65, 0.6], ['cherry', 0.3, 0]];
  orchards.forEach(([type, maturity, fruit], k) => {
    const ft: FieldTile[] = [];
    for (let j = 0; j < 36; j++) ft.push({ stage: fruit > 0 ? (j % 7 === 0 ? 4 : 3) : 2, growth: 1 });
    addBuilding('orchard', 4 + k * 10, 50, 6, 6, { orchard: { type, maturity, fruit }, fieldTiles: ft });
  });
  // Pastures.
  const pastures: [LivestockType, number, number, number, number][] = [
    ['sheep', 4, 60, 11, 9], ['cattle', 17, 60, 12, 10], ['chicken', 31, 60, 7, 7],
  ];
  const pastureCounts = [12, 7, 16];
  pastures.forEach(([type, x, z, w, h], k) => {
    addBuilding('pasture', x, z, w, h, { livestock: { type, count: pastureCounts[k], breed: 0, product: 0 } });
  });

  // Houses with chimneys, a burning one.
  const houses: FakeWorld['houses'] = [];
  const housePos: [number, number, number][] = [[66, 16, 0], [71, 16, 0], [76, 16, 0], [66, 22, 0], [76, 23, 0.85]];
  for (const [x, z, burning] of housePos) {
    const b = addBuilding('woodenHouse', x, z, 3, 3, { fire: burning, smoking: burning === 0 });
    houses.push({ x, z, w: 3, h: 3, id: b.id, burning });
  }

  // Citizens.
  const professions: Profession[] = [
    'laborer', 'builder', 'farmer', 'herder', 'gatherer', 'hunter', 'fisherman', 'forester', 'woodcutter', 'stonecutter',
    'miner', 'blacksmith', 'tailor', 'herbalist', 'brewer', 'vendor', 'teacher', 'healer', 'priest', 'tavernkeeper', 'trader',
  ];
  const carryTypes: (ResourceType | null)[] = [null, null, 'log', 'stone', 'wheat', 'tool', 'firewood', 'fish', 'iron', null];
  const walkers: Walker[] = [];
  const mkCitizen = (x: number, z: number, profession: Profession, age: number, gender: 'M' | 'F', activity: Activity, heading: number, moving: boolean, carrying: ResourceType | null = null, sick = 0): Citizen => {
    const c: Citizen = {
      id: newId(), name: 'Sim', gender, age, lifespan: 80, spouseId: -1, motherId: -1, fatherId: -1, childIds: [],
      homeId: -1, workplaceId: -1, profession, food: 80, warmth: 90, health: 90, happiness: 60, education: 0, sick,
      dietMask: 0, dietTimers: [0, 0, 0, 0], toolWear: 100, coatWear: 100, x, z, heading, moving, activity,
      taskLabel: activity, carrying: carrying ? { type: carrying, amount: 8 } : null, task: null, path: null, pathIndex: 0,
      starveTime: 0, freezeTime: 0, bornAt: 0, grief: 0,
    };
    state.citizens.push(c);
    citizenById.set(c.id, c);
    return c;
  };
  // Walkers in circles around the plaza (all professions, ages, some carrying).
  for (let i = 0; i < 44; i++) {
    const ring = i % 4;
    const r = 2.5 + ring * 1.8;
    const a = (i / 44) * Math.PI * 2 * 3.3;
    const cx = 56;
    const cz = 30;
    const age = i % 9 === 0 ? 5 + (i % 4) : i % 11 === 0 ? 12 : i % 7 === 0 ? 66 : 20 + (i % 30);
    const prof: Profession = age < 10 ? 'child' : age < 14 ? 'student' : professions[i % professions.length];
    const c = mkCitizen(cx + Math.cos(a) * r, cz + Math.sin(a) * r, prof, age, i % 2 === 0 ? 'M' : 'F', age < 10 && i % 3 === 0 ? 'playing' : 'walking', 0, true, age >= 14 ? carryTypes[i % carryTypes.length] : null, i === 5 ? 0.8 : 0);
    walkers.push({ id: c.id, cx, cz, r, w: (ring % 2 === 0 ? 1 : -1) * (1.2 + (i % 3) * 0.2) / r, a });
  }
  // Stress: many more walkers spread over the map.
  if (opts.stress) {
    for (let i = 0; i < 150; i++) {
      const cx = 20 + (i % 10) * 12;
      const cz = 80 + Math.floor(i / 10) * 5;
      const r = 1.5 + (i % 5);
      const age = 8 + (i * 7) % 60;
      const c = mkCitizen(cx, cz, professions[i % professions.length], age, i % 2 ? 'F' : 'M', 'walking', 0, true, carryTypes[i % carryTypes.length]);
      walkers.push({ id: c.id, cx, cz, r, w: 1.3 / r, a: i });
    }
  }
  // Bridge crossers.
  for (let i = 0; i < 3; i++) {
    const c = mkCitizen(riverX0 - 2, 50.5, 'laborer', 30, i % 2 ? 'F' : 'M', 'walking', 0, true, i === 1 ? 'log' : null);
    walkers.push({ id: c.id, cx: (riverX0 + riverX1) / 2, cz: 50.5, r: 5 + i * 0.001, w: 0, a: i * 2 });
  }
  // Activity stations (standing).
  const stations: [Activity, Profession, number, number, ResourceType | null][] = [
    ['chopping', 'forester', 0.1, 0, null], ['chopping', 'laborer', 0.5, 1, null], ['mining', 'stonecutter', 0, 0, null], ['mining', 'miner', 0.3, 1, null],
    ['building', 'builder', 0, 0, null], ['building', 'builder', 0.6, 1, null], ['farming', 'farmer', 0, 0, null], ['farming', 'farmer', 0.4, 1, null],
    ['gathering', 'gatherer', 0, 1, null], ['fishing', 'fisherman', 0, 0, null], ['hunting', 'hunter', 0, 0, null], ['hauling', 'laborer', 0, 0, 'stone'],
    ['working', 'blacksmith', 0, 0, null], ['working', 'tailor', 0, 1, null], ['eating', 'laborer', 0, 1, null], ['warming', 'laborer', 0, 0, null],
    ['praying', 'priest', 0, 0, null], ['healing', 'healer', 0, 1, null], ['firefighting', 'laborer', 0, 0, null], ['sick', 'laborer', 0, 1, null],
    ['idle', 'laborer', 0, 0, null], ['idle', 'vendor', 0, 1, null], ['studying', 'student', 0, 1, null], ['playing', 'child', 0, 0, null],
  ];
  stations.forEach(([act, prof, _p, fem, carry], k) => {
    const x = 44 + (k % 8) * 1.4;
    const z = 36 + Math.floor(k / 8) * 1.6;
    const age = prof === 'child' ? 6 : prof === 'student' ? 12 : k === 20 ? 70 : 32;
    mkCitizen(x, z, prof, age, fem ? 'F' : 'M', act, Math.PI * 0.25, false, carry, act === 'sick' ? 0.9 : 0);
  });
  // Hidden checks: one inside a house footprint, one eating at a house door.
  mkCitizen(67.5, 17.5, 'laborer', 30, 'M', 'idle', 0, false);
  mkCitizen(67.5, 19.5, 'laborer', 30, 'F', 'eating', 0, false);

  // Deer herd: walkers + grazers + one hunted.
  const deerWalkers: Walker[] = [];
  for (let i = 0; i < 8; i++) {
    const a: Animal = { id: newId(), kind: 'deer', x: 50 + (i % 4) * 1.3, z: 68 + Math.floor(i / 4) * 1.5, heading: i, moving: false, herd: 1, huntedBy: i === 7 ? 99 : -1, wander: null };
    state.animals.push(a);
    animalById.set(a.id, a);
    if (i < 3) deerWalkers.push({ id: a.id, cx: 56, cz: 74, r: 3 + i, w: 0.35 / (1 + i * 0.3), a: i * 2 });
  }

  const events = new EventBus<GameEvents>();
  const game = {
    state, events, buildingById, citizenById, animalById, speed: 1,
    getBuilding: (id: number) => buildingById.get(id),
    getCitizen: (id: number) => citizenById.get(id),
  } as unknown as Game;

  let t = 0;
  const step = (dt: number) => {
    t += dt;
    state.time.elapsed += dt;
    for (const w of walkers) {
      const c = citizenById.get(w.id)!;
      if (w.w === 0) {
        // Bridge crossers: back and forth along x.
        const u = (Math.sin(t * 0.25 + w.a) + 1) / 2;
        const nx = w.cx - w.r + u * w.r * 2;
        c.heading = nx >= c.x ? 0 : Math.PI;
        c.x = nx;
        c.moving = true;
        continue;
      }
      w.a += w.w * dt;
      c.x = w.cx + Math.cos(w.a) * w.r;
      c.z = w.cz + Math.sin(w.a) * w.r;
      c.heading = w.a + (w.w > 0 ? Math.PI / 2 : -Math.PI / 2);
      c.moving = true;
    }
    for (const w of deerWalkers) {
      const a = animalById.get(w.id)!;
      w.a += w.w * dt;
      const walking = Math.sin(t * 0.2 + w.r) > -0.2;
      if (walking) {
        a.x = w.cx + Math.cos(w.a) * w.r;
        a.z = w.cz + Math.sin(w.a) * w.r;
        a.heading = w.a + Math.PI / 2;
      } else {
        w.a -= w.w * dt;
      }
      a.moving = walking;
    }
  };

  return { game, state, walkers, deerWalkers, houses, step };
}
