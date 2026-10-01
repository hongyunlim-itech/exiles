/**
 * Building material: MeshLambertMaterial (vertex colours, flat shading) extended via onBeforeCompile with
 *  - snow on upward faces (global uSnow, patchy world-space noise, masked by fx.y)
 *  - night window glow (global uNight × per-material uLit, weighted by fx.x)
 *  - ember glow (fx.z × (base + uEmber))
 *  - char/burn darkening + flickering ember emissive (per-material uChar / uBurn)
 *  - selection highlight emissive (per-material uHighlight)
 *  - bottom-up reveal: fragments above model-space y = uReveal (+ jagged noise uJag) are discarded
 *    (construction, demolition and ruins). A matching depth material keeps shadows consistent.
 * All variants share ONE compiled program (customProgramCacheKey) — per-material uniforms only.
 */
import * as THREE from 'three';

export interface BuildingUniforms {
  uChar: { value: number };
  uBurn: { value: number };
  uLit: { value: number };
  uHighlight: { value: number };
  uReveal: { value: number };
  uJag: { value: number };
  uEmber: { value: number };
}

/** Global uniforms shared by every building material (updated once per frame by BuildingRenderer). */
export const GLOBAL_UNIFORMS = {
  uSnow: { value: 0 },
  uNight: { value: 0 },
  uTime: { value: 0 },
};

export const NO_REVEAL = 1e5;

const HASH = /* glsl */ `
float exHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float exVN(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = exHash(i);
  float b = exHash(i + vec2(1.0, 0.0));
  float c = exHash(i + vec2(0.0, 1.0));
  float d = exHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const CUT = /* glsl */ `
  {
    float exCut = uReveal + uJag * (exHash(floor(vLocalPos.xz * 2.5) + 0.37) - 0.5);
    if (vLocalPos.y > exCut) discard;
  }
`;

const VERT_PARS = /* glsl */ `
attribute vec3 fx;
varying vec3 vFx;
varying vec3 vLocalPos;
varying vec3 vWPos;
`;

const FRAG_PARS = /* glsl */ `
uniform float uSnow;
uniform float uNight;
uniform float uTime;
uniform float uChar;
uniform float uBurn;
uniform float uLit;
uniform float uHighlight;
uniform float uReveal;
uniform float uJag;
uniform float uEmber;
varying vec3 vFx;
varying vec3 vLocalPos;
varying vec3 vWPos;
${HASH}
`;

const FRAG_SURFACE = /* glsl */ `
  {
    float exSnow = 0.0;
    if (uSnow > 0.001) {
      vec3 exN = inverseTransformDirection(normal, viewMatrix);
      float exUp = smoothstep(0.28, 0.72, exN.y);
      // finer noise and a soft threshold: partial cover reads as a dusting that thickens, not camouflage blotches
      float exNoise = 0.6 * exVN(vWPos.xz * 4.6 + vWPos.y) + 0.4 * exVN(vWPos.xz * 11.0 + 7.0);
      // roofs hold snow longer than the ground: they whiten quickly and keep only small bare patches
      float exS = clamp(uSnow * 1.7, 0.0, 1.2);
      float exT = 0.05 + 0.75 * exNoise;
      exSnow = vFx.y * exUp * smoothstep(exT - 0.12, exT + 0.22, exS);
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.036), clamp(uChar, 0.0, 1.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.9), exSnow * (1.0 - clamp(uChar, 0.0, 1.0)));
    totalEmissiveRadiance += vFx.x * uNight * uLit * vec3(1.0, 0.56, 0.2) * 1.7;
    totalEmissiveRadiance += vFx.z * (0.35 + uEmber) * vec3(1.0, 0.33, 0.07);
    float exFlick = 0.7 + 0.3 * sin(uTime * 9.0 + vWPos.x * 2.3 + vWPos.z * 1.7) * sin(uTime * 5.3 + vWPos.y * 3.0);
    if (uBurn > 0.001) {
      vec2 exQ = vWPos.xz * 3.4 + vec2(vWPos.y * 2.1, -vWPos.y * 1.7);
      float exN2 = exVN(exQ + uTime * 0.12) * 0.62 + exVN(exQ * 2.3 - uTime * 0.2) * 0.38;
      float exThr = 1.0 - uBurn * 0.42;
      float exEmb = smoothstep(exThr, exThr + 0.1, exN2);
      totalEmissiveRadiance += exEmb * exFlick * vec3(1.0, 0.24, 0.03) * (0.35 + uBurn * 0.9);
    }
    totalEmissiveRadiance += uHighlight * vec3(0.32, 0.25, 0.1);
  }
