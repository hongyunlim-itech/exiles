/**
 * Patched MeshLambertMaterial used by instanced nature/crop/marker meshes (render-entities).
 *
 * Features (enabled per material through defines):
 *  - EN_FOLIAGE: seasonal foliage colours (green → per-tree autumn colour → brown) computed in the fragment shader
 *    from shared uniforms, and leaf fall/regrowth by shrinking foliage blobs toward their `aCenter`.
 *  - EN_TINT: blossom colour per instance (`aTint`) mixed into foliage in spring (orchards).
 *  - EN_SWAY: wind sway of vertices above SWAY_START (world-space wind converted into instance space).
 *  - EN_SNOW: snow on upward-facing faces, driven by the ground snow cover.
 *  - EN_VARY: per-instance brightness variation from aInst.x (rocks).
 *  - EN_MARKBAND: red paint band on trunks of trees marked for removal (aInst.y > 0.5).
 *  - EN_MARKER: spinning & bobbing removal markers, scaled with camera distance.
 *  - EN_INSTSHRINK: every part shrinks toward its aCenter by aInst.z (orchard fruit amount).
 *  - EN_COAT: per-instance coat colour (`aTint`) multiplied onto aPart == 0 faces only (animals: fixed-colour
 *    muzzles/horns/beaks use aPart 2).
 * A matching MeshDepthMaterial (same vertex deformation) is provided for shadow casting.
 *
 * Per-instance attribute `aInst` (vec4): x = random variation 0..1, y = marked 0/1, z = growth/maturity 0..1,
 * w = stagger 0..1 (per-tree offset of leaf fall / autumn turn).
 */
import * as THREE from 'three';

export interface EnvUniforms {
  uTime: { value: number };
  uSnow: { value: number };
  uSnowColor: { value: THREE.Color };
  /** (dirX, dirZ, strength 0..1). */
  uWind: { value: THREE.Vector3 };
  uMarkerScale: { value: number };
}

export interface FoliageUniforms {
  uLeaf: { value: number };
  uGreen: { value: THREE.Color };
  uAutA: { value: THREE.Color };
  uAutB: { value: THREE.Color };
  uAutC: { value: THREE.Color };
  uBrownCol: { value: THREE.Color };
  uBrown: { value: number };
  uAutumn: { value: number };
  uBlossom: { value: number };
}

export function createEnvUniforms(): EnvUniforms {
  return {
    uTime: { value: 0 },
    uSnow: { value: 0 },
    uSnowColor: { value: new THREE.Color(0xeef3f7) },
    uWind: { value: new THREE.Vector3(1, 0, 0.3) },
    uMarkerScale: { value: 1 },
  };
}

export function createFoliageUniforms(): FoliageUniforms {
  return {
    uLeaf: { value: 1 },
    uGreen: { value: new THREE.Color(0x5f8a38) },
    uAutA: { value: new THREE.Color(0xb3452a) },
    uAutB: { value: new THREE.Color(0xd27a28) },
    uAutC: { value: new THREE.Color(0xd6a53a) },
    uBrownCol: { value: new THREE.Color(0x8a6038) },
    uBrown: { value: 0 },
    uAutumn: { value: 0 },
    uBlossom: { value: 0 },
  };
}

export interface EntityMaterialOptions {
  /** Unique program-cache key (the injected code differs per option set). */
  key: string;
  /** Geometry has aPart/aCenter attributes. */
  parts?: boolean;
  /** Geometry has the per-instance aInst attribute. */
  inst?: boolean;
  foliage?: FoliageUniforms;
  tint?: boolean;
  sway?: { start: number; amp: number };
  snow?: { lo: number; hi: number; amount: number };
  vary?: boolean;
  markBand?: boolean;
  marker?: boolean;
  /** Per-instance coat colour on aPart == 0 faces (requires parts + tint). */
  coat?: boolean;
  /** Shrink parts toward aCenter by aInst.z (requires parts + inst). */
  instShrink?: boolean;
  /** Use per-vertex colours (default true). */
  vertexColors?: boolean;
  side?: THREE.Side;
  emissive?: number;
  color?: number;
  /** Also build a depth material for shadows with the same vertex deformation. */
  depth?: boolean;
}

export interface EntityMaterials {
  material: THREE.MeshLambertMaterial;
  depth: THREE.MeshDepthMaterial | null;
}

function f(v: number): string {
  return v.toFixed(4);
}

