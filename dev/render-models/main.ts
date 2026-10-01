/**
 * render-models sandbox: every building type in a labelled grid on a simple terrain with lighting & shadows,
 * construction stages, ruins, fire, ghosts, stockpile piles, market goods, trading post + merchant boat, bridges,
 * slope tests and rotation tests. Orbit camera. `window.__sandbox` exposes camera presets for screenshots.
 *
 * URL params: ?snow=0..1&day=0..1&outline=0|1&view=<preset>
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { BUILDINGS, BUILDING_TYPES } from '../../src/core/defs';
import type { Building, BuildingState, BuildingType, GameState, Rotation } from '../../src/core/types';
import { Road, Terrain } from '../../src/core/types';
import { computeDoor, footprintSize, heightAt } from '../../src/core/world';
import { BuildingRenderer } from '../../src/render/buildings';
import { createGhostModel, disposeModel, setGhostValid } from '../../src/render/models';
import type { FrameContext } from '../../src/render/types';
import type { Game } from '../../src/sim/game';

const params = new URLSearchParams(location.search);
const W = 140;
const H = 112;
const LAND = 0.3;

// ---------------------------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------------------------

function makeState(): GameState {
  const n = W * H;
  const tiles = {
    height: new Float32Array((W + 1) * (H + 1)).fill(LAND),
    terrain: new Uint8Array(n),
    feature: new Uint8Array(n),
    featureAmount: new Float32Array(n),
    variant: new Uint8Array(n),
    road: new Uint8Array(n),
    building: new Int32Array(n).fill(-1),
    marked: new Uint8Array(n),
    region: new Int32Array(n),
  };
  return {
    version: 1,
    settings: { seed: 1, townName: 'Sandbox', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: true },
    W, H, tiles,
    time: { elapsed: 0, year: 1, month: 4, monthProgress: 0.5, dayTime: 0.5 },
    weather: { temperature: 15, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0, windStrength: 0.3 },
    citizens: [], buildings: [], animals: [], nextId: 1,
    unlocked: { crops: ['wheat'], orchards: ['apple'], livestock: ['sheep'] },
    buildersDesired: 2,
    trade: { merchant: null, nextArrival: 100, requested: null },
    nomads: null, nextNomads: 100, messages: [], history: [],
    tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
    rngState: 1, rev: { terrain: 1, features: 1, roads: 1, buildings: 1, fields: 1 },
    unburied: 0, gameOver: false, tornado: null,
  };
}

const state = makeState();
const T = state.tiles;
const setCorner = (x: number, z: number, h: number) => { T.height[z * (W + 1) + x] = h; };

// water strip z ∈ [2, 8)
for (let z = 2; z < 8; z++) for (let x = 0; x < W; x++) T.terrain[z * W + x] = Terrain.Water;
for (let z = 3; z <= 7; z++) for (let x = 0; x <= W; x++) setCorner(x, z, -0.45);
// mountain block behind the mine spot
for (let z = 8; z < 11; z++) for (let x = 30; x < 50; x++) T.terrain[z * W + x] = Terrain.Mountain;
for (let z = 9; z <= 10; z++) for (let x = 31; x <= 49; x++) setCorner(x, z, 2.4 + ((x * 7 + z * 3) % 5) * 0.15);
// bridges across the strip
for (let z = 2; z < 8; z++) {
  T.road[z * W + 4] = Road.Bridge;
  T.road[z * W + 8] = Road.Bridge;
  T.road[z * W + 9] = Road.Bridge;
}
// a gentle hill for slope tests (x ∈ [60, 100], z ∈ [8, 17])
for (let z = 8; z <= 17; z++) {
  for (let x = 58; x <= 104; x++) {
    const d = Math.hypot((x - 80) / 16, (z - 12) / 6);
    setCorner(x, z, LAND + Math.max(0, 1 - d) * 1.6);
  }
}

let nextId = 1;
const labels: { b: Building; text: string }[] = [];

function mk(type: BuildingType, x: number, z: number, opts: Partial<Building> & { label?: string; rot?: Rotation; size?: [number, number] } = {}): Building {
  const def = BUILDINGS[type];
  const rot = opts.rot ?? 0;
  const [w, h] = opts.size ?? footprintSize(type, rot);
  const [dx, dz] = computeDoor(type, x, z, w, h, rot);
  const b: Building = {
    id: nextId++, type, x, z, w, h, rotation: rot, doorX: dx, doorZ: dz,
    state: 'active', progress: 1, cost: { ...def.cost }, delivered: { ...def.cost }, incoming: {}, workRemaining: 0,
    priority: false, paused: false, workersDesired: def.defaultWorkers, workerIds: def.maxWorkers ? [1] : [], residentIds: def.housing ? [1] : [],
    inventory: {}, reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0, smoking: !!def.housing, producedThisYear: {}, producedLastYear: {},
    builtAt: 0,
  };
  const { label, rot: _r, size: _s, ...rest } = opts;
  Object.assign(b, rest);
  if (type === 'cemetery' && b.graves === undefined) b.graves = 0;
  state.buildings.push(b);
  for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) T.building[zz * W + xx] = b.id;
  labels.push({ b, text: label ?? type });
  return b;
}

// ---- shore row ----
mk('fishingDock', 14, 6, { smoking: false });
const post = mk('tradingPost', 22, 5);
post.inventory = { fish: 80, tool: 40, wool: 60, apple: 90, ale: 30, stone: 50 };
state.trade.merchant = { id: 999, kind: 'general', name: 'Aldo', postId: post.id, offers: [], leavesIn: 100, arrive: 1 };
mk('mine', 36, 11);
mk('fishingDock', 52, 6, { label: 'fishingDock (smoke off)' });

// ---- all types grid (rotation 0) ----
const gridTop = 20;
let cx = 2;
let cz = gridTop;
let rowH = 0;
const byType = new Map<BuildingType, Building>();
for (const type of BUILDING_TYPES) {
  if (type === 'fishingDock' || type === 'tradingPost' || type === 'mine') continue;
  const [w, h] = BUILDINGS[type].size;
  if (cx + w > W - 2) {
    cx = 2;
    cz += rowH + 3;
    rowH = 0;
  }
  const b = mk(type, cx, cz);
  byType.set(type, b);
  cx += w + 3;
  rowH = Math.max(rowH, h);
}
const gridBottom = cz + rowH;
// inventories for storage types
byType.get('stockpile')!.inventory = { log: 90, stone: 60, iron: 30, firewood: 70 };
byType.get('market')!.inventory = { wheat: 200, apple: 120, fish: 90, venison: 60, tool: 40, woolCoat: 30, ale: 50, firewood: 80, herbs: 25, berries: 70 };
byType.get('cemetery')!.graves = 11;
for (const t of ['woodcutter', 'blacksmith', 'brewery', 'tailor'] as const) byType.get(t)!.smoking = true;

// ---- big stockpile with lots of piles ----
const stageZ = gridBottom + 4;
const sp = mk('stockpile', 2, stageZ, { size: [8, 6], label: 'stockpile 8x6 (piles)' });
sp.inventory = { log: 300, stone: 210, iron: 70, firewood: 160, wheat: 30 } as Building['inventory'];

// ---- construction stages ----
const stages: [BuildingState, number, number, string][] = [
  ['clearing', 0, 0, 'clearing'],
  ['construction', 0, 0, 'constr 0'],
  ['construction', 0.3, 0, 'constr .3'],
  ['construction', 0.7, 0, 'constr .7'],
  ['active', 1, 0, 'active'],
  ['demolishing', 0.5, 0, 'demolish .5'],
  ['ruin', 0, 0, 'ruin'],
  ['active', 1, 0.7, 'burning .7'],
];
let sx = 13;
const stageXs: number[] = [];
for (const [st, p, fire, label] of stages) {
  stageXs.push(sx);
  mk('woodenHouse', sx, stageZ, { state: st, progress: p, fire, label, smoking: st === 'active' && fire === 0 });
  sx += 5;
}
mk('storageBarn', sx, stageZ, { state: 'construction', progress: 0.3, delivered: { log: 40, stone: 12, iron: 6 }, label: 'barn .3 (materials)' });
sx += 7;
mk('chapel', sx, stageZ, { state: 'construction', progress: 0.55, label: 'chapel .55' });
sx += 8;
mk('townHall', sx, stageZ, { state: 'ruin', label: 'townHall ruin' });
sx += 8;
mk('pasture', sx, stageZ, { state: 'construction', progress: 0.5, size: [8, 6], label: 'pasture constr .5' });

// ---- rotation tests ----
const rotZ = stageZ + 10;
let rx = 2;
for (const type of ['tavern', 'blacksmith', 'tailor', 'pasture'] as const) {
  for (let r = 0; r < 4; r++) {
    const rot = r as Rotation;
    const size: [number, number] | undefined = type === 'pasture' ? (rot % 2 ? [6, 8] : [8, 6]) : undefined;
    const b = mk(type, rx, rotZ, { rot, size, label: `${type} r${r}` });
    rx += b.w + 3;
  }
}

// ---- slope tests (on the hill) ----
mk('woodenHouse', 70, 10, { label: 'house on slope' });
mk('pasture', 76, 9, { size: [9, 7], label: 'pasture on slope' });
mk('cemetery', 87, 9, { size: [6, 6], graves: 9, label: 'cemetery on slope' });
mk('cropField', 95, 9, { size: [7, 7], label: 'field on slope' });
mk('stockpile', 62, 10, { size: [5, 4], label: 'stockpile slope', inventory: { log: 70, stone: 40, firewood: 30 } });

state.rev.buildings++;

const buildingById = new Map<number, Building>();
for (const b of state.buildings) buildingById.set(b.id, b);
const game = { state, buildingById, speed: 1 } as unknown as Game;

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'fixed';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c4);
scene.fog = new THREE.Fog(0x9fb4c4, 120, 260);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 600);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;

const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x5a4a3a, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// terrain: per-tile quads with vertex colours
function buildTerrain(): THREE.Mesh {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const ch = (x: number, z: number) => T.height[z * (W + 1) + x];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const t = T.terrain[z * W + x];
      const bid = T.building[z * W + x];
      const bt = bid >= 0 ? buildingById.get(bid)?.type : undefined;
      if (t === Terrain.Water) c.setHex(0x6b6a55);
      else if (t === Terrain.Mountain) c.setHex(0x7d766c);
      else if (bt === 'cropField' || bt === 'orchard' || bt === 'pasture') c.setHex(bt === 'pasture' ? 0x7f9a4c : 0x6b5236);
      else if (bt === 'cemetery') c.setHex(0x68884a);
      else if (bt) c.setHex(0x7d6647);
      else c.setHex((x + z) % 2 ? 0x6f8f45 : 0x6b8a42);
      if (T.road[z * W + x] === Road.Bridge) c.setHex(0x6b6a55);
      const y00 = ch(x, z), y10 = ch(x + 1, z), y01 = ch(x, z + 1), y11 = ch(x + 1, z + 1);
      pos.push(x, y00, z, x, y01, z + 1, x + 1, y11, z + 1, x, y00, z, x + 1, y11, z + 1, x + 1, y10, z);
      for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  m.receiveShadow = true;
  return m;
}
scene.add(buildTerrain());
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(W, 6).rotateX(-Math.PI / 2).translate(W / 2, 0, 5),
  new THREE.MeshLambertMaterial({ color: 0x4f7f86, transparent: true, opacity: 0.82 }),
);
scene.add(water);

// footprint outlines + door markers
const outline = params.get('outline') !== '0';
if (outline) {
  const pts: number[] = [];
  const doors: number[] = [];
  for (const b of state.buildings) {
    const y = heightAt(state, b.x + b.w / 2, b.z + b.h / 2) + 0.03;
    const x0 = b.x, x1 = b.x + b.w, z0 = b.z, z1 = b.z + b.h;
    pts.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
    const dy = heightAt(state, b.doorX + 0.5, b.doorZ + 0.5) + 0.04;
    doors.push(b.doorX + 0.2, dy, b.doorZ + 0.2, b.doorX + 0.8, dy, b.doorZ + 0.8, b.doorX + 0.8, dy, b.doorZ + 0.2, b.doorX + 0.2, dy, b.doorZ + 0.8);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffe066 })));
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.Float32BufferAttribute(doors, 3));
  scene.add(new THREE.LineSegments(dg, new THREE.LineBasicMaterial({ color: 0xff3030 })));
}

// labels
for (const { b, text } of labels) {
  const div = document.createElement('div');
  div.className = 'lbl';
  div.textContent = text;
  const o = new CSS2DObject(div);
  o.position.set(b.x + b.w / 2, heightAt(state, b.x + b.w / 2, b.z + b.h / 2) + 0.1, b.z + b.h + 0.6);
  scene.add(o);
}

// buildings
const buildings = new BuildingRenderer(scene, game);

// ghosts
const ghostZ = stageZ + 1;
const g1 = createGhostModel('woodenHouse', 3, 3);
g1.position.set(sx + 12, LAND, ghostZ + 1.5);
setGhostValid(g1, true);
const g2 = createGhostModel('woodenHouse', 3, 3);
g2.position.set(sx + 16, LAND, ghostZ + 1.5);
setGhostValid(g2, false);
const g3 = createGhostModel('cropField', 5, 4);
g3.position.set(sx + 22, LAND, ghostZ + 2);
setGhostValid(g3, true);
scene.add(g1, g2, g3);
for (const [g, t] of [[g1, 'ghost valid'], [g2, 'ghost invalid'], [g3, 'ghost field']] as const) {
  const div = document.createElement('div');
  div.className = 'lbl';
  div.textContent = t;
  const o = new CSS2DObject(div);
  o.position.set(g.position.x, LAND, g.position.z + 2.2);
  scene.add(o);
}
void disposeModel;

// ---------------------------------------------------------------------------------------------
// Loop & API
// ---------------------------------------------------------------------------------------------

let snow = Number(params.get('snow') ?? 0);
let daylight = Number(params.get('day') ?? 1);
let highlight: number | null = null;
const t0 = performance.now();
let last = t0;

function applyLighting(): void {
  const d = daylight;
  sun.intensity = 0.25 + 2.4 * d;
  hemi.intensity = 0.35 + 0.8 * d;
  sun.color.setHSL(0.09, 0.5, 0.55 + 0.35 * d);
  const sky = new THREE.Color(0x1c2638).lerp(new THREE.Color(0x9fb4c4), d);
  scene.background = sky;
  (scene.fog as THREE.Fog).color.copy(sky);
}

function frame(): void {
  const now = performance.now();
  const realTime = (now - t0) / 1000;
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // merchant arrival animation demo when ?arrive=anim
  if (params.get('arrive') === 'anim' && state.trade.merchant) state.trade.merchant.arrive = Math.min(1, (realTime % 12) / 8);
  state.weather.snow = snow;
  const ctx: FrameContext = {
    game, camera, realTime, realDt, gameDt: 0, daylight, snow, season: snow > 0.3 ? 'winter' : 'summer', yearProgress: 0.4,
    focusX: controls.target.x, focusZ: controls.target.z, cameraDistance: camera.position.distanceTo(controls.target), quality: 'high',
  };
  sun.position.set(controls.target.x + 40, 70, controls.target.z + 25);
  sun.target.position.copy(controls.target);
  buildings.update(ctx);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  const hud = document.getElementById('hud')!;
  hud.textContent = `draw calls ${renderer.info.render.calls} · tris ${renderer.info.render.triangles} · chimneys ${buildings.getChimneys().length} · fires ${buildings.getFires().length}`;
}
renderer.setAnimationLoop(frame);

function look(tx: number, tz: number, dist: number, azDeg: number, elevDeg: number): void {
  const az = (azDeg * Math.PI) / 180;
  const el = (elevDeg * Math.PI) / 180;
  const ty = heightAt(state, tx, tz);
  controls.target.set(tx, ty, tz);
  camera.position.set(tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, tz + Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(controls.target);
  controls.update();
}

function focusBuilding(b: Building, dist = 9, az = 30, el = 32): void {
  look(b.x + b.w / 2, b.z + b.h / 2, dist, az, el);
}

const views: Record<string, () => void> = {
  overview: () => look(W / 2, 52, 130, 20, 55),
  shore: () => look(26, 9, 30, 25, 38),
  grid1: () => look(30, gridTop + 4, 34, 15, 40),
  grid2: () => look(78, gridTop + 4, 34, 15, 40),
  grid3: () => look(30, gridTop + 16, 34, 15, 40),
  grid4: () => look(78, gridTop + 16, 34, 15, 40),
  grid5: () => look(40, gridTop + 30, 40, 15, 40),
  stages: () => look(38, stageZ + 2, 32, 12, 38),
  stages2: () => look(78, stageZ + 3, 34, 12, 38),
  rotations: () => look(30, rotZ + 3, 34, 0, 88),
  rotations2: () => look(80, rotZ + 3, 34, 0, 88),
  rotations3: () => look(118, rotZ + 3, 34, 0, 88),
  slope: () => look(82, 13, 32, 10, 30),
  mine: () => look(38.5, 13, 12, 20, 35),
  bridges: () => look(7, 5, 10, 60, 35),
  fire: () => look(stageXs[7] + 1.5, stageZ + 1.5, 9, 25, 35),
  ruin: () => look(stageXs[6] + 1.5, stageZ + 1.5, 9, 25, 35),
  constr: () => look(stageXs[2] + 4, stageZ + 1.5, 12, 20, 30),
};

const api = {
  views: Object.keys(views),
  view(name: string): boolean {
    if (views[name]) {
      views[name]();
      return true;
    }
    const m = /^focus:(\w+)(?::(-?\d+))?(?::(\d+))?(?::([\d.]+))?$/.exec(name);
    if (m) {
      const b = byType.get(m[1] as BuildingType) ?? state.buildings.find((x) => x.type === m[1]);
      if (!b) return false;
      const size = Math.max(b.w, b.h);
      focusBuilding(b, m[4] ? Number(m[4]) : 4 + size * 1.5, m[2] ? Number(m[2]) : 30, m[3] ? Number(m[3]) : 30);
      return true;
    }
    return false;
  },
  setSnow(v: number) { snow = v; },
  setArrive(v: number) { if (state.trade.merchant) state.trade.merchant.arrive = v; },
  setDaylight(v: number) { daylight = v; applyLighting(); },
  highlight(type: BuildingType | null) {
    const b = type ? byType.get(type) : null;
    highlight = b ? b.id : null;
    buildings.setHighlight(highlight);
  },
  setFire(type: BuildingType, fire: number) {
    const b = byType.get(type);
    if (b) b.fire = fire;
  },
  /** Render one frame and return a PNG data URL (labels are HTML and not included). Enabled with ?capture=1. */
  capture: params.get('capture') === '1' ? () => { frame(); return renderer.domElement.toDataURL('image/png'); } : undefined,
  info() {
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, buildings: buildings.count };
  },
  state,
};
(window as unknown as { __sandbox: typeof api }).__sandbox = api;

applyLighting();
api.view(params.get('view') ?? 'overview');
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});
requestAnimationFrame(() => requestAnimationFrame(() => ((window as unknown as { __ready: boolean }).__ready = true)));
