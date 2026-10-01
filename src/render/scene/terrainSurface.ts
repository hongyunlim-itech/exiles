/**
 * Pure terrain surface classification: per-tile "natural" ground colour (terrain type, forest floor, shore, depth)
 * and per-tile overlay codes (roads, soil, packed earth, zones) with 4-neighbour edge masks.
 * No three.js — unit-testable. OWNER: render-scene.
 *
 * Overlay byte layout: (pattern << 4) | mask, where mask bit 0 = neighbour at z-1 (north) has the same overlay group,
 * bit 1 = x+1 (east), bit 2 = z+1 (south), bit 3 = x-1 (west). Open sides get soft, ragged edges in the shader.
 */
import { WATER_LEVEL } from '../../core/constants';
import { hash2 } from '../../core/rng';
import type { Building, BuildingType, GameState } from '../../core/types';
import { Feature, Road, Terrain } from '../../core/types';
import { PAL, clamp01, hexToRgb, smoothstep, type RGB } from './palette';

/** Overlay pattern ids (0..15). Keep in sync with the terrain shader & overlay palette. */
export const OV = {
  NONE: 0,
  DIRT_ROAD: 1,
  STONE_ROAD: 2,
  SOIL: 3,
  FURROW_X: 4,
  FURROW_Z: 5,
  STUBBLE_X: 6,
  STUBBLE_Z: 7,
  PACKED: 8,
  QUARRY: 9,
  PASTURE: 10,
  ORCHARD: 11,
  CEMETERY: 12,
  CHARRED: 13,
  TRODDEN: 14,
} as const;

export interface OverlayStyle {
  /** sRGB hex base colour. */
  color: number;
  /** 0..1 how much snow settles on it. */
  snow: number;
  /** 0..1 how much the seasonal grass tint applies. */
  grass: number;
  /** Width (tile fraction) of the soft edge on open sides; 0 = hard edge. */
  soft: number;
  /** Minimum coverage at an open edge (0 = fully fades into the ground). */
  edgeMin: number;
}

export const OVERLAY_STYLES: OverlayStyle[] = (() => {
  const s: OverlayStyle[] = [];
  const def = (id: number, st: OverlayStyle) => { s[id] = st; };
  for (let i = 0; i < 16; i++) s[i] = { color: 0x000000, snow: 1, grass: 0, soft: 0, edgeMin: 1 };
  def(OV.DIRT_ROAD, { color: PAL.dirtRoad, snow: 0.38, grass: 0, soft: 0.26, edgeMin: 0.15 });
  def(OV.STONE_ROAD, { color: PAL.stoneRoad, snow: 0.3, grass: 0, soft: 0.1, edgeMin: 0.35 });
  def(OV.SOIL, { color: PAL.soil, snow: 1, grass: 0, soft: 0.14, edgeMin: 0.25 });
  def(OV.FURROW_X, { color: PAL.soilPlowed, snow: 1, grass: 0, soft: 0.12, edgeMin: 0.3 });
  def(OV.FURROW_Z, { color: PAL.soilPlowed, snow: 1, grass: 0, soft: 0.12, edgeMin: 0.3 });
  def(OV.STUBBLE_X, { color: PAL.stubble, snow: 1, grass: 0, soft: 0.12, edgeMin: 0.3 });
  def(OV.STUBBLE_Z, { color: PAL.stubble, snow: 1, grass: 0, soft: 0.12, edgeMin: 0.3 });
  def(OV.PACKED, { color: PAL.packedEarth, snow: 0.75, grass: 0, soft: 0.3, edgeMin: 0.1 });
  def(OV.QUARRY, { color: PAL.quarry, snow: 0.8, grass: 0, soft: 0.3, edgeMin: 0.15 });
  def(OV.PASTURE, { color: PAL.pasture, snow: 1, grass: 0.85, soft: 0.3, edgeMin: 0.2 });
  def(OV.ORCHARD, { color: PAL.orchard, snow: 1, grass: 0.7, soft: 0.3, edgeMin: 0.2 });
  def(OV.CEMETERY, { color: PAL.cemetery, snow: 1, grass: 0.9, soft: 0.25, edgeMin: 0.25 });
  def(OV.CHARRED, { color: PAL.charred, snow: 0.6, grass: 0, soft: 0.35, edgeMin: 0.1 });
  def(OV.TRODDEN, { color: PAL.trodden, snow: 0.9, grass: 0.6, soft: 0.4, edgeMin: 0 });
  return s;
})();

