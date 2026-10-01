/**
 * PileLayer — instanced storage piles: stockpile tiles filled per resource (size ∝ fill, coloured by resource),
 * goods on market stalls / trading-post pier slots, and delivered materials at construction sites.
 * One InstancedMesh per pile shape (bounded instance counts), rebuilt only when inventories change (polled ~3 Hz).
 */
import * as THREE from 'three';
import { BUILDINGS, RESOURCES } from '../../../core/defs';
import type { Building, GameState, Inventory, ResourceType } from '../../../core/types';
import { hash2 } from '../../../core/rng';
import { heightAt } from '../../../core/world';
import { pileShapeGeometry, type PileShape } from '../extras';
import type { BuildingMaterial } from '../material';
import type { BuildingVisual } from './visual';

const CAPACITY: Record<PileShape, number> = {
  logs: 2400, stones: 2400, ore: 1600, firewood: 2400, crate: 600, basket: 600, barrel: 400, content: 1200, sack: 600,
};
const SHAPES = Object.keys(CAPACITY) as PileShape[];

/** Raw stockpile shapes. */
const RAW_SHAPE: Partial<Record<ResourceType, PileShape>> = { log: 'logs', stone: 'stones', iron: 'ore', firewood: 'firewood' };
const BASKET_GOODS = new Set<ResourceType>(['berries', 'apple', 'pear', 'cherry', 'eggs', 'mushrooms', 'herbs']);
const SACK_GOODS = new Set<ResourceType>(['wheat', 'corn', 'potato', 'beans', 'roots', 'wool']);
/** Stockpile fill order (then any other resource). */
const ORDER: ResourceType[] = ['log', 'stone', 'iron', 'firewood'];

const BURLAP = new THREE.Color(0xb49c72);
const WHITE = new THREE.Color(1, 1, 1);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

function resColor(r: ResourceType, out: THREE.Color, boost = 1.12): THREE.Color {
  out.setHex(RESOURCES[r].color);
  out.r = Math.min(1.4, out.r * boost);
  out.g = Math.min(1.4, out.g * boost);
  out.b = Math.min(1.4, out.b * boost);
  return out;
}

export class PileLayer {
  readonly group = new THREE.Group();
  private readonly meshes = {} as Record<PileShape, THREE.InstancedMesh>;
  private readonly counts = {} as Record<PileShape, number>;
  private lastPoll = -1e9;
  private signature = -1;

