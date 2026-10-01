/**
 * Dev-only 3D preview of generated worlds (NOT the game renderer). URL params:
 *   ?seed=1&terrain=valleys&size=medium&view=start|overview&az=0.6&el=0.9&dist=70
 */
import * as THREE from 'three';
import { Rng } from '../../src/core/rng';
import type { MapSize, NewGameSettings, TerrainStyle } from '../../src/core/types';
import { Feature, Terrain } from '../../src/core/types';
import { heightAt } from '../../src/core/world';
import { generateWorld } from '../../src/sim/worldgen';

const q = new URLSearchParams(location.search);
const settings: NewGameSettings = {
  seed: Number(q.get('seed') ?? 1),
  townName: 'P',
  mapSize: (q.get('size') ?? 'medium') as MapSize,
  terrain: (q.get('terrain') ?? 'valleys') as TerrainStyle,
  climate: 'fair',
  difficulty: 'medium',
  disasters: true,
};
let id = 1;
const t0 = performance.now();
const world = generateWorld(settings, new Rng(settings.seed), () => id++);
const genMs = performance.now() - t0;
const { W, H, tiles } = world;
const state = { W, H, tiles } as never;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c4);
scene.fog = new THREE.Fog(0x9fb4c4, 140, 360);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 1000);
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a4a30, 1.1));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
sun.position.set(-60, 90, -40);
scene.add(sun);

// Terrain: per-tile quads with flat shading, colours by terrain type.
const COLORS: Record<number, number> = {
  [Terrain.Grass]: 0x6f8f45,
  [Terrain.Sand]: 0xc9b98a,
  [Terrain.Water]: 0x6b6450,
  [Terrain.DeepWater]: 0x4b4636,
  [Terrain.Mountain]: 0x7d766c,
};
const pos: number[] = [];
const col: number[] = [];
const c = new THREE.Color();
const snow = new THREE.Color(0xe8eef2);
const CW = W + 1;
const h = (xx: number, zz: number): number => tiles.height[zz * CW + xx];
for (let z = 0; z < H; z++) {
  for (let x = 0; x < W; x++) {
    const i = z * W + x;
    const t = tiles.terrain[i];
    c.setHex(COLORS[t]);
    const avg = (h(x, z) + h(x + 1, z) + h(x, z + 1) + h(x + 1, z + 1)) / 4;
    if (t === Terrain.Mountain && avg > 7) c.lerp(snow, Math.min(1, (avg - 7) / 3));
    if (t === Terrain.Grass) c.multiplyScalar(0.92 + ((x * 7 + z * 13) % 5) * 0.02);
    const v = [[x, z], [x, z + 1], [x + 1, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]];
    for (const [vx, vz] of v) {
      pos.push(vx, h(vx, vz), vz);
      col.push(c.r, c.g, c.b);
    }
  }
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
geo.computeVertexNormals();
scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(W, H),
  new THREE.MeshLambertMaterial({ color: 0x3f6f7a, transparent: true, opacity: 0.82 }),
);
water.rotation.x = -Math.PI / 2;
water.position.set(W / 2, 0, H / 2);
scene.add(water);

// Features
const treeCounts = [0, 0, 0];
for (let i = 0; i < W * H; i++) if (tiles.feature[i] === Feature.Tree) treeCounts[tiles.variant[i]]++;
const coneGeo = new THREE.ConeGeometry(0.45, 1, 6);
coneGeo.translate(0, 0.5, 0);
const blobGeo = new THREE.IcosahedronGeometry(0.55, 0);
blobGeo.translate(0, 0.9, 0);
const treeMats = [0x2c4a26, 0x46702c, 0x8aa55a].map((color) => new THREE.MeshLambertMaterial({ color, flatShading: true }));
const trees = [0, 1, 2].map((s) => new THREE.InstancedMesh(s === 0 ? coneGeo : blobGeo, treeMats[s], Math.max(1, treeCounts[s])));
const rockGeo = new THREE.DodecahedronGeometry(0.35, 0);
let rockCount = 0;
for (let i = 0; i < W * H; i++) if (tiles.feature[i] === Feature.Rock || tiles.feature[i] === Feature.Iron) rockCount++;
const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ flatShading: true }), Math.max(1, rockCount));
const m = new THREE.Matrix4();
const ti = [0, 0, 0];
let ri = 0;
const rockCol = new THREE.Color(0xa8a59c);
const ironCol = new THREE.Color(0x8a4a2a);
for (let z = 0; z < H; z++) {
  for (let x = 0; x < W; x++) {
    const i = z * W + x;
    const f = tiles.feature[i];
    if (f === Feature.None) continue;
    const jx = x + 0.5 + (((x * 73 + z * 31) % 7) - 3) * 0.06;
    const jz = z + 0.5 + (((x * 17 + z * 59) % 7) - 3) * 0.06;
    const y = heightAt(state, jx, jz);
    if (f === Feature.Tree) {
      const s = tiles.variant[i];
      const g = tiles.featureAmount[i];
      const hgt = (s === 0 ? 3.2 : 2.4) * (0.3 + 0.7 * g);
      m.makeScale(0.6 + 0.4 * g, hgt, 0.6 + 0.4 * g).setPosition(jx, y, jz);
      trees[s].setMatrixAt(ti[s]++, m);
    } else {
      m.makeScale(1, 0.8, 1).setPosition(jx, y + 0.1, jz);
      rocks.setMatrixAt(ri, m);
      rocks.setColorAt(ri++, f === Feature.Rock ? rockCol : ironCol);
    }
  }
}
for (const t of trees) scene.add(t);
scene.add(rocks);
const deerGeo = new THREE.BoxGeometry(0.5, 0.35, 0.22);
deerGeo.translate(0, 0.35, 0);
const deer = new THREE.InstancedMesh(deerGeo, new THREE.MeshLambertMaterial({ color: 0x8b5a2b }), Math.max(1, world.animals.length));
world.animals.forEach((a, k) => {
  m.makeRotationY(-a.heading).setPosition(a.x, heightAt(state, a.x, a.z), a.z);
  deer.setMatrixAt(k, m);
});
scene.add(deer);
// Start square marker
const corners = [[-12, -12], [12, -12], [12, 12], [-12, 12]].map(
  ([dx, dz]) => new THREE.Vector3(world.startX + dx, heightAt(state, world.startX + dx, world.startZ + dz) + 0.1, world.startZ + dz),
);
scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: 0xffe000 })));

const view = q.get('view') ?? 'start';
const tx = view === 'start' ? world.startX : W / 2;
const tz = view === 'start' ? world.startZ : H / 2;
const dist = Number(q.get('dist') ?? (view === 'start' ? 70 : W * 1.25));
const az = Number(q.get('az') ?? 0.6);
const el = Number(q.get('el') ?? 0.85);
const ty = heightAt(state, tx, tz);
camera.position.set(tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, tz + Math.cos(az) * Math.cos(el) * dist);
camera.lookAt(tx, ty, tz);
renderer.render(scene, camera);
document.getElementById('info')!.textContent =
  `${settings.terrain}/${settings.mapSize}/seed ${settings.seed} gen ${genMs.toFixed(0)}ms trees ${treeCounts.join('/')} deer ${world.animals.length}`;
(window as unknown as { __ready: boolean }).__ready = true;
