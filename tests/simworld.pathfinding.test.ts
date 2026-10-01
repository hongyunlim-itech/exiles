import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameState } from '../src/core/types';
import { Feature, Road, Terrain } from '../src/core/types';
import { isWalkable, tileCost } from '../src/core/world';
import type { Game } from '../src/sim/game';
import { computeRegions, findPath, pathStats, sameRegion } from '../src/sim/pathfinding';
import { addBuilding, makeState, makeWorldState, mockGame, makeSettings } from './simworld.helpers';

function walkable(game: Game, i: number): boolean {
  return isWalkable(game.state, i, (id) => game.buildingById.get(id)?.type);
}

/** Validate path structure: contiguous 8-neighbour steps, walkable, no corner cutting. */
function checkPath(game: Game, sx: number, sz: number, path: number[], allowLastBlocked = false): void {
  const W = game.state.W;
  let px = sx;
  let pz = sz;
  path.forEach((i, k) => {
    const x = i % W;
    const z = Math.floor(i / W);
    const dx = x - px;
    const dz = z - pz;
    expect(Math.max(Math.abs(dx), Math.abs(dz))).toBe(1);
    const last = k === path.length - 1;
    if (!(last && allowLastBlocked)) expect(walkable(game, i)).toBe(true);
    if (dx !== 0 && dz !== 0) {
      expect(walkable(game, pz * W + x)).toBe(true);
      expect(walkable(game, z * W + px)).toBe(true);
    }
    px = x;
    pz = z;
  });
}

function pathCost(state: GameState, sx: number, sz: number, path: number[]): number {
  let c = 0;
  let px = sx;
  let pz = sz;
  for (const i of path) {
    const x = i % state.W;
    const z = Math.floor(i / state.W);
    c += (x !== px && z !== pz ? Math.SQRT2 : 1) * tileCost(state, i);
    px = x;
    pz = z;
  }
  return c;
}

/** Reference Dijkstra with the same cost model (walkable tiles only, no corner cutting). */
function dijkstra(game: Game, sx: number, sz: number, tx: number, tz: number): number {
  const s = game.state;
  const W = s.W;
  const N = W * s.H;
  const dist = new Float64Array(N).fill(Infinity);
  const done = new Uint8Array(N);
  const start = sz * W + sx;
  dist[start] = 0;
  for (;;) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bd) {
      bd = dist[i];
      best = i;
    }
    if (best < 0) return Infinity;
    if (best === tz * W + tx) return bd;
    done[best] = 1;
    const x = best % W;
    const z = Math.floor(best / W);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= s.H) continue;
      const ni = nz * W + nx;
      if (!walkable(game, ni)) continue;
      if (dx && dz && (!walkable(game, z * W + nx) || !walkable(game, nz * W + x))) continue;
      const nd = bd + (dx && dz ? Math.SQRT2 : 1) * tileCost(s, ni);
      if (nd < dist[ni]) dist[ni] = nd;
    }
  }
}

