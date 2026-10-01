/**
 * Sky dome/background, fog, sun & moon lights (shadow-casting sun that follows the camera focus), hemisphere light,
 * day/night cycle and seasonal light colour. Publishes daylight for FrameContext.
 * OWNER: render-scene agent.
 *
 * - The pure model in scene/dayCycle.ts maps (dayTime, season, overcast) to colours & directions.
 * - One directional light is the sun by day and the (dimmer, bluish) moon by night; the swap happens at twilight
 *   when both are ~0 so it is invisible. Its shadow camera follows the camera focus, snapped to shadow texels to
 *   avoid shimmering while panning. The orthographic shadow box is fitted in light space to the receivers around
 *   the focus (radius from the zoom, height range from the terrain): across the light it spans ±R, along the
 *   light's "up" axis only R·sin(elevation) + the height range — a low sun no longer drags a long strip of the
 *   map (and every tree on it) into the shadow pass, and ground texels stay roughly square.
 * - `shadowCull` (a copy of this frame's shadow frustum) + `shadowVersion` let other layers cull their shadow
 *   casters per instance (nature) before the renderer draws.
 * - At high game speeds (5x/10x) a 24 s day would strobe, so the cycle eases towards a steady late-morning light.
 * - Fog distance follows the camera distance; fog colour = horizon colour, so terrain fades into the sky.
 */
import * as THREE from 'three';
import type { Game } from '../sim/game';
import { computeSky, createSkyState, type SkyState } from './scene/dayCycle';
import { createSkyDome, createSkyDomeUniforms, type SkyDomeUniforms } from './scene/skyDome';
import { WATER_LEVEL } from '../core/constants';
import { heightAt, yearProgress } from '../core/world';
import type { FrameContext, SubRenderer } from './types';

const registry = new WeakMap<THREE.Scene, SkyRenderer>();

/** Latest sky state for a scene (for layers that want sky-matched colours, e.g. water reflections). */
export function getSkyState(scene: THREE.Scene): SkyState | undefined {
  return registry.get(scene)?.state;
}

/** The sky renderer of a scene (sun, shadow culling data), if one was created. */
export function getSkyRenderer(scene: THREE.Scene): SkyRenderer | undefined {
  return registry.get(scene);
}

/** Radius (world units) of the shadowed area around the camera focus for a camera distance. */
export function shadowRadiusFor(cameraDistance: number): number {
  const want = Math.max(24, Math.min(62, cameraDistance * 0.62 + 16));
  return Math.ceil(want / 4) * 4;
}

export interface ShadowBox {
  /** Light-space extents relative to the (snapped) focus: x across the light, y along the light's up axis. */
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * Tight light-space box for receivers within radius R of the focus whose heights (relative to the focus) lie in
 * [yLo, yHi], for a light at elevation sinE. Any caster whose shadow lands on those receivers projects into the
 * same light-space rectangle, so casters are never lost. Extents are quantized to 2 units (stable frusta).
 */
export function fitShadowBox(R: number, sinE: number, yLo: number, yHi: number, out: ShadowBox): ShadowBox {
  const se = Math.max(0.05, Math.min(1, sinE));
  const ce = Math.sqrt(Math.max(0, 1 - se * se));
  let lo = -R * se + Math.min(0, yLo) * ce;
  let hi = R * se + Math.max(0, yHi) * ce;
  lo = Math.floor(lo / 2) * 2;
  hi = Math.ceil(hi / 2) * 2;
  if (hi - lo < 8) {
    const mid = (hi + lo) / 2;
    lo = Math.floor((mid - 4) / 2) * 2;
    hi = lo + 8;
  }
  out.left = -R;
  out.right = R;
  out.bottom = lo;
  out.top = hi;
  return out;
}

const LIGHT_DISTANCE = 160;
const DOME_RADIUS = 1800;

export class SkyRenderer implements SubRenderer {
  readonly state: SkyState = createSkyState();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly fog: THREE.Fog;
  private readonly scene: THREE.Scene;
  private game: Game;
  private readonly dome: THREE.Mesh;
  private readonly domeU: SkyDomeUniforms = createSkyDomeUniforms();
  private readonly background = new THREE.Color();
  private cycle = 1;
  private overcast = 0;
  private shadowsWanted = true;
  /**
   * Frustum of this frame's shadow camera placement (valid while `shadowCasting`). Computed from a private camera,
   * so reading it never touches the light's own shadow matrices (the renderer may skip shadow-map updates).
   */
  readonly shadowCull = new THREE.Frustum();
  /** Bumped whenever the shadow frustum changed noticeably (light turned > ~0.6°, box moved/resized). */
  shadowVersion = 0;
  private readonly cullCam = new THREE.OrthographicCamera();
  private readonly box: ShadowBox = { left: -40, right: 40, bottom: -40, top: 40 };
  private readonly lastL = new THREE.Vector3(0, 1, 0);
  private readonly lastTarget = new THREE.Vector3(Infinity, 0, 0);
  private heightKey = '';
  private yLo = -2;
  private yHi = 6;
  private readonly pv = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;

