/**
 * Wild deer (state.animals) and pasture livestock (drawn from Building.livestock.count, wandering inside the pasture).
 * OWNER: render-entities agent.
 *
 * Each species is drawn with instanced parts (body, head, legs, antlers) using a coat-tint material; the joint
 * hierarchy is evaluated per frame on the CPU without allocations. Livestock positions are purely visual and are
 * simulated render-side (entities/livestockSim.ts) inside each pasture's footprint.
 */
import * as THREE from 'three';
import { LIVESTOCK } from '../core/defs';
import type { Building, LivestockType } from '../core/types';
import type { Game } from '../sim/game';
import {
  buildCattle, buildChicken, buildDeer, buildSheep, type AnimalSpeciesModel,
} from './entities/animalModels';
import { createEntityMaterial, createEnvUniforms } from './entities/entityMaterial';
import { cameraPlanes, createPlanes, smallPropShadows, sphereInPlanes } from './entities/cull';
import { entityGroundY } from './entities/ground';
import { GrowableInstances } from './entities/instancing';
import { Herd, type PastureBounds } from './entities/livestockSim';
import { damp, fract, hashId, lerpAngle, TAU } from './entities/math';
import type { FrameContext, SubRenderer } from './types';

type SpeciesKey = 'deer' | LivestockType;
const SPECIES: SpeciesKey[] = ['deer', 'sheep', 'cattle', 'chicken'];
const LIVESTOCK_TYPES: LivestockType[] = ['sheep', 'cattle', 'chicken'];

function pastureBounds(b: Building, type: LivestockType, out: PastureBounds): void {
  const margin = type === 'chicken' ? 0.35 : 0.6;
  out.x0 = b.x + margin;
  out.z0 = b.z + margin;
  out.x1 = Math.max(out.x0, b.x + b.w - margin);
  out.z1 = Math.max(out.z0, b.z + b.h - margin);
}

const COATS: Record<SpeciesKey, number[]> = {
  deer: [0x8b6440, 0x7d5a3a, 0x94704a, 0x86603c],
  sheep: [0xf0ede4, 0xe8e2d4, 0xf4f0e8, 0xded6c4, 0xece6da, 0x3a3430],
  cattle: [0x6b4a33, 0x6b4a33, 0x3a2e28, 0x9a6a3a, 0xd8d0c0, 0x8a4a2a],
  chicken: [0xf5f0e6, 0xa8683a, 0x2e2a28, 0xd8c8a8, 0xf0e8d8],
};

interface SpeciesSet {
  model: AnimalSpeciesModel;
  body: GrowableInstances;
  head: GrowableInstances;
  leg: GrowableInstances;
  extra: GrowableInstances | null;
  coats: Float32Array; // linear rgb triplets
  n: number;
  legN: number;
  extraN: number;
}

interface DeerState {
  px: number;
  pz: number;
  heading: number;
  phase: number;
  t: number;
  headDown: number;
  speed: number;
  seen: number;
  init: boolean;
  buck: boolean;
  coat: number;
  seed: number;
}

const _root = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _loc = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();

/** local = T · Ry(ay) · Rz(az) */
function localYZ(out: THREE.Matrix4, px: number, py: number, pz: number, ay: number, az: number): THREE.Matrix4 {
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  return out.set(
    cy * cz, -cy * sz, sy, px,
    sz, cz, 0, py,
    -sy * cz, sy * sz, cy, pz,
    0, 0, 0, 1,
  );
}

