/**
 * Render census helpers (render/app performance): build every sub-renderer headless (no WebGL) on a real game and
 * count what three.js would submit per frame — draw calls & triangles for the main pass and the sun's shadow pass —
 * replicating WebGLRenderer.projectObject / WebGLShadowMap.renderObject culling (visible flags, layers, frustum
 * spheres, castShadow). This is the renderer.info-equivalent used to measure LOD / culling changes in node.
 * Not a test file (no `.test.ts`).
 */
import * as THREE from 'three';
import type { NewGameSettings } from '../src/core/types';
import { seasonOfMonth } from '../src/core/defs';
import { heightAt, yearProgress } from '../src/core/world';
import { AnimalRenderer } from '../src/render/animals';
import { BuildingRenderer } from '../src/render/buildings';
import { CitizenRenderer } from '../src/render/citizens';
import { CropRenderer } from '../src/render/crops';
import { EffectsRenderer } from '../src/render/effects';
import { NatureRenderer } from '../src/render/nature';
import { SkyRenderer } from '../src/render/sky';
import { TerrainRenderer } from '../src/render/terrain';
import type { FrameContext, SubRenderer } from '../src/render/types';
import { WaterRenderer } from '../src/render/water';
import { shadowCasterCull } from '../src/render/scene/shadowCasters';
import { Game } from '../src/sim/game';

export interface PassCount {
  calls: number;
  triangles: number;
}

export interface Census {
  main: PassCount;
  shadow: PassCount;
  total: PassCount;
  /** Main-pass triangles per top-level group name. */
  byGroup: Record<string, PassCount>;
  shadowByGroup: Record<string, PassCount>;
}

export function censusSettings(seed = 20240611): NewGameSettings {
  return { seed, townName: 'Census', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false };
}

export interface HeadlessScene {
  game: Game;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sky: SkyRenderer;
  terrain: TerrainRenderer;
  nature: NatureRenderer;
  layers: SubRenderer[];
  ctx: FrameContext;
  /** Orbit parameters of the camera (like CameraController). */
  view: { x: number; z: number; yaw: number; pitch: number; distance: number };
  /** Place the camera like CameraController.apply() and run one frame of every layer. */
  frame(dt?: number, gameDt?: number): void;
  /** Switch the quality tier like GameRenderer.applySettings (shadow map size, LODs). */
  setQuality(q: 'low' | 'medium' | 'high'): void;
}

export function buildHeadlessScene(game: Game, aspect = 1744 / 1274): HeadlessScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 2500);
  const sky = new SkyRenderer(scene, game);
  const terrain = new TerrainRenderer(scene, game);
  const water = new WaterRenderer(scene, game);
  const nature = new NatureRenderer(scene, game);
  const crops = new CropRenderer(scene, game);
  const buildings = new BuildingRenderer(scene, game);
  const animals = new AnimalRenderer(scene, game);
  const citizens = new CitizenRenderer(scene, game);
  const effects = new EffectsRenderer(scene, game, buildings);
  const layers: SubRenderer[] = [sky, terrain, water, nature, crops, buildings, animals, citizens, effects];
  const c = game.townCenter();
  const view = { x: c.x, z: c.z, yaw: 0, pitch: 0.9, distance: 42 };
  let realTime = 0;
  const ctx: FrameContext = {
    game, camera, realTime: 0, realDt: 0, gameDt: 0, daylight: 1, snow: 0, season: 'spring', yearProgress: 0,
    focusX: view.x, focusZ: view.z, cameraDistance: view.distance, quality: 'high',
  };
  const place = (): void => {
    const s = game.state;
    const ty = Math.max(0, heightAt(s, view.x, view.z));
    const cp = Math.cos(view.pitch);
    camera.position.set(
      view.x + Math.sin(view.yaw) * cp * view.distance,
      ty + Math.sin(view.pitch) * view.distance,
      view.z + Math.cos(view.yaw) * cp * view.distance,
    );
    camera.lookAt(view.x, ty, view.z);
    camera.near = Math.max(0.3, Math.min(3, view.distance * 0.03));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };
  const hs: HeadlessScene = {
    game, scene, camera, sky, terrain, nature, layers, ctx, view,
    setQuality(q) {
      ctx.quality = q;
      sky.setShadows(true, q);
    },
    frame(dt = 1 / 60, gameDt = 0) {
      place();
      realTime += dt;
      const s = game.state;
      ctx.realTime = realTime;
      ctx.realDt = dt;
      ctx.gameDt = gameDt;
      ctx.snow = s.weather.snow;
      ctx.season = seasonOfMonth(s.time.month);
      ctx.yearProgress = yearProgress(s);
      ctx.focusX = view.x;
      ctx.focusZ = view.z;
      ctx.cameraDistance = view.distance;
      ctx.daylight = sky.daylight;
      for (const l of layers) l.update(ctx);
      scene.updateMatrixWorld(true);
      // as GameRenderer.render does right before drawing
      shadowCasterCull(scene).update(camera, sky.state.lightDir, sky.sun.shadow.getFrustum());
    },
  };
  hs.frame();
  return hs;
}