/** Road overlay group id (all road kinds connect). Buildings use id + 1 (> 0). */
const GROUP_ROAD = -2;
const GROUP_NONE = 0;

/** Scratch buffers reused between overlay computations. */
export interface OverlayScratch {
  pattern: Uint8Array;
  group: Int32Array;
}

export function createOverlayScratch(n: number): OverlayScratch {
  return { pattern: new Uint8Array(n), group: new Int32Array(n) };
}

function buildingPattern(b: Building, lx: number, lz: number): number {
  const t: BuildingType = b.type;
  if (b.state === 'ruin') return OV.CHARRED;
  switch (t) {
    case 'cropField': {
      const alongX = b.w >= b.h;
      const ft = b.fieldTiles?.[lz * b.w + lx];
      const stage = ft ? ft.stage : 0;
      if (stage === 0) return OV.SOIL;
      if (stage === 4) return alongX ? OV.STUBBLE_X : OV.STUBBLE_Z;
      return alongX ? OV.FURROW_X : OV.FURROW_Z;
    }
    case 'orchard': return OV.ORCHARD;
    case 'pasture': return OV.PASTURE;
    case 'cemetery': return OV.CEMETERY;
    case 'stockpile': return OV.PACKED;
    case 'quarry': return b.state === 'clearing' ? OV.TRODDEN : OV.QUARRY;
    default:
      return b.state === 'clearing' ? OV.TRODDEN : OV.PACKED;
  }
}

/**
 * Compute the overlay byte for every tile into `out` (length W*H). Only land tiles get overlays
 * (bridges and water under docks keep their natural riverbed).
 */
export function computeOverlay(state: GameState, out: Uint8Array, scratch: OverlayScratch): void {
  const { W, H } = state;
  const t = state.tiles;
  const pat = scratch.pattern;
  const grp = scratch.group;
  pat.fill(0);
  grp.fill(GROUP_NONE);
  const n = W * H;
  for (let i = 0; i < n; i++) {
    const r = t.road[i];
    if (r === Road.Dirt || r === Road.Stone) {
      const ter = t.terrain[i];
      if (ter === Terrain.Grass || ter === Terrain.Sand || ter === Terrain.Mountain) {
        pat[i] = r === Road.Dirt ? OV.DIRT_ROAD : OV.STONE_ROAD;
      }
      grp[i] = GROUP_ROAD;
    } else if (r === Road.Bridge) {
      grp[i] = GROUP_ROAD;
    }
  }
  for (const b of state.buildings) {
    const gid = b.id + 1;
    for (let lz = 0; lz < b.h; lz++) {
      const z = b.z + lz;
      if (z < 0 || z >= H) continue;
      for (let lx = 0; lx < b.w; lx++) {
        const x = b.x + lx;
        if (x < 0 || x >= W) continue;
        const i = z * W + x;
        const ter = t.terrain[i];
        grp[i] = gid;
        if (ter === Terrain.Water || ter === Terrain.DeepWater) {
          pat[i] = 0;
          continue;
        }
        pat[i] = buildingPattern(b, lx, lz);
      }
    }
  }
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const p = pat[i];
      if (p === 0) {
        out[i] = 0;
        continue;
      }
      const g = grp[i];
      let mask = 0;
      if (z === 0 || grp[i - W] === g) mask |= 1;
      if (x === W - 1 || grp[i + 1] === g) mask |= 2;
      if (z === H - 1 || grp[i + W] === g) mask |= 4;
      if (x === 0 || grp[i - 1] === g) mask |= 8;
      out[i] = (p << 4) | mask;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Natural ground colour
// ---------------------------------------------------------------------------------------------

/** Static per-tile noise for a world: [hash, low-frequency, mid-frequency] per tile, 0..1. */
export function computeTileNoise(W: number, H: number, seed: number): Float32Array {
  const out = new Float32Array(W * H * 3);
  const s = seed | 0;
  const vnoise = (x: number, z: number, cell: number, salt: number): number => {
    const fx = x / cell;
    const fz = z / cell;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    let tx = fx - x0;
    let tz = fz - z0;
    tx = tx * tx * (3 - 2 * tx);
    tz = tz * tz * (3 - 2 * tz);
    const a = hash2(x0, z0, s + salt);
    const b = hash2(x0 + 1, z0, s + salt);
    const c = hash2(x0, z0 + 1, s + salt);
    const d = hash2(x0 + 1, z0 + 1, s + salt);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const k = (z * W + x) * 3;
      out[k] = hash2(x, z, s + 101);
      out[k + 1] = vnoise(x, z, 17, 202) * 0.65 + vnoise(x, z, 7, 303) * 0.35;
      out[k + 2] = vnoise(x, z, 4, 404);
    }
  }
  return out;
}

