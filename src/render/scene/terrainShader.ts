/**
 * Terrain material: MeshLambertMaterial (flat shaded, shadows, fog) patched via onBeforeCompile with
 *  - per-corner natural colour (sRGB bytes) + material (grassiness / snowiness / rockiness),
 *  - per-tile overlay patterns (roads w/ cobbles, furrowed soil, stubble, packed earth, zones) with soft ragged edges,
 *  - seasonal grass tint, patchy snow cover, height-based mountain snow caps, steep-slope rock,
 *  - world-space colour mottling and an optional anti-aliased tile grid.
 * All seasonal/snow/grid changes are uniform updates — geometry is never rebuilt for them. OWNER: render-scene.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';
import { PAL } from './palette';
import { OVERLAY_STYLES } from './terrainSurface';

export interface TerrainUniforms {
  [name: string]: THREE.IUniform;
  uGrassTint: THREE.IUniform<THREE.Color>;
  uSnow: THREE.IUniform<number>;
  uSnowColor: THREE.IUniform<THREE.Color>;
  uSnowLine: THREE.IUniform<number>;
  uRockColor: THREE.IUniform<THREE.Color>;
  uMountainColor: THREE.IUniform<THREE.Color>;
  uSandColor: THREE.IUniform<THREE.Color>;
  uGrid: THREE.IUniform<number>;
  uW: THREE.IUniform<number>;
  /** Debug view: 0 off, 1 vegetation colour, 2 smooth normal, 3 slope, 4 flat normal. */
  uDebug: THREE.IUniform<number>;
  uOvA: THREE.IUniform<THREE.Vector4[]>;
  uOvB: THREE.IUniform<THREE.Vector4[]>;
}

