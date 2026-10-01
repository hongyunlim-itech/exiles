/**
 * Pure day/night + seasonal sky model. Maps (dayTime, yearProgress, overcast, damping) to sun/moon directions,
 * light colours & intensities, sky gradient and fog colours. No three.js — unit-testable.
 * All colours are sRGB 0..1 triples. OWNER: render-scene.
 */
import { clamp01, hexToRgb, lerp, lerpRgb, smoothstep, type RGB } from './palette';

export type Vec3 = [number, number, number];

export interface SkyInputs {
  /** 0..1, 0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  dayTime: number;
  /** 0..1 through the year (0 = start of Early Spring). */
  yearProgress: number;
  /** 0..1 cloud cover / precipitation darkness. */
  overcast: number;
  /**
   * 0..1 how much of the real day cycle is shown. 1 = full cycle; 0 = frozen at a pleasant late-morning light
   * (used at high game speeds where a 24 s day would strobe).
   */
  cycle: number;
}

export interface SkyState {
  /** 0 = night .. 1 = full day (effective, after cycle damping). */
  daylight: number;
  /** Normalized sun height -1..1 (sin of the day angle). */
  sunHeight: number;
  /** Unit vector towards the sun (may be below the horizon). */
  sunDir: Vec3;
  /** Unit vector towards the moon. */
  moonDir: Vec3;
  /** Unit vector towards the active shadow-casting light (sun by day, moon by night), elevation-clamped. */
  lightDir: Vec3;
  lightColor: RGB;
  lightIntensity: number;
  /** 0..1 shadow darkness multiplier (weaker when overcast / at twilight). */
  shadowStrength: number;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  zenith: RGB;
  horizon: RGB;
  fog: RGB;
  cloud: RGB;
  /** 0..1 strength of the warm glow around the sun (strong near the horizon). */
  sunGlow: number;
  /** 0..1 visibility of stars & moon disc. */
  stars: number;
  /** 0..1 how wintery the light is (desaturated, cool). */
  winter: number;
}

interface Key {
  at: number;
  c: RGB;
}

function keys(list: [number, number][]): Key[] {
  return list.map(([at, hex]) => ({ at, c: hexToRgb(hex) }));
}

function sampleKeys(k: Key[], s: number, out: RGB): RGB {
  if (s <= k[0].at) return lerpRgb(k[0].c, k[0].c, 0, out);
  for (let i = 1; i < k.length; i++) {
    if (s <= k[i].at) {
      const t = (s - k[i - 1].at) / (k[i].at - k[i - 1].at);
      return lerpRgb(k[i - 1].c, k[i].c, t * t * (3 - 2 * t), out);
    }
  }
  const last = k[k.length - 1].c;
  return lerpRgb(last, last, 0, out);
}

// Keyframes over normalized sun height s = sin(dayAngle), -1 (midnight) .. 1 (noon).
const ZENITH = keys([
  [-1, 0x0b1428], [-0.3, 0x101c38], [-0.1, 0x28365f], [0, 0x4b6194], [0.15, 0x5f83b8], [0.4, 0x6593c8], [1, 0x5a8fcb],
]);
const HORIZON = keys([
  [-1, 0x1b2842], [-0.3, 0x22304c], [-0.12, 0x5b5070], [-0.02, 0xc4806a], [0.05, 0xeba56e], [0.18, 0xe6caa2],
  [0.4, 0xcfdde2], [1, 0xc9dce6],
]);
const SUN_COLOR = keys([
  [-0.05, 0xff8a48], [0.05, 0xffa060], [0.2, 0xffd3a2], [0.45, 0xffefd9], [1, 0xfff5e8],
]);
const HEMI_SKY = keys([
  [-1, 0x566a9e], [-0.2, 0x5c6b9c], [-0.05, 0x7a7898], [0.06, 0xc6ab94], [0.3, 0xbcd0e4], [1, 0xc4d7ea],
]);
const HEMI_GROUND = keys([
  [-1, 0x2a2b36], [-0.1, 0x36323a], [0.05, 0x66523f], [0.3, 0x86765a], [1, 0x8c7c5e],
]);
const MOON_COLOR = hexToRgb(0xa8bdf0);
const OVERCAST_DAY = hexToRgb(0xa3aaae);
const OVERCAST_NIGHT = hexToRgb(0x1c2230);
const WINTER_HAZE = hexToRgb(0xc8cfd4);
const AUTUMN_HAZE = hexToRgb(0xe4cf9f);
const COOL_SUN = hexToRgb(0xf0f3fa);
const CLOUD_DAY = hexToRgb(0xf4f1ea);
const CLOUD_NIGHT = hexToRgb(0x2a3348);
const CLOUD_DUSK = hexToRgb(0xf0b08a);

