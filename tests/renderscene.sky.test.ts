import { describe, expect, it } from 'vitest';
import { computeSky, createSkyState, daylightAt, seasonalFactor, winterness } from '../src/render/scene/dayCycle';
import { grassColorAt, GRASS_SEASON_KEYS, hexToRgb } from '../src/render/scene/palette';
import { townCenter } from '../src/render/scene/townCenter';
import { minPitchFor, CAMERA_MAX_PITCH } from '../src/render/camera';
import { createNullRenderer, ThrottledErrorLog } from '../src/render/scene/guard';
import { makeBuilding, makeState } from './renderscene.helpers';

const inputs = (dayTime: number, yearProgress = 0.375, overcast = 0, cycle = 1) => ({ dayTime, yearProgress, overcast, cycle });

describe('day cycle', () => {
  it('is bright at noon and dim (but not black) at midnight', () => {
    const noon = computeSky(inputs(0.5));
    const night = computeSky(inputs(0));
    expect(noon.daylight).toBeGreaterThan(0.95);
    expect(night.daylight).toBeLessThan(0.05);
    expect(noon.sunDir[1]).toBeGreaterThan(0.5);
    expect(night.sunDir[1]).toBeLessThan(0);
    // the moon lights the night: never pitch black
    expect(night.lightIntensity).toBeGreaterThan(0.3);
    expect(night.hemiIntensity).toBeGreaterThan(0.5);
    expect(noon.lightIntensity).toBeGreaterThan(night.lightIntensity * 2);
  });

  it('keeps the shadow light above a minimum elevation', () => {
    for (let t = 0; t < 1; t += 0.01) {
      const s = computeSky(inputs(t));
      expect(s.lightDir[1]).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(Math.hypot(...s.lightDir)).toBeCloseTo(1, 6);
    }
  });

  it('produces valid colours everywhere', () => {
    for (let t = 0; t < 1; t += 0.05) {
      for (const y of [0, 0.3, 0.6, 0.9]) {
        const s = computeSky(inputs(t, y, t % 0.5));
        for (const c of [s.zenith, s.horizon, s.fog, s.lightColor, s.hemiSky, s.hemiGround, s.cloud]) {
          for (const v of c) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('has warm dawn/dusk horizons', () => {
    const dusk = computeSky(inputs(0.745));
    expect(dusk.horizon[0]).toBeGreaterThan(dusk.horizon[2]);
    expect(dusk.sunGlow).toBeGreaterThan(0.3);
  });

  it('freezes the light when the cycle is damped (high game speed)', () => {
    const a = computeSky(inputs(0.05, 0.375, 0, 0));
    const b = computeSky(inputs(0.6, 0.375, 0, 0));
    expect(a.daylight).toBeCloseTo(b.daylight, 6);
    expect(a.daylight).toBeGreaterThan(0.8);
    expect(a.lightDir[0]).toBeCloseTo(b.lightDir[0], 6);
  });

  it('has a higher summer sun and a paler winter', () => {
    const summer = computeSky(inputs(0.5, 0.375));
    const winter = computeSky(inputs(0.5, 0.875));
    expect(summer.sunDir[1]).toBeGreaterThan(winter.sunDir[1]);
    expect(winter.winter).toBeGreaterThan(0.9);
    expect(summer.winter).toBe(0);
    expect(seasonalFactor(0.375)).toBeCloseTo(1, 6);
    expect(winterness(0.875)).toBe(1);
  });

  it('dims the sun under overcast skies', () => {
    const clear = computeSky(inputs(0.5, 0.375, 0));
    const rain = computeSky(inputs(0.5, 0.375, 1));
    expect(rain.lightIntensity).toBeLessThan(clear.lightIntensity * 0.5);
    expect(rain.shadowStrength).toBeLessThan(clear.shadowStrength);
  });

  it('daylightAt matches the model and reuses output objects', () => {
    expect(daylightAt(0.5)).toBeCloseTo(1, 6);
    const out = createSkyState();
    expect(computeSky(inputs(0.3), out)).toBe(out);
  });
});

describe('seasonal grass', () => {
  it('is the base colour in mid-summer and autumnal in autumn', () => {
    const summer = grassColorAt(4.5 / 12);
    const base = hexToRgb(GRASS_SEASON_KEYS[4]);
    summer.forEach((v, i) => expect(v).toBeCloseTo(base[i], 5));
    const autumn = grassColorAt(7.5 / 12);
    expect(autumn[0]).toBeGreaterThan(summer[0]);
  });
  it('wraps smoothly across the year boundary', () => {
    const a = grassColorAt(0.9999);
    const b = grassColorAt(0.0001);
    a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(0.01));
  });
});

describe('townCenter', () => {
  it('averages building centres, skipping ruins', () => {
    const s = makeState(64, 64);
    s.buildings.push(makeBuilding(1, 'woodenHouse', 10, 10, 2, 2), makeBuilding(2, 'woodenHouse', 20, 30, 2, 2));
    s.buildings.push(makeBuilding(3, 'woodenHouse', 60, 60, 2, 2, { state: 'ruin' }));
    expect(townCenter(s)).toEqual({ x: 16, z: 21 });
  });
  it('falls back to the first citizen, then the map centre', () => {
    const s = makeState(64, 32);
    expect(townCenter(s)).toEqual({ x: 32, z: 16 });
    s.citizens.push({ x: 5, z: 7 } as never);
    expect(townCenter(s)).toEqual({ x: 5, z: 7 });
  });
});

describe('camera limits', () => {
  it('allows a lower pitch when zoomed in than when zoomed out', () => {
    expect(minPitchFor(8)).toBeLessThan(minPitchFor(120));
    expect(minPitchFor(8)).toBeGreaterThan(0.25);
    expect(minPitchFor(120)).toBeLessThan(CAMERA_MAX_PITCH);
    for (let d = 8; d < 120; d += 4) expect(minPitchFor(d + 4)).toBeGreaterThanOrEqual(minPitchFor(d));
  });
});

describe('render guard', () => {
  it('null renderer is inert', () => {
    const r = createNullRenderer<{ update(): void; getChimneys(): unknown[]; pick(): number | null }>('x');
    expect(r.update()).toBeUndefined();
    expect(r.getChimneys()).toEqual([]);
    expect(r.pick()).toBeNull();
  });
  it('throttles repeated errors per layer', () => {
    const orig = console.error;
    let n = 0;
    console.error = () => { n++; };
    try {
      const log = new ThrottledErrorLog(10000);
      for (let i = 0; i < 50; i++) log.error('terrain', 'boom', new Error('x'));
      log.error('water', 'boom', new Error('y'));
      expect(n).toBe(2);
    } finally {
      console.error = orig;
    }
  });
});
