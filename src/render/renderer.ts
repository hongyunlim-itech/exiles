/**
 * GameRenderer — owns the WebGL renderer, scene, camera and all sub-renderers. OWNER: render-scene agent.
 *
 * - WebGLRenderer: antialias, ACES filmic tone mapping, sRGB output, soft PCF shadows (quality presets).
 * - Sub-renderers are constructed in the fixed order sky, terrain, water, nature, crops, buildings, animals,
 *   citizens, effects (effects receives the BuildingRenderer), then the co-op layer remotePlayers (other players'
 *   cursors, name labels and placement ghosts; main.ts sets its source). A constructor that throws is replaced with a no-op
 *   stand-in and each per-frame update runs in its own try/catch with throttled logging, so one broken layer never
 *   kills the frame.
 * - Picking: terrain via heightfield ray-march (water surface counts as ground); entities via citizens.pick(ray),
 *   then approximate building volumes, then the building on the picked tile.
 * - Performance (render/app perf pass): quality 'auto' picks a tier from the GPU (scene/perf.ts classifyGpu) and adds
 *   dynamic resolution (render scale 0.6–1 from smoothed frame times fed by the main loop via reportFrame). Pixel
 *   ratio caps: high min(dpr, 1.5), medium 1, low 0.75. The shadow map is re-rendered on demand
 *   (shadowMap.autoUpdate = false): every frame while the view moves fast, ≤ 30 Hz while the game runs or the view
 *   drifts, and only on world changes (or every 0.5 s) when the scene is static. Shadow casters are culled by
 *   shadow footprint (scene/shadowCasters.ts).
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../core/constants';
import { heightAt, tileHeight, yearProgress } from '../core/world';
import { seasonOfMonth } from '../core/defs';
import type { Game } from '../sim/game';
import { AnimalRenderer } from './animals';
import { BuildingRenderer } from './buildings';
import { CameraController } from './camera';
import { CitizenRenderer } from './citizens';
import { CropRenderer } from './crops';
import { EffectsRenderer } from './effects';
import { NatureRenderer } from './nature';
import { createNullRenderer, ThrottledErrorLog } from './scene/guard';
import { raymarchHeightfield, type RayHit } from './scene/heightfield';
import {
  classifyGpu, DynamicResolution, frameBudget, pixelRatioForTier, resolveQuality, type QualitySetting, type QualityTier,
} from './scene/perf';
import { RemotePlayersRenderer } from './remotePlayers';
import { pickBuildingBox } from './scene/pickVolumes';
import { createWebGLRenderer, glRendererName } from './scene/rendererSetup';
import { shadowCasterCull } from './scene/shadowCasters';
import { gameTownCenter } from './scene/townCenter';
import { SkyRenderer } from './sky';
import { TerrainRenderer } from './terrain';
import type { FrameContext, PickResult, SubRenderer } from './types';
import { WaterRenderer } from './water';

export interface RenderSettings {
  shadows: boolean;
  /** 'auto' = tier from the GPU + dynamic resolution. */
  quality: QualitySetting;
  showGrid: boolean;
}

/** Live performance readout for the FPS HUD. */
export interface RenderPerf {
  /** Resolved quality tier. */
  tier: QualityTier;
  /** Quality setting ('auto' or a fixed tier). */
  quality: QualitySetting;
  /** Dynamic-resolution scale (1 unless quality is 'auto'). */
  renderScale: number;
  /** Effective device pixel ratio of the canvas. */
  pixelRatio: number;
  /** Draw calls / triangles of the last rendered frame (incl. the shadow pass when it ran). */
  calls: number;
  triangles: number;
  /** Did the last frame re-render the shadow map? */
  shadowUpdated: boolean;
  gpu: string;
}