function trianglesOf(obj: THREE.Mesh, group?: { start: number; count: number }): number {
  const g = obj.geometry;
  const index = g.index;
  const position = g.getAttribute('position');
  if (!position && !index) return 0;
  const dataCount = index ? index.count : position.count;
  let start = g.drawRange.start;
  let end = Math.min(dataCount, g.drawRange.start + g.drawRange.count);
  if (group) {
    start = Math.max(start, group.start);
    end = Math.min(end, group.start + group.count);
  }
  const count = Math.max(0, end - start);
  let instances = 1;
  if ((obj as THREE.InstancedMesh).isInstancedMesh) instances = (obj as THREE.InstancedMesh).count;
  else if ((g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry) {
    const ig = g as THREE.InstancedBufferGeometry;
    instances = Math.min(ig.instanceCount, Number.MAX_SAFE_INTEGER);
  }
  if (count === 0 || instances === 0) return 0;
  return Math.floor(count / 3) * instances;
}

function add(map: Record<string, PassCount>, key: string, calls: number, tris: number): void {
  const e = map[key] ?? (map[key] = { calls: 0, triangles: 0 });
  e.calls += calls;
  e.triangles += tris;
}

function groupKey(o: THREE.Object3D, scene: THREE.Scene): string {
  let top: THREE.Object3D = o;
  while (top.parent && top.parent !== scene) top = top.parent;
  return top.name || top.type;
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();

function drawsFor(o: THREE.Mesh, depth: boolean): { calls: number; tris: number } {
  const mat = o.material as THREE.Material | THREE.Material[];
  let calls = 0;
  let tris = 0;
  if (Array.isArray(mat)) {
    for (const gr of o.geometry.groups) {
      const m = mat[gr.materialIndex ?? 0];
      if (m && m.visible) {
        calls++;
        tris += trianglesOf(o, gr);
      }
    }
  } else if (mat && (mat.visible || depth)) {
    calls++;
    tris += trianglesOf(o);
  }
  return { calls, tris };
}

/** renderer.info-equivalent census of one frame (main pass + directional shadow pass). */
export function census(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sun?: THREE.DirectionalLight, shadowPass = true): Census {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const byGroup: Record<string, PassCount> = {};
  const shadowByGroup: Record<string, PassCount> = {};
  const main: PassCount = { calls: 0, triangles: 0 };
  const shadow: PassCount = { calls: 0, triangles: 0 };

  // ---- main pass ----
  _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pv);
  const visitMain = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    if (o.layers.test(camera.layers) && ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) {
      const m = o as THREE.Mesh;
      if (!m.frustumCulled || m.intersectsFrustum(_frustum)) {
        const d = drawsFor(m, false);
        main.calls += d.calls;
        main.triangles += (m as THREE.Mesh).isMesh ? d.tris : 0;
        add(byGroup, groupKey(o, scene), d.calls, (m as THREE.Mesh).isMesh ? d.tris : 0);
      }
    }
    for (const c of o.children) visitMain(c);
  };
  visitMain(scene);

  // ---- shadow pass ----
  if (shadowPass && sun && sun.castShadow) {
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const fr = sun.shadow.getFrustum();
    const visitShadow = (o: THREE.Object3D): void => {
      if (!o.visible) return;
      if (o.layers.test(camera.layers) && ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) {
        const m = o as THREE.Mesh;
        if (m.castShadow && (!m.frustumCulled || m.intersectsFrustum(fr))) {
          const d = drawsFor(m, true);
          shadow.calls += d.calls;
          shadow.triangles += d.tris;
          add(shadowByGroup, groupKey(o, scene), d.calls, d.tris);
        }
      }
      for (const c of o.children) visitShadow(c);
    };
    visitShadow(scene);
  }
  return {
    main, shadow, byGroup, shadowByGroup,
    total: { calls: main.calls + shadow.calls, triangles: main.triangles + shadow.triangles },
  };
}

export function formatCensus(label: string, c: Census): string {
  const rows = [`${label}: total ${c.total.triangles} tris / ${c.total.calls} calls  (main ${c.main.triangles}/${c.main.calls}, shadow ${c.shadow.triangles}/${c.shadow.calls})`];
  const keys = new Set([...Object.keys(c.byGroup), ...Object.keys(c.shadowByGroup)]);
  for (const k of keys) {
    const m = c.byGroup[k] ?? { calls: 0, triangles: 0 };
    const s = c.shadowByGroup[k] ?? { calls: 0, triangles: 0 };
    rows.push(`   ${k.padEnd(16)} main ${String(m.triangles).padStart(7)} / ${String(m.calls).padStart(3)}   shadow ${String(s.triangles).padStart(7)} / ${String(s.calls).padStart(3)}`);
  }
  return rows.join('\n');
}
