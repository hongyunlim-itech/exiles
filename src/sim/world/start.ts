/**
 * Start location selection & guarantees (flat clear grass with forest, stone, iron and water nearby).
 * OWNER: sim-world agent.
 */
import { Feature, Terrain } from '../../core/types';
import type { GenContext } from './context';
import { START_HALF, WATER_NONE } from './context';
import { distanceTransform, IntegralImage, labelComponents } from './grid';
import { addPond } from './hydrology';
import { plantPatch, placeCluster } from './vegetation';

/** Radius (tiles) within which the start must have forest, stone, iron and water. */
export const START_RESOURCE_RADIUS = 30;
/** Tiles around the start square that must be free of water and mountains (gentle banks, room to expand). */
export const START_MARGIN = 4;

/**
 * Choose the start tile on the (final) water/mountain masks, before heights are shaped.
 * Adds a pond when no water is close enough and clears any blocking tiles in the start square.
 */
export function chooseStart(ctx: GenContext): void {
  const { W, H, N, CW, water, mountain, land, rng } = ctx;
  const blocked = (i: number): boolean => water[i] !== WATER_NONE || mountain[i] === 1;
  const Ib = new IntegralImage(W, H, (i) => (blocked(i) ? 1 : 0));
  const tileH = (i: number): number => {
    const x = i % W;
    const z = (i - x) / W;
    const c = z * CW + x;
    return (land[c] + land[c + 1] + land[c + CW] + land[c + CW + 1]) * 0.25;
  };
  const Ih = new IntegralImage(W, H, tileH);
  const Ih2 = new IntegralImage(W, H, (i) => {
    const h = tileH(i);
    return h * h;
  });
  const dWater = distanceTransform(W, H, (i) => water[i] !== WATER_NONE);
  const dMount = distanceTransform(W, H, (i) => mountain[i] === 1);
  const comps = labelComponents(W, H, (i) => !blocked(i));
  let totalLand = 0;
  for (let i = 0; i < N; i++) if (!blocked(i)) totalLand++;

  const half = START_HALF;
  const margin = Math.max(half + 8, Math.round(W * 0.17));
  let best = -Infinity;
  let bx = W >> 1;
  let bz = H >> 1;
  let fbBest = Infinity;
  let fbx = W >> 1;
  let fbz = H >> 1;
  const area = (2 * half) * (2 * half);
  for (let z = margin; z < H - margin; z += 2) {
    for (let x = margin; x < W - margin; x += 2) {
      const i = z * W + x;
      const nb = Ib.sum(x - half - START_MARGIN, z - half - START_MARGIN, x + half + START_MARGIN, z + half + START_MARGIN);
      const distC = Math.hypot(x - W / 2, z - H / 2) / (W / 2);
      if (nb > 0) {
        const fb = nb + distC * 20;
        if (fb < fbBest) {
          fbBest = fb;
          fbx = x;
          fbz = z;
        }
        continue;
      }
      const label = comps.labels[i];
      if (!label || comps.sizes[label] < totalLand * 0.3) continue;
      let score = 0;
      const dw = dWater[i];
      if (dw > 26) score -= (dw - 26) * 3;
      else if (dw < 15) score -= (15 - dw) * 2;
      const dm = dMount[i];
      if (dm > 48) score -= (dm - 48) * 0.4;
      else if (dm < 18) score -= (18 - dm) * 1.2;
      const mean = Ih.sum(x - half, z - half, x + half, z + half) / area;
      const variance = Math.max(0, Ih2.sum(x - half, z - half, x + half, z + half) / area - mean * mean);
      score -= Math.sqrt(variance) * 60;
      score -= distC * 30;
      // Some breathing room beyond the square.
      score -= Ib.sum(x - half - 6, z - half - 6, x + half + 6, z + half + 6) * 0.05;
      score += rng.next() * 2;
      if (score > best) {
        best = score;
        bx = x;
        bz = z;
      }
    }
  }
  if (best === -Infinity) {
    bx = fbx;
    bz = fbz;
    // Force the square (+ margin) clear (rare fallback).
    for (let z = bz - half - START_MARGIN; z < bz + half + START_MARGIN; z++) {
      for (let x = bx - half - START_MARGIN; x < bx + half + START_MARGIN; x++) {
        if (x < 0 || z < 0 || x >= W || z >= H) continue;
        const i = z * W + x;
        water[i] = WATER_NONE;
        ctx.waterCap[i] = 0;
        mountain[i] = 0;
      }
    }
  }
  ctx.startX = bx;
  ctx.startZ = bz;
  for (let z = bz - half - 3; z < bz + half + 3; z++) {
    for (let x = bx - half - 3; x < bx + half + 3; x++) {
      if (x >= 0 && z >= 0 && x < W && z < H) ctx.noMountain[z * W + x] = 1;
    }
  }

  // Guarantee water within reach: add a pond on the start's land if the nearest water is too far.
  if (dWater[bz * W + bx] > START_RESOURCE_RADIUS - 6) {
    const startLabel = comps.labels[bz * W + bx];
    const Iw = new IntegralImage(W, H, (i) => (water[i] !== WATER_NONE ? 1 : 0));
    // Progressively relax: (0) fully clear spot, (1) smaller pond, (2) carve the pond into mountains.
    for (let pass = 0; pass < 3; pass++) {
      const R = pass === 0 ? rng.range(4, 5.2) : rng.range(3.4, 4.2);
      const ext = Math.ceil(R * 1.6) + 1;
      let bestSpot: [number, number] | null = null;
      let bestH = Infinity;
      for (let a = 0; a < 240; a++) {
        const ang = rng.range(0, Math.PI * 2);
        const d = rng.range(half + 8, START_RESOURCE_RADIUS + 1);
        const px = Math.round(bx + Math.cos(ang) * d);
        const pz = Math.round(bz + Math.sin(ang) * d);
        if (px < ext + 4 || pz < ext + 4 || px >= W - ext - 4 || pz >= H - ext - 4) continue;
        // Keep the pond (and its banks) out of the start square + margin.
        const gap = Math.hypot(Math.max(0, Math.abs(px - bx) - half - START_MARGIN), Math.max(0, Math.abs(pz - bz) - half - START_MARGIN));
        if (gap < ext + 1) continue;
        if (comps.labels[pz * W + px] !== startLabel) continue;
        if (pass < 2 ? Ib.sum(px - ext, pz - ext, px + ext + 1, pz + ext + 1) > 0 : Iw.sum(px - ext, pz - ext, px + ext + 1, pz + ext + 1) > 0) continue;
        const h = land[pz * CW + px];
        if (h < bestH) {
          bestH = h;
          bestSpot = [px, pz];
        }
      }
      if (!bestSpot) continue;
      addPond(ctx, bestSpot[0] + 0.5, bestSpot[1] + 0.5, R);
      if (pass === 2) {
        // Clear mountains around the carved pond so it gets proper banks.
        for (let z = bestSpot[1] - ext - 3; z <= bestSpot[1] + ext + 3; z++) {
          for (let x = bestSpot[0] - ext - 3; x <= bestSpot[0] + ext + 3; x++) {
            if (x >= 0 && z >= 0 && x < W && z < H && ctx.noMountain[z * W + x]) mountain[z * W + x] = 0;
          }
        }
      }
      break;
    }
  }
}

