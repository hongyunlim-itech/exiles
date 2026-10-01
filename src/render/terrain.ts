/**
 * Terrain mesh: per-tile colours (grass/sand/rock/shore, roads, bridges excluded, soil under fields & zones, dirt under buildings),
 * seasonal grass tint, snow cover, optional grid overlay.
 * OWNER: render-scene agent.
 *
 * Design
 * - One mesh, one quad (4 unique vertices) per tile; heights come from the shared corner array.
 * - Vertex data: `aColor` = smooth "natural" ground colour per corner (terrain type, forest floor, shore, riverbed),
 *   `aMat` = (grassiness, snowiness, rockiness, overlay byte). Overlays (roads, soil, pads, zones) are drawn by the
 *   shader from a small palette with soft ragged edges that blend into the natural colour underneath.
 * - Rebuilds are lazy and diff-based on `state.rev` counters (throttled), and only changed vertex ranges are
 *   uploaded. Seasons, snow, snow line and the grid are pure uniform updates (no geometry work per frame).
 * - A decorative ring of hills & mountains surrounds the map so the world never ends in a cliff.
 * - Drawn as ~25 chunk meshes sharing the geometry's buffers (TerrainGeometry.chunks) and 8 ring sectors, so
 *   off-screen parts are culled in the main and the shadow pass.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../core/constants';
import { heightAt } from '../core/world';
import type { Game } from '../sim/game';
import { CLIMATE_OFFSET, MONTH_TEMPERATURE } from '../core/defs';
import { grassColorAt, type RGB } from './scene/palette';
import { TerrainBorder } from './scene/terrainBorder';
import { TerrainGeometry } from './scene/terrainGeometry';
import { shadowCasterCull } from './scene/shadowCasters';
import { createTerrainMaterial, createTerrainUniforms, type TerrainUniforms } from './scene/terrainShader';
import {
  computeCorners, computeCornersForTiles, computeNatural, computeNaturalTiles, computeNearWater, computeOverlay,
  computeTileNoise, createOverlayScratch, featureKey,
  mountainHeights, quantile, type OverlayScratch,
} from './scene/terrainSurface';
import { getSkyState } from './sky';
import type { FrameContext, SubRenderer } from './types';

/** Minimum real seconds between rebuilds of each kind (changes are never lost, only delayed). */
const THROTTLE_TERRAIN = 0.2;
const THROTTLE_OVERLAY = 0.15;
const THROTTLE_FEATURES = 1.5;
const THROTTLE_BORDER = 2.0;

const SUMMER_GRASS = new THREE.Color(0x6f8f45);

/** Mean monthly temperature (fair climate), smoothly interpolated between month centres. */
function seasonalTemperature(yearProgress: number): number {
  const n = MONTH_TEMPERATURE.length;
  const m = (((yearProgress * n - 0.5) % n) + n) % n;
  const i0 = Math.floor(m);
  const f = m - i0;
  return MONTH_TEMPERATURE[i0] + (MONTH_TEMPERATURE[(i0 + 1) % n] - MONTH_TEMPERATURE[i0]) * f;
}

export class TerrainRenderer implements SubRenderer {
  private readonly scene: THREE.Scene;
  private game: Game;
  private readonly group = new THREE.Group();
  private readonly uniforms: TerrainUniforms = createTerrainUniforms();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly ringMaterial: THREE.MeshLambertMaterial;
  private readonly terrainMesh: THREE.Mesh;
  /** Rendered terrain: one mesh per culling chunk (shared buffers). */
  private readonly chunkGroup = new THREE.Group();
  private chunkMeshes: THREE.Mesh[] = [];
  private readonly border: TerrainBorder;
  private geo: TerrainGeometry | null = null;

  // CPU-side surface data
  private noise: Float32Array = new Float32Array(0);
  private nearWater = new Uint8Array(0);
  private tileRgb = new Uint8Array(0);
  private tileMat = new Uint8Array(0);
  private cornerRgb = new Uint8Array(0);
  private cornerMat = new Uint8Array(0);
  private overlay = new Uint8Array(0);
  private scratch: OverlayScratch = createOverlayScratch(0);
  private mountainQ: Float32Array = new Float32Array(0);
  /** Scratch list of tiles whose natural colour changed (incremental updates). */
  private readonly changedTiles = new Int32Array(4096);
  /** Per-tile feature keys last used for colouring (see featureKey). */
  private featureKeys = new Uint8Array(0);
  /** Terrain types / map-edge heights the colours & border ring were built from. */
  private lastTerrainTypes = new Uint8Array(0);
  private edgeHeights: Float32Array = new Float32Array(0);

