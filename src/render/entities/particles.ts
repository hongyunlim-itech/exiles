/**
 * CPU-simulated billboard particle pool (smoke, dust, flames, embers, chips, splashes) drawn as ONE instanced quad
 * mesh. All particle state lives in preallocated typed arrays; alive particles are kept compact (swap-remove) so the
 * GPU draws exactly `alive` instances. Zero allocations per frame.
 */
import * as THREE from 'three';

export interface ParticlePoolOptions {
  capacity: number;
  additive: boolean;
  /** Edge softness 0..1 (fraction of the radius that fades). */
  softness: number;
  /** Shade the sprite (lighter top) and scale by the scene light factor (smoke). */
  lit: boolean;
  /** Vertical (screen-space) elongation of sprites, 1 = round (flames ≈ 1.6). */
  stretch?: number;
  /** Irregular (lumpy) sprite edge — for smoke/dust; off for flames. */
  lumpy?: boolean;
  /** Random initial sprite rotation (off for stretched flames). */
  randomRotation?: boolean;
  /** Apply the renderer's tone mapping (off for emissive flames so they stay saturated). */
  toneMapped?: boolean;
  renderOrder?: number;
}

const VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aParams; // size, alpha, rotation, seed
attribute vec3 aColor;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = viewMatrix * vec4( aOffset, 1.0 );
  float c = cos( aParams.z );
  float s = sin( aParams.z );
  vec2 q = vec2( c * position.x - s * position.y, s * position.x + c * position.y ) * aParams.x;
  q.y *= STRETCH;
  mvPosition.xy += q;
  gl_Position = projectionMatrix * mvPosition;
  vUv = position.xy + 0.5;
  vAlpha = aParams.y;
  vColor = aColor;
  vSeed = aParams.w;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uSoft;
