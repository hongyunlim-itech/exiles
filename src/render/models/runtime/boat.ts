/**
 * MerchantBoatLayer — the trading cog moored at the trading post while `state.trade.merchant` is present.
 * `merchant.arrive` (0..1) sails it in from open water (model -Z of the post); when the merchant leaves the boat
 * sails away over a few seconds. Gentle bob & roll on the water.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../../../core/constants';
import type { GameState } from '../../../core/types';
import { merchantBoatGeometry } from '../extras';
import type { BuildingMaterial } from '../material';
import type { BuildingVisual } from './visual';

const SAIL_DISTANCE = 16;
const DEPART_SECONDS = 7;

const _v = new THREE.Vector3();

export class MerchantBoatLayer {
  readonly mesh: THREE.Mesh;
  private merchantId = -1;
  /** Pose of the mooring (world) for departure animation. */
  private readonly moor = new THREE.Vector3();
  private readonly out = new THREE.Vector3();
  private heading = 0;
  private departT = -1;

  constructor(material: BuildingMaterial) {
    this.mesh = new THREE.Mesh(merchantBoatGeometry(), material);
    this.mesh.name = 'merchant-boat';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  reset(): void {
    this.merchantId = -1;
    this.departT = -1;
    this.mesh.visible = false;
  }

  update(s: GameState, visuals: Map<number, BuildingVisual>, time: number, dt: number): void {
    const m = s.trade?.merchant ?? null;
    const post = m ? visuals.get(m.postId) : undefined;
    if (m && post && post.model.boat && post.building.state === 'active') {
      this.merchantId = m.id;
      this.departT = -1;
      const bt = post.model.boat;
      post.toWorld(_v.set(bt.x, 0, bt.z), this.moor);
      post.toWorld(_v.set(bt.x, 0, bt.z - SAIL_DISTANCE), this.out);
      this.heading = post.group.rotation.y + bt.ry;
      const a = Math.max(0, Math.min(1, m.arrive));
      const e = 1 - Math.pow(1 - a, 3);
      this.pose(this.out.x + (this.moor.x - this.out.x) * e, this.out.z + (this.moor.z - this.out.z) * e, time, 1 - e);
      return;
    }
    if (this.merchantId !== -1 && this.mesh.visible) {
      // merchant left: sail away (turn around and go out)
      if (this.departT < 0) this.departT = 0;
      this.departT += dt;
      const t = Math.min(1, this.departT / DEPART_SECONDS);
      const e = t * t;
      this.pose(this.moor.x + (this.out.x - this.moor.x) * e, this.moor.z + (this.out.z - this.moor.z) * e, time, e);
      if (t >= 1) {
        this.mesh.visible = false;
        this.merchantId = -1;
        this.departT = -1;
      }
      return;
    }
    this.mesh.visible = false;
  }

  private pose(x: number, z: number, time: number, moving: number): void {
    const bob = Math.sin(time * 1.3) * 0.035 + Math.sin(time * 2.1 + 1) * 0.015;
    this.mesh.position.set(x, WATER_LEVEL - 0.04 + bob, z);
    this.mesh.rotation.set(Math.sin(time * 0.8) * 0.02 + moving * 0.02, this.heading, Math.sin(time * 1.1) * 0.035);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}