  private readonly seen = { terrain: -1, features: -1, roads: -1, buildings: -1, fields: -1 };
  private lastTerrainAt = -Infinity;
  private lastOverlayAt = -Infinity;
  private lastFeaturesAt = -Infinity;
  private lastBorderAt = -Infinity;
  private borderDirty = false;
  private clock = 0;

  private snowVisual = 0;
  private gridTarget = 0;
  private readonly tmpRgb: RGB = [0, 0, 0];
  private readonly tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.group.name = 'terrain';
    this.material = createTerrainMaterial(this.uniforms, false);
    this.ringMaterial = createTerrainMaterial(this.uniforms, true);
    this.terrainMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.terrainMesh.name = 'terrain-mesh';
    this.terrainMesh.castShadow = true;
    this.terrainMesh.receiveShadow = true;
    this.border = new TerrainBorder(this.ringMaterial);
    this.chunkGroup.name = 'terrain-chunks';
    this.group.add(this.chunkGroup, this.border.group);
    scene.add(this.group);
    this.setGame(game);
  }

  setGame(game: Game): void {
    this.game = game;
    const s = game.state;
    const { W, H } = s;
    const n = W * H;
    const nc = (W + 1) * (H + 1);
    this.geo?.dispose();
    this.geo = new TerrainGeometry(W, H, s.tiles.height);
    this.terrainMesh.geometry = this.geo.geometry;
    for (const m of this.chunkMeshes) m.removeFromParent();
    this.chunkMeshes = this.geo.chunks.map((c, i) => {
      const m = new THREE.Mesh(c.geometry, this.material);
      m.name = 'terrain-chunk-' + i;
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      shadowCasterCull(this.scene).install(m);
      this.chunkGroup.add(m);
      return m;
    });
    this.uniforms.uW.value = W;

    this.noise = computeTileNoise(W, H, s.settings.seed);
    this.nearWater = new Uint8Array(n);
    this.tileRgb = new Uint8Array(n * 3);
    this.tileMat = new Uint8Array(n * 4);
    this.cornerRgb = new Uint8Array(nc * 4);
    this.cornerMat = new Uint8Array(nc * 4);
    this.overlay = new Uint8Array(n);
    this.scratch = createOverlayScratch(n);

    this.lastTerrainTypes = Uint8Array.from(s.tiles.terrain);
    this.featureKeys = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.featureKeys[i] = featureKey(s.tiles.feature[i], s.tiles.featureAmount[i]);
    computeNearWater(s, this.nearWater);
    this.recolourAll();
    computeOverlay(s, this.overlay, this.scratch);
    this.geo.syncOverlay(this.overlay);
    this.geo.flush();
    this.mountainQ = mountainHeights(s);
    this.buildBorder();

    const r = s.rev;
    this.seen.terrain = r.terrain;
    this.seen.features = r.features;
    this.seen.roads = r.roads;
    this.seen.buildings = r.buildings;
    this.seen.fields = r.fields;
    this.borderDirty = false;
    this.snowVisual = s.weather.snow;
    this.uniforms.uSnowLine.value = 1000; // snaps to the proper line on the next update
  }

  /** Full natural recolour (corners + all vertices). */
  private recolourAll(): void {
    const s = this.game.state;
    computeNatural(s, this.noise, this.nearWater, this.tileRgb, this.tileMat);
    computeCorners(s, this.tileRgb, this.tileMat, this.cornerRgb, this.cornerMat);
    this.geo?.syncNatural(this.cornerRgb, this.cornerMat);
  }

  /** Incremental recolour of the first `count` tiles in `changedTiles` and their corner neighbourhoods. */
  private recolourTiles(count: number): void {
    const s = this.game.state;
    const n = computeNaturalTiles(s, this.noise, this.nearWater, this.tileRgb, this.tileMat, this.changedTiles, count);
    if (n === 0) return;
    computeCornersForTiles(s, this.tileRgb, this.tileMat, this.cornerRgb, this.cornerMat, this.changedTiles, n);
    this.geo?.syncNaturalTiles(this.cornerRgb, this.cornerMat, this.changedTiles, n);
  }

  /** Compare terrain types with the last seen copy; true (and re-copy) if any changed. */
  private syncTerrainTypes(): boolean {
    const cur = this.game.state.tiles.terrain;
    const last = this.lastTerrainTypes;
    let changed = last.length !== cur.length;
    if (!changed) {
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] !== last[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) this.lastTerrainTypes = Uint8Array.from(cur);
    return changed;
  }

  /** True if any map-edge corner height differs from the copy the border ring was built from. */
  private edgeHeightsChanged(): boolean {
    const e = this.readEdgeHeights();
    const old = this.edgeHeights;
    let changed = e.length !== old.length;
    for (let i = 0; !changed && i < e.length; i++) if (e[i] !== old[i]) changed = true;
    return changed;
  }

  private readEdgeHeights(): Float32Array {
    const s = this.game.state;
    const { W, H } = s;
    const h = s.tiles.height;
    const out = new Float32Array(2 * (W + 1) + 2 * (H + 1));
    let k = 0;
    for (let x = 0; x <= W; x++) {
      out[k++] = h[x];
      out[k++] = h[H * (W + 1) + x];
    }
    for (let z = 0; z <= H; z++) {
      out[k++] = h[z * (W + 1)];
      out[k++] = h[z * (W + 1) + W];
    }
    return out;
  }

  private buildBorder(): void {
    this.edgeHeights = this.readEdgeHeights();
    const s = this.game.state;
    this.border.build({
      W: s.W, H: s.H, heights: s.tiles.height, cornerRgb: this.cornerRgb, cornerMat: this.cornerMat, seed: s.settings.seed,
      mountainLevel: quantile(this.mountainQ, 0.9, 8),
    });
    this.lastBorderAt = this.clock;
  }

  update(ctx: FrameContext): void {
    const geo = this.geo;
    if (!geo) return;
    this.clock = ctx.realTime;
    const now = ctx.realTime;
    const s = this.game.state;
    const rev = s.rev;

    // ---- heights / terrain types (e.g. building placement flattens a footprint) ----
    if (rev.terrain !== this.seen.terrain && now - this.lastTerrainAt >= THROTTLE_TERRAIN) {
      this.seen.terrain = rev.terrain;
      this.lastTerrainAt = now;
      const dirty = geo.syncHeights(s.tiles.height, this.changedTiles);
      if (this.syncTerrainTypes()) {
        // terrain types changed (rare): full natural rebuild
        computeNearWater(s, this.nearWater);
        this.mountainQ = mountainHeights(s);
        this.recolourAll();
      } else if (dirty > this.changedTiles.length) {
        this.recolourAll();
      } else if (dirty > 0) {
        this.recolourTiles(dirty);
      }
      if (dirty > 0 && this.edgeHeightsChanged()) this.borderDirty = true;
    }
    // ---- natural colours (forest floor follows trees): only tiles whose feature key changed ----
    if (rev.features !== this.seen.features && now - this.lastFeaturesAt >= THROTTLE_FEATURES) {
      this.seen.features = rev.features;
      this.lastFeaturesAt = now;
      const keys = this.featureKeys;
      const t = s.tiles;
      const cap = this.changedTiles.length;
      let n = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = featureKey(t.feature[i], t.featureAmount[i]);
        if (k !== keys[i]) {
          keys[i] = k;
          if (n < cap) this.changedTiles[n] = i;
          n++;
        }
      }
      if (n > cap) this.recolourAll();
      else if (n > 0) this.recolourTiles(n);
    }
    // ---- overlays: roads, buildings, fields ----
    if ((rev.roads !== this.seen.roads || rev.buildings !== this.seen.buildings || rev.fields !== this.seen.fields)
      && now - this.lastOverlayAt >= THROTTLE_OVERLAY) {
      this.seen.roads = rev.roads;
      this.seen.buildings = rev.buildings;
      this.seen.fields = rev.fields;
      this.lastOverlayAt = now;
      computeOverlay(s, this.overlay, this.scratch);
      geo.syncOverlay(this.overlay);
    }
    geo.flush();
    if (this.borderDirty && now - this.lastBorderAt >= THROTTLE_BORDER) {
      this.borderDirty = false;
      this.buildBorder();
    }

    this.updateUniforms(ctx);
    this.updateShadowCasters();
  }

  /**
   * Terrain chunks only cast shadows when some slope in them is steeper than the light and the chunk has real relief
   * (flat meadows and gentle bumps can't cast a visible shadow at the sun's elevation; Lambert shading already darkens
   * slopes facing away) — saves most terrain draws in the shadow pass.
   */
  private updateShadowCasters(): void {
    const geo = this.geo;
    if (!geo) return;
    const ld = getSkyState(this.scene)?.lightDir;
    const tanE = ld ? ld[1] / Math.max(1e-3, Math.hypot(ld[0], ld[2])) : 1;
    for (let i = 0; i < this.chunkMeshes.length; i++) {
      const c = geo.chunks[i];
      this.chunkMeshes[i].castShadow = c.maxSlope * 1.5 > tanE && c.relief > 0.8;
    }
  }

  private updateUniforms(ctx: FrameContext): void {
    const u = this.uniforms;
    const dt = Math.min(0.1, ctx.realDt);
    // seasonal grass tint relative to the summer base colour (linear space)
    const g = grassColorAt(ctx.yearProgress, this.tmpRgb);
    this.tmpColor.setRGB(g[0], g[1], g[2], THREE.SRGBColorSpace);
    u.uGrassTint.value.setRGB(
      this.tmpColor.r / SUMMER_GRASS.r, this.tmpColor.g / SUMMER_GRASS.g, this.tmpColor.b / SUMMER_GRASS.b,
    );
    // snow cover eases in/out so the sim's changes never pop
    const target = Math.max(0, Math.min(1, ctx.snow));
    this.snowVisual += (target - this.snowVisual) * (1 - Math.exp(-dt * 1.2));
    u.uSnow.value = this.snowVisual;
    // snow line on mountains follows the seasonal temperature curve (lags the sun: lowest in late winter),
    // and drops further while snow lies on the ground
    const q = this.mountainQ.length > 40 ? this.mountainQ : this.border.rockHeights;
    const summer = quantile(q, 0.9, 1000);
    const winter = quantile(q, 0.3, 1000);
    const temp = seasonalTemperature(ctx.yearProgress) + CLIMATE_OFFSET[this.game.state.settings.climate ?? 'fair'];
    const k = Math.max(0, Math.min(1, (temp + 6) / 28));
    let line = winter + (summer - winter) * k;
    line -= this.snowVisual * Math.max(0, line - WATER_LEVEL) * 0.3;
    u.uSnowLine.value += (line - u.uSnowLine.value) * (u.uSnowLine.value > 999 ? 1 : 1 - Math.exp(-dt * 0.8));
    // grid fade
    u.uGrid.value += (this.gridTarget - u.uGrid.value) * (1 - Math.exp(-dt * 12));
    if (Math.abs(u.uGrid.value - this.gridTarget) < 0.002) u.uGrid.value = this.gridTarget;
  }

  /** The terrain mesh (for debugging; picking uses the heightfield, not raycasts). */
  get mesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  setGridVisible(visible: boolean): void {
    this.gridTarget = visible ? 1 : 0;
  }

  /**
   * Visible ground height at any world point, including the decorative border ring outside the map (the camera
   * uses this to stay above the hills beyond the map edge).
   */
  groundHeight(wx: number, wz: number): number {
    const s = this.game.state;
    if (wx < 0 || wz < 0 || wx > s.W || wz > s.H) {
      const h = this.border.heightAt(wx, wz);
      if (h !== null) return h;
    }
    return heightAt(s, wx, wz);
  }

  /** Current visual snow cover (smoothed), for other layers that want to match the ground. */
  get snowCover(): number {
    return this.snowVisual;
  }

  dispose(): void {
    for (const m of this.chunkMeshes) m.removeFromParent();
    this.chunkMeshes = [];
    this.geo?.dispose();
    this.geo = null;
    this.border.dispose();
    this.material.dispose();
    this.ringMaterial.dispose();
    this.group.removeFromParent();
    void this.scene;
  }
}
