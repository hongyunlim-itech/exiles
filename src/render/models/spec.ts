/**
 * Model function contract: each building type has a ModelFn that emits parts into a ModelBuilder (model space:
 * origin at footprint centre, ground y = 0, door toward +Z, footprint x ∈ [-w/2, w/2], z ∈ [-h/2, h/2]) and
 * returns metadata used by the BuildingRenderer.
 */
import type * as THREE from 'three';
import type { ModelBuilder } from './builder';

/** Axis-aligned bounds of the main structure (for scaffolding / fire anchors). */
export interface BodyBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Top of the walls / main mass (scaffolding height). */
  top: number;
}

export interface ModelSpec {
  /** Smoke emission points (model space). */
  chimneys: THREE.Vector3[];
  /** Main structure bounds. */
  body: BodyBox;
  /** Goods display slots (market stalls, trading post yard) — top surface points. */
  slots?: THREE.Vector3[];
  /** Merchant boat mooring (trading post): model-space position (at the waterline) & heading. */
  boat?: { x: number; z: number; ry: number };
  /** Fire emitter points (model space). Defaults are derived from `body`. */
  fires?: THREE.Vector3[];
}

export interface ModelCtx {
  /** Unrotated footprint size. */
  w: number;
  h: number;
  seed: number;
  /** Small deterministic variant index derived from the seed (0..2). */
  variant: number;
}

export type ModelFn = (b: ModelBuilder, ctx: ModelCtx) => ModelSpec;

export function body(minX: number, maxX: number, minZ: number, maxZ: number, top: number): BodyBox {
  return { minX, maxX, minZ, maxZ, top };
}

/** Body box centred at (x, z) with size (sx, sz). */
export function bodyC(x: number, z: number, sx: number, sz: number, top: number): BodyBox {
  return { minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2, top };
}
