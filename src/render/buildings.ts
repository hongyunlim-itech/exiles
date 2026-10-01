/**
 * Syncs one procedural model per building (construction stages, ruins, fire glow, snow on roofs, stockpile piles,
 * merchant boat at the trading post, bridges on Road.Bridge tiles). Publishes chimney/fire anchors for effects.
 * OWNER: render-models agent.
 *
 * Structure (see src/render/models/runtime/*):
 *  - BuildingVisual per building (one merged mesh + state props), added/removed when rev.buildings changes,
 *    cheap per-frame updates (state, progress, fire, lights, highlight, graves).
 *  - PileLayer (instanced piles for stockpiles, market stalls, trading post, construction sites).
 *  - BridgeLayer (merged bridge mesh, rebuilt on rev.roads).
 *  - MerchantBoatLayer, SelectionRing.
 * Global shader uniforms (snow cover, night window glow, time) are updated once per frame.
 */
import * as THREE from 'three';
import type { Building } from '../core/types';
import type { Game } from '../sim/game';
import { BUILDINGS } from '../core/defs';
import { sharedPropMaterial, sharedUnlitMaterial, updateGlobalUniforms } from './models/material';
import { MerchantBoatLayer } from './models/runtime/boat';
import { BridgeLayer } from './models/runtime/bridges';
import { SelectionRing } from './models/runtime/highlight';
import { PileLayer } from './models/runtime/piles';
import { BuildingVisual } from './models/runtime/visual';
import { shadowCasterCull } from './scene/shadowCasters';
import type { FrameContext, SubRenderer } from './types';
import type { EmitterAnchor } from './types';

/** Seconds between terrain-driven re-placements (flattening bumps rev.terrain often while placing). */
const TERRAIN_REFIT_INTERVAL = 0.4;

const _v = new THREE.Vector3();

function nightFactor(daylight: number): number {
  const t = Math.max(0, Math.min(1, (0.62 - daylight) / 0.42));
  return t * t * (3 - 2 * t);
}

export class BuildingRenderer implements SubRenderer {
  private readonly scene: THREE.Scene;
  private game: Game;
  /** Root of everything this renderer draws. */
  readonly root = new THREE.Group();
  private readonly buildingsGroup = new THREE.Group();
  private readonly visuals = new Map<number, BuildingVisual>();
  private readonly piles: PileLayer;
  private readonly bridges: BridgeLayer;
  private readonly boat: MerchantBoatLayer;
  private readonly ring: SelectionRing;
  private seenBuildingsRev = -1;
  private seenTerrainRev = -1;
  private terrainDirty = false;
  private lastTerrainFit = -1e9;
  private syncStamp = 0;
  private highlightId: number | null = null;
  private time = 0;
  private quality: FrameContext['quality'] | null = null;

