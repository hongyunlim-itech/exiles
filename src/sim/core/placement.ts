/**
 * Placement rules, terrain flattening, roads/bridges and removal marking. ARCHITECTURE §3.6. OWNER: sim-core.
 */
import { MAX_BUILD_SLOPE, WATER_LEVEL } from '../../core/constants';
import { BUILDINGS, ROAD_DEFS } from '../../core/defs';
import type { Building, BuildingType, PlacementCheck, RemovalFilter, ResourceType, Rotation } from '../../core/types';
import { Feature, Road, Terrain } from '../../core/types';
import { computeDoor, cornerHeight, footprintSize, inBounds, isLandTerrain, isWaterTerrain, tileSlope } from '../../core/world';
import type { Game } from '../game';
import { computeRegions } from '../pathfinding';
import { availableInStorage, takeFromStorageNow } from './storage';
import { invGet } from './util';

/** Largest corner-height range across a non-zone footprint (it gets flattened). */
const MAX_FOOTPRINT_RANGE = 2.6;
/** Zones are not flattened; they tolerate somewhat steeper tiles. */
const ZONE_SLOPE_FACTOR = 1.6;

export interface Footprint {
  w: number;
  h: number;
}

/** Resolve the footprint size for a placement request. */
export function resolveFootprint(type: BuildingType, rotation: Rotation, w?: number, h?: number): Footprint {
  const def = BUILDINGS[type];
  if (def.resizable) {
    return { w: Math.round(w ?? def.size[0]), h: Math.round(h ?? def.size[1]) };
  }
  const [fw, fh] = footprintSize(type, rotation);
  return { w: fw, h: fh };
}

export function checkPlacementImpl(g: Game, type: BuildingType, x: number, z: number, rotation: Rotation, w?: number, h?: number): PlacementCheck {
  const s = g.state;
  const def = BUILDINGS[type];
  const rot = (((rotation | 0) % 4) + 4) % 4 as Rotation;
  const fp = resolveFootprint(type, rot, w, h);
  x = Math.floor(x);
  z = Math.floor(z);
  const [doorX, doorZ] = computeDoor(type, x, z, fp.w, fp.h, rot);
  const result: PlacementCheck = { ok: false, blocked: [], clearing: [], doorX, doorZ };
  const fail = (reason: string): PlacementCheck => {
    if (!result.reason) result.reason = reason;
    return result;
  };
  if (!def) return fail('Unknown building');
  if (def.resizable) {
    const { min, max } = def.resizable;
    if (fp.w < min || fp.h < min || fp.w > max || fp.h > max) fail(`Size must be between ${min} and ${max}`);
  }
  const walkable = !!def.walkable;
  const shore = def.placement === 'shore';
  const t = s.tiles;
  const W = s.W;
  let water = 0;
  let land = 0;
  let outside = false;
  let minH = Infinity;
  let maxH = -Infinity;
  const slopeLimit = walkable ? MAX_BUILD_SLOPE * ZONE_SLOPE_FACTOR : MAX_BUILD_SLOPE;
  for (let zz = z; zz < z + fp.h; zz++) {
    for (let xx = x; xx < x + fp.w; xx++) {
      if (!inBounds(s, xx, zz)) {
        outside = true;
        continue;
      }
      const i = zz * W + xx;
      const terr = t.terrain[i];
      if (t.building[i] >= 0 || t.road[i] !== Road.None) {
        result.blocked.push(i);
        continue;
      }
      if (shore && isWaterTerrain(terr)) {
        water++;
        continue;
      }
      if (!isLandTerrain(terr)) {
        result.blocked.push(i);
        continue;
      }
      if (tileSlope(s, xx, zz) > slopeLimit) {
        result.blocked.push(i);
        continue;
      }
      if (g.rt.doorTiles.has(i)) {
        result.blocked.push(i);
        continue;
      }
      land++;
      if (t.feature[i] !== Feature.None) result.clearing.push(i);
      if (!walkable && !shore) {
        for (const [cx, cz] of [[xx, zz], [xx + 1, zz], [xx, zz + 1], [xx + 1, zz + 1]] as const) {
          const hh = cornerHeight(s, cx, cz);
          if (hh < minH) minH = hh;
          if (hh > maxH) maxH = hh;
        }
      }
    }
  }
  if (outside) fail('Outside the map');
  if (result.blocked.length > 0) {
    const i0 = result.blocked[0];
    const terr = t.terrain[i0];
    if (t.building[i0] >= 0) fail('Blocked by another building');
    else if (t.road[i0] !== Road.None) fail('Blocked by a road');
    else if (terr === Terrain.Mountain) fail('Cannot build on mountains');
    else if (isWaterTerrain(terr)) fail(shore ? 'Blocked' : 'Cannot build on water');
    else if (g.rt.doorTiles.has(i0)) fail('Would block the entrance of another building');
    else fail('Ground is too steep');
  }
  if (!walkable && !shore && maxH - minH > MAX_FOOTPRINT_RANGE) fail('Ground is too uneven');
  const total = fp.w * fp.h;
  if (shore) {
    if (water < total * 0.25) fail('Must be placed on the water\'s edge');
    else if (land < total * 0.4) fail('Needs more solid ground');
  }
  if (def.placement === 'mountain' && !touchesMountain(g, x, z, fp.w, fp.h)) fail('Must be placed against a mountain');
  // entrance
  if (!inBounds(s, doorX, doorZ)) fail('Entrance is outside the map');
  else {
    const di = doorZ * W + doorX;
    const terr = t.terrain[di];
    const insideFootprint = doorX >= x && doorX < x + fp.w && doorZ >= z && doorZ < z + fp.h;
    if (!insideFootprint) {
      if (!isLandTerrain(terr) && t.road[di] !== Road.Bridge) fail('Entrance must be on land');
      else if (t.building[di] >= 0) {
        const other = g.buildingById.get(t.building[di]);
        if (!other || !BUILDINGS[other.type].walkable) fail('Entrance is blocked');
      }
    } else if (!isLandTerrain(terr)) fail('Entrance must be on land');
  }
  result.ok = !result.reason;
  return result;
}

