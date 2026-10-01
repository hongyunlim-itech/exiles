/**
 * Terrain relief: base land heights, mountain masks, final corner heights and terrain classification.
 * OWNER: sim-world agent.
 */
import { Terrain } from '../../core/types';
import type { GenContext } from './context';
import {
  CORNER_LAND, CORNER_MOUNTAIN, CORNER_SHORE, CORNER_WATER, DEEP_WATER_HEIGHT, SHORE_HEIGHT, START_HALF, WATER_NONE,
  quantile, quantize,
} from './context';
import { distanceTransform, labelComponents } from './grid';
import { lerp, smoothstep } from './noise';

/** Rolling base land (corner heights), before water and mountains are applied. */
export function generateBaseLand(ctx: GenContext): void {
  const { CW, CH, land, params } = ctx;
  const nb = ctx.noise.base;
  const nd = ctx.noise.detail;
  const s = params.landScale;
  for (let z = 0; z < CH; z++) {
    for (let x = 0; x < CW; x++) {
      const v = nb.fbm01(x / s, z / s, 4, 2, 0.5);
      // Slightly flatten the lowlands (more buildable plains) while keeping hills.
      const shaped = v * v * (1.6 - 0.6 * v);
      land[z * CW + x] = 0.45 + params.landAmp * shaped + 0.1 * nd.noise(x / 7.5, z / 7.5);
    }
  }
}

/** Mountain ranges (ridged noise, coverage-controlled) plus a noisy mountain ring along the map border. */
export function generateMountains(ctx: GenContext): void {
  const { W, H, N, mountain, noMountain, water, params } = ctx;
  const nm = ctx.noise.mountain;
  const nm2 = ctx.noise.mountain2;
  const ne = ctx.noise.edge;
  const s = params.mountainScale;
  const v = new Float32Array(N);
  const interior: number[] = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      // Domain-warped fBm gives massive, irregular ranges; a ridged term adds spurs along crests.
      const wx = x + 14 * nm2.noise(x / 45, z / 45);
      const wz = z + 14 * nm2.noise(x / 45 + 31.4, z / 45 - 17.2);
      const f = nm.fbm01(wx / s, wz / s, 4, 2, 0.5);
      const r = nm2.ridged(wx / (s * 0.75), wz / (s * 0.75), 3, 2, 0.5);
      v[i] = 0.74 * f + 0.26 * r;
      if (!noMountain[i]) interior.push(v[i]);
    }
  }
  const thr = params.mountainCoverage > 0 ? quantile(Float32Array.from(interior), 1 - params.mountainCoverage) : Infinity;
  const edgeScale = Math.sqrt(W / 160);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (noMountain[i] || water[i] !== WATER_NONE) {
        mountain[i] = 0;
        continue;
      }
      const dEdge = Math.min(x + 0.5, z + 0.5, W - x - 0.5, H - z - 0.5);
      const thick = (params.edgeThickness + params.edgeVariation * ne.fbm(x / 26, z / 26, 2)) * edgeScale;
      mountain[i] = v[i] > thr || dEdge < thick ? 1 : 0;
    }
  }
}

/** Smooth mountain shapes, drop tiny blobs and fill small enclosed land pockets. */
export function cleanupMountains(ctx: GenContext): void {
  const { W, H, N, mountain, noMountain, water } = ctx;
  const next = new Uint8Array(N);
  for (let it = 0; it < 3; it++) {
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        let c = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const xx = x + dx;
            const zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= W || zz >= H) c++;
            else c += mountain[zz * W + xx];
          }
        }
        let m = mountain[i];
        if (c >= 5) m = 1;
        else if (c <= 2) m = 0;
        if (noMountain[i] || water[i] !== WATER_NONE) m = 0;
        next[i] = m;
      }
    }
    mountain.set(next);
  }
  // Remove small isolated mountain blobs.
  const mc = labelComponents(W, H, (i) => mountain[i] === 1);
  for (let i = 0; i < N; i++) {
    const l = mc.labels[i];
    if (l && mc.sizes[l] < 14) mountain[i] = 0;
  }
  // Fill small land pockets fully enclosed by mountains (unreachable & ugly).
  const lc = labelComponents(W, H, (i) => mountain[i] === 0 && water[i] === WATER_NONE);
  const touchesWater = new Uint8Array(lc.sizes.length);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const l = lc.labels[i];
      if (!l) continue;
      if ((x > 0 && water[i - 1]) || (x < W - 1 && water[i + 1]) || (z > 0 && water[i - W]) || (z < H - 1 && water[i + W])) {
        touchesWater[l] = 1;
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const l = lc.labels[i];
    if (l && lc.sizes[l] < 70 && !touchesWater[l] && !noMountain[i]) mountain[i] = 1;
  }
}

