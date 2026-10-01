/**
 * Forests (3 species), rock and iron deposits. OWNER: sim-world agent.
 * Tree variant: 0 = conifer, 1 = deciduous, 2 = birch. Rock/iron variant: shape seed 0..255.
 */
import { Feature, Terrain } from '../../core/types';
import type { GenContext } from './context';
import { START_HALF, quantile } from './context';
import { distanceTransform } from './grid';
import { clamp, smoothstep } from './noise';

export const SPECIES_CONIFER = 0;
export const SPECIES_DECIDUOUS = 1;
export const SPECIES_BIRCH = 2;

function tileAvgHeight(ctx: GenContext, x: number, z: number): number {
  const { CW } = ctx;
  const h = ctx.tiles.height;
  const c = z * CW + x;
  return (h[c] + h[c + 1] + h[c + CW] + h[c + CW + 1]) * 0.25;
}

/** Pick a tree species for tile (x, z) from clustered noise, mountain proximity and altitude. */
function pickSpecies(ctx: GenContext, x: number, z: number, dMount: number): number {
  const { rng } = ctx;
  const h = tileAvgHeight(ctx, x, z);
  // Conifers dominate near mountains and on high ground; mixed deciduous/birch woods in the lowlands.
  const pc = clamp(0.78 - (dMount - 3) / 16, 0.18, 0.82) + clamp((h - 1.8) * 0.2, 0, 0.2);
  const s1 = ctx.noise.species.noise(x / 17, z / 17) * 0.5 + 0.5 + (rng.next() - 0.5) * 0.2;
  if (s1 < pc) return SPECIES_CONIFER;
  const s2 = ctx.noise.species2.noise(x / 13, z / 13) + (rng.next() - 0.5) * 0.35;
  return s2 > 0.22 ? SPECIES_BIRCH : SPECIES_DECIDUOUS;
}

function randomGrowth(ctx: GenContext): number {
  const r = ctx.rng;
  return r.next() < 0.12 ? r.range(0.08, 0.5) : r.range(0.6, 1.0);
}

function setTree(ctx: GenContext, i: number, species: number, growth: number): void {
  const t = ctx.tiles;
  t.feature[i] = Feature.Tree;
  // Quantised to 1/64 so fresh saves compress well (growth becomes continuous once nature updates it).
  t.featureAmount[i] = Math.max(1 / 64, Math.round(growth * 64) / 64);
  t.variant[i] = species;
}

/** Noise-clustered forests over grass, sparse lone trees on meadows. */
export function plantForests(ctx: GenContext): void {
  const { W, H, N, tiles, params, rng } = ctx;
  const { terrain } = tiles;
  const nf = ctx.noise.forest;
  const nf2 = ctx.noise.forest2;
  const dens = new Float32Array(N);
  const grass: number[] = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (terrain[i] !== Terrain.Grass) continue;
      const d = 0.62 * nf.fbm01(x / 30, z / 30, 4) + 0.38 * nf2.fbm01(x / 9, z / 9, 2);
      dens[i] = d;
      grass.push(d);
    }
  }
  const thr = quantile(Float32Array.from(grass), 1 - params.forestCoverage * 0.95);
  const dMount = distanceTransform(W, H, (i) => terrain[i] === Terrain.Mountain);
  const dWater = distanceTransform(W, H, (i) => terrain[i] === Terrain.Water || terrain[i] === Terrain.DeepWater);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (terrain[i] !== Terrain.Grass) continue;
      let d = dens[i];
      if (dWater[i] < 2.5) d -= 0.05;
      let p: number;
      if (d > thr) p = 0.62 + 0.36 * smoothstep(thr, thr + 0.1, d);
      else if (d > thr - 0.04) p = 0.14;
      else p = 0.01;
      if (rng.next() >= p) continue;
      setTree(ctx, i, pickSpecies(ctx, x, z, dMount[i]), randomGrowth(ctx));
    }
  }
}

/**
 * Place a cluster of `count` rock/iron deposits around (cx, cz) (gaussian spread).
 * When `region` > 0, only tiles of that walkability region are used (requires tiles.region).
 */