function touchesMountain(g: Game, x: number, z: number, w: number, h: number): boolean {
  const s = g.state;
  for (let zz = z - 1; zz <= z + h; zz++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const inside = xx >= x && xx < x + w && zz >= z && zz < z + h;
      if (inside || !inBounds(s, xx, zz)) continue;
      if (s.tiles.terrain[zz * s.W + xx] === Terrain.Mountain) return true;
    }
  }
  return false;
}

/** Average the corner heights under a footprint (non-zone buildings). */
export function flattenFootprint(g: Game, b: Building): void {
  const s = g.state;
  const W1 = s.W + 1;
  const hts = s.tiles.height;
  let sum = 0;
  let n = 0;
  for (let zz = b.z; zz <= b.z + b.h; zz++) {
    for (let xx = b.x; xx <= b.x + b.w; xx++) {
      sum += hts[zz * W1 + xx];
      n++;
    }
  }
  if (n === 0) return;
  const avg = Math.max(WATER_LEVEL + 0.06, sum / n);
  for (let zz = b.z; zz <= b.z + b.h; zz++) {
    for (let xx = b.x; xx <= b.x + b.w; xx++) hts[zz * W1 + xx] = avg;
  }
  s.rev.terrain++;
}

/** Mark footprint features for clearing. Returns number marked. */
export function markFootprintFeatures(g: Game, b: Building): number {
  const s = g.state;
  let n = 0;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const i = zz * s.W + xx;
      if (s.tiles.feature[i] === Feature.None) continue;
      if (!s.tiles.marked[i]) {
        s.tiles.marked[i] = 1;
        n++;
      }
      g.rt.marked.add(i);
    }
  }
  if (n > 0) g.bumpFeatures();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------------------------

export function checkRoadImpl(g: Game, tiles: number[], kind: 'dirt' | 'stone'): { ok: number[]; blocked: number[] } {
  void kind;
  const s = g.state;
  const N = s.W * s.H;
  const ok: number[] = [];
  const blocked: number[] = [];
  const seen = new Set<number>();
  for (const raw of tiles) {
    const i = raw | 0;
    if (seen.has(i)) continue;
    seen.add(i);
    if (i < 0 || i >= N) continue;
    const terr = s.tiles.terrain[i];
    if (s.tiles.building[i] >= 0) blocked.push(i);
    else if (terr === Terrain.Water) ok.push(i);
    else if (isLandTerrain(terr)) ok.push(i);
    else blocked.push(i);
  }
  return { ok, blocked };
}