export function createTerrainUniforms(): TerrainUniforms {
  const ovA: THREE.Vector4[] = [];
  const ovB: THREE.Vector4[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < 16; i++) {
    const s = OVERLAY_STYLES[i];
    c.setHex(s.color);
    ovA.push(new THREE.Vector4(c.r, c.g, c.b, s.snow));
    ovB.push(new THREE.Vector4(s.grass, s.soft, s.edgeMin, 0));
  }
  return {
    uGrassTint: { value: new THREE.Color(1, 1, 1) },
    uSnow: { value: 0 },
    uSnowColor: { value: new THREE.Color(PAL.snow) },
    uSnowLine: { value: 1000 },
    uRockColor: { value: new THREE.Color(PAL.rock) },
    uMountainColor: { value: new THREE.Color(PAL.mountain) },
    uSandColor: { value: new THREE.Color(PAL.sand) },
    uGrid: { value: 0 },
    uW: { value: 1 },
    uDebug: { value: 0 },
    uOvA: { value: ovA },
    uOvB: { value: ovB },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aMat;
varying vec3 vTColor;
varying vec3 vTMat;
varying float vTSand;
varying vec3 vTWPos;
varying vec3 vTNormal;
#ifndef TERRAIN_RING
uniform int uW;
flat varying float vTOverlay;
flat varying vec2 vTTile;
#endif
`;

const VERT_BODY = /* glsl */ `
vTColor = pow(aColor.rgb, vec3(2.2));
vTSand = aColor.a;
vTMat = aMat.xyz;
vTWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTNormal = normalize(mat3(modelMatrix) * objectNormal);
#ifndef TERRAIN_RING
vTOverlay = floor(aMat.w * 255.0 + 0.5);
int tIdx = gl_VertexID / 4;
vTTile = vec2(float(tIdx - (tIdx / uW) * uW), float(tIdx / uW));
#endif
`;

const FRAG_HEAD = /* glsl */ `
uniform vec3 uGrassTint;
uniform float uSnow;
uniform vec3 uSnowColor;
uniform float uSnowLine;
uniform vec3 uRockColor;
uniform vec3 uMountainColor;
uniform vec3 uSandColor;
uniform float uGrid;
uniform int uDebug;
uniform vec4 uOvA[16];
uniform vec4 uOvB[16];
varying vec3 vTColor;
varying vec3 vTMat;
varying float vTSand;
varying vec3 vTWPos;
varying vec3 vTNormal;
float rs_rockMix = 0.0;
#ifndef TERRAIN_RING
flat varying float vTOverlay;
flat varying vec2 vTTile;
#endif
${GLSL_NOISE}

// fade factor for procedural detail that would alias at distance
float rs_detailFade(float freqCoord) {
  return 1.0 - smoothstep(0.25, 0.75, fwidth(freqCoord));
}

vec3 rs_overlayDetail(int pat, vec3 oc, vec3 wp, vec2 f) {
  if (pat == 1) {
    // dirt road: mottled with darker wheel ruts and pebbles
    float n = rs_noise(wp.xz * 5.0);
    oc *= 0.88 + 0.22 * n;
    float pb = step(0.93, rs_hash12(floor(wp.xz * 9.0)));
    oc = mix(oc, oc * 1.25, pb * 0.5 * rs_detailFade(wp.x * 9.0));
  } else if (pat == 2) {
    // stone road: offset cobbles with dark mortar
    vec2 p = wp.xz * 3.2;
    p.x += 0.5 * mod(floor(p.y), 2.0);
    vec2 cell = floor(p);
    vec2 g = fract(p);
    float h = rs_hash12(cell);
    float edge = min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y));
    float mortar = 1.0 - smoothstep(0.05, 0.14, edge);
    vec3 stone = oc * (0.84 + 0.3 * h);
    float fade = rs_detailFade(p.x);
    oc = mix(oc * (0.95 + 0.1 * rs_noise(wp.xz * 2.0)), mix(stone, oc * 0.6, mortar), fade);
  } else if (pat == 3 || pat == 8 || pat == 9) {
    float n = rs_noise(wp.xz * 4.0) * 0.6 + rs_noise(wp.xz * 11.0) * 0.4;
    oc *= 0.86 + 0.26 * n;
    if (pat == 9) {
      // quarry: rubble & exposed stone
      float r = rs_noise(wp.xz * 2.2);
      oc = mix(oc, oc * vec3(1.08, 1.08, 1.1), smoothstep(0.55, 0.75, r));
      oc *= 0.9 + 0.2 * step(0.8, rs_hash12(floor(wp.xz * 6.0))) * rs_detailFade(wp.x * 6.0);
    }
  } else if (pat >= 4 && pat <= 7) {
    // furrows (4,6 run along X; 5,7 along Z)
    bool alongX = (pat == 4 || pat == 6);
    float coord = alongX ? wp.z : wp.x;
    float s = 0.5 + 0.5 * sin(coord * 6.2831853 * 3.0);
    float fade = rs_detailFade(coord * 3.0);
    float n = rs_noise(wp.xz * 6.0);
    if (pat <= 5) {
      oc *= mix(1.0, mix(0.74, 1.12, s), fade) * (0.93 + 0.14 * n);
    } else {
      // stubble: straw rows over soil
      vec3 soil = uOvA[3].rgb;
      oc = mix(soil * (0.9 + 0.2 * n), oc * (0.9 + 0.25 * n), mix(0.6, s, fade));
    }
  } else if (pat == 10 || pat == 11 || pat == 12 || pat == 14) {
    float n = rs_noise(wp.xz * 1.7) * 0.6 + rs_noise(wp.xz * 7.0) * 0.4;
    oc *= 0.9 + 0.2 * n;
    if (pat == 10) {
      // pasture: grazed bare patches
      float bare = smoothstep(0.66, 0.82, rs_noise(wp.xz * 1.3 + 3.1));
      oc = mix(oc, uOvA[3].rgb * 1.3, bare * 0.25);
    }
  } else if (pat == 13) {
    float n = rs_noise(wp.xz * 5.0) * 0.7 + rs_noise(wp.xz * 13.0) * 0.3;
    oc *= 0.75 + 0.5 * n;
    oc = mix(oc, vec3(0.06, 0.055, 0.05), smoothstep(0.55, 0.75, rs_noise(wp.xz * 2.3 + 5.0)) * 0.5);
  }
  return oc;
}

