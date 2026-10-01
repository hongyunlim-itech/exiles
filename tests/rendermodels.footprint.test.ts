/**
 * render-models: every building model must fit its footprint (model space, door toward +Z), carry the attributes
 * the building material needs, and report sane metadata. Pure geometry — runs headless (no WebGL).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BUILDINGS, BUILDING_TYPES } from '../src/core/defs';
import type { Building, BuildingType, GameState } from '../src/core/types';
import {
  createBuildingModel, createGhostModel, disposeModel, getModelData, isSharedGeometry, isZoneType, modelDims, setGhostValid,
  variantOf,
} from '../src/render/models';
import { cemeterySlots, gateSpan } from '../src/render/models/types/zones';
import { computeBaseY, conformGeometry } from '../src/render/models/runtime/terrainFit';
import { shoreNeedsMirror } from '../src/render/models/runtime/visual';
import { Terrain } from '../src/core/types';
import {
  gravesGeometry, merchantBoatGeometry, pileShapeGeometry, ruinDebrisGeometry, scaffoldGeometry, stakesGeometry,
} from '../src/render/models/extras';

/** Types whose models intentionally reach over water beyond the land part (still inside the footprint). */
const EPS = 0.02;

function sizesFor(type: BuildingType): [number, number][] {
  const def = BUILDINGS[type];
  if (!def.resizable) return [def.size];
  const { min, max } = def.resizable;
  return [def.size, [min, min], [max, max], [min, max], [max, min]];
}

function checkGeometry(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const fx = g.getAttribute('fx') as THREE.BufferAttribute;
  expect(pos.count).toBeGreaterThan(0);
  expect(pos.count % 3).toBe(0);
  expect(col.count).toBe(pos.count);
  expect(nrm.count).toBe(pos.count);
  expect(fx.count).toBe(pos.count);
  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i])).toBe(true);
}

