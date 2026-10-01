/**
 * Render/app performance: pure policy logic (GPU tiers, dynamic resolution, frame pacing, settings migration),
 * culling/LOD helpers, geometry invariants of the LOD'd terrain ring & chunked terrain, and a renderer.info-equivalent
 * census of a real scene (triangles & draw calls incl. the shadow pass) against the integrated-GPU budget.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/core/app';
import {
  boxInPlanes, createPlanes, natureLodFor, planesFromFrustum, smallPropShadows, sphereInPlanes, treeLodAt,
} from '../src/render/entities/cull';
import { buildFarTree, buildTree, SPECIES_TOP } from '../src/render/entities/treeModels';
import {
  classifyGpu, DynamicResolution, effectiveFpsCap, frameBudget, FramePacer, pixelRatioForTier, resolveQuality,
} from '../src/render/scene/perf';
import { borderBandRects, TerrainBorder } from '../src/render/scene/terrainBorder';
import { TerrainGeometry, terrainChunkSize } from '../src/render/scene/terrainGeometry';
import { fitShadowBox, shadowRadiusFor, type ShadowBox } from '../src/render/sky';
import { Game } from '../src/sim/game';
import { buildHeadlessScene, census, censusSettings, formatCensus } from './render.helpers';

describe('GPU tier detection (quality auto)', () => {
  const cases: [string, string][] = [
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['Intel(R) HD Graphics 400', 'medium'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['NVIDIA GeForce GTX 1050 Ti/PCIe/SSE2', 'high'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) RX Vega 10 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['AMD Radeon 780M Graphics', 'medium'],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['Intel(R) Arc(TM) A770 Graphics', 'high'],
    ['Intel(R) Arc(TM) Graphics', 'medium'],
    ['Apple M1', 'medium'],
    ['Apple GPU', 'medium'],
    ['Apple M2 Max', 'high'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low'],
    ['Microsoft Basic Render Driver', 'low'],
    ['', 'medium'],
  ];
  it.each(cases)('%s → %s', (name, tier) => {
    expect(classifyGpu(name)).toBe(tier);
  });

  it('resolves settings and caps the pixel ratio per tier', () => {
    expect(resolveQuality('auto', 'medium')).toBe('medium');
    expect(resolveQuality('high', 'low')).toBe('high');
    expect(resolveQuality(undefined, 'high')).toBe('high');
    expect(pixelRatioForTier('high', 2)).toBe(1.5);
    expect(pixelRatioForTier('high', 1)).toBe(1);
    expect(pixelRatioForTier('medium', 2)).toBe(1);
    expect(pixelRatioForTier('low', 1)).toBe(0.75);
  });
});

describe('dynamic resolution', () => {
  const run = (dr: DynamicResolution, ms: number, seconds: number, cpuMs = 2) => {
    const b = frameBudget(1000 / 60);
    let changes = 0;
    for (let t = 0; t < seconds * 1000; t += ms) if (dr.sample(ms, cpuMs, b.over, b.under)) changes++;
    return changes;
  };

  it('steps down only after ~1.5 s over budget and never below 0.6', () => {
    const dr = new DynamicResolution();
    run(dr, 30, 1.0);
    expect(dr.scale).toBe(1);
    run(dr, 30, 2.5);
    expect(dr.scale).toBeCloseTo(0.9, 5);
    run(dr, 30, 30);
    expect(dr.scale).toBeCloseTo(0.6, 5);
  });

  it('raises the scale back slowly with headroom', () => {
    const dr = new DynamicResolution();
    run(dr, 30, 30);
    expect(dr.scale).toBeCloseTo(0.6, 5);
    run(dr, 8, 4);
    expect(dr.scale).toBeCloseTo(0.6, 5); // not yet (needs ~5 s)
    run(dr, 8, 30);
    expect(dr.scale).toBeGreaterThanOrEqual(0.7);
    run(dr, 8, 200);
    expect(dr.scale).toBe(1);
  });

  it('does not lower the resolution for CPU-bound frames or hitches', () => {
    const dr = new DynamicResolution();
    run(dr, 30, 10, 28); // the frame code itself takes the time
    expect(dr.scale).toBe(1);
    run(dr, 400, 10); // tab switches / hitches are ignored
    expect(dr.scale).toBe(1);
  });

  it('holds a 60 Hz vsync-locked frame rate at full scale', () => {
    const dr = new DynamicResolution();
    run(dr, 16.7, 60);
    expect(dr.scale).toBe(1);
  });
});

describe('frame pacing', () => {
  const simulate = (hz: number, cap: number, seconds: number, jitter = 0): number => {
    const p = new FramePacer();
    let frames = 0;
    const step = 1000 / hz;
    for (let i = 0; i < hz * seconds; i++) {
      const now = 1000 + i * step + (jitter ? Math.sin(i * 12.9898) * jitter : 0);
      if (p.shouldRender(now, cap)) frames++;
    }
    return frames / seconds;
  };

  it('caps high-refresh displays and keeps every refresh at matching rates', () => {
    expect(simulate(144, 60, 10)).toBeGreaterThan(58.5);
    expect(simulate(144, 60, 10)).toBeLessThan(61.5);
    expect(simulate(120, 30, 10)).toBeCloseTo(30, 0);
    expect(simulate(60, 60, 10, 0.6)).toBeGreaterThan(59.5);
    expect(simulate(60, 30, 10, 0.6)).toBeCloseTo(30, 0);
    expect(simulate(144, 0, 5)).toBeCloseTo(144, 0);
  });

  it('idle caps to 30 fps and wake() renders immediately', () => {
    expect(effectiveFpsCap(60, true)).toBe(30);
    expect(effectiveFpsCap(0, true)).toBe(30);
    expect(effectiveFpsCap(30, true)).toBe(30);
    expect(effectiveFpsCap(0, false)).toBe(0);
    expect(effectiveFpsCap(60, false)).toBe(60);
    const p = new FramePacer();
    expect(p.shouldRender(1000, 30)).toBe(true);
    expect(p.shouldRender(1007, 30)).toBe(false);
    p.wake();
    expect(p.shouldRender(1014, 30)).toBe(true);
  });
});

describe('settings', () => {
  it('defaults to auto quality and a 60 fps cap', () => {
    expect(DEFAULT_SETTINGS.quality).toBe('auto');
    expect(DEFAULT_SETTINGS.fpsCap).toBe(60);
  });

  it('moves pre-existing default "high" settings onto auto, keeps explicit choices', () => {
    expect(migrateSettings({ quality: 'high' }).quality).toBe('auto');
    expect(migrateSettings({ quality: 'medium' }).quality).toBe('medium');
    expect(migrateSettings({ quality: 'high', fpsCap: 60 }).quality).toBe('high');
    expect(migrateSettings({ fpsCap: 45 as never }).fpsCap).toBe(60);
    expect(migrateSettings({ quality: 'ultra' as never }).quality).toBe('auto');
  });
});

describe('culling helpers', () => {
  it('flat-plane sphere/box tests agree with THREE.Frustum', () => {
    const cam = new THREE.PerspectiveCamera(45, 1.4, 0.5, 400);
    cam.position.set(30, 40, 60);
    cam.lookAt(10, 0, 5);
    cam.updateMatrixWorld();
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const pl = planesFromFrustum(f, createPlanes());
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const x = rnd() * 300 - 150;
      const y = rnd() * 60 - 20;
      const z = rnd() * 300 - 150;
      const r = rnd() * 5;
      expect(sphereInPlanes(pl, x, y, z, r)).toBe(f.intersectsSphere(new THREE.Sphere(new THREE.Vector3(x, y, z), r)));
      const box = new THREE.Box3(new THREE.Vector3(x, y, z), new THREE.Vector3(x + r * 3, y + r, z + r * 2));
      expect(boxInPlanes(pl, box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z)).toBe(f.intersectsBox(box));
    }
  });

  it('LOD thresholds are ordered and low never uses the full model', () => {
    for (const q of ['low', 'medium', 'high'] as const) {
      const l = natureLodFor(q);
      expect(l.lod0).toBeLessThanOrEqual(l.lod1);
      expect(l.shadowLod0).toBeLessThanOrEqual(l.shadowLod1);
      expect(l.shadowLod1).toBeLessThanOrEqual(l.lod1);
    }
    expect(treeLodAt(10, natureLodFor('low'))).toBe(1);
    expect(treeLodAt(10, natureLodFor('high'))).toBe(0);
    expect(treeLodAt(100, natureLodFor('high'))).toBe(1);
    expect(treeLodAt(400, natureLodFor('high'))).toBe(2);
  });

  it('small props cast shadows only when zoomed in (with hysteresis)', () => {
    expect(smallPropShadows(20, 'high', false)).toBe(true);
    expect(smallPropShadows(42, 'high', true)).toBe(false);
    expect(smallPropShadows(34.5, 'high', true)).toBe(true);
    expect(smallPropShadows(34.5, 'high', false)).toBe(false);
    expect(smallPropShadows(10, 'low', true)).toBe(false);
  });
});

describe('shadow box fitting', () => {
  it('contains the light-space footprint of every receiver and shrinks for a low sun', () => {
    const R = shadowRadiusFor(42);
    expect(R).toBe(44);
    const box: ShadowBox = { left: 0, right: 0, bottom: 0, top: 0 };
    for (const sinE of [0.3, 0.5, 0.8, 1]) {
      const yLo = -3;
      const yHi = 9;
      fitShadowBox(R, sinE, yLo, yHi, box);
      const cosE = Math.sqrt(1 - sinE * sinE);
      // receivers p = u·a + y·Y + v·right (a = horizontal towards the light): light-space y = -u·sinE + y·cosE
      for (let u = -R; u <= R; u += 4) {
        for (let y = yLo; y <= yHi; y += 1) {
          const ly = -u * sinE + y * cosE;
          expect(ly).toBeGreaterThanOrEqual(box.bottom - 1e-9);
          expect(ly).toBeLessThanOrEqual(box.top + 1e-9);
        }
      }
      expect(box.left).toBe(-R);
      expect(box.right).toBe(R);
    }
    fitShadowBox(R, 0.3, -2, 6, box);
    // the old symmetric box was 2R along the light's up axis
    expect(box.top - box.bottom).toBeLessThan(0.6 * 2 * R);
  });
});

describe('far tree LOD', () => {
  it('is a handful of triangles with the detailed model height', () => {
    for (let sp = 0; sp < 3; sp++) {
      const g = buildFarTree(sp);
      const tris = g.getAttribute('position').count / 3;
      expect(tris).toBeLessThanOrEqual(26);
      expect(tris).toBeLessThan(buildTree(sp, 1).getAttribute('position').count / 3);
      g.computeBoundingBox();
      expect(Math.abs(g.boundingBox!.max.y - SPECIES_TOP[sp])).toBeLessThan(0.45);
      for (const name of ['position', 'normal', 'color', 'aPart', 'aCenter']) expect(g.getAttribute(name)).toBeTruthy();
      expect(buildTree(sp, 2).getAttribute('position').count).toBe(g.getAttribute('position').count);
    }
  });
});

function borderSource(W: number, H: number, seed = 5) {
  const heights = new Float32Array((W + 1) * (H + 1));
  for (let z = 0; z <= H; z++) {
    for (let x = 0; x <= W; x++) heights[z * (W + 1) + x] = 1 + Math.sin(x * 0.3) * 0.8 + Math.cos(z * 0.21) * 0.6 - (x === 7 ? 1.6 : 0);
  }
  const n = (W + 1) * (H + 1) * 4;
  return { W, H, heights, cornerRgb: new Uint8Array(n).fill(120), cornerMat: new Uint8Array(n).fill(200), seed, mountainLevel: 12 };
}

describe('terrain border ring', () => {
  it('is watertight: no T-junctions, joins every map-edge segment, faces up', () => {
    const W = 40;
    const H = 32;
    const b = new TerrainBorder(new THREE.MeshBasicMaterial());
    b.build(borderSource(W, H));
    const g = b.mesh.geometry;
    const pos = g.getAttribute('position').array as Float32Array;
    const idx = g.index!.array;
    const edges = new Map<string, number>();
    const key = (a: number, c: number) => (a < c ? `${a}_${c}` : `${c}_${a}`);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t];
      const c = idx[t + 1];
      const d = idx[t + 2];
      for (const [p, q] of [[a, c], [c, d], [d, a]]) edges.set(key(p, q), (edges.get(key(p, q)) ?? 0) + 1);
      // counter-clockwise seen from above (heightfield triangles face up)
      const ux = pos[c * 3] - pos[a * 3];
      const uz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[d * 3] - pos[a * 3];
      const vz = pos[d * 3 + 2] - pos[a * 3 + 2];
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
    const outer = borderBandRects(W, H).at(-1)!.outer;
    const onMapEdge = (x: number, z: number) => ((x === 0 || x === W) && z >= 0 && z <= H) || ((z === 0 || z === H) && x >= 0 && x <= W);
    const onOuter = (x: number, z: number) => x === outer.x0 || x === outer.x1 || z === outer.z0 || z === outer.z1;
    const mapEdges = new Set<string>();
    for (const [k, count] of edges) {
      expect(count).toBeLessThanOrEqual(2);
      if (count === 2) continue;
      const [a, c] = k.split('_').map(Number);
      const ax = pos[a * 3];
      const az = pos[a * 3 + 2];
      const cx = pos[c * 3];
      const cz = pos[c * 3 + 2];
      const inner = onMapEdge(ax, az) && onMapEdge(cx, cz);
      expect(inner || (onOuter(ax, az) && onOuter(cx, cz))).toBe(true);
      if (inner) {
        expect(Math.hypot(ax - cx, az - cz)).toBe(1);
        mapEdges.add(k);
      }
    }
    expect(mapEdges.size).toBe(2 * (W + H)); // every unit segment of the map edge meets the terrain surface
    // exact corner heights along the seam
    const src = borderSource(W, H);
    for (let v = 0; v < pos.length / 3; v++) {
      const x = pos[v * 3];
      const z = pos[v * 3 + 2];
      if (onMapEdge(x, z)) expect(pos[v * 3 + 1]).toBeCloseTo(src.heights[z * (W + 1) + x], 5);
    }
    b.dispose();
  });

  it('uses far fewer triangles than the old 1-unit band + 8-unit ring, and heights stay continuous', () => {
    const W = 160;
    const H = 160;
    const b = new TerrainBorder(new THREE.MeshBasicMaterial());
    b.build(borderSource(W, H, 9));
    // old ring: (W+88)² − W² one-unit cells + ~21.6k 8-unit cells, 2 triangles each ≈ 115k
    expect(b.triangleCount).toBeLessThan(40000);
    expect(b.group.children.length).toBe(8);
    // camera clamp sampler: defined out to the far ring, continuous across band boundaries
    for (const m of [8, 24, 56, 112]) {
      const inside = b.heightAt(-m + 0.01, 70)!;
      const outside = b.heightAt(-m - 0.01, 70)!;
      expect(Math.abs(inside - outside)).toBeLessThan(0.5);
    }
    expect(b.heightAt(80, 80)).toBeNull();
    expect(b.heightAt(-400, 80)).not.toBeNull();
    b.dispose();
  });
});

describe('chunked terrain geometry', () => {
  it('chunk draw ranges partition the index buffer and stay inside their chunk', () => {
    const W = 40;
    const H = 24;
    const heights = new Float32Array((W + 1) * (H + 1)).map((_, i) => Math.sin(i * 0.37));
    const tg = new TerrainGeometry(W, H, heights);
    expect(terrainChunkSize(W, H)).toBe(16);
    expect(tg.chunks.length).toBe(6);
    const idx = tg.geometry.index!.array;
    const seen = new Uint8Array(W * H);
    let total = 0;
    for (const c of tg.chunks) {
      const g = c.geometry;
      expect(g.index).toBe(tg.geometry.index);
      expect(g.getAttribute('position')).toBe(tg.geometry.getAttribute('position'));
      total += g.drawRange.count;
      for (let k = g.drawRange.start; k < g.drawRange.start + g.drawRange.count; k++) {
        const tile = Math.floor(idx[k] / 4);
        const x = tile % W;
        const z = Math.floor(tile / W);
        expect(x >= c.x0 && x < c.x1 && z >= c.z0 && z < c.z1).toBe(true);
        seen[tile] = 1;
      }
      const bb = g.boundingBox!;
      for (let z = c.z0; z <= c.z1; z++) {
        for (let x = c.x0; x <= c.x1; x++) expect(bb.containsPoint(new THREE.Vector3(x, heights[z * (W + 1) + x], z))).toBe(true);
      }
    }
    expect(total).toBe(W * H * 6);
    expect(seen.every((v) => v === 1)).toBe(true);
    // height edits keep chunk bounds tight
    heights[5 * (W + 1) + 5] = 9;
    tg.syncHeights(heights);
    expect(tg.chunks[0].geometry.boundingBox!.max.y).toBeGreaterThanOrEqual(9);
    tg.dispose();
  });
});

describe('scene census (renderer.info equivalent)', () => {
  it('stays within the integrated-GPU budget at the default view', () => {
    const game = Game.create(censusSettings());
    const hs = buildHeadlessScene(game);
    const lines: string[] = [];
    for (const dayTime of [0.3, 0.5, 0.7]) {
      game.state.time.dayTime = dayTime;
      for (let i = 0; i < 4; i++) hs.frame(0.25, 0);
      const c = census(hs.scene, hs.camera, hs.sky.sun);
      lines.push(formatCensus(`default view, dayTime ${dayTime}`, c));
      expect(c.total.triangles).toBeLessThan(350_000);
      expect(c.total.calls).toBeLessThan(180);
      // nature: a handful of shared instanced sets instead of ~100 chunk meshes
      expect(c.byGroup.nature.calls).toBeLessThanOrEqual(12);
      expect(c.shadowByGroup.nature?.calls ?? 0).toBeLessThanOrEqual(11);
    }
    // medium tier (Iris Xe under 'auto') is cheaper still
    hs.setQuality('medium');
    for (let i = 0; i < 4; i++) hs.frame(0.25, 0);
    const med = census(hs.scene, hs.camera, hs.sky.sun);
    lines.push(formatCensus('default view, medium', med));
    expect(med.total.triangles).toBeLessThan(260_000);
    expect(hs.sky.sun.shadow.mapSize.x).toBe(1024);
    void lines;
  });

  it('draws every tree inside the view (no culling holes) and nothing beyond the fog', () => {
    const game = Game.create(censusSettings(4242));
    const hs = buildHeadlessScene(game);
    hs.view.yaw = 0.8;
    for (let i = 0; i < 3; i++) hs.frame(0.25, 0);
    const cam = hs.camera;
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const drawn = new Set<string>();
    hs.scene.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (!m.isInstancedMesh || !m.name.startsWith('nature-main-') || !m.visible) return;
      const a = m.instanceMatrix.array as Float32Array;
      for (let i = 0; i < m.count; i++) drawn.add(`${Math.floor(a[i * 16 + 12])},${Math.floor(a[i * 16 + 14])}`);
    });
    const fogFar = (hs.scene.fog as THREE.Fog).far;
    const s = game.state;
    let visible = 0;
    const v = new THREE.Vector3();
    for (let z = 0; z < s.H; z++) {
      for (let x = 0; x < s.W; x++) {
        if (s.tiles.feature[z * s.W + x] !== 1 || s.tiles.featureAmount[z * s.W + x] < 0.3) continue;
        v.set(x + 0.5, s.tiles.height[z * (s.W + 1) + x] + 1, z + 0.5);
        if (!f.containsPoint(v) || v.distanceTo(cam.position) > fogFar - 5) continue;
        visible++;
        expect(drawn.has(`${x},${z}`)).toBe(true);
      }
    }
    expect(visible).toBeGreaterThan(20);
    expect(drawn.size).toBeLessThan(visible * 3 + 200); // culled per instance, not per 32×32 chunk
  });
});