  constructor(material: BuildingMaterial) {
    this.group.name = 'building-piles';
    for (const shape of SHAPES) {
      const mesh = new THREE.InstancedMesh(pileShapeGeometry(shape), material, CAPACITY[shape]);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[shape] * 3), 3);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `piles:${shape}`;
      this.meshes[shape] = mesh;
      this.counts[shape] = 0;
      this.group.add(mesh);
    }
  }

  /** Toggle shadow casting of all piles (quality setting). */
  setShadows(on: boolean): void {
    for (const shape of SHAPES) this.meshes[shape].castShadow = on;
  }

  reset(): void {
    this.signature = -1;
    this.lastPoll = -1e9;
    for (const shape of SHAPES) this.meshes[shape].count = 0;
  }

  /** Poll inventories (throttled) and rebuild instances when anything visible changed. */
  update(s: GameState, visuals: Map<number, BuildingVisual>, time: number, force = false): void {
    if (!force && time - this.lastPoll < 0.33) return;
    this.lastPoll = time;
    const sig = this.computeSignature(s, visuals);
    if (!force && sig === this.signature) return;
    this.signature = sig;
    this.rebuild(s, visuals);
  }

  private relevant(b: Building): boolean {
    if (b.state === 'active') return b.type === 'stockpile' || b.type === 'market' || b.type === 'tradingPost';
    return b.state === 'construction' && !BUILDINGS[b.type].resizable;
  }

  private computeSignature(s: GameState, visuals: Map<number, BuildingVisual>): number {
    let h = 17;
    for (const b of s.buildings) {
      if (!this.relevant(b)) continue;
      const v = visuals.get(b.id);
      h = (Math.imul(h, 31) + b.id) | 0;
      h = (Math.imul(h, 31) + (v ? Math.round(v.baseY * 50) : 0)) | 0;
      h = (Math.imul(h, 31) + (b.state === 'construction' ? Math.round(b.progress * 20) + 1000 : 0)) | 0;
      const inv: Inventory = b.state === 'construction' ? b.delivered : b.inventory;
      for (const k in inv) {
        const amt = inv[k as ResourceType] ?? 0;
        if (amt <= 0.5) continue;
        h = (Math.imul(h, 31) + k.charCodeAt(0) * 7 + k.length) | 0;
        h = (Math.imul(h, 31) + Math.ceil(amt / 2)) | 0;
      }
    }
    return h;
  }

  private rebuild(s: GameState, visuals: Map<number, BuildingVisual>): void {
    for (const shape of SHAPES) this.counts[shape] = 0;
    for (const b of s.buildings) {
      if (!this.relevant(b)) continue;
      const v = visuals.get(b.id);
      if (!v) continue;
      if (b.state === 'construction') this.addSiteMaterials(s, b, v);
      else if (b.type === 'stockpile') this.addStockpile(s, b);
      else this.addSlots(b, v);
    }
    for (const shape of SHAPES) {
      const mesh = this.meshes[shape];
      mesh.count = this.counts[shape];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private push(shape: PileShape, x: number, y: number, z: number, ry: number, sxz: number, sy: number, color: THREE.Color): boolean {
    const n = this.counts[shape];
    if (n >= CAPACITY[shape]) return false;
    const mesh = this.meshes[shape];
    _e.set(0, ry, 0);
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(sxz, sy, sxz);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(n, _m);
    mesh.setColorAt(n, color);
    this.counts[shape] = n + 1;
    return true;
  }

  /** One pile per tile, resources in contiguous runs, height by tile fill. */
  private addStockpile(s: GameState, b: Building): void {
    const cap = BUILDINGS.stockpile.storage?.capacity ?? 25;
    const tiles = b.w * b.h;
    const res: ResourceType[] = [];
    for (const r of ORDER) if ((b.inventory[r] ?? 0) > 0.5) res.push(r);
    for (const k in b.inventory) {
      const r = k as ResourceType;
      if (!ORDER.includes(r) && (b.inventory[r] ?? 0) > 0.5) res.push(r);
    }
    let t = 0;
    for (const r of res) {
      let amt = b.inventory[r] ?? 0;
      while (amt > 0.5 && t < tiles) {
        const fill = Math.min(1, amt / cap);
        amt -= cap;
        const tx = b.x + (t % b.w);
        const tz = b.z + Math.floor(t / b.w);
        t++;
        const jx = (hash2(tx, tz, 3) - 0.5) * 0.08;
        const jz = (hash2(tx, tz, 5) - 0.5) * 0.08;
        const x = tx + 0.5 + jx;
        const z = tz + 0.5 + jz;
        const ry = (hash2(tx, tz, 7) < 0.5 ? 0 : Math.PI / 2) + (hash2(tx, tz, 9) - 0.5) * 0.2;
        this.addGood(r, x, heightAt(s, x, z), z, ry, 0.78 + 0.22 * fill, 0.25 + 0.75 * fill);
      }
    }
  }

  /** A good (raw pile or container + contents) at a world point. */
  private addGood(r: ResourceType, x: number, y: number, z: number, ry: number, sxz: number, sy: number): void {
    const raw = RAW_SHAPE[r];
    if (raw) {
      this.push(raw, x, y, z, ry, sxz, sy, resColor(r, _c, raw === 'logs' || raw === 'firewood' ? 1.05 : 1.12));
      return;
    }
    const k = Math.max(0.55, sxz);
    if (r === 'ale') {
      this.push('barrel', x, y, z, ry, k, k, WHITE);
      return;
    }
    if (SACK_GOODS.has(r)) {
      _c.copy(BURLAP).lerp(resColor(r, _c2, 1), 0.45);
      this.push('sack', x, y, z, ry, k, k * (0.8 + 0.2 * sy), _c);
      return;
    }
    if (BASKET_GOODS.has(r)) {
      if (this.push('basket', x, y, z, ry, k * 1.4, k * 1.4, WHITE)) this.push('content', x, y + 0.2 * k * 1.4, z, ry, k * 1.25, k, resColor(r, _c));
      return;
    }
    if (this.push('crate', x, y, z, ry, k, k, WHITE)) this.push('content', x, y + 0.34 * k, z, ry, k * 1.1, k * 0.9, resColor(r, _c));
  }

  /** Market stall / trading post slots: distinct goods first (largest amounts), scaled by amount. */
  private addSlots(b: Building, v: BuildingVisual): void {
    const slots = v.model.slots;
    if (!slots.length) return;
    const goods: [ResourceType, number][] = [];
    for (const k in b.inventory) {
      const amt = b.inventory[k as ResourceType] ?? 0;
      if (amt > 0.5) goods.push([k as ResourceType, amt]);
    }
    if (!goods.length) return;
    goods.sort((a, c) => c[1] - a[1]);
    const ry0 = v.group.rotation.y;
    for (let i = 0; i < slots.length; i++) {
      const [r, amt] = goods[i % goods.length];
      if (i >= goods.length && amt < 60 * (1 + Math.floor(i / goods.length))) continue;
      v.toWorld(slots[i], _v);
      const k = 0.55 + 0.35 * Math.min(1, amt / 250);
      const raw = RAW_SHAPE[r];
      this.addGood(r, _v.x, _v.y, _v.z, ry0 + (i % 3) * 0.4, raw ? k * 0.55 : k * 0.9, raw ? 0.3 + 0.4 * Math.min(1, amt / 250) : 1);
    }
  }

  /** Delivered-but-unused construction materials piled at the site's front corners. */
  private addSiteMaterials(s: GameState, b: Building, v: BuildingVisual): void {
    const hw = v.mw / 2;
    const hh = v.mh / 2;
    const spots: [number, number][] = [[-hw + 0.42, hh - 0.4], [hw - 0.42, hh - 0.4], [hw - 0.42, hh - 1.2]];
    let i = 0;
    for (const r of ['log', 'stone', 'iron'] as const) {
      const cost = b.cost[r] ?? 0;
      const del = b.delivered[r] ?? 0;
      const left = del - cost * Math.max(0, Math.min(1, b.progress));
      if (left < 1 || i >= spots.length) continue;
      _v.set(spots[i][0], 0, spots[i][1]);
      i++;
      v.toWorld(_v, _v);
      const f = Math.min(1, left / 25);
      this.addGood(r, _v.x, heightAt(s, _v.x, _v.z), _v.z, v.group.rotation.y, 0.55 + 0.2 * f, 0.3 + 0.6 * f);
    }
  }

  dispose(): void {
    for (const shape of SHAPES) {
      const mesh = this.meshes[shape];
      mesh.removeFromParent();
      mesh.dispose();
    }
  }
}