describe('render-models: building models', () => {
  it('has a model for every building type', () => {
    expect(BUILDING_TYPES.length).toBe(28);
    for (const type of BUILDING_TYPES) {
      const [w, h] = BUILDINGS[type].size;
      const m = createBuildingModel(type, w, h, 1);
      expect(m.root.children.length).toBeGreaterThan(0);
      expect(m.type).toBe(type);
    }
  });

  for (const type of BUILDING_TYPES) {
    it(`${type} fits its footprint for every variant/size`, () => {
      for (const [w, h] of sizesFor(type)) {
        const seeds = BUILDINGS[type].resizable ? 1 : 3;
        for (let seed = 0; seed < seeds; seed++) {
          const m = createBuildingModel(type, w, h, seed * 7 + 1);
          const g = m.mesh.geometry;
          checkGeometry(g);
          g.computeBoundingBox();
          const bb = g.boundingBox!;
          expect(bb.min.x, `${type} ${w}x${h} minX`).toBeGreaterThanOrEqual(-w / 2 - EPS);
          expect(bb.max.x, `${type} ${w}x${h} maxX`).toBeLessThanOrEqual(w / 2 + EPS);
          expect(bb.min.z, `${type} ${w}x${h} minZ`).toBeGreaterThanOrEqual(-h / 2 - EPS);
          expect(bb.max.z, `${type} ${w}x${h} maxZ`).toBeLessThanOrEqual(h / 2 + EPS);
          expect(bb.min.y).toBeGreaterThan(-3);
          expect(m.height).toBeGreaterThan(0.25);
          expect(m.height).toBeLessThan(7);
          for (const c of m.chimneys) {
            expect(Math.abs(c.x)).toBeLessThanOrEqual(w / 2);
            expect(Math.abs(c.z)).toBeLessThanOrEqual(h / 2);
            expect(c.y).toBeGreaterThan(1);
          }
          expect(m.fires.length).toBeGreaterThan(0);
          expect(m.body.maxX).toBeGreaterThan(m.body.minX);
          expect(m.body.maxZ).toBeGreaterThan(m.body.minZ);
        }
      }
    });
  }

  it('houses and workshops publish chimneys; the market and trading post publish goods slots', () => {
    for (const t of ['woodenHouse', 'stoneHouse', 'boardingHouse', 'blacksmith', 'woodcutter', 'tailor', 'brewery'] as const) {
      const [w, h] = BUILDINGS[t].size;
      expect(createBuildingModel(t, w, h, 3).chimneys.length, t).toBeGreaterThan(0);
    }
    expect(createBuildingModel('boardingHouse', 4, 5, 1).chimneys.length).toBe(2);
    expect(createBuildingModel('market', 7, 7, 1).slots.length).toBeGreaterThanOrEqual(12);
    const post = createBuildingModel('tradingPost', 5, 6, 1);
    expect(post.slots.length).toBeGreaterThan(0);
    expect(post.boat).not.toBeNull();
    expect(post.boat!.z).toBeLessThan(0); // moored on the water side (-Z)
  });

  it('shares geometry for fixed-size buildings and builds zones fresh', () => {
    const a = createBuildingModel('woodenHouse', 3, 3, 5);
    const b = createBuildingModel('woodenHouse', 3, 3, 5);
    expect(a.mesh.geometry).toBe(b.mesh.geometry);
    expect(isSharedGeometry(a.mesh.geometry)).toBe(true);
    const z1 = createBuildingModel('pasture', 8, 8, 5);
    const z2 = createBuildingModel('pasture', 8, 8, 5);
    expect(z1.mesh.geometry).not.toBe(z2.mesh.geometry);
    expect(isSharedGeometry(z1.mesh.geometry)).toBe(false);
    expect(isZoneType('pasture')).toBe(true);
    expect(isZoneType('woodenHouse')).toBe(false);
    for (let s = 0; s < 50; s++) expect([0, 1, 2]).toContain(variantOf(s));
  });

  it('modelDims swaps w/h for rotations 1 and 3', () => {
    expect(modelDims({ w: 5, h: 4, rotation: 1 })).toEqual([4, 5]);
    expect(modelDims({ w: 4, h: 5, rotation: 2 })).toEqual([4, 5]);
  });

  it('disposeModel leaves shared geometry intact and disposes private resources', () => {
    const m = createBuildingModel('woodenHouse', 3, 3, 9);
    let disposed = 0;
    m.mesh.geometry.addEventListener('dispose', () => disposed++);
    disposeModel(m.root);
    expect(disposed).toBe(0);
    const z = createBuildingModel('cropField', 6, 6, 2);
    let zd = 0;
    z.mesh.geometry.addEventListener('dispose', () => zd++);
    disposeModel(z.root);
    expect(zd).toBe(1);
  });
});

describe('render-models: ghosts', () => {
  it('creates translucent, shadowless ghosts with their own material and tints them', () => {
    const g = createGhostModel('storageBarn', 4, 5);
    const mesh = g.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshLambertMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mesh.castShadow).toBe(false);
    setGhostValid(g, false);
    const bad = mat.color.clone();
    setGhostValid(g, true);
    expect(mat.color.equals(bad)).toBe(false);
    const g2 = createGhostModel('storageBarn', 4, 5);
    expect((g2.children[0] as THREE.Mesh).material).not.toBe(mat);
    let geomDisposed = 0;
    mesh.geometry.addEventListener('dispose', () => geomDisposed++);
    let matDisposed = 0;
    mat.addEventListener('dispose', () => matDisposed++);
    disposeModel(g);
    expect(geomDisposed).toBe(0);
    expect(matDisposed).toBe(1);
  });
});

