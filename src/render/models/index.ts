/**
 * Procedural low-poly building models. OWNER: render-models agent.
 *
 * Model space convention: origin at the footprint CENTER, ground at y = 0, door facing +Z,
 * footprint spans x in [-w/2, w/2], z in [-h/2, h/2] where (w, h) are the UNROTATED dimensions
 * (def.size for fixed buildings; the chosen size for resizable zones). The caller applies rotationAngle().
 *
 * Every model is ONE merged, flat-shaded, vertex-coloured geometry (one draw call) rendered with the shared
 * building material (snow on roofs, night window glow, char/reveal support — see material.ts). Geometries of
 * fixed-size buildings are cached per (type, variant); zone geometries (resizable) are built per instance.
 */
import * as THREE from 'three';
import { BUILDINGS } from '../../core/defs';
import type { Building, BuildingType } from '../../core/types';
import { ModelBuilder } from './builder';
import { isSharedMaterial, sharedLitMaterial } from './material';
import { MODEL_FNS } from './registry';
import type { BodyBox, ModelSpec } from './spec';

export interface BuildingModel {
  root: THREE.Group;
  /** Local-space chimney tops (for smoke). */
  chimneys: THREE.Vector3[];
  /** Local-space height of the tallest point (for labels/fire). */
  height: number;
  // ---- additions (render-models) ----
  /** The single merged mesh of the model (child of root). */
  mesh: THREE.Mesh;
  type: BuildingType;
  /** Unrotated footprint dims the model was built for. */
  w: number;
  h: number;
  /** Main structure bounds (model space) — scaffolding, fire anchors. */
  body: BodyBox;
  /** Goods display slots (market / trading post), model space. */
  slots: THREE.Vector3[];
  /** Merchant boat mooring (trading post), model space. */
  boat: { x: number; z: number; ry: number } | null;
  /** Fire emitter points (model space). */
  fires: THREE.Vector3[];
  /** Whether the geometry is shared with other models (never mutate shared geometry). */
  sharedGeometry: boolean;
}

interface ModelData {
  geometry: THREE.BufferGeometry;
  spec: ModelSpec;
  height: number;
}

const geometryCache = new Map<string, ModelData>();
const sharedGeometries = new WeakSet<THREE.BufferGeometry>();

const TYPE_INDEX: Record<string, number> = {};
Object.keys(MODEL_FNS).forEach((t, i) => (TYPE_INDEX[t] = i + 1));

