/**
 * Work-radius rings: thin terrain-hugging ribbons (a closed loop of quads whose vertices sample the terrain height).
 * - `cursor`: the radius of the building being placed (pulses gently).
 * - `selection`: the radius of the selected building.
 * - faint rings: radii of existing buildings of the same type while placing (pooled).
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../../core/constants';
import type { GameState } from '../../core/types';
import { heightAt } from '../../core/world';
import { RingColor } from './colors';

const MAX_SEGMENTS = 256;
const LIFT = 0.09;

function segmentsFor(radius: number): number {
  return Math.max(48, Math.min(MAX_SEGMENTS, Math.round(radius * 7)));
}

/** One ribbon ring with its own preallocated geometry. */
export class RingMesh {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  /** Parameters of the last build (to skip redundant rebuilds). */
  private cx = NaN;
  private cz = NaN;
  private r = NaN;
  private width = NaN;
  private terrainRev = -1;

  constructor(parent: THREE.Object3D, material: THREE.Material, name: string) {
    this.positions = new Float32Array((MAX_SEGMENTS + 1) * 2 * 3);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const index = new Uint16Array(MAX_SEGMENTS * 6);
    for (let k = 0; k < MAX_SEGMENTS; k++) {
      const v = k * 2;
      const o = k * 6;
      index[o] = v;
      index[o + 1] = v + 1;
      index[o + 2] = v + 2;
      index[o + 3] = v + 1;
      index[o + 4] = v + 3;
      index[o + 5] = v + 2;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Show the ring centred at (cx, cz) with radius r and ribbon width (world units). Rebuilds only on change. */
  show(state: GameState, cx: number, cz: number, r: number, width: number): void {
    const rev = state.rev.terrain;
    if (this.mesh.visible && cx === this.cx && cz === this.cz && r === this.r && width === this.width && rev === this.terrainRev) return;
    this.cx = cx;
    this.cz = cz;
    this.r = r;
    this.width = width;
    this.terrainRev = rev;
    const segs = segmentsFor(r);
    const p = this.positions;
    const ri = Math.max(0.05, r - width / 2);
    const ro = r + width / 2;
    let o = 0;
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ix = cx + ca * ri;
      const iz = cz + sa * ri;
      const ox = cx + ca * ro;
      const oz = cz + sa * ro;
      const hi = heightAt(state, ix, iz);
      const ho = heightAt(state, ox, oz);
      p[o++] = ix;
      p[o++] = (hi > WATER_LEVEL ? hi : WATER_LEVEL) + LIFT;
      p[o++] = iz;
      p[o++] = ox;
      p[o++] = (ho > WATER_LEVEL ? ho : WATER_LEVEL) + LIFT;
      p[o++] = oz;
    }
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, (segs + 1) * 6);
    this.posAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, segs * 6);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
  }
}

function ringMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

/** Ribbon width that stays readable at any zoom level. */
export function ringWidthForDistance(cameraDistance: number): number {
  const w = cameraDistance * 0.0055;
  // quantise so zooming doesn't rebuild the rings every frame
  return Math.round(Math.max(0.14, Math.min(0.7, w)) * 20) / 20;
}

export class RingSet {
  readonly cursor: RingMesh;
  readonly selection: RingMesh;
  private readonly faint: RingMesh[] = [];
  private faintUsed = 0;
  private readonly cursorMat = ringMaterial(RingColor.cursor, 0.85);
  private readonly selectionMat = ringMaterial(RingColor.selection, 0.85);
  private readonly faintMat = ringMaterial(RingColor.faint, 0.3);
  private readonly group = new THREE.Group();
  /** Maximum number of faint rings drawn at once. */
  static readonly MAX_FAINT = 40;

  constructor(parent: THREE.Object3D) {
    this.group.name = 'input.rings';
    parent.add(this.group);
    this.cursor = new RingMesh(this.group, this.cursorMat, 'input.ring.cursor');
    this.selection = new RingMesh(this.group, this.selectionMat, 'input.ring.selection');
  }

  /** Begin (re)filling the faint rings. */
  beginFaint(): void {
    this.faintUsed = 0;
  }

  addFaint(state: GameState, cx: number, cz: number, r: number, width: number): void {
    if (this.faintUsed >= RingSet.MAX_FAINT) return;
    let ring = this.faint[this.faintUsed];
    if (!ring) {
      ring = new RingMesh(this.group, this.faintMat, `input.ring.faint${this.faintUsed}`);
      this.faint.push(ring);
    }
    ring.show(state, cx, cz, r, width);
    this.faintUsed++;
  }

  endFaint(): void {
    for (let k = this.faintUsed; k < this.faint.length; k++) this.faint[k].hide();
  }

  hideFaint(): void {
    this.faintUsed = 0;
    this.endFaint();
  }

  /** Per-frame cosmetic animation (cheap: two uniform updates). */
  animate(time: number): void {
    this.cursorMat.opacity = 0.7 + 0.2 * Math.sin(time * 3.2);
    this.selectionMat.opacity = 0.72 + 0.18 * Math.sin(time * 2.4);
  }

  hideAll(): void {
    this.cursor.hide();
    this.selection.hide();
    this.hideFaint();
  }

  dispose(): void {
    this.cursor.dispose();
    this.selection.dispose();
    for (const r of this.faint) r.dispose();
    this.faint.length = 0;
    this.cursorMat.dispose();
    this.selectionMat.dispose();
    this.faintMat.dispose();
    this.group.parent?.remove(this.group);
  }
}
