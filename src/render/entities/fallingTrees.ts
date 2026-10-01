/**
 * Short-lived "timber!" animations for trees that were just cut down: the tree tips over around its base, bounces,
 * then sinks away. One small dynamic InstancedMesh per species; zero per-frame allocations.
 */
import * as THREE from 'three';
import { GrowableInstances } from './instancing';
import { clamp01, easeIn } from './math';

const FALL_TIME = 1.25;
const REST_TIME = 0.45;
const SINK_TIME = 0.8;
const TOTAL = FALL_TIME + REST_TIME + SINK_TIME;
const MAX_ACTIVE = 24;

interface Faller {
  active: boolean;
  species: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  dirX: number;
  dirZ: number;
  t: number;
  inst: [number, number, number, number];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class FallingTrees {
  private sets: GrowableInstances[] = [];
  private pool: Faller[] = [];
  private counts = [0, 0, 0];

  constructor(
    parent: THREE.Object3D,
    bases: THREE.BufferGeometry[],
    materials: THREE.Material[],
    depthMaterials: (THREE.Material | null)[],
  ) {
    for (let sp = 0; sp < bases.length; sp++) {
      this.sets.push(new GrowableInstances(parent, bases[sp], materials[sp], { aInst: 4 }, MAX_ACTIVE, {
        castShadow: true, receiveShadow: true, depthMaterial: depthMaterials[sp], dynamic: true,
      }));
    }
    for (let i = 0; i < MAX_ACTIVE; i++) {
      this.pool.push({
        active: false, species: 0, x: 0, y: 0, z: 0, yaw: 0, sx: 1, sy: 1, sz: 1, dirX: 1, dirZ: 0, t: 0, inst: [0, 0, 1, 0],
      });
    }
  }

  /** Start a falling animation. Silently ignored when the pool is exhausted. */
  spawn(
    species: number, x: number, y: number, z: number, yaw: number,
    sx: number, sy: number, sz: number, fallAngle: number,
    variation: number, growth: number, stagger: number,
  ): void {
    for (let i = 0; i < this.pool.length; i++) {
      const f = this.pool[i];
      if (f.active) continue;
      f.active = true;
      f.species = species;
      f.x = x;
      f.y = y;
      f.z = z;
      f.yaw = yaw;
      f.sx = sx;
      f.sy = sy;
      f.sz = sz;
      f.dirX = Math.cos(fallAngle);
      f.dirZ = Math.sin(fallAngle);
      f.t = 0;
      f.inst[0] = variation;
      f.inst[1] = 0;
      f.inst[2] = growth;
      f.inst[3] = stagger;
      return;
    }
  }

  clear(): void {
    for (const f of this.pool) f.active = false;
    for (const s of this.sets) s.commit(0);
  }

  update(dt: number): void {
    this.counts[0] = this.counts[1] = this.counts[2] = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const f = this.pool[i];
      if (!f.active) continue;
      f.t += dt;
      if (f.t >= TOTAL) {
        f.active = false;
        continue;
      }
      let angle: number;
      let sink = 0;
      let shrink = 1;
      if (f.t < FALL_TIME) {
        angle = (Math.PI / 2 - 0.08) * easeIn(f.t / FALL_TIME);
      } else if (f.t < FALL_TIME + REST_TIME) {
        const u = (f.t - FALL_TIME) / REST_TIME;
        angle = Math.PI / 2 - 0.08 - Math.sin(u * Math.PI) * 0.07 * (1 - u);
      } else {
        const u = clamp01((f.t - FALL_TIME - REST_TIME) / SINK_TIME);
        angle = Math.PI / 2 - 0.08;
        sink = u * 0.25;
        shrink = 1 - u;
      }
      _axis.set(f.dirZ, 0, -f.dirX).normalize();
      _q.setFromAxisAngle(_axis, angle);
      _qYaw.setFromAxisAngle(_up, f.yaw);
      _q.multiply(_qYaw);
      _p.set(f.x, f.y - sink, f.z);
      _s.set(f.sx * shrink, f.sy * shrink, f.sz * shrink);
      _m.compose(_p, _q, _s);
      const set = this.sets[f.species];
      const n = this.counts[f.species]++;
      _m.toArray(set.matrixArray, n * 16);
      const ia = set.extras.aInst.array as Float32Array;
      ia[n * 4] = f.inst[0];
      ia[n * 4 + 1] = f.inst[1];
      ia[n * 4 + 2] = f.inst[2];
      ia[n * 4 + 3] = f.inst[3];
    }
    for (let sp = 0; sp < this.sets.length; sp++) this.sets[sp].commit(this.counts[sp]);
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.sets = [];
  }
}
