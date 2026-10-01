import { describe, expect, it } from 'vitest';
import { Feature, Road, Terrain } from '../src/core/types';
import {
  computeCorners, computeCornersForTiles, computeNatural, computeNearWater, computeOverlay, computeTileNoise,
  createOverlayScratch, OV,
} from '../src/render/scene/terrainSurface';
import { buildWaterMesh, shoreDistance } from '../src/render/scene/waterMesh';
import { addBuilding, makeBuilding, makeState } from './renderscene.helpers';

const pat = (b: number) => b >> 4;
const mask = (b: number) => b & 15;

describe('computeOverlay', () => {
  it('draws roads with neighbour masks and connects dirt, stone and bridges', () => {
    const s = makeState(8, 8);
    const W = s.W;
    for (let x = 1; x <= 4; x++) s.tiles.road[3 * W + x] = Road.Dirt;
    s.tiles.road[3 * W + 5] = Road.Stone;
    s.tiles.terrain[3 * W + 6] = Terrain.Water;
    s.tiles.road[3 * W + 6] = Road.Bridge;
    const out = new Uint8Array(W * s.H);
    computeOverlay(s, out, createOverlayScratch(W * s.H));
    expect(pat(out[3 * W + 1])).toBe(OV.DIRT_ROAD);
    expect(mask(out[3 * W + 1])).toBe(0b0010); // only east neighbour is road
    expect(mask(out[3 * W + 2])).toBe(0b1010); // east + west
    expect(pat(out[3 * W + 5])).toBe(OV.STONE_ROAD);
    expect(mask(out[3 * W + 5])).toBe(0b1010); // connects to the bridge on the east
    expect(out[3 * W + 6]).toBe(0); // bridges are drawn by building models, terrain stays riverbed
    expect(out[0]).toBe(0);
  });

  it('paints pads, zones and field stages; ruins are charred; clearing is trodden', () => {
    const s = makeState(20, 20);
    const W = s.W;
    addBuilding(s, makeBuilding(1, 'woodenHouse', 1, 1, 3, 3));
    addBuilding(s, makeBuilding(2, 'woodenHouse', 5, 1, 3, 3, { state: 'ruin' }));
    addBuilding(s, makeBuilding(3, 'woodenHouse', 9, 1, 3, 3, { state: 'clearing' }));
    addBuilding(s, makeBuilding(4, 'cropField', 1, 6, 4, 2, {
      fieldTiles: [0, 1, 2, 3, 4, 4, 3, 0].map((stage) => ({ stage, growth: 0 })),
    }));
    addBuilding(s, makeBuilding(5, 'pasture', 8, 6, 3, 3));
    addBuilding(s, makeBuilding(6, 'quarry', 12, 6, 3, 3));
    const out = new Uint8Array(W * s.H);
    computeOverlay(s, out, createOverlayScratch(W * s.H));
    expect(pat(out[1 * W + 1])).toBe(OV.PACKED);
    expect(mask(out[2 * W + 2])).toBe(15); // interior tile: all neighbours same building
    expect(mask(out[1 * W + 1]) & 0b1001).toBe(0); // corner tile: north & west open
    expect(pat(out[1 * W + 5])).toBe(OV.CHARRED);
    expect(pat(out[1 * W + 9])).toBe(OV.TRODDEN);
    const f = (lx: number, lz: number) => pat(out[(6 + lz) * W + 1 + lx]);
    expect(f(0, 0)).toBe(OV.SOIL);
    expect(f(1, 0)).toBe(OV.FURROW_X);
    expect(f(3, 0)).toBe(OV.FURROW_X);
    expect(f(0, 1)).toBe(OV.STUBBLE_X);
    expect(f(3, 1)).toBe(OV.SOIL);
    expect(pat(out[6 * W + 8])).toBe(OV.PASTURE);
    expect(pat(out[6 * W + 12])).toBe(OV.QUARRY);
  });

  it('keeps water tiles under shore buildings natural', () => {
    const s = makeState(10, 10);
    const W = s.W;
    for (let x = 0; x < W; x++) s.tiles.terrain[5 * W + x] = Terrain.Water;
    addBuilding(s, makeBuilding(1, 'fishingDock', 2, 3, 3, 4));
    const out = new Uint8Array(W * s.H);
    computeOverlay(s, out, createOverlayScratch(W * s.H));
    expect(pat(out[4 * W + 3])).toBe(OV.PACKED);
    expect(out[5 * W + 3]).toBe(0);
    // the land tile next to the water tile of the same building stays connected (no soft edge toward it)
    expect(mask(out[4 * W + 3]) & 0b0100).toBe(0b0100);
  });
});