uniform float uLight;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec2 d = vUv - 0.5;
  float r = length( d ) * 2.0;
  #ifdef LUMPY
  float ang = atan( d.y, d.x );
  float edge = 1.0 + 0.13 * sin( ang * 5.0 + vSeed * 31.0 ) + 0.08 * sin( ang * 3.0 - vSeed * 17.0 );
  float a = ( 1.0 - smoothstep( 1.0 - uSoft, 1.0, r / edge ) ) * vAlpha;
  #else
  // flame tongue: round bottom, pointed (slightly bent) top
  vec2 p = d * 2.0;
  p.x += ( vSeed - 0.5 ) * 0.5 * max( p.y, 0.0 );
  float taper = 1.0 + 2.6 * max( p.y, 0.0 );
  float rr = length( vec2( p.x * taper, p.y ) );
  float a = ( 1.0 - smoothstep( 1.0 - uSoft, 1.0, rr ) ) * vAlpha;
  #endif
  if ( a < 0.003 ) discard;
  #ifdef LIT
  vec3 col = vColor * mix( 0.8, 1.1, vUv.y ) * uLight;
  #elif defined( LUMPY )
  vec3 col = vColor;
  #else
  vec3 col = vColor * ( 1.0 + 0.35 * ( 1.0 - clamp( rr, 0.0, 1.0 ) ) );
  #endif
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef ADDITIVE
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      gl_FragColor.a *= 1.0 - fogFactor;
    #endif
  #else
    #include <fog_fragment>
  #endif
}
`;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  /** Live particle limit (≤ capacity) — lowered on cheaper quality tiers to bound transparent overdraw. */
  limit: number;
  alive = 0;
  private readonly randomRotation: boolean;
  /** Scene light factor for lit pools (0..1+). */
  readonly uniforms: { uSoft: { value: number }; uLight: { value: number } };

  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;

  // Simulation state (structure of arrays).
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array; // size0, size1
  private readonly alpha: Float32Array;
  private readonly col: Float32Array; // r0 g0 b0 r1 g1 b1
  private readonly phys: Float32Array; // drag, gravity (+up/-down accel), windK, spin
  private readonly rot: Float32Array;
  private readonly seed: Float32Array;

  constructor(opts: ParticlePoolOptions) {
    const cap = opts.capacity;
    this.capacity = cap;
    this.limit = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.size = new Float32Array(cap * 2);
    this.alpha = new Float32Array(cap);
    this.col = new Float32Array(cap * 6);
    this.phys = new Float32Array(cap * 4);
    this.rot = new Float32Array(cap);
    this.seed = new Float32Array(cap);

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aOffset', this.aOffset);
    this.geo.setAttribute('aParams', this.aParams);
    this.geo.setAttribute('aColor', this.aColor);
    this.geo.instanceCount = 0;

    this.uniforms = { uSoft: { value: opts.softness }, uLight: { value: 1 } };
    const defines: Record<string, string> = { STRETCH: (opts.stretch ?? 1).toFixed(3) };
    if (opts.additive) defines.ADDITIVE = '';
    if (opts.lit) defines.LIT = '';
    if (opts.lumpy ?? true) defines.LUMPY = '';
    this.randomRotation = opts.randomRotation ?? true;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, this.uniforms]),
      defines,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: opts.toneMapped ?? true,
    });
    // UniformsUtils.merge clones values; re-link our uniform objects so updates propagate.
    this.material.uniforms.uSoft = this.uniforms.uSoft;
    this.material.uniforms.uLight = this.uniforms.uLight;
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 5;
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * Spawn a particle. Returns false when the pool is full.
   * gravity: vertical acceleration (+ = buoyant up, − = falls); drag: velocity damping per second;
   * windK: how strongly the particle is pushed toward the wind velocity; spin: rad/s.
   */
  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number, alpha: number,
    r0: number, g0: number, b0: number, r1: number, g1: number, b1: number,
    drag: number, gravity: number, windK: number, spin: number,
  ): boolean {
    if (this.alive >= Math.min(this.capacity, this.limit)) return false;
    const i = this.alive++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, life);
    this.size[i * 2] = size0;
    this.size[i * 2 + 1] = size1;
    this.alpha[i] = alpha;
    const i6 = i * 6;
    this.col[i6] = r0;
    this.col[i6 + 1] = g0;
    this.col[i6 + 2] = b0;
    this.col[i6 + 3] = r1;
    this.col[i6 + 4] = g1;
    this.col[i6 + 5] = b1;
    const i4 = i * 4;
    this.phys[i4] = drag;
    this.phys[i4 + 1] = gravity;
    this.phys[i4 + 2] = windK;
    this.phys[i4 + 3] = spin;
    this.rot[i] = this.randomRotation ? Math.random() * Math.PI * 2 : 0;
    this.seed[i] = Math.random();
    return true;
  }

  clear(): void {
    this.alive = 0;
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
  }

  /** Integrate, retire dead particles and upload the alive ones. `groundAt` (optional) stops falling particles. */
  update(dt: number, windX: number, windZ: number): void {
    const P = this.pos;
    const V = this.vel;
    let i = 0;
    while (i < this.alive) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      const i4 = i * 4;
      const drag = this.phys[i4];
      const grav = this.phys[i4 + 1];
      const wk = this.phys[i4 + 2];
      const k = Math.max(0, 1 - drag * dt);
      V[i3] = (V[i3] + (windX - V[i3]) * wk * dt) * k;
      V[i3 + 1] = V[i3 + 1] * k + grav * dt;
      V[i3 + 2] = (V[i3 + 2] + (windZ - V[i3 + 2]) * wk * dt) * k;
      P[i3] += V[i3] * dt;
      P[i3 + 1] += V[i3 + 1] * dt;
      P[i3 + 2] += V[i3 + 2] * dt;
      this.rot[i] += this.phys[i4 + 3] * dt;
      i++;
    }
    // Upload.
    const off = this.aOffset.array as Float32Array;
    const par = this.aParams.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    for (let j = 0; j < this.alive; j++) {
      const t = this.age[j] / this.life[j];
      const j3 = j * 3;
      off[j3] = P[j3];
      off[j3 + 1] = P[j3 + 1];
      off[j3 + 2] = P[j3 + 2];
      const grow = 1 - (1 - t) * (1 - t);
      const s0 = this.size[j * 2];
      const s1 = this.size[j * 2 + 1];
      const fadeIn = t < 0.1 ? t / 0.1 : 1;
      const fadeOut = t > 0.45 ? 1 - (t - 0.45) / 0.55 : 1;
      const j4 = j * 4;
      par[j4] = s0 + (s1 - s0) * grow;
      par[j4 + 1] = this.alpha[j] * fadeIn * fadeOut * fadeOut;
      par[j4 + 2] = this.rot[j];
      par[j4 + 3] = this.seed[j];
      const j6 = j * 6;
      col[j3] = this.col[j6] + (this.col[j6 + 3] - this.col[j6]) * t;
      col[j3 + 1] = this.col[j6 + 1] + (this.col[j6 + 4] - this.col[j6 + 1]) * t;
      col[j3 + 2] = this.col[j6 + 2] + (this.col[j6 + 5] - this.col[j6 + 2]) * t;
    }
    this.geo.instanceCount = this.alive;
    // no empty draw call while nothing is alive
    this.mesh.visible = this.alive > 0;
    if (this.alive > 0) {
      this.aOffset.needsUpdate = true;
      this.aParams.needsUpdate = true;
      this.aColor.needsUpdate = true;
    }
  }

  /** Clamp particles that fell below `minY` (chips/splashes) — kill them. */
  killBelow(minYAt: (x: number, z: number) => number): void {
    let i = 0;
    while (i < this.alive) {
      const i3 = i * 3;
      if (this.vel[i3 + 1] < 0 && this.phys[i * 4 + 1] < 0 && this.pos[i3 + 1] < minYAt(this.pos[i3], this.pos[i3 + 2])) {
        this.kill(i);
        continue;
      }
      i++;
    }
  }

  private kill(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    const i3 = i * 3;
    const l3 = last * 3;
    this.pos[i3] = this.pos[l3];
    this.pos[i3 + 1] = this.pos[l3 + 1];
    this.pos[i3 + 2] = this.pos[l3 + 2];
    this.vel[i3] = this.vel[l3];
    this.vel[i3 + 1] = this.vel[l3 + 1];
    this.vel[i3 + 2] = this.vel[l3 + 2];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.size[i * 2] = this.size[last * 2];
    this.size[i * 2 + 1] = this.size[last * 2 + 1];
    this.alpha[i] = this.alpha[last];
    for (let k = 0; k < 6; k++) this.col[i * 6 + k] = this.col[last * 6 + k];
    for (let k = 0; k < 4; k++) this.phys[i * 4 + k] = this.phys[last * 4 + k];
    this.rot[i] = this.rot[last];
    this.seed[i] = this.seed[last];
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