vec3 terrainAlbedo() {
  vec3 wp = vTWPos;
  vec3 wn = normalize(cross(dFdx(wp), dFdy(wp)));
  float slopeFlat = 1.0 - abs(wn.y);
  float slopeSmooth = 1.0 - clamp(normalize(vTNormal).y, 0.0, 1.0);
  // colour decisions use a mostly smooth slope (no per-facet banding); cliffs keep their facets
  float slope = mix(slopeFlat, slopeSmooth, 0.75);
  float grassiness = vTMat.x;
  float snowiness = vTMat.y;

  // noise domain skewed by height so steep faces don't show vertically stretched streaks
  vec2 np = wp.xz + vec2(wp.y * 0.83, -wp.y * 0.61);
  float nLarge = rs_noise(wp.xz * 0.055) * 0.65 + rs_noise(wp.xz * 0.13 + 7.3) * 0.35;
  float nMid = rs_noise(np * 0.45);
  float nDetail = rs_noise(np * 2.7);
  float nEdge = rs_noise(np * 1.3) * 0.6 + rs_noise(np * 4.1) * 0.4;

  // ---- vegetation layer (corner-blended colour) ----
  vec3 nat = vTColor;
  nat *= 0.87 + 0.26 * nLarge;
  nat *= 0.96 + 0.08 * nDetail;
  // meadow hue patches (drier yellow vs. deeper green) on grassy ground
  float hue = rs_noise(wp.xz * 0.09 + 13.7);
  nat = mix(nat, nat * mix(vec3(0.84, 0.93, 0.9), vec3(1.1, 1.02, 0.82), hue), grassiness);
  // fine grass texture, only where it would not alias
  float fineFade = rs_detailFade(wp.x * 7.0);
  if (fineFade > 0.01) {
    float fine = rs_noise(wp.xz * 7.0) * 0.6 + rs_noise(wp.xz * 15.0) * 0.4;
    nat *= 1.0 + (fine - 0.5) * 0.16 * fineFade;
  }
  nat = mix(nat, nat * uGrassTint, grassiness);

#ifdef TERRAIN_RING
  // distant woodland: Voronoi tree crowns (dark gaps, lit tops), faded out where it would alias
  {
    vec2 cp = wp.xz * 0.95 + vec2(rs_noise(wp.xz * 0.3) * 0.8);
    vec2 ci = floor(cp);
    vec2 cf = fract(cp);
    float best = 1.0;
    float top = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 rnd = vec2(rs_hash12(ci + o), rs_hash12(ci + o + 17.31));
        vec2 dd = o + rnd * 0.8 + 0.1 - cf;
        float dist2 = dot(dd, dd);
        if (dist2 < best) { best = dist2; top = rnd.x; }
      }
    }
    float crown = 1.0 - smoothstep(0.02, 0.5, best);
    float fade = 1.0 - smoothstep(0.35, 0.9, fwidth(cp.x));
    float shade = mix(0.66, 1.06 - 0.14 * top, crown * crown * (3.0 - 2.0 * crown));
    nat *= mix(0.8, shade, fade) * grassiness + (1.0 - grassiness);
  }
#endif

  // ---- sand layer: crisp, ragged beaches; darker & wet near the waterline ----
  float sandMix = smoothstep(0.4, 0.56, vTSand + (nEdge - 0.5) * 0.42);
  vec3 sandCol = uSandColor * (0.93 + 0.1 * nDetail + 0.06 * nMid);
  sandCol = mix(sandCol * vec3(0.78, 0.77, 0.74), sandCol, smoothstep(0.02, 0.45, wp.y));
  nat = mix(nat, sandCol, sandMix);

  // ---- rock layer: mountains with crisp ragged edges ----
  float rockMix = smoothstep(0.4, 0.58, vTMat.z + (nEdge - 0.5) * 0.5);
  vec3 rockCol = uMountainColor * (0.84 + 0.3 * rs_noise(np * 0.33 + 4.0)) * (0.94 + 0.12 * nDetail);
  // subtle strata bands & darker cliffs
  float strata = 0.5 + 0.5 * sin(wp.y * 2.3 + nMid * 3.0);
  rockCol *= 1.0 - smoothstep(0.35, 0.85, slopeFlat) * 0.1 - strata * 0.06;
  nat = mix(nat, rockCol, rockMix);
  float rockiness = rockMix;
  rs_rockMix = rockMix;

  // steep grassy slopes expose earth & rock
  float steep = smoothstep(0.3, 0.62, slope) * (1.0 - rockMix);
  nat = mix(nat, uRockColor * (0.82 + 0.3 * nDetail), steep * 0.75);

  vec3 col = nat;
  float snowAmt = snowiness;
  /** Max snow coverage (trampled roads & yards keep showing through deep snow). */
  float snowMax = 1.0;

#ifndef TERRAIN_RING
  int ov = int(vTOverlay);
  int pat = ov >> 4;
  if (pat > 0) {
    int mask = ov & 15;
    vec2 f = clamp(wp.xz - vTTile, 0.0, 1.0);
    vec4 A = uOvA[pat];
    vec4 B = uOvB[pat];
    vec3 oc = A.rgb * (0.97 + 0.06 * rs_hash12(vTTile + 0.37));
    oc = mix(oc, oc * uGrassTint, B.x);
    oc = rs_overlayDetail(pat, oc, wp, f);
    float cover = 1.0;
    if (B.y > 0.0) {
      float e = 1.0;
      if ((mask & 1) == 0) e = min(e, f.y);
      if ((mask & 2) == 0) e = min(e, 1.0 - f.x);
      if ((mask & 4) == 0) e = min(e, 1.0 - f.y);
      if ((mask & 8) == 0) e = min(e, f.x);
      float jitter = (rs_noise(wp.xz * 6.0) - 0.5) * B.y * 0.8;
      cover = mix(B.z, 1.0, smoothstep(0.0, B.y, e + jitter));
    }
    col = mix(nat, oc, cover);
    snowMax = mix(1.0, A.a + (rs_noise(wp.xz * 3.1) - 0.5) * 0.3, cover);
  }