const C = {
  grassLush: hexToRgb(PAL.grassLush),
  grassDry: hexToRgb(PAL.grassDry),
  forest: hexToRgb(PAL.forestFloor),
  stony: hexToRgb(PAL.stony),
  scrub: hexToRgb(PAL.scrub),
  riverbed: hexToRgb(PAL.riverbed),
  riverbedDeep: hexToRgb(PAL.riverbedDeep),
};

function mixInto(o: RGB, c: RGB, t: number): void {
  o[0] += (c[0] - o[0]) * t;
  o[1] += (c[1] - o[1]) * t;
  o[2] += (c[2] - o[2]) * t;
}

const _c: RGB = [0, 0, 0];

/**
 * Natural (un-overlaid) ground per tile.
 * rgbOut: W*H*3 bytes (sRGB) — the vegetation / riverbed layer.
 * matOut: W*H*4 bytes — grassiness (seasonal tint), snowiness, rockiness (rock layer), sandiness (sand layer).
 * Sand and rock are drawn by the shader with crisp, ragged thresholds on these (corner-interpolated) weights.
 * Returns the number of tiles that changed; their indices are written to `changedOut` (when given) up to its
 * capacity, so callers can update incrementally (count > capacity means "too many, do a full pass").
 */
export function computeNatural(
  state: GameState, noise: Float32Array, nearWater: Uint8Array, rgbOut: Uint8Array, matOut: Uint8Array,
  changedOut?: Int32Array,
): number {
  const n = state.W * state.H;
  const cap = changedOut ? changedOut.length : 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (naturalTile(state, i, noise, nearWater, rgbOut, matOut)) {
      if (changed < cap) changedOut![changed] = i;
      changed++;
    }
  }
  return changed;
}

/**
 * Recompute only the listed tiles. Compacts `tiles` in place to those that actually changed and returns their
 * count (feed the result to computeCornersForTiles / TerrainGeometry.syncNaturalTiles).
 */
export function computeNaturalTiles(
  state: GameState, noise: Float32Array, nearWater: Uint8Array, rgbOut: Uint8Array, matOut: Uint8Array,
  tiles: Int32Array, count: number,
): number {
  let k = 0;
  for (let j = 0; j < count; j++) {
    const i = tiles[j];
    if (naturalTile(state, i, noise, nearWater, rgbOut, matOut)) tiles[k++] = i;
  }
  return k;
}