/** Clear the start square of rocks/iron and (most) trees. */
export function clearStartArea(ctx: GenContext): void {
  const { W, H, startX, startZ, rng } = ctx;
  const { feature, featureAmount, variant } = ctx.tiles;
  const half = START_HALF;
  for (let z = startZ - half; z < startZ + half; z++) {
    for (let x = startX - half; x < startX + half; x++) {
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const i = z * W + x;
      const f = feature[i];
      if (f === Feature.None) continue;
      const d = Math.hypot(x + 0.5 - startX, z + 0.5 - startZ);
      const keep = f === Feature.Tree && d > 8 && rng.next() < 0.1;
      if (!keep) {
        feature[i] = Feature.None;
        featureAmount[i] = 0;
        variant[i] = 0;
      }
    }
  }
}

export interface StartResources {
  trees: number;
  rocks: number;
  iron: number;
  water: number;
}

/** Count reachable resources (same walkability region as the start) within START_RESOURCE_RADIUS. */
export function countStartResources(W: number, H: number, tiles: GenContext['tiles'], sx: number, sz: number): StartResources {
  const { feature, featureAmount, terrain, region } = tiles;
  const r0 = region[sz * W + sx];
  const R = START_RESOURCE_RADIUS;
  const res: StartResources = { trees: 0, rocks: 0, iron: 0, water: 0 };
  for (let z = Math.max(0, sz - R); z <= Math.min(H - 1, sz + R); z++) {
    for (let x = Math.max(0, sx - R); x <= Math.min(W - 1, sx + R); x++) {
      if (Math.hypot(x - sx, z - sz) > R) continue;
      const i = z * W + x;
      const t = terrain[i];
      if (t === Terrain.Water || t === Terrain.DeepWater) {
        // Reachable shore: a land neighbour in the start region.
        if ((x > 0 && region[i - 1] === r0) || (x < W - 1 && region[i + 1] === r0) || (z > 0 && region[i - W] === r0) || (z < H - 1 && region[i + W] === r0)) {
          res.water++;
        }
        continue;
      }
      if (region[i] !== r0) continue;
      const f = feature[i];
      if (f === Feature.Tree && featureAmount[i] >= 0.5) res.trees++;
      else if (f === Feature.Rock) res.rocks++;
      else if (f === Feature.Iron) res.iron++;
    }
  }
  return res;
}

