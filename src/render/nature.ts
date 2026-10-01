/**
 * Instanced trees (conifer/deciduous/birch, growth-scaled, seasonal foliage incl. autumn colours & bare winter
 * deciduous, snow-capped), rocks and iron deposits; marked-for-removal features show a marker.
 * OWNER: render-entities agent (performance pass: render/app performance engineer).
 *
 * Design
 * - The map is split into CHUNK×CHUNK tile chunks. Each chunk keeps CPU-side instance data per kind (matrix, aInst,
 *   bounding sphere); a per-tile key snapshot (feature, marked, variant, quantised amount) is diffed against the live
 *   tiles when `rev.features` changes (throttled) and only chunks with differences are rebuilt (a few per frame,
 *   nearest first).
 * - Drawing is decoupled from chunks: whenever the view changes noticeably, every instance of the chunks touching the
 *   camera or shadow frustum is culled PER INSTANCE and appended to a handful of shared InstancedMeshes:
 *     main pass   — species × LOD (full / reduced / far 16–26 tris), rocks, iron, markers (≤ 12 draws);
 *     shadow pass — species × LOD silhouettes + rocks/iron near the camera (≤ 11 draws), shadow-only
 *                   meshes (they refuse every frustum but the sun's shadow frustum), casters taken from the sun's
 *                   fitted shadow box (SkyRenderer.shadowCull) and kept only when their shadow can land in view.
 *                   Trees drawn with the far model (beyond lod1) cast no shadows.
 *   Instances beyond the fog's far distance are dropped. This replaced ~100 per-chunk meshes (and their draw calls)
 *   whose coarse culling drew thousands of off-screen trees, many of them twice (shadow pass).
 * - Seasons, leaf fall, autumn colours, snow and wind sway are all shader uniforms → no per-frame instance updates.
 * - Trees that disappear near the camera play a short falling animation.
 */
import * as THREE from 'three';
import { Feature } from '../core/types';
import type { GameState } from '../core/types';
import { heightAt } from '../core/world';
import type { Game } from '../sim/game';
import { boxInPlanes, createPlanes, natureLodFor, planesFromFrustum, sphereInPlanes, type NatureLod } from './entities/cull';
import {
  createEntityMaterial, createEnvUniforms, createFoliageUniforms, setSRGB,
  type EnvUniforms, type FoliageUniforms,
} from './entities/entityMaterial';
import { FallingTrees } from './entities/fallingTrees';
import { GrowableInstances } from './entities/instancing';
import { clamp, clamp01, hashTile, TAU } from './entities/math';
import { createFoliageParams, foliageAt, type FoliageSpecies } from './entities/palette';
import {
  buildIron, buildMarker, buildRock, buildTree, ROCK_TOP, SPECIES_TOP,
} from './entities/treeModels';
import { getSkyRenderer } from './sky';
import type { FrameContext, SubRenderer } from './types';

/** Chunk edge length in tiles. */
export const NATURE_CHUNK = 32;
/** Minimum real seconds between feature scans while `rev.features` keeps changing. */
const SCAN_INTERVAL = 0.3;
/** Max chunks rebuilt per frame (after the initial build). */
const REBUILDS_PER_FRAME = 4;
/** Minimum real seconds between re-culls caused only by the sun's shadow frustum moving (sun path at 1x speed). */
const SHADOW_RECULL_INTERVAL = 0.2;
/** Extra radius (world units) around shadow casters when culling (covers the frustum drift between re-culls). */
const SHADOW_MARGIN = 4;

// Kinds 0..2 are the tree species (conifer, deciduous, birch — see treeModels SPECIES_*).
const KIND_BIRCH = 2;
const KIND_ROCK = 3;
const KIND_IRON = 4;
const KIND_MARKER = 5;
const KIND_COUNT = 6;
const MAX_PER_CHUNK = NATURE_CHUNK * NATURE_CHUNK;
const TREE_LODS = 3;

const SPECIES_NAMES: FoliageSpecies[] = ['conifer', 'deciduous', 'birch'];

interface Chunk {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  cx: number;
  cz: number;
  /** Instances per kind and their data (matrix ×16, aInst ×4, bounding sphere x,y,z,r ×4). */
  n: Int32Array;
  mat: Float32Array[];
  inst: Float32Array[];
  sph: Float32Array[];
  minY: number;
  maxY: number;
  dirty: boolean;
}

