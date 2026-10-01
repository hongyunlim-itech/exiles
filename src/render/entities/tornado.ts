/**
 * Tornado funnel: a flared, bending, swirling translucent cone (procedural shader) plus orbiting debris chunks.
 * The EffectsRenderer positions it from `state.tornado` and adds dust particles at its base.
 */
import * as THREE from 'three';

export const FUNNEL_HEIGHT = 17;
const RINGS = 22;
const SEGS = 28;
const DEBRIS = 48;

const VERT = /* glsl */ `
attribute float aH;
uniform float uTime;
varying float vH;
varying float vAng;
varying vec3 vN;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  float bend = aH * aH;
  p.x += sin( aH * 3.0 + uTime * 0.7 ) * 1.6 * bend;
  p.z += cos( aH * 2.3 + uTime * 0.55 ) * 1.2 * bend;
  vH = aH;
  vAng = atan( position.z, position.x );
  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  vN = normalize( normalMatrix * normalize( vec3( position.x, 0.0, position.z ) ) );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uColor;
uniform float uLight;
varying float vH;
varying float vAng;
varying vec3 vN;
#include <common>
#include <fog_pars_fragment>
float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
void main() {
  float a = vAng / 6.2831853;
  vec2 uv = vec2( a * 5.0 - uTime * 1.6 + vH * 2.5, vH * 6.0 - uTime * 0.8 );
  float n = vnoise( uv * vec2( 3.0, 1.0 ) ) * 0.6 + vnoise( uv * vec2( 7.0, 2.3 ) + 3.1 ) * 0.4;
  float bands = smoothstep( 0.3, 0.8, n );
  float rim = 0.55 + 0.45 * abs( vN.z );
  float fade = smoothstep( 0.0, 0.08, vH ) * ( 1.0 - smoothstep( 0.75, 1.0, vH ) );
  float alpha = ( 0.28 + 0.55 * bands ) * fade * uAlpha * rim;
  if ( alpha < 0.004 ) discard;
  vec3 col = uColor * ( 0.7 + 0.45 * n ) * uLight;
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function buildFunnelGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const hs: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= RINGS; r++) {
    const h = r / RINGS;
    const radius = 0.55 + 5.8 * Math.pow(h, 1.9);
    for (let s = 0; s <= SEGS; s++) {
      const a = (s / SEGS) * Math.PI * 2;
      pos.push(Math.cos(a) * radius, h * FUNNEL_HEIGHT, Math.sin(a) * radius);
      hs.push(h);
    }
  }
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SEGS; s++) {
      const a = r * (SEGS + 1) + s;
      const b = a + SEGS + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hs, 1));
  g.setIndex(idx);
  return g;
}

/** Radius of the funnel at normalised height h (matches the geometry). */
export function funnelRadius(h: number): number {
  return 0.55 + 5.8 * Math.pow(Math.max(0, Math.min(1, h)), 1.9);
}

export class Tornado {
  readonly group = new THREE.Group();
  readonly uniforms = {
    uTime: { value: 0 },
    uAlpha: { value: 0 },
    uColor: { value: new THREE.Color(0x7a7266) },
    uLight: { value: 1 },
  };
  private readonly funnel: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private readonly debris: THREE.InstancedMesh;
  private readonly seeds = new Float32Array(DEBRIS * 4);
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  /** 0..1 appearance (fades in/out). */
  presence = 0;

  constructor() {
    const geo = buildFunnelGeometry();
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, this.uniforms);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    this.funnel = new THREE.Mesh(geo, mat);
    this.funnel.frustumCulled = false;
    this.funnel.renderOrder = 7;
    this.inner = new THREE.Mesh(geo, mat);
    this.inner.scale.set(0.6, 0.97, 0.6);
    this.inner.frustumCulled = false;
    this.inner.renderOrder = 6;
    const debrisGeo = new THREE.BoxGeometry(0.16, 0.08, 0.12);
    const debrisMat = new THREE.MeshLambertMaterial({ color: 0x5a4a3a, flatShading: true });
    this.debris = new THREE.InstancedMesh(debrisGeo, debrisMat, DEBRIS);
    this.debris.frustumCulled = false;
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.Color();
    for (let i = 0; i < DEBRIS; i++) {
      this.seeds[i * 4] = Math.random();
      this.seeds[i * 4 + 1] = Math.random();
      this.seeds[i * 4 + 2] = Math.random();
      this.seeds[i * 4 + 3] = Math.random();
      c.setHex([0x5a4a3a, 0x6b5a44, 0x3e3a34, 0x4a6a3a, 0x7a5534][i % 5]);
      this.debris.setColorAt(i, c);
    }
    this.group.add(this.inner, this.funnel, this.debris);
    this.group.visible = false;
  }

  /** Place at (x, y, z) and animate. `presence` 0..1 fades the whole effect. */
  update(time: number, x: number, y: number, z: number, presence: number, light: number): void {
    this.presence = presence;
    this.group.visible = presence > 0.01;
    if (!this.group.visible) return;
    this.group.position.set(x, y, z);
    this.uniforms.uTime.value = time;
    this.uniforms.uAlpha.value = presence;
    this.uniforms.uLight.value = light;
    this.funnel.rotation.y = -time * 2.2;
    this.inner.rotation.y = -time * 3.1;
    for (let i = 0; i < DEBRIS; i++) {
      const s0 = this.seeds[i * 4];
      const s1 = this.seeds[i * 4 + 1];
      const s2 = this.seeds[i * 4 + 2];
      const s3 = this.seeds[i * 4 + 3];
      const h = (s0 + time * (0.05 + s1 * 0.06)) % 1;
      const hh = h * 0.7;
      const ang = s2 * Math.PI * 2 + time * (2.5 + s3 * 2);
      const r = funnelRadius(hh) * (0.9 + s3 * 0.35) + 0.2;
      const bend = hh * hh;
      this._p.set(
        Math.cos(ang) * r + Math.sin(hh * 3 + time * 0.7) * 1.6 * bend,
        hh * FUNNEL_HEIGHT,
        Math.sin(ang) * r + Math.cos(hh * 2.3 + time * 0.55) * 1.2 * bend,
      );
      this._e.set(time * (3 + s1 * 4), time * (2 + s2 * 3), s0 * 6);
      this._q.setFromEuler(this._e);
      const sc = (0.6 + s0 * 1.2) * presence;
      this._m.compose(this._p, this._q, this._s.set(sc, sc, sc));
      this.debris.setMatrixAt(i, this._m);
    }
    this.debris.instanceMatrix.needsUpdate = true;
    this.group.updateMatrixWorld(true);
  }

  dispose(): void {
    this.funnel.geometry.dispose();
    (this.funnel.material as THREE.Material).dispose();
    this.debris.geometry.dispose();
    (this.debris.material as THREE.Material).dispose();
    this.debris.dispose();
  }
}