/** Rotation (radians around +Y) applied to the sun path so noon light comes in from the front-right. */
const SUN_AZIMUTH = 0.65;
const MOON_AZIMUTH = -0.9;
/** Day angle used when the cycle is fully damped (late morning). */
const FROZEN_ANGLE = Math.PI * 2 * 0.16;
/** Minimum sine of elevation for the shadow light so shadows never stretch across the map. */
const MIN_LIGHT_ELEV = 0.3;

function wrapPi(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function rotY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = v[0] * c + v[2] * s;
  const z = -v[0] * s + v[2] * c;
  v[0] = x;
  v[2] = z;
  return v;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
  return v;
}

function desaturate(c: RGB, amount: number): void {
  const l = c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;
  c[0] = lerp(c[0], l, amount);
  c[1] = lerp(c[1], l, amount);
  c[2] = lerp(c[2], l, amount);
}

/** Seasonal factor: +1 mid-summer, -1 mid-winter. */
export function seasonalFactor(yearProgress: number): number {
  return Math.cos(Math.PI * 2 * (yearProgress - 0.375));
}

/** 0..1 how wintery (0 in summer/early autumn, 1 in mid-winter). */
export function winterness(yearProgress: number): number {
  return clamp01(-seasonalFactor(yearProgress) * 1.5 - 0.25);
}

/** Raw daylight for a day time (no damping), 0 at night .. 1 in full day. */
export function daylightAt(dayTime: number): number {
  return smoothstep(-0.2, 0.25, Math.sin(Math.PI * 2 * (dayTime - 0.25)));
}

export function createSkyState(): SkyState {
  return {
    daylight: 1, sunHeight: 1,
    sunDir: [0, 1, 0], moonDir: [0, 1, 0], lightDir: [0, 1, 0],
    lightColor: [1, 1, 1], lightIntensity: 3, shadowStrength: 1,
    hemiSky: [1, 1, 1], hemiGround: [0.5, 0.4, 0.3], hemiIntensity: 1,
    zenith: [0.3, 0.5, 0.8], horizon: [0.8, 0.85, 0.9], fog: [0.8, 0.85, 0.9], cloud: [1, 1, 1],
    sunGlow: 0, stars: 0, winter: 0,
  };
}

const _tmp: RGB = [0, 0, 0];