export function placeRoadImpl(g: Game, tiles: number[], kind: 'dirt' | 'stone'): number {
  const s = g.state;
  const t = s.tiles;
  const { ok } = checkRoadImpl(g, tiles, kind);
  let placed = 0;
  let bridges = 0;
  let marked = 0;
  let skippedCost = 0;
  for (const i of ok) {
    const terr = t.terrain[i];
    if (terr === Terrain.Water) {
      if (t.road[i] === Road.Bridge) continue;
      if (!payFor(g, ROAD_DEFS.bridge.cost)) {
        skippedCost++;
        continue;
      }
      t.road[i] = Road.Bridge;
      placed++;
      bridges++;
      continue;
    }
    const cur = t.road[i];
    if (kind === 'dirt') {
      if (cur !== Road.None) continue;
      t.road[i] = Road.Dirt;
    } else {
      if (cur === Road.Stone) continue;
      if (!payFor(g, ROAD_DEFS.stone.cost)) {
        skippedCost++;
        continue;
      }
      t.road[i] = Road.Stone;
    }
    placed++;
    if (t.feature[i] !== Feature.None && !t.marked[i]) {
      t.marked[i] = 1;
      g.rt.marked.add(i);
      marked++;
    }
  }
  if (placed > 0) s.rev.roads++;
  if (marked > 0) g.bumpFeatures();
  if (bridges > 0) g.recomputeRegions();
  if (skippedCost > 0 && placed === 0) {
    g.addMessage(kind === 'stone' ? 'Not enough stone to build the road.' : 'Not enough materials to build the bridge.', 'warning');
  }
  return placed;
}

function payFor(g: Game, cost: Partial<Record<ResourceType, number>>): boolean {
  for (const k in cost) {
    const r = k as ResourceType;
    if (availableInStorage(g, r, true) < invGet(cost, r)) return false;
  }
  for (const k in cost) {
    const r = k as ResourceType;
    takeFromStorageNow(g, r, invGet(cost, r));
  }
  return true;
}

export function removeRoadImpl(g: Game, tiles: number[]): number {
  const s = g.state;
  const t = s.tiles;
  const N = s.W * s.H;
  let n = 0;
  let bridges = 0;
  for (const raw of tiles) {
    const i = raw | 0;
    if (i < 0 || i >= N) continue;
    if (t.road[i] === Road.None) continue;
    if (t.road[i] === Road.Bridge) bridges++;
    t.road[i] = Road.None;
    n++;
  }
  if (n > 0) s.rev.roads++;
  if (bridges > 0) g.recomputeRegions();
  return n;
}

/** Recompute walkability regions (after bridges changed). */
export function recomputeRegionsSafe(g: Game): void {
  try {
    computeRegions(g.state);
  } catch (err) {
    g.reportModuleError('computeRegions', err);
  }
}

// ---------------------------------------------------------------------------------------------
// Removal marking
// ---------------------------------------------------------------------------------------------

function matches(feature: number, filter: RemovalFilter): boolean {
  switch (filter) {
    case 'all': return feature !== Feature.None;
    case 'trees': return feature === Feature.Tree;
    case 'stone': return feature === Feature.Rock;
    case 'iron': return feature === Feature.Iron;
  }
  return false;
}

function normRect(g: Game, x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
  const s = g.state;
  const ax = Math.max(0, Math.min(Math.floor(x0), Math.floor(x1)));
  const bx = Math.min(s.W - 1, Math.max(Math.floor(x0), Math.floor(x1)));
  const az = Math.max(0, Math.min(Math.floor(z0), Math.floor(z1)));
  const bz = Math.min(s.H - 1, Math.max(Math.floor(z0), Math.floor(z1)));
  return [ax, az, bx, bz];
}

export function markRect(g: Game, x0: number, z0: number, x1: number, z1: number, filter: RemovalFilter): number {
  const s = g.state;
  const t = s.tiles;
  const [ax, az, bx, bz] = normRect(g, x0, z0, x1, z1);
  let n = 0;
  for (let z = az; z <= bz; z++) {
    for (let x = ax; x <= bx; x++) {
      const i = z * s.W + x;
      if (t.marked[i] || !matches(t.feature[i], filter)) continue;
      t.marked[i] = 1;
      g.rt.marked.add(i);
      n++;
    }
  }
  if (n > 0) g.bumpFeatures();
  return n;
}

export function unmarkRect(g: Game, x0: number, z0: number, x1: number, z1: number): number {
  const s = g.state;
  const t = s.tiles;
  const [ax, az, bx, bz] = normRect(g, x0, z0, x1, z1);
  let n = 0;
  for (let z = az; z <= bz; z++) {
    for (let x = ax; x <= bx; x++) {
      const i = z * s.W + x;
      if (!t.marked[i]) continue;
      const bid = t.building[i];
      if (bid >= 0) {
        const b = g.buildingById.get(bid);
        if (b && b.state === 'clearing') continue; // required for construction
      }
      if (t.road[i] !== Road.None) continue; // roads need their tiles cleared
      t.marked[i] = 0;
      g.rt.marked.delete(i);
      n++;
    }
  }
  if (n > 0) g.bumpFeatures();
  return n;
}