/** One drawn instance set: the mesh plus the (chunk, instance) references gathered by the last cull. */
interface DrawSet {
  kind: number;
  gi: GrowableInstances;
  refs: Int32Array;
  count: number;
}

/** Packed per-tile key used to detect visual changes (feature 2b | marked 1b | variant 2b | amount 8b). */
export function featureKey(feature: number, marked: number, variant: number, amount: number): number {
  if (feature === Feature.None) return 0;
  const q = feature === Feature.Tree
    ? Math.min(63, Math.floor(clamp01(amount) * 40))
    : Math.min(255, Math.max(0, Math.ceil(amount)));
  return (feature & 3) | ((marked ? 1 : 0) << 2) | ((variant % 3) << 3) | (q << 5);
}

/** Growth → uniform model scale of a tree (saplings are small but visible). */
export function treeGrowthScale(growth: number): number {
  const g = clamp01(growth);
  return g >= 1 ? 1 : 0.18 + 0.82 * g;
}

/** Remaining amount → model scale of rocks & iron deposits (0.3–0.7 tall). */
export function rockScale(amount: number): number {
  return 0.6 + 0.8 * clamp01(amount / 40);
}

// Scratch objects (no per-frame allocation).
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _pv = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

interface TreePlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  lx: number;
  lz: number;
  sx: number;
  sy: number;
  sz: number;
  variation: number;
  stagger: number;
}

const _tp: TreePlacement = { x: 0, y: 0, z: 0, yaw: 0, lx: 0, lz: 0, sx: 1, sy: 1, sz: 1, variation: 0, stagger: 0 };

/** Deterministic placement of the tree on tile (x, z) at the given growth. */
function placeTree(s: GameState, x: number, z: number, growth: number, out: TreePlacement): TreePlacement {
  const gs = treeGrowthScale(growth);
  out.x = x + 0.5 + (hashTile(x, z, 11) - 0.5) * 0.42;
  out.z = z + 0.5 + (hashTile(x, z, 12) - 0.5) * 0.42;
  out.yaw = hashTile(x, z, 13) * TAU;
  out.lx = (hashTile(x, z, 14) - 0.5) * 0.09;
  out.lz = (hashTile(x, z, 15) - 0.5) * 0.09;
  const size = 0.85 + hashTile(x, z, 16) * 0.3;
  const width = 0.9 + hashTile(x, z, 17) * 0.22;
  out.sx = gs * size * width;
  out.sy = gs * size;
  out.sz = gs * size * width;
  out.y = heightAt(s, out.x, out.z) - 0.05 * gs;
  out.variation = hashTile(x, z, 18);
  out.stagger = hashTile(x, z, 19);
  return out;
}

/** Drawn-instance counters of the last cull (debug / perf HUD). */
export interface NatureStats {
  /** Main-pass trees per LOD. */
  trees: [number, number, number];
  rocks: number;
  /** Shadow-pass casters (trees + rocks). */
  shadowCasters: number;
  /** Re-culls performed since start. */
  culls: number;
}

export class NatureRenderer implements SubRenderer {
  private game: Game;
  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly env: EnvUniforms = createEnvUniforms();
  private readonly foliage: FoliageUniforms[] = [createFoliageUniforms(), createFoliageUniforms(), createFoliageUniforms()];
  private readonly fparams = createFoliageParams();

  private readonly bases: THREE.BufferGeometry[][] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly depthMaterials: (THREE.Material | null)[] = [];

  private chunks: Chunk[] = [];
  private chunksX = 0;
  private chunksZ = 0;
  private snapshot: Uint16Array = new Uint16Array(0);
  private lastFeaturesRev = -1;
  private lastTerrainRev = -1;
  private lastScanTime = -1e9;
  private pendingScan = true;
  private initialBuildDone = false;
  private readonly falling: FallingTrees;

  // Rebuild scratch (one chunk at a time).
  private readonly scratchMat: Float32Array[] = [];
  private readonly scratchInst: Float32Array[] = [];
  private readonly scratchSph: Float32Array[] = [];
  private readonly counts = new Int32Array(KIND_COUNT);

