/**
 * Placement ghost management: creates ghosts via render-models' `createGhostModel`, keeps a small LRU cache keyed by
 * (type, unrotated w, h) so dragging a zone back and forth doesn't rebuild models, positions them per the model-space
 * convention and tints them with `setGhostValid` (only when validity changes).
 *
 * If the model factory is unavailable or throws, a simple translucent box ghost is used instead so the tool keeps
 * working.
 */
import * as THREE from 'three';
import type { BuildingType } from '../../core/types';
import { createGhostModel, disposeModel, setGhostValid } from '../../render/models';

interface GhostEntry {
  key: string;
  group: THREE.Group;
  /** True when created by render-models (dispose via disposeModel); false for the local fallback. */
  real: boolean;
  valid: boolean | null;
}

const CACHE_SIZE = 6;

function prepare(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
    o.renderOrder = 12;
  });
}

function fallbackGhost(w: number, h: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x66dd66, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
  const body = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.2, w - 0.2), 1.2, Math.max(0.2, h - 0.2)), mat);
  body.position.y = 0.6;
  group.add(body);
  // door marker on the +Z side
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.12), mat);
  door.position.set(0, 0.35, h / 2);
  group.add(door);
  group.userData.fallbackMaterial = mat;
  return group;
}

function setFallbackValid(group: THREE.Group, valid: boolean): void {
  const mat = group.userData.fallbackMaterial as THREE.MeshBasicMaterial | undefined;
  mat?.color.setHex(valid ? 0x66dd66 : 0xe24a3b);
}

function disposeFallback(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
  (group.userData.fallbackMaterial as THREE.Material | undefined)?.dispose();
}

export class GhostManager {
  private readonly root = new THREE.Group();
  /** LRU: most recently used last. */
  private readonly cache: GhostEntry[] = [];
  private current: GhostEntry | null = null;
  private warned = false;

  constructor(parent: THREE.Object3D) {
    this.root.name = 'input.ghosts';
    parent.add(this.root);
  }

  /**
   * Show the ghost of `type` with UNROTATED model dims (mw, mh) at world position (x, y, z) rotated by `angle`.
   */
  show(type: BuildingType, mw: number, mh: number, x: number, y: number, z: number, angle: number, valid: boolean): void {
    const entry = this.acquire(type, mw, mh);
    if (this.current !== entry) {
      if (this.current) this.current.group.visible = false;
      this.current = entry;
    }
    const g = entry.group;
    g.visible = true;
    g.position.set(x, y, z);
    g.rotation.set(0, angle, 0);
    if (entry.valid !== valid) {
      entry.valid = valid;
      try {
        if (entry.real) setGhostValid(g, valid);
        else setFallbackValid(g, valid);
      } catch (err) {
        this.warn('setGhostValid failed', err);
      }
    }
  }

  hide(): void {
    if (this.current) this.current.group.visible = false;
    this.current = null;
  }

  /** Drop all cached ghosts (e.g. on game change). */
  clear(): void {
    this.hide();
    for (const e of this.cache) this.destroy(e);
    this.cache.length = 0;
  }

  dispose(): void {
    this.clear();
    this.root.parent?.remove(this.root);
  }

  private acquire(type: BuildingType, mw: number, mh: number): GhostEntry {
    const key = `${type}:${mw}x${mh}`;
    const idx = this.cache.findIndex((e) => e.key === key);
    if (idx >= 0) {
      const e = this.cache[idx];
      if (idx !== this.cache.length - 1) {
        this.cache.splice(idx, 1);
        this.cache.push(e);
      }
      return e;
    }
    let group: THREE.Group;
    let real = true;
    try {
      group = createGhostModel(type, mw, mh);
    } catch (err) {
      this.warn('createGhostModel failed; using a box ghost', err);
      group = fallbackGhost(mw, mh);
      real = false;
    }
    prepare(group);
    group.visible = false;
    this.root.add(group);
    const entry: GhostEntry = { key, group, real, valid: null };
    this.cache.push(entry);
    while (this.cache.length > CACHE_SIZE) {
      const old = this.cache[0];
      if (old === this.current) break;
      this.cache.shift();
      this.destroy(old);
    }
    return entry;
  }

  private destroy(e: GhostEntry): void {
    this.root.remove(e.group);
    if (e.real) {
      try {
        disposeModel(e.group);
      } catch (err) {
        // Never dispose shared model geometry ourselves; dropping the reference is the safe fallback.
        this.warn('disposeModel failed', err);
      }
    } else {
      disposeFallback(e.group);
    }
  }

  private warn(msg: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[input] ${msg}`, err);
  }
}
