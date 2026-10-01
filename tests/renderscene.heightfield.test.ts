import { describe, expect, it } from 'vitest';
import { rayBox, raymarchHeightfield } from '../src/render/scene/heightfield';
import { pickBuildingBox } from '../src/render/scene/pickVolumes';
import { makeBuilding } from './renderscene.helpers';

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

describe('rayBox', () => {
  it('hits a box in front and reports the entry distance', () => {
    const t = rayBox(0, 0, 0, 1, 0, 0, 5, -1, -1, 6, 1, 1);
    expect(t).toBeCloseTo(5, 6);
  });
  it('misses boxes behind or beside the ray', () => {
    expect(rayBox(0, 0, 0, 1, 0, 0, -6, -1, -1, -5, 1, 1)).toBe(-1);
    expect(rayBox(0, 0, 0, 1, 0, 0, 5, 2, -1, 6, 3, 1)).toBe(-1);
  });
  it('returns 0 when the origin is inside', () => {
    expect(rayBox(0, 0, 0, 0, -1, 0, -1, -1, -1, 1, 1, 1)).toBe(0);
  });
});

describe('raymarchHeightfield', () => {
  it('hits a flat plane exactly', () => {
    const [dx, dy, dz] = norm(1, -1, 0.5);
    const hit = raymarchHeightfield(() => 1, 100, 100, 1, 1, 10, 21, 10, dx, dy, dz);
    expect(hit).not.toBeNull();
    // descending 20 units in y from y=21 to y=1
    const t = 20 / -dy;
    expect(hit!.t).toBeCloseTo(t, 2);
    expect(hit!.x).toBeCloseTo(10 + dx * t, 2);
    expect(hit!.z).toBeCloseTo(10 + dz * t, 2);
    expect(hit!.y).toBeCloseTo(1, 2);
  });

  it('matches a brute-force march on rolling terrain', () => {
    const h = (x: number, z: number) => 2 + Math.sin(x * 0.7) * 1.5 + Math.cos(z * 0.45) * 1.2;
    for (let k = 0; k < 20; k++) {
      const ox = 5 + k * 3;
      const [dx, dy, dz] = norm(0.8 + (k % 3) * 0.2, -0.35 - (k % 4) * 0.12, 0.3 + (k % 5) * 0.1);
      const hit = raymarchHeightfield(h, 128, 128, -1, 5, ox, 12, 4, dx, dy, dz);
      // brute force with tiny steps
      let ref = -1;
      for (let t = 0; t < 400; t += 0.002) {
        const x = ox + dx * t;
        const z = 4 + dz * t;
        if (x < 0 || z < 0 || x > 128 || z > 128) break;
        if (12 + dy * t - h(x, z) <= 0) {
          ref = t;
          break;
        }
      }
      if (ref < 0) expect(hit).toBeNull();
      else {
        expect(hit).not.toBeNull();
        expect(Math.abs(hit!.t - ref)).toBeLessThan(0.02);
      }
    }
  });

  it('returns null when the ray points away from the map', () => {
    expect(raymarchHeightfield(() => 0, 10, 10, 0, 0, 5, 5, 5, 0, 1, 0)).toBeNull();
    expect(raymarchHeightfield(() => 0, 10, 10, 0, 0, -5, 5, 5, -1, 0, 0)).toBeNull();
  });

  it('enters from outside the map rectangle', () => {
    const [dx, dy, dz] = norm(1, -0.3, 0);
    const hit = raymarchHeightfield(() => 0, 50, 50, 0, 0, -20, 10, 25, dx, dy, dz);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeGreaterThan(0);
    expect(hit!.y).toBeCloseTo(0, 2);
  });
});

describe('pickBuildingBox', () => {
  const house = makeBuilding(7, 'woodenHouse', 10, 10, 3, 3);
  const field = makeBuilding(8, 'cropField', 20, 10, 5, 5);
  it('hits a house roof before the ground behind it', () => {
    // ray passing through the house volume at mid height, travelling +x
    const r = pickBuildingBox([house, field], () => 0, 0, 1, 11.5, 1, 0, 0, 1000);
    expect(r?.id).toBe(7);
    expect(r!.t).toBeCloseTo(10.15, 2);
  });
  it('ignores zones and rays that pass above', () => {
    expect(pickBuildingBox([house, field], () => 0, 0, 5, 11.5, 1, 0, 0, 1000)).toBeNull();
    expect(pickBuildingBox([field], () => 0, 22, 5, 12, 0, -1, 0, 1000)).toBeNull();
  });
  it('respects the max distance (terrain hit in front)', () => {
    expect(pickBuildingBox([house], () => 0, 0, 1, 11.5, 1, 0, 0, 5)).toBeNull();
  });
});
