/**
 * Water material: MeshPhongMaterial (receives shadows & fog) patched with gentle multi-directional vertex waves and
 * matching analytic per-pixel normals + noise ripples (sun/moon glitter), depth-based shallow→deep colour, animated
 * shoreline foam, fresnel sky reflection, winter tint and shore ice. OWNER: render-scene.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';
import { PAL } from './palette';

export interface WaterUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uShallow: THREE.IUniform<THREE.Color>;
  uDeep: THREE.IUniform<THREE.Color>;
  uFoam: THREE.IUniform<THREE.Color>;
  uIceColor: THREE.IUniform<THREE.Color>;
  uWinterTint: THREE.IUniform<THREE.Color>;
  uSkyRefl: THREE.IUniform<THREE.Color>;
  /** 0..1 how far ice reaches out from the shore. */
  uIce: THREE.IUniform<number>;
  /** 0..1 winter colour shift. */
  uWinter: THREE.IUniform<number>;
  /** 0..1 extra choppiness (wind / rain). */
  uChop: THREE.IUniform<number>;
  /** Wind direction (x, z) unit vector. */
  uWind: THREE.IUniform<THREE.Vector2>;
  /** 0..1 daylight (foam & reflections calm down at night). */
  uDay: THREE.IUniform<number>;
}

export function createWaterUniforms(): WaterUniforms {
  return {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(PAL.waterShallow) },
    uDeep: { value: new THREE.Color(PAL.waterDeep) },
    uFoam: { value: new THREE.Color(PAL.foam) },
    uIceColor: { value: new THREE.Color(PAL.ice) },
    uWinterTint: { value: new THREE.Color(PAL.waterWinter) },
    uSkyRefl: { value: new THREE.Color(0.7, 0.8, 0.9) },
    uIce: { value: 0 },
    uWinter: { value: 0 },
    uChop: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
    uDay: { value: 1 },
  };
}

const VERT_HEAD = /* glsl */ `
attribute float aDepth;
attribute float aShore;
uniform float uTime;
uniform float uIce;
uniform float uChop;
uniform vec2 uWind;
uniform float uDay;
varying float vWDepth;
varying float vWShore;
varying float vWAmp;
varying vec3 vWPos;
`;

const VERT_BODY = /* glsl */ `
vWDepth = aDepth;
vWShore = aShore;
{
  vec3 wp0 = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float iceHere = smoothstep(uIce * 1.6, uIce * 1.6 - 0.8, aShore) * step(0.01, uIce);
  vWAmp = (0.035 + 0.03 * uChop) * smoothstep(0.02, 0.5, aDepth) * (1.0 - iceHere);
  vec2 p = wp0.xz;
  float t = uTime;
  vec2 d1 = vec2(0.61, 0.37) * 1.25;
  vec2 d2 = vec2(-0.29, 0.83) * 2.05;
  vec2 d3 = normalize(uWind + vec2(0.2, 0.1)) * 3.3;
  float w = sin(dot(p, d1) + t * 1.2) + 0.6 * sin(dot(p, d2) + t * 1.75) + 0.35 * sin(dot(p, d3) + t * 2.6);
  transformed.y += vWAmp * w;
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
}
`;

const FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uIceColor;
uniform vec3 uWinterTint;
uniform vec3 uSkyRefl;
uniform float uIce;
uniform float uWinter;
uniform float uChop;
uniform vec2 uWind;
uniform float uDay;
varying float vWDepth;
varying float vWShore;
varying float vWAmp;
varying vec3 vWPos;
${GLSL_NOISE}
float rsw_ice = 0.0;
float rsw_foam = 0.0;