    this.hemi = new THREE.HemisphereLight(0xc4d7ea, 0x746448, 1.4);
    this.hemi.name = 'sky-hemisphere';
    scene.add(this.hemi);
    // a little flat fill so cliffs facing away from the sun never go black
    this.ambient = new THREE.AmbientLight(0xc4d7ea, 0.35);
    this.ambient.name = 'sky-ambient';
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff5e8, 3);
    this.sun.name = 'sky-sun';
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(2048, 2048);
    sh.bias = -0.0004;
    sh.normalBias = 0.035;
    sh.radius = 2.5;
    const cam = sh.camera as THREE.OrthographicCamera;
    cam.near = 1;
    cam.far = LIGHT_DISTANCE * 2 + 60;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fog = new THREE.Fog(0xc9dce6, 60, 260);
    scene.fog = this.fog;
    scene.background = this.background;

    this.dome = createSkyDome(this.domeU);
    this.dome.scale.setScalar(DOME_RADIUS);
    scene.add(this.dome);

    registry.set(scene, this);
    this.setGame(game);
  }

  setGame(game: Game): void {
    this.game = game;
    this.cycle = this.cycleTarget();
    this.overcast = this.overcastTarget();
    this.compute();
  }

  private cycleTarget(): number {
    return this.game.speed >= 5 ? 0 : 1;
  }

  private overcastTarget(): number {
    const w = this.game.state.weather;
    return w.precipitation === 'none' ? 0 : 0.3 + 0.7 * Math.max(0, Math.min(1, w.precipIntensity));
  }

  private compute(): SkyState {
    const t = this.game.state.time;
    return computeSky(
      { dayTime: t.dayTime, yearProgress: yearProgress(this.game.state), overcast: this.overcast, cycle: this.cycle },
      this.state,
    );
  }

  update(ctx: FrameContext): void {
    const dt = Math.min(0.1, ctx.realDt);
    this.cycle += (this.cycleTarget() - this.cycle) * (1 - Math.exp(-dt / 1.2));
    this.overcast += (this.overcastTarget() - this.overcast) * (1 - Math.exp(-dt / 3));
    const st = this.compute();

    // ---- lights ----
    const sun = this.sun;
    sun.color.setRGB(st.lightColor[0], st.lightColor[1], st.lightColor[2], THREE.SRGBColorSpace);
    sun.intensity = st.lightIntensity;
    sun.shadow.intensity = st.shadowStrength;
    this.hemi.color.setRGB(st.hemiSky[0], st.hemiSky[1], st.hemiSky[2], THREE.SRGBColorSpace);
    this.hemi.groundColor.setRGB(st.hemiGround[0], st.hemiGround[1], st.hemiGround[2], THREE.SRGBColorSpace);
    this.hemi.intensity = st.hemiIntensity;
    this.ambient.color.copy(this.hemi.color);
    this.ambient.intensity = st.hemiIntensity * 0.55;
    this.placeSun(ctx);

    // ---- fog & background ----
    this.fog.color.setRGB(st.fog[0], st.fog[1], st.fog[2], THREE.SRGBColorSpace);
    this.background.copy(this.fog.color);
    const d = ctx.cameraDistance;
    const thick = 1 - 0.3 * this.overcast - 0.12 * st.winter;
    this.fog.near = (d * 1.0 + 30) * thick;
    this.fog.far = (d * 2.6 + 210) * thick;

    // ---- dome ----
    const u = this.domeU;
    u.uZenith.value.setRGB(st.zenith[0], st.zenith[1], st.zenith[2], THREE.SRGBColorSpace);
    u.uHorizon.value.setRGB(st.horizon[0], st.horizon[1], st.horizon[2], THREE.SRGBColorSpace);
    u.uFog.value.copy(this.fog.color);
    this.c.setRGB(st.lightColor[0], st.lightColor[1], st.lightColor[2], THREE.SRGBColorSpace);
    u.uSunColor.value.copy(this.c);
    u.uCloudColor.value.setRGB(st.cloud[0], st.cloud[1], st.cloud[2], THREE.SRGBColorSpace);
    u.uSunDir.value.set(st.sunDir[0], st.sunDir[1], st.sunDir[2]);
    u.uMoonDir.value.set(st.moonDir[0], st.moonDir[1], st.moonDir[2]);
    u.uSunGlow.value = st.sunGlow;
    u.uSunVis.value = (1 - this.overcast * 0.9) * (st.sunDir[1] > -0.05 ? 1 : 0);
    u.uStars.value = st.stars;
    u.uCloud.value = 0.3 + 0.7 * this.overcast;
    u.uTime.value = ctx.realTime;
    const w = this.game.state.weather;
    u.uWind.value.set(Math.cos(w.windDir), Math.sin(w.windDir)).multiplyScalar(0.5 + w.windStrength);
    this.dome.position.copy(ctx.camera.position);
  }

  /** True when the sun casts shadows (setting on & quality allows). */
  get shadowCasting(): boolean {
    return this.shadowsWanted && this.sun.castShadow;
  }

  /** Terrain height range (relative to the focus) of the receivers within radius R (sampled on a coarse grid). */
  private receiverHeights(fx: number, fz: number, fy: number, R: number): void {
    const s = this.game.state;
    const key = `${Math.round(fx / 4)}|${Math.round(fz / 4)}|${R}|${s.rev.terrain}`;
    if (key === this.heightKey) return;
    this.heightKey = key;
    let lo = Infinity;
    let hi = -Infinity;
    const x0 = Math.max(0, fx - R);
    const x1 = Math.min(s.W, fx + R);
    const z0 = Math.max(0, fz - R);
    const z1 = Math.min(s.H, fz + R);
    for (let z = z0; z <= z1 + 1e-6; z += 4) {
      for (let x = x0; x <= x1 + 1e-6; x += 4) {
        const h = Math.max(WATER_LEVEL, heightAt(s, Math.min(x, s.W), Math.min(z, s.H)));
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = fy;
      hi = fy;
    }
    // receivers: the ground plus whatever stands on it (trees, roofs, spires)
    this.yLo = lo - fy - 0.5;
    this.yHi = hi - fy + 4.5;
  }

  /** Aim the directional light at the camera focus; fit, size & snap its shadow frustum. */
  private placeSun(ctx: FrameContext): void {
    const st = this.state;
    const L = this.tmp.set(st.lightDir[0], st.lightDir[1], st.lightDir[2]).normalize();
    const R = shadowRadiusFor(ctx.cameraDistance);
    const fx = ctx.focusX;
    const fz = ctx.focusZ;
    const fy = heightAt(this.game.state, fx, fz);
    this.receiverHeights(fx, fz, fy, R);
    const box = fitShadowBox(R, L.y, this.yLo, this.yHi, this.box);
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    // far plane just behind the deepest receiver (down-light edge of the disk, lowest ground): anything further
    // from the light can neither receive a visible shadow nor cast one onto the receivers
    const cosE = Math.sqrt(Math.max(0, 1 - L.y * L.y));
    const far = Math.ceil((LIGHT_DISTANCE + R * cosE + Math.max(0, -this.yLo) * L.y + 6) / 4) * 4;
    let changed = false;
    if (cam.left !== box.left || cam.right !== box.right || cam.top !== box.top || cam.bottom !== box.bottom || cam.far !== far) {
      cam.left = box.left;
      cam.right = box.right;
      cam.top = box.top;
      cam.bottom = box.bottom;
      cam.far = far;
      cam.updateProjectionMatrix();
      changed = true;
    }
    // snap the focus to the shadow-map texel grid in light space
    this.focus.set(fx, fy, fz);
    this.right.set(0, 1, 0).cross(L);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.copy(L).cross(this.right).normalize();
    const size = this.sun.shadow.mapSize.x;
    const texelX = (box.right - box.left) / size;
    const texelY = (box.top - box.bottom) / size;
    const rx = this.focus.dot(this.right);
    const ry = this.focus.dot(this.up);
    const sx = Math.round(rx / texelX) * texelX - rx;
    const sy = Math.round(ry / texelY) * texelY - ry;
    this.focus.addScaledVector(this.right, sx).addScaledVector(this.up, sy);
    this.sun.target.position.copy(this.focus);
    this.sun.position.copy(this.focus).addScaledVector(L, LIGHT_DISTANCE);
    this.sun.target.updateMatrixWorld();

    // culling copy of the shadow frustum (only refreshed when it moved noticeably)
    if (changed || L.dot(this.lastL) < 0.99995 || this.focus.distanceToSquared(this.lastTarget) > 0.5 * 0.5) {
      this.lastL.copy(L);
      this.lastTarget.copy(this.focus);
      const cc = this.cullCam;
      cc.left = box.left;
      cc.right = box.right;
      cc.top = box.top;
      cc.bottom = box.bottom;
      cc.near = cam.near;
      cc.far = cam.far;
      cc.updateProjectionMatrix();
      cc.position.copy(this.sun.position);
      cc.lookAt(this.focus);
      cc.updateMatrixWorld();
      this.pv.multiplyMatrices(cc.projectionMatrix, cc.matrixWorldInverse);
      this.shadowCull.setFromProjectionMatrix(this.pv);
      this.shadowVersion++;
    }
  }

  /** 0 = night, 1 = day, derived from state.time.dayTime. */
  get daylight(): number {
    return this.compute().daylight;
  }

  setShadows(enabled: boolean, quality: 'low' | 'medium' | 'high'): void {
    this.shadowsWanted = enabled && quality !== 'low';
    this.sun.castShadow = this.shadowsWanted;
    const size = quality === 'high' ? 2048 : 1024;
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
    }
    sh.radius = quality === 'high' ? 2.5 : 1.8;
    this.shadowVersion++;
    this.lastTarget.set(Infinity, 0, 0);
  }

  dispose(): void {
    registry.delete(this.scene);
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.sun.removeFromParent();
    this.sun.target.removeFromParent();
    this.hemi.removeFromParent();
    this.ambient.dispose();
    this.ambient.removeFromParent();
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    this.dome.removeFromParent();
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this.scene.background === this.background) this.scene.background = null;
  }
}