/** Deterministic small variant index (0..2) from a seed. */
export function variantOf(seed: number): number {
  let h = Math.imul((seed | 0) ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  return ((h >>> 0) % 3) as number;
}

/** True for resizable zones (fields, stockpiles, pastures, orchards, cemeteries). */
export function isZoneType(type: BuildingType): boolean {
  return !!BUILDINGS[type].resizable;
}

/** Unrotated model dims for a placed building (rotation 1/3 swap w/h). */
export function modelDims(b: Pick<Building, 'w' | 'h' | 'rotation'>): [number, number] {
  return b.rotation % 2 === 1 ? [b.h, b.w] : [b.w, b.h];
}

function runModel(type: BuildingType, w: number, h: number, seed: number, variant: number): ModelData {
  const b = new ModelBuilder(Math.imul(seed | 0, 2654435761) ^ (TYPE_INDEX[type] * 7919));
  const spec = MODEL_FNS[type](b, { w, h, seed, variant });
  const geometry = b.build();
  geometry.name = `model:${type}:${w}x${h}:${variant}`;
  return { geometry, spec, height: Math.max(0.3, b.maxY) };
}

/** Geometry + metadata for a model. Fixed-size types are cached per variant; zones are built fresh. */
export function getModelData(type: BuildingType, w: number, h: number, seed: number): { data: ModelData; shared: boolean } {
  const variant = variantOf(seed);
  if (isZoneType(type)) {
    return { data: runModel(type, w, h, seed, variant), shared: false };
  }
  const key = `${type}|${w}x${h}|${variant}`;
  let data = geometryCache.get(key);
  if (!data) {
    data = runModel(type, w, h, variant + 1, variant);
    geometryCache.set(key, data);
    sharedGeometries.add(data.geometry);
  }
  return { data, shared: true };
}

function defaultFires(body: BodyBox): THREE.Vector3[] {
  const cx = (body.minX + body.maxX) / 2;
  const cz = (body.minZ + body.maxZ) / 2;
  const sx = body.maxX - body.minX;
  const sz = body.maxZ - body.minZ;
  const y = Math.max(0.3, body.top * 0.85);
  const out = [new THREE.Vector3(cx, y + 0.2, cz)];
  if (sx * sz > 5) {
    out.push(new THREE.Vector3(cx - sx * 0.28, y, cz - sz * 0.25));
    out.push(new THREE.Vector3(cx + sx * 0.28, y, cz + sz * 0.25));
  }
  if (sx * sz > 12) out.push(new THREE.Vector3(cx + sx * 0.3, y * 0.8, cz - sz * 0.3));
  return out;
}

/** Build a finished building model. `seed` varies details (roof colour, clutter) deterministically. */
export function createBuildingModel(type: BuildingType, w: number, h: number, seed: number): BuildingModel {
  const { data, shared } = getModelData(type, w, h, seed);
  const mesh = new THREE.Mesh(data.geometry, sharedLitMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `building-mesh:${type}`;
  const root = new THREE.Group();
  root.name = `building:${type}`;
  root.add(mesh);
  const spec = data.spec;
  return {
    root,
    mesh,
    chimneys: spec.chimneys.map((v) => v.clone()),
    height: data.height,
    type,
    w,
    h,
    body: { ...spec.body },
    slots: (spec.slots ?? []).map((v) => v.clone()),
    boat: spec.boat ? { ...spec.boat } : null,
    fires: (spec.fires ?? defaultFires(spec.body)).map((v) => v.clone()),
    sharedGeometry: shared,
  };
}

const GHOST_OK = new THREE.Color(0.7, 1.0, 0.72);
const GHOST_BAD = new THREE.Color(1.0, 0.5, 0.45);
const GHOST_OK_EMISSIVE = new THREE.Color(0x0c2a10);
const GHOST_BAD_EMISSIVE = new THREE.Color(0x3a0c08);

/**
 * Translucent placement ghost (cloned materials, transparent, depthWrite false, no shadows).
 * Same model-space convention. Call setGhostValid to tint green/red.
 */
export function createGhostModel(type: BuildingType, w: number, h: number): THREE.Group {
  const { data } = getModelData(type, w, h, 1);
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(data.geometry, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 20;
  mesh.name = `ghost-mesh:${type}`;
  const root = new THREE.Group();
  root.name = `ghost:${type}`;
  root.add(mesh);
  root.userData.ghostMaterial = mat;
  setGhostValid(root, true);
  return root;
}

export function setGhostValid(ghost: THREE.Group, valid: boolean): void {
  const mat = ghost.userData.ghostMaterial as THREE.MeshLambertMaterial | undefined;
  if (!mat) {
    ghost.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (m && 'emissive' in m) {
        m.color.copy(valid ? GHOST_OK : GHOST_BAD);
        m.emissive.copy(valid ? GHOST_OK_EMISSIVE : GHOST_BAD_EMISSIVE);
      }
    });
    return;
  }
  if (ghost.userData.ghostValid === valid) return;
  ghost.userData.ghostValid = valid;
  mat.color.copy(valid ? GHOST_OK : GHOST_BAD);
  mat.emissive.copy(valid ? GHOST_OK_EMISSIVE : GHOST_BAD_EMISSIVE);
}

/** True if the geometry belongs to a shared cache (must not be disposed or mutated). */
export function isSharedGeometry(g: THREE.BufferGeometry): boolean {
  return sharedGeometries.has(g);
}

/** Register a geometry as shared (e.g. extras caches) so disposeModel leaves it alone. */
export function markSharedGeometry(g: THREE.BufferGeometry): void {
  sharedGeometries.add(g);
}

/** Dispose geometries/materials created for a model (shared caches must not be disposed). */
export function disposeModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !sharedGeometries.has(mesh.geometry)) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || isSharedMaterial(m) || m.userData?.sharedModelMaterial) continue;
      const depth = m.userData?.depth as THREE.Material | undefined;
      depth?.dispose();
      m.dispose();
    }
    const cd = mesh.customDepthMaterial;
    if (cd && !cd.userData?.sharedModelMaterial) cd.dispose();
  });
}

/** Drop all cached geometries (e.g. on full renderer teardown). */
export function clearModelCache(): void {
  for (const d of geometryCache.values()) d.geometry.dispose();
  geometryCache.clear();
}

export type { BodyBox, ModelSpec } from './spec';
