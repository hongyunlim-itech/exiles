/**
 * render-entities visual sandbox. Serve with `npx vite --port 5203` and open /dev/render-entities/index.html.
 * URL params: month (0..11), weather (none|rain|snow), snow (0..1), cam (preset), quality, tornado=1, day (0..1),
 * shot=1 (hide UI), stress=1 (160² map with ~10k trees), prewarm (seconds of effects pre-simulation).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MONTH_NAMES, seasonOfMonth } from '../../src/core/defs';
import { Terrain } from '../../src/core/types';
import { heightAt } from '../../src/core/world';
import { AnimalRenderer } from '../../src/render/animals';
import type { BuildingRenderer } from '../../src/render/buildings';
import { CitizenRenderer } from '../../src/render/citizens';
import { CropRenderer } from '../../src/render/crops';
import { EffectsRenderer } from '../../src/render/effects';
import { NatureRenderer } from '../../src/render/nature';
import type { EmitterAnchor, FrameContext } from '../../src/render/types';
import { createFakeWorld } from './fakeState';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
if (params.get('shot') === '1') document.body.classList.add('shot');

const world = createFakeWorld({ stress: params.get('stress') === '1' });
const { game, state } = world;

// ---- renderer / scene ------------------------------------------------------------------------------
const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 600);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -45;
sun.shadow.camera.right = 45;
sun.shadow.camera.top = 45;
sun.shadow.camera.bottom = -45;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfe0f0, 0x5a4a38, 0.95);
scene.add(hemi);

// ---- ground ----------------------------------------------------------------------------------------
const W = state.W;
const H = state.H;
const groundGeo = new THREE.BufferGeometry();
{
  const pos: number[] = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const c = (cx: number, cz: number) => [cx, state.tiles.height[cz * (W + 1) + cx], cz];
      const a = c(x, z), b = c(x + 1, z), d = c(x, z + 1), e = c(x + 1, z + 1);
      pos.push(...a, ...d, ...b, ...b, ...d, ...e);
    }
  }
  groundGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
ground.receiveShadow = true;
scene.add(ground);
const water = new THREE.Mesh(new THREE.PlaneGeometry(4, H), new THREE.MeshLambertMaterial({ color: 0x4f7f86, transparent: true, opacity: 0.85 }));
water.rotation.x = -Math.PI / 2;
water.position.set(W - 6, 0.0, H / 2);
scene.add(water);
// Bridge deck.
const bridge = new THREE.Mesh(new THREE.BoxGeometry(5, 0.12, 1), new THREE.MeshLambertMaterial({ color: 0x7a5534 }));
bridge.position.set(W - 6, 0.19, 50.5);
bridge.castShadow = bridge.receiveShadow = true;
scene.add(bridge);

function colorGround(month: number, snow: number): void {
  const col = groundGeo.getAttribute('color') as THREE.BufferAttribute;
  const season = seasonOfMonth(month);
  const grass = new THREE.Color(season === 'spring' ? 0x7a9a48 : season === 'summer' ? 0x6f8f45 : season === 'autumn' ? 0x9a8a45 : 0x7d8a58);
  const soil = new THREE.Color(0x6b5236);
  const sand = new THREE.Color(0xc9b98a);
  const dirt = new THREE.Color(0x8a7050);
  const snowC = new THREE.Color(0xe8eef2);
  const packed = new THREE.Color(0x8d7a5c);
  const tmp = new THREE.Color();
  let k = 0;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const b = state.tiles.building[i];
      const bt = b >= 0 ? game.buildingById.get(b)?.type : undefined;
      if (state.tiles.terrain[i] === Terrain.Water) tmp.set(0x2d5566);
      else if (state.tiles.terrain[i] === Terrain.Sand) tmp.copy(sand);
      else if (state.tiles.road[i]) tmp.copy(dirt);
      else if (bt === 'cropField' || bt === 'orchard') tmp.copy(soil).lerp(grass, bt === 'orchard' ? 0.5 : 0);
      else if (bt === 'woodenHouse') tmp.copy(packed);
      else tmp.copy(grass).multiplyScalar(0.94 + ((x * 13 + z * 7) % 5) * 0.03);
      if (state.tiles.terrain[i] !== Terrain.Water) tmp.lerp(snowC, snow * 0.92);
      for (let v = 0; v < 6; v++) col.setXYZ(k++, tmp.r, tmp.g, tmp.b);
    }
  }
  col.needsUpdate = true;
}

// ---- simple houses (stand-ins for BuildingRenderer) ----------------------------------------------------
const houseMat = new THREE.MeshLambertMaterial({ color: 0xd8cfb8, flatShading: true });
const roofMat = new THREE.MeshLambertMaterial({ color: 0x9c7d45, flatShading: true });
const charMat = new THREE.MeshLambertMaterial({ color: 0x3a302a, flatShading: true });
const chimneyAnchors: EmitterAnchor[] = [];
const fireAnchors: EmitterAnchor[] = [];
for (const h of world.houses) {
  const gx = h.x + h.w / 2;
  const gz = h.z + h.h / 2;
  const gy = heightAt(state, gx, gz);
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 2.4), h.burning ? charMat : houseMat);
  body.position.set(gx, gy + 0.55, gz);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 1.0, 4), h.burning ? charMat : roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.set(gx, gy + 1.6, gz);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.3), houseMat);
  chimney.position.set(gx + 0.6, gy + 1.8, gz - 0.4);
  for (const m of [body, roof, chimney]) {
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  if (h.burning) fireAnchors.push({ x: gx, y: gy + 2.1, z: gz, strength: h.burning, buildingId: h.id });
  else chimneyAnchors.push({ x: gx + 0.6, y: gy + 2.25, z: gz - 0.4, strength: 1, buildingId: h.id });
}
const fakeBuildings = {
  getChimneys: () => chimneyAnchors,
  getFires: () => fireAnchors,
} as unknown as BuildingRenderer;

// ---- entity renderers -------------------------------------------------------------------------------
const t0 = performance.now();
const nature = new NatureRenderer(scene, game);
const crops = new CropRenderer(scene, game);
const animals = new AnimalRenderer(scene, game);
const citizens = new CitizenRenderer(scene, game);
const effects = new EffectsRenderer(scene, game, fakeBuildings);
const buildMs = performance.now() - t0;

// ---- controls ---------------------------------------------------------------------------------------
const monthSel = document.getElementById('month') as HTMLSelectElement;
MONTH_NAMES.forEach((n, i) => monthSel.add(new Option(`${i}: ${n}`, String(i))));
const weatherSel = document.getElementById('weather') as HTMLSelectElement;
const snowIn = document.getElementById('snow') as HTMLInputElement;
const camSel = document.getElementById('cam') as HTMLSelectElement;
const qualitySel = document.getElementById('quality') as HTMLSelectElement;
const tornadoIn = document.getElementById('tornado') as HTMLInputElement;

const CAMS: Record<string, { t: [number, number, number]; d: number; pitch: number; yaw: number }> = {
  overview: { t: [44, 0, 40], d: 78, pitch: 0.95, yaw: 0.4 },
  forest: { t: [22, 0, 13], d: 26, pitch: 0.75, yaw: 0.3 },
  forestFar: { t: [22, 0, 20], d: 60, pitch: 0.9, yaw: 0.2 },
  rocks: { t: [51, 0, 9], d: 16, pitch: 0.8, yaw: 0.2 },
  citizens: { t: [49.5, 0, 38], d: 8.5, pitch: 0.55, yaw: 0.5 },
  walkers: { t: [56, 0, 30], d: 14, pitch: 0.8, yaw: 0.0 },
  closeup: { t: [46, 0.3, 37], d: 4.2, pitch: 0.35, yaw: 0.7 },
  closeup2: { t: [50, 0.3, 39], d: 4.2, pitch: 0.35, yaw: 2.2 },
  walkclose: { t: [56, 0.3, 26.5], d: 4.5, pitch: 0.4, yaw: 0.3 },
  hidden: { t: [67.5, 0, 19], d: 6, pitch: 0.6, yaw: 0.6 },
  fields: { t: [22, 0, 45], d: 22, pitch: 0.7, yaw: 0.25 },
  orchards: { t: [16, 0, 53], d: 16, pitch: 0.6, yaw: 0.3 },
  pasture: { t: [20, 0, 65], d: 20, pitch: 0.75, yaw: 0.3 },
  livestock: { t: [9, 0, 64], d: 7, pitch: 0.5, yaw: 0.5 },
  deer: { t: [52, 0, 69], d: 6, pitch: 0.45, yaw: 0.4 },
  cattle: { t: [23, 0, 65], d: 7, pitch: 0.5, yaw: 0.3 },
  chickens: { t: [34.5, 0, 63.5], d: 4, pitch: 0.55, yaw: 0.3 },
  fire: { t: [72, 0, 21], d: 18, pitch: 0.6, yaw: 0.3 },
  tornado: { t: [58, 0, 50], d: 34, pitch: 0.45, yaw: 0.2 },
  fell: { t: [20, 0, 25], d: 14, pitch: 0.55, yaw: 0.2 },
  fellclose: { t: [20, 0, 33], d: 9, pitch: 0.35, yaw: 0.0 },
  bridge: { t: [W - 6, 0, 50], d: 10, pitch: 0.6, yaw: 0.9 },
  stress: { t: [80, 0, 100], d: 60, pitch: 0.85, yaw: 0.3 },
};
Object.keys(CAMS).forEach((k) => camSel.add(new Option(k, k)));

function applyCam(name: string): void {
  const c = CAMS[name] ?? CAMS.overview;
  const [tx, , tz] = c.t;
  const ty = heightAt(state, tx, tz) + c.t[1];
  controls.target.set(tx, ty, tz);
  camera.position.set(
    tx + Math.cos(c.pitch) * Math.sin(c.yaw) * c.d,
    ty + Math.sin(c.pitch) * c.d,
    tz + Math.cos(c.pitch) * Math.cos(c.yaw) * c.d,
  );
  camera.lookAt(controls.target);
  controls.update();
}

function setMonth(m: number): void {
  state.time.month = m;
  monthSel.value = String(m);
  const winter = m >= 9;
  if (!params.has('snow')) snowIn.value = String(winter ? (m === 9 ? 0.55 : 0.85) : 0);
  applyEnv();
}
function applyEnv(): void {
  const m = Number(monthSel.value);
  state.weather.snow = Number(snowIn.value);
  const wsel = weatherSel.value as 'none' | 'rain' | 'snow';
  state.weather.precipitation = wsel;
  state.weather.precipIntensity = wsel === 'none' ? 0 : 0.85;
  colorGround(m, state.weather.snow);
  const season = seasonOfMonth(m);
  const sky = new THREE.Color(season === 'winter' ? 0xb8c4cc : 0xa9c3d6);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 60, 230);
}

monthSel.onchange = () => setMonth(Number(monthSel.value));
weatherSel.onchange = snowIn.oninput = applyEnv;
camSel.onchange = () => applyCam(camSel.value);

monthSel.value = String(num('month', 4));
weatherSel.value = params.get('weather') ?? 'none';
snowIn.value = String(num('snow', 0));
camSel.value = params.get('cam') ?? 'overview';
qualitySel.value = params.get('quality') ?? 'high';
tornadoIn.checked = params.get('tornado') === '1';
setMonth(Number(monthSel.value));
applyCam(camSel.value);

const highlightId = state.citizens[3]?.id ?? null;
citizens.setHighlight(highlightId);

// ---- frame loop -------------------------------------------------------------------------------------
const stats = document.getElementById('stats')!;
const ctx: FrameContext = {
  game, camera, realTime: 0, realDt: 0, gameDt: 0, daylight: 1, snow: 0, season: 'spring', yearProgress: 0,
  focusX: 0, focusZ: 0, cameraDistance: 40, quality: 'high',
};
const timings = { nature: 0, crops: 0, animals: 0, citizens: 0, effects: 0 };
const avg = { nature: 0, crops: 0, animals: 0, citizens: 0, effects: 0, n: 0 };
let last = performance.now();
let realTime = 10;
let frames = 0;
let fpsAcc = 0;
let fps = 0;

let fellTimer = 0;
let eventTimer = 0;
const fellOrder: number[] = [];
for (let z = params.get('fellfront') === '1' ? 30 : 18; z < 32; z++) for (let x = params.get('fellfront') === '1' ? 14 : 3; x < (params.get('fellfront') === '1' ? 26 : 38); x++) fellOrder.push(z * W + x);
function frame(dtReal: number, render: boolean): void {
  realTime += dtReal;
  world.step(dtReal);
  // Optional scripted changes: fell trees / emit sim events.
  if (params.get('fell') === '1' && render) {
    fellTimer += dtReal;
    if (fellTimer > 0.4 && fellOrder.length) {
      fellTimer = 0;
      const i = fellOrder.splice(Math.floor(Math.random() * fellOrder.length), 1)[0];
      if (state.tiles.feature[i] === 1 && state.tiles.featureAmount[i] > 0.5) {
        state.tiles.feature[i] = 0;
        state.rev.features++;
      }
    }
  }
  if (params.get('events') === '1') {
    eventTimer += dtReal;
    if (eventTimer > 0.5) {
      eventTimer = 0;
      game.events.emit('sound', { cue: 'chop', x: 45.5, z: 36.5 });
      game.events.emit('sound', { cue: 'dig', x: 47, z: 36.5 });
      game.events.emit('sound', { cue: 'splash', x: W - 6.5, z: 30 });
      if (Math.random() < 0.3) game.events.emit('buildingCompleted', { id: world.houses[1].id });
    }
  }
  const m = Number(monthSel.value);
  state.time.dayTime = num('day', 0.42);
  state.tornado = tornadoIn.checked ? { x: 60 + Math.sin(realTime * 0.1) * 6, z: 52, dirX: 1, dirZ: 0, life: 20 } : null;
  ctx.realTime = realTime;
  ctx.realDt = dtReal;
  ctx.gameDt = dtReal;
  const day = state.time.dayTime;
  ctx.daylight = Math.max(0, Math.min(1, 0.5 + 1.4 * Math.sin((day - 0.25) * Math.PI * 2)));
  ctx.snow = state.weather.snow;
  ctx.season = seasonOfMonth(m);
  ctx.yearProgress = (m + 0.5) / 12;
  ctx.focusX = controls.target.x;
  ctx.focusZ = controls.target.z;
  ctx.cameraDistance = camera.position.distanceTo(controls.target);
  ctx.quality = qualitySel.value as FrameContext['quality'];

  const sunAng = (day - 0.25) * Math.PI * 2;
  sun.position.set(controls.target.x - 30, Math.max(8, Math.sin(sunAng) * 60), controls.target.z + 25);
  sun.target.position.copy(controls.target);
  sun.intensity = 0.3 + 1.7 * ctx.daylight;
  hemi.intensity = 0.35 + 0.6 * ctx.daylight;

  let t = performance.now();
  nature.update(ctx);
  timings.nature = performance.now() - t;
  t = performance.now();
  crops.update(ctx);
  timings.crops = performance.now() - t;
  t = performance.now();
  animals.update(ctx);
  timings.animals = performance.now() - t;
  t = performance.now();
  citizens.update(ctx);
  timings.citizens = performance.now() - t;
  t = performance.now();
  effects.update(ctx);
  timings.effects = performance.now() - t;
  if (!render) return finishFrame(render);
  avg.nature += timings.nature;
  avg.crops += timings.crops;
  avg.animals += timings.animals;
  avg.citizens += timings.citizens;
  avg.effects += timings.effects;
  avg.n++;
  finishFrame(render);
}

function finishFrame(render: boolean): void {
  if (render && params.get('norender') !== '1') {
    controls.update();
    renderer.render(scene, camera);
  }
}

// Pre-warm (smoke plumes etc.).
const prewarm = num('prewarm', 6);
for (let i = 0; i < prewarm * 20; i++) frame(0.05, false);

function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame(params.get('freeze') === '1' ? 0 : dt, true);
  frames++;
  fpsAcc += dt;
  if (fpsAcc > 0.5) {
    fps = frames / fpsAcc;
    frames = 0;
    fpsAcc = 0;
  }
  const info = renderer.info;
  stats.textContent =
    `fps ${fps.toFixed(0)}  draws ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  build ${buildMs.toFixed(1)}ms\n` +
    `nature ${timings.nature.toFixed(2)}  crops ${timings.crops.toFixed(2)}  animals ${timings.animals.toFixed(2)}  ` +
    `citizens ${timings.citizens.toFixed(2)}  effects ${timings.effects.toFixed(2)} ms\n` +
    `instances ${nature.instanceCount}  particles ${effects.particleCount}  citizens ${state.citizens.length}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame((n) => {
  last = n;
  loop(n);
  (window as unknown as { __ready: boolean }).__ready = true;
  (window as unknown as { __fx: unknown }).__fx = { effects, nature, citizens, animals, crops, scene, camera, renderer, state };
  (window as unknown as { __stats: () => unknown }).__stats = () => ({
    fps, timings, draws: renderer.info.render.calls,
    avgMs: Object.fromEntries(Object.entries(avg).filter(([k]) => k !== 'n').map(([k, v]) => [k, +(v / Math.max(1, avg.n)).toFixed(3)])),
    citizens: state.citizens.length, tris: renderer.info.render.triangles, buildMs,
    instances: nature.instanceCount, particles: effects.particleCount,
  });
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
