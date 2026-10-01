/**
 * render-scene sandbox: renders ONLY the scene layers (sky, terrain, water, camera) on a synthetic or generated
 * world with a fake Game object. URL params:
 *   t=dayTime  m=month(float, e.g. 4.5)  snow=0..1  temp=°C  precip=rain|snow  pi=intensity  wind=0..1
 *   dist, pitch, yaw, fx, fz (camera)   grid=1   speed=0|1|2|5|10   gen=real   frames=N   q=low|medium|high
 *   shadows=0   anim=1 (advance dayTime live)
 */
import * as THREE from 'three';
import { EventBus } from '../../src/core/events';
import { Rng } from '../../src/core/rng';
import type { Building, GameEvents, GameState } from '../../src/core/types';
import { CameraController } from '../../src/render/camera';
import { createWebGLRenderer, pixelRatioFor } from '../../src/render/scene/rendererSetup';
import { SkyRenderer } from '../../src/render/sky';
import { TerrainRenderer } from '../../src/render/terrain';
import type { FrameContext } from '../../src/render/types';
import { WaterRenderer } from '../../src/render/water';
import type { Game } from '../../src/sim/game';
import { seasonOfMonth } from '../../src/core/defs';
import { yearProgress } from '../../src/core/world';
import { raymarchHeightfield } from '../../src/render/scene/heightfield';
import { heightAt } from '../../src/core/world';
import { synthState } from './synthWorld';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);

async function makeState(): Promise<GameState> {
  const base = synthState({ W: num('W', 160), seed: num('seed', 1234) });
  if (P.get('gen') === 'real') {
    try {
      const mod = await import('../../src/sim/worldgen');
      let id = 1000;
      const settings = { ...base.settings, seed: num('seed', 1234), mapSize: (P.get('size') ?? 'medium') as 'medium' };
      const res = mod.generateWorld(settings, new Rng(settings.seed), () => id++);
      const s: GameState = { ...base, W: res.W, H: res.H, tiles: res.tiles, buildings: [], animals: res.animals, settings };
      (window as unknown as { __start: unknown }).__start = [res.startX, res.startZ];
      return s;
    } catch (err) {
      console.warn('[sandbox] real generateWorld unavailable, using synthetic world', err);
    }
  }
  return base;
}

function fakeGame(state: GameState): Game {
  const buildingById = new Map<number, Building>(state.buildings.map((b) => [b.id, b]));
  const g = {
    state,
    speed: num('speed', 1),
    events: new EventBus<GameEvents>(),
    citizenById: new Map(),
    buildingById,
    animalById: new Map(),
    buildingAtTile(x: number, z: number) {
      const id = state.tiles.building[z * state.W + x];
      return id >= 0 ? buildingById.get(id) : undefined;
    },
    season() {
      return seasonOfMonth(state.time.month);
    },
  };
  return g as unknown as Game;
}

