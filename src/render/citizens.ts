/**
 * Instanced low-poly townsfolk (profession-coloured tunics, children smaller, walk bob & arm swing, carried goods,
 * work animations by activity).
 * OWNER: render-entities agent.
 *
 * Every body part (legs, torso, skirt, head, hair, hats, arms, hands, carried goods, tools) is one dynamic
 * InstancedMesh; each frame the per-citizen joint hierarchy is evaluated on the CPU (no allocations) and written into
 * the instance buffers. Citizens standing inside a building (or at its door doing an indoor activity) are hidden.
 */
import * as THREE from 'three';
import { ADULT_AGE, ELDERLY_AGE } from '../core/constants';
import { BUILDINGS } from '../core/defs';
import type { Building, BuildingType, Citizen, GameState } from '../core/types';
import type { Game } from '../sim/game';
import {
  BODY, buildArm, buildCarry, buildHairLong, buildHairShort, buildHand, buildHatCap, buildHatStraw, buildHead,
  buildHighlightMarker, buildHighlightRing, buildLeg, buildSkirt, buildTool, buildTorso, CARRY_COUNT, CARRY_LOG,
  CARRY_NONE, HAT_CAP, HAT_STRAW, TOOL_COUNT, TOOL_NONE,
} from './entities/citizenModel';
import {
  carryKindOf, citizenScale, makeLook, professionColor, resourceColor, type CitizenLook, type LinearRGB,
} from './entities/citizenLook';
import { computePose, createPose, type PoseInput } from './entities/citizenPose';
import { cameraPlanes, createPlanes, smallPropShadows, sphereInPlanes } from './entities/cull';
import { entityGroundY } from './entities/ground';
import { GrowableInstances } from './entities/instancing';
import { clamp01, damp, lerpAngle, TAU } from './entities/math';
import type { FrameContext, SubRenderer } from './types';

/** Activities that happen inside a building when the citizen stands still at its door. */
const INDOOR = new Set<string>(['eating', 'warming', 'studying', 'healing', 'praying', 'sick', 'working']);
/** Buildings whose workers stay visible on the footprint (open pits). */
const OPEN_AIR = new Set<BuildingType>(['quarry']);
/** Seconds a citizen must be "inside" before it is hidden (avoids flicker). */
const HIDE_DELAY = 0.15;
const PICK_RADIUS = 0.35;

interface RenderState {
  look: CitizenLook;
  seen: number;
  px: number;
  pz: number;
  heading: number;
  phase: number;
  t: number;
  hideT: number;
  init: boolean;
  female: boolean;
}

// Scratch matrices.
const _root = new THREE.Matrix4();
const _hips = new THREE.Matrix4();
const _spine = new THREE.Matrix4();
const _head = new THREE.Matrix4();
const _armL = new THREE.Matrix4();
const _armR = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _loc = new THREE.Matrix4();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();

/** local = T(px,py,pz) · Rz(az) · Rx(ax) · S(s) */
function jointZX(out: THREE.Matrix4, px: number, py: number, pz: number, az: number, ax: number, s = 1): THREE.Matrix4 {
  const ca = Math.cos(az);
  const sa = Math.sin(az);
  const cb = Math.cos(ax);
  const sb = Math.sin(ax);
  return out.set(
    ca * s, -sa * cb * s, sa * sb * s, px,
    sa * s, ca * cb * s, -ca * sb * s, py,
    0, sb * s, cb * s, pz,
    0, 0, 0, 1,
  );
}

/** local = T · Ry(ay) · Rz(az) · S(s) */
function jointYZ(out: THREE.Matrix4, px: number, py: number, pz: number, ay: number, az: number, s = 1): THREE.Matrix4 {
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  // Ry * Rz
  return out.set(
    cy * cz * s, -cy * sz * s, sy * s, px,
    sz * s, cz * s, 0, py,
    -sy * cz * s, sy * sz * s, cy * s, pz,
    0, 0, 0, 1,
  );
}

