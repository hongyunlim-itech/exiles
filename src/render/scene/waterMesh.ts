/**
 * Builds the water surface mesh data: an indexed grid at WATER_LEVEL covering water tiles plus a 1-tile land margin
 * (so the surface meets the sloping banks), extended a few tiles past the map edge where rivers leave the map.
 * Per-vertex attributes: depth below the surface and distance to the shore (tiles). Pure — no three.js.
 * OWNER: render-scene.
 */
import { WATER_LEVEL } from '../../core/constants';
import type { GameState } from '../../core/types';
import { Terrain } from '../../core/types';
import { smoothstep } from './palette';

export interface WaterMeshData {
  positions: Float32Array;
  /** WATER_LEVEL - terrain height at the vertex (negative on land). */
  depth: Float32Array;
  /** Distance from land in tiles (0 at the shoreline), capped. */
  shore: Float32Array;
  index: Uint32Array;
  /** Number of water tiles found (0 = no water mesh needed). */
  waterTiles: number;
}

const SHORE_CAP = 6;

function isWater(t: number): boolean {
  return t === Terrain.Water || t === Terrain.DeepWater;
}

/** Multi-source BFS (8-neighbour) distance from land for every tile, capped at SHORE_CAP. */
export function shoreDistance(state: GameState): Uint8Array {
  const { W, H } = state;
  const ter = state.tiles.terrain;
  const n = W * H;
  const dist = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!isWater(ter[i])) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= SHORE_CAP) continue;
    const x = i % W;
    const z = (i / W) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const j = zz * W + xx;
        if (dist[j] > d + 1) {
          dist[j] = d + 1;
          queue[tail++] = j;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) if (dist[i] > SHORE_CAP) dist[i] = SHORE_CAP;
  return dist;
}

export function buildWaterMesh(state: GameState, apron = 12): WaterMeshData {
  const { W, H } = state;
  const ter = state.tiles.terrain;
  const hgt = state.tiles.height;
  const W1 = W + 1;
  const n = W * H;

  // tiles to cover: water + 8-neighbour land margin
  const include = new Uint8Array(n);
  let waterTiles = 0;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!isWater(ter[z * W + x])) continue;
      waterTiles++;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          include[zz * W + xx] = 1;
        }
      }
    }
  }
  if (waterTiles === 0) {
    return { positions: new Float32Array(0), depth: new Float32Array(0), shore: new Float32Array(0), index: new Uint32Array(0), waterTiles: 0 };
  }
  const dist = shoreDistance(state);

  // extended corner grid [-apron, W+apron] x [-apron, H+apron]
  const EW = W + 2 * apron + 1;
  const EH = H + 2 * apron + 1;
  const vid = new Int32Array(EW * EH).fill(-1);
  const pos: number[] = [];
  const dep: number[] = [];
  const sho: number[] = [];
  const idx: number[] = [];

  const cornerH = (cx: number, cz: number): number =>
    hgt[Math.max(0, Math.min(H, cz)) * W1 + Math.max(0, Math.min(W, cx))];
  const tileDist = (tx: number, tz: number): number =>
    dist[Math.max(0, Math.min(H - 1, tz)) * W + Math.max(0, Math.min(W - 1, tx))];

  const vertex = (cx: number, cz: number): number => {
    const key = (cz + apron) * EW + (cx + apron);
    let v = vid[key];
    if (v >= 0) return v;
    v = pos.length / 3;
    vid[key] = v;
    pos.push(cx, WATER_LEVEL, cz);
    // outside the map the river continues along the border ring's valley, whose bed rises out of the water over
    // ~14 tiles (mirrors TerrainBorder's river-valley profile)
    const out = Math.max(0, -cx, cx - W, -cz, cz - H);
    const base = cornerH(cx, cz);
    const bed = out > 0 ? base + (Math.max(base, 0.45) - base) * smoothstep(0, 14.5, out) : base;
    dep.push(WATER_LEVEL - bed);
    // shore distance: min over the (up to 4) tiles sharing this corner
    let s = SHORE_CAP;
    for (let dz = -1; dz <= 0; dz++) {
      for (let dx = -1; dx <= 0; dx++) {
        const td = tileDist(cx + dx, cz + dz);
        if (td < s) s = td;
      }
    }
    sho.push(s);
    return v;
  };

  const quad = (tx: number, tz: number): void => {
    const a = vertex(tx, tz);
    const b = vertex(tx + 1, tz);
    const c = vertex(tx, tz + 1);
    const d = vertex(tx + 1, tz + 1);
    // CCW seen from above (+Y)
    idx.push(a, c, d, a, d, b);
  };

  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!include[z * W + x]) continue;
      quad(x, z);
      if (!isWater(ter[z * W + x])) continue;
      // extend edge water outwards so rivers don't end abruptly at the map border
      const west = x === 0;
      const east = x === W - 1;
      const north = z === 0;
      const south = z === H - 1;
      for (let k = 1; k <= apron; k++) {
        if (west) quad(x - k, z);
        if (east) quad(x + k, z);
        if (north) quad(x, z - k);
        if (south) quad(x, z + k);
        if (west && north) for (let j = 1; j <= apron; j++) quad(x - k, z - j);
        if (west && south) for (let j = 1; j <= apron; j++) quad(x - k, z + j);
        if (east && north) for (let j = 1; j <= apron; j++) quad(x + k, z - j);
        if (east && south) for (let j = 1; j <= apron; j++) quad(x + k, z + j);
      }
    }
  }

  return {
    positions: Float32Array.from(pos),
    depth: Float32Array.from(dep),
    shore: Float32Array.from(sho),
    index: Uint32Array.from(idx),
    waterTiles,
  };
}