describe('render-models: zones & extras', () => {
  it('gate span covers the door tile for every rotation', () => {
    expect(gateSpan(7)).toEqual([-0.5, 0.5]);
    expect(gateSpan(8)).toEqual([-1, 1]);
  });

  it('cemetery slots hold the grave capacity inside the walls', () => {
    for (let w = 3; w <= 10; w++) {
      for (let h = 3; h <= 10; h++) {
        const cap = Math.floor(w * h * (BUILDINGS.cemetery.gravesPerTile ?? 0.5));
        const slots = cemeterySlots(w, h, cap);
        expect(slots.length, `${w}x${h}`).toBeGreaterThanOrEqual(Math.min(cap, 4));
        if (w >= 4 && h >= 4) expect(slots.length, `${w}x${h}`).toBeGreaterThanOrEqual(cap);
        for (const s of slots) {
          expect(Math.abs(s.x)).toBeLessThan(w / 2 - 0.2);
          expect(Math.abs(s.z)).toBeLessThan(h / 2 - 0.2);
        }
        if (w === h) checkGeometry(gravesGeometry(slots, cap, 1));
      }
    }
  });

  it('builds extras geometries', () => {
    const body = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, top: 1.2 };
    checkGeometry(scaffoldGeometry(body));
    checkGeometry(ruinDebrisGeometry(body));
    checkGeometry(stakesGeometry(3, 3));
    checkGeometry(merchantBoatGeometry());
    for (const s of ['logs', 'stones', 'ore', 'firewood', 'crate', 'basket', 'barrel', 'content', 'sack'] as const) checkGeometry(pileShapeGeometry(s));
    expect(scaffoldGeometry(body)).toBe(scaffoldGeometry({ ...body }));
  });
});

describe('render-models: terrain fitting', () => {
  function flatState(W: number, H: number, f: (x: number, z: number) => number): GameState {
    const height = new Float32Array((W + 1) * (H + 1));
    for (let z = 0; z <= H; z++) for (let x = 0; x <= W; x++) height[z * (W + 1) + x] = f(x, z);
    return {
      W, H,
      tiles: { height, terrain: new Uint8Array(W * H), feature: new Uint8Array(W * H), featureAmount: new Float32Array(W * H), variant: new Uint8Array(W * H), road: new Uint8Array(W * H), building: new Int32Array(W * H).fill(-1), marked: new Uint8Array(W * H), region: new Int32Array(W * H) },
    } as unknown as GameState;
  }
  const bld = (type: BuildingType, x: number, z: number, w: number, h: number): Building => ({ type, x, z, w, h, rotation: 0 } as Building);

  it('places buildings at the highest footprint corner (skirt covers the rest)', () => {
    const s = flatState(20, 20, (x) => x * 0.1);
    expect(computeBaseY(s, bld('woodenHouse', 2, 2, 3, 3))).toBeCloseTo(0.5, 5);
  });

  it('conforms zone geometry vertices to the terrain, keeping posts vertical', () => {
    const s = flatState(20, 20, (x, z) => x * 0.2 + z * 0.1);
    const b = bld('pasture', 4, 4, 8, 8);
    const { data } = getModelData('pasture', 8, 8, 1);
    const g = data.geometry;
    const base = new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);
    const baseY = computeBaseY(s, b);
    conformGeometry(s, g, base, b, baseY);
    const pos = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const wx = 8 + pos[i];
      const wz = 8 + pos[i + 2];
      const expected = base[i + 1] + (wx * 0.2 + wz * 0.1) - baseY;
      expect(pos[i + 1]).toBeCloseTo(expected, 3);
      expect(pos[i]).toBe(base[i]);
    }
  });

  it('mirrors shore layouts so the pier reaches over the wetter side', () => {
    const s = flatState(20, 20, () => 0.3);
    // water on the south (+Z) rows of a dock rotated to face east (rotation 3): model -X maps to world +Z
    for (let z = 10; z < 20; z++) for (let x = 0; x < 20; x++) (s.tiles.terrain as Uint8Array)[z * 20 + x] = Terrain.Water;
    const east = { type: 'fishingDock', x: 5, z: 8, w: 4, h: 3, rotation: 3 } as Building;
    expect(shoreNeedsMirror(s, east)).toBe(true);
    const west = { type: 'fishingDock', x: 5, z: 8, w: 4, h: 3, rotation: 1 } as Building;
    expect(shoreNeedsMirror(s, west)).toBe(false);
    // water straight ahead of the back side (rotation 2 = door north, water south): symmetric -> no mirror
    const north = { type: 'fishingDock', x: 5, z: 8, w: 3, h: 4, rotation: 2 } as Building;
    expect(shoreNeedsMirror(s, north)).toBe(false);
  });
});
