/**
 * Clock, calendar, weather (temperature, precipitation, snow cover, wind). ARCHITECTURE §3.7. OWNER: sim-core.
 */
import { DAY_SECONDS, MONTH_SECONDS } from '../../core/constants';
import { CLIMATE_OFFSET, MONTH_TEMPERATURE, seasonOfMonth } from '../../core/defs';
import { hash2 } from '../../core/rng';
import type { GameState, WeatherState } from '../../core/types';
import type { Game } from '../game';
import { clamp, lerp, smoothstep } from './util';
import * as dm from './dmath';

/** Seconds between knots of the slow temperature noise. */
const TEMP_NOISE_PERIOD = 75;
const TEMP_NOISE_AMPLITUDE = 3;
const DAY_SWING = 2;
/** Fraction of time with precipitation, per season (spring, summer, autumn, winter). */
const PRECIP_SHARE = [0.32, 0.2, 0.34, 0.42];
/** Mean duration of a rain/snow spell in game seconds. */
const PRECIP_DURATION = 38;

/** Mean temperature for a (fractional) calendar position, climate adjusted, without noise or day swing. */
export function seasonalTemperature(state: GameState, month: number, monthProgress: number): number {
  const pos = month + monthProgress - 0.5;
  const m0 = ((Math.floor(pos) % 12) + 12) % 12;
  const m1 = (m0 + 1) % 12;
  const f = pos - Math.floor(pos);
  const base = lerp(MONTH_TEMPERATURE[m0], MONTH_TEMPERATURE[m1], smoothstep(f));
  return base + (CLIMATE_OFFSET[state.settings.climate] ?? 0);
}

function temperatureNoise(state: GameState): number {
  const t = state.time.elapsed / TEMP_NOISE_PERIOD;
  const k = Math.floor(t);
  const f = smoothstep(t - k);
  const seed = state.settings.seed | 0;
  const a = hash2(k, 17, seed) * 2 - 1;
  const b = hash2(k + 1, 17, seed) * 2 - 1;
  return lerp(a, b, f) * TEMP_NOISE_AMPLITUDE;
}

/** Full temperature at the current time (seasonal + noise + day/night swing). */
export function currentTemperature(state: GameState): number {
  const tm = state.time;
  const day = -dm.cos(tm.dayTime * Math.PI * 2) * DAY_SWING;
  return seasonalTemperature(state, tm.month, tm.monthProgress) + temperatureNoise(state) + day;
}

export function initialWeather(state: GameState): WeatherState {
  return {
    temperature: currentTemperature(state),
    snow: 0,
    precipitation: 'none',
    precipIntensity: 0,
    windDir: hash2(3, 5, state.settings.seed) * Math.PI * 2,
    windStrength: 0.3,
  };
}

/** Advance the clock and weather by dt game seconds; emits season/year events. */
export function updateTime(g: Game, dt: number): void {
  const s = g.state;
  const tm = s.time;
  const prevTick = Math.floor(tm.elapsed);
  tm.elapsed += dt;
  tm.dayTime = (tm.dayTime + dt / DAY_SECONDS) % 1;
  tm.monthProgress += dt / MONTH_SECONDS;
  while (tm.monthProgress >= 1) {
    tm.monthProgress -= 1;
    const prevMonth = tm.month;
    tm.month = (tm.month + 1) % 12;
    if (tm.month === 0) {
      tm.year += 1;
      rotateYearCounters(s);
      g.events.emit('yearChanged', { year: tm.year });
    }
    if (tm.month % 3 === 0 && seasonOfMonth(prevMonth) !== seasonOfMonth(tm.month)) {
      g.events.emit('seasonChanged', { season: seasonOfMonth(tm.month), year: tm.year });
    }
  }
  updateWeather(g, dt, Math.floor(tm.elapsed) !== prevTick);
}

function rotateYearCounters(s: GameState): void {
  for (const b of s.buildings) {
    b.producedLastYear = b.producedThisYear;
    b.producedThisYear = {};
  }
}

function updateWeather(g: Game, dt: number, secondTick: boolean): void {
  const s = g.state;
  const w = s.weather;
  const temp = currentTemperature(s);
  w.temperature = temp;
  const season = Math.floor(s.time.month / 3) % 4;

  if (secondTick) {
    const rng = g.rng;
    if (w.precipitation === 'none') {
      const share = PRECIP_SHARE[season];
      const pStart = (1 / PRECIP_DURATION) * (share / (1 - share));
      if (rng.next() < pStart) {
        w.precipitation = temp < 0.5 ? 'snow' : 'rain';
        // intensity eases in from 0; target stored implicitly by the random draw below
        w.precipIntensity = 0.05;
        w.precipTarget = rng.range(0.35, 1);
      }
    } else {
      if (rng.next() < 1 / PRECIP_DURATION) {
        w.precipTarget = 0;
      }
      // switch rain <-> snow with temperature
      if (w.precipitation === 'rain' && temp < -0.5) w.precipitation = 'snow';
      else if (w.precipitation === 'snow' && temp > 1.5) w.precipitation = 'rain';
    }
    // wind: slow random walk
    w.windDir = (w.windDir + rng.range(-0.08, 0.08) + Math.PI * 2) % (Math.PI * 2);
    const windTarget = w.precipitation !== 'none' ? 0.55 + w.precipIntensity * 0.35 : season === 3 ? 0.45 : 0.25;
    w.windStrength = clamp(w.windStrength + (windTarget - w.windStrength) * 0.05 + rng.range(-0.03, 0.03), 0, 1);
  }

  if (w.precipitation !== 'none') {
    const target = w.precipTarget ?? 0.6;
    w.precipIntensity += (target - w.precipIntensity) * Math.min(1, dt * 0.25);
    if (target === 0 && w.precipIntensity < 0.03) {
      w.precipitation = 'none';
      w.precipIntensity = 0;
      delete w.precipTarget;
    }
  } else {
    w.precipIntensity = 0;
  }

  // snow cover
  if (w.precipitation === 'snow') w.snow += 0.014 * w.precipIntensity * dt;
  else if (temp < -1) w.snow += 0.0015 * dt * (w.snow > 0.05 ? 1 : 0);
  if (temp > 2) w.snow -= (temp - 2) * 0.0045 * dt * (w.precipitation === 'rain' ? 1.8 : 1);
  w.snow = clamp(w.snow, 0, 1);
  if (!Number.isFinite(w.snow)) w.snow = 0;
  if (!Number.isFinite(w.precipIntensity)) w.precipIntensity = 0;
}
