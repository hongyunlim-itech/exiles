/**
 * Shadow-caster culling by shadow footprint (render/app performance).
 *
 * three.js draws every castShadow mesh that intersects the sun's shadow frustum, but a caster only matters when its
 * shadow can land on something the camera sees. `ShadowCasterCull.install(mesh)` replaces the mesh's
 * `intersectsFrustum` so that, in the sun's shadow pass only, the mesh is also required to have its bounding sphere
 * swept down-light (to the bottom of the sphere) intersect the camera frustum. The main pass is unaffected.
 * GameRenderer refreshes the camera planes / light direction right before each render.
 */
import * as THREE from 'three';
import { createPlanes, planesFromFrustum, sphereInPlanes } from '../entities/cull';

const registry = new WeakMap<THREE.Object3D, ShadowCasterCull>();

/** Shared caster-cull state of a scene (created on first use). */
export function shadowCasterCull(scene: THREE.Object3D): ShadowCasterCull {
  let c = registry.get(scene);
  if (!c) {
    c = new ShadowCasterCull();
    registry.set(scene, c);
  }
  return c;
}

const _pv = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

export class ShadowCasterCull {
  readonly viewPlanes = createPlanes();
  /** Unit vector towards the shadow-casting light. */
  readonly light = new THREE.Vector3(0, 1, 0);
  /** The renderer's frustum object of the sun's shadow pass (identity marks that pass). */
  shadowFrustum: THREE.Frustum | null = null;
  /** False until the first update (then every caster passes). */
  active = false;
  /** Extra radius (world units) around footprints (covers the camera moving between shadow-map updates). */
  margin = 3;
  private readonly sphere = new THREE.Sphere();

  /** Refresh from the main camera and the light (call right before rendering the frame). */
  update(camera: THREE.Camera, lightDir: readonly number[], shadowFrustum: THREE.Frustum | null, margin = 3): void {
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    planesFromFrustum(_frustum, this.viewPlanes);
    this.light.set(lightDir[0], lightDir[1], lightDir[2]);
    if (this.light.lengthSq() < 1e-8) this.light.set(0, 1, 0);
    this.light.normalize();
    this.shadowFrustum = shadowFrustum;
    this.margin = margin;
    this.active = true;
  }

  /** Can the shadow of a world-space sphere land inside the camera view? */
  footprintVisible(x: number, y: number, z: number, r: number): boolean {
    const L = this.light;
    const ly = Math.max(0.2, L.y);
    const t = r / ly;
    return sphereInPlanes(this.viewPlanes, x - L.x * t, y - L.y * t, z - L.z * t, 2 * r + t + this.margin);
  }

  /** Make `mesh` skip the sun's shadow pass whenever its shadow could not be seen. */
  install(mesh: THREE.Mesh): void {
    const self = this;
    const sphere = this.sphere;
    mesh.intersectsFrustum = function (this: THREE.Mesh, f: THREE.Frustum): boolean {
      if (!f.intersectsObject(this)) return false;
      if (!self.active || f !== self.shadowFrustum) return true;
      const g = this.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (!g.boundingSphere) return true;
      sphere.copy(g.boundingSphere).applyMatrix4(this.matrixWorld);
      return self.footprintVisible(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    } as THREE.Mesh['intersectsFrustum'];
  }
}
