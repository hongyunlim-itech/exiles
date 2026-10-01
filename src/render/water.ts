/**
 * Animated water surface for rivers & lakes (seasonal colour, gentle waves, shoreline foam).
 * OWNER: render-scene agent.
 *
 * One indexed mesh at WATER_LEVEL covers all water tiles plus a 1-tile margin so the plane meets the sloping banks
 * naturally. Per-vertex depth & shore distance drive colour, transparency, foam and ice in the shader.
 * The mesh is rebuilt lazily when `rev.terrain` changes; everything else is uniform animation.
 */
import * as THREE from 'three';
import type { Game } from '../sim/game';
import { winterness } from './scene/dayCycle';
import { buildWaterMesh } from './scene/waterMesh';
import { createWaterMaterial, createWaterUniforms, type WaterUniforms } from './scene/waterShader';
import { getSkyState } from './sky';
import type { FrameContext, SubRenderer } from './types';

const THROTTLE_REBUILD = 1.0;

export class WaterRenderer implements SubRenderer {
  private readonly scene: THREE.Scene;
  private game: Game;
  private readonly uniforms: WaterUniforms = createWaterUniforms();
  private readonly material: THREE.MeshPhongMaterial;
  private readonly waterMesh: THREE.Mesh;
  private seenTerrain = -1;
  private lastBuildAt = -Infinity;
  private ice = 0;
  private chop = 0;
  private usedCorners = new Int32Array(0);
  private usedHeights = new Float32Array(0);
  private readonly tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
    this.material = createWaterMaterial(this.uniforms);
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.waterMesh.name = 'water';
    this.waterMesh.receiveShadow = true;
    this.waterMesh.castShadow = false;
    // draw first among transparent objects so particles above the water blend over it
    this.waterMesh.renderOrder = -1;
    scene.add(this.waterMesh);
    this.setGame(game);
  }

  setGame(game: Game): void {
    this.game = game;
    this.rebuild();
    this.seenTerrain = game.state.rev.terrain;
    this.ice = this.iceTarget();
  }

  private rebuild(): void {
    const data = buildWaterMesh(this.game.state);
    const g = new THREE.BufferGeometry();
    if (data.waterTiles > 0) {
      g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(data.positions.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      g.setAttribute('aDepth', new THREE.BufferAttribute(data.depth, 1));
      g.setAttribute('aShore', new THREE.BufferAttribute(data.shore, 1));
      g.setIndex(new THREE.BufferAttribute(data.index, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      // waves displace vertices slightly; pad the bounds so culling never clips them
      g.boundingBox?.expandByScalar(0.2);
      if (g.boundingSphere) g.boundingSphere.radius += 0.2;
    }
    this.waterMesh.geometry.dispose();
    this.waterMesh.geometry = g;
    this.waterMesh.visible = data.waterTiles > 0;
    // remember the corner heights the mesh depends on, so unrelated terrain edits don't trigger rebuilds
    const s = this.game.state;
    const W1 = s.W + 1;
    const idx: number[] = [];
    for (let i = 0; i < data.positions.length; i += 3) {
      const x = data.positions[i];
      const z = data.positions[i + 2];
      if (x >= 0 && z >= 0 && x <= s.W && z <= s.H) idx.push(z * W1 + x);
    }
    this.usedCorners = Int32Array.from(idx);
    this.usedHeights = Float32Array.from(idx, (c) => s.tiles.height[c]);
  }

  private heightsUnderWaterChanged(): boolean {
    const h = this.game.state.tiles.height;
    const c = this.usedCorners;
    const u = this.usedHeights;
    for (let i = 0; i < c.length; i++) if (h[c[i]] !== u[i]) return true;
    return false;
  }

  private iceTarget(): number {
    const t = this.game.state.weather.temperature;
    return Math.max(0, Math.min(1, (-t - 0.5) / 7));
  }

  update(ctx: FrameContext): void {
    const s = this.game.state;
    if (s.rev.terrain !== this.seenTerrain && ctx.realTime - this.lastBuildAt >= THROTTLE_REBUILD) {
      this.seenTerrain = s.rev.terrain;
      this.lastBuildAt = ctx.realTime;
      if (this.heightsUnderWaterChanged()) this.rebuild();
    }
    const dt = Math.min(0.1, ctx.realDt);
    const u = this.uniforms;
    // waves keep moving while paused (real time), a little faster when the game runs fast
    u.uTime.value = ctx.realTime;
    this.ice += (this.iceTarget() - this.ice) * (1 - Math.exp(-dt * 0.35));
    u.uIce.value = this.ice;
    u.uWinter.value = Math.max(winterness(ctx.yearProgress) * 0.75, ctx.snow * 0.9);
    const w = s.weather;
    const chopTarget = Math.min(1, w.windStrength * 0.7 + (w.precipitation === 'rain' ? 0.5 * w.precipIntensity : 0));
    this.chop += (chopTarget - this.chop) * (1 - Math.exp(-dt * 0.5));
    u.uChop.value = this.chop;
    u.uWind.value.set(Math.cos(w.windDir), Math.sin(w.windDir));
    u.uDay.value = ctx.daylight;
    // reflect the sky: the horizon/fog colour at grazing angles
    const sky = getSkyState(this.scene);
    if (sky) {
      this.tmpColor.setRGB(sky.horizon[0], sky.horizon[1], sky.horizon[2], THREE.SRGBColorSpace);
      u.uSkyRefl.value.copy(this.tmpColor).multiplyScalar(0.55 + 0.45 * sky.daylight);
    }
  }

  dispose(): void {
    this.waterMesh.geometry.dispose();
    this.material.dispose();
    this.waterMesh.removeFromParent();
  }
}