describe('findPath', () => {
  it('returns [] when already at the goal and excludes the start tile', () => {
    const s = makeState(20, 20);
    const g = mockGame(s);
    expect(findPath(g, 3, 3, 3, 3)).toEqual([]);
    const p = findPath(g, 2, 2, 8, 2)!;
    expect(p).not.toBeNull();
    expect(p.length).toBe(6);
    expect(p[0]).toBe(2 * 20 + 3);
    expect(p[p.length - 1]).toBe(2 * 20 + 8);
    checkPath(g, 2, 2, p);
  });

  it('moves diagonally on open ground (octile)', () => {
    const s = makeState(20, 20);
    const g = mockGame(s);
    const p = findPath(g, 1, 1, 9, 5)!;
    expect(p.length).toBe(8);
    expect(pathCost(s, 1, 1, p)).toBeCloseTo(4 + 4 * Math.SQRT2, 5);
  });

  it('routes through a gap in a wall and never cuts corners', () => {
    const s = makeState(30, 30);
    for (let z = 0; z < 30; z++) if (z !== 25) s.tiles.terrain[z * 30 + 15] = Terrain.Mountain;
    const g = mockGame(s);
    const p = findPath(g, 5, 5, 25, 5)!;
    expect(p).not.toBeNull();
    checkPath(g, 5, 5, p);
    expect(p).toContain(25 * 30 + 15);
  });

  it('forbids squeezing diagonally between two blocked tiles', () => {
    const s = makeState(10, 10);
    // Checkerboard pinch: (5,4) and (4,5) blocked; moving (4,4)->(5,5) diagonally would cut both corners.
    for (let x = 0; x < 10; x++) {
      if (x !== 5) s.tiles.terrain[4 * 10 + x] = Terrain.Mountain;
    }
    for (let x = 0; x < 10; x++) {
      if (x !== 4) s.tiles.terrain[5 * 10 + x] = Terrain.Mountain;
    }
    const g = mockGame(s);
    // From above row 4 to below row 5 the only connection would be the diagonal (5,4)->(4,5): illegal.
    expect(findPath(g, 2, 2, 2, 8)).toBeNull();
  });

  it('returns null when the goal is unreachable (terrain) and for out-of-bounds', () => {
    const s = makeState(30, 30);
    for (let z = 0; z < 30; z++) for (let x = 14; x < 17; x++) s.tiles.terrain[z * 30 + x] = Terrain.Water;
    computeRegions(s);
    const g = mockGame(s);
    expect(findPath(g, 5, 5, 25, 5)).toBeNull();
    expect(findPath(g, 5, 5, 40, 5)).toBeNull();
    expect(sameRegion(s, 5, 5, 25, 5)).toBe(false);
    // Water tile adjacent to the west bank counts as that bank's region.
    expect(sameRegion(s, 5, 5, 14, 5)).toBe(true);
    // The middle of the 3-wide river is reachable (for fishing etc.) from both banks.
    expect(sameRegion(s, 5, 5, 15, 5)).toBe(true);
    expect(sameRegion(s, 25, 5, 15, 5)).toBe(true);
    // A lake centre far from the shore uses the nearest shore ring.
    const l = makeState(30, 30);
    for (let z = 5; z < 25; z++) for (let x = 5; x < 25; x++) l.tiles.terrain[z * 30 + x] = Terrain.DeepWater;
    computeRegions(l);
    expect(sameRegion(l, 1, 1, 15, 15)).toBe(true);
    expect(findPath(mockGame(l), 1, 1, 15, 15)).not.toBeNull();
  });

  it('crosses rivers over bridges only (regions recomputed after roads change)', () => {
    const s = makeState(30, 30);
    for (let z = 0; z < 30; z++) for (let x = 14; x < 17; x++) s.tiles.terrain[z * 30 + x] = Terrain.Water;
    computeRegions(s);
    const g = mockGame(s);
    expect(findPath(g, 5, 20, 25, 20)).toBeNull();
    for (let x = 14; x < 17; x++) s.tiles.road[10 * 30 + x] = Road.Bridge;
    s.rev.roads++;
    const p = findPath(g, 5, 20, 25, 20)!;
    expect(p).not.toBeNull();
    checkPath(g, 5, 20, p);
    expect(p).toContain(10 * 30 + 15);
    expect(sameRegion(s, 5, 20, 25, 20)).toBe(true);
  });

  it('is blocked by buildings but walks through walkable zones', () => {
    const s = makeState(30, 30);
    const g = mockGame(s);
    // A long house wall with one stockpile (walkable zone) gap.
    addBuilding(g, 'boardingHouse', 10, 0, 4, 12);
    addBuilding(g, 'boardingHouse', 10, 16, 4, 14);
    addBuilding(g, 'stockpile', 10, 12, 4, 4);
    const p = findPath(g, 3, 3, 25, 3)!;
    expect(p).not.toBeNull();
    checkPath(g, 3, 3, p);
    expect(p.some((i) => s.tiles.building[i] >= 0 && g.buildingById.get(s.tiles.building[i])!.type === 'stockpile')).toBe(true);
    // Close the gap with a house: now unreachable (regions ignore buildings, so this exercises the search itself).
    addBuilding(g, 'woodenHouse', 10, 12, 4, 4);
    for (let z = 12; z < 16; z++) for (let x = 10; x < 14; x++) s.tiles.building[z * 30 + x] = s.nextId - 1;
    expect(findPath(g, 3, 3, 25, 3)).toBeNull();
  });

  it('adjacent goal semantics for blocked goal tiles', () => {
    const s = makeState(20, 20);
    const g = mockGame(s);
    addBuilding(g, 'woodenHouse', 10, 10, 3, 3);
    const goal = 11 * 20 + 11; // centre of the house
    const p = findPath(g, 2, 2, 11, 11)!;
    expect(p).not.toBeNull();
    const last = p[p.length - 1];
    expect(last).not.toBe(goal);
    expect(walkable(g, last)).toBe(true);
    // Centre tile has no walkable neighbours → adjacent is impossible → but an edge tile works:
    const q = findPath(g, 2, 2, 10, 10)!;
    const lx = q[q.length - 1] % 20;
    const lz = Math.floor(q[q.length - 1] / 20);
    expect(Math.max(Math.abs(lx - 10), Math.abs(lz - 10))).toBe(1);
    // adjacent:false enters the blocked goal tile as the last step
    const r = findPath(g, 2, 2, 10, 10, { adjacent: false })!;
    expect(r[r.length - 1]).toBe(10 * 20 + 10);
    checkPath(g, 2, 2, r, true);
    // Already adjacent → []
    expect(findPath(g, 9, 9, 10, 10)).toEqual([]);
  });

  it('paths to water tiles end on the shore', () => {
    const s = makeState(20, 20);
    for (let z = 0; z < 20; z++) for (let x = 12; x < 20; x++) s.tiles.terrain[z * 20 + x] = Terrain.Water;
    const g = mockGame(s);
    const p = findPath(g, 2, 5, 15, 5)!;
    expect(p).not.toBeNull();
    const last = p[p.length - 1];
    expect(last % 20).toBe(11);
  });

  it('treats the start tile as walkable and escapes from inside a building', () => {
    const s = makeState(20, 20);
    const g = mockGame(s);
    addBuilding(g, 'storageBarn', 5, 5, 4, 5);
    const p = findPath(g, 6, 7, 15, 15)!;
    expect(p).not.toBeNull();
    expect(p[p.length - 1]).toBe(15 * 20 + 15);
  });

  it('escaping from a blocked start never crosses water (or other blocked kinds)', () => {
    const s = makeState(30, 20);
    for (let z = 0; z < 20; z++) for (let x = 14; x < 17; x++) s.tiles.terrain[z * 30 + x] = Terrain.Water;
    computeRegions(s);
    const g = mockGame(s);
    // A riverside building: citizen inside it cannot "escape" across the river.
    addBuilding(g, 'storageBarn', 10, 5, 4, 5);
    expect(findPath(g, 12, 7, 25, 7)).toBeNull();
    const back = findPath(g, 12, 7, 3, 7)!;
    expect(back).not.toBeNull();
    // Stranded on a water tile (bridge removed): wades to the nearest bank, then walks on.
    const p = findPath(g, 15, 15, 25, 15)!;
    expect(p).not.toBeNull();
    expect(p[p.length - 1]).toBe(15 * 30 + 25);
  });

  it('prefers roads and avoids dense forest when cheaper', () => {
    const s = makeState(40, 12);
    // Road along row 1; straight line along row 6 is shorter but grassy.
    for (let x = 0; x < 40; x++) s.tiles.road[1 * 40 + x] = Road.Stone;
    s.rev.roads++;
    const g = mockGame(s);
    const p = findPath(g, 2, 6, 37, 6)!;
    const onRoad = p.filter((i) => s.tiles.road[i] !== Road.None).length;
    expect(onRoad).toBeGreaterThan(20);
    // Forest wall costs more than a detour of equal length.
    const f = makeState(20, 20);
    for (let z = 0; z < 15; z++) {
      f.tiles.feature[z * 20 + 10] = Feature.Tree;
      f.tiles.featureAmount[z * 20 + 10] = 1;
    }
    const gf = mockGame(f);
    const q = findPath(gf, 5, 5, 15, 5)!;
    expect(pathCost(f, 5, 5, q)).toBeCloseTo(dijkstra(gf, 5, 5, 15, 5), 6);
  });

  it('respects maxNodes', () => {
    const s = makeState(60, 60);
    const g = mockGame(s);
    expect(findPath(g, 1, 1, 58, 58, { maxNodes: 10 })).toBeNull();
    expect(findPath(g, 1, 1, 58, 58)).not.toBeNull();
  });

  it('finds optimal paths (matches Dijkstra) on random maps', () => {
    const rng = new Rng(99);
    for (let trial = 0; trial < 12; trial++) {
      const s = makeState(24, 24);
      for (let i = 0; i < s.tiles.terrain.length; i++) {
        const r = rng.next();
        if (r < 0.18) s.tiles.terrain[i] = Terrain.Mountain;
        else if (r < 0.3) {
          s.tiles.feature[i] = Feature.Tree;
          s.tiles.featureAmount[i] = 1;
        } else if (r < 0.4) s.tiles.road[i] = rng.chance(0.5) ? Road.Dirt : Road.Stone;
      }
      s.rev.roads++;
      computeRegions(s);
      const g = mockGame(s);
      let sx: number, sz: number, tx: number, tz: number;
      do {
        sx = rng.int(0, 23);
        sz = rng.int(0, 23);
      } while (s.tiles.terrain[sz * 24 + sx] === Terrain.Mountain);
      do {
        tx = rng.int(0, 23);
        tz = rng.int(0, 23);
      } while (s.tiles.terrain[tz * 24 + tx] === Terrain.Mountain);
      const p = findPath(g, sx, sz, tx, tz);
      const ref = dijkstra(g, sx, sz, tx, tz);
      if (ref === Infinity) {
        expect(p).toBeNull();
      } else {
        expect(p).not.toBeNull();
        checkPath(g, sx, sz, p!);
        expect(pathCost(s, sx, sz, p!)).toBeCloseTo(ref, 6);
      }
    }
  });

  it('is fast on a large generated map', () => {
    const { state } = makeWorldState(makeSettings({ mapSize: 'large', seed: 7 }));
    const g = mockGame(state);
    computeRegions(state);
    const rng = new Rng(5);
    const W = state.W;
    const land: number[] = [];
    for (let i = 0; i < state.tiles.terrain.length; i++) {
      const t = state.tiles.terrain[i];
      if (t === Terrain.Grass || t === Terrain.Sand) land.push(i);
    }
    const before = pathStats().searches;
    let total = 0;
    let max = 0;
    let found = 0;
    const RUNS = 300;
    for (let k = 0; k < RUNS; k++) {
      const a = land[Math.floor(rng.next() * land.length)];
      // Typical in-town trips: up to ~50 tiles away.
      const ax = a % W;
      const az = Math.floor(a / W);
      const bx = Math.max(0, Math.min(W - 1, ax + rng.int(-50, 50)));
      const bz = Math.max(0, Math.min(state.H - 1, az + rng.int(-50, 50)));
      const t0 = performance.now();
      const p = findPath(g, ax, az, bx, bz);
      const dt = performance.now() - t0;
      total += dt;
      max = Math.max(max, dt);
      if (p) found++;
    }
    expect(pathStats().searches - before).toBe(RUNS);
    const avg = total / RUNS;
    console.log(`[pathfinding] large map: avg ${avg.toFixed(3)} ms, max ${max.toFixed(2)} ms, found ${found}/${RUNS}`);
    // Typical: ~0.15 ms. Generous bound so parallel/contended CI runs don't flake.
    expect(avg).toBeLessThan(25);
  });
});