export class AnimalRenderer implements SubRenderer {
  private game: Game;
  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly env = createEnvUniforms();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly sets = new Map<SpeciesKey, SpeciesSet>();
  private readonly deer = new Map<number, DeerState>();
  private readonly herds = new Map<number, Herd>();
  private pastureIds: number[] = [];
  private pastureRev = -1;
  private frame = 0;
  private readonly bounds: PastureBounds = { x0: 0, z0: 0, x1: 0, z1: 0 };
  private readonly livestockTotals: Record<LivestockType, number> = { sheep: 0, cattle: 0, chicken: 0 };
  private readonly setList: SpeciesSet[] = [];
  /** View-frustum planes of the current frame (animals outside are not posed/drawn). */
  private readonly planes = createPlanes();
  private shadows = true;
  private readonly pruneDeer = (ds: DeerState, id: number): void => {
    if (ds.seen !== this.frame) this.deer.delete(id);
  };
  private readonly pruneHerd = (_h: Herd, id: number): void => {
    if (!this.building(id)) this.herds.delete(id);
  };

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.root.name = 'animals';
    scene.add(this.root);
    this.material = createEntityMaterial(this.env, { key: 'animal', parts: true, tint: true, coat: true }).material;
    const builders: Record<SpeciesKey, () => AnimalSpeciesModel> = {
      deer: buildDeer, sheep: buildSheep, cattle: buildCattle, chicken: buildChicken,
    };
    for (const sp of SPECIES) {
      const model = builders[sp]();
      const mk = (g: THREE.BufferGeometry, cap: number, shadow: boolean) =>
        new GrowableInstances(this.root, g, this.material, { aTint: 3 }, cap, { dynamic: true, castShadow: shadow, receiveShadow: true });
      const coats = new Float32Array(COATS[sp].length * 3);
      const c = new THREE.Color();
      COATS[sp].forEach((hex, i) => {
        c.setHex(hex);
        coats[i * 3] = c.r;
        coats[i * 3 + 1] = c.g;
        coats[i * 3 + 2] = c.b;
      });
      this.sets.set(sp, {
        model,
        body: mk(model.body, 32, true),
        head: mk(model.head, 32, true),
        leg: mk(model.leg, 128, sp !== 'chicken'),
        extra: model.extra ? mk(model.extra, 16, false) : null,
        coats, n: 0, legN: 0, extraN: 0,
      });
      this.setList.push(this.sets.get(sp)!);
    }
  }

  setGame(game: Game): void {
    this.game = game;
    this.deer.clear();
    this.herds.clear();
    this.pastureIds = [];
    this.pastureRev = -1;
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    this.frame++;
    const dt = Math.min(ctx.realDt, 0.1);
    const gdt = Math.min(ctx.gameDt, 0.5);
    const wantShadows = smallPropShadows(ctx.cameraDistance, ctx.quality, this.shadows);
    for (let i = 0; i < this.setList.length; i++) {
      const set = this.setList[i];
      set.n = set.legN = set.extraN = 0;
      if (wantShadows !== this.shadows) {
        set.body.setShadowEnabled(wantShadows);
        set.head.setShadowEnabled(wantShadows);
        set.leg.setShadowEnabled(wantShadows);
        set.extra?.setShadowEnabled(wantShadows);
      }
    }
    this.shadows = wantShadows;
    cameraPlanes(ctx.camera, _frustum, _pv, this.planes);

    // ---- wild deer ----
    const deerSet = this.sets.get('deer')!;
    const animals = s.animals;
    this.ensure(deerSet, animals.length);
    for (let i = 0; i < animals.length; i++) {
      const a = animals[i];
      let ds = this.deer.get(a.id);
      if (!ds) {
        ds = {
          px: a.x, pz: a.z, heading: a.heading, phase: 0, t: hashId(a.id, 3) * 20, headDown: 0, speed: 0, seen: 0,
          init: false, buck: hashId(a.id, 1) < 0.4, coat: Math.floor(hashId(a.id, 2) * COATS.deer.length), seed: hashId(a.id, 4),
        };
        this.deer.set(a.id, ds);
      }
      ds.seen = this.frame;
      const dx = a.x - ds.px;
      const dz = a.z - ds.pz;
      const moved = Math.sqrt(dx * dx + dz * dz);
      ds.px = a.x;
      ds.pz = a.z;
      const teleport = moved > 3;
      const moving = !teleport && (a.moving || moved > 0.004);
      const target = moving && moved > 1e-4 ? Math.atan2(dz, dx) : a.heading;
      ds.heading = ds.init && !teleport ? lerpAngle(ds.heading, target, damp(8, dt)) : target;
      ds.init = true;
      if (dt > 0 && !teleport) ds.speed += (moved / Math.max(dt, 1e-3) - ds.speed) * damp(6, dt);
      if (moving && !teleport) ds.phase += Math.min((moved * TAU) / deerSet.model.stride, 1.2);
      if (gdt > 0) ds.t += dt;
      let want: number;
      if (moving) want = 0.12;
      else if (a.huntedBy >= 0) want = -0.15;
      else want = fract((ds.t + ds.seed * 37) / 11) < 0.66 ? 1 : 0;
      ds.headDown += (want - ds.headDown) * damp(3, dt);
      const alert = !moving && ds.headDown < 0.3;
      const yawHead = alert ? 0.45 * Math.sin(ds.t * 0.8 + ds.seed * 9) : 0;
      const chew = !moving && ds.headDown > 0.8 ? 0.04 * Math.sin(ds.t * 7) : 0;
      const gallop = moving && ds.speed > 2.2;
      this.drawAnimal(deerSet, a.x, a.z, ds.heading, 1, moving, ds.phase, ds.headDown, yawHead, chew, gallop, ds.coat, ds.buck, s);
    }
    if (this.frame % 120 === 0) {
      this.deer.forEach(this.pruneDeer);
    }

    // ---- pasture livestock ----
    if (s.rev.buildings !== this.pastureRev) this.refreshPastures();
    // Pass 1: sync herd sizes and reserve capacity (growing a mesh discards its contents, so do it before drawing).
    const bd = this.bounds;
    this.livestockTotals.sheep = this.livestockTotals.cattle = this.livestockTotals.chicken = 0;
    for (let i = 0; i < this.pastureIds.length; i++) {
      const b = this.building(this.pastureIds[i]);
      if (!b || b.state !== 'active' || !b.livestock || b.livestock.count <= 0) {
        if (b) this.herds.delete(b.id);
        continue;
      }
      const type = b.livestock.type;
      let herd = this.herds.get(b.id);
      if (!herd || herd.type !== type) {
        herd = new Herd(type, (b.id * 2654435761) >>> 0);
        this.herds.set(b.id, herd);
      }
      pastureBounds(b, type, bd);
      herd.sync(b.livestock.count, bd);
      this.livestockTotals[type] += herd.grazers.length;
    }
    for (let k = 0; k < LIVESTOCK_TYPES.length; k++) {
      const type = LIVESTOCK_TYPES[k];
      this.ensure(this.sets.get(type)!, this.livestockTotals[type]);
    }
    // Pass 2: wander & draw.
    for (let i = 0; i < this.pastureIds.length; i++) {
      const b = this.building(this.pastureIds[i]);
      if (!b || !b.livestock) continue;
      const herd = this.herds.get(b.id);
      if (!herd) continue;
      const type = herd.type;
      pastureBounds(b, type, bd);
      herd.step(gdt, bd);
      const set = this.sets.get(type)!;
      const def = LIVESTOCK[type];
      const nCoats = COATS[type].length;
      for (let k = 0; k < herd.grazers.length; k++) {
        const g = herd.grazers[k];
        const coat = type === 'sheep'
          ? (g.variant < 0.05 ? 5 : Math.floor(g.variant * 5) % 5)
          : Math.floor(g.variant * nCoats) % nCoats;
        const sc = def.scale * (0.9 + g.seed * 0.2);
        const chew = !g.moving && g.headDown > 0.8 && type !== 'chicken' ? 0.04 * Math.sin(ctx.realTime * 6 + g.seed * 10) : 0;
        this.drawAnimal(set, g.x, g.z, g.heading, sc, g.moving, g.phase, g.headDown, 0, chew, false, coat, false, s);
      }
    }
    // Drop herds of removed pastures.
    if (this.frame % 180 === 0) {
      this.herds.forEach(this.pruneHerd);
    }

    for (let i = 0; i < this.setList.length; i++) {
      const set = this.setList[i];
      set.body.commit(set.n);
      set.head.commit(set.n);
      set.leg.commit(set.legN);
      set.extra?.commit(set.extraN);
    }
  }

  dispose(): void {
    for (const set of this.sets.values()) {
      set.body.dispose();
      set.head.dispose();
      set.leg.dispose();
      set.extra?.dispose();
      set.model.body.dispose();
      set.model.head.dispose();
      set.model.leg.dispose();
      set.model.extra?.dispose();
    }
    this.sets.clear();
    this.setList.length = 0;
    this.material.dispose();
    this.scene.remove(this.root);
  }

  /** Total animals drawn last frame (debug). */
  get drawnCount(): number {
    let n = 0;
    for (const set of this.sets.values()) n += set.n;
    return n;
  }

  // ---------------------------------------------------------------------------------------------

  private building(id: number): Building | undefined {
    return this.game.buildingById?.get(id) ?? this.game.state.buildings.find((b) => b.id === id);
  }

  private refreshPastures(): void {
    const s = this.game.state;
    this.pastureRev = s.rev.buildings;
    this.pastureIds = s.buildings.filter((b) => b.type === 'pasture').map((b) => b.id);
  }

  private ensure(set: SpeciesSet, n: number): void {
    set.body.ensure(n);
    set.head.ensure(n);
    set.leg.ensure(n * set.model.legPivots.length);
    set.extra?.ensure(n);
  }

  private drawAnimal(
    set: SpeciesSet, x: number, z: number, heading: number, scale: number, moving: boolean, phase: number,
    headDown: number, headYaw: number, chew: number, gallop: boolean, coat: number, antlers: boolean,
    s: Game['state'],
  ): void {
    const m = set.model;
    const y = entityGroundY(s, x, z);
    // off-screen (with a margin for the shadow): skip the whole joint hierarchy
    if (!sphereInPlanes(this.planes, x, y + 0.5 * scale, z, 1.5 * scale + 2)) return;
    const sw = Math.sin(phase);
    const bob = moving ? Math.abs(sw) * (gallop ? 0.05 : 0.012) * scale : 0;
    const yaw = -heading;
    const c = Math.cos(yaw) * scale;
    const sn = Math.sin(yaw) * scale;
    const pitchBody = gallop ? Math.cos(phase) * 0.12 : 0;
    _root.set(
      c, 0, sn, x,
      0, scale, 0, y + bob,
      -sn, 0, c, z,
      0, 0, 0, 1,
    );
    if (pitchBody !== 0) _root.multiply(localYZ(_loc, 0, 0, 0, 0, pitchBody));
    const idx = set.n++;
    const cr = set.coats[coat * 3];
    const cg = set.coats[coat * 3 + 1];
    const cb = set.coats[coat * 3 + 2];
    // body
    _root.toArray(set.body.matrixArray, idx * 16);
    writeTint(set.body, idx, cr, cg, cb);
    // head
    const hp = m.headPivot;
    const pitch = headDown * m.grazePitch + chew + (moving ? Math.sin(phase * 2) * 0.05 : 0);
    _tmp.multiplyMatrices(_root, localYZ(_loc, hp[0], hp[1], hp[2], headYaw, -pitch));
    _tmp.toArray(set.head.matrixArray, idx * 16);
    writeTint(set.head, idx, cr, cg, cb);
    if (antlers && set.extra) {
      const e = set.extraN++;
      _tmp.toArray(set.extra.matrixArray, e * 16);
      writeTint(set.extra, e, 1, 1, 1);
    }
    // legs
    const pivots = m.legPivots;
    const quad = pivots.length === 4;
    for (let l = 0; l < pivots.length; l++) {
      let swing = 0;
      if (moving) {
        if (quad) {
          if (gallop) swing = Math.sin(phase + (l < 2 ? 0 : Math.PI * 0.6)) * m.legSwing * 1.5;
          else swing = sw * m.legSwing * (l === 0 || l === 3 ? 1 : -1);
        } else {
          swing = sw * m.legSwing * (l === 0 ? 1 : -1);
        }
      }
      const p = pivots[l];
      _tmp.multiplyMatrices(_root, localYZ(_loc, p[0], p[1], p[2], 0, swing));
      const li = set.legN++;
      _tmp.toArray(set.leg.matrixArray, li * 16);
      writeTint(set.leg, li, cr, cg, cb);
    }
  }
}

function writeTint(set: GrowableInstances, i: number, r: number, g: number, b: number): void {
  const a = set.extras.aTint.array as Float32Array;
  a[i * 3] = r;
  a[i * 3 + 1] = g;
  a[i * 3 + 2] = b;
}