/** local = T · Rz(az) · Ry(ay) */
function jointZY(out: THREE.Matrix4, px: number, py: number, pz: number, az: number, ay: number): THREE.Matrix4 {
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  // Rz * Ry
  return out.set(
    cz * cy, -sz, cz * sy, px,
    sz * cy, cz, sz * sy, py,
    -sy, 0, cy, pz,
    0, 0, 0, 1,
  );
}

type PartName = 'legs' | 'torso' | 'skirt' | 'head' | 'hairShort' | 'hairLong' | 'hatStraw' | 'hatCap' | 'arms' | 'hands';

export class CitizenRenderer implements SubRenderer {
  private game: Game;
  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly parts: Record<PartName, GrowableInstances>;
  private readonly carries: (GrowableInstances | null)[] = [];
  private readonly tools: (GrowableInstances | null)[] = [];
  private readonly counts: Record<PartName, number> = {
    legs: 0, torso: 0, skirt: 0, head: 0, hairShort: 0, hairLong: 0, hatStraw: 0, hatCap: 0, arms: 0, hands: 0,
  };
  private readonly carryCounts = new Int32Array(CARRY_COUNT);
  private readonly toolCounts = new Int32Array(TOOL_COUNT);
  private readonly states = new Map<number, RenderState>();
  private frame = 0;
  private readonly pose = createPose();
  private readonly poseIn: PoseInput = {
    activity: 'idle', moving: false, walkPhase: 0, t: 0, seed: 0, elderly: false, child: false, carry: 0,
    profession: 'laborer', sick: 0,
  };

  // Door tiles → building id (for "went inside" detection).
  private doorMap = new Map<number, number>();
  private doorRev = -1;

  // Picking (positions as last drawn).
  private pickIds = new Int32Array(256);
  private pickPos = new Float32Array(256 * 4);
  private pickCount = 0;

  // Highlight.
  private highlightId: number | null = null;
  private readonly highlight = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly marker: THREE.Mesh;

  /** Drops render state of citizens not seen this frame (pre-bound: no per-call closure). */
  private readonly pruneState = (rs: RenderState, id: number): void => {
    if (rs.seen !== this.frame) this.states.delete(id);
  };

  private readonly tunic: LinearRGB = [0, 0, 0];
  private readonly skin: LinearRGB = [0, 0, 0];
  /** View-frustum planes of the current frame (citizens outside are not posed/drawn). */
  private readonly planes = createPlanes();
  private shadows = true;
  private readonly allSets: GrowableInstances[] = [];

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.root.name = 'citizens';
    scene.add(this.root);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    const mk = (geo: THREE.BufferGeometry, color: boolean, shadow: boolean, cap = 64): GrowableInstances => {
      this.geometries.push(geo);
      return new GrowableInstances(this.root, geo, this.material, {}, cap, {
        dynamic: true, instanceColor: color, castShadow: shadow, receiveShadow: true,
      });
    };
    this.parts = {
      legs: mk(buildLeg(), true, true, 128),
      torso: mk(buildTorso(), true, true),
      skirt: mk(buildSkirt(), true, true),
      head: mk(buildHead(), true, true),
      hairShort: mk(buildHairShort(), true, false),
      hairLong: mk(buildHairLong(), true, false),
      hatStraw: mk(buildHatStraw(), false, false, 16),
      hatCap: mk(buildHatCap(), true, false, 16),
      arms: mk(buildArm(), true, true, 128),
      hands: mk(buildHand(), true, false, 128),
    };
    for (let k = 0; k < CARRY_COUNT; k++) this.carries.push(k === CARRY_NONE ? null : mk(buildCarry(k), true, true, 16));
    for (let k = 0; k < TOOL_COUNT; k++) this.tools.push(k === TOOL_NONE ? null : mk(buildTool(k), false, false, 16));
    for (const name of PART_NAMES) this.allSets.push(this.parts[name]);
    for (const c of this.carries) if (c) this.allSets.push(c);
    for (const t of this.tools) if (t) this.allSets.push(t);