  private readonly chimneyAnchors: EmitterAnchor[] = [];
  private readonly fireAnchors: EmitterAnchor[] = [];
  private readonly anchorPool: EmitterAnchor[] = [];
  private poolUsed = 0;

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.root.name = 'buildings-root';
    this.buildingsGroup.name = 'buildings';
    this.root.add(this.buildingsGroup);
    this.piles = new PileLayer(sharedPropMaterial());
    this.bridges = new BridgeLayer(sharedUnlitMaterial());
    this.boat = new MerchantBoatLayer(sharedPropMaterial());
    this.ring = new SelectionRing();
    this.root.add(this.piles.group, this.bridges.group, this.boat.mesh, this.ring.mesh);
    scene.add(this.root);
    this.setGame(game);
  }

  setGame(game: Game): void {
    this.game = game;
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
    this.seenBuildingsRev = -1;
    this.seenTerrainRev = -1;
    this.terrainDirty = false;
    this.highlightId = null;
    this.piles.reset();
    this.bridges.reset();
    this.boat.reset();
    this.ring.clear();
    this.chimneyAnchors.length = 0;
    this.fireAnchors.length = 0;
    if (game?.state) {
      this.sync();
      this.seenTerrainRev = game.state.rev.terrain;
    }
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    this.time = ctx.realTime;
    updateGlobalUniforms(ctx.snow, nightFactor(ctx.daylight), ctx.realTime);
    if (ctx.quality !== this.quality) {
      this.quality = ctx.quality;
      this.piles.setShadows(ctx.quality !== 'low');
    }

    if (s.rev.buildings !== this.seenBuildingsRev || s.buildings.length !== this.visuals.size) this.sync();
    if (s.rev.terrain !== this.seenTerrainRev) {
      this.seenTerrainRev = s.rev.terrain;
      this.terrainDirty = true;
    }
    if (this.terrainDirty && ctx.realTime - this.lastTerrainFit >= TERRAIN_REFIT_INTERVAL) {
      this.terrainDirty = false;
      this.lastTerrainFit = ctx.realTime;
      for (const v of this.visuals.values()) v.place(s, v.building);
      this.piles.update(s, this.visuals, ctx.realTime, true);
    }

    // per-frame cheap updates
    this.chimneyAnchors.length = 0;
    this.fireAnchors.length = 0;
    this.poolUsed = 0;
    const byId = this.game.buildingById;
    for (const b of s.buildings) {
      const v = this.visuals.get(b.id);
      if (!v) continue;
      if (!v.matches(b)) {
        // footprint changed without a revision bump — rebuild lazily
        this.seenBuildingsRev = -1;
        continue;
      }
      v.update(b, s, ctx.realTime);
      this.collectAnchors(b, v);
    }
    if (this.highlightId !== null) {
      const hb = byId?.get(this.highlightId) ?? s.buildings.find((x) => x.id === this.highlightId);
      if (hb) this.ring.set(s, hb);
      else this.setHighlight(null);
    }
    this.ring.update(ctx.realTime);
    this.piles.update(s, this.visuals, ctx.realTime);
    this.bridges.update(s, ctx.realTime);
    this.boat.update(s, this.visuals, ctx.realTime, ctx.realDt);
  }

  /** Add/remove/rebuild visuals to match state.buildings. */
  private sync(): void {
    const s = this.game.state;
    this.seenBuildingsRev = s.rev.buildings;
    const stamp = ++this.syncStamp;
    for (const b of s.buildings) {
      let v = this.visuals.get(b.id);
      if (v && !v.matches(b)) {
        v.dispose();
        v = undefined;
      }
      if (!v) {
        v = new BuildingVisual(b, s);
        this.visuals.set(b.id, v);
        // shadow pass: skip buildings whose shadow cannot land in view
        const cull = shadowCasterCull(this.scene);
        v.group.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) cull.install(o as THREE.Mesh);
        });
        this.buildingsGroup.add(v.group);
        if (b.id === this.highlightId) v.setHighlight(true);
      }
      v.stamp = stamp;
    }
    for (const [id, v] of this.visuals) {
      if (v.stamp !== stamp) {
        v.dispose();
        this.visuals.delete(id);
        if (id === this.highlightId) {
          this.highlightId = null;
          this.ring.clear();
        }
      }
    }
    this.piles.update(s, this.visuals, this.time, true);
  }

  private anchor(x: number, y: number, z: number, strength: number, buildingId: number): EmitterAnchor {
    let a = this.anchorPool[this.poolUsed];
    if (!a) {
      a = { x: 0, y: 0, z: 0, strength: 0, buildingId: -1 };
      this.anchorPool.push(a);
    }
    this.poolUsed++;
    a.x = x;
    a.y = y;
    a.z = z;
    a.strength = strength;
    a.buildingId = buildingId;
    return a;
  }

  private collectAnchors(b: Building, v: BuildingVisual): void {
    if (b.smoking && b.state === 'active' && b.fire <= 0.05) {
      const strength = BUILDINGS[b.type].housing ? 1 : 0.8;
      for (const c of v.model.chimneys) {
        v.toWorld(c, _v);
        this.chimneyAnchors.push(this.anchor(_v.x, _v.y, _v.z, strength, b.id));
      }
    }
    if (b.fire > 0.001) {
      const f = Math.min(1, b.fire);
      const pts = v.model.fires;
      // bigger fires use more emitters
      const n = Math.max(1, Math.min(pts.length, Math.ceil(pts.length * Math.min(1, f * 1.6))));
      for (let i = 0; i < n; i++) {
        v.toWorld(pts[i], _v);
        this.fireAnchors.push(this.anchor(_v.x, _v.y, _v.z, f, b.id));
      }
    }
  }

  /** Chimney smoke emitters (houses heated, workshops working). World space. */
  getChimneys(): EmitterAnchor[] {
    return this.chimneyAnchors;
  }

  /** Fire emitters for burning buildings (strength = fire intensity). */
  getFires(): EmitterAnchor[] {
    return this.fireAnchors;
  }

  /** Outline/tint the selected building (null clears). */
  setHighlight(id: number | null): void {
    if (this.highlightId !== null) this.visuals.get(this.highlightId)?.setHighlight(false);
    this.highlightId = id;
    if (id === null) {
      this.ring.clear();
      return;
    }
    const v = this.visuals.get(id);
    v?.setHighlight(true);
    const b = this.game.buildingById?.get(id) ?? this.game.state.buildings.find((x) => x.id === id);
    if (b) this.ring.set(this.game.state, b);
    else this.ring.clear();
  }

  /** The visual for a building (debug/tools). */
  getVisual(id: number): BuildingVisual | undefined {
    return this.visuals.get(id);
  }

  /** Number of building visuals currently alive. */
  get count(): number {
    return this.visuals.size;
  }

  dispose(): void {
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
    this.piles.dispose();
    this.bridges.dispose();
    this.boat.dispose();
    this.ring.dispose();
    this.root.removeFromParent();
    this.scene.remove(this.root);
  }
}