// analytic normal of the vertex wave function + fine noise ripples (smooth sun glitter)
vec3 rsw_waveNormal(vec2 p) {
  float t = uTime;
  vec2 d1 = vec2(0.61, 0.37) * 1.25;
  vec2 d2 = vec2(-0.29, 0.83) * 2.05;
  vec2 d3 = normalize(uWind + vec2(0.2, 0.1)) * 3.3;
  vec2 g = cos(dot(p, d1) + t * 1.2) * d1 + 0.6 * cos(dot(p, d2) + t * 1.75) * d2 + 0.35 * cos(dot(p, d3) + t * 2.6) * d3;
  g *= vWAmp;
  float e = 0.12;
  vec2 q = p * 2.3 + vec2(t * 0.31, t * 0.23);
  float n0 = rs_noise(q);
  float nx = rs_noise(q + vec2(e, 0.0));
  float nz = rs_noise(q + vec2(0.0, e));
  vec2 q2 = p * 5.1 - vec2(t * 0.41, t * 0.19);
  float m0 = rs_noise(q2);
  float mx = rs_noise(q2 + vec2(e, 0.0));
  float mz = rs_noise(q2 + vec2(0.0, e));
  float rip = (0.016 + 0.025 * uChop) * smoothstep(0.02, 0.4, vWDepth);
  g += (vec2(nx - n0, nz - n0) + 0.5 * vec2(mx - m0, mz - m0)) / e * rip;
  return normalize(vec3(-g.x, 1.0, -g.y));
}
`;

const FRAG_COLOR = /* glsl */ `
{
  float wd = vWDepth;
  vec2 p = vWPos.xz;
  float rn = rs_noise(p * 0.6 + vec2(uTime * 0.05, uTime * 0.035));
  vec3 wcol = mix(uShallow, uDeep, smoothstep(0.08, 1.9, wd));
  wcol *= 0.92 + 0.16 * rn;
  wcol = mix(wcol, uWinterTint, uWinter * 0.35);

  // shoreline foam: pulsing band that follows the waterline
  float band = (1.0 - smoothstep(0.0, 0.16, wd)) * (1.0 - smoothstep(0.7, 1.6, vWShore));
  float fn = rs_noise(p * 3.2 + vec2(uTime * 0.21, -uTime * 0.17));
  float pulse = 0.55 + 0.45 * sin(uTime * 1.6 - vWShore * 9.0 + rn * 5.0);
  rsw_foam = band * smoothstep(0.5, 0.85, fn * pulse + band * 0.4) * step(0.001, wd + 0.05);
  // scattered whitecaps on choppy deep water
  rsw_foam = max(rsw_foam, uChop * smoothstep(0.82, 0.95, rs_noise(p * 1.7 + uTime * 0.4)) * smoothstep(0.4, 1.2, wd) * 0.6);

  // ice creeping out from the shore in hard frost
  if (uIce > 0.01) {
    float reach = uIce * 1.6 + (fn - 0.5) * 0.5;
    rsw_ice = smoothstep(reach, reach - 0.35, vWShore);
  }

  rsw_foam *= 0.45 + 0.55 * uDay;
  wcol = mix(wcol, uFoam, rsw_foam * 0.85 * (1.0 - rsw_ice));
  wcol = mix(wcol, uIceColor * (0.9 + 0.1 * fn), rsw_ice);
  diffuseColor.rgb = wcol;
  float alpha = mix(0.6, 0.93, smoothstep(0.0, 1.3, wd));
  alpha = max(alpha, max(rsw_foam * 0.92, rsw_ice * 0.97));
  diffuseColor.a = alpha;
}
`;

const FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
normal = normalize((viewMatrix * vec4(rsw_waveNormal(vWPos.xz), 0.0)).xyz);
`;

const FRAG_LIGHT = /* glsl */ `
#include <lights_fragment_end>
reflectedLight.directSpecular *= 1.0 - rsw_ice * 0.8 - rsw_foam * 0.6;
`;

const FRAG_OUT = /* glsl */ `
{
  vec3 V = normalize(cameraPosition - vWPos);
  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
  float refl = (0.06 + 0.42 * fres) * (1.0 - rsw_ice) * (1.0 - rsw_foam);
  outgoingLight = mix(outgoingLight, uSkyRefl, refl);
}
#include <opaque_fragment>
`;

export function createWaterMaterial(uniforms: WaterUniforms): THREE.MeshPhongMaterial {
  const mat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    specular: 0x4f585c,
    shininess: 180,
    flatShading: false,
    transparent: true,
    depthWrite: true,
  });
  mat.onBeforeCompile = (shader) => {
    for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <lights_fragment_end>', FRAG_LIGHT)
      .replace('#include <opaque_fragment>', FRAG_OUT);
  };
  mat.customProgramCacheKey = () => 'exiles-water-v2';
  return mat;
}
