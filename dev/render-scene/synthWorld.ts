/**
 * Synthetic world + fake town for the render-scene sandbox (used when sim-world's generator is unavailable).
 * Rolling hills, a winding river, a lake, mountain ridges near the edges, sand beaches, forests, rocks/iron,
 * and a small town with every overlay type (dirt/stone roads, bridge, pads, field stages, orchard, pasture,
 * cemetery, quarry, ruin, clearing).
 */
import { hash2 } from '../../src/core/rng';
import type { Building, BuildingState, BuildingType, FieldTile, GameState, TileData } from '../../src/core/types';
import { Feature, Road, Terrain } from '../../src/core/types';

function vnoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  let tx = x - x0;
  let tz = z - z0;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

function fbm(x: number, z: number, seed: number, oct = 5): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    v += a * vnoise(x * f, z * f, seed + o * 31);
    norm += a;
    a *= 0.5;
    f *= 2.02;
  }
  return v / norm;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface SynthOptions {
  W?: number;
  seed?: number;
}

export function synthTiles(opts: SynthOptions = {}): { W: number; H: number; tiles: TileData; startX: number; startZ: number } {
  const W = opts.W ?? 160;
  const H = W;
  const seed = opts.seed ?? 1234;
  const W1 = W + 1;
  const n = W * H;
  const height = new Float32Array(W1 * (H + 1));
  const startX = Math.round(W * 0.42);
  const startZ = Math.round(H * 0.5);
  const riverX = (z: number) => W * 0.66 + Math.sin(z * 0.045) * 9 + Math.sin(z * 0.11 + 1.3) * 3;
  const lake = { x: W * 0.2, z: H * 0.78, r: 13 };

  for (let z = 0; z <= H; z++) {
    for (let x = 0; x <= W; x++) {
      let h = 0.9 + (fbm(x * 0.025, z * 0.025, seed) - 0.5) * 5 + (fbm(x * 0.09, z * 0.09, seed + 7, 3) - 0.5) * 0.9;
      // edges & a ridge rise into mountains
      const edge = Math.min(x, z, W - x, H - z);
      const ridge = smooth(0.52, 0.7, fbm(x * 0.03 + 50, z * 0.03, seed + 99));
      const nearEdge = smooth(18, 2, edge);
      const mtn = Math.max(nearEdge * (0.6 + 0.8 * fbm(x * 0.06, z * 0.06, seed + 5)), ridge * (x < W * 0.3 || z < H * 0.25 ? 1 : 0.2));
      h += mtn * 11 * (0.7 + 0.6 * fbm(x * 0.12, z * 0.12, seed + 11, 3));
      // river
      const dr = Math.abs(x - riverX(z));
      if (dr < 7) h = Math.min(h, -1.1 + dr * 0.28 + Math.max(0, dr - 2.5) * 0.35);
      // lake
      const dl = Math.hypot(x - lake.x, z - lake.z);
      if (dl < lake.r + 5) h = Math.min(h, -2.6 + Math.pow(dl / lake.r, 2) * 2.9);
      // flat town area
      const dt = Math.max(Math.abs(x - startX), Math.abs(z - startZ));
      const flat = smooth(22, 12, dt);
      h = h * (1 - flat) + 0.9 * flat + (flat > 0 ? (fbm(x * 0.2, z * 0.2, seed + 3, 2) - 0.5) * 0.15 * flat : 0);
      height[z * W1 + x] = h;
    }
  }

  const terrain = new Uint8Array(n);
  const feature = new Uint8Array(n);
  const featureAmount = new Float32Array(n);
  const variant = new Uint8Array(n);
  const tileH = (x: number, z: number) =>
    (height[z * W1 + x] + height[z * W1 + x + 1] + height[(z + 1) * W1 + x] + height[(z + 1) * W1 + x + 1]) * 0.25;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const h = tileH(x, z);
      const a = height[z * W1 + x], b = height[z * W1 + x + 1], c = height[(z + 1) * W1 + x], d = height[(z + 1) * W1 + x + 1];
      const slope = Math.max(a, b, c, d) - Math.min(a, b, c, d);
      if (h < -1.5) terrain[i] = Terrain.DeepWater;
      else if (h < 0) terrain[i] = Terrain.Water;
      else if (h > 5.5 || slope > 1.6) terrain[i] = Terrain.Mountain;
      else terrain[i] = Terrain.Grass;
    }
  }
  // sand beaches
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (terrain[i] !== Terrain.Grass) continue;
      let wet = false;
      for (let dz = -2; dz <= 2 && !wet; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
          const t = terrain[zz * W + xx];
          if (t === Terrain.Water || t === Terrain.DeepWater) { wet = true; break; }
        }
      }
      if (wet && tileH(x, z) < 0.55 && hash2(x, z, seed + 77) < 0.85) terrain[i] = Terrain.Sand;
    }
  }
  // forests, rocks, iron
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (terrain[i] !== Terrain.Grass) continue;
      const dt = Math.max(Math.abs(x - startX), Math.abs(z - startZ));
      if (dt < 13) continue;
      const f = fbm(x * 0.05, z * 0.05, seed + 17);
      const r = hash2(x, z, seed + 19);
      if (f > 0.52 && r < (f - 0.45) * 2.2) {
        feature[i] = Feature.Tree;
        featureAmount[i] = r < 0.08 ? 0.2 + r * 5 : 0.6 + hash2(x, z, 3) * 0.4;
        const nearM = tileH(x, z) > 2.5;
        variant[i] = nearM ? 0 : (hash2(x, z, 5) < 0.6 ? 1 : 2);
      } else if (r > 0.992) {
        feature[i] = Feature.Rock;
        featureAmount[i] = 20;
      } else if (r > 0.986 && tileH(x, z) > 2) {
        feature[i] = Feature.Iron;
        featureAmount[i] = 20;
      }
    }
  }
  const tiles: TileData = {
    height, terrain, feature, featureAmount, variant,
    road: new Uint8Array(n),
    building: new Int32Array(n).fill(-1),
    marked: new Uint8Array(n),
    region: new Int32Array(n),
  };
  return { W, H, tiles, startX, startZ };
}

