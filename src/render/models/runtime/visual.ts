/**
 * BuildingVisual — the render-side object for one Building: model mesh + state visuals (clearing stakes,
 * construction reveal & scaffolding, demolition, ruins & debris, fire charring, highlight, night lights,
 * cemetery graves). Positioned on the terrain; zone geometry is conformed to the ground.
 */
import * as THREE from 'three';
import { BUILDINGS } from '../../../core/defs';
import type { Building, BuildingState, BuildingType, GameState } from '../../../core/types';
import { isLandTerrain, rotationAngle } from '../../../core/world';
import { gravesGeometry, ruinDebrisGeometry, scaffoldGeometry, stakesGeometry } from '../extras';
import { createBuildingModel, disposeModel, isZoneType, modelDims, type BuildingModel } from '../index';
import {
  createBuildingMaterial, createRevealDepthMaterial, NO_REVEAL, sharedLitMaterial, sharedPropMaterial, sharedUnlitMaterial,
  type BuildingMaterial,
} from '../material';
import { cemeterySlots } from '../types/zones';
import { computeBaseY, conformGeometry } from './terrainFit';

/** Types that never get scaffolding (zones and open works). */
const NO_SCAFFOLD = new Set<BuildingType>(['quarry', 'mine', 'well']);
/** Types whose lights are on whenever active (public buildings). */
const ALWAYS_LIT = new Set<BuildingType>(['townHall', 'chapel', 'tavern', 'market', 'tradingPost', 'hospital', 'mine', 'storageBarn']);

/** Model-space y at which the construction reveal starts (foundation visible). */
const REVEAL_START = 0.2;

/**
 * Shore models (fishing dock, trading post) put their pier on the model's +X side and the water toward -Z.
 * If the real footprint has more water on the model's -X half, mirror the layout.
 */
export function shoreNeedsMirror(s: GameState, b: Building): boolean {
  const cx = b.x + b.w / 2;
  const cz = b.z + b.h / 2;
  const a = rotationAngle(b.rotation);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let plus = 0;
  let minus = 0;
  for (let z = b.z; z < b.z + b.h; z++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
      if (isLandTerrain(s.tiles.terrain[z * s.W + x])) continue;
      // world offset -> model x (inverse of Ry): lx = dx*cos - dz*sin
      const dx = x + 0.5 - cx;
      const dz = z + 0.5 - cz;
      const lx = dx * cos - dz * sin;
      if (lx > 0.01) plus++;
      else if (lx < -0.01) minus++;
    }
  }
  return minus > plus;
}

export class BuildingVisual {
  readonly id: number;
  readonly group = new THREE.Group();
  readonly model: BuildingModel;
  readonly type: BuildingType;
  readonly zone: boolean;
  /** Unrotated model dims. */
  readonly mw: number;
  readonly mh: number;
  baseY = 0;
  /** Shore buildings: layout mirrored in model X so the pier reaches over the wetter side. */
  readonly mirrored: boolean;
  /** Sync stamp (renderer bookkeeping). */
  stamp = 0;
  /** Last seen building object (identity changes on load). */
  building: Building;

  private readonly key: string;
  private state: BuildingState | null = null;
  private ownMat: BuildingMaterial | null = null;
  private depthMat: THREE.MeshDepthMaterial | null = null;
  private scaffold: THREE.Mesh | null = null;
  private stakes: THREE.Mesh | null = null;
  private stakesBase: Float32Array | null = null;
  private debris: THREE.Mesh | null = null;
  private graves: THREE.Mesh | null = null;
  private gravesBase: Float32Array | null = null;
  private gravesCount = -1;
  private graveSlots: THREE.Vector3[] | null = null;
  private zoneBase: Float32Array | null = null;
  private highlighted = false;
  private lastMaterialKey = '';