#endif

  // ---- snow cover (patchy while light) & mountain caps ----
  if (uSnow > 0.001 || (rockiness > 0.001 && wp.y > uSnowLine - 2.5)) {
    // Rotated, multi-octave domain: value noise sampled on the tile-aligned lattice made square, grid-locked
    // patches once thresholded, so each octave gets its own rotation and offset.
    vec2 q1 = mat2(0.8, -0.6, 0.6, 0.8) * np;
    vec2 q2 = mat2(0.28, 0.96, -0.96, 0.28) * np;
    float nS = rs_noise(q1 * 0.38 + 5.3) * 0.5 + rs_noise(q2 * 0.93 + 1.7) * 0.3 + rs_noise(q1 * 2.3 + 9.1) * 0.2;
    float st = uSnow * snowAmt * 1.6 - nS * 0.6;
    float s = smoothstep(0.0, 0.34, st) * (1.0 - smoothstep(0.5, 0.78, slope));
    // steep rock faces shed snow (per facet), so snowy mountains keep their shape
    s *= 1.0 - smoothstep(0.3, 0.55, slopeFlat + (nS - 0.5) * 0.2) * rockiness * 0.9;
    s = min(s, clamp(snowMax, 0.0, 1.0) * smoothstep(0.0, 0.35, uSnow));
    float capLine = uSnowLine + (nS - 0.5) * 2.6;
    float cap = rockiness * smoothstep(capLine - 0.7, capLine + 0.7, wp.y) * (1.0 - 0.85 * smoothstep(0.5, 0.8, slopeFlat));
    s = max(s, cap);
    // snow isn't flat white: soft drifts, slightly blue in hollows
    vec3 snowCol = uSnowColor * (0.9 + 0.07 * nDetail + 0.06 * nLarge);
    snowCol *= mix(vec3(0.93, 0.96, 1.02), vec3(1.0), smoothstep(-0.5, 2.5, wp.y - 0.4 + nMid));
    col = mix(col, snowCol, s);
  }

  // ---- optional tile grid ----
  if (uGrid > 0.001) {
    vec2 gd = abs(fract(wp.xz + 0.5) - 0.5) / max(fwidth(wp.xz), vec2(1e-4));
    float line = 1.0 - clamp(min(gd.x, gd.y) - 0.35, 0.0, 1.0);
    float fade = 1.0 - smoothstep(55.0, 120.0, length(wp - cameraPosition));
    col = mix(col, col * 0.5, line * uGrid * fade * 0.7);
  }
  if (uDebug == 1) col = vTColor;
  else if (uDebug == 2) col = normalize(vTNormal) * 0.5 + 0.5;
  else if (uDebug == 3) col = vec3(slope);
  else if (uDebug == 4) col = wn * 0.5 + 0.5;
  return col;
}
`;

/** Blend the flat facet normal with the smooth corner normal (world space varying): meadows read smooth, rock stays faceted. */
const NORMAL_BLEND = /* glsl */ `
#include <normal_fragment_begin>
{
  vec3 sn = normalize((viewMatrix * vec4(normalize(vTNormal), 0.0)).xyz);
#ifdef TERRAIN_RING
  normal = normalize(mix(normal, sn, mix(0.92, 0.45, rs_rockMix)));
#else
  normal = normalize(mix(normal, sn, mix(0.72, 0.15, rs_rockMix)));
#endif
}
`;

/**
 * Create the terrain material. `ring` = the decorative border ring outside the map (no per-tile overlays).
 * Both variants share the same uniform objects so one update drives both.
 */
export function createTerrainMaterial(uniforms: TerrainUniforms, ring: boolean): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  if (ring) mat.defines = { TERRAIN_RING: '' };
  mat.onBeforeCompile = (shader) => {
    for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n  diffuseColor.rgb *= terrainAlbedo();`);
  };
  mat.customProgramCacheKey = () => (ring ? 'exiles-terrain-ring-v5' : 'exiles-terrain-v5');
  return mat;
}