describe('computeNatural / computeCorners', () => {
  it('classifies sand, rock, water and forest floor', () => {
    const s = makeState(6, 6, 1);
    const W = s.W;
    s.tiles.terrain[0] = Terrain.Sand;
    s.tiles.terrain[1] = Terrain.Mountain;
    s.tiles.terrain[5 * W + 5] = Terrain.DeepWater;
    s.tiles.feature[2 * W + 2] = Feature.Tree;
    s.tiles.featureAmount[2 * W + 2] = 1;
    const n = W * s.H;
    const noise = computeTileNoise(W, s.H, 3);
    const near = new Uint8Array(n);
    computeNearWater(s, near);
    expect(near[4 * W + 4]).toBe(1);
    expect(near[5 * W + 5]).toBe(0);
    const rgb = new Uint8Array(n * 3);
    const mat = new Uint8Array(n * 4);
    expect(computeNatural(s, noise, near, rgb, mat)).toBeGreaterThan(0);
    expect(mat[0 * 4 + 3]).toBe(255); // sand layer
    expect(mat[1 * 4 + 2]).toBe(255); // rock layer
    expect(mat[(5 * W + 5) * 4 + 1]).toBe(0); // no snow on water
    expect(mat[(2 * W + 2) * 4 + 1]).toBeLessThan(255); // forest floor holds less snow
    const grassLum = rgb[3 * 3] + rgb[3 * 3 + 1];
    const forestLum = rgb[(2 * W + 2) * 3] + rgb[(2 * W + 2) * 3 + 1];
    expect(forestLum).toBeLessThan(grassLum);
    // unchanged input -> reports no change
    expect(computeNatural(s, noise, near, rgb, mat)).toBe(0);

    const cr = new Uint8Array((W + 1) * (s.H + 1) * 4);
    const cm = new Uint8Array((W + 1) * (s.H + 1) * 4);
    computeCorners(s, rgb, mat, cr, cm);
    // corner shared by the deep-water tile and land tiles takes land values (land wins)
    const c = (5 * (W + 1) + 5) * 4;
    expect(cm[c + 1]).toBe(255);
    // the far corner of the water tile only touches water
    const cw = (6 * (W + 1) + 6) * 4;
    expect(cm[cw + 1]).toBe(0);
  });
});

describe('incremental natural updates', () => {
  it('match a full recompute after trees change', () => {
    const s = makeState(24, 24, 1);
    const W = s.W;
    const n = W * s.H;
    for (let i = 0; i < n; i += 7) { s.tiles.feature[i] = Feature.Tree; s.tiles.featureAmount[i] = 0.8; }
    const noise = computeTileNoise(W, s.H, 9);
    const near = new Uint8Array(n);
    computeNearWater(s, near);
    const rgb = new Uint8Array(n * 3);
    const mat = new Uint8Array(n * 4);
    computeNatural(s, noise, near, rgb, mat);
    const cr = new Uint8Array((W + 1) * (s.H + 1) * 4);
    const cm = new Uint8Array((W + 1) * (s.H + 1) * 4);
    computeCorners(s, rgb, mat, cr, cm);
    // cut some trees, grow a sapling
    s.tiles.feature[0] = Feature.None;
    s.tiles.feature[7 * 10] = Feature.None;
    s.tiles.feature[5] = Feature.Tree;
    s.tiles.featureAmount[5] = 0.5;
    const changed = new Int32Array(64);
    const count = computeNatural(s, noise, near, rgb, mat, changed);
    expect(count).toBe(3);
    computeCornersForTiles(s, rgb, mat, cr, cm, changed, count);
    const fr = new Uint8Array(cr.length);
    const fm = new Uint8Array(cm.length);
    computeCorners(s, rgb, mat, fr, fm);
    expect(Array.from(cr)).toEqual(Array.from(fr));
    expect(Array.from(cm)).toEqual(Array.from(fm));
  });
});

describe('water mesh', () => {
  it('measures shore distance from land', () => {
    const s = makeState(9, 9);
    const W = s.W;
    for (let z = 2; z <= 6; z++) for (let x = 2; x <= 6; x++) s.tiles.terrain[z * W + x] = Terrain.Water;
    const d = shoreDistance(s);
    expect(d[0]).toBe(0);
    expect(d[2 * W + 2]).toBe(1);
    expect(d[4 * W + 4]).toBe(3);
  });

  it('covers water plus a land margin with a valid indexed mesh', () => {
    const s = makeState(12, 12, 1);
    const W = s.W;
    for (let z = 3; z <= 6; z++) for (let x = 3; x <= 6; x++) {
      s.tiles.terrain[z * W + x] = Terrain.Water;
    }
    for (let z = 3; z <= 7; z++) for (let x = 3; x <= 7; x++) s.tiles.height[z * (W + 1) + x] = -1;
    const m = buildWaterMesh(s);
    expect(m.waterTiles).toBe(16);
    expect(m.index.length).toBe(6 * 36); // 4x4 water + 1-tile margin = 6x6 quads
    const nv = m.positions.length / 3;
    for (const i of m.index) expect(i).toBeLessThan(nv);
    expect(Math.max(...m.depth)).toBeCloseTo(1, 5);
    expect(Math.min(...m.depth)).toBeCloseTo(-1, 5);
  });

  it('extends edge rivers past the map border and returns nothing without water', () => {
    const s = makeState(10, 10);
    const W = s.W;
    for (let x = 0; x < W; x++) s.tiles.terrain[5 * W + x] = Terrain.Water;
    const m = buildWaterMesh(s, 3);
    let minX = Infinity;
    for (let i = 0; i < m.positions.length; i += 3) minX = Math.min(minX, m.positions[i]);
    expect(minX).toBe(-3);
    expect(buildWaterMesh(makeState(5, 5)).waterTiles).toBe(0);
  });
});
