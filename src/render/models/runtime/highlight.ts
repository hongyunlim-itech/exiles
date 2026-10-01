/**
 * SelectionRing — a pulsing gold outline around the selected building's footprint that follows the terrain,
 * with corner brackets. Built in world space when the selection changes (or the terrain changes).
 */
import * as THREE from 'three';
import type { Building, GameState } from '../../../core/types';
import { heightAt } from '../../../core/world';

const LIFT = 0.06;

export class SelectionRing {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private kId = -1;
  private kX = 0;
  private kZ = 0;
  private kW = 0;
  private kH = 0;
  private kRev = -1;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      color: 0xf2cf7a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'selection-ring';
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  clear(): void {
    this.kId = -1;
    this.mesh.visible = false;
  }

  /** Show the ring around `b` (rebuilds geometry when the footprint or terrain revision changed). */
  set(s: GameState, b: Building): void {
    this.mesh.visible = true;
    if (b.id === this.kId && b.x === this.kX && b.z === this.kZ && b.w === this.kW && b.h === this.kH && s.rev.terrain === this.kRev) return;
    this.kId = b.id;
    this.kX = b.x;
    this.kZ = b.z;
    this.kW = b.w;
    this.kH = b.h;
    this.kRev = s.rev.terrain;
    this.build(s, b);
  }

  update(time: number): void {
    if (!this.mesh.visible) return;
    this.material.opacity = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(time * 4));
  }

  private build(s: GameState, b: Building): void {
    const pad = 0.1;
    const x0 = b.x - pad;
    const x1 = b.x + b.w + pad;
    const z0 = b.z - pad;
    const z1 = b.z + b.h + pad;
    const pos: number[] = [];
    const quad = (ax: number, az: number, bx: number, bz: number, width: number) => {
      // strip from a→b with inward offset `width` (perpendicular in XZ), segmented to follow terrain
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / 0.5));
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      const nx = -dz * width;
      const nz = dx * width;
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const p0x = ax + (bx - ax) * t0;
        const p0z = az + (bz - az) * t0;
        const p1x = ax + (bx - ax) * t1;
        const p1z = az + (bz - az) * t1;
        const y00 = heightAt(s, p0x, p0z) + LIFT;
        const y10 = heightAt(s, p1x, p1z) + LIFT;
        const y01 = heightAt(s, p0x + nx, p0z + nz) + LIFT;
        const y11 = heightAt(s, p1x + nx, p1z + nz) + LIFT;
        pos.push(p0x, y00, p0z, p1x, y10, p1z, p1x + nx, y11, p1z + nz);
        pos.push(p0x, y00, p0z, p1x + nx, y11, p1z + nz, p0x + nx, y01, p0z + nz);
      }
    };
    const w = 0.07;
    quad(x0, z0, x1, z0, w);
    quad(x1, z0, x1, z1, w);
    quad(x1, z1, x0, z1, w);
    quad(x0, z1, x0, z0, w);
    // corner brackets (thicker, short)
    const c = Math.min(0.8, Math.min(b.w, b.h) * 0.3);
    const cw = 0.16;
    quad(x0, z0, x0 + c, z0, cw);
    quad(x0, z0 + c, x0, z0, cw);
    quad(x1 - c, z0, x1, z0, cw);
    quad(x1, z0, x1, z0 + c, cw);
    quad(x1, z1, x1 - c, z1, cw);
    quad(x1, z1 - c, x1, z1, cw);
    quad(x0 + c, z1, x0, z1, cw);
    quad(x0, z1, x0, z1 - c, cw);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
