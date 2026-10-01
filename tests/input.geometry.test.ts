import { describe, expect, it } from 'vitest';
import {
  centredFootprint, chunkTiles, clampRectToMap, footprintOrigin, footprintRect, modelDims, nextRotation, normalizeRect,
  rectTileCount, roadPath, roadPathIndices, TILES_PER_COMMAND, zoneRectFromDrag,
} from '../src/input/geometry';

describe('normalizeRect / clampRectToMap', () => {
  it('orders corners regardless of drag direction', () => {
    expect(normalizeRect(5, 9, 2, 3)).toEqual({ x0: 2, z0: 3, x1: 5, z1: 9 });
    expect(normalizeRect(2, 3, 5, 9)).toEqual({ x0: 2, z0: 3, x1: 5, z1: 9 });
    expect(normalizeRect(4, 4, 4, 4)).toEqual({ x0: 4, z0: 4, x1: 4, z1: 4 });
  });

  it('clamps to the map and rejects rectangles fully outside', () => {
    expect(clampRectToMap({ x0: -3, z0: -1, x1: 4, z1: 200 }, 128, 128)).toEqual({ x0: 0, z0: 0, x1: 4, z1: 127 });
    expect(clampRectToMap({ x0: 130, z0: 0, x1: 140, z1: 5 }, 128, 128)).toBeNull();
    expect(clampRectToMap({ x0: -5, z0: -5, x1: -1, z1: 3 }, 128, 128)).toBeNull();
  });

  it('counts tiles inclusively', () => {
    expect(rectTileCount({ x0: 0, z0: 0, x1: 0, z1: 0 })).toBe(1);
    expect(rectTileCount({ x0: 2, z0: 3, x1: 5, z1: 9 })).toBe(4 * 7);
  });
});

describe('footprint centring', () => {
  it('centres odd sizes on the cursor tile', () => {
    // cursor anywhere inside tile 10 → a 3-wide footprint covers 9..11
    for (const wx of [10.0, 10.3, 10.5, 10.99]) expect(footprintOrigin(wx, 3, 128)).toBe(9);
    expect(footprintOrigin(10.5, 5, 128)).toBe(8);
    expect(footprintOrigin(10.5, 1, 128)).toBe(10);
  });

  it('snaps even sizes to the nearest tile corner', () => {
    expect(footprintOrigin(10.2, 4, 128)).toBe(8); // covers 8..11, centre 10.0
    expect(footprintOrigin(10.8, 4, 128)).toBe(9); // covers 9..12, centre 11.0
  });

  it('keeps the footprint inside the map', () => {
    expect(footprintOrigin(0.2, 5, 128)).toBe(0);
    expect(footprintOrigin(127.9, 5, 128)).toBe(123);
    const f = centredFootprint(127.5, 0.5, 4, 5, 128, 100);
    expect(f).toEqual({ x: 124, z: 0, w: 4, h: 5 });
  });

  it('footprint centre stays within half a tile of the cursor away from edges', () => {
    for (let k = 0; k < 200; k++) {
      const wx = 20 + Math.random() * 80;
      const wz = 20 + Math.random() * 80;
      const w = 1 + Math.floor(Math.random() * 8);
      const h = 1 + Math.floor(Math.random() * 8);
      const f = centredFootprint(wx, wz, w, h, 128, 128);
      expect(Math.abs(f.x + w / 2 - wx)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(f.z + h / 2 - wz)).toBeLessThanOrEqual(0.5 + 1e-9);
      // the cursor tile is always covered
      expect(Math.floor(wx)).toBeGreaterThanOrEqual(f.x);
      expect(Math.floor(wx)).toBeLessThan(f.x + w);
    }
  });

  it('footprintRect is the inclusive tile range', () => {
    expect(footprintRect({ x: 3, z: 4, w: 2, h: 3 })).toEqual({ x0: 3, z0: 4, x1: 4, z1: 6 });
  });
});

