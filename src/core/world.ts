/**
 * Pure tile/geometry helpers shared by sim, render, UI and input. Architect-owned.
 * Keep these functions side-effect free and cheap.
 */
import { ADULT_AGE, COST_BRIDGE, COST_DIRT_ROAD, COST_FOREST, COST_GRASS, COST_STONE_ROAD, ELDERLY_AGE, MAX_BUILD_SLOPE, MONTH_SECONDS } from './constants';
import { BUILDINGS, seasonOfMonth } from './defs';
import type { AgeClass, Building, BuildingType, Citizen, GameState, Rotation, Season } from './types';
import { Feature, Road, Terrain } from './types';

export function idx(s: { W: number }, x: number, z: number): number {
  return z * s.W + x;
}

export function tileXZ(s: { W: number }, i: number): [number, number] {
  return [i % s.W, Math.floor(i / s.W)];
}

export function inBounds(s: { W: number; H: number }, x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x < s.W && z < s.H;
}

/** Height of the tile corner (x, z), 0 <= x <= W, 0 <= z <= H. */
export function cornerHeight(s: GameState, x: number, z: number): number {
  const cx = Math.max(0, Math.min(s.W, x));
  const cz = Math.max(0, Math.min(s.H, z));
  return s.tiles.height[cz * (s.W + 1) + cx];
}

/** Average corner height of a tile. */
export function tileHeight(s: GameState, x: number, z: number): number {
  return (cornerHeight(s, x, z) + cornerHeight(s, x + 1, z) + cornerHeight(s, x, z + 1) + cornerHeight(s, x + 1, z + 1)) * 0.25;
}

/** Bilinearly interpolated terrain height at continuous world position. */
export function heightAt(s: GameState, wx: number, wz: number): number {
  const x = Math.max(0, Math.min(s.W - 0.0001, wx));
  const z = Math.max(0, Math.min(s.H - 0.0001, wz));
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const h00 = cornerHeight(s, x0, z0);
  const h10 = cornerHeight(s, x0 + 1, z0);
  const h01 = cornerHeight(s, x0, z0 + 1);
  const h11 = cornerHeight(s, x0 + 1, z0 + 1);
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

/** Max - min corner height of a tile. */
export function tileSlope(s: GameState, x: number, z: number): number {
  const a = cornerHeight(s, x, z);
  const b = cornerHeight(s, x + 1, z);
  const c = cornerHeight(s, x, z + 1);
  const d = cornerHeight(s, x + 1, z + 1);
  return Math.max(a, b, c, d) - Math.min(a, b, c, d);
}

export function isWaterTerrain(t: number): boolean {
  return t === Terrain.Water || t === Terrain.DeepWater;
}

export function isLandTerrain(t: number): boolean {
  return t === Terrain.Grass || t === Terrain.Sand;
}

/** Whether the building type's footprint tiles can be walked on (zones). */
export function isWalkableBuildingType(type: BuildingType): boolean {
  return !!BUILDINGS[type].walkable;
}

/**
 * Walkability for pathfinding. `buildingTypeById` lets the caller resolve tile building ids
 * (Game passes a lookup); if omitted, any building tile is treated as blocked.
 */
export function isWalkable(s: GameState, i: number, buildingTypeById?: (id: number) => BuildingType | undefined): boolean {
  const t = s.tiles.terrain[i];
  if (!isLandTerrain(t)) return s.tiles.road[i] === Road.Bridge;
  const b = s.tiles.building[i];
  if (b >= 0) {
    const type = buildingTypeById?.(b);
    return !!type && isWalkableBuildingType(type);
  }
  return true;
}

/** Movement cost multiplier for entering tile i (assumes walkable). */
export function tileCost(s: GameState, i: number): number {
  switch (s.tiles.road[i]) {
    case Road.Dirt: return COST_DIRT_ROAD;
    case Road.Stone: return COST_STONE_ROAD;
    case Road.Bridge: return COST_BRIDGE;
  }
  return s.tiles.feature[i] === Feature.Tree && s.tiles.featureAmount[i] > 0.3 ? COST_FOREST : COST_GRASS;
}

/** Footprint (w, h) for a building type at a rotation (non-resizable). */
export function footprintSize(type: BuildingType, rotation: Rotation): [number, number] {
  const [w, h] = BUILDINGS[type].size;
  return rotation % 2 === 1 ? [h, w] : [w, h];
}

/** Door tile for a footprint. Zones (walkable) use a tile inside the footprint on the door edge. */
export function computeDoor(type: BuildingType, x: number, z: number, w: number, h: number, rotation: Rotation): [number, number] {
  const inside = isWalkableBuildingType(type) ? 1 : 0;
  switch (rotation) {
    case 0: return [x + Math.floor(w / 2), z + h - inside];
    case 1: return [x - 1 + inside, z + Math.floor(h / 2)];
    case 2: return [x + Math.floor(w / 2), z - 1 + inside];
    case 3: return [x + w - inside, z + Math.floor(h / 2)];
  }
}

/** Continuous world-space center of a building footprint. */
export function buildingCenter(b: Pick<Building, 'x' | 'z' | 'w' | 'h'>): [number, number] {
  return [b.x + b.w / 2, b.z + b.h / 2];
}

/** Door tile center in world space. */
export function doorPos(b: Pick<Building, 'doorX' | 'doorZ'>): [number, number] {
  return [b.doorX + 0.5, b.doorZ + 0.5];
}

/** Standard buildability of a single tile (ignores features — trees/rocks get cleared). */
export function isTileBuildable(s: GameState, x: number, z: number): boolean {
  if (!inBounds(s, x, z)) return false;
  const i = idx(s, x, z);
  if (!isLandTerrain(s.tiles.terrain[i])) return false;
  if (s.tiles.building[i] >= 0) return false;
  if (s.tiles.road[i] !== Road.None) return false;
  return tileSlope(s, x, z) <= MAX_BUILD_SLOPE;
}

/** Visit every tile index whose center is within radius r of (cx, cz) (world coords). */
export function forTilesInRadius(s: { W: number; H: number }, cx: number, cz: number, r: number, fn: (i: number, x: number, z: number) => void): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(s.W - 1, Math.ceil(cx + r));
  const z0 = Math.max(0, Math.floor(cz - r));
  const z1 = Math.min(s.H - 1, Math.ceil(cz + r));
  const r2 = r * r;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dz = z + 0.5 - cz;
      if (dx * dx + dz * dz <= r2) fn(z * s.W + x, x, z);
    }
  }
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function currentSeason(s: GameState): Season {
  return seasonOfMonth(s.time.month);
}

/** Fraction through the year 0..1. */
export function yearProgress(s: GameState): number {
  return (s.time.month + s.time.monthProgress) / 12;
}

export function ageClassOf(c: Citizen): AgeClass {
  if (c.profession === 'student') return 'student';
  if (c.age < ADULT_AGE) return 'child';
  if (c.age >= ELDERLY_AGE) return 'elderly';
  return 'adult';
}

/** Months -> game seconds. */
export function months(n: number): number {
  return n * MONTH_SECONDS;
}

/**
 * Y-axis rotation (radians) that orients a model authored with its door facing +Z to the given Rotation.
 * rotation 0: +Z, 1: -X, 2: -Z, 3: +X.
 */
export function rotationAngle(r: Rotation): number {
  return [0, -Math.PI / 2, Math.PI, Math.PI / 2][r];
}
