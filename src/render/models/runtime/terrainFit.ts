/**
 * Ground placement helpers: base height of a building, model↔world transforms, and terrain conforming of
 * zone geometry (fences, graves, stakes follow the ground vertex by vertex).
 */
import type * as THREE from 'three';
import { BUILDINGS } from '../../../core/defs';
import { WATER_LEVEL } from '../../../core/constants';
import type { Building, GameState } from '../../../core/types';
import { cornerHeight, heightAt, isLandTerrain, rotationAngle, tileHeight } from '../../../core/world';
import { computeFlatNormals } from '../builder';

/** Ground height the model origin is placed at. */
export function computeBaseY(s: GameState, b: Building): number {
  const def = BUILDINGS[b.type];
  if (def.resizable) {
    let sum = 0;
    let n = 0;
    for (let z = b.z; z <= b.z + b.h; z++) {
      for (let x = b.x; x <= b.x + b.w; x++) {
        sum += cornerHeight(s, x, z);
        n++;
      }
    }
    return n ? sum / n : 0;
  }
  if (def.placement === 'shore') {
    let best = -Infinity;
    for (let z = b.z; z < b.z + b.h; z++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
        if (!isLandTerrain(s.tiles.terrain[z * s.W + x])) continue;
        best = Math.max(best, tileHeight(s, x, z));
      }
    }
    if (!Number.isFinite(best)) best = WATER_LEVEL + 0.15;
    return Math.max(best, WATER_LEVEL + 0.12);
  }
  let max = -Infinity;
  for (let z = b.z; z <= b.z + b.h; z++) {
    for (let x = b.x; x <= b.x + b.w; x++) max = Math.max(max, cornerHeight(s, x, z));
  }
  return Number.isFinite(max) ? max : 0;
}

/** World-space footprint centre. */
export function footprintCenter(b: Building): [number, number] {
  return [b.x + b.w / 2, b.z + b.h / 2];
}

/**
 * Displace a zone geometry so every vertex sits at `local y + terrain(wx, wz) - baseY` — posts stay vertical,
 * rails follow the slope. `basePositions` holds the undisplaced positions.
 */
export function conformGeometry(
  s: GameState, geometry: THREE.BufferGeometry, basePositions: Float32Array, b: Building, baseY: number, lift = 0,
): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const [cx, cz] = footprintCenter(b);
  const a = rotationAngle(b.rotation);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  for (let i = 0; i < basePositions.length; i += 3) {
    const lx = basePositions[i];
    const lz = basePositions[i + 2];
    const wx = cx + lx * cos + lz * sin;
    const wz = cz - lx * sin + lz * cos;
    arr[i] = lx;
    arr[i + 1] = basePositions[i + 1] + heightAt(s, wx, wz) - baseY + lift;
    arr[i + 2] = lz;
  }
  pos.needsUpdate = true;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nrm) {
    (nrm.array as Float32Array).set(computeFlatNormals(arr));
    nrm.needsUpdate = true;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
