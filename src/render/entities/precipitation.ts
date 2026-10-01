/**
 * GPU-only rain & snowfall around the camera. Each drop/flake has a fixed random seed; the vertex shader animates it
 * (fall + wind + flutter) and wraps it inside a box that follows the camera, so there is no CPU work per frame beyond
 * setting a few uniforms. Density = drawn instance count.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform float uTime;
uniform float uFall;
uniform vec2 uWind;
uniform float uSize;
uniform float uLen;
varying vec2 vUv;
varying float vFade;
#include <common>
#include <fog_pars_vertex>
void main() {
  float spd = 0.8 + 0.4 * aSeed.w;
  vec3 p = aSeed.xyz * uBox;
  p.y -= uTime * uFall * spd;
  p.x += uTime * uWind.x * spd;
  p.z += uTime * uWind.y * spd;
  #ifdef SNOW
  p.x += sin( uTime * 1.3 + aSeed.w * 40.0 ) * 0.45;
  p.z += cos( uTime * 1.1 + aSeed.x * 40.0 ) * 0.45;
  #endif
  vec3 lo = uCenter - 0.5 * uBox;
  p = lo + mod( p - lo, uBox );
  // fade near the box faces so wrapping is invisible
  vec3 q = abs( ( p - uCenter ) / ( 0.5 * uBox ) );
  float edge = 1.0 - smoothstep( 0.75, 1.0, max( max( q.x, q.y ), q.z ) );
  vec4 mv0 = viewMatrix * vec4( p, 1.0 );
  float camDist = -mv0.z;
  vFade = edge * smoothstep( 1.5, 4.0, camDist );
  vec4 mvPosition;
  #ifdef SNOW
  mvPosition = mv0;
  mvPosition.xy += position.xy * uSize * ( 0.7 + 0.6 * aSeed.w );
  #else
  // Streak: from the drop (head) back along its velocity (tail); widened sideways in world space,
  // perpendicular to both the fall direction and the view ray.
  vec3 vel = normalize( vec3( uWind.x, -uFall, uWind.y ) );
  vec3 tail = p - vel * uLen * ( 0.7 + 0.6 * aSeed.w );
  vec3 side = cross( vel, normalize( p - cameraPosition ) );
  side = side / max( length( side ), 1e-3 );
  vec3 wp = mix( p, tail, position.y + 0.5 ) + side * ( position.x * uSize );
  mvPosition = viewMatrix * vec4( wp, 1.0 );
  #endif
  gl_Position = projectionMatrix * mvPosition;
  vUv = position.xy + 0.5;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;
#include <common>
#include <fog_pars_fragment>
void main() {
  #ifdef SNOW
  float r = length( vUv - 0.5 ) * 2.0;
  float a = 1.0 - smoothstep( 0.35, 1.0, r );
  #else
  float a = ( 1.0 - abs( vUv.x - 0.5 ) * 2.0 ) * ( 1.0 - vUv.y * 0.85 ) * smoothstep( 0.0, 0.06, vUv.y );
  #endif
  a *= uOpacity * vFade;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Precipitation {
  readonly mesh: THREE.Mesh;
  readonly uniforms: {
    uCenter: { value: THREE.Vector3 };
    uBox: { value: THREE.Vector3 };
    uTime: { value: number };
    uFall: { value: number };
    uWind: { value: THREE.Vector2 };
    uSize: { value: number };
    uLen: { value: number };
    uColor: { value: THREE.Color };
    uOpacity: { value: number };
  };
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  constructor(readonly kind: 'rain' | 'snow', readonly capacity: number) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const seeds = new Float32Array(capacity * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = 0;
    const snow = kind === 'snow';
    this.uniforms = {
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(44, 30, 44) },
      uTime: { value: 0 },
      uFall: { value: snow ? 1.1 : 15 },
      uWind: { value: new THREE.Vector2() },
      uSize: { value: snow ? 0.09 : 0.022 },
      uLen: { value: snow ? 0 : 0.9 },
      uColor: { value: new THREE.Color(snow ? 0xffffff : 0xb8c4cc) },
      uOpacity: { value: snow ? 0.9 : 0.5 },
    };
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, this.uniforms);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      defines: snow ? { SNOW: '' } : {},
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /** Set the drawn count (0..capacity) — density. */
  setCount(n: number): void {
    const c = Math.max(0, Math.min(this.capacity, Math.floor(n)));
    this.geo.instanceCount = c;
    this.mesh.visible = c > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
