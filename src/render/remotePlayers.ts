/**
 * RemotePlayersRenderer — the other co-op players in the world: a coloured cursor marker hugging the terrain (pulsing
 * ground ring + small pin with a pennant, gentle bob), a DOM name label above it (projected every frame, hidden when
 * off-screen), and a translucent ghost of what they are about to place, tinted in their colour.
 *
 * Data comes from a source function (main.ts wires `() => app.net.players()`), polled at ~20 Hz; marker positions are
 * smoothed in between. Cheap by construction: shared geometries, one small material set per player, cached ghosts,
 * no shadows, no per-frame allocations (scratch vectors, DOM writes only when a label moved or changed).
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../core/constants';
import { BUILDINGS } from '../core/defs';
import type { BuildingType, GameState } from '../core/types';
import { cornerHeight, heightAt, rotationAngle } from '../core/world';
import type { PlayerInfo } from '../net/types';
import type { Game } from '../sim/game';
import { createGhostModel, disposeModel } from './models';
import type { FrameContext, SubRenderer } from './types';

export type PlayersSource = () => readonly PlayerInfo[];

/** Seconds between reads of the players list. */
const POLL_INTERVAL = 0.05;
/** Exponential smoothing rate of marker movement (1/s). */
const FOLLOW_RATE = 14;
/** Presence unchanged for this long → dimmed marker and label. */
const IDLE_MS = 45_000;
/** Render order: above terrain overlays, below the local build ghost (20). */
const RENDER_ORDER = 14;