type LayerName = 'sky' | 'terrain' | 'water' | 'nature' | 'crops' | 'buildings' | 'animals' | 'citizens' | 'effects' | 'remotePlayers';

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly cameraController!: CameraController;
  readonly terrain!: TerrainRenderer;
  readonly water!: WaterRenderer;
  readonly sky!: SkyRenderer;
  readonly buildings!: BuildingRenderer;
  readonly nature!: NatureRenderer;
  readonly citizens!: CitizenRenderer;
  readonly animals!: AnimalRenderer;
  readonly crops!: CropRenderer;
  readonly effects!: EffectsRenderer;
  /** Co-op: other players' cursors, name labels and placement ghosts (source wired by main.ts). */
  readonly remotePlayers!: RemotePlayersRenderer;
  /** INPUT adds its overlay objects (ghosts, tile highlights, radius rings) here. Not shadow-casting. */
  readonly overlayGroup: THREE.Group;
  readonly canvas: HTMLCanvasElement;
  settings: RenderSettings = { shadows: true, quality: 'auto', showGrid: false };
  game: Game;
  /** Unmasked GPU renderer string and its detected tier. */
  readonly gpuName: string;
  readonly gpuTier: QualityTier;
  /** Quality tier in use (the setting, or the detected tier for 'auto'). */
  tier: QualityTier;
  private readonly dynres = new DynamicResolution();
  private pixelRatio = 0;
  private shadowForce = 2;
  private lastShadowAt = -1e9;
  private shadowUpdated = false;
  private revSig = '';

  private readonly container: HTMLElement;
  private readonly layers: { name: LayerName; r: SubRenderer }[] = [];
  private readonly errors = new ThrottledErrorLog(5000);
  private readonly ctx: FrameContext;
  private realTime = 0;
  private canvasRect = { left: 0, top: 0, width: 1, height: 1 };
  private resizeObserver: ResizeObserver | null = null;
  private terrainMaxY = 10;
  private terrainMinY = -5;
  private boundsRev = -1;
  private disposed = false;

  // scratch objects (no per-frame allocations)
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly v3 = new THREE.Vector3();
  private readonly hit: RayHit = { t: 0, x: 0, y: 0, z: 0 };

  constructor(container: HTMLElement, game: Game, opts: { antialias?: boolean; gpuName?: string } = {}) {
    this.game = game;
    this.container = container;
    this.renderer = createWebGLRenderer({ antialias: opts.antialias ?? true });
    this.gpuName = opts.gpuName || glRendererName(this.renderer.getContext());
    this.gpuTier = classifyGpu(this.gpuName);
    this.tier = resolveQuality(this.settings.quality, this.gpuTier);
    // the shadow map is re-rendered on demand (see scheduleShadows)
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.applyPixelRatio();
    this.scene = new THREE.Scene();
    this.scene.name = 'exiles-scene';
    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 2500);
    this.overlayGroup = new THREE.Group();
    this.overlayGroup.name = 'overlays';
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    const w = this as unknown as Record<string, unknown>;
    const make = <T extends SubRenderer>(name: LayerName, create: () => T): T => {
      let r: T;
      try {
        r = create();
      } catch (err) {
        console.error(`[render] failed to construct ${name} renderer — continuing without it`, err);
        r = createNullRenderer<T>(name);
      }
      w[name] = r;
      this.layers.push({ name, r });
      return r;
    };
    // constructor order is part of the architecture contract
    make('sky', () => new SkyRenderer(this.scene, game));
    make('terrain', () => new TerrainRenderer(this.scene, game));
    make('water', () => new WaterRenderer(this.scene, game));
    make('nature', () => new NatureRenderer(this.scene, game));
    make('crops', () => new CropRenderer(this.scene, game));
    const buildings = make('buildings', () => new BuildingRenderer(this.scene, game));
    make('animals', () => new AnimalRenderer(this.scene, game));
    make('citizens', () => new CitizenRenderer(this.scene, game));
    make('effects', () => new EffectsRenderer(this.scene, game, buildings));
    // co-op layer (after the contract's fixed order); labels live in the canvas container, below the UI
    make('remotePlayers', () => new RemotePlayersRenderer(this.scene, game, { container }));
    this.scene.add(this.overlayGroup);

    const cc = new CameraController(this.camera, this.canvas, game);
    cc.pickGround = (x, y) => {
      const p = this.pickTile(x, y);
      return p ? { wx: p.wx, wz: p.wz } : null;
    };
    cc.groundHeightAt = (x, z) => {
      const t = this.terrain as Partial<TerrainRenderer>;
      const h: unknown = typeof t.groundHeight === 'function' ? t.groundHeight.call(this.terrain, x, z) : undefined;
      return typeof h === 'number' ? h : heightAt(this.game.state, x, z);
    };
    (this as { cameraController: CameraController }).cameraController = cc;

    this.ctx = {
      game,
      camera: this.camera,
      realTime: 0,
      realDt: 0,
      gameDt: 0,
      daylight: 1,
      snow: 0,
      season: 'spring',
      yearProgress: 0,
      focusX: cc.target.x,
      focusZ: cc.target.z,
      cameraDistance: cc.distance,
      quality: this.tier,
    };

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.focusTown(true);
  }

  /** Swap to a new/loaded game: all sub-renderers rebuild. */
  setGame(game: Game): void {
    this.game = game;
    this.ctx.game = game;
    this.boundsRev = -1;
    for (const { name, r } of this.layers) {
      try {
        r.setGame(game);
      } catch (err) {
        this.errors.error(name, 'setGame failed', err);
      }
    }
    try {
      this.cameraController.setGame(game);
    } catch (err) {
      this.errors.error('camera', 'setGame failed', err);
    }
    this.focusTown(true);
  }

  /** Point the camera at the town (average building position, else the first citizen). */
  focusTown(instant = false): void {
    const c = gameTownCenter(this.game);
    if (instant) this.cameraController.jumpTo(c.x, c.z);
    else this.cameraController.focusOn(c.x, c.z);
  }

  /** Sync all sub-renderers with the game state and draw a frame. gameDt = game seconds simulated this frame. */
  render(realDt: number, gameDt: number): void {
    if (this.disposed) return;
    const dt = Number.isFinite(realDt) ? Math.max(0, Math.min(realDt, 0.25)) : 0;
    this.realTime += dt;
    try {
      this.cameraController.update(dt);
    } catch (err) {
      this.errors.error('camera', 'update failed', err);
    }
    const s = this.game.state;
    const ctx = this.ctx;
    const cc = this.cameraController;
    ctx.game = this.game;
    ctx.realTime = this.realTime;
    ctx.realDt = dt;
    ctx.gameDt = gameDt;
    ctx.snow = s.weather.snow;
    ctx.season = seasonOfMonth(s.time.month);
    ctx.yearProgress = yearProgress(s);
    ctx.focusX = cc.target.x;
    ctx.focusZ = cc.target.z;
    ctx.cameraDistance = cc.distance;
    ctx.quality = this.tier;
    try {
      const d: unknown = this.sky.daylight;
      ctx.daylight = typeof d === 'number' && Number.isFinite(d) ? d : 1;
    } catch (err) {
      this.errors.error('sky', 'daylight failed', err);
    }
    for (const { name, r } of this.layers) {
      try {
        r.update(ctx);
      } catch (err) {
        this.errors.error(name, 'update failed', err);
      }
    }
    this.scheduleShadows(gameDt);
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      this.errors.error('webgl', 'render failed', err);
    }
  }

  /**
   * Decide whether this frame re-renders the shadow map. Moving fast → every frame (no stale/swimming shadows);
   * game running or view drifting → at most ~30 Hz (every 2nd frame at 60 fps); static scene → only when the world
   * changed, plus a slow 0.5 s refresh.
   */
  private scheduleShadows(gameDt: number): void {
    const sm = this.renderer.shadowMap;
    this.shadowUpdated = false;
    if (!sm.enabled) {
      sm.needsUpdate = false;
      return;
    }
    const r = this.game.state.rev;
    const sig = r.terrain + '|' + r.features + '|' + r.buildings + '|' + r.fields + '|' + r.roads;
    const changed = sig !== this.revSig;
    this.revSig = sig;
    const t = this.realTime;
    const since = t - this.lastShadowAt;
    const cc = this.cameraController;
    const speed = cc.viewSpeed;
    let update: boolean;
    if (this.shadowForce > 0) {
      this.shadowForce--;
      update = true;
    } else if (speed > 0.15) update = true;
    else if (gameDt > 0 || speed > 0.002 || cc.isMoving) update = since >= 1 / 31;
    else update = changed || since >= 0.5;
    sm.needsUpdate = update;
    if (!update) return;
    this.lastShadowAt = t;
    this.shadowUpdated = true;
    // cull casters whose shadow cannot land in view (this frame's camera & light)
    try {
      const sky = this.sky as Partial<SkyRenderer>;
      const ld = sky.state?.lightDir;
      if (ld && sky.sun) shadowCasterCull(this.scene).update(this.camera, ld, sky.sun.shadow.getFrustum());
    } catch (err) {
      this.errors.error('sky', 'shadow cull failed', err);
    }
  }

  /**
   * Main-loop timing feedback for dynamic resolution (quality 'auto' only): frameMs = interval since the previous
   * rendered frame, cpuMs = time spent in our frame code, targetMs = the frame interval aimed for (1000 / cap).
   */
  reportFrame(frameMs: number, cpuMs: number, targetMs: number): void {
    if (this.settings.quality !== 'auto') return;
    const b = frameBudget(targetMs);
    if (this.dynres.sample(frameMs, cpuMs, b.over, b.under)) this.applyPixelRatio();
  }

  /** Current dynamic-resolution scale (1 when quality is fixed). */
  get renderScale(): number {
    return this.settings.quality === 'auto' ? this.dynres.scale : 1;
  }

  private applyPixelRatio(): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const ratio = Math.round(pixelRatioForTier(this.tier, dpr) * this.renderScale * 100) / 100;
    if (ratio === this.pixelRatio) return;
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
  }

  /** Live performance readout (FPS HUD). */
  perf(): RenderPerf {
    const i = this.renderer.info;
    return {
      tier: this.tier,
      quality: this.settings.quality,
      renderScale: this.renderScale,
      pixelRatio: this.renderer.getPixelRatio(),
      calls: i.render.calls,
      triangles: i.render.triangles,
      shadowUpdated: this.shadowUpdated,
      gpu: this.gpuName,
    };
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateRect();
  }

  private updateRect(): void {
    const r = this.canvas.getBoundingClientRect();
    this.canvasRect = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  applySettings(patch: Partial<RenderSettings>): void {
    const prev = this.settings;
    const next: RenderSettings = { ...prev, ...patch };
    this.settings = next;
    const tier = resolveQuality(next.quality, this.gpuTier);
    if (next.quality !== prev.quality || tier !== this.tier) {
      this.tier = tier;
      this.dynres.reset(1);
      this.applyPixelRatio();
      this.resize();
    }
    const shadowsOn = next.shadows && tier !== 'low';
    this.shadowForce = 2;
    try {
      this.sky.setShadows(next.shadows, tier);
    } catch (err) {
      this.errors.error('sky', 'setShadows failed', err);
    }
    if (this.renderer.shadowMap.enabled !== shadowsOn) {
      this.renderer.shadowMap.enabled = shadowsOn;
      // programs are keyed on shadow state: force recompilation
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        if (Array.isArray(m)) m.forEach((x) => { x.needsUpdate = true; });
        else m.needsUpdate = true;
      });
    }
    try {
      this.terrain.setGridVisible(next.showGrid);
    } catch (err) {
      this.errors.error('terrain', 'setGridVisible failed', err);
    }
  }

  /** Ray from the camera through a client (CSS pixel) position. */
  getRay(clientX: number, clientY: number): THREE.Ray {
    const r = this.canvasRect;
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  private refreshBounds(): void {
    const s = this.game.state;
    if (this.boundsRev === s.rev.terrain) return;
    this.boundsRev = s.rev.terrain;
    const h = s.tiles.height;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    this.terrainMinY = Math.min(lo, WATER_LEVEL);
    this.terrainMaxY = Math.max(hi, WATER_LEVEL);
  }

  private surfaceSampler = (wx: number, wz: number): number => Math.max(WATER_LEVEL, heightAt(this.game.state, wx, wz));

  private marchRay(ray: THREE.Ray): RayHit | null {
    this.refreshBounds();
    const s = this.game.state;
    const o = ray.origin;
    const d = ray.direction;
    return raymarchHeightfield(this.surfaceSampler, s.W, s.H, this.terrainMinY, this.terrainMaxY, o.x, o.y, o.z, d.x, d.y, d.z, this.hit);
  }

  /** Terrain intersection under the cursor (heightfield ray-march; fast). */
  pickTile(clientX: number, clientY: number): { x: number; z: number; wx: number; wz: number } | null {
    const hit = this.marchRay(this.getRay(clientX, clientY));
    if (!hit) return null;
    const s = this.game.state;
    const x = Math.max(0, Math.min(s.W - 1, Math.floor(hit.x)));
    const z = Math.max(0, Math.min(s.H - 1, Math.floor(hit.z)));
    return { x, z, wx: hit.x, wz: hit.z };
  }

  /** Citizen under the cursor (preferred) else building whose footprint contains the picked tile. */
  pickEntity(clientX: number, clientY: number): PickResult {
    const ray = this.getRay(clientX, clientY);
    try {
      const cid = this.citizens.pick(ray);
      if (cid !== null && cid !== undefined) return { kind: 'citizen', id: cid };
    } catch (err) {
      this.errors.error('citizens', 'pick failed', err);
    }
    const s = this.game.state;
    const hit = this.marchRay(ray);
    const o = ray.origin;
    const d = ray.direction;
    const maxT = hit ? hit.t : Infinity;
    const box = pickBuildingBox(s.buildings, (b) => tileHeight(s, b.x + (b.w >> 1), b.z + (b.h >> 1)), o.x, o.y, o.z, d.x, d.y, d.z, maxT + 0.01);
    if (box) return { kind: 'building', id: box.id };
    if (!hit) return null;
    const x = Math.max(0, Math.min(s.W - 1, Math.floor(hit.x)));
    const z = Math.max(0, Math.min(s.H - 1, Math.floor(hit.z)));
    try {
      const b = this.game.buildingAtTile(x, z);
      if (b) return { kind: 'building', id: b.id };
    } catch {
      // fall back to the tile index directly
      const id = s.tiles.building[z * s.W + x];
      if (id >= 0) return { kind: 'building', id };
    }
    return null;
  }

  /** Project a world position to client (CSS pixel) coordinates. */
  worldToScreen(wx: number, wy: number, wz: number): { x: number; y: number; visible: boolean } {
    const v = this.v3.set(wx, wy, wz);
    this.camera.updateMatrixWorld();
    // behind the camera?
    const cam = this.camera;
    const e = cam.matrixWorldInverse.elements;
    const viewZ = e[2] * wx + e[6] * wy + e[10] * wz + e[14];
    v.project(cam);
    const r = this.canvasRect;
    const x = r.left + ((v.x + 1) / 2) * r.width;
    const y = r.top + ((1 - v.y) / 2) * r.height;
    const visible = viewZ < 0 && v.z >= -1 && v.z <= 1 && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1;
    return { x, y, visible };
  }

  focusOn(wx: number, wz: number): void {
    this.cameraController.focusOn(wx, wz);
  }

  /** Draw-call / triangle counters of the last frame (debug HUD). */
  stats(): { calls: number; triangles: number; geometries: number; textures: number } {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const { name, r } of this.layers) {
      try {
        r.dispose();
      } catch (err) {
        this.errors.error(name, 'dispose failed', err);
      }
    }
    try {
      this.cameraController.dispose();
    } catch (err) {
      this.errors.error('camera', 'dispose failed', err);
    }
    this.overlayGroup.removeFromParent();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