let nextId = 1;

function mkBuilding(type: BuildingType, x: number, z: number, w: number, h: number, state: BuildingState = 'active', extra: Partial<Building> = {}): Building {
  return {
    id: nextId++, type, x, z, w, h, rotation: 0, doorX: x + (w >> 1), doorZ: z + h, state, progress: state === 'active' ? 1 : 0.5,
    cost: {}, delivered: {}, incoming: {}, workRemaining: 0, priority: false, paused: false, workersDesired: 0, workerIds: [],
    residentIds: [], inventory: {}, reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0, smoking: false,
    producedThisYear: {}, producedLastYear: {}, builtAt: 0, ...extra,
  };
}

/** Flatten a footprint to its average height (like the sim does on placement). */
function flatten(t: TileData, W: number, b: Building): void {
  const W1 = W + 1;
  let s = 0, n = 0;
  for (let z = b.z; z <= b.z + b.h; z++) for (let x = b.x; x <= b.x + b.w; x++) { s += t.height[z * W1 + x]; n++; }
  const avg = s / n;
  for (let z = b.z; z <= b.z + b.h; z++) for (let x = b.x; x <= b.x + b.w; x++) t.height[z * W1 + x] = avg;
}

export function synthState(opts: SynthOptions = {}): GameState {
  const { W, H, tiles, startX, startZ } = synthTiles(opts);
  nextId = 1;
  const buildings: Building[] = [];
  const sx = startX;
  const sz = startZ;
  const add = (b: Building, flat = true) => {
    buildings.push(b);
    for (let z = b.z; z < b.z + b.h; z++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = z * W + x;
        tiles.building[i] = b.id;
        tiles.feature[i] = Feature.None;
      }
    }
    if (flat) flatten(tiles, W, b);
  };
  // roads first so buildings sit beside them
  const road = (x0: number, z0: number, x1: number, z1: number, kind: Road) => {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        const i = z * W + x;
        const t = tiles.terrain[i];
        tiles.feature[i] = Feature.None;
        tiles.road[i] = t === Terrain.Water ? Road.Bridge : t === Terrain.DeepWater ? Road.None : kind;
      }
    }
  };
  road(sx - 14, sz, sx + 16, sz, Road.Stone); // main street (E-W)
  road(sx, sz - 14, sx, sz + 14, Road.Dirt); // N-S street
  road(sx + 16, sz, Math.round(W * 0.66) + 14, sz, Road.Dirt); // road to river + bridge
  road(sx - 10, sz + 7, sx + 12, sz + 7, Road.Dirt);

  // houses north of main street
  for (let k = 0; k < 4; k++) add(mkBuilding('woodenHouse', sx - 12 + k * 4, sz - 4, 3, 3));
  add(mkBuilding('stoneHouse', sx + 2, sz - 4, 3, 3));
  add(mkBuilding('woodenHouse', sx + 6, sz - 4, 3, 3, 'construction'));
  add(mkBuilding('woodenHouse', sx + 10, sz - 4, 3, 3, 'clearing'), false);
  add(mkBuilding('well', sx + 2, sz + 2, 2, 2));
  add(mkBuilding('stockpile', sx - 12, sz + 1, 6, 5));
  add(mkBuilding('storageBarn', sx - 5, sz + 1, 4, 5));
  add(mkBuilding('townHall', sx + 5, sz + 1, 5, 6, 'ruin'));
  // fields south
  const fw = 10, fh = 8;
  const ft: FieldTile[] = [];
  for (let z = 0; z < fh; z++) for (let x = 0; x < fw; x++) ft.push({ stage: x < 2 ? 0 : x < 5 ? 1 : x < 8 ? 3 : 4, growth: 0.5 });
  add(mkBuilding('cropField', sx - 12, sz + 9, fw, fh, 'active', { crop: 'wheat', fieldTiles: ft }));
  add(mkBuilding('orchard', sx + 1, sz + 9, 8, 7, 'active', { orchard: { type: 'apple', maturity: 1, fruit: 0 } }));
  add(mkBuilding('pasture', sx - 12, sz - 18, 11, 9, 'active', { livestock: { type: 'sheep', count: 4, breed: 0, product: 0 } }));
  add(mkBuilding('cemetery', sx + 2, sz - 13, 6, 5, 'active', { graves: 3 }));
  add(mkBuilding('quarry', sx + 11, sz - 16, 8, 8));

  const state: GameState = {
    version: 1,
    settings: { seed: opts.seed ?? 1234, townName: 'Sandbox', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false },
    W, H, tiles,
    time: { elapsed: 0, year: 1, month: 4, monthProgress: 0.5, dayTime: 0.45 },
    weather: { temperature: 18, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0.6, windStrength: 0.3 },
    citizens: [], buildings, animals: [], nextId,
    unlocked: { crops: ['wheat'], orchards: ['apple'], livestock: ['sheep'] },
    buildersDesired: 2,
    trade: { merchant: null, nextArrival: 100, requested: null },
    nomads: null, nextNomads: 100, messages: [], history: [],
    tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
    rngState: 1, rev: { terrain: 0, features: 0, roads: 0, buildings: 0, fields: 0 },
    unburied: 0, gameOver: false, tornado: null,
  };
  return state;
}
