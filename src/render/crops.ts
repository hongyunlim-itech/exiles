/**
 * Crop field plants per FieldTile stage/growth and orchard trees (maturity, blossom in spring, fruit in late summer/autumn).
 * OWNER: render-entities agent.
 *
 * One instance per field tile per visual layer (furrows, crop plants by type, corn cobs, stubble / mounds) and one
 * orchard tree per ~2×2 tiles (+ fruit dots). Rebuilt lazily when rev.fields / rev.buildings change (throttled) and
 * periodically for orchard fruit/maturity. Crops follow the tile slope via a shear so stalks stay vertical.
 */
import * as THREE from 'three';
import { CROPS, ORCHARDS } from '../core/defs';
import type { Building, CropType, FieldTile, GameState } from '../core/types';
import { heightAt } from '../core/world';
import type { Game } from '../sim/game';
import {
  buildBeans, buildCorn, buildCornCobs, buildFurrows, buildMounds, buildOrchardFruit, buildOrchardTree, buildPotato,
  buildStubble, buildWheat,
} from './entities/cropModels';
import {
  createEntityMaterial, createEnvUniforms, createFoliageUniforms, setSRGB, type FoliageUniforms,
} from './entities/entityMaterial';
import { smallPropShadows } from './entities/cull';
import { tilePlane } from './entities/ground';
import { GrowableInstances } from './entities/instancing';
import { clamp, clamp01, hashTile, smoothstep, TAU } from './entities/math';
import { createFoliageParams, foliageAt } from './entities/palette';
import type { FrameContext, SubRenderer } from './types';

const K_FURROW = 0;
const K_WHEAT = 1;
const K_CORN = 2;
const K_COB = 3;
const K_POTATO = 4;
const K_BEANS = 5;
const K_STUBBLE = 6;
const K_MOUND = 7;
const K_TREE = 8;
const K_FRUIT = 9;
const K_COUNT = 10;

const CROP_KIND: Record<CropType, number> = { wheat: K_WHEAT, corn: K_CORN, potato: K_POTATO, beans: K_BEANS };
const REBUILD_INTERVAL = 0.35;
const ORCHARD_REFRESH = 2.0;

type RGB = [number, number, number];

