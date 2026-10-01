/**
 * Allocation-free frustum culling & LOD helpers for per-instance culling (nature). Pure math — unit-testable.
 *
 * Planes are stored as a flat Float32Array(24): (nx, ny, nz, c) × 6, a point p is inside when n·p + c ≥ 0 for all
 * six planes (three.js Frustum convention).
 */
import type * as THREE from 'three';

export type Planes = Float32Array;

export function createPlanes(): Planes {
  return new Float32Array(24);
}

/** Copy a THREE.Frustum's planes into the flat array. */
export function planesFromFrustum(f: THREE.Frustum, out: Planes): Planes {
  for (let i = 0; i < 6; i++) {
    const p = f.planes[i];
    out[i * 4] = p.normal.x;
    out[i * 4 + 1] = p.normal.y;
    out[i * 4 + 2] = p.normal.z;
    out[i * 4 + 3] = p.constant;
  }
  return out;
}

/** True when the sphere (x, y, z, r) intersects the frustum. */
export function sphereInPlanes(pl: Planes, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 24; i += 4) {
    if (pl[i] * x + pl[i + 1] * y + pl[i + 2] * z + pl[i + 3] < -r) return false;
  }
  return true;
}

/** True when the AABB intersects the frustum (conservative p-vertex test). */
export function boxInPlanes(
  pl: Planes, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): boolean {
  for (let i = 0; i < 24; i += 4) {
    const nx = pl[i];
    const ny = pl[i + 1];
    const nz = pl[i + 2];
    const px = nx > 0 ? x1 : x0;
    const py = ny > 0 ? y1 : y0;
    const pz = nz > 0 ? z1 : z0;
    if (nx * px + ny * py + nz * pz + pl[i + 3] < 0) return false;
  }
  return true;
}

/** Distance thresholds (camera → instance) of the nature LODs for a quality tier. */
export interface NatureLod {
  /** Trees closer than this use the full model (LOD 0). */
  lod0: number;
  /** Trees closer than this use the reduced model (LOD 1); beyond: far model (LOD 2, no shadow). */
  lod1: number;
  /** Tree shadows use the full model closer than this, the LOD 1 silhouette closer than shadowLod1, else LOD 2. */
  shadowLod0: number;
  shadowLod1: number;
  /** Rocks/iron cast shadows closer than this. */
  rockShadow: number;
}

export function natureLodFor(quality: 'low' | 'medium' | 'high'): NatureLod {
  if (quality === 'high') return { lod0: 58, lod1: 135, shadowLod0: 30, shadowLod1: 75, rockShadow: 60 };
  if (quality === 'medium') return { lod0: 42, lod1: 105, shadowLod0: 20, shadowLod1: 55, rockShadow: 45 };
  return { lod0: 0, lod1: 80, shadowLod0: 0, shadowLod1: 0, rockShadow: 0 };
}

/**
 * Should small props (citizens, animals, low crops) cast shadows at this camera distance? Their shadows are a few
 * pixels when zoomed out, so they only cast when the camera is close. Hysteresis (±2) avoids flicker while zooming.
 */
export function smallPropShadows(cameraDistance: number, quality: 'low' | 'medium' | 'high', prev: boolean): boolean {
  if (quality === 'low') return false;
  const limit = quality === 'high' ? 34 : 26;
  return prev ? cameraDistance < limit + 2 : cameraDistance < limit - 2;
}

/** Camera frustum planes of a perspective camera (current matrices). */
export function cameraPlanes(camera: THREE.Camera, frustum: THREE.Frustum, pv: THREE.Matrix4, out: Planes): Planes {
  pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(pv);
  return planesFromFrustum(frustum, out);
}

/** LOD level of a tree at camera distance d (0 = full, 1 = reduced, 2 = far). */
export function treeLodAt(d: number, lod: NatureLod): 0 | 1 | 2 {
  return d < lod.lod0 ? 0 : d < lod.lod1 ? 1 : 2;
}
