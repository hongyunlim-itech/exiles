/**
 * Pure tile-geometry helpers for the input tools (no three.js, no DOM) — unit tested in tests/input.geometry.test.ts.
 *
 * Conventions (see ARCHITECTURE.md §2): tile (x, z) spans [x, x+1] × [z, z+1]; footprints cover [x, x+w) × [z, z+h);
 * rectangles used by area tools are INCLUSIVE tile ranges (x0..x1, z0..z1).
 */
import type { Rotation } from '../core/types';

/** Inclusive tile rectangle (x0 <= x1, z0 <= z1 after normalisation). */
export interface TileRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Building footprint: min corner + size (already rotated). */
export interface Footprint {
  x: number;
  z: number;
  w: number;
  h: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Rectangle spanning two tile corners in any order (inclusive). */
export function normalizeRect(ax: number, az: number, bx: number, bz: number): TileRect {
  return {
    x0: Math.min(ax, bx),
    z0: Math.min(az, bz),
    x1: Math.max(ax, bx),
    z1: Math.max(az, bz),
  };
}

/** Intersect an inclusive rectangle with the map. Returns null when it lies completely outside. */
export function clampRectToMap(r: TileRect, W: number, H: number): TileRect | null {
  const x0 = Math.max(0, r.x0);
  const z0 = Math.max(0, r.z0);
  const x1 = Math.min(W - 1, r.x1);
  const z1 = Math.min(H - 1, r.z1);
  if (x0 > x1 || z0 > z1) return null;
  return { x0, z0, x1, z1 };
}

export function rectTileCount(r: TileRect): number {
  return (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1);
}

export function rectWidth(r: TileRect): number {
  return r.x1 - r.x0 + 1;
}

export function rectHeight(r: TileRect): number {
  return r.z1 - r.z0 + 1;
}

/**
 * Min-corner coordinate of a footprint of `size` tiles centred on the continuous cursor coordinate `center`.
 * Odd sizes centre on the cursor's tile; even sizes snap to the tile corner nearest the cursor.
 * The result is clamped so the footprint stays inside [0, mapSize).
 */
export function footprintOrigin(center: number, size: number, mapSize: number): number {
  const o = Math.round(center - size / 2);
  return clamp(o, 0, Math.max(0, mapSize - size));
}

/** A w × h footprint centred on the continuous world position (wx, wz), clamped to the map. */
export function centredFootprint(
  wx: number, wz: number, w: number, h: number, W: number, H: number,
  out: Footprint = { x: 0, z: 0, w: 0, h: 0 },
): Footprint {
  out.x = footprintOrigin(wx, w, W);
  out.z = footprintOrigin(wz, h, H);
  out.w = w;
  out.h = h;
  return out;
}

/**
 * Zone rectangle for a drag from anchor tile (ax, az) to the current tile (bx, bz).
 * Each side is clamped to [min, max] (and to the map size); when the drag is shorter than `min` the zone grows in the
 * drag direction, when longer than `max` it is cut off at `max` tiles from the anchor. The result lies inside the map.
 */
export function zoneRectFromDrag(
  ax: number, az: number, bx: number, bz: number,
  min: number, max: number, W: number, H: number,
  out: Footprint = { x: 0, z: 0, w: 0, h: 0 },
): Footprint {
  const dx = bx - ax;
  const dz = bz - az;
  const w = Math.min(W, clamp(Math.abs(dx) + 1, min, max));
  const h = Math.min(H, clamp(Math.abs(dz) + 1, min, max));
  const x = dx >= 0 ? ax : ax - w + 1;
  const z = dz >= 0 ? az : az - h + 1;
  out.x = clamp(x, 0, Math.max(0, W - w));
  out.z = clamp(z, 0, Math.max(0, H - h));
  out.w = w;
  out.h = h;
  return out;
}

/** Inclusive rect covered by a footprint. */
export function footprintRect(f: Footprint): TileRect {
  return { x0: f.x, z0: f.z, x1: f.x + f.w - 1, z1: f.z + f.h - 1 };
}

/**
 * L-shaped road path from (x0, z0) to (x1, z1) as a list of [x, z] tiles (start and end included, no duplicates).
 * The first leg follows the dominant drag axis (|dx| >= |dz| → horizontal first), then bends toward the end tile.
 */
export function roadPath(x0: number, z0: number, x1: number, z1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const dx = x1 - x0;
  const dz = z1 - z0;
  const sx = Math.sign(dx);
  const sz = Math.sign(dz);
  if (Math.abs(dx) >= Math.abs(dz)) {
    for (let x = x0; ; x += sx) {
      out.push([x, z0]);
      if (x === x1 || sx === 0) break;
    }
    for (let z = z0 + sz; sz !== 0; z += sz) {
      out.push([x1, z]);
      if (z === z1) break;
    }
  } else {
    for (let z = z0; ; z += sz) {
      out.push([x0, z]);
      if (z === z1 || sz === 0) break;
    }
    for (let x = x0 + sx; sx !== 0; x += sx) {
      out.push([x, z1]);
      if (x === x1) break;
    }
  }
  return out;
}

/** `roadPath` as tile indices (z * W + x), dropping tiles outside the map. */
export function roadPathIndices(x0: number, z0: number, x1: number, z1: number, W: number, H: number): number[] {
  const out: number[] = [];
  for (const [x, z] of roadPath(x0, z0, x1, z1)) {
    if (x >= 0 && z >= 0 && x < W && z < H) out.push(z * W + x);
  }
  return out;
}

/** Next rotation clockwise (door +Z → −X → −Z → +X). */
export function nextRotation(r: Rotation): Rotation {
  return ((r + 1) % 4) as Rotation;
}

/**
 * Unrotated model dimensions for a footprint of (w, h) at `rotation` (model space authors the door toward +Z).
 * For rotation 1/3 the unrotated dims are (h, w).
 */
export function modelDims(w: number, h: number, rotation: Rotation): [number, number] {
  return rotation % 2 === 1 ? [h, w] : [w, h];
}

/** Pointer travel (CSS px) above which a press counts as a drag rather than a click. */
export const CLICK_SLOP_PX = 5;

/**
 * Tiles per 'road' / 'removeRoad' command. Co-op commands travel in ≤ 4 KiB room payloads and a guest's presence
 * command queue is budgeted at ~2 KB (net/protocol QUEUE_BYTES, ROAD_SPLIT = 120): 120 indices of up to 5 digits are
 * ~0.7 KB of JSON.
 */
export const TILES_PER_COMMAND = 120;

/** Split a tile list into command-sized chunks (order kept; a short list is returned as one chunk). */
export function chunkTiles(tiles: readonly number[], size = TILES_PER_COMMAND): number[][] {
  const n = Math.max(1, Math.floor(size));
  if (tiles.length <= n) return [tiles.slice()];
  const out: number[][] = [];
  for (let i = 0; i < tiles.length; i += n) out.push(tiles.slice(i, i + n));
  return out;
}