  constructor(b: Building, s: GameState) {
    this.id = b.id;
    this.type = b.type;
    this.building = b;
    this.key = BuildingVisual.keyOf(b);
    this.zone = isZoneType(b.type);
    const [mw, mh] = modelDims(b);
    this.mw = mw;
    this.mh = mh;
    this.model = createBuildingModel(b.type, mw, mh, b.id * 7 + b.x * 31 + b.z * 17);
    this.group.name = `building#${b.id}`;
    this.group.matrixAutoUpdate = false;
    this.group.userData.buildingId = b.id;
    this.mirrored = BUILDINGS[b.type].placement === 'shore' && shoreNeedsMirror(s, b);
    if (this.mirrored) this.model.root.scale.set(-1, 1, 1);
    this.model.root.updateMatrix();
    this.model.root.matrixAutoUpdate = false;
    this.model.mesh.matrixAutoUpdate = false;
    this.group.add(this.model.root);
    if (this.zone && !this.model.sharedGeometry) {
      const pos = this.model.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      this.zoneBase = new Float32Array(pos.array as Float32Array);
    }
    this.place(s, b);
    this.applyState(b, s);
  }

  /** Identity key: a change means the visual must be rebuilt (not just updated). */
  static keyOf(b: Building): string {
    return `${b.type}|${b.x}|${b.z}|${b.w}|${b.h}|${b.rotation}`;
  }

  matches(b: Building): boolean {
    return this.key === BuildingVisual.keyOf(b);
  }

  /** Position on the terrain (and conform zone geometry). Call on terrain changes. */
  place(s: GameState, b: Building): void {
    this.baseY = computeBaseY(s, b);
    this.group.position.set(b.x + b.w / 2, this.baseY, b.z + b.h / 2);
    this.group.rotation.set(0, rotationAngle(b.rotation), 0);
    this.group.updateMatrix();
    if (this.zoneBase) conformGeometry(s, this.model.mesh.geometry, this.zoneBase, b, this.baseY);
    if (this.stakes && this.stakesBase && this.zone) conformGeometry(s, this.stakes.geometry, this.stakesBase, b, this.baseY);
    if (this.graves && this.gravesBase) conformGeometry(s, this.graves.geometry, this.gravesBase, b, this.baseY);
  }

  setHighlight(on: boolean): void {
    this.highlighted = on;
  }