`;

function patchBuildingShader(shader: THREE.WebGLProgramParametersWithUniforms, u: BuildingUniforms): void {
  Object.assign(shader.uniforms, GLOBAL_UNIFORMS, u);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLocalPos = transformed;\n  vFx = fx;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
  #ifdef USE_INSTANCING
    vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_SURFACE}`);
}

export function makeBuildingUniforms(): BuildingUniforms {
  return {
    uChar: { value: 0 },
    uBurn: { value: 0 },
    uLit: { value: 1 },
    uHighlight: { value: 0 },
    uReveal: { value: NO_REVEAL },
    uJag: { value: 0 },
    uEmber: { value: 0 },
  };
}

export interface BuildingMaterial extends THREE.MeshLambertMaterial {
  userData: { uniforms: BuildingUniforms; depth?: THREE.MeshDepthMaterial };
}

/** Create a new building material (own uniforms, shared program). */
export function createBuildingMaterial(opts?: { lit?: boolean; doubleSide?: boolean }): BuildingMaterial {
  const u = makeBuildingUniforms();
  u.uLit.value = opts?.lit === false ? 0 : 1;
  const m = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: opts?.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  }) as BuildingMaterial;
  m.userData = { uniforms: u };
  m.onBeforeCompile = (shader) => patchBuildingShader(shader, u);
  m.customProgramCacheKey = () => 'exiles-building-v1';
  return m;
}

/** Depth material for shadow casting that honours the reveal cut of `u`. */
export function createRevealDepthMaterial(u: BuildingUniforms): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = u.uReveal;
    shader.uniforms.uJag = u.uJag;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLocalPos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uReveal;\nuniform float uJag;\nvarying vec3 vLocalPos;\n${HASH}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT}`);
  };
  m.customProgramCacheKey = () => 'exiles-building-depth-v1';
  return m;
}

// ---- shared instances ---------------------------------------------------------------------------

let sharedLit: BuildingMaterial | null = null;
let sharedUnlit: BuildingMaterial | null = null;
let sharedProps: BuildingMaterial | null = null;

/** Shared material for active buildings whose windows light up at night. */
export function sharedLitMaterial(): BuildingMaterial {
  return (sharedLit ??= createBuildingMaterial({ lit: true }));
}

/** Shared material for buildings that stay dark at night (empty, unstaffed, zones, bridges). */
export function sharedUnlitMaterial(): BuildingMaterial {
  return (sharedUnlit ??= createBuildingMaterial({ lit: false }));
}

/** Shared material for props (piles, graves, scaffolding, stakes, boats). */
export function sharedPropMaterial(): BuildingMaterial {
  return (sharedProps ??= createBuildingMaterial({ lit: true }));
}

/** True if the material is one of the shared singletons (must not be disposed by models). */
export function isSharedMaterial(m: THREE.Material): boolean {
  return m === sharedLit || m === sharedUnlit || m === sharedProps;
}

/** Update the global uniforms (call once per frame). */
export function updateGlobalUniforms(snow: number, night: number, time: number): void {
  GLOBAL_UNIFORMS.uSnow.value = snow;
  GLOBAL_UNIFORMS.uNight.value = night;
  GLOBAL_UNIFORMS.uTime.value = time;
}
