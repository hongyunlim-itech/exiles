/**
 * Pure helpers that turn game state + camera into audio parameters (no WebAudio; unit-tested headless).
 */
import { seasonOfMonth } from '../core/defs';
import type { GameState, Season } from '../core/types';
import { Feature, Terrain } from '../core/types';

/** Camera distance range used for zoom-dependent mixing (matches the camera clamp 8..120). */
export const ZOOM_NEAR = 8;
export const ZOOM_FAR = 120;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** 0 when zoomed fully in, 1 when fully out. */
export function zoomFactor(cameraDistance: number): number {
  return clamp01((cameraDistance - ZOOM_NEAR) / (ZOOM_FAR - ZOOM_NEAR));
}

/** 1 during the day, 0 at night, smooth around sunrise (0.25) and sunset (0.75). */
export function daylightFactor(dayTime: number): number {
  return smoothstep(0.2, 0.3, dayTime) * (1 - smoothstep(0.7, 0.8, dayTime));
}

/** What surrounds the listener: fractions of water and (mature) tree tiles within the sampled radius. */
export interface EnvSample {
  water: number;
  trees: number;
}

/**
 * Sample the tiles around (fx, fz) on a sparse grid (≈ 13×13 samples regardless of radius — cheap enough to run a few
 * times per second).
 */
export function sampleEnvironment(state: GameState, fx: number, fz: number, radius: number, out: EnvSample = { water: 0, trees: 0 }): EnvSample {
  const W = state.W;
  const H = state.H;
  const t = state.tiles;
  const step = Math.max(1, Math.round(radius / 6));
  const r2 = radius * radius;
  let n = 0;
  let water = 0;
  let trees = 0;
  const cx = Math.floor(fx);
  const cz = Math.floor(fz);
  for (let dz = -radius; dz <= radius; dz += step) {
    const z = cz + Math.round(dz);
    if (z < 0 || z >= H) continue;
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dz * dz > r2) continue;
      const x = cx + Math.round(dx);
      if (x < 0 || x >= W) continue;
      const i = z * W + x;
      n++;
      const ter = t.terrain[i];
      if (ter === Terrain.Water || ter === Terrain.DeepWater) water++;
      else if (t.feature[i] === Feature.Tree && t.featureAmount[i] >= 0.5) trees++;
    }
  }
  out.water = n > 0 ? water / n : 0;
  out.trees = n > 0 ? trees / n : 0;
  return out;
}

/** Sampling radius (tiles) around the camera focus for the ambient bed. */
export function envRadius(cameraDistance: number): number {
  return 8 + zoomFactor(cameraDistance) * 18;
}

/** Target levels for the ambient bed (all 0..1 except the event rates in events/second). */
export interface AmbientTargets {
  /** Wind loudness. */
  wind: number;
  /** Wind filter brightness (higher = hissier, stormier). */
  windBright: number;
  rain: number;
  water: number;
  /** Bird songs per second. */
  birdRate: number;
  /** Cricket chirp bursts per second. */
  cricketRate: number;
}

const SEASON_WIND: Record<Season, number> = { spring: 0.5, summer: 0.36, autumn: 0.66, winter: 0.9 };
const SEASON_BIRDS: Record<Season, number> = { spring: 1, summer: 0.85, autumn: 0.25, winter: 0 };

/** Crickets: summer, plus warm edges of late spring / early autumn. */
function cricketSeason(month: number): number {
  if (month >= 3 && month <= 5) return 1;
  if (month === 2 || month === 6) return 0.5;
  return 0;
}

export function computeAmbientTargets(
  state: GameState,
  env: EnvSample,
  cameraDistance: number,
  out: AmbientTargets = { wind: 0, windBright: 0, rain: 0, water: 0, birdRate: 0, cricketRate: 0 },
): AmbientTargets {
  const month = ((state.time.month % 12) + 12) % 12;
  const season = seasonOfMonth(month);
  const w = state.weather;
  const zoom = zoomFactor(cameraDistance);
  const close = 1 - zoom;
  const day = daylightFactor(state.time.dayTime);
  const night = 1 - day;
  const raining = w.precipitation === 'rain' ? clamp01(w.precipIntensity) : 0;
  const snowing = w.precipitation === 'snow' ? clamp01(w.precipIntensity) : 0;
  const strength = clamp01(w.windStrength);

  out.wind = clamp01(SEASON_WIND[season] * (0.45 + 0.55 * strength) * (0.5 + 0.7 * zoom) + snowing * 0.15 + raining * 0.1);
  out.windBright = clamp01(0.25 + 0.5 * strength + 0.25 * zoom - snowing * 0.2);
  out.rain = clamp01(raining * (0.55 + 0.45 * close));
  out.water = clamp01(Math.min(1, env.water * 2.5) * (0.25 + 0.75 * close));
  const birdWeather = 1 - 0.75 * Math.max(raining, snowing);
  out.birdRate = SEASON_BIRDS[season] * day * (0.2 + 1.6 * env.trees) * Math.pow(close, 1.5) * birdWeather * 1.1;
  const warm = smoothstep(10, 16, w.temperature);
  out.cricketRate = cricketSeason(month) * night * warm * (0.4 + 0.6 * (1 - env.water)) * close * (1 - 0.8 * raining) * 2.6;
  return out;
}

/**
 * Gain (0..1) for a sound at world (x, z) heard from the camera focus (fx, fz) at the given camera distance:
 * quadratic falloff within an audible radius that grows as the camera zooms out, times a zoom-out damping.
 */
export function positionalGain(x: number, z: number, fx: number, fz: number, cameraDistance: number): number {
  const radius = 14 + cameraDistance * 0.55;
  const d = Math.hypot(x - fx, z - fz);
  const f = clamp01(1 - d / radius);
  const zoomGain = Math.max(0.2, Math.min(1, 1.25 - cameraDistance / 90));
  return f * f * zoomGain;
}