async function main(): Promise<void> {
  const state = await makeState();
  const month = num('m', 4.5);
  state.time.month = Math.floor(month) % 12;
  state.time.monthProgress = month - Math.floor(month);
  state.time.dayTime = num('t', 0.42);
  state.weather.snow = num('snow', 0);
  state.weather.temperature = num('temp', 18);
  state.weather.precipitation = (P.get('precip') as 'rain' | 'snow' | null) ?? 'none';
  state.weather.precipIntensity = num('pi', state.weather.precipitation === 'none' ? 0 : 0.7);
  state.weather.windStrength = num('wind', 0.3);
  const game = fakeGame(state);

  const container = document.getElementById('app')!;
  const renderer = createWebGLRenderer();
  const quality = (P.get('q') ?? 'high') as 'low' | 'medium' | 'high';
  renderer.setPixelRatio(pixelRatioFor(quality));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2500);

  const sky = new SkyRenderer(scene, game);
  const terrain = new TerrainRenderer(scene, game);
  const water = new WaterRenderer(scene, game);
  const shadows = P.get('shadows') !== '0';
  sky.setShadows(shadows, quality);
  renderer.shadowMap.enabled = shadows && quality !== 'low';
  terrain.setGridVisible(P.get('grid') === '1');
  if (P.has('debug')) {
    (terrain as unknown as { uniforms: { uDebug: { value: number } } }).uniforms.uDebug.value = num('debug', 0);
    if (num('debug', 0) > 0) { scene.remove(sky.hemi); sky.sun.intensity = 0; }
  }

  if (P.get('box') === '1') {
    // debug caster: a few boxes to check shadows & scale
    const m = new THREE.MeshLambertMaterial({ color: 0xb09070, flatShading: true });
    for (let k = 0; k < 4; k++) {
      const hgt = 1 + k * 1.2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(2, hgt, 2), m);
      const bx = num('fx', state.W * 0.42) - 6 + k * 4;
      const bz = num('fz', state.H * 0.5) - 8;
      b.position.set(bx, 0.9 + hgt / 2, bz);
      b.castShadow = true;
      b.receiveShadow = true;
      scene.add(b);
    }
  }
  const cam = new CameraController(camera, renderer.domElement, game);
  const start = (window as unknown as { __start?: [number, number] }).__start;
  const fx = num('fx', start ? start[0] : state.W * 0.42);
  const fz = num('fz', start ? start[1] : state.H * 0.5);
  cam.jumpTo(fx, fz, num('dist', 42));
  cam.yaw = num('yaw', 0.35);
  cam.pitch = num('pitch', 0.85);
  (cam as unknown as { goal: { yaw: number; pitch: number } }).goal.yaw = cam.yaw;
  (cam as unknown as { goal: { yaw: number; pitch: number } }).goal.pitch = cam.pitch;
  cam.pickGround = (x, y) => {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, camera);
    const o = rc.ray.origin;
    const d = rc.ray.direction;
    const hit = raymarchHeightfield((a, b) => Math.max(0, heightAt(state, a, b)), state.W, state.H, -5, 40, o.x, o.y, o.z, d.x, d.y, d.z);
    return hit ? { wx: hit.x, wz: hit.z } : null;
  };

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const ctx: FrameContext = {
    game, camera, realTime: 0, realDt: 0, gameDt: 0, daylight: 1, snow: 0, season: 'summer', yearProgress: 0,
    focusX: 0, focusZ: 0, cameraDistance: 40, quality,
  };
  const frames = num('frames', 3);
  const anim = P.get('anim') === '1';
  let count = 0;
  let last = performance.now();
  const hud = document.getElementById('hud')!;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (anim) state.time.dayTime = (state.time.dayTime + dt / 24) % 1;
    cam.update(count === 0 ? 1 : dt);
    ctx.realTime += count === 0 ? 0 : dt;
    ctx.realDt = count < frames ? 1 : dt; // settle smoothing quickly for screenshots
    ctx.snow = state.weather.snow;
    ctx.season = seasonOfMonth(state.time.month);
    ctx.yearProgress = yearProgress(state);
    ctx.focusX = cam.target.x;
    ctx.focusZ = cam.target.z;
    ctx.cameraDistance = cam.distance;
    ctx.daylight = sky.daylight;
    for (let k = 0; k < (count < frames ? 6 : 1); k++) {
      sky.update(ctx);
      terrain.update(ctx);
      water.update(ctx);
    }
    renderer.render(scene, camera);
    count++;
    if (count === frames) (window as unknown as { __ready: boolean }).__ready = true;
    if (count % 15 === 0 || count === frames) {
      const i = renderer.info.render;
      hud.textContent = `calls ${i.calls} tris ${i.triangles} | day ${state.time.dayTime.toFixed(2)} month ${month} snow ${state.weather.snow}`;
    }
    // software GL is slow: stop after the requested frames unless animating (screenshots stay fast)
    if (count < frames || anim) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as unknown as Record<string, unknown>).__sandbox = { state, game, sky, terrain, water, cam, renderer, scene };
}

main().catch((err) => {
  console.error(err);
  document.body.textContent = String(err);
});