export function placeCluster(ctx: GenContext, kind: Feature, cx: number, cz: number, count: number, spread: number, region = 0): number {
  const { W, H, rng, tiles } = ctx;
  let placed = 0;
  for (let a = 0; a < count * 6 && placed < count; a++) {
    const x = Math.round(cx + rng.gaussian() * spread);
    const z = Math.round(cz + rng.gaussian() * spread);
    if (x < 1 || z < 1 || x >= W - 1 || z >= H - 1) continue;
    const i = z * W + x;
    const t = tiles.terrain[i];
    if (t !== Terrain.Grass && t !== Terrain.Sand) continue;
    if (region > 0 && tiles.region[i] !== region) continue;
    if (tiles.feature[i] === Feature.Rock || tiles.feature[i] === Feature.Iron) continue;
    if (inStartSquare(ctx, x, z)) continue;
    tiles.feature[i] = kind;
    tiles.featureAmount[i] = rng.int(10, 40);
    tiles.variant[i] = rng.int(0, 255);
    placed++;
  }
  return placed;
}

/** Plant a roughly circular patch of (mostly mature) trees. */
export function plantPatch(ctx: GenContext, cx: number, cz: number, radius: number, region = 0): void {
  const { W, H, rng, tiles } = ctx;
  const dMount = distanceTransform(W, H, (i) => tiles.terrain[i] === Terrain.Mountain);
  const R = Math.ceil(radius);
  for (let z = cz - R; z <= cz + R; z++) {
    for (let x = cx - R; x <= cx + R; x++) {
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d > radius) continue;
      const i = z * W + x;
      if (tiles.terrain[i] !== Terrain.Grass || tiles.feature[i] !== Feature.None) continue;
      if (region > 0 && tiles.region[i] !== region) continue;
      if (inStartSquare(ctx, x, z)) continue;
      if (rng.next() > 0.9 - 0.4 * (d / radius)) continue;
      setTree(ctx, i, pickSpecies(ctx, x, z, dMount[i]), rng.range(0.65, 1));
    }
  }
}

function inStartSquare(ctx: GenContext, x: number, z: number): boolean {
  return Math.abs(x + 0.5 - ctx.startX) < START_HALF && Math.abs(z + 0.5 - ctx.startZ) < START_HALF;
}

/** Rock clusters (half at mountain feet) and iron clusters (mostly near mountains). */
export function placeRocksAndIron(ctx: GenContext): void {
  const { W, H, N, tiles, params, rng } = ctx;
  const { terrain } = tiles;
  const dMount = distanceTransform(W, H, (i) => terrain[i] === Terrain.Mountain);
  let hasMountains = false;
  for (let i = 0; i < N; i++) {
    if (terrain[i] === Terrain.Mountain) {
      hasMountains = true;
      break;
    }
  }
  const scale = N / 10000;
  const findSite = (pred: (i: number) => boolean): [number, number] | null => {
    for (let a = 0; a < 300; a++) {
      const x = rng.int(4, W - 5);
      const z = rng.int(4, H - 5);
      const i = z * W + x;
      const t = terrain[i];
      if (t !== Terrain.Grass && t !== Terrain.Sand) continue;
      if (pred(i)) return [x, z];
    }
    return null;
  };
  const rockCount = Math.round(params.rockClusters * scale * rng.range(0.85, 1.15));
  for (let k = 0; k < rockCount; k++) {
    const near = hasMountains && rng.chance(0.5);
    const site = findSite((i) => (near ? dMount[i] >= 1 && dMount[i] <= 7 : dMount[i] > 3));
    if (site) placeCluster(ctx, Feature.Rock, site[0], site[1], rng.int(3, 8), rng.range(1.3, 2.4));
  }
  const ironCount = Math.round(params.ironClusters * scale * rng.range(0.85, 1.15));
  for (let k = 0; k < ironCount; k++) {
    const near = hasMountains && rng.chance(0.8);
    const site = findSite((i) => (near ? dMount[i] >= 1 && dMount[i] <= 6 : true));
    if (site) placeCluster(ctx, Feature.Iron, site[0], site[1], rng.int(2, 5), rng.range(1.1, 1.8));
  }
}
