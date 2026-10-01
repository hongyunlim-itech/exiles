/**
 * Particles: chimney smoke, fire & embers (+ flickering point lights), snowfall, rain, tornado funnel & debris,
 * dust puffs. Anchors come from BuildingRenderer.
 * OWNER: render-entities agent.
 *
 * - Two CPU particle pools (normal-blended smoke/dust/chips, additive flames/embers), preallocated, one draw each.
 * - Rain & snow are GPU-animated around the camera (no CPU per frame).
 * - A fixed pool of PointLights flickers at the fires nearest to the camera focus (the light count never changes at
 *   runtime so no shader recompiles; 'low' quality hides them).
 * - Dust bursts on construction completion / demolition and small chips/dust/splashes on work sound cues.
 * Everything scales with the quality setting; no per-frame allocations.
 */
import * as THREE from 'three';
import type { Game } from '../sim/game';
import type { BuildingRenderer } from './buildings';
import { entityGroundY } from './entities/ground';
import { clamp01, lerp } from './entities/math';
import { ParticlePool } from './entities/particles';
import { Precipitation } from './entities/precipitation';
import { Tornado } from './entities/tornado';
import type { EmitterAnchor, FrameContext, SubRenderer } from './types';

const SMOKE_CAP = 2600;
const FLAME_CAP = 1400;
const GLOW_CAP = 1200;
const RAIN_CAP = 4200;
const SNOW_CAP = 3600;
const MAX_LIGHTS = 3;
/** Chimneys/fires further than this from the camera focus emit nothing. */
const EMIT_RANGE = 95;

const EV_COMPLETE = 1;
const EV_REMOVED = 2;
const EV_CHOP = 3;
const EV_DIG = 4;
const EV_SPLASH = 5;
const EV_HAMMER = 6;
const EV_MAX = 64;