/** Minimum reachable resources near the start that world generation guarantees. */
export const START_MIN = { trees: 90, rocks: 4, iron: 3, water: 1 };

/** Add forest / rock / iron clusters near the start when the natural distribution left it short. Requires regions. */
export function guaranteeStartResources(ctx: GenContext): void {
  const { W, H, startX: sx, startZ: sz, rng, tiles } = ctx;
  const r0 = tiles.region[sz * W + sx];
  const dMount = distanceTransform(W, H, (i) => tiles.terrain[i] === Terrain.Mountain);
  const findSite = (minD: number, maxD: number, pref: (i: number) => number): [number, number] | null => {
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let a = 0; a < 200; a++) {
      const ang = rng.range(0, Math.PI * 2);
      const d = rng.range(minD, maxD);
      const x = Math.round(sx + Math.cos(ang) * d);
      const z = Math.round(sz + Math.sin(ang) * d);
      if (x < 2 || z < 2 || x >= W - 2 || z >= H - 2) continue;
      if (Math.abs(x - sx) < START_HALF + 2 && Math.abs(z - sz) < START_HALF + 2) continue;
      const i = z * W + x;
      if (tiles.region[i] !== r0 || tiles.terrain[i] !== Terrain.Grass) continue;
      const s = pref(i) + rng.next();
      if (s > bestScore) {
        bestScore = s;
        best = [x, z];
      }
    }
    return best;
  };

  let res = countStartResources(W, H, tiles, sx, sz);
  for (let k = 0; k < 3 && res.trees < START_MIN.trees; k++) {
    const site = findSite(START_HALF + 5, START_RESOURCE_RADIUS - 6, (i) => (tiles.feature[i] === Feature.Tree ? 3 : 0));
    if (site) plantPatch(ctx, site[0], site[1], 6.5, r0);
    res = countStartResources(W, H, tiles, sx, sz);
  }
  for (let k = 0; k < 3 && res.rocks < START_MIN.rocks; k++) {
    const site = findSite(START_HALF + 3, START_RESOURCE_RADIUS - 4, (i) => -Math.abs(dMount[i] - 4) * 0.3);
    if (site) placeCluster(ctx, Feature.Rock, site[0], site[1], rng.int(5, 8), 1.8, r0);
    res = countStartResources(W, H, tiles, sx, sz);
  }
  for (let k = 0; k < 3 && res.iron < START_MIN.iron; k++) {
    const site = findSite(START_HALF + 5, START_RESOURCE_RADIUS - 3, (i) => -Math.abs(dMount[i] - 3) * 0.5);
    if (site) placeCluster(ctx, Feature.Iron, site[0], site[1], rng.int(3, 5), 1.5, r0);
    res = countStartResources(W, H, tiles, sx, sz);
  }
}