  /** Local (model-space) point → world, written into `out`. */
  toWorld(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.mirrored ? -local.x : local.x, local.y, local.z).applyMatrix4(this.group.matrix);
  }

  /** Per-frame update: state visuals, materials, graves. */
  update(b: Building, s: GameState, time: number): void {
    this.building = b;
    if (b.state !== this.state) this.applyState(b, s);
    if (this.type === 'cemetery' && b.state === 'active' && (b.graves ?? 0) !== this.gravesCount) this.updateGraves(b, s);
    this.updateMaterial(b, time);
  }

  private applyState(b: Building, s: GameState): void {
    this.state = b.state;
    const st = b.state;
    this.model.mesh.visible = st !== 'clearing';
    // stakes while clearing
    if (st === 'clearing') {
      if (!this.stakes) {
        const g = stakesGeometry(this.mw, this.mh, b.id);
        this.stakes = this.addProp(g, false);
        if (this.zone) {
          this.stakesBase = new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);
          conformGeometry(s, g, this.stakesBase, b, this.baseY);
        }
      }
      this.stakes.visible = true;
    } else if (this.stakes) {
      this.stakes.visible = false;
    }
    // scaffolding during construction / demolition
    const wantScaffold = (st === 'construction' || st === 'demolishing') && !this.zone && !NO_SCAFFOLD.has(this.type);
    if (wantScaffold && !this.scaffold) this.scaffold = this.addProp(scaffoldGeometry(this.model.body), true);
    if (this.scaffold) this.scaffold.visible = wantScaffold;
    // ruin debris
    if (st === 'ruin' && !this.debris && !this.zone) this.debris = this.addProp(ruinDebrisGeometry(this.model.body), true);
    if (this.debris) this.debris.visible = st === 'ruin';
    if (this.graves) this.graves.visible = st === 'active';
    this.lastMaterialKey = '';
  }

  private addProp(g: THREE.BufferGeometry, shadow: boolean): THREE.Mesh {
    const m = new THREE.Mesh(g, sharedPropMaterial());
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    this.group.add(m);
    return m;
  }

  private updateGraves(b: Building, s: GameState): void {
    const count = Math.max(0, Math.floor(b.graves ?? 0));
    this.gravesCount = count;
    if (!this.graveSlots) {
      const cap = Math.floor(this.mw * this.mh * (BUILDINGS.cemetery.gravesPerTile ?? 0.5));
      this.graveSlots = cemeterySlots(this.mw, this.mh, cap);
    }
    if (this.graves) {
      this.group.remove(this.graves);
      this.graves.geometry.dispose();
      this.graves = null;
      this.gravesBase = null;
    }
    if (count <= 0) return;
    const g = gravesGeometry(this.graveSlots, count, b.id);
    this.gravesBase = new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);
    conformGeometry(s, g, this.gravesBase, b, this.baseY);
    this.graves = this.addProp(g, true);
  }

  private ensureOwn(): BuildingMaterial {
    if (!this.ownMat) {
      this.ownMat = createBuildingMaterial({ lit: true });
      this.depthMat = createRevealDepthMaterial(this.ownMat.userData.uniforms);
      this.ownMat.userData.depth = this.depthMat;
    }
    return this.ownMat;
  }

  private isLit(b: Building): boolean {
    if (b.state !== 'active') return false;
    const def = BUILDINGS[b.type];
    if (def.walkable) return this.type === 'market';
    if (def.housing) return b.residentIds.length > 0;
    if (ALWAYS_LIT.has(b.type)) return true;
    return b.workerIds.length > 0;
  }

  private updateMaterial(b: Building, time: number): void {
    const mesh = this.model.mesh;
    const st = b.state;
    const fire = b.fire > 0.001 ? Math.min(1, b.fire) : 0;
    const reveal = st === 'construction' || st === 'demolishing' || st === 'ruin';
    const lit = this.isLit(b);
    if (!reveal && fire === 0 && !this.highlighted) {
      const key = lit ? 'lit' : 'unlit';
      if (key !== this.lastMaterialKey) {
        mesh.material = lit ? sharedLitMaterial() : sharedUnlitMaterial();
        mesh.customDepthMaterial = undefined;
        this.lastMaterialKey = key;
      }
      return;
    }
    const mat = this.ensureOwn();
    const u = mat.userData.uniforms;
    const top = this.model.height + 0.05;
    let revealY = NO_REVEAL;
    let jag = 0;
    let char = Math.min(1, fire * 1.15) * 0.9;
    let burn = fire;
    const p = Math.max(0, Math.min(1, b.progress));
    if (st === 'construction') {
      revealY = REVEAL_START + (top - REVEAL_START) * p;
    } else if (st === 'demolishing') {
      revealY = top - (top - REVEAL_START) * p;
    } else if (st === 'ruin') {
      revealY = Math.min(1.1, Math.max(0.35, this.model.body.top * 0.45));
      jag = 0.7;
      char = 0.88;
      burn = fire > 0 ? fire : 0.08;
    }
    u.uReveal.value = revealY;
    u.uJag.value = jag;
    u.uChar.value = char;
    u.uBurn.value = burn;
    u.uEmber.value = b.smoking ? 1 : 0;
    u.uLit.value = lit && fire === 0 ? 1 : 0;
    u.uHighlight.value = this.highlighted ? 0.32 + 0.18 * Math.sin(time * 4) : 0;
    const side = reveal ? THREE.DoubleSide : THREE.FrontSide;
    if (mat.side !== side) {
      mat.side = side;
      mat.needsUpdate = true;
    }
    if (mesh.material !== mat) mesh.material = mat;
    const depth = reveal ? this.depthMat ?? undefined : undefined;
    if (mesh.customDepthMaterial !== depth) mesh.customDepthMaterial = depth;
    this.lastMaterialKey = 'own';
  }

  /** Model-space chimney tops (use toWorld for world coordinates). */
  get chimneys(): THREE.Vector3[] {
    return this.model.chimneys;
  }

  dispose(): void {
    this.group.removeFromParent();
    disposeModel(this.model.root);
    if (this.ownMat) {
      this.ownMat.dispose();
      this.depthMat?.dispose();
      this.ownMat = null;
      this.depthMat = null;
    }
    // props: shared geometries (scaffold/debris) are cached; stakes & graves are per-visual
    if (this.stakes) this.stakes.geometry.dispose();
    if (this.graves) this.graves.geometry.dispose();
  }
}