function lin(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const STRAW = lin(0xb89a5a);
const SOIL = lin(0x6b5236);
const COB = lin(0xe0bc48);
const UNRIPE_FRUIT = lin(0x7a9a3a);

const cropYoung = new Map<CropType, RGB>();
const cropRipe = new Map<CropType, RGB>();
for (const k of Object.keys(CROPS) as CropType[]) {
  cropYoung.set(k, lin(CROPS[k].colorYoung));
  cropRipe.set(k, lin(CROPS[k].colorRipe));
}

const _m = new THREE.Matrix4();
const _plane = new Float32Array(3);
const _col: RGB = [0, 0, 0];
const _c = new THREE.Color();

export class CropRenderer implements SubRenderer {
  private game: Game;
  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly env = createEnvUniforms();
  private readonly foliage: FoliageUniforms = createFoliageUniforms();
  private readonly fparams = createFoliageParams();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly sets: GrowableInstances[] = [];
  private readonly counts = new Int32Array(K_COUNT);
  private lastFields = -1;
  private lastBuildings = -1;
  private lastBuild = -1e9;
  private lastOrchardRefresh = -1e9;
  private dirty = true;
  private hasOrchards = false;
  private shadows = true;
  /** 0..1 how much fruit the current foliage can show (0 when leaves are gone). */
  private fruitSeason = 1;

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.root.name = 'crops';
    scene.add(this.root);

    const furrowMat = createEntityMaterial(this.env, { key: 'furrow', snow: { lo: 0.4, hi: 0.8, amount: 1 } }).material;
    const plantMat = createEntityMaterial(this.env, {
      key: 'crop', sway: { start: 0.05, amp: 0.06 }, snow: { lo: 0.45, hi: 0.85, amount: 0.9 }, side: THREE.DoubleSide,
    }).material;
    const tree = createEntityMaterial(this.env, {
      key: 'orchard', parts: true, inst: true, foliage: this.foliage, tint: true, sway: { start: 0.5, amp: 0.02 },
      snow: { lo: 0.45, hi: 0.85, amount: 0.9 }, depth: true,
    });
    const fruitMat = createEntityMaterial(this.env, {
      key: 'fruit', parts: true, inst: true, instShrink: true, sway: { start: 0.5, amp: 0.02 },
    }).material;
    this.materials.push(furrowMat, plantMat, tree.material, fruitMat);
    if (tree.depth) this.materials.push(tree.depth);

    const geo = (g: THREE.BufferGeometry) => {
      this.geometries.push(g);
      return g;
    };
    const plant = (g: THREE.BufferGeometry, shadow: boolean) =>
      new GrowableInstances(this.root, geo(g), plantMat, {}, 64, { instanceColor: true, castShadow: shadow, receiveShadow: true, frustumCulled: true });
    this.sets[K_FURROW] = new GrowableInstances(this.root, geo(buildFurrows()), furrowMat, {}, 64, { receiveShadow: true, frustumCulled: true });
    this.sets[K_WHEAT] = plant(buildWheat(), false);
    this.sets[K_CORN] = plant(buildCorn(), true);
    this.sets[K_COB] = plant(buildCornCobs(), false);
    this.sets[K_POTATO] = plant(buildPotato(), false);
    this.sets[K_BEANS] = plant(buildBeans(), true);
    this.sets[K_STUBBLE] = plant(buildStubble(), false);
    this.sets[K_MOUND] = plant(buildMounds(), false);
    this.sets[K_TREE] = new GrowableInstances(this.root, geo(buildOrchardTree()), tree.material, { aInst: 4, aTint: 3 }, 32, {
      castShadow: true, receiveShadow: true, depthMaterial: tree.depth, frustumCulled: true,
    });
    this.sets[K_FRUIT] = new GrowableInstances(this.root, geo(buildOrchardFruit()), fruitMat, { aInst: 4 }, 32, {
      instanceColor: true, receiveShadow: true, frustumCulled: true,
    });
  }

  setGame(game: Game): void {
    this.game = game;
    this.dirty = true;
    this.lastFields = -1;
    this.lastBuildings = -1;
    this.lastBuild = -1e9;
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    const env = this.env;
    env.uTime.value = ctx.realTime;
    env.uSnow.value = clamp01(ctx.snow);
    env.uWind.value.set(Math.cos(s.weather.windDir), Math.sin(s.weather.windDir), clamp01(s.weather.windStrength));
    const p = foliageAt('orchard', ctx.yearProgress, this.fparams);
    const u = this.foliage;
    u.uLeaf.value = p.leaf;
    u.uAutumn.value = p.autumn;
    u.uBrown.value = p.brown;
    u.uBlossom.value = p.blossom;
    this.fruitSeason = smoothstep(0.15, 0.6, p.leaf);
    setSRGB(u.uGreen.value, p.green);
    setSRGB(u.uAutA.value, p.autA);
    setSRGB(u.uAutB.value, p.autB);
    setSRGB(u.uAutC.value, p.autC);
    setSRGB(u.uBrownCol.value, p.brownCol);

    // low crops only cast shadows when zoomed in (orchard trees always do)
    const wantShadows = smallPropShadows(ctx.cameraDistance, ctx.quality, this.shadows);
    if (wantShadows !== this.shadows) {
      this.shadows = wantShadows;
      this.sets[K_CORN].setShadowEnabled(wantShadows);
      this.sets[K_BEANS].setShadowEnabled(wantShadows);
    }

    if (s.rev.fields !== this.lastFields || s.rev.buildings !== this.lastBuildings) this.dirty = true;
    if (this.hasOrchards && ctx.realTime - this.lastOrchardRefresh >= ORCHARD_REFRESH) this.dirty = true;
    if (this.dirty && ctx.realTime - this.lastBuild >= REBUILD_INTERVAL) {
      this.lastFields = s.rev.fields;
      this.lastBuildings = s.rev.buildings;
      this.lastBuild = ctx.realTime;
      this.lastOrchardRefresh = ctx.realTime;
      this.dirty = false;
      this.rebuild(s);
    }
  }

  dispose(): void {
    for (const set of this.sets) set.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.scene.remove(this.root);
  }

  /** Force an immediate rebuild on the next update (debug / tests). */
  invalidate(): void {
    this.dirty = true;
    this.lastBuild = -1e9;
  }

  // ---------------------------------------------------------------------------------------------

  private rebuild(s: GameState): void {
    // Capacity upper bounds.
    let tiles = 0;
    let trees = 0;
    for (const b of s.buildings) {
      if (!renderable(b)) continue;
      if (b.type === 'cropField') tiles += b.w * b.h;
      else if (b.type === 'orchard') trees += Math.max(1, Math.floor(b.w / 2)) * Math.max(1, Math.floor(b.h / 2));
    }
    for (let k = 0; k < K_TREE; k++) this.sets[k].ensure(tiles);
    this.sets[K_TREE].ensure(trees);
    this.sets[K_FRUIT].ensure(trees);
    this.counts.fill(0);
    this.hasOrchards = false;
    for (const b of s.buildings) {
      if (!renderable(b)) continue;
      if (b.type === 'cropField') this.addField(s, b);
      else if (b.type === 'orchard') {
        this.hasOrchards = true;
        this.addOrchard(s, b);
      }
    }
    for (let k = 0; k < K_COUNT; k++) this.sets[k].commit(this.counts[k], true);
  }

  private addField(s: GameState, b: Building): void {
    const tilesArr = b.fieldTiles;
    if (!tilesArr) return;
    const crop: CropType = b.crop ?? 'wheat';
    const def = CROPS[crop];
    const kind = CROP_KIND[crop];
    const young = cropYoung.get(crop)!;
    const ripe = cropRipe.get(crop)!;
    const grain = crop === 'wheat' || crop === 'corn';
    for (let j = 0; j < tilesArr.length; j++) {
      const ft: FieldTile = tilesArr[j];
      if (!ft || ft.stage <= 0) continue;
      const tx = b.x + (j % b.w);
      const tz = b.z + Math.floor(j / b.w);
      if (tx < 0 || tz < 0 || tx >= s.W || tz >= s.H) continue;
      tilePlane(s, tx, tz, _plane);
      const flip = hashTile(tx, tz, 41) < 0.5;
      const vary = 0.94 + hashTile(tx, tz, 42) * 0.12;
      const hj = 0.92 + hashTile(tx, tz, 43) * 0.16;
      const g = clamp01(ft.growth);
      if (ft.stage === 1 || (ft.stage === 2 && g < 0.3)) {
        this.put(K_FURROW, tx, tz, 1, 1, flip, null);
      }
      if (ft.stage === 2 || ft.stage === 3) {
        const growth = ft.stage === 3 ? 1 : g;
        const sy = def.height * (0.1 + 0.9 * growth) * hj;
        const sxz = 0.55 + 0.45 * growth;
        const t = ft.stage === 3 ? 1 : smoothstep(0.55, 1.0, growth);
        const sprout = ft.stage === 2 && growth < 0.15 ? 1.12 : 1;
        _col[0] = (young[0] + (ripe[0] - young[0]) * t) * vary * sprout;
        _col[1] = (young[1] + (ripe[1] - young[1]) * t) * vary * sprout;
        _col[2] = (young[2] + (ripe[2] - young[2]) * t) * vary;
        this.put(kind, tx, tz, sxz, sy, flip, _col);
        if (crop === 'corn' && growth > 0.7) {
          const cs = smoothstep(0.7, 1, growth);
          _col[0] = COB[0] * vary;
          _col[1] = COB[1] * vary;
          _col[2] = COB[2] * vary;
          this.put(K_COB, tx, tz, sxz, sy * (0.8 + 0.2 * cs), flip, _col);
        }
      } else if (ft.stage === 4) {
        if (grain) {
          _col[0] = STRAW[0] * vary;
          _col[1] = STRAW[1] * vary;
          _col[2] = STRAW[2] * vary;
          this.put(K_STUBBLE, tx, tz, 1, 0.1 * hj, flip, _col);
        } else {
          _col[0] = SOIL[0] * vary;
          _col[1] = SOIL[1] * vary;
          _col[2] = SOIL[2] * vary;
          this.put(K_MOUND, tx, tz, 1, 1, flip, _col);
        }
      }
    }
  }

  private addOrchard(s: GameState, b: Building): void {
    const o = b.orchard;
    const type = o?.type ?? 'apple';
    const def = ORCHARDS[type];
    const maturity = clamp01(o?.maturity ?? 0);
    const fruitAmt = clamp01(o?.fruit ?? 0);
    const nx = Math.max(1, Math.floor(b.w / 2));
    const nz = Math.max(1, Math.floor(b.h / 2));
    const ox = (b.w - nx * 2) / 2;
    const oz = (b.h - nz * 2) / 2;
    const blossom = _c.setHex(def.blossomColor);
    const br = blossom.r;
    const bg = blossom.g;
    const bb = blossom.b;
    _c.setHex(def.fruitColor);
    const fr = _c.r;
    const fg = _c.g;
    const fb = _c.b;
    const tileArr = b.fieldTiles;
    const treeSet = this.sets[K_TREE];
    const fruitSet = this.sets[K_FRUIT];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const cx = b.x + ox + i * 2 + 1;
        const cz = b.z + oz + j * 2 + 1;
        const ix = Math.floor(cx);
        const iz = Math.floor(cz);
        const px = cx + (hashTile(ix, iz, 51) - 0.5) * 0.25;
        const pz = cz + (hashTile(ix, iz, 52) - 0.5) * 0.25;
        const py = heightAt(s, px, pz) - 0.03;
        const sc = (0.3 + 0.7 * maturity) * (0.92 + hashTile(ix, iz, 53) * 0.16);
        const yaw = hashTile(ix, iz, 54) * TAU;
        const cyaw = Math.cos(yaw) * sc;
        const syaw = Math.sin(yaw) * sc;
        _m.set(
          cyaw, 0, syaw, px,
          0, sc, 0, py,
          -syaw, 0, cyaw, pz,
          0, 0, 0, 1,
        );
        const n = this.counts[K_TREE]++;
        _m.toArray(treeSet.matrixArray, n * 16);
        const ai = treeSet.extras.aInst.array as Float32Array;
        ai[n * 4] = hashTile(ix, iz, 55);
        ai[n * 4 + 1] = 0;
        ai[n * 4 + 2] = maturity;
        ai[n * 4 + 3] = hashTile(ix, iz, 56);
        const at = treeSet.extras.aTint.array as Float32Array;
        at[n * 3] = br;
        at[n * 3 + 1] = bg;
        at[n * 3 + 2] = bb;

        // Fruit: ripe/harvested state of the tree's 2×2 tile cell.
        let fruit = fruitAmt;
        let ripeness = smoothstep(0.35, 0.9, fruitAmt);
        if (tileArr && tileArr.length === b.w * b.h) {
          let ripeTiles = 0;
          let harvested = 0;
          let cells = 0;
          for (let dz = -1; dz <= 0; dz++) {
            for (let dx = -1; dx <= 0; dx++) {
              const lx = Math.floor(cx) + dx - b.x;
              const lz = Math.floor(cz) + dz - b.z;
              if (lx < 0 || lz < 0 || lx >= b.w || lz >= b.h) continue;
              const ft = tileArr[lz * b.w + lx];
              if (!ft) continue;
              cells++;
              if (ft.stage === 3) ripeTiles++;
              else if (ft.stage === 4) harvested++;
            }
          }
          if (cells > 0) {
            if (ripeTiles > 0) {
              fruit = Math.max(fruit, 0.6 + 0.4 * (ripeTiles / cells));
              ripeness = 1;
            } else if (harvested === cells) {
              fruit = 0;
            }
          }
        }
        if (maturity < 0.45) fruit = 0;
        // No fruit hangs on bare winter branches, whatever the sim says.
        fruit *= this.fruitSeason;
        if (fruit > 0.03) {
          const f = this.counts[K_FRUIT]++;
          _m.toArray(fruitSet.matrixArray, f * 16);
          const fi = fruitSet.extras.aInst.array as Float32Array;
          fi[f * 4] = 0;
          fi[f * 4 + 1] = 0;
          fi[f * 4 + 2] = clamp(0.35 + 0.65 * fruit, 0, 1);
          fi[f * 4 + 3] = 0;
          const fc = fruitSet.colorArray!;
          fc[f * 3] = UNRIPE_FRUIT[0] + (fr - UNRIPE_FRUIT[0]) * ripeness;
          fc[f * 3 + 1] = UNRIPE_FRUIT[1] + (fg - UNRIPE_FRUIT[1]) * ripeness;
          fc[f * 3 + 2] = UNRIPE_FRUIT[2] + (fb - UNRIPE_FRUIT[2]) * ripeness;
        }
      }
    }
  }

  /** Write one sheared per-tile instance (rows along X, optionally flipped 180°). */
  private put(kind: number, tx: number, tz: number, sxz: number, sy: number, flip: boolean, color: RGB | null): void {
    const set = this.sets[kind];
    const n = this.counts[kind]++;
    const base = _plane[0];
    const slx = _plane[1];
    const slz = _plane[2];
    const f = flip ? -1 : 1;
    const cx = tx + 0.5;
    const cz = tz + 0.5;
    _m.set(
      f * sxz, 0, 0, cx,
      f * slx * sxz, sy, f * slz * sxz, base,
      0, 0, f * sxz, cz,
      0, 0, 0, 1,
    );
    _m.toArray(set.matrixArray, n * 16);
    if (color) {
      const ca = set.colorArray;
      if (ca) {
        ca[n * 3] = color[0];
        ca[n * 3 + 1] = color[1];
        ca[n * 3 + 2] = color[2];
      }
    }
  }
}

function renderable(b: Building): boolean {
  return (b.type === 'cropField' || b.type === 'orchard') && b.state !== 'clearing' && b.state !== 'ruin';
}
