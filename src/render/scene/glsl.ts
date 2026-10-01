/**
 * Shared GLSL snippets for the scene shaders (terrain, water, sky). OWNER: render-scene.
 * Functions are prefixed `rs_` to avoid clashing with three.js chunk names.
 */

export const GLSL_NOISE = /* glsl */ `
float rs_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float rs_hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float rs_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rs_hash12(i);
  float b = rs_hash12(i + vec2(1.0, 0.0));
  float c = rs_hash12(i + vec2(0.0, 1.0));
  float d = rs_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float rs_fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * rs_noise(p);
    p = p * 2.03 + vec2(17.13, 9.27);
    a *= 0.5;
  }
  return v / 0.9375;
}
`;
