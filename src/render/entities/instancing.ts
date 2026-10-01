/**
 * Helpers for InstancedMeshes whose base geometry attributes are SHARED between many meshes (chunks, LODs) while each
 * mesh owns its per-instance attributes.
 *
 * Important: BufferGeometry.dispose() frees the GL buffers of every attribute on the geometry — including shared ones,
 * which would break other meshes' VAOs. Always dispose instance geometries through `disposeInstanceGeometry`.
 */
import * as THREE from 'three';

/** Tag on geometries created by `shareGeometry` listing the attribute names borrowed from the base. */
const SHARED_KEY = '__sharedAttrs';

/** New geometry that borrows all attributes of `base` (no copies) and bounding volumes. */
export function shareGeometry(base: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const names: string[] = [];
  for (const name of Object.keys(base.attributes)) {
    g.setAttribute(name, base.attributes[name]);
    names.push(name);
  }
  if (base.index) g.setIndex(base.index);
  if (!base.boundingSphere) base.computeBoundingSphere();
  if (!base.boundingBox) base.computeBoundingBox();
  g.boundingSphere = base.boundingSphere!.clone();
  g.boundingBox = base.boundingBox!.clone();
  g.userData[SHARED_KEY] = names;
  return g;
}

/** Dispose a geometry created by `shareGeometry` without freeing the shared base buffers. */
export function disposeInstanceGeometry(g: THREE.BufferGeometry): void {
  const names = g.userData[SHARED_KEY] as string[] | undefined;
  if (names) {
    for (const n of names) g.deleteAttribute(n);
    g.setIndex(null);
  }
  g.dispose();
}

/** Round a required instance count up to a comfortable capacity. */
export function capacityFor(n: number, min = 16): number {
  let c = min;
  while (c < n) c *= 2;
  return c;
}

/**
 * An InstancedMesh wrapper that can grow its capacity (recreating the mesh) and draw a dynamic count.
 * Per-instance extra attributes are declared up front by name & item size.
 */
export class GrowableInstances {
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Extra per-instance attributes (live on the instance geometry). */
  readonly extras: Record<string, THREE.InstancedBufferAttribute> = {};
  private readonly bases: THREE.BufferGeometry[];
  private lodIndex = 0;
  private shadowEnabled = true;
  private geos: THREE.BufferGeometry[] = [];
  private readonly extraNames: string[];

  constructor(
    private readonly parent: THREE.Object3D,
    /** One base geometry per LOD level (index 0 = highest detail). */
    bases: THREE.BufferGeometry | THREE.BufferGeometry[],
    private readonly material: THREE.Material,
    private readonly extraDefs: Record<string, number>,
    initialCapacity: number,
    private readonly opts: {
      castShadow?: boolean;
      receiveShadow?: boolean;
      depthMaterial?: THREE.Material | null;
      dynamic?: boolean;
      instanceColor?: boolean;
      frustumCulled?: boolean;
      renderOrder?: number;
      /** Upload only the committed range even for dynamic meshes (large sets refilled occasionally). */
      ranged?: boolean;
      /** Called with every (re)created mesh (e.g. to install a custom intersectsFrustum pass filter). */
      onMesh?: (mesh: THREE.InstancedMesh) => void;
    } = {},
  ) {
    this.bases = Array.isArray(bases) ? bases : [bases];
    this.extraNames = Object.keys(extraDefs);
    this.capacity = capacityFor(initialCapacity);
    this.mesh = this.create(this.capacity);
  }

  private create(cap: number): THREE.InstancedMesh {
    this.geos = this.bases.map((b) => shareGeometry(b));
    for (const name of this.extraNames) {
      const size = this.extraDefs[name];
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      if (this.opts.dynamic) attr.setUsage(THREE.DynamicDrawUsage);
      this.extras[name] = attr;
      for (const g of this.geos) g.setAttribute(name, attr);
    }
    const mesh = new THREE.InstancedMesh(this.geos[this.lodIndex], this.material, cap);
    mesh.count = 0;
    mesh.visible = false; // no empty instanced draw calls until something is committed
    if (this.opts.dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.opts.instanceColor) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      if (this.opts.dynamic) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    mesh.castShadow = !!this.opts.castShadow && this.shadowEnabled;
    mesh.receiveShadow = !!this.opts.receiveShadow;
    if (this.opts.depthMaterial) mesh.customDepthMaterial = this.opts.depthMaterial;
    mesh.frustumCulled = this.opts.frustumCulled ?? false;
    if (this.opts.renderOrder !== undefined) mesh.renderOrder = this.opts.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.opts.onMesh?.(mesh);
    this.parent.add(mesh);
    return mesh;
  }

  /** Make sure at least n instances fit (recreates the mesh when growing; contents are NOT preserved). */
  ensure(n: number): void {
    if (n <= this.capacity) return;
    this.destroyMesh();
    this.capacity = capacityFor(n, this.capacity * 2);
    this.mesh = this.create(this.capacity);
  }

  /** Enable/disable shadow casting at runtime (only meshes created with castShadow ever cast). */
  setShadowEnabled(on: boolean): void {
    this.shadowEnabled = on;
    this.mesh.castShadow = !!this.opts.castShadow && on;
  }

  /** Switch LOD level (0..bases-1). */
  setLod(level: number): void {
    const l = Math.max(0, Math.min(this.geos.length - 1, level));
    if (l === this.lodIndex) return;
    this.lodIndex = l;
    this.mesh.geometry = this.geos[l];
  }

  get lod(): number {
    return this.lodIndex;
  }

  get matrixArray(): Float32Array {
    return this.mesh.instanceMatrix.array as Float32Array;
  }

  get colorArray(): Float32Array | null {
    return (this.mesh.instanceColor?.array as Float32Array | undefined) ?? null;
  }

  /** Set the drawn count and flag the first n instances of every attribute for upload. */
  commit(n: number, computeBounds = false): void {
    const m = this.mesh;
    m.count = n;
    m.visible = n > 0;
    if (n === 0) return;
    // Dynamic meshes re-upload whole buffers (no per-frame range objects); static ones upload only the used range.
    const ranged = !this.opts.dynamic || !!this.opts.ranged;
    markRange(m.instanceMatrix, n, ranged);
    if (m.instanceColor) markRange(m.instanceColor, n, ranged);
    for (let i = 0; i < this.extraNames.length; i++) markRange(this.extras[this.extraNames[i]], n, ranged);
    if (computeBounds) m.computeBoundingSphere();
  }

  private destroyMesh(): void {
    this.parent.remove(this.mesh);
    for (const g of this.geos) disposeInstanceGeometry(g);
    this.mesh.dispose();
  }

  dispose(): void {
    this.destroyMesh();
  }
}

function markRange(attr: THREE.BufferAttribute | THREE.InstancedBufferAttribute, n: number, ranged: boolean): void {
  attr.clearUpdateRanges();
  if (ranged) attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
}