const QUALITY_MUL = { low: 0.35, medium: 0.65, high: 1 } as const;

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class EffectsRenderer implements SubRenderer {
  private game: Game;
  private readonly scene: THREE.Scene;
  private readonly buildings: BuildingRenderer;
  private readonly root = new THREE.Group();
  private readonly smoke: ParticlePool;
  private readonly flame: ParticlePool;
  private readonly glow: ParticlePool;
  private readonly rain: Precipitation;
  private readonly snowfall: Precipitation;
  private readonly precip: Precipitation[];
  private readonly tornado: Tornado;
  private readonly lights: THREE.PointLight[] = [];
  private lightCount = MAX_LIGHTS;
  private tornadoPresence = 0;
  private tornadoX = 0;
  private tornadoZ = 0;
  private rainAmt = 0;
  private snowAmt = 0;
  private anchorWarned = false;
  private unsub: (() => void)[] = [];

  // Building footprints (for fire spread & dust bursts after removal).
  private readonly footprints = new Map<number, Float32Array>();
  private footprintRev = -1;

  // Pending one-shot events (type, x, z, w, h).
  private readonly events = new Float32Array(EV_MAX * 5);
  private eventCount = 0;

  // Fire anchors per building this frame.
  private readonly fireCounts = new Map<number, number>();
  // Fire light assignment scratch.
  private readonly fireDist = new Float32Array(MAX_LIGHTS);
  private readonly fireIdx = new Int32Array(MAX_LIGHTS);

  private readonly groundAt = (x: number, z: number): number => entityGroundY(this.game.state, x, z);
  private readonly camFwd = new THREE.Vector3();

  constructor(scene: THREE.Scene, game: Game, buildings: BuildingRenderer) {
    this.scene = scene;
    this.game = game;
    this.buildings = buildings;
    this.root.name = 'effects';
    scene.add(this.root);
    this.smoke = new ParticlePool({ capacity: SMOKE_CAP, additive: false, softness: 0.55, lit: true, renderOrder: 5 });
    this.flame = new ParticlePool({
      capacity: FLAME_CAP, additive: false, softness: 0.45, lit: false, renderOrder: 6, stretch: 1.9, lumpy: false,
      randomRotation: false, toneMapped: false,
    });
    this.glow = new ParticlePool({
      capacity: GLOW_CAP, additive: true, softness: 0.9, lit: false, renderOrder: 7, stretch: 1.3, lumpy: false,
      randomRotation: false, toneMapped: false,
    });
    this.rain = new Precipitation('rain', RAIN_CAP);
    this.snowfall = new Precipitation('snow', SNOW_CAP);
    this.precip = [this.rain, this.snowfall];
    this.tornado = new Tornado();
    this.root.add(this.smoke.mesh, this.flame.mesh, this.glow.mesh, this.rain.mesh, this.snowfall.mesh, this.tornado.group);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xff8a3a, 0, 11, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.root.add(l);
    }
    this.setGame(game);
  }

  setGame(game: Game): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.game = game;
    this.smoke.clear();
    this.flame.clear();
    this.glow.clear();
    this.eventCount = 0;
    this.footprints.clear();
    this.footprintRev = -1;
    this.tornadoPresence = 0;
    const ev = game.events;
    if (ev && typeof ev.on === 'function') {
      this.unsub.push(
        ev.on('buildingCompleted', (e) => this.queueBuildingEvent(EV_COMPLETE, e.id)),
        ev.on('buildingRemoved', (e) => this.queueBuildingEvent(EV_REMOVED, e.id)),
        ev.on('sound', (e) => {
          const t = e.cue === 'chop' ? EV_CHOP : e.cue === 'dig' ? EV_DIG : e.cue === 'splash' ? EV_SPLASH : e.cue === 'hammer' ? EV_HAMMER : 0;
          if (t) this.queue(t, e.x, e.z, 0, 0);
        }),
      );
    }
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    const dt = Math.min(ctx.realDt, 0.1);
    const q = QUALITY_MUL[ctx.quality] ?? 1;
    // cap live particles per tier (transparent overdraw is expensive on integrated GPUs)
    this.smoke.limit = Math.round(SMOKE_CAP * q);
    this.flame.limit = Math.round(FLAME_CAP * q);
    this.glow.limit = Math.round(GLOW_CAP * q);
    const light = 0.22 + 0.78 * clamp01(ctx.daylight);
    this.smoke.uniforms.uLight.value = light;
    const w = s.weather;
    const wind = clamp01(w.windStrength);
    const windX = Math.cos(w.windDir) * (0.3 + 1.6 * wind);
    const windZ = Math.sin(w.windDir) * (0.3 + 1.6 * wind);

    if (s.rev.buildings !== this.footprintRev) this.refreshFootprints();

    // ---- chimney smoke ----
    const chimneys = this.safeAnchors(true);
    const fx = ctx.focusX;
    const fz = ctx.focusZ;
    const range = Math.max(EMIT_RANGE, ctx.cameraDistance * 1.3);
    const range2 = range * range;
    if (chimneys) {
      for (let i = 0; i < chimneys.length; i++) {
        const a = chimneys[i];
        const dx = a.x - fx;
        const dz = a.z - fz;
        if (dx * dx + dz * dz > range2) continue;
        const rate = 2.6 * clamp01(a.strength) * q;
        let n = Math.floor(rate * dt + Math.random());
        while (n-- > 0) {
          const g = rnd(0.7, 0.86);
          this.smoke.emit(
            a.x + rnd(-0.05, 0.05), a.y + 0.05, a.z + rnd(-0.05, 0.05),
            rnd(-0.08, 0.08), rnd(0.45, 0.7), rnd(-0.08, 0.08),
            rnd(4.5, 6.5), rnd(0.14, 0.22), rnd(0.85, 1.25), rnd(0.42, 0.58),
            g, g, g * 1.02, g * 0.92, g * 0.92, g * 0.95,
            0.15, 0.02, 0.35, rnd(-0.3, 0.3),
          );
        }
      }
    }

    // ---- fires ----
    const fires = this.safeAnchors(false);
    for (let k = 0; k < MAX_LIGHTS; k++) {
      this.fireDist[k] = Infinity;
      this.fireIdx[k] = -1;
    }
    if (fires) {
      // BuildingRenderer publishes several anchors for big fires; share the emission between them.
      this.fireCounts.clear();
      for (let i = 0; i < fires.length; i++) {
        const id = fires[i].buildingId;
        this.fireCounts.set(id, (this.fireCounts.get(id) ?? 0) + 1);
      }
      for (let i = 0; i < fires.length; i++) {
        const a = fires[i];
        const dx = a.x - fx;
        const dz = a.z - fz;
        const d2 = dx * dx + dz * dz;
        this.insertFireLight(i, d2, fires);
        if (d2 > range2) continue;
        this.emitFire(a, dt, q, s, 1 / (this.fireCounts.get(a.buildingId) ?? 1));
      }
    }
    this.updateLights(fires, ctx);

    // ---- tornado ----
    const tor = s.tornado;
    if (tor) {
      this.tornadoX = tor.x;
      this.tornadoZ = tor.z;
      const lifeFade = tor.life > 0 ? clamp01(tor.life / 2.5) : 1;
      this.tornadoPresence = Math.min(lifeFade, this.tornadoPresence + dt / 2);
    } else {
      this.tornadoPresence = Math.max(0, this.tornadoPresence - dt / 1.5);
    }
    if (this.tornadoPresence > 0.01) {
      const ty = entityGroundY(s, this.tornadoX, this.tornadoZ);
      this.tornado.update(ctx.realTime, this.tornadoX, ty - 0.2, this.tornadoZ, this.tornadoPresence, light);
      let n = Math.floor(28 * q * this.tornadoPresence * dt + Math.random());
      while (n-- > 0) {
        const ang = Math.random() * Math.PI * 2;
        const r = rnd(0.4, 2.2);
        const c = rnd(0.3, 0.4);
        this.smoke.emit(
          this.tornadoX + Math.cos(ang) * r, ty + 0.1, this.tornadoZ + Math.sin(ang) * r,
          -Math.sin(ang) * 3.5 + Math.cos(ang) * 1.2, rnd(0.8, 2.2), Math.cos(ang) * 3.5 + Math.sin(ang) * 1.2,
          rnd(1.2, 2.4), rnd(0.5, 0.8), rnd(1.8, 2.8), rnd(0.35, 0.55),
          c, c * 0.92, c * 0.82, c * 1.05, c, c * 0.9,
          0.8, 0.4, 0.1, rnd(-1, 1),
        );
      }
    } else {
      this.tornado.update(ctx.realTime, 0, 0, 0, 0, light);
    }

    // ---- one-shot events ----
    this.flushEvents(ctx, q);

    // ---- precipitation ----
    this.updatePrecipitation(ctx, q, windX, windZ);

    // ---- integrate pools ----
    this.smoke.update(dt, windX, windZ);
    this.flame.update(dt, windX * 0.4, windZ * 0.4);
    this.glow.update(dt, windX * 0.6, windZ * 0.6);
    this.smoke.killBelow(this.groundAt);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.smoke.dispose();
    this.flame.dispose();
    this.glow.dispose();
    this.rain.dispose();
    this.snowfall.dispose();
    this.tornado.dispose();
    for (const l of this.lights) l.dispose();
    this.scene.remove(this.root);
  }

  /** Alive particle count (debug). */
  get particleCount(): number {
    return this.smoke.alive + this.flame.alive + this.glow.alive;
  }

  // ---------------------------------------------------------------------------------------------

  private safeAnchors(chimneys: boolean): EmitterAnchor[] | null {
    try {
      return chimneys ? this.buildings.getChimneys() : this.buildings.getFires();
    } catch (err) {
      if (!this.anchorWarned) {
        this.anchorWarned = true;
        console.warn('[effects] emitter anchors unavailable', err);
      }
      return null;
    }
  }

  private refreshFootprints(): void {
    const s = this.game.state;
    this.footprintRev = s.rev.buildings;
    // Keep entries of removed buildings for one refresh so removal events can still find them.
    const alive = new Set<number>();
    for (const b of s.buildings) {
      alive.add(b.id);
      let f = this.footprints.get(b.id);
      if (!f) {
        f = new Float32Array(4);
        this.footprints.set(b.id, f);
      }
      f[0] = b.x + b.w / 2;
      f[1] = b.z + b.h / 2;
      f[2] = b.w;
      f[3] = b.h;
    }
    if (this.footprints.size > alive.size + 32) {
      for (const id of this.footprints.keys()) if (!alive.has(id)) this.footprints.delete(id);
    }
  }

  private queueBuildingEvent(type: number, id: number): void {
    let f = this.footprints.get(id);
    if (!f) {
      const b = this.game.state.buildings.find((x) => x.id === id);
      if (!b) return;
      f = new Float32Array([b.x + b.w / 2, b.z + b.h / 2, b.w, b.h]);
    }
    this.queue(type, f[0], f[1], f[2], f[3]);
  }

  private queue(type: number, x: number, z: number, w: number, h: number): void {
    if (this.eventCount >= EV_MAX) return;
    const o = this.eventCount++ * 5;
    this.events[o] = type;
    this.events[o + 1] = x;
    this.events[o + 2] = z;
    this.events[o + 3] = w;
    this.events[o + 4] = h;
  }

  private flushEvents(ctx: FrameContext, q: number): void {
    const s = this.game.state;
    const range2 = Math.max(70, ctx.cameraDistance * 1.3) ** 2;
    for (let e = 0; e < this.eventCount; e++) {
      const o = e * 5;
      const type = this.events[o];
      const x = this.events[o + 1];
      const z = this.events[o + 2];
      const w = this.events[o + 3];
      const h = this.events[o + 4];
      const dx = x - ctx.focusX;
      const dz = z - ctx.focusZ;
      if (dx * dx + dz * dz > range2) continue;
      const y = entityGroundY(s, x, z);
      if (type === EV_COMPLETE || type === EV_REMOVED) {
        const n = Math.floor((type === EV_REMOVED ? 46 : 26) * q * Math.min(2, (w * h) / 9 + 0.5));
        for (let i = 0; i < n; i++) {
          const px = x + rnd(-0.5, 0.5) * w;
          const pz = z + rnd(-0.5, 0.5) * h;
          const c = rnd(0.55, 0.68);
          this.smoke.emit(
            px, entityGroundY(s, px, pz) + rnd(0.05, 0.4), pz,
            (px - x) * 0.4, rnd(0.2, 0.7), (pz - z) * 0.4,
            rnd(1.4, 2.6), rnd(0.3, 0.5), rnd(1.0, 1.8), rnd(0.35, 0.55),
            c, c * 0.93, c * 0.82, c * 1.05, c, c * 0.9,
            1.2, 0.08, 0.2, rnd(-0.5, 0.5),
          );
        }
      } else if (type === EV_CHOP) {
        for (let i = 0; i < 5; i++) {
          this.smoke.emit(
            x + rnd(-0.2, 0.2), y + rnd(0.2, 0.45), z + rnd(-0.2, 0.2),
            rnd(-1, 1), rnd(1.2, 2.2), rnd(-1, 1),
            rnd(0.6, 1.0), 0.05, 0.04, 1,
            0.62, 0.42, 0.22, 0.5, 0.33, 0.18,
            0.4, -7, 0, rnd(-8, 8),
          );
        }
      } else if (type === EV_DIG) {
        for (let i = 0; i < 3; i++) {
          this.smoke.emit(
            x + rnd(-0.25, 0.25), y + 0.1, z + rnd(-0.25, 0.25),
            rnd(-0.3, 0.3), rnd(0.3, 0.6), rnd(-0.3, 0.3),
            rnd(1.0, 1.6), 0.15, 0.5, 0.4,
            0.62, 0.6, 0.56, 0.7, 0.68, 0.64,
            1.5, 0.05, 0.2, 0,
          );
        }
      } else if (type === EV_SPLASH) {
        for (let i = 0; i < 6; i++) {
          this.glow.emit(
            x + rnd(-0.2, 0.2), Math.max(y, 0.02), z + rnd(-0.2, 0.2),
            rnd(-0.6, 0.6), rnd(1.2, 2.0), rnd(-0.6, 0.6),
            rnd(0.4, 0.7), 0.06, 0.04, 0.5,
            0.55, 0.62, 0.7, 0.4, 0.45, 0.5,
            0.2, -6, 0, 0,
          );
        }
      } else if (type === EV_HAMMER) {
        this.smoke.emit(
          x + rnd(-0.3, 0.3), y + rnd(0.3, 0.8), z + rnd(-0.3, 0.3),
          rnd(-0.2, 0.2), rnd(0.2, 0.4), rnd(-0.2, 0.2),
          rnd(0.8, 1.2), 0.1, 0.35, 0.3,
          0.7, 0.62, 0.5, 0.75, 0.7, 0.62,
          1.5, 0.05, 0.2, 0,
        );
      }
    }
    this.eventCount = 0;
  }

  private emitFire(a: EmitterAnchor, dt: number, q: number, s: Game['state'], share: number): void {
    const strength = clamp01(a.strength);
    if (strength <= 0) return;
    const f = this.footprints.get(a.buildingId);
    const w = f ? f[2] : 2;
    const h = f ? f[3] : 2;
    const cx = f ? f[0] : a.x;
    const cz = f ? f[1] : a.z;
    const area = Math.min(4, Math.max(1, (w * h) / 9)) * share;
    const top = Math.max(0.6, a.y - entityGroundY(s, a.x, a.z));
    const baseY = entityGroundY(s, cx, cz);
    const spread = 0.35 + 0.65 * strength;

    // Flames: licking up the walls (just outside the footprint edge) and over the roof — particles inside the
    // building volume would be hidden by its walls.
    let n = Math.floor(70 * strength * area * q * dt + Math.random());
    while (n-- > 0) {
      let px: number;
      let pz: number;
      let py: number;
      const pick = Math.random();
      if (pick < 0.35 && share < 1) {
        // around this anchor (roof fire point)
        px = a.x + rnd(-0.45, 0.45);
        pz = a.z + rnd(-0.45, 0.45);
        py = a.y + rnd(-0.35, 0.2);
      } else if (pick < 0.7) {
        const side = Math.floor(Math.random() * 4);
        const u = rnd(-0.5, 0.5) * spread;
        px = cx + (side < 2 ? u * w : (side === 2 ? -0.5 : 0.5) * w + rnd(-0.05, 0.12) * (side === 2 ? -1 : 1));
        pz = cz + (side >= 2 ? u * h : (side === 0 ? -0.5 : 0.5) * h + rnd(-0.05, 0.12) * (side === 0 ? -1 : 1));
        py = baseY + rnd(0.1, 0.75) * top;
      } else {
        px = cx + rnd(-0.32, 0.32) * w * spread;
        pz = cz + rnd(-0.32, 0.32) * h * spread;
        py = baseY + top * rnd(0.72, 1.02);
      }
      const sz = rnd(0.35, 0.7) * (0.6 + 0.6 * strength);
      const hot = Math.random();
      this.flame.emit(
        px, py, pz,
        rnd(-0.12, 0.12), rnd(1.0, 1.8), rnd(-0.12, 0.12),
        rnd(0.45, 0.8), sz, sz * 0.25, rnd(0.8, 0.95),
        1.0, 0.5 + 0.3 * hot, 0.08 + 0.12 * hot, 0.72, 0.1, 0.02,
        0.6, 0.8, 0.25, 0,
      );
      // Soft additive glow halo around some flames.
      if (Math.random() < 0.25) {
        this.glow.emit(
          px, py + 0.1, pz,
          0, rnd(0.6, 1.0), 0,
          rnd(0.35, 0.6), sz * 2.2, sz * 1.2, 0.22,
          1.0, 0.45, 0.12, 0.6, 0.12, 0.02,
          0.5, 0.3, 0.2, 0,
        );
      }
    }
    // Embers.
    n = Math.floor(9 * strength * area * q * dt + Math.random());
    while (n-- > 0) {
      this.glow.emit(
        cx + rnd(-0.4, 0.4) * w, baseY + top * rnd(0.5, 1.1), cz + rnd(-0.4, 0.4) * h,
        rnd(-0.6, 0.6), rnd(1.6, 3.2), rnd(-0.6, 0.6),
        rnd(1.4, 2.8), 0.06, 0.035, 1,
        2.0, 0.9, 0.25, 1.4, 0.35, 0.06,
        0.5, -0.25, 0.5, 0,
      );
    }
    // Thick smoke.
    n = Math.floor(7 * strength * area * q * dt + Math.random());
    while (n-- > 0) {
      const c = rnd(0.07, 0.14);
      this.smoke.emit(
        cx + rnd(-0.35, 0.35) * w, baseY + top * rnd(0.9, 1.25), cz + rnd(-0.35, 0.35) * h,
        rnd(-0.15, 0.15), rnd(1.0, 1.6), rnd(-0.15, 0.15),
        rnd(4.5, 7), rnd(0.5, 0.8), rnd(2.2, 3.4), rnd(0.55, 0.75),
        c, c, c, c * 1.6, c * 1.55, c * 1.5,
        0.2, 0.05, 0.3, rnd(-0.4, 0.4),
      );
    }
  }

  private insertFireLight(i: number, d2: number, fires: EmitterAnchor[]): void {
    // One light per burning building (the anchor nearest to the camera focus).
    const bid = fires[i].buildingId;
    for (let k = 0; k < MAX_LIGHTS; k++) {
      const j = this.fireIdx[k];
      if (j >= 0 && fires[j].buildingId === bid) {
        if (d2 >= this.fireDist[k]) return;
        // Remove the farther anchor of the same building, then insert normally.
        for (let m = k; m < MAX_LIGHTS - 1; m++) {
          this.fireDist[m] = this.fireDist[m + 1];
          this.fireIdx[m] = this.fireIdx[m + 1];
        }
        this.fireDist[MAX_LIGHTS - 1] = Infinity;
        this.fireIdx[MAX_LIGHTS - 1] = -1;
        break;
      }
    }
    for (let k = 0; k < MAX_LIGHTS; k++) {
      if (d2 < this.fireDist[k]) {
        for (let m = MAX_LIGHTS - 1; m > k; m--) {
          this.fireDist[m] = this.fireDist[m - 1];
          this.fireIdx[m] = this.fireIdx[m - 1];
        }
        this.fireDist[k] = d2;
        this.fireIdx[k] = i;
        return;
      }
    }
  }

  private updateLights(fires: EmitterAnchor[] | null, ctx: FrameContext): void {
    // fire lights per tier: every lit fragment evaluates each visible point light (even at intensity 0), so the
    // medium tier (integrated GPUs) keeps only the nearest one
    const count = ctx.quality === 'high' ? MAX_LIGHTS : ctx.quality === 'medium' ? 1 : 0;
    if (count !== this.lightCount) {
      // Changes the scene light count (one-time shader recompile) — only on a quality change.
      this.lightCount = count;
      for (let k = 0; k < this.lights.length; k++) this.lights[k].visible = k < count;
    }
    const want = count > 0;
    const s = this.game.state;
    const t = ctx.realTime;
    for (let k = 0; k < MAX_LIGHTS; k++) {
      const l = this.lights[k];
      const idx = this.fireIdx[k];
      if (!fires || idx < 0 || !want || k >= count) {
        l.intensity = 0;
        continue;
      }
      const a = fires[idx];
      const f = this.footprints.get(a.buildingId);
      const cx = f ? f[0] : a.x;
      const cz = f ? f[1] : a.z;
      const baseY = entityGroundY(s, cx, cz);
      const strength = clamp01(a.strength);
      const flicker = 0.75 + 0.12 * Math.sin(t * 13.1 + k * 2) + 0.08 * Math.sin(t * 23.7 + k * 5) + 0.05 * Math.sin(t * 41.3);
      l.position.set(cx + Math.sin(t * 7 + k) * 0.08, baseY + lerp(0.8, Math.max(1.2, a.y - baseY), 0.6), cz + Math.cos(t * 9 + k) * 0.08);
      l.intensity = 14 * (0.35 + 0.65 * strength) * flicker;
      l.distance = 8 + 6 * strength;
    }
  }

  private updatePrecipitation(ctx: FrameContext, q: number, windX: number, windZ: number): void {
    const s = this.game.state;
    const w = s.weather;
    const dt = Math.min(ctx.realDt, 0.1);
    const intensity = clamp01(w.precipIntensity);
    const rainT = w.precipitation === 'rain' ? intensity : 0;
    const snowT = w.precipitation === 'snow' ? intensity : 0;
    this.rainAmt += (rainT - this.rainAmt) * Math.min(1, dt * 0.8);
    this.snowAmt += (snowT - this.snowAmt) * Math.min(1, dt * 0.8);
    const cam = ctx.camera;
    cam.getWorldDirection(this.camFwd);
    const d = Math.min(ctx.cameraDistance * 0.55, 26);
    const cx = cam.position.x + this.camFwd.x * d;
    const cy = cam.position.y + this.camFwd.y * d;
    const cz = cam.position.z + this.camFwd.z * d;
    const light = 0.45 + 0.55 * clamp01(ctx.daylight);
    const time = ctx.realTime % 1000;
    const box = Math.max(40, Math.min(70, ctx.cameraDistance * 1.1));
    for (let i = 0; i < this.precip.length; i++) {
      const p = this.precip[i];
      const amt = p === this.rain ? this.rainAmt : this.snowAmt;
      if (amt < 0.01) {
        p.setCount(0);
        continue;
      }
      const u = p.uniforms;
      u.uCenter.value.set(cx, cy, cz);
      u.uBox.value.set(box, 32, box);
      u.uTime.value = time;
      u.uWind.value.set(windX * (p === this.rain ? 1.2 : 0.9), windZ * (p === this.rain ? 1.2 : 0.9));
      u.uColor.value.setScalar(p === this.rain ? 0.62 * light : 0.95 * light);
      if (p === this.rain) u.uColor.value.b *= 1.08;
      // Keep flakes/streaks readable when zoomed out.
      const zoom = Math.max(1, ctx.cameraDistance / 40);
      u.uSize.value = p === this.rain ? 0.022 * zoom : 0.085 * Math.sqrt(zoom);
      p.setCount(p.capacity * amt * q);
    }
  }
}