/** Corner (cx, cz) tile-neighbourhood summary: counts of water / mountain / in-bounds tiles. */
function classifyCorners(ctx: GenContext, capOut: Float32Array): void {
  const { W, H, CW, CH, water, waterCap, mountain, cornerType } = ctx;
  for (let cz = 0; cz < CH; cz++) {
    for (let cx = 0; cx < CW; cx++) {
      let nIn = 0;
      let nWater = 0;
      let nMount = 0;
      let cap = 0;
      for (let dz = -1; dz <= 0; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= H) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= W) continue;
          const i = z * W + x;
          nIn++;
          if (water[i] !== WATER_NONE) {
            nWater++;
            if (waterCap[i] > cap) cap = waterCap[i];
          } else if (mountain[i]) nMount++;
        }
      }
      const c = cz * CW + cx;
      capOut[c] = cap;
      if (nWater > 0) cornerType[c] = nWater === nIn ? CORNER_WATER : CORNER_SHORE;
      else if (nMount > 0 && nMount === nIn) cornerType[c] = CORNER_MOUNTAIN;
      else cornerType[c] = CORNER_LAND;
    }
  }
}

/**
 * Compute final corner heights from the land base + water/mountain masks.
 * Guarantees: water tiles average below WATER_LEVEL, land tiles above; mountain tiles rise steeply.
 */
export function computeHeights(ctx: GenContext): void {
  const { W, H, CW, CH, water, mountain, cornerType, land, params } = ctx;
  const height = ctx.tiles.height;
  const NC = CW * CH;
  const cap = new Float32Array(NC);

  // Iterate until every water tile has a true water corner and every mountain tile an interior corner.
  for (let pass = 0; pass < 6; pass++) {
    classifyCorners(ctx, cap);
    let changed = false;
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        const c00 = z * CW + x;
        const c10 = c00 + 1;
        const c01 = c00 + CW;
        const c11 = c01 + 1;
        if (water[i] !== WATER_NONE) {
          if (cornerType[c00] !== CORNER_WATER && cornerType[c10] !== CORNER_WATER && cornerType[c01] !== CORNER_WATER && cornerType[c11] !== CORNER_WATER) {
            water[i] = WATER_NONE;
            ctx.waterCap[i] = 0;
            changed = true;
          }
        } else if (mountain[i]) {
          if (cornerType[c00] !== CORNER_MOUNTAIN && cornerType[c10] !== CORNER_MOUNTAIN && cornerType[c01] !== CORNER_MOUNTAIN && cornerType[c11] !== CORNER_MOUNTAIN) {
            mountain[i] = 0;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  const dShore = distanceTransform(CW, CH, (c) => cornerType[c] !== CORNER_WATER);
  const dWater = distanceTransform(CW, CH, (c) => cornerType[c] === CORNER_WATER || cornerType[c] === CORNER_SHORE, ctx.cornerWaterDist);
  const dMount = distanceTransform(CW, CH, (c) => cornerType[c] !== CORNER_MOUNTAIN);
  const touchesMountain = new Uint8Array(NC);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!mountain[z * W + x]) continue;
      const c = z * CW + x;
      touchesMountain[c] = touchesMountain[c + 1] = touchesMountain[c + CW] = touchesMountain[c + CW + 1] = 1;
    }
  }
  const dMountNear = distanceTransform(CW, CH, (c) => touchesMountain[c] === 1);
  const nr = ctx.noise.rock;
  const FOOT = 0.35;
  const EDGE = 8;

  for (let cz = 0; cz < CH; cz++) {
    for (let cx = 0; cx < CW; cx++) {
      const c = cz * CW + cx;
      const L = land[c];
      let h: number;
      switch (cornerType[c]) {
        case CORNER_WATER: {
          const depth = Math.min(cap[c], 0.3 + 0.3 * Math.max(0, dShore[c] - 1));
          h = -depth;
          break;
        }
        case CORNER_SHORE:
          h = SHORE_HEIGHT;
          break;
        case CORNER_MOUNTAIN: {
          const d = dMount[c];
          const ridge = nr.ridged(cx / 14, cz / 14, 3);
          const rise = (1.05 + 1.4 * Math.pow(d, 0.9)) * (0.78 + 0.5 * ridge) + 0.28 * nr.noise(cx / 2.7, cz / 2.7);
          h = L + FOOT + Math.min(16, Math.max(0.9, rise * params.mountainHeight));
          break;
        }
        default: {
          const dw = dWater[c];
          const bank = smoothstep(0.5, params.bankWidth, dw);
          h = lerp(0.1 + 0.05 * Math.min(dw, 3), L, bank);
          h += FOOT * (1 - smoothstep(0, 7, dMountNear[c]));
          const dEdge = Math.min(cx, cz, CW - 1 - cx, CH - 1 - cz);
          if (dEdge < EDGE) {
            const t = (EDGE - dEdge) / EDGE;
            h += 0.9 * t * t * smoothstep(1, 4, dw);
          }
          if (h < 0.1) h = 0.1;
          break;
        }
      }
      height[c] = quantize(h);
    }
  }
}

