/**
 * TileOverlay — one draw call of per-tile translucent quads that hug the terrain (each quad's four corners sample the
 * terrain height, lifted slightly, and sit above the water surface on water tiles). Used for placement validity
 * (green/yellow/red), road previews, area selections and demolish highlights.
 *
 * Buffers are preallocated and grow geometrically; filling happens only when a tool's preview changes (never per
 * frame), and nothing is allocated while filling except on capacity growth.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../../core/constants';
import type { GameState } from '../../core/types';
import { heightAt } from '../../core/world';
import { linearRgb } from './colors';

/** Height above the terrain (world units). */
const LIFT = 0.05;
/** Minimum height above WATER_LEVEL for overlay quads (water surface waves). */
const WATER_LIFT = 0.1;
/** Inset of each quad from the tile edges (gives a subtle grid look). */
const INSET = 0.06;

export class TileOverlay {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private capacity = 0;
  private count = 0;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private posAttr!: THREE.BufferAttribute;
  private colAttr!: THREE.BufferAttribute;
  private state: GameState | null = null;

  constructor(parent: THREE.Object3D, initialCapacity = 256, renderOrder = 10, name = 'input.tileOverlay') {
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.grow(initialCapacity);
    parent.add(this.mesh);
  }

  /** Number of tiles currently drawn. */
  get size(): number {
    return this.count;
  }

  /** Start a new fill. */
  begin(state: GameState): void {
    this.state = state;
    this.count = 0;
  }

  /** Add one tile quad (x, z) with an sRGB colour and alpha. */
  add(x: number, z: number, color: number, alpha: number): void {
    const s = this.state;
    if (!s || x < 0 || z < 0 || x >= s.W || z >= s.H) return;
    if (this.count >= this.capacity) this.grow(Math.max(64, this.capacity * 2));
    const [r, g, b] = linearRgb(color);
    const p = this.positions;
    const c = this.colors;
    let o = this.count * 12;
    let oc = this.count * 16;
    for (let k = 0; k < 4; k++) {
      const vx = x + ((k & 1) === 0 ? INSET : 1 - INSET);
      const vz = z + ((k & 2) === 0 ? INSET : 1 - INSET);
      const h = heightAt(s, vx, vz);
      p[o++] = vx;
      // over water keep clear of the wave crests (render-scene waves reach about +-0.07)
      p[o++] = Math.max(h + LIFT, WATER_LEVEL + WATER_LIFT);
      p[o++] = vz;
      c[oc++] = r;
      c[oc++] = g;
      c[oc++] = b;
      c[oc++] = alpha;
    }
    this.count++;
  }

  /** Add a tile by index. */
  addIndex(i: number, color: number, alpha: number): void {
    const s = this.state;
    if (!s) return;
    this.add(i % s.W, Math.floor(i / s.W), color, alpha);
  }

  /** Upload the filled tiles. */
  end(): void {
    const n = this.count;
    this.posAttr.clearUpdateRanges();
    this.colAttr.clearUpdateRanges();
    if (n > 0) {
      this.posAttr.addUpdateRange(0, n * 12);
      this.colAttr.addUpdateRange(0, n * 16);
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
    this.state = null;
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }

  private grow(capacity: number): void {
    const positions = new Float32Array(capacity * 12);
    const colors = new Float32Array(capacity * 16);
    positions.set(this.positions.subarray(0, Math.min(this.positions.length, this.count * 12)));
    colors.set(this.colors.subarray(0, Math.min(this.colors.length, this.count * 16)));
    const index = new Uint32Array(capacity * 6);
    for (let t = 0; t < capacity; t++) {
      const v = t * 4;
      const o = t * 6;
      index[o] = v;
      index[o + 1] = v + 2;
      index[o + 2] = v + 1;
      index[o + 3] = v + 1;
      index[o + 4] = v + 2;
      index[o + 5] = v + 3;
    }
    // A fresh geometry so the old GPU buffers are released with the old geometry.
    const geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.posAttr);
    geometry.setAttribute('color', this.colAttr);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, this.count * 6);
    const old = this.geometry;
    this.geometry = geometry;
    if (this.mesh) this.mesh.geometry = geometry;
    old?.dispose();
    this.positions = positions;
    this.colors = colors;
    this.capacity = capacity;
  }
}