describe('zoneRectFromDrag', () => {
  const W = 128;
  const H = 128;

  it('grows from the anchor in the drag direction', () => {
    expect(zoneRectFromDrag(10, 10, 17, 14, 4, 15, W, H)).toEqual({ x: 10, z: 10, w: 8, h: 5 });
    expect(zoneRectFromDrag(20, 20, 13, 12, 4, 15, W, H)).toEqual({ x: 13, z: 12, w: 8, h: 9 });
  });

  it('enforces the minimum size in the drag direction', () => {
    expect(zoneRectFromDrag(10, 10, 11, 10, 4, 15, W, H)).toEqual({ x: 10, z: 10, w: 4, h: 4 });
    expect(zoneRectFromDrag(10, 10, 9, 9, 4, 15, W, H)).toEqual({ x: 7, z: 7, w: 4, h: 4 });
  });

  it('enforces the maximum size', () => {
    expect(zoneRectFromDrag(10, 10, 60, 11, 4, 15, W, H)).toEqual({ x: 10, z: 10, w: 15, h: 4 });
    expect(zoneRectFromDrag(60, 60, 0, 0, 4, 15, W, H)).toEqual({ x: 46, z: 46, w: 15, h: 15 });
  });

  it('stays inside the map', () => {
    expect(zoneRectFromDrag(1, 1, 0, 0, 4, 15, W, H)).toEqual({ x: 0, z: 0, w: 4, h: 4 });
    expect(zoneRectFromDrag(126, 126, 127, 127, 4, 15, W, H)).toEqual({ x: 124, z: 124, w: 4, h: 4 });
  });

  it('always yields sides within [min, max]', () => {
    for (let k = 0; k < 300; k++) {
      const ax = Math.floor(Math.random() * W);
      const az = Math.floor(Math.random() * H);
      const bx = Math.floor(Math.random() * W);
      const bz = Math.floor(Math.random() * H);
      const r = zoneRectFromDrag(ax, az, bx, bz, 3, 10, W, H);
      expect(r.w).toBeGreaterThanOrEqual(3);
      expect(r.w).toBeLessThanOrEqual(10);
      expect(r.h).toBeGreaterThanOrEqual(3);
      expect(r.h).toBeLessThanOrEqual(10);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.z).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(W);
      expect(r.z + r.h).toBeLessThanOrEqual(H);
    }
  });
});

describe('roadPath', () => {
  it('single tile', () => {
    expect(roadPath(5, 5, 5, 5)).toEqual([[5, 5]]);
  });

  it('straight lines in all directions', () => {
    expect(roadPath(2, 3, 5, 3)).toEqual([[2, 3], [3, 3], [4, 3], [5, 3]]);
    expect(roadPath(5, 3, 2, 3)).toEqual([[5, 3], [4, 3], [3, 3], [2, 3]]);
    expect(roadPath(1, 1, 1, 4)).toEqual([[1, 1], [1, 2], [1, 3], [1, 4]]);
    expect(roadPath(1, 4, 1, 1)).toEqual([[1, 4], [1, 3], [1, 2], [1, 1]]);
  });

  it('bends after the dominant axis', () => {
    // |dx| > |dz| → horizontal first, then vertical at the end column
    expect(roadPath(0, 0, 3, 1)).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]]);
    // |dz| > |dx| → vertical first, then horizontal at the end row
    expect(roadPath(0, 0, 1, 3)).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]]);
    expect(roadPath(4, 4, 2, 0)).toEqual([[4, 4], [4, 3], [4, 2], [4, 1], [4, 0], [3, 0], [2, 0]]);
  });

  it('is contiguous, unique and has manhattan length + 1 tiles', () => {
    for (let k = 0; k < 200; k++) {
      const a = [Math.floor(Math.random() * 30), Math.floor(Math.random() * 30)];
      const b = [Math.floor(Math.random() * 30), Math.floor(Math.random() * 30)];
      const p = roadPath(a[0], a[1], b[0], b[1]);
      expect(p.length).toBe(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + 1);
      expect(p[0]).toEqual([a[0], a[1]]);
      expect(p[p.length - 1]).toEqual([b[0], b[1]]);
      const seen = new Set(p.map(([x, z]) => `${x},${z}`));
      expect(seen.size).toBe(p.length);
      for (let i = 1; i < p.length; i++) {
        expect(Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1])).toBe(1);
      }
    }
  });

  it('roadPathIndices maps to tile indices and drops out-of-map tiles', () => {
    expect(roadPathIndices(0, 0, 2, 0, 10, 10)).toEqual([0, 1, 2]);
    expect(roadPathIndices(8, 1, 11, 1, 10, 10)).toEqual([18, 19]);
  });
});

describe('rotation helpers', () => {
  it('cycles rotations', () => {
    expect(nextRotation(0)).toBe(1);
    expect(nextRotation(3)).toBe(0);
  });

  it('model dims swap for odd rotations', () => {
    expect(modelDims(4, 5, 0)).toEqual([4, 5]);
    expect(modelDims(5, 4, 1)).toEqual([4, 5]);
    expect(modelDims(4, 5, 2)).toEqual([4, 5]);
    expect(modelDims(5, 4, 3)).toEqual([4, 5]);
  });
});

describe('chunkTiles (co-op command size)', () => {
  it('keeps short lists whole and splits long ones in order', () => {
    expect(chunkTiles([])).toEqual([[]]);
    expect(chunkTiles([1, 2, 3])).toEqual([[1, 2, 3]]);
    const long = Array.from({ length: TILES_PER_COMMAND * 2 + 5 }, (_, i) => i);
    const parts = chunkTiles(long);
    expect(parts.map((p) => p.length)).toEqual([TILES_PER_COMMAND, TILES_PER_COMMAND, 5]);
    expect(parts.flat()).toEqual(long);
  });

  it('a full chunk of large tile indices stays well under the room payload limit', () => {
    const tiles = Array.from({ length: TILES_PER_COMMAND }, (_, i) => 43000 + i);
    const json = JSON.stringify({ op: 'road', kind: 'stone', tiles });
    expect(json.length).toBeLessThan(1000);
  });
});