const STYLE_ID = 'exiles-remote-players-style';
const CSS = `
.exiles-remote-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.exiles-remote-label {
  position: absolute; left: 0; top: 0; display: none; pointer-events: none; user-select: none; white-space: nowrap;
  padding: 2px 8px 3px; border-radius: 6px; border: 1px solid rgba(201, 164, 92, 0.55);
  border-left: 3px solid var(--pc, #e6c47c);
  background: rgba(24, 18, 12, 0.82); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  font: 600 12px/1.25 "Alegreya Sans", "Segoe UI", Georgia, sans-serif; color: #efe3c6;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6); will-change: transform; transition: opacity 0.3s;
}
.exiles-remote-label .rl-name { color: var(--pc, #efe3c6); font-weight: 700; }
.exiles-remote-label .rl-tool { display: block; font-size: 10.5px; font-weight: 500; color: #cbbd9f; }
.exiles-remote-label .rl-tool:empty { display: none; }
.exiles-remote-label.idle { opacity: 0.55; }
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface GhostSlot {
  key: string;
  group: THREE.Group;
  /** Materials we tinted (restored never: the ghost is ours alone). */
  mats: THREE.Material[];
  /** Footprint the cached ground height belongs to. */
  fx: number;
  fz: number;
  fw: number;
  fh: number;
  terrainRev: number;
  y: number;
  valid: boolean | null;
}

interface Entry {
  peer: string;
  color: string;
  readonly tint: THREE.Color;
  readonly marker: THREE.Group;
  readonly ring: THREE.Mesh;
  readonly bob: THREE.Group;
  readonly ringMat: THREE.MeshBasicMaterial;
  readonly pinMat: THREE.MeshLambertMaterial;
  readonly flagMat: THREE.MeshLambertMaterial;
  /** Displayed (smoothed) and target positions. */
  x: number;
  z: number;
  tx: number;
  tz: number;
  hasCursor: boolean;
  shown: boolean;
  phase: number;
  idle: boolean;
  ghost: GhostSlot | null;
  ghostTarget: PlayerInfo['ghost'];
  // DOM label
  readonly label: HTMLDivElement | null;
  readonly nameEl: HTMLSpanElement | null;
  readonly toolEl: HTMLSpanElement | null;
  name: string;
  tool: string;
  labelShown: boolean;
  px: number;
  py: number;
  seen: number;
}

export class RemotePlayersRenderer implements SubRenderer {
  private game: Game;
  private readonly root = new THREE.Group();
  private readonly layer: HTMLDivElement | null = null;
  private source: PlayersSource | null = null;
  private readonly entries = new Map<string, Entry>();
  private pollIn = 0;
  private stamp = 0;
  private time = 0;
  private viewW = 1;
  private viewH = 1;
  private warned = false;
  private disposed = false;

  // shared geometries (disposed with the renderer)
  private readonly ringGeo = new THREE.RingGeometry(0.34, 0.5, 28);
  private readonly dotGeo = new THREE.CircleGeometry(0.12, 12);
  private readonly poleGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6);
  private readonly headGeo = new THREE.SphereGeometry(0.11, 10, 8);
  private readonly flagGeo: THREE.BufferGeometry;

  // scratch
  private readonly v = new THREE.Vector3();

  constructor(scene: THREE.Scene, game: Game, opts: { container?: HTMLElement | null } = {}) {
    this.game = game;
    this.root.name = 'remote-players';
    this.root.renderOrder = RENDER_ORDER;
    scene.add(this.root);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.dotGeo.rotateX(-Math.PI / 2);
    this.poleGeo.translate(0, 0.55, 0);
    this.headGeo.translate(0, 1.14, 0);
    // pennant: a triangle hanging off the top of the pole
    const flag = new THREE.BufferGeometry();
    flag.setAttribute('position', new THREE.Float32BufferAttribute([0.03, 1.08, 0, 0.03, 0.78, 0, 0.42, 0.93, 0], 3));
    flag.computeVertexNormals();
    this.flagGeo = flag;
    if (typeof document !== 'undefined' && opts.container) {
      ensureStyle();
      const layer = document.createElement('div');
      layer.className = 'exiles-remote-labels';
      layer.setAttribute('aria-hidden', 'true');
      opts.container.appendChild(layer);
      this.layer = layer;
    }
  }

  /** Where the players come from (main.ts: `() => app.net.players()`); null hides everyone. */
  setSource(fn: PlayersSource | null): void {
    this.source = fn;
    this.pollIn = 0;
  }

  setGame(game: Game): void {
    this.game = game;
    // ghost ground heights belong to the old terrain
    for (const e of this.entries.values()) this.dropGhost(e);
  }

  update(ctx: FrameContext): void {
    if (this.disposed) return;
    const dt = ctx.realDt;
    this.time += dt;
    this.pollIn -= dt;
    if (this.pollIn <= 0) {
      this.pollIn = POLL_INTERVAL;
      this.poll();
    }
    if (this.entries.size === 0) return;
    const st = this.game.state;
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const scale = Math.max(0.8, Math.min(3.2, ctx.cameraDistance / 34));
    const k = 1 - Math.exp(-FOLLOW_RATE * Math.min(dt, 0.1));
    for (const e of this.entries.values()) {
      // ---- marker ----
      if (e.hasCursor) {
        if (!e.shown) {
          e.x = e.tx;
          e.z = e.tz;
        } else {
          e.x += (e.tx - e.x) * k;
          e.z += (e.tz - e.z) * k;
        }
        const y = Math.max(WATER_LEVEL, heightAt(st, e.x, e.z));
        e.marker.visible = true;
        e.shown = true;
        e.marker.position.set(e.x, y + 0.08, e.z);
        e.marker.scale.setScalar(scale);
        const t = this.time * 2.6 + e.phase;
        e.bob.position.y = 0.08 + Math.sin(t) * 0.07;
        e.bob.rotation.y = Math.sin(t * 0.5) * 0.35;
        const pulse = 1 + Math.sin(t * 1.3) * 0.08;
        e.ring.scale.set(pulse, 1, pulse);
        e.ringMat.opacity = e.idle ? 0.3 : 0.62;
        this.placeLabel(e, cam, e.x, y + 1.45 * scale + 0.25, e.z);
      } else {
        e.shown = false;
        e.marker.visible = false;
        this.hideLabel(e);
      }
      // ---- ghost ----
      this.updateGhost(e, st);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of this.entries.values()) this.destroy(e);
    this.entries.clear();
    this.root.removeFromParent();
    this.ringGeo.dispose();
    this.dotGeo.dispose();
    this.poleGeo.dispose();
    this.headGeo.dispose();
    this.flagGeo.dispose();
    this.layer?.remove();
  }

  // ---------------------------------------------------------------------------------------------

  private poll(): void {
    let list: readonly PlayerInfo[] = [];
    try {
      list = this.source ? this.source() : [];
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[render] remote players source failed', err);
      }
      list = [];
    }
    if (this.layer && typeof window !== 'undefined') {
      // the canvas container is fixed to the viewport: window size needs no layout read (no forced reflow)
      this.viewW = window.innerWidth || 1;
      this.viewH = window.innerHeight || 1;
    }
    const st = this.game.state;
    const stamp = ++this.stamp;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.isMe) continue;
      let e = this.entries.get(p.peer);
      if (!e) {
        e = this.create(p);
        this.entries.set(p.peer, e);
      }
      e.seen = stamp;
      if (p.color !== e.color) this.recolor(e, p.color);
      // presence is untrusted peer data: ignore non-finite values and keep everything on the map
      const c = p.cursor;
      if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        e.tx = Math.max(0, Math.min(st.W, c[0]));
        e.tz = Math.max(0, Math.min(st.H, c[1]));
        e.hasCursor = true;
      } else e.hasCursor = false;
      e.idle = p.idleMs > IDLE_MS;
      e.ghostTarget = saneGhost(p.ghost, st.W, st.H);
      this.setLabelText(e, p.name, p.tool);
    }
    for (const [peer, e] of this.entries) {
      if (e.seen === stamp) continue;
      this.destroy(e);
      this.entries.delete(peer);
    }
  }

  private create(p: PlayerInfo): Entry {
    const tint = new THREE.Color();
    safeColor(tint, p.color);
    const ringMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    const pinMat = new THREE.MeshLambertMaterial({ color: 0x3a2c1c, emissive: tint.clone().multiplyScalar(0.25) });
    const flagMat = new THREE.MeshLambertMaterial({ color: tint, emissive: tint.clone().multiplyScalar(0.45), side: THREE.DoubleSide });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    const dot = new THREE.Mesh(this.dotGeo, ringMat);
    const bob = new THREE.Group();
    const pole = new THREE.Mesh(this.poleGeo, pinMat);
    const head = new THREE.Mesh(this.headGeo, flagMat);
    const flag = new THREE.Mesh(this.flagGeo, flagMat);
    bob.add(pole, head, flag);
    const marker = new THREE.Group();
    marker.name = `remote-player:${p.peer}`;
    marker.add(ring, dot, bob);
    marker.visible = false;
    marker.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.renderOrder = RENDER_ORDER;
      o.frustumCulled = false;
    });
    this.root.add(marker);

    let label: HTMLDivElement | null = null;
    let nameEl: HTMLSpanElement | null = null;
    let toolEl: HTMLSpanElement | null = null;
    if (this.layer) {
      label = document.createElement('div');
      label.className = 'exiles-remote-label';
      nameEl = document.createElement('span');
      nameEl.className = 'rl-name';
      toolEl = document.createElement('span');
      toolEl.className = 'rl-tool';
      label.append(nameEl, toolEl);
      label.style.setProperty('--pc', p.color);
      this.layer.appendChild(label);
    }
    return {
      peer: p.peer, color: p.color, tint, marker, ring, bob, ringMat, pinMat, flagMat,
      x: 0, z: 0, tx: 0, tz: 0, hasCursor: false, shown: false, phase: hashPhase(p.peer), idle: false,
      ghost: null, ghostTarget: null,
      label, nameEl, toolEl, name: '', tool: '', labelShown: false, px: NaN, py: NaN, seen: 0,
    };
  }

  private recolor(e: Entry, color: string): void {
    e.color = color;
    safeColor(e.tint, color);
    e.ringMat.color.copy(e.tint);
    e.pinMat.emissive.copy(e.tint).multiplyScalar(0.25);
    e.flagMat.color.copy(e.tint);
    e.flagMat.emissive.copy(e.tint).multiplyScalar(0.45);
    e.label?.style.setProperty('--pc', color);
    if (e.ghost) e.ghost.valid = null; // re-tint
  }

  private destroy(e: Entry): void {
    this.dropGhost(e);
    this.root.remove(e.marker);
    e.ringMat.dispose();
    e.pinMat.dispose();
    e.flagMat.dispose();
    e.label?.remove();
  }

  // ---- labels -----------------------------------------------------------------------------------

  private setLabelText(e: Entry, name: string, tool: string): void {
    if (!e.label) return;
    if (name !== e.name) {
      e.name = name;
      e.nameEl!.textContent = name;
    }
    const t = tool && tool !== 'Selecting' ? tool : '';
    if (t !== e.tool) {
      e.tool = t;
      e.toolEl!.textContent = t;
    }
    if (e.label.classList.contains('idle') !== e.idle) e.label.classList.toggle('idle', e.idle);
  }

  private placeLabel(e: Entry, cam: THREE.PerspectiveCamera, wx: number, wy: number, wz: number): void {
    const el = e.label;
    if (!el) return;
    const v = this.v.set(wx, wy, wz).applyMatrix4(cam.matrixWorldInverse);
    if (v.z >= 0) {
      this.hideLabel(e);
      return;
    }
    v.applyMatrix4(cam.projectionMatrix);
    if (v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.1 || v.z > 1) {
      this.hideLabel(e);
      return;
    }
    const x = Math.round((v.x + 1) * 0.5 * this.viewW);
    const y = Math.round((1 - v.y) * 0.5 * this.viewH);
    if (!e.labelShown) {
      e.labelShown = true;
      el.style.display = 'block';
    }
    if (x === e.px && y === e.py) return;
    e.px = x;
    e.py = y;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
  }

  private hideLabel(e: Entry): void {
    if (!e.labelShown || !e.label) return;
    e.labelShown = false;
    e.label.style.display = 'none';
    e.px = NaN;
  }

  // ---- ghosts -----------------------------------------------------------------------------------

  private updateGhost(e: Entry, st: GameState): void {
    const g = e.ghostTarget;
    if (!g || !e.hasCursor) {
      if (e.ghost) e.ghost.group.visible = false;
      return;
    }
    const odd = g.rot % 2 === 1;
    const mw = odd ? g.h : g.w;
    const mh = odd ? g.w : g.h;
    const key = `${g.type}:${mw}x${mh}`;
    if (!e.ghost || e.ghost.key !== key) {
      this.dropGhost(e);
      e.ghost = this.makeGhost(g.type, mw, mh, key);
      if (!e.ghost) return;
    }
    const slot = e.ghost;
    if (slot.fx !== g.x || slot.fz !== g.z || slot.fw !== g.w || slot.fh !== g.h || slot.terrainRev !== st.rev.terrain) {
      slot.fx = g.x;
      slot.fz = g.z;
      slot.fw = g.w;
      slot.fh = g.h;
      slot.terrainRev = st.rev.terrain;
      slot.y = footprintGroundY(st, g.x, g.z, g.w, g.h);
    }
    if (slot.valid !== g.valid) {
      slot.valid = g.valid;
      for (const m of slot.mats) tintGhostMaterial(m, e.tint, g.valid);
    }
    const grp = slot.group;
    grp.visible = true;
    grp.position.set(g.x + g.w / 2, slot.y, g.z + g.h / 2);
    grp.rotation.set(0, rotationAngle(g.rot), 0);
  }

  private makeGhost(type: BuildingType, mw: number, mh: number, key: string): GhostSlot | null {
    let group: THREE.Group;
    try {
      group = createGhostModel(type, mw, mh);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[render] remote ghost failed', err);
      }
      return null;
    }
    const mats: THREE.Material[] = [];
    group.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.renderOrder = RENDER_ORDER;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) if (m && !mats.includes(m)) mats.push(m);
    });
    group.visible = false;
    this.root.add(group);
    return { key, group, mats, fx: NaN, fz: NaN, fw: 0, fh: 0, terrainRev: -1, y: 0, valid: null };
  }

  private dropGhost(e: Entry): void {
    const slot = e.ghost;
    if (!slot) return;
    e.ghost = null;
    this.root.remove(slot.group);
    try {
      disposeModel(slot.group);
    } catch {
      /* shared geometry is never ours to dispose; dropping the reference is enough */
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** A ghost from another peer's presence, or null when it is malformed (unknown type, absurd size, off the map). */
function saneGhost(g: PlayerInfo['ghost'], W: number, H: number): PlayerInfo['ghost'] {
  if (!g || !knownBuildingType(g.type)) return null;
  const ints = Number.isInteger(g.x) && Number.isInteger(g.z) && Number.isInteger(g.w) && Number.isInteger(g.h);
  if (!ints || g.w < 1 || g.h < 1 || g.w > 64 || g.h > 64) return null;
  if (g.x < 0 || g.z < 0 || g.x + g.w > W || g.z + g.h > H) return null;
  if (!(g.rot === 0 || g.rot === 1 || g.rot === 2 || g.rot === 3)) return null;
  return g;
}

/** Guard against a ghost type this build does not know (e.g. another peer on a newer version). */
function knownBuildingType(type: string): type is BuildingType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(BUILDINGS, type);
}

/** Tint a ghost material in the player's colour (valid: brighter & more opaque). */
function tintGhostMaterial(m: THREE.Material, tint: THREE.Color, valid: boolean): void {
  const mat = m as THREE.MeshLambertMaterial;
  if (mat.color) mat.color.copy(tint).lerp(WHITE, valid ? 0.25 : 0);
  if (mat.emissive) mat.emissive.copy(tint).multiplyScalar(valid ? 0.32 : 0.12);
  mat.transparent = true;
  mat.opacity = valid ? 0.46 : 0.26;
  mat.depthWrite = false;
}

const WHITE = new THREE.Color(1, 1, 1);

/** Average corner height of a footprint (flattened on placement), never below the water surface. */
export function footprintGroundY(st: GameState, x: number, z: number, w: number, h: number): number {
  let sum = 0;
  let n = 0;
  for (let zz = z; zz <= z + h; zz++) {
    for (let xx = x; xx <= x + w; xx++) {
      sum += cornerHeight(st, xx, zz);
      n++;
    }
  }
  return Math.max(n > 0 ? sum / n : 0, WATER_LEVEL);
}

/** Stable 0..2π phase from a peer label (markers don't bob in unison). */
export function hashPhase(s: string): number {
  let hsh = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hsh ^= s.charCodeAt(i);
    hsh = Math.imul(hsh, 16777619);
  }
  return ((hsh >>> 0) / 4294967296) * Math.PI * 2;
}

/** THREE.Color.set with a fallback for strings it cannot parse. */
function safeColor(out: THREE.Color, css: string): void {
  try {
    out.set(css);
  } catch {
    out.set(0xe6c47c);
  }
}