/** Flatten the start area (land corners only) towards its mean height, with a soft falloff. */
export function flattenStartArea(ctx: GenContext): void {
  const { CW, CH, cornerType, startX, startZ } = ctx;
  const height = ctx.tiles.height;
  const half = START_HALF + 1;
  const FALL = 6;
  let sum = 0;
  let n = 0;
  for (let cz = startZ - half; cz <= startZ + half; cz++) {
    for (let cx = startX - half; cx <= startX + half; cx++) {
      if (cx < 0 || cz < 0 || cx >= CW || cz >= CH) continue;
      const c = cz * CW + cx;
      if (cornerType[c] !== CORNER_LAND) continue;
      sum += height[c];
      n++;
    }
  }
  if (n === 0) return;
  const target = Math.max(0.3, sum / n);
  const R = half + FALL;
  for (let cz = startZ - R; cz <= startZ + R; cz++) {
    for (let cx = startX - R; cx <= startX + R; cx++) {
      if (cx < 0 || cz < 0 || cx >= CW || cz >= CH) continue;
      const c = cz * CW + cx;
      if (cornerType[c] !== CORNER_LAND) continue;
      const dx = Math.max(0, Math.abs(cx - startX) - half);
      const dz = Math.max(0, Math.abs(cz - startZ) - half);
      // Fade out near shores so banks keep their natural slope down to the water.
      const w = (1 - smoothstep(0, FALL, Math.hypot(dx, dz))) * smoothstep(0.5, 4, ctx.cornerWaterDist[c]);
      if (w <= 0) continue;
      const flat = target + (height[c] - target) * 0.12;
      height[c] = quantize(Math.max(0.1, lerp(height[c], flat, w)));
    }
  }
}

/** Assign tiles.terrain from masks + final heights (Water / DeepWater / Mountain / Sand / Grass). */
export function classifyTerrain(ctx: GenContext): void {
  const { W, H, CW, water, mountain, params } = ctx;
  const { height, terrain } = ctx.tiles;
  const ns = ctx.noise.sand;
  const dW = distanceTransform(W, H, (i) => water[i] !== WATER_NONE);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const c = z * CW + x;
      const avg = (height[c] + height[c + 1] + height[c + CW] + height[c + CW + 1]) * 0.25;
      if (water[i] !== WATER_NONE) {
        terrain[i] = avg < DEEP_WATER_HEIGHT ? Terrain.DeepWater : Terrain.Water;
      } else if (mountain[i]) {
        terrain[i] = Terrain.Mountain;
      } else {
        const sn = ns.fbm(x / 9, z / 9, 2) + (params.sandiness - 0.4);
        const d = dW[i];
        const sandy = avg < 0.7 && ((d <= 1.5 && sn > -0.45) || (d <= 2.5 && sn > 0.1) || (d <= 3.5 && sn > 0.45));
        terrain[i] = sandy ? Terrain.Sand : Terrain.Grass;
      }
    }
  }
}

/** Debug/test helper: tiles whose terrain disagrees with their average height (should be none). */
export function heightConsistencyErrors(ctx: { W: number; H: number; tiles: { height: Float32Array; terrain: Uint8Array } }): number {
  const { W, H } = ctx;
  const CW = W + 1;
  const { height, terrain } = ctx.tiles;
  let bad = 0;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const c = z * CW + x;
      const avg = (height[c] + height[c + 1] + height[c + CW] + height[c + CW + 1]) * 0.25;
      const t = terrain[z * W + x];
      const isWater = t === Terrain.Water || t === Terrain.DeepWater;
      if (isWater ? avg >= 0 : avg <= 0) bad++;
    }
  }
  return bad;
}