/** Compute one tile's natural colour/material; returns true if its bytes changed. */
function naturalTile(
  state: GameState, i: number, noise: Float32Array, nearWater: Uint8Array, rgbOut: Uint8Array, matOut: Uint8Array,
): boolean {
  const W = state.W;
  const x = i % W;
  const z = (i / W) | 0;
  const t = state.tiles;
  const hgt = t.height;
  const W1 = W + 1;
  const n0 = noise[i * 3];
  const n1 = noise[i * 3 + 1];
  const n2 = noise[i * 3 + 2];
  const ter = t.terrain[i];
  const h = (hgt[z * W1 + x] + hgt[z * W1 + x + 1] + hgt[(z + 1) * W1 + x] + hgt[(z + 1) * W1 + x + 1]) * 0.25;
  let grass = 1;
  let snow = 1;
  let rock = 0;
  let sand = 0;
  if (ter === Terrain.Water || ter === Terrain.DeepWater) {
    const depth = WATER_LEVEL - h;
    _c[0] = C.riverbed[0]; _c[1] = C.riverbed[1]; _c[2] = C.riverbed[2];
    mixInto(_c, C.riverbedDeep, smoothstep(0.15, 2.2, depth) * 0.9 + (ter === Terrain.DeepWater ? 0.1 : 0));
    const b = 0.94 + 0.12 * n0;
    _c[0] *= b; _c[1] *= b; _c[2] *= b;
    grass = 0;
    snow = 0;
  } else {
    // vegetation layer — meadow variation between lush and dry patches
    _c[0] = C.grassLush[0]; _c[1] = C.grassLush[1]; _c[2] = C.grassLush[2];
    mixInto(_c, C.grassDry, clamp01(n1 * 1.5 - 0.35));
    const b = 0.95 + 0.1 * n0;
    _c[0] *= b; _c[1] *= b; _c[2] *= b;
    if (ter === Terrain.Mountain) {
      // scrubby vegetation shows only along the foot of the rock
      mixInto(_c, C.scrub, 0.7);
      rock = 1;
      grass = 0.6;
    } else if (ter === Terrain.Sand) {
      sand = 1;
    } else {
      const f = t.feature[i];
      if (f === Feature.Tree) {
        const k = smoothstep(0.1, 0.7, t.featureAmount[i]) * (0.55 + 0.2 * n2);
        mixInto(_c, C.forest, k);
        grass = 1 - 0.25 * k;
        snow = 1 - 0.6 * k; // canopies catch snow: the forest floor stays patchy
      } else if (f === Feature.Rock || f === Feature.Iron) {
        mixInto(_c, C.stony, 0.35);
        grass = 0.75;
      }
      if (nearWater[i] === 1 && h < WATER_LEVEL + 0.9) sand = 0.46;
    }
  }
  const k3 = i * 3;
  const k4 = i * 4;
  const r = Math.round(clamp01(_c[0]) * 255);
  const g = Math.round(clamp01(_c[1]) * 255);
  const bl = Math.round(clamp01(_c[2]) * 255);
  const mg = Math.round(grass * 255);
  const ms = Math.round(snow * 255);
  const mr = Math.round(rock * 255);
  const md = Math.round(sand * 255);
  if (rgbOut[k3] !== r || rgbOut[k3 + 1] !== g || rgbOut[k3 + 2] !== bl
    || matOut[k4] !== mg || matOut[k4 + 1] !== ms || matOut[k4 + 2] !== mr || matOut[k4 + 3] !== md) {
    rgbOut[k3] = r; rgbOut[k3 + 1] = g; rgbOut[k3 + 2] = bl;
    matOut[k4] = mg; matOut[k4 + 1] = ms; matOut[k4 + 2] = mr; matOut[k4 + 3] = md;
    return true;
  }
  return false;
}

/**
 * Per-tile key of everything feature-related that affects the natural colour (feature kind + quantized tree
 * growth). Comparing keys finds the few tiles that need recolouring after a `rev.features` bump.
 */
export function featureKey(feature: number, amount: number): number {
  return feature === Feature.Tree ? 128 | Math.min(127, Math.floor(amount * 64)) : feature;
}

/** 1 for land tiles with a water tile in their 8-neighbourhood (depends on terrain only). */
export function computeNearWater(state: GameState, out: Uint8Array): void {
  const { W, H } = state;
  const ter = state.tiles.terrain;
  out.fill(0);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const t0 = ter[z * W + x];
      if (t0 === Terrain.Water || t0 === Terrain.DeepWater) continue;
      let wet = 0;
      for (let dz = -1; dz <= 1 && !wet; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W || (dx === 0 && dz === 0)) continue;
          const tt = ter[zz * W + xx];
          if (tt === Terrain.Water || tt === Terrain.DeepWater) {
            wet = 1;
            break;
          }
        }
      }
      out[z * W + x] = wet;
    }
  }
}