    const hlMat = new THREE.MeshBasicMaterial({ color: 0xf2d27a, transparent: true, opacity: 0.9, depthWrite: false });
    this.ring = new THREE.Mesh(buildHighlightRing(), hlMat);
    this.ring.renderOrder = 2;
    this.marker = new THREE.Mesh(buildHighlightMarker(), new THREE.MeshBasicMaterial({ color: 0xffd76a }));
    this.highlight.add(this.ring, this.marker);
    this.highlight.visible = false;
    this.root.add(this.highlight);
  }

  setGame(game: Game): void {
    this.game = game;
    this.states.clear();
    this.doorRev = -1;
    this.pickCount = 0;
    this.highlightId = null;
    this.highlight.visible = false;
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    const cits = s.citizens;
    const n = cits.length;
    this.frame++;
    if (s.rev.buildings !== this.doorRev) this.rebuildDoorMap(s);

    // Capacity (upper bounds).
    const P = this.parts;
    P.legs.ensure(n * 2);
    P.arms.ensure(n * 2);
    P.hands.ensure(n * 2);
    P.torso.ensure(n);
    P.skirt.ensure(n);
    P.head.ensure(n);
    P.hairShort.ensure(n);
    P.hairLong.ensure(n);
    P.hatStraw.ensure(n);
    P.hatCap.ensure(n);
    for (let k = 0; k < this.carries.length; k++) this.carries[k]?.ensure(n);
    for (let k = 0; k < this.tools.length; k++) this.tools[k]?.ensure(n);
    if (this.pickIds.length < n) {
      this.pickIds = new Int32Array(n * 2);
      this.pickPos = new Float32Array(n * 8);
    }
    const C = this.counts;
    C.legs = C.torso = C.skirt = C.head = C.hairShort = C.hairLong = C.hatStraw = C.hatCap = C.arms = C.hands = 0;
    this.carryCounts.fill(0);
    this.toolCounts.fill(0);
    this.pickCount = 0;

    const dt = Math.min(ctx.realDt, 0.1);
    // small shadows only when zoomed in; cull citizens outside the view (margin covers their shadow)
    const wantShadows = smallPropShadows(ctx.cameraDistance, ctx.quality, this.shadows);
    if (wantShadows !== this.shadows) {
      this.shadows = wantShadows;
      for (const set of this.allSets) set.setShadowEnabled(wantShadows);
    }
    const planes = cameraPlanes(ctx.camera, _frustum, _pv, this.planes);
    const animDt = ctx.gameDt > 0 ? dt : 0;
    let hlFound = false;

    for (let i = 0; i < n; i++) {
      const c = cits[i];
      let rs = this.states.get(c.id);
      if (!rs) {
        rs = {
          look: makeLook(c), seen: 0, px: c.x, pz: c.z, heading: c.heading, phase: 0, t: hashIdPhase(c.id),
          hideT: 0, init: false, female: c.gender === 'F',
        };
        this.states.set(c.id, rs);
      }
      rs.seen = this.frame;

      // ---- visibility (inside buildings) ----
      if (this.isInside(c, s)) rs.hideT += dt;
      else rs.hideT = 0;
      const hidden = rs.init ? rs.hideT > HIDE_DELAY : rs.hideT > 0;

      // ---- motion ----
      const dx = c.x - rs.px;
      const dz = c.z - rs.pz;
      const moved = Math.sqrt(dx * dx + dz * dz);
      rs.px = c.x;
      rs.pz = c.z;
      const teleport = moved > 3;
      const moving = !teleport && (c.moving || moved > 0.004);
      let targetHeading = c.heading;
      if (moving && moved > 1e-4) targetHeading = Math.atan2(dz, dx);
      rs.heading = !rs.init || teleport ? targetHeading : lerpAngle(rs.heading, targetHeading, damp(12, dt));
      rs.init = true;
      rs.t += animDt;
      if (hidden) continue;
      const y = entityGroundY(s, c.x, c.z);
      if (!sphereInPlanes(planes, c.x, y + 0.3, c.z, 2.5)) continue;

      const look = rs.look;
      const scale = citizenScale(c, look);
      if (moving && !teleport) rs.phase = (rs.phase + Math.min((moved * TAU) / (0.44 * scale), 1.2)) % (TAU * 1000);

      // ---- pose ----
      const pi = this.poseIn;
      pi.activity = c.activity;
      pi.moving = moving;
      pi.walkPhase = rs.phase;
      pi.t = rs.t;
      pi.seed = look.seed;
      pi.elderly = c.age >= ELDERLY_AGE;
      pi.child = c.age < ADULT_AGE;
      pi.carry = c.carrying && c.carrying.amount > 0 ? carryKindOf(c.carrying.type) : CARRY_NONE;
      pi.profession = c.profession;
      pi.sick = c.sick;
      const pose = computePose(pi, this.pose);

      // ---- colours ----
      const sick = clamp01(c.sick);
      const tun = professionColor(c.profession);
      const skinBase = look.skin;
      const pale = sick * 0.55;
      this.skin[0] = skinBase[0] + (0.5 - skinBase[0]) * pale;
      this.skin[1] = skinBase[1] + (0.56 - skinBase[1]) * pale;
      this.skin[2] = skinBase[2] + (0.38 - skinBase[2]) * pale;
      const grey = (tun[0] + tun[1] + tun[2]) / 3;
      const desat = sick * 0.4;
      this.tunic[0] = tun[0] + (grey - tun[0]) * desat;
      this.tunic[1] = tun[1] + (grey - tun[1]) * desat;
      this.tunic[2] = tun[2] + (grey - tun[2]) * desat;
      const tunic = this.tunic;
      const skin = this.skin;

      // ---- hierarchy ----
      const yaw = -(rs.heading + pose.yawOffset);
      const cyaw = Math.cos(yaw);
      const syaw = Math.sin(yaw);
      _root.set(
        cyaw * scale, 0, syaw * scale, c.x,
        0, scale, 0, y,
        -syaw * scale, 0, cyaw * scale, c.z,
        0, 0, 0, 1,
      );
      const maxLeg = Math.max(Math.abs(pose.legL), Math.abs(pose.legR));
      const hipY = BODY.hipY - BODY.legLen * (1 - Math.cos(maxLeg)) + pose.bob;
      _hips.multiplyMatrices(_root, jointZX(_loc, 0, hipY, 0, 0, 0));

      // legs
      this.put('legs', _tmp.multiplyMatrices(_hips, jointZX(_loc, 0, 0, -BODY.legZ, pose.legL, 0)), rs.female ? DARK_LEGS : look.trousers);
      this.put('legs', _tmp.multiplyMatrices(_hips, jointZX(_loc, 0, 0, BODY.legZ, pose.legR, 0)), rs.female ? DARK_LEGS : look.trousers);
      if (rs.female) {
        this.put('skirt', _hips, mulColor(tunic, 0.78, SCR_A));
      }

      // spine
      _spine.multiplyMatrices(_hips, jointZY(_loc, 0, 0, 0, -pose.lean, pose.twist));
      this.put('torso', _spine, tunic);

      // head
      const headScale = c.age < ADULT_AGE ? 1.18 : 1;
      _head.multiplyMatrices(_spine, jointYZ(_loc, 0, BODY.neckY, 0, pose.headYaw, -pose.headPitch, headScale));
      this.put('head', _head, skin);
      const hairCol = c.age >= ELDERLY_AGE ? look.grey : look.hair;
      if (look.hairStyle === 0) this.put('hairShort', _head, hairCol);
      else this.put('hairLong', _head, look.hairStyle === 2 && c.age >= ADULT_AGE ? look.kerchief : hairCol);
      if (c.age >= ADULT_AGE) {
        if (look.hat === HAT_STRAW) this.put('hatStraw', _head, null);
        else if (look.hat === HAT_CAP) this.put('hatCap', _head, look.hatColor);
      }

      // arms & hands
      const sleeve = mulColor(tunic, 0.9, SCR_B);
      _armL.multiplyMatrices(_spine, jointZX(_loc, 0, BODY.shoulderY, -BODY.shoulderZ, pose.armL, -pose.armInL));
      _armR.multiplyMatrices(_spine, jointZX(_loc, 0, BODY.shoulderY, BODY.shoulderZ, pose.armR, pose.armInR));
      this.put('arms', _armL, sleeve);
      this.put('arms', _armR, sleeve);
      this.put('hands', _armL, skin);
      this.put('hands', _armR, skin);

      // tool
      if (pose.tool !== TOOL_NONE) {
        const set = this.tools[pose.tool];
        if (set) {
          const arm = pose.toolHand === 1 ? _armL : _armR;
          const inComp = pose.twoHanded ? -pose.armInR : 0;
          _tmp.multiplyMatrices(arm, jointZX(_loc, 0, -BODY.armLen + 0.012, 0, 0, inComp));
          _tmp.multiply(jointZX(_loc, 0, 0, 0, pose.toolAngle, 0));
          const k = this.toolCounts[pose.tool]++;
          _tmp.toArray(set.matrixArray, k * 16);
        }
      }

      // carried goods
      if (pose.carry !== CARRY_NONE && c.carrying) {
        const set = this.carries[pose.carry];
        if (set) {
          const amt = clamp01(c.carrying.amount / 10);
          const sc = 0.75 + 0.3 * amt;
          if (pose.carry === CARRY_LOG) {
            const short = c.carrying.type === 'firewood';
            _tmp.multiplyMatrices(_spine, jointZX(_loc, -0.01, BODY.shoulderY + 0.045, BODY.shoulderZ * 0.75, 0.15, 0, short ? 0.72 : 1));
          } else {
            _tmp.multiplyMatrices(_spine, jointZX(_loc, 0.13, 0.1, 0, 0, 0, sc));
          }
          const k = this.carryCounts[pose.carry]++;
          _tmp.toArray(set.matrixArray, k * 16);
          const col = resourceColor(c.carrying.type);
          const ca = set.colorArray!;
          ca[k * 3] = col[0];
          ca[k * 3 + 1] = col[1];
          ca[k * 3 + 2] = col[2];
        }
      }

      // picking record
      const h = 0.55 * scale;
      const pk = this.pickCount++;
      this.pickIds[pk] = c.id;
      this.pickPos[pk * 4] = c.x;
      this.pickPos[pk * 4 + 1] = y;
      this.pickPos[pk * 4 + 2] = c.z;
      this.pickPos[pk * 4 + 3] = h;

      if (this.highlightId === c.id) {
        hlFound = true;
        this.highlight.position.set(c.x, y, c.z);
        this.marker.position.set(0, h + 0.28 + Math.sin(ctx.realTime * 3) * 0.04, 0);
        this.marker.rotation.y = ctx.realTime * 2;
        this.marker.scale.setScalar(Math.max(1, Math.min(2.5, ctx.cameraDistance / 30)));
        this.ring.scale.setScalar(scale);
      }
    }

    // ---- commit ----
    for (let k = 0; k < PART_NAMES.length; k++) P[PART_NAMES[k]].commit(C[PART_NAMES[k]]);
    for (let k = 0; k < CARRY_COUNT; k++) this.carries[k]?.commit(this.carryCounts[k]);
    for (let k = 0; k < TOOL_COUNT; k++) this.tools[k]?.commit(this.toolCounts[k]);

    this.highlight.visible = hlFound;
    this.highlight.updateMatrixWorld();

    // ---- forget citizens that no longer exist ----
    if (this.frame % 120 === 0) {
      this.states.forEach(this.pruneState);
    }
  }

  /** Nearest citizen whose body the ray passes within ~0.35 units of, or null. */
  pick(ray: THREE.Ray): number | null {
    let best: number | null = null;
    let bestD = PICK_RADIUS * PICK_RADIUS;
    let bestAlong = Infinity;
    for (let i = 0; i < this.pickCount; i++) {
      const x = this.pickPos[i * 4];
      const y = this.pickPos[i * 4 + 1];
      const z = this.pickPos[i * 4 + 2];
      const h = this.pickPos[i * 4 + 3];
      _v0.set(x, y + h * 0.1, z);
      _v1.set(x, y + h * 0.95, z);
      const d2 = ray.distanceSqToSegment(_v0, _v1, _pt);
      if (d2 > PICK_RADIUS * PICK_RADIUS) continue;
      const along = _pt.sub(ray.origin).dot(ray.direction);
      // Prefer the closest to the ray; break near-ties by distance to the camera.
      if (d2 < bestD - 0.004 || (d2 < bestD + 0.004 && along < bestAlong)) {
        bestD = Math.min(bestD, d2);
        bestAlong = along;
        best = this.pickIds[i];
      }
    }
    return best;
  }

  setHighlight(id: number | null): void {
    this.highlightId = id;
    if (id === null) this.highlight.visible = false;
  }

  dispose(): void {
    for (const name of PART_NAMES) this.parts[name].dispose();
    for (const c of this.carries) c?.dispose();
    for (const t of this.tools) t?.dispose();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
    this.scene.remove(this.root);
    this.states.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private put(part: PartName, m: THREE.Matrix4, color: LinearRGB | null): void {
    const set = this.parts[part];
    const k = this.counts[part]++;
    m.toArray(set.matrixArray, k * 16);
    if (color) {
      const ca = set.colorArray;
      if (ca) {
        ca[k * 3] = color[0];
        ca[k * 3 + 1] = color[1];
        ca[k * 3 + 2] = color[2];
      }
    }
  }

  private rebuildDoorMap(s: GameState): void {
    this.doorRev = s.rev.buildings;
    this.doorMap.clear();
    for (const b of s.buildings) {
      if (b.doorX < 0 || b.doorZ < 0 || b.doorX >= s.W || b.doorZ >= s.H) continue;
      const key = b.doorZ * s.W + b.doorX;
      if (!this.doorMap.has(key)) this.doorMap.set(key, b.id);
    }
  }

  private buildingById(id: number): Building | undefined {
    return this.game.buildingById?.get(id) ?? this.game.state.buildings.find((b) => b.id === id);
  }

  /** Whether the citizen is (visually) inside a building right now. */
  private isInside(c: Citizen, s: GameState): boolean {
    const tx = Math.floor(c.x);
    const tz = Math.floor(c.z);
    if (tx < 0 || tz < 0 || tx >= s.W || tz >= s.H) return false;
    const ti = tz * s.W + tx;
    const bid = s.tiles.building[ti];
    if (bid >= 0) {
      const b = this.buildingById(bid);
      if (b && b.state === 'active' && !BUILDINGS[b.type].walkable && !OPEN_AIR.has(b.type)) return true;
    }
    if (!c.moving) {
      const indoor = INDOOR.has(c.activity);
      // Miners dig inside the mine (quarry workers stay visible in their open pit).
      if (indoor || c.activity === 'mining') {
        const did = this.doorMap.get(ti);
        if (did !== undefined) {
          const b = this.buildingById(did);
          if (b && b.state === 'active' && !BUILDINGS[b.type].walkable && !OPEN_AIR.has(b.type)) {
            return indoor || b.type === 'mine';
          }
        }
      }
    }
    return false;
  }
}

const PART_NAMES: PartName[] = ['legs', 'torso', 'skirt', 'head', 'hairShort', 'hairLong', 'hatStraw', 'hatCap', 'arms', 'hands'];
const DARK_LEGS: LinearRGB = [0.05, 0.045, 0.04];
const SCR_A: LinearRGB = [0, 0, 0];
const SCR_B: LinearRGB = [0, 0, 0];

function mulColor(c: LinearRGB, k: number, out: LinearRGB): LinearRGB {
  out[0] = c[0] * k;
  out[1] = c[1] * k;
  out[2] = c[2] * k;
  return out;
}

function hashIdPhase(id: number): number {
  return ((id * 2654435761) >>> 0) / 4294967296 * 10;
}