  // Drawn sets.
  /** main[kind] — trees: [lod0, lod1, lod2]; rocks/iron/markers: [single]. */
  private readonly main: DrawSet[][] = [];
  /** shadow[kind] — trees: [lod0, lod1, lod2]; rocks/iron: [single]; markers: none. */
  private readonly shadow: DrawSet[][] = [];
  private readonly allSets: DrawSet[] = [];

  // View-cull state.
  private viewDirty = true;
  private readonly lastCam = new Float32Array(16);
  private lastProj0 = 0;
  private lastProj5 = 0;
  private lastShadowVersion = -1;
  private lastShadowCullAt = -1e9;
  private lastFogFar = 0;
  private quality: FrameContext['quality'] = 'high';
  private lod: NatureLod = natureLodFor('high');
  private readonly mainPlanes = createPlanes();
  private readonly shadowPlanes = createPlanes();
  private shadowFrustumRef: THREE.Frustum | null = null;
  readonly stats: NatureStats = { trees: [0, 0, 0], rocks: 0, shadowCasters: 0, culls: 0 };

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.root.name = 'nature';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);

    for (let sp = 0; sp < 3; sp++) {
      this.bases.push([buildTree(sp, 0), buildTree(sp, 1), buildTree(sp, 2)]);
      const mats = createEntityMaterial(this.env, {
        key: `tree-${sp}`,
        parts: true,
        inst: true,
        foliage: this.foliage[sp],
        sway: { start: sp === 0 ? 0.6 : 0.9, amp: sp === 0 ? 0.012 : 0.02 },
        snow: sp === 0 ? { lo: 0.35, hi: 0.78, amount: 0.95 } : { lo: 0.45, hi: 0.85, amount: 0.9 },
        markBand: true,
        depth: true,
      });
      this.materials.push(mats.material);
      this.depthMaterials.push(mats.depth);
    }
    this.bases.push([buildRock()], [buildIron()], [buildMarker()]);
    const rock = createEntityMaterial(this.env, { key: 'rock', parts: true, inst: true, vary: true, snow: { lo: 0.35, hi: 0.8, amount: 1 } });
    const iron = createEntityMaterial(this.env, { key: 'iron', parts: true, inst: true, vary: true, snow: { lo: 0.4, hi: 0.85, amount: 0.9 } });
    const marker = createEntityMaterial(this.env, { key: 'marker', inst: true, marker: true, emissive: 0x8a2a0c });
    this.materials.push(rock.material, iron.material, marker.material);
    this.depthMaterials.push(null, null, null);

    for (let k = 0; k < KIND_COUNT; k++) {
      this.scratchMat.push(new Float32Array(MAX_PER_CHUNK * 16));
      this.scratchInst.push(new Float32Array(MAX_PER_CHUNK * 4));
      this.scratchSph.push(new Float32Array(MAX_PER_CHUNK * 4));
    }
    this.createSets();

    this.falling = new FallingTrees(
      this.root,
      [this.bases[0][0], this.bases[1][0], this.bases[2][0]],
      [this.materials[0], this.materials[1], this.materials[2]],
      [this.depthMaterials[0], this.depthMaterials[1], this.depthMaterials[2]],
    );
    this.setGame(game);
  }

  private createSets(): void {
    const mk = (kind: number, geo: THREE.BufferGeometry, pass: 'main' | 'shadow'): DrawSet => {
      const isMarker = kind === KIND_MARKER;
      const name = `nature-${pass}-${kind}`;
      const named = (mesh: THREE.InstancedMesh): void => {
        mesh.name = name;
      };
      const shadowOnly = (mesh: THREE.InstancedMesh): void => {
        mesh.name = name;
        // Drawn only by the sun's shadow pass: refuse every other frustum (the main camera's).
        mesh.intersectsFrustum = (f: THREE.Frustum) => f === this.shadowFrustum();
      };
      const gi = new GrowableInstances(this.root, geo, this.materials[kind], { aInst: 4 }, 16, pass === 'main'
        ? { castShadow: false, receiveShadow: !isMarker, dynamic: true, ranged: true, frustumCulled: false, onMesh: named }
        : {
          castShadow: true, receiveShadow: false, dynamic: true, ranged: true, frustumCulled: true,
          depthMaterial: this.depthMaterials[kind], onMesh: shadowOnly,
        });
      const set: DrawSet = { kind, gi, refs: new Int32Array(64), count: 0 };
      this.allSets.push(set);
      return set;
    };
    for (let k = 0; k < KIND_COUNT; k++) {
      const isTree = k <= KIND_BIRCH;
      this.main.push(isTree ? [0, 1, 2].map((l) => mk(k, this.bases[k][l], 'main')) : [mk(k, this.bases[k][0], 'main')]);
      if (k === KIND_MARKER) this.shadow.push([]);
      else this.shadow.push(isTree ? [0, 1, 2].map((l) => mk(k, this.bases[k][l], 'shadow')) : [mk(k, this.bases[k][0], 'shadow')]);
    }
  }

  /** The renderer's shadow frustum object for the sun (identity marks the shadow pass). */
  private shadowFrustum(): THREE.Frustum | null {
    if (!this.shadowFrustumRef) this.shadowFrustumRef = getSkyRenderer(this.scene)?.sun.shadow.getFrustum() ?? null;
    return this.shadowFrustumRef;
  }

  setGame(game: Game): void {
    this.game = game;
    this.chunks = [];
    this.falling.clear();
    const s = game.state;
    this.chunksX = Math.ceil(s.W / NATURE_CHUNK);
    this.chunksZ = Math.ceil(s.H / NATURE_CHUNK);
    for (let cz = 0; cz < this.chunksZ; cz++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        const x0 = cx * NATURE_CHUNK;
        const z0 = cz * NATURE_CHUNK;
        const x1 = Math.min(s.W, x0 + NATURE_CHUNK);
        const z1 = Math.min(s.H, z0 + NATURE_CHUNK);
        const empty = () => new Float32Array(0);
        this.chunks.push({
          x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
          n: new Int32Array(KIND_COUNT),
          mat: Array.from({ length: KIND_COUNT }, empty),
          inst: Array.from({ length: KIND_COUNT }, empty),
          sph: Array.from({ length: KIND_COUNT }, empty),
          minY: 0, maxY: 0, dirty: true,
        });
      }
    }
    this.snapshot = new Uint16Array(s.W * s.H);
    this.lastFeaturesRev = s.rev.features;
    this.lastTerrainRev = s.rev.terrain;
    this.initialBuildDone = false;
    this.pendingScan = false;
    // Initial full build (synchronous so the first frame shows the forest).
    this.fullScan(false);
    for (const ch of this.chunks) this.rebuildChunk(ch);
    this.initialBuildDone = true;
    for (const set of this.allSets) {
      set.count = 0;
      set.gi.commit(0);
    }
    this.viewDirty = true;
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    this.updateUniforms(ctx, s);

    // ---- change detection (throttled) ----
    if (s.rev.terrain !== this.lastTerrainRev) {
      this.lastTerrainRev = s.rev.terrain;
      for (const ch of this.chunks) ch.dirty = true; // ground heights may have moved under features
    }
    if (s.rev.features !== this.lastFeaturesRev) this.pendingScan = true;
    if (this.pendingScan && ctx.realTime - this.lastScanTime >= SCAN_INTERVAL) {
      this.pendingScan = false;
      this.lastFeaturesRev = s.rev.features;
      this.lastScanTime = ctx.realTime;
      this.fullScan(true, ctx);
    }
    this.rebuildDirty(ctx);

    // ---- per-instance culling & LOD (only when the view / shadow box / data changed noticeably) ----
    if (ctx.quality !== this.quality) {
      this.quality = ctx.quality;
      this.lod = natureLodFor(ctx.quality);
      this.viewDirty = true;
    }
    if (this.needsCull(ctx)) this.cull(ctx);

    // ---- falling trees ----
    const animDt = ctx.gameDt > 0 ? Math.min(ctx.realDt, 0.1) : 0;
    this.falling.update(animDt);
  }

  dispose(): void {
    this.chunks = [];
    for (const set of this.allSets) set.gi.dispose();
    this.falling.dispose();
    this.scene.remove(this.root);
    for (const lods of this.bases) for (const g of lods) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const m of this.depthMaterials) m?.dispose();
  }

  /** Number of drawn tree/rock instances in the main pass (debug/perf readout). */
  get instanceCount(): number {
    let n = 0;
    for (const sets of this.main) for (const set of sets) n += set.count;
    return n;
  }

  // ---------------------------------------------------------------------------------------------

  private fogFar(): number {
    const f = this.scene.fog as THREE.Fog | null;
    return f && typeof (f as THREE.Fog).far === 'number' ? f.far : 1e9;
  }

  private cullMargin(ctx: FrameContext): number {
    return 2 + ctx.cameraDistance * 0.05;
  }

  /** Did the camera, projection, fog or shadow box move enough that the last cull may show holes? */
  private needsCull(ctx: FrameContext): boolean {
    if (this.viewDirty) return true;
    const cam = ctx.camera;
    const e = cam.matrixWorld.elements;
    const l = this.lastCam;
    const margin = this.cullMargin(ctx);
    const dx = e[12] - l[12];
    const dy = e[13] - l[13];
    const dz = e[14] - l[14];
    if (dx * dx + dy * dy + dz * dz > (margin * 0.4) ** 2) return true;
    // view direction (camera -Z) turned: points at the fog distance move by angle × distance
    const dot = e[8] * l[8] + e[9] * l[9] + e[10] * l[10];
    const reach = Math.max(60, Math.min(this.lastFogFar, 400));
    const maxAngle = (margin * 0.5) / reach;
    if (dot < Math.cos(maxAngle)) return true;
    // roll/up change (e.g. pitch) is covered by the forward test; projection (resize / fov)
    const pe = cam.projectionMatrix.elements;
    if (Math.abs(pe[0] - this.lastProj0) > 1e-4 || Math.abs(pe[5] - this.lastProj5) > 1e-4) return true;
    const fog = this.fogFar();
    if (Math.abs(fog - this.lastFogFar) > Math.max(4, this.lastFogFar * 0.04)) return true;
    const sky = getSkyRenderer(this.scene);
    if (sky && sky.shadowCasting && sky.shadowVersion !== this.lastShadowVersion
      && ctx.realTime - this.lastShadowCullAt >= SHADOW_RECULL_INTERVAL) return true;
    return false;
  }

  private cull(ctx: FrameContext): void {
    this.viewDirty = false;
    this.stats.culls++;
    const cam = ctx.camera;
    this.lastCam.set(cam.matrixWorld.elements);
    this.lastProj0 = cam.projectionMatrix.elements[0];
    this.lastProj5 = cam.projectionMatrix.elements[5];
    const fogFar = this.fogFar();
    this.lastFogFar = fogFar;
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const mp = planesFromFrustum(_frustum, this.mainPlanes);
    const sky = getSkyRenderer(this.scene);
    const shadowOn = !!sky && sky.shadowCasting && this.quality !== 'low';
    let sp: Float32Array | null = null;
    // light direction (towards the light) for the shadow-footprint test
    let lx = 0;
    let ly = 1;
    let lz = 0;
    if (shadowOn && sky) {
      sp = planesFromFrustum(sky.shadowCull, this.shadowPlanes);
      this.lastShadowVersion = sky.shadowVersion;
      this.lastShadowCullAt = ctx.realTime;
      const ld = sky.state.lightDir;
      const len = Math.hypot(ld[0], ld[1], ld[2]) || 1;
      lx = ld[0] / len;
      ly = Math.max(0.2, ld[1] / len);
      lz = ld[2] / len;
    }
    const margin = this.cullMargin(ctx);
    const lod = this.lod;
    const cx = cam.position.x;
    const cy = cam.position.y;
    const cz = cam.position.z;
    const fog2 = fogFar + 4;

    for (const set of this.allSets) set.count = 0;
    let trees0 = 0;
    let trees1 = 0;
    let trees2 = 0;
    let rocks = 0;
    let casters = 0;

    for (let ci = 0; ci < this.chunks.length; ci++) {
      const ch = this.chunks[ci];
      let any = 0;
      for (let k = 0; k < KIND_COUNT; k++) any += ch.n[k];
      if (any === 0) continue;
      const bx0 = ch.x0 - 1.5;
      const bx1 = ch.x1 + 1.5;
      const bz0 = ch.z0 - 1.5;
      const bz1 = ch.z1 + 1.5;
      // nearest distance from the camera to the chunk box (fog cull)
      const nx = cx < bx0 ? bx0 : cx > bx1 ? bx1 : cx;
      const nz = cz < bz0 ? bz0 : cz > bz1 ? bz1 : cz;
      const ny = cy < ch.minY ? ch.minY : cy > ch.maxY ? ch.maxY : cy;
      const near = Math.hypot(cx - nx, cy - ny, cz - nz);
      const inMain = near < fog2 && boxInPlanes(mp, bx0 - margin, ch.minY - margin, bz0 - margin, bx1 + margin, ch.maxY + margin, bz1 + margin);
      const inShadow = sp !== null && near < lod.lod1
        && boxInPlanes(sp, bx0 - SHADOW_MARGIN, ch.minY - SHADOW_MARGIN, bz0 - SHADOW_MARGIN, bx1 + SHADOW_MARGIN, ch.maxY + SHADOW_MARGIN, bz1 + SHADOW_MARGIN);
      if (!inMain && !inShadow) continue;
      for (let k = 0; k < KIND_COUNT; k++) {
        const n = ch.n[k];
        if (n === 0) continue;
        const sph = ch.sph[k];
        const isTree = k <= KIND_BIRCH;
        const mainSets = this.main[k];
        const shadowSets = this.shadow[k];
        for (let i = 0; i < n; i++) {
          const o = i * 4;
          const x = sph[o];
          const y = sph[o + 1];
          const z = sph[o + 2];
          const r = sph[o + 3];
          const ddx = x - cx;
          const ddy = y - cy;
          const ddz = z - cz;
          const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          if (inMain && d - r < fogFar && sphereInPlanes(mp, x, y, z, r + margin)) {
            if (isTree) {
              const l = d < lod.lod0 ? 0 : d < lod.lod1 ? 1 : 2;
              this.pushRef(mainSets[l], ci, i);
              if (l === 0) trees0++;
              else if (l === 1) trees1++;
              else trees2++;
            } else {
              this.pushRef(mainSets[0], ci, i);
              if (k !== KIND_MARKER) rocks++;
            }
          }
          // a caster matters only if its shadow can land on something visible: test the sphere swept down-light
          // to the ground (bounding sphere of the segment) against the camera frustum as well as the shadow box
          if (inShadow && k !== KIND_MARKER && sphereInPlanes(sp!, x, y, z, r + SHADOW_MARGIN)
            && sphereInPlanes(mp, x - lx * (r / ly), y - ly * (r / ly), z - lz * (r / ly), 2 * r + r / ly + margin)) {
            if (isTree) {
              if (d < lod.lod1) {
                this.pushRef(shadowSets[d < lod.shadowLod0 ? 0 : d < lod.shadowLod1 ? 1 : 2], ci, i);
                casters++;
              }
            } else if (d < lod.rockShadow) {
              this.pushRef(shadowSets[0], ci, i);
              casters++;
            }
          }
        }
      }
    }

    for (const set of this.allSets) this.fill(set);
    this.stats.trees[0] = trees0;
    this.stats.trees[1] = trees1;
    this.stats.trees[2] = trees2;
    this.stats.rocks = rocks;
    this.stats.shadowCasters = casters;
  }

  private pushRef(set: DrawSet, chunk: number, i: number): void {
    const j = set.count * 2;
    if (j + 2 > set.refs.length) {
      const next = new Int32Array(set.refs.length * 2);
      next.set(set.refs);
      set.refs = next;
    }
    set.refs[j] = chunk;
    set.refs[j + 1] = i;
    set.count++;
  }

  /** Copy the referenced instances into the set's GPU buffers and commit. */
  private fill(set: DrawSet): void {
    const n = set.count;
    const gi = set.gi;
    if (n === 0) {
      gi.commit(0);
      return;
    }
    gi.ensure(n);
    const dm = gi.matrixArray;
    const di = gi.extras.aInst.array as Float32Array;
    const k = set.kind;
    const refs = set.refs;
    for (let j = 0; j < n; j++) {
      const ch = this.chunks[refs[j * 2]];
      const i = refs[j * 2 + 1];
      const sm = ch.mat[k];
      const si = ch.inst[k];
      const a = i * 16;
      const b = j * 16;
      for (let t = 0; t < 16; t++) dm[b + t] = sm[a + t];
      const c = i * 4;
      const e = j * 4;
      di[e] = si[c];
      di[e + 1] = si[c + 1];
      di[e + 2] = si[c + 2];
      di[e + 3] = si[c + 3];
    }
    gi.commit(n);
  }

  private updateUniforms(ctx: FrameContext, s: GameState): void {
    const env = this.env;
    env.uTime.value = ctx.realTime;
    env.uSnow.value = clamp01(ctx.snow);
    const w = s.weather;
    env.uWind.value.set(Math.cos(w.windDir), Math.sin(w.windDir), clamp01(w.windStrength));
    env.uMarkerScale.value = clamp(ctx.cameraDistance / 32, 1, 3.2);
    for (let sp = 0; sp < 3; sp++) {
      const p = foliageAt(SPECIES_NAMES[sp], ctx.yearProgress, this.fparams);
      const u = this.foliage[sp];
      u.uLeaf.value = p.leaf;
      u.uAutumn.value = p.autumn;
      u.uBrown.value = p.brown;
      u.uBlossom.value = p.blossom;
      setSRGB(u.uGreen.value, p.green);
      setSRGB(u.uAutA.value, p.autA);
      setSRGB(u.uAutB.value, p.autB);
      setSRGB(u.uAutC.value, p.autC);
      setSRGB(u.uBrownCol.value, p.brownCol);
    }
  }

  private chunkIndexOfTile(x: number, z: number): number {
    return Math.floor(z / NATURE_CHUNK) * this.chunksX + Math.floor(x / NATURE_CHUNK);
  }

  /** Diff every tile against the snapshot; mark changed chunks dirty; spawn falling trees for felled trees. */
  private fullScan(animate: boolean, ctx?: FrameContext): void {
    const s = this.game.state;
    const t = s.tiles;
    const W = s.W;
    const n = W * s.H;
    const snap = this.snapshot;
    const camX = ctx ? ctx.focusX : 0;
    const camZ = ctx ? ctx.focusZ : 0;
    const animRange = ctx ? Math.max(40, ctx.cameraDistance * 1.2) : 0;
    for (let i = 0; i < n; i++) {
      const k = featureKey(t.feature[i], t.marked[i], t.variant[i], t.featureAmount[i]);
      const old = snap[i];
      if (k === old) continue;
      snap[i] = k;
      const x = i % W;
      const z = (i - x) / W;
      this.chunks[this.chunkIndexOfTile(x, z)].dirty = true;
      if (animate && this.initialBuildDone && (old & 3) === Feature.Tree && (k & 3) !== Feature.Tree) {
        const growth = (old >> 5) / 40;
        if (growth >= 0.35) {
          const dx = x + 0.5 - camX;
          const dz = z + 0.5 - camZ;
          if (dx * dx + dz * dz < animRange * animRange) {
            const sp = (old >> 3) & 3;
            const tp = placeTree(s, x, z, growth, _tp);
            this.falling.spawn(sp % 3, tp.x, tp.y, tp.z, tp.yaw, tp.sx, tp.sy, tp.sz,
              hashTile(x, z, 20) * TAU, tp.variation, growth, tp.stagger);
          }
        }
      }
    }
  }

  private rebuildDirty(ctx: FrameContext): void {
    let budget = REBUILDS_PER_FRAME;
    while (budget > 0) {
      // Pick the dirty chunk nearest to the camera focus.
      let best: Chunk | null = null;
      let bestD = Infinity;
      for (let i = 0; i < this.chunks.length; i++) {
        const ch = this.chunks[i];
        if (!ch.dirty) continue;
        const dx = ch.cx - ctx.focusX;
        const dz = ch.cz - ctx.focusZ;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = ch;
        }
      }
      if (!best) return;
      this.rebuildChunk(best);
      budget--;
    }
  }

  private rebuildChunk(ch: Chunk): void {
    ch.dirty = false;
    this.viewDirty = true;
    const s = this.game.state;
    const t = s.tiles;
    const W = s.W;
    const counts = this.counts;
    counts.fill(0);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let z = ch.z0; z < ch.z1; z++) {
      for (let x = ch.x0; x < ch.x1; x++) {
        const i = z * W + x;
        const f = t.feature[i];
        if (f === Feature.None) continue;
        const marked = t.marked[i] ? 1 : 0;
        let top = 0;
        let px = 0;
        let pz = 0;
        let py = 0;
        if (f === Feature.Tree) {
          const kind = t.variant[i] % 3;
          const growth = clamp01(t.featureAmount[i]);
          const tp = placeTree(s, x, z, growth, _tp);
          _e.set(tp.lx, tp.yaw, tp.lz, 'YXZ');
          _q.setFromEuler(_e);
          _m.compose(_p.set(tp.x, tp.y, tp.z), _q, _s.set(tp.sx, tp.sy, tp.sz));
          top = SPECIES_TOP[kind] * tp.sy;
          // bounding sphere: centred half-way up, radius covers the height and the crown width
          const r = Math.max(top * 0.5, 0.95 * tp.sx) + 0.15;
          this.push(kind, tp.variation, marked, growth, tp.stagger, tp.x, tp.y + top * 0.5, tp.z, r);
          px = tp.x;
          py = tp.y;
          pz = tp.z;
        } else if (f === Feature.Rock || f === Feature.Iron) {
          const kind = f === Feature.Rock ? KIND_ROCK : KIND_IRON;
          const sc = rockScale(t.featureAmount[i]);
          px = x + 0.5 + (hashTile(x, z, 21) - 0.5) * 0.25;
          pz = z + 0.5 + (hashTile(x, z, 22) - 0.5) * 0.25;
          py = heightAt(s, px, pz) - 0.04 * sc;
          const yaw = hashTile(x, z, 23) * TAU;
          _e.set((hashTile(x, z, 24) - 0.5) * 0.2, yaw, (hashTile(x, z, 25) - 0.5) * 0.2, 'YXZ');
          _q.setFromEuler(_e);
          const sy = sc * (0.85 + hashTile(x, z, 26) * 0.3);
          _m.compose(_p.set(px, py, pz), _q, _s.set(sc * (0.78 + hashTile(x, z, 27) * 0.18), sy, sc * 0.82));
          top = ROCK_TOP * sy;
          this.push(kind, hashTile(x, z, 28), marked, 1, 0, px, py + top * 0.5, pz, 0.62 * sc + 0.05);
        } else {
          continue;
        }
        if (py < minY) minY = py;
        if (py + top > maxY) maxY = py + top;
        if (marked) {
          _q.identity();
          _m.compose(_p.set(px, py + top + 0.32, pz), _q, _s.set(1, 1, 1));
          this.push(KIND_MARKER, hashTile(x, z, 29), 1, 1, 0, px, py + top + 0.32, pz, 1.0);
          if (py + top + 1.4 > maxY) maxY = py + top + 1.4;
        }
      }
    }
    ch.minY = Number.isFinite(minY) ? minY - 0.5 : 0;
    ch.maxY = Number.isFinite(maxY) ? maxY + 0.5 : 0;
    for (let k = 0; k < KIND_COUNT; k++) {
      const n = counts[k];
      ch.n[k] = n;
      if (n === 0) continue;
      if (ch.mat[k].length < n * 16) {
        const cap = Math.min(MAX_PER_CHUNK, Math.max(n, Math.ceil(n * 1.25) + 8));
        ch.mat[k] = new Float32Array(cap * 16);
        ch.inst[k] = new Float32Array(cap * 4);
        ch.sph[k] = new Float32Array(cap * 4);
      }
      ch.mat[k].set(this.scratchMat[k].subarray(0, n * 16));
      ch.inst[k].set(this.scratchInst[k].subarray(0, n * 4));
      ch.sph[k].set(this.scratchSph[k].subarray(0, n * 4));
    }
  }

  /** Append the current scratch matrix `_m` + instance data + bounding sphere for a kind. */
  private push(
    kind: number, variation: number, marked: number, growth: number, stagger: number,
    sx: number, sy: number, sz: number, sr: number,
  ): void {
    const n = this.counts[kind];
    if (n >= MAX_PER_CHUNK) return;
    _m.toArray(this.scratchMat[kind], n * 16);
    const a = this.scratchInst[kind];
    a[n * 4] = variation;
    a[n * 4 + 1] = marked;
    a[n * 4 + 2] = growth;
    a[n * 4 + 3] = stagger;
    const b = this.scratchSph[kind];
    b[n * 4] = sx;
    b[n * 4 + 1] = sy;
    b[n * 4 + 2] = sz;
    b[n * 4 + 3] = sr;
    this.counts[kind] = n + 1;
  }
}

/** Number of tree LOD levels used by the nature renderer (full, reduced, far). */
export const NATURE_TREE_LODS = TREE_LODS;