/**
 * Average tile colours/materials onto tile corners ((W+1)*(H+1)*4 bytes each: r,g,b,255 / grass,snow,rock,sand).
 * Land tiles win over water tiles so shorelines don't get muddy/unsnowed bands and beaches reach the waterline.
 */
export function computeCorners(
  state: GameState, tileRgb: Uint8Array, tileMat: Uint8Array, cornerRgb: Uint8Array, cornerMat: Uint8Array,
): void {
  for (let cz = 0; cz <= state.H; cz++) {
    for (let cx = 0; cx <= state.W; cx++) computeCorner(state, tileRgb, tileMat, cornerRgb, cornerMat, cx, cz);
  }
}

/** Recompute the 4 corners of each listed tile (incremental companion of computeCorners). */
export function computeCornersForTiles(
  state: GameState, tileRgb: Uint8Array, tileMat: Uint8Array, cornerRgb: Uint8Array, cornerMat: Uint8Array,
  tiles: Int32Array, count: number,
): void {
  const W = state.W;
  for (let k = 0; k < count; k++) {
    const i = tiles[k];
    const x = i % W;
    const z = (i / W) | 0;
    computeCorner(state, tileRgb, tileMat, cornerRgb, cornerMat, x, z);
    computeCorner(state, tileRgb, tileMat, cornerRgb, cornerMat, x + 1, z);
    computeCorner(state, tileRgb, tileMat, cornerRgb, cornerMat, x, z + 1);
    computeCorner(state, tileRgb, tileMat, cornerRgb, cornerMat, x + 1, z + 1);
  }
}

const _acc = new Float64Array(7);
const _wacc = new Float64Array(7);

function computeCorner(
  state: GameState, tileRgb: Uint8Array, tileMat: Uint8Array, cornerRgb: Uint8Array, cornerMat: Uint8Array,
  cx: number, cz: number,
): void {
  const { W, H } = state;
  const ter = state.tiles.terrain;
  const acc = _acc;
  const wacc = _wacc;
  acc.fill(0);
  wacc.fill(0);
  let n = 0;
  let wn = 0;
  for (let dz = -1; dz <= 0; dz++) {
    const z = cz + dz;
    if (z < 0 || z >= H) continue;
    for (let dx = -1; dx <= 0; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= W) continue;
      const i = z * W + x;
      const k = i * 3;
      const m = i * 4;
      const tt = ter[i];
      const a = tt === Terrain.Water || tt === Terrain.DeepWater ? wacc : acc;
      a[0] += tileRgb[k]; a[1] += tileRgb[k + 1]; a[2] += tileRgb[k + 2];
      a[3] += tileMat[m]; a[4] += tileMat[m + 1]; a[5] += tileMat[m + 2]; a[6] += tileMat[m + 3];
      if (a === wacc) wn++;
      else n++;
    }
  }
  const src = n > 0 ? acc : wacc;
  const inv = 1 / Math.max(1, n > 0 ? n : wn);
  const o = (cz * (W + 1) + cx) * 4;
  cornerRgb[o] = Math.round(src[0] * inv);
  cornerRgb[o + 1] = Math.round(src[1] * inv);
  cornerRgb[o + 2] = Math.round(src[2] * inv);
  cornerRgb[o + 3] = 255;
  cornerMat[o] = Math.round(src[3] * inv);
  cornerMat[o + 1] = Math.round(src[4] * inv);
  cornerMat[o + 2] = Math.round(src[5] * inv);
  cornerMat[o + 3] = Math.round(src[6] * inv);
}

/** Snow-line helper: heights (sorted ascending) of mountain tile corners, subsampled. */
export function mountainHeights(state: GameState): Float32Array {
  const { W, H } = state;
  const vals: number[] = [];
  const ter = state.tiles.terrain;
  const hgt = state.tiles.height;
  for (let z = 0; z < H; z += 1) {
    for (let x = 0; x < W; x += 1) {
      if (ter[z * W + x] !== Terrain.Mountain) continue;
      vals.push(hgt[z * (W + 1) + x]);
    }
  }
  const arr = Float32Array.from(vals);
  arr.sort();
  return arr;
}

export function quantile(sorted: Float32Array, q: number, fallback: number): number {
  if (sorted.length === 0) return fallback;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}