const VERTEX_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
#ifdef EN_FOLIAGE
uniform float uLeaf;
#endif
#ifdef EN_MARKER
uniform float uMarkerScale;
#endif
#ifdef EN_INST
attribute vec4 aInst;
#endif
#ifdef EN_PARTS
attribute float aPart;
attribute vec3 aCenter;
#endif
#ifdef EN_TINT
attribute vec3 aTint;
#endif
#ifndef EN_DEPTH
  #ifdef EN_INST
  varying vec4 vInst;
  #endif
  #ifdef EN_PARTS
  varying float vPart;
  varying float vLocalY;
  #endif
  #ifdef EN_TINT
  varying vec3 vTint;
  #endif
#endif
`;

const BEGIN_VERTEX = /* glsl */ `
vec3 transformed = vec3( position );
#ifndef EN_DEPTH
  #ifdef EN_INST
  vInst = aInst;
  #endif
  #ifdef EN_PARTS
  vPart = aPart;
  vLocalY = position.y;
  #endif
  #ifdef EN_TINT
  vTint = aTint;
  #endif
#endif
#if defined( EN_FOLIAGE ) && defined( EN_PARTS )
if ( aPart > 0.5 && aPart < 1.5 ) {
  #ifdef EN_INST
  float stagger = aInst.w;
  #else
  float stagger = 0.5;
  #endif
  float leafI = clamp( uLeaf * 1.35 - stagger * 0.35, 0.0, 1.0 );
  transformed = aCenter + ( transformed - aCenter ) * leafI;
}
#endif
#if defined( EN_INSTSHRINK ) && defined( EN_INST ) && defined( EN_PARTS )
transformed = aCenter + ( transformed - aCenter ) * aInst.z;
#endif
#ifdef EN_MARKER
{
  #ifdef EN_INST
  float ph = aInst.x * 6.2831;
  #else
  float ph = 0.0;
  #endif
  float ang = uTime * 2.2 + ph;
  float cs = cos( ang );
  float sn = sin( ang );
  transformed.xz = vec2( cs * transformed.x - sn * transformed.z, sn * transformed.x + cs * transformed.z );
  transformed *= uMarkerScale;
  transformed.y += sin( uTime * 3.1 + ph ) * 0.06 * uMarkerScale;
}
#endif
#if defined( EN_SWAY ) && defined( USE_INSTANCING )
{
  vec3 ip = instanceMatrix[3].xyz;
  float h = max( position.y - SWAY_START, 0.0 );
  float gust = sin( uTime * 1.6 + ip.x * 0.37 + ip.z * 0.23 ) * 0.6 + sin( uTime * 2.7 + ip.x * 0.91 - ip.z * 0.57 ) * 0.4;
  float amp = h * SWAY_AMP * ( uWind.z * 0.8 + ( 0.25 + uWind.z ) * gust );
  vec3 wOff = vec3( uWind.x, 0.0, uWind.y ) * amp;
  vec3 c0 = instanceMatrix[0].xyz;
  vec3 c2 = instanceMatrix[2].xyz;
  transformed.x += dot( wOff, c0 ) / max( dot( c0, c0 ), 1e-4 );
  transformed.z += dot( wOff, c2 ) / max( dot( c2, c2 ), 1e-4 );
}
#endif
`;

const FRAGMENT_PARS = /* glsl */ `
uniform float uSnow;
uniform vec3 uSnowColor;
#ifdef EN_FOLIAGE
uniform vec3 uGreen;
uniform vec3 uAutA;
uniform vec3 uAutB;
uniform vec3 uAutC;
uniform vec3 uBrownCol;
uniform float uBrown;
uniform float uAutumn;
uniform float uBlossom;
#endif
#ifdef EN_INST
varying vec4 vInst;
#endif
#ifdef EN_PARTS
varying float vPart;
varying float vLocalY;
#endif
#ifdef EN_TINT
varying vec3 vTint;
#endif
`;

const COLOR_FRAGMENT = /* glsl */ `
#include <color_fragment>
#if defined( EN_FOLIAGE ) && defined( EN_PARTS )
if ( vPart > 0.5 && vPart < 1.5 ) {
  #ifdef EN_INST
  float v = vInst.x;
  float stg = vInst.w;
  #else
  float v = 0.5;
  float stg = 0.5;
  #endif
  vec3 green = uGreen * ( 0.9 + v * 0.2 );
  float pick = fract( v * 7.31 );
  vec3 aut = pick < 0.34 ? uAutA : ( pick < 0.67 ? uAutB : uAutC );
  aut = mix( aut, uBrownCol, uBrown * ( 0.55 + 0.45 * fract( v * 3.7 ) ) );
  float turn = clamp( uAutumn * 1.5 - stg * 0.5, 0.0, 1.0 );
  vec3 leafCol = mix( green, aut, turn );
  #ifdef EN_TINT
  float bl = uBlossom * step( 0.3, vColor.g );
  #ifdef EN_INST
  bl *= step( 0.45, vInst.z );
  #endif
  leafCol = mix( leafCol, vTint, bl * 0.92 );
  #endif
  diffuseColor.rgb = diffuse * leafCol * vColor.r;
}
#endif
#if defined( EN_MARKBAND ) && defined( EN_INST ) && defined( EN_PARTS )
if ( vPart < 0.5 && vInst.y > 0.5 && vLocalY > 0.3 && vLocalY < 0.44 ) diffuseColor.rgb = vec3( 0.78, 0.13, 0.06 );
#endif
#if defined( EN_VARY ) && defined( EN_INST )
diffuseColor.rgb *= 0.86 + vInst.x * 0.28;
#endif
#if defined( EN_COAT ) && defined( EN_TINT ) && defined( EN_PARTS )
if ( vPart < 0.5 ) diffuseColor.rgb *= vTint;
#endif
`;

const SNOW_FRAGMENT = /* glsl */ `
#include <normal_fragment_maps>
#ifdef EN_SNOW
{
  vec3 wN = inverseTransformDirection( normal, viewMatrix );
  float sAmt = uSnow * SNOW_AMOUNT * smoothstep( SNOW_LO, SNOW_HI, wN.y );
  diffuseColor.rgb = mix( diffuseColor.rgb, uSnowColor, clamp( sAmt, 0.0, 1.0 ) );
}
#endif
`;

function buildDefines(o: EntityMaterialOptions, depth: boolean): Record<string, string> {
  const d: Record<string, string> = {};
  if (depth) d.EN_DEPTH = '';
  if (o.inst) d.EN_INST = '';
  if (o.parts) d.EN_PARTS = '';
  if (o.foliage) d.EN_FOLIAGE = '';
  if (o.tint) d.EN_TINT = '';
  if (o.sway) {
    d.EN_SWAY = '';
    d.SWAY_START = f(o.sway.start);
    d.SWAY_AMP = f(o.sway.amp);
  }
  if (o.marker) d.EN_MARKER = '';
  if (o.instShrink) d.EN_INSTSHRINK = '';
  if (!depth) {
    if (o.snow) {
      d.EN_SNOW = '';
      d.SNOW_LO = f(o.snow.lo);
      d.SNOW_HI = f(o.snow.hi);
      d.SNOW_AMOUNT = f(o.snow.amount);
    }
    if (o.vary) d.EN_VARY = '';
    if (o.markBand) d.EN_MARKBAND = '';
    if (o.coat) d.EN_COAT = '';
  }
  return d;
}

function assignUniforms(target: Record<string, THREE.IUniform>, env: EnvUniforms, fol?: FoliageUniforms): void {
  target.uTime = env.uTime;
  target.uWind = env.uWind;
  target.uSnow = env.uSnow;
  target.uSnowColor = env.uSnowColor;
  target.uMarkerScale = env.uMarkerScale;
  if (fol) {
    target.uLeaf = fol.uLeaf;
    target.uGreen = fol.uGreen;
    target.uAutA = fol.uAutA;
    target.uAutB = fol.uAutB;
    target.uAutC = fol.uAutC;
    target.uBrownCol = fol.uBrownCol;
    target.uBrown = fol.uBrown;
    target.uAutumn = fol.uAutumn;
    target.uBlossom = fol.uBlossom;
  }
}

/** Create a patched Lambert material (+ optional matching depth material) sharing `env` uniforms. */
export function createEntityMaterial(env: EnvUniforms, o: EntityMaterialOptions): EntityMaterials {
  const material = new THREE.MeshLambertMaterial({
    color: o.color ?? 0xffffff,
    vertexColors: o.vertexColors ?? true,
    flatShading: true,
    side: o.side ?? THREE.FrontSide,
    emissive: o.emissive ?? 0x000000,
  });
  material.defines = buildDefines(o, false);
  material.onBeforeCompile = (shader) => {
    assignUniforms(shader.uniforms, env, o.foliage);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', BEGIN_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', COLOR_FRAGMENT)
      .replace('#include <normal_fragment_maps>', SNOW_FRAGMENT);
  };
  material.customProgramCacheKey = () => `entity-${o.key}`;

  let depth: THREE.MeshDepthMaterial | null = null;
  if (o.depth) {
    depth = new THREE.MeshDepthMaterial();
    depth.defines = buildDefines(o, true);
    depth.onBeforeCompile = (shader) => {
      assignUniforms(shader.uniforms, env, o.foliage);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
        .replace('#include <begin_vertex>', BEGIN_VERTEX);
    };
    depth.customProgramCacheKey = () => `entity-depth-${o.key}`;
  }
  return { material, depth };
}

/** Copy an sRGB 0..1 triple into a (linear working space) THREE.Color uniform. */
export function setSRGB(c: THREE.Color, rgb: readonly number[]): void {
  c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}