/** Compute the full sky/light state. Writes into `out` (allocation-free when reused). */
export function computeSky(inp: SkyInputs, out: SkyState = createSkyState()): SkyState {
  const cycle = clamp01(inp.cycle);
  const realAngle = Math.PI * 2 * (inp.dayTime - 0.25);
  const angle = FROZEN_ANGLE + wrapPi(realAngle - FROZEN_ANGLE) * cycle;
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const sf = seasonalFactor(inp.yearProgress);
  const winter = winterness(inp.yearProgress);
  const autumn = Math.exp(-(((inp.yearProgress - 0.63) / 0.09) ** 2));
  const overcast = clamp01(inp.overcast);

  // ---- directions ----------------------------------------------------------------------------
  const noonElev = ((47 + 17 * sf) * Math.PI) / 180;
  const sun = out.sunDir;
  sun[0] = c;
  sun[1] = s * Math.sin(noonElev);
  sun[2] = s * Math.cos(noonElev);
  normalize(rotY(sun, SUN_AZIMUTH));

  const moonAngle = angle + Math.PI;
  const moonElev = (52 * Math.PI) / 180;
  const moon = out.moonDir;
  moon[0] = Math.cos(moonAngle);
  moon[1] = Math.sin(moonAngle) * Math.sin(moonElev);
  moon[2] = Math.sin(moonAngle) * Math.cos(moonElev);
  normalize(rotY(moon, MOON_AZIMUTH));

  // ---- lights --------------------------------------------------------------------------------
  const sunI = 2.45 * smoothstep(-0.06, 0.2, s) * (1 - 0.18 * winter) * (1 - 0.68 * overcast);
  const moonI = 0.7 * smoothstep(-0.03, -0.32, s) * (1 - 0.5 * overcast);
  const useSun = sunI >= moonI;
  const src = useSun ? sun : moon;
  const ld = out.lightDir;
  ld[0] = src[0];
  ld[1] = src[1];
  ld[2] = src[2];
  if (ld[1] < MIN_LIGHT_ELEV) {
    const hl = Math.hypot(ld[0], ld[2]) || 1;
    const k = Math.sqrt(1 - MIN_LIGHT_ELEV * MIN_LIGHT_ELEV) / hl;
    ld[0] *= k;
    ld[2] *= k;
    ld[1] = MIN_LIGHT_ELEV;
  }
  if (useSun) {
    sampleKeys(SUN_COLOR, s, out.lightColor);
    lerpRgb(out.lightColor, COOL_SUN, 0.45 * winter, out.lightColor);
    out.lightIntensity = sunI;
  } else {
    lerpRgb(MOON_COLOR, MOON_COLOR, 0, out.lightColor);
    out.lightIntensity = moonI;
  }
  out.shadowStrength = clamp01((useSun ? 0.9 : 0.55) * (1 - 0.75 * overcast) * smoothstep(0, 0.35, out.lightIntensity));

  // ---- hemisphere ----------------------------------------------------------------------------
  sampleKeys(HEMI_SKY, s, out.hemiSky);
  sampleKeys(HEMI_GROUND, s, out.hemiGround);
  const day = smoothstep(-0.2, 0.25, s);
  const twilight = smoothstep(0.4, 0.0, Math.abs(s + 0.02));
  out.hemiIntensity = (lerp(0.95, 1.0, day) + 0.4 * twilight) * (1 + 0.3 * overcast) * (1 + 0.1 * winter);
  desaturate(out.hemiSky, 0.3 * overcast + 0.2 * winter);

  // ---- sky gradient & fog ----------------------------------------------------------------------
  sampleKeys(ZENITH, s, out.zenith);
  sampleKeys(HORIZON, s, out.horizon);
  // seasons: winter paler & greyer, autumn warm haze
  desaturate(out.zenith, 0.3 * winter);
  lerpRgb(out.horizon, WINTER_HAZE, 0.35 * winter * day, out.horizon);
  lerpRgb(out.horizon, AUTUMN_HAZE, 0.22 * autumn * day, out.horizon);
  // overcast greys everything out
  lerpRgb(OVERCAST_NIGHT, OVERCAST_DAY, day, _tmp);
  lerpRgb(out.zenith, _tmp, 0.75 * overcast, out.zenith);
  lerpRgb(out.horizon, _tmp, 0.65 * overcast, out.horizon);
  lerpRgb(out.horizon, out.zenith, 0.14, out.fog);
  desaturate(out.fog, 0.12);

  // clouds
  lerpRgb(CLOUD_NIGHT, CLOUD_DAY, day, out.cloud);
  const dusk = smoothstep(0.35, 0.02, Math.abs(s)) * day;
  lerpRgb(out.cloud, CLOUD_DUSK, 0.55 * dusk, out.cloud);
  lerpRgb(out.cloud, out.zenith, 0.35 * overcast, out.cloud);

  out.sunGlow = smoothstep(0.45, 0.0, Math.abs(s)) * (1 - overcast) * smoothstep(-0.25, -0.02, s);
  out.stars = smoothstep(-0.08, -0.35, s) * (1 - overcast);
  out.daylight = day;
  out.sunHeight = s;
  out.winter = winter;
  return out;
}
