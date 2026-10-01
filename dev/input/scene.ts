/**
 * Sandbox-only minimal renderer implementing the parts of GameRenderer the InputManager uses: overlayGroup, camera,
 * cameraController (target/distance/rightDragMoved), terrain.setGridVisible, pickTile, pickEntity, worldToScreen.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../../src/core/constants';
import { BUILDINGS } from '../../src/core/defs';
import { Feature, Road, Terrain } from '../../src/core/types';
import { cornerHeight, heightAt, rotationAngle } from '../../src/core/world';
import { createBuildingModel } from '../../src/render/models';
import type { PickResult } from '../../src/render/types';
import type { FakeGame } from './fakeGame';

const TERRAIN_COLORS: Record<number, number> = {
  [Terrain.Grass]: 0x6f8f45,
  [Terrain.Sand]: 0xc9b98a,
  [Terrain.Water]: 0x4f7f86,
  [Terrain.DeepWater]: 0x2d5566,
  [Terrain.Mountain]: 0x7d766c,
};

export class SandboxRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  readonly overlayGroup = new THREE.Group();
  readonly canvas: HTMLCanvasElement;
  settings = { shadows: false, quality: 'high' as const, showGrid: false };
  readonly cameraController = { target: { x: 0, y: 0, z: 0 }, yaw: 0.6, pitch: 0.95, distance: 42, rightDragMoved: 0, enabled: true, edgeScroll: false };
  readonly terrain: { setGridVisible(v: boolean): void };
  private terrainMesh!: THREE.Mesh;
  private grid!: THREE.LineSegments;
  private readonly features = new THREE.Group();
  private readonly buildings = new THREE.Group();
  private lastRoads = -1;
  private lastFeatures = -1;
  private lastBuildings = -1;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly tmp = new THREE.Vector3();

  constructor(container: HTMLElement, readonly game: FakeGame) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);
    this.scene.background = new THREE.Color(0xa9c3cf);
    this.scene.add(new THREE.HemisphereLight(0xdfeaf0, 0x4a4030, 1.4));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
    sun.position.set(-40, 80, 30);
    this.scene.add(sun);
    this.scene.add(this.overlayGroup, this.features, this.buildings);
    this.buildTerrain();
    this.terrain = { setGridVisible: (v: boolean) => { this.grid.visible = v; } };
    const ctl = this.cameraController;
    ctl.target.x = game.startX + 0.5;
    ctl.target.z = game.startZ + 0.5;
    this.bindControls();
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  focusOn(x: number, z: number): void {
    this.cameraController.target.x = x;
    this.cameraController.target.z = z;
  }

  render(): void {
    const s = this.game.state;
    if (s.rev.roads !== this.lastRoads) {
      this.lastRoads = s.rev.roads;
      this.colorTerrain();
    }
    if (s.rev.features !== this.lastFeatures) {
      this.lastFeatures = s.rev.features;
      this.buildFeatures();
    }
    if (s.rev.buildings !== this.lastBuildings) {
      this.lastBuildings = s.rev.buildings;
      this.buildBuildings();
    }
    const c = this.cameraController;
    c.target.y = heightAt(s, c.target.x, c.target.z);
    const cp = Math.cos(c.pitch);
    this.camera.position.set(
      c.target.x + Math.cos(c.yaw) * cp * c.distance,
      c.target.y + Math.sin(c.pitch) * c.distance,
      c.target.z + Math.sin(c.yaw) * cp * c.distance,
    );
    this.camera.lookAt(c.target.x, c.target.y, c.target.z);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
  }

  pickTile(clientX: number, clientY: number): { x: number; z: number; wx: number; wz: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (!hit) return null;
    const s = this.game.state;
    const x = Math.floor(hit.point.x);
    const z = Math.floor(hit.point.z);
    if (x < 0 || z < 0 || x >= s.W || z >= s.H) return null;
    return { x, z, wx: hit.point.x, wz: hit.point.z };
  }

  pickEntity(clientX: number, clientY: number): PickResult {
    const t = this.pickTile(clientX, clientY);
    if (!t) return null;
    const b = this.game.buildingAtTile(t.x, t.z);
    return b ? { kind: 'building', id: b.id } : null;
  }

  worldToScreen(wx: number, wy: number, wz: number): { x: number; y: number; visible: boolean } {
    const v = this.tmp.set(wx, wy, wz).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, visible: v.z < 1 && v.z > -1 };
  }

  // ---------------------------------------------------------------------------------------------

  private buildTerrain(): void {
    const s = this.game.state;
    const n = s.W * s.H;
    const pos = new Float32Array(n * 4 * 3);
    const idx = new Uint32Array(n * 6);
    for (let z = 0; z < s.H; z++) {
      for (let x = 0; x < s.W; x++) {
        const t = z * s.W + x;
        for (let k = 0; k < 4; k++) {
          const cx = x + (k & 1);
          const cz = z + (k >> 1);
          const o = (t * 4 + k) * 3;
          pos[o] = cx;
          pos[o + 1] = cornerHeight(s, cx, cz);
          pos[o + 2] = cz;
        }
        const v = t * 4;
        idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], t * 6);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    this.terrainMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.scene.add(this.terrainMesh);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(s.W, s.H), new THREE.MeshLambertMaterial({ color: 0x3f6f7a, transparent: true, opacity: 0.75 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(s.W / 2, WATER_LEVEL - 0.05, s.H / 2);
    this.scene.add(water);
    // grid
    const lines: number[] = [];
    for (let z = 0; z < s.H; z++) {
      for (let x = 0; x < s.W; x++) {
        lines.push(x, cornerHeight(s, x, z) + 0.02, z, x + 1, cornerHeight(s, x + 1, z) + 0.02, z);
        lines.push(x, cornerHeight(s, x, z) + 0.02, z, x, cornerHeight(s, x, z + 1) + 0.02, z + 1);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }));
    this.grid.visible = false;
    this.scene.add(this.grid);
  }

  private colorTerrain(): void {
    const s = this.game.state;
    const attr = this.terrainMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < s.W * s.H; i++) {
      const r = s.tiles.road[i];
      c.setHex(r === Road.Dirt ? 0x8a7050 : r === Road.Stone ? 0x8e8b84 : r === Road.Bridge ? 0x7a5534 : TERRAIN_COLORS[s.tiles.terrain[i]]);
      for (let k = 0; k < 4; k++) attr.setXYZ(i * 4 + k, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }

  private buildFeatures(): void {
    const s = this.game.state;
    for (const ch of this.features.children) {
      const m = ch as THREE.InstancedMesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.features.clear();
    const trees: number[] = [];
    const rocks: number[] = [];
    for (let i = 0; i < s.W * s.H; i++) {
      const f = s.tiles.feature[i];
      if (f === Feature.Tree) trees.push(i);
      else if (f === Feature.Rock || f === Feature.Iron) rocks.push(i);
    }
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const tree = new THREE.InstancedMesh(new THREE.ConeGeometry(0.4, 1.6, 6), new THREE.MeshLambertMaterial({ flatShading: true }), Math.max(1, trees.length));
    trees.forEach((i, k) => {
      const x = (i % s.W) + 0.5;
      const z = Math.floor(i / s.W) + 0.5;
      const g = Math.max(0.3, s.tiles.featureAmount[i]);
      m4.makeScale(g, g, g).setPosition(x, heightAt(s, x, z) + 0.8 * g, z);
      tree.setMatrixAt(k, m4);
      tree.setColorAt(k, col.setHex(s.tiles.marked[i] ? 0xc0582a : 0x3d6b35));
    });
    tree.count = trees.length;
    const rock = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.35), new THREE.MeshLambertMaterial({ flatShading: true }), Math.max(1, rocks.length));
    rocks.forEach((i, k) => {
      const x = (i % s.W) + 0.5;
      const z = Math.floor(i / s.W) + 0.5;
      m4.makeTranslation(x, heightAt(s, x, z) + 0.15, z);
      rock.setMatrixAt(k, m4);
      rock.setColorAt(k, col.setHex(s.tiles.marked[i] ? 0xc0582a : s.tiles.feature[i] === Feature.Iron ? 0x6b4a3a : 0x9a9a96));
    });
    rock.count = rocks.length;
    this.features.add(tree, rock);
  }

  private buildBuildings(): void {
    const s = this.game.state;
    this.buildings.clear();
    for (const b of s.buildings) {
      const [mw, mh] = b.rotation % 2 === 1 ? [b.h, b.w] : [b.w, b.h];
      let obj: THREE.Object3D;
      try {
        obj = createBuildingModel(b.type, mw, mh, b.id).root;
      } catch {
        const def = BUILDINGS[b.type];
        const hgt = def.walkable ? 0.1 : 1.4;
        obj = new THREE.Mesh(new THREE.BoxGeometry(mw - 0.2, hgt, mh - 0.2), new THREE.MeshLambertMaterial({ color: def.walkable ? 0x7a6a45 : 0xb89a70 }));
        obj.position.y = hgt / 2;
        const g = new THREE.Group();
        g.add(obj);
        obj = g;
      }
      obj.position.set(b.x + b.w / 2, heightAt(s, b.x + b.w / 2, b.z + b.h / 2), b.z + b.h / 2);
      obj.rotation.y = rotationAngle(b.rotation);
      this.buildings.add(obj);
    }
  }

  private bindControls(): void {
    const c = this.cameraController;
    let rdown = false;
    let lx = 0;
    let ly = 0;
    let sx = 0;
    let sy = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        rdown = true;
        lx = sx = e.clientX;
        ly = sy = e.clientY;
        c.rightDragMoved = 0;
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!rdown) return;
      c.yaw += (e.clientX - lx) * 0.005;
      c.pitch = Math.max(0.4, Math.min(1.4, c.pitch + (e.clientY - ly) * 0.005));
      lx = e.clientX;
      ly = e.clientY;
      c.rightDragMoved = Math.max(c.rightDragMoved, Math.hypot(e.clientX - sx, e.clientY - sy));
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 2) rdown = false;
    });
    this.canvas.addEventListener('wheel', (e) => {
      c.distance = Math.max(8, Math.min(120, c.distance * (e.deltaY > 0 ? 1.1 : 0.9)));
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      const step = c.distance * 0.05;
      const fx = -Math.cos(c.yaw);
      const fz = -Math.sin(c.yaw);
      if (e.code === 'KeyW') { c.target.x += fx * step; c.target.z += fz * step; }
      if (e.code === 'KeyS') { c.target.x -= fx * step; c.target.z -= fz * step; }
      if (e.code === 'KeyA') { c.target.x += fz * step; c.target.z -= fx * step; }
      if (e.code === 'KeyD') { c.target.x -= fz * step; c.target.z += fx * step; }
    });
  }
}
