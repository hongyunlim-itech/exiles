/**
 * Sky dome: gradient sky (zenith → horizon → fog-coloured ground band), sun disc & glow, moon disc, stars and soft
 * drifting clouds. Centred on the camera and projected onto the far plane (xyww); drawn LAST among the opaque objects
 * with the depth test on, so its fairly heavy fragment shader (fbm clouds) only runs on pixels no geometry covered —
 * at the usual top-down views that is a small part of the screen instead of every pixel. Colours are display-referred
 * (not tone mapped) so the horizon matches the scene fog exactly. OWNER: render-scene.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';

export interface SkyDomeUniforms {
  [name: string]: THREE.IUniform;
  uZenith: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uFog: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uCloudColor: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uSunGlow: THREE.IUniform<number>;
  uSunVis: THREE.IUniform<number>;
  uStars: THREE.IUniform<number>;
  uCloud: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
}

export function createSkyDomeUniforms(): SkyDomeUniforms {
  return {
    uZenith: { value: new THREE.Color(0x5a8fcb) },
    uHorizon: { value: new THREE.Color(0xc9dce6) },
    uFog: { value: new THREE.Color(0xc9dce6) },
    uSunColor: { value: new THREE.Color(0xfff5e8) },
    uCloudColor: { value: new THREE.Color(0xffffff) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uSunGlow: { value: 0 },
    uSunVis: { value: 1 },
    uStars: { value: 0 },
    uCloud: { value: 0.3 },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
  };
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFog;
uniform vec3 uSunColor;
uniform vec3 uCloudColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunGlow;
uniform float uSunVis;
uniform float uStars;
uniform float uCloud;
uniform float uTime;
uniform vec2 uWind;
varying vec3 vDir;
${GLSL_NOISE}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 1.0, max(h, 0.0)), 0.55));
  // haze band just above the horizon blends into the fog colour
  col = mix(col, uFog, (1.0 - smoothstep(0.0, 0.12, h)) * 0.6);
  // below the horizon: fog colour (matches the fogged terrain / border hills)
  col = mix(col, uFog, smoothstep(0.0, -0.05, h));

  // sun: disc + two glow lobes (wide warm glow near the horizon)
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uSunVis * (smoothstep(0.9993, 0.99965, sd) * 3.0 + pow(sd, 64.0) * 0.35);
  col += uSunColor * uSunGlow * (pow(sd, 6.0) * 0.35 + pow(sd, 2.0) * 0.12) * smoothstep(-0.15, 0.05, h);

  // stars & moon
  if (uStars > 0.001) {
    vec3 sp = d * 240.0;
    vec3 cell = floor(sp);
    float r = rs_hash13(cell);
    vec3 f = fract(sp) - 0.5;
    float star = step(0.9965, r) * smoothstep(0.32, 0.0, length(f));
    star *= 0.6 + 0.4 * sin(uTime * (1.5 + r * 3.0) + r * 40.0);
    col += vec3(0.85, 0.9, 1.0) * star * uStars * smoothstep(0.02, 0.25, h);
    float md = dot(d, uMoonDir);
    col += vec3(0.86, 0.9, 1.0) * smoothstep(0.99955, 0.99975, md) * uStars;
    col += vec3(0.35, 0.42, 0.6) * pow(max(md, 0.0), 80.0) * 0.25 * uStars;
  }

  // clouds on a virtual plane
  if (h > 0.0 && uCloud > 0.001) {
    vec2 uv = d.xz / (h + 0.12) * 0.9 + uWind * uTime * 0.012;
    float c = rs_fbm(uv * 1.1);
    float cover = smoothstep(0.62 - uCloud * 0.35, 0.95 - uCloud * 0.2, c);
    float shade = 0.82 + 0.18 * rs_noise(uv * 3.0 + 7.0);
    float fade = smoothstep(0.0, 0.18, h);
    col = mix(col, uCloudColor * shade, cover * fade * 0.85);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export function createSkyDome(uniforms: SkyDomeUniforms): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
  // the gradient is per-fragment, so a coarse sphere is enough
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;
  // after all other opaque objects (early depth rejection); still before the transparent pass (water, particles)
  mesh.renderOrder = 100000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
