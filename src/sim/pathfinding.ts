/**
 * A* pathfinding on the tile grid + walkability regions. OWNER: sim-world agent.
 *
 * Design (ARCHITECTURE.md §4):
 * - 8-neighbour A* with an indexed binary min-heap (decrease-key), octile heuristic, no diagonal corner cutting.
 * - All per-node scratch arrays are typed arrays that are allocated once per map size and reused between searches.
 *   A "generation" stamp avoids clearing them: a node's data is only valid when `stamp[i] === gen`.
 * - Step cost = step length (1 or √2) × cost multiplier of the tile being entered (see core/world `tileCost`:
 *   roads/bridges are cheaper, dense forest is more expensive).
 * - Walkability = core/world `isWalkable` semantics: land terrain or bridges; building tiles block unless the building
 *   type is a walkable zone (fields, stockpiles, pastures, cemeteries). Building types are resolved through
 *   `game.buildingById`.
 * - The start tile is always treated as walkable. If the start is inside a blocked area (e.g. a building footprint
 *   was placed over a citizen, or a bridge was removed under them), the search may "escape" through connected blocked
 *   tiles of the same kind (building tiles, or shallow water) at a penalty until it reaches walkable ground.
 * - Goal: when `adjacent` (default) and the goal tile is not walkable, the search ends on the nearest walkable tile
 *   around it: any walkable tile within Chebyshev distance R of the goal, where R (1..12) is the smallest ring around
 *   the goal that contains a walkable tile of the start's region. R = 1 is the usual door / shore / building-side
 *   case; larger R handles building centres and water tiles far from the shore. When `adjacent` is false the blocked
 *   goal tile itself is entered as the very last step (requires a walkable 8-neighbour).
 * - Unreachable goals are rejected cheaply via the connected-component `region` labels before searching.
 *   Regions are recomputed lazily if `rev.terrain`/`rev.roads` changed since the last computation.
 * - The heuristic weight is the cheapest tile cost that currently exists on the map (1.0 without roads, 0.6 with
 *   dirt roads/bridges, 0.45 with stone roads), which keeps A* admissible (optimal) yet fast on road-less maps.
 *   For long trips (> LONG_TRIP tiles) the weight ramps up towards the grass cost (weighted A*): paths stay good
 *   and still follow roads they meet, but the search no longer floods half the map.
 */
import { COST_BRIDGE, COST_DIRT_ROAD, COST_GRASS, COST_STONE_ROAD } from '../core/constants';
import { BUILDINGS } from '../core/defs';
import type { GameState } from '../core/types';
import { Road, Terrain } from '../core/types';
import { tileCost } from '../core/world';
import type { Game } from './game';

export interface PathOptions {
  /** If the goal tile is not walkable, path to the nearest walkable neighbour instead (default true). */
  adjacent?: boolean;
  /** Abort after expanding this many nodes (default: W*H). */
  maxNodes?: number;
}

const SQRT2 = Math.SQRT2;
/** Cost multiplier for "escaping" through blocked tiles when the start tile is itself blocked. */
const ESCAPE_COST = 4;
/** Trips longer than this (octile tiles) use a gradually inflated heuristic weight (see findPath). */
const LONG_TRIP = 48;
/** Extra tiles over LONG_TRIP per +1.0 of heuristic weight (capped at the grass cost). */
const LONG_TRIP_RAMP = 160;
/** Blocked goals: how far (Chebyshev rings) to look for walkable approach tiles. */
const MAX_GOAL_RING = 12;
/** Tie-breaker: slightly inflate h so that among equal-f nodes the one closer to the goal is expanded first. */
const TIE_BREAK = 1 + 1 / 1024;

// Neighbour offsets: 4 orthogonal first, then 4 diagonals.
const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DZ = [0, 0, 1, -1, 1, 1, -1, -1];

// ---------------------------------------------------------------------------------------------
// Reusable scratch buffers
// ---------------------------------------------------------------------------------------------

let capN = 0;
let gScore = new Float64Array(0);
let parent = new Int32Array(0);
/** Stamp when the node was first touched this search (its g/parent are valid). */
let seenStamp = new Uint32Array(0);
/** Stamp when the node was closed (expanded) this search. */
let closedStamp = new Uint32Array(0);
/** Node flags this search: bit0 = reached through blocked tiles ("escaping"). */
let nodeFlags = new Uint8Array(0);
/** Position of the node within the heap, or -1. Valid only when seenStamp matches. */
let heapPos = new Int32Array(0);
let heapNode = new Int32Array(0);
let heapF = new Float64Array(0);
let heapSize = 0;
let gen = 0;

/** Scratch per-tile walkability for the current search: 0 unknown, 1 walkable, 2 blocked(building land), 3 blocked other. */
let walkCache = new Uint8Array(0);
let walkStamp = new Uint32Array(0);

let statSearches = 0;
let statNodes = 0;

function ensureCapacity(n: number): void {
  if (n <= capN) return;
  capN = n;
  gScore = new Float64Array(n);
  parent = new Int32Array(n);
  seenStamp = new Uint32Array(n);
  closedStamp = new Uint32Array(n);
  nodeFlags = new Uint8Array(n);
  heapPos = new Int32Array(n);
  heapNode = new Int32Array(n);
  heapF = new Float64Array(n);
  walkCache = new Uint8Array(n);
  walkStamp = new Uint32Array(n);
  gen = 0;
}

function nextGen(): void {
  gen++;
  if (gen >= 0xfffffff0) {
    // Wrap-around: clear stamps once every ~4 billion searches.
    seenStamp.fill(0);
    closedStamp.fill(0);
    walkStamp.fill(0);
    gen = 1;
  }
}

// ---- indexed binary min-heap on heapF ---------------------------------------------------------

function heapSwap(a: number, b: number): void {
  const na = heapNode[a];
  const nb = heapNode[b];
  const fa = heapF[a];
  heapNode[a] = nb;
  heapF[a] = heapF[b];
  heapNode[b] = na;
  heapF[b] = fa;
  heapPos[nb] = a;
  heapPos[na] = b;
}

function heapUp(pos: number): void {
  while (pos > 0) {
    const p = (pos - 1) >> 1;
    if (heapF[p] <= heapF[pos]) break;
    heapSwap(p, pos);
    pos = p;
  }
}

function heapDown(pos: number): void {
  for (;;) {
    const l = pos * 2 + 1;
    if (l >= heapSize) break;
    const r = l + 1;
    const c = r < heapSize && heapF[r] < heapF[l] ? r : l;
    if (heapF[pos] <= heapF[c]) break;
    heapSwap(pos, c);
    pos = c;
  }
}

function heapPush(node: number, f: number): void {
  const pos = heapSize++;
  heapNode[pos] = node;
  heapF[pos] = f;
  heapPos[node] = pos;
  heapUp(pos);
}

function heapPop(): number {
  const top = heapNode[0];
  heapSize--;
  heapPos[top] = -1;
  if (heapSize > 0) {
    heapNode[0] = heapNode[heapSize];
    heapF[0] = heapF[heapSize];
    heapPos[heapNode[0]] = 0;
    heapDown(0);
  }
  return top;
}

function heapDecrease(node: number, f: number): void {
  const pos = heapPos[node];
  heapF[pos] = f;
  heapUp(pos);
}

// ---------------------------------------------------------------------------------------------
// Map-derived caches (heuristic weight, region freshness)
// ---------------------------------------------------------------------------------------------

interface MapCache {
  roadsRev: number;
  terrainRev: number;
  /** Cheapest tile cost multiplier present on the map (heuristic weight). */
  minCost: number;
  /** Revisions at which `region` was last computed by us. -1 = unknown (computed elsewhere / loaded). */
  regionRoadsRev: number;
  regionTerrainRev: number;
}

const mapCaches = new WeakMap<GameState['tiles'], MapCache>();

function getMapCache(state: GameState): MapCache {
  let c = mapCaches.get(state.tiles);
  if (!c) {
    c = { roadsRev: -1, terrainRev: -1, minCost: COST_GRASS, regionRoadsRev: -1, regionTerrainRev: -1 };
    mapCaches.set(state.tiles, c);
  }
  if (c.roadsRev !== state.rev.roads || c.terrainRev !== state.rev.terrain) {
    let hasDirt = false;
    let hasStone = false;
    let hasBridge = false;
    const road = state.tiles.road;
    for (let i = 0, n = road.length; i < n; i++) {
      const r = road[i];
      if (r === Road.None) continue;
      if (r === Road.Dirt) hasDirt = true;
      else if (r === Road.Stone) hasStone = true;
      else if (r === Road.Bridge) hasBridge = true;
    }
    let m = COST_GRASS;
    if (hasDirt) m = Math.min(m, COST_DIRT_ROAD);
    if (hasStone) m = Math.min(m, COST_STONE_ROAD);
    if (hasBridge) m = Math.min(m, COST_BRIDGE);
    c.minCost = m;
    c.roadsRev = state.rev.roads;
    c.terrainRev = state.rev.terrain;
  }
  return c;
}

/** Make sure `tiles.region` reflects the current terrain/roads (recompute if revisions moved since we last did). */
function ensureRegions(state: GameState): void {
  const c = getMapCache(state);
  if (c.regionRoadsRev === -1) {
    // First time we see this state: trust the stored regions if they look populated, else compute.
    const region = state.tiles.region;
    let any = false;
    for (let i = 0, n = region.length; i < n; i += 97) {
      if (region[i] !== 0) {
        any = true;
        break;
      }
    }
    if (!any) computeRegions(state);
    else {
      c.regionRoadsRev = state.rev.roads;
      c.regionTerrainRev = state.rev.terrain;
    }
    return;
  }
  if (c.regionRoadsRev !== state.rev.roads || c.regionTerrainRev !== state.rev.terrain) computeRegions(state);
}

// ---------------------------------------------------------------------------------------------
// Walkability
// ---------------------------------------------------------------------------------------------

const WALK_OK = 1;
/** Blocked by a (non-walkable) building on land. */
const WALK_BUILDING = 2;
/** Blocked by terrain (water without bridge, mountain). */
const WALK_TERRAIN = 3;
/** Deep water / mountain: never passable even when escaping. */
const WALK_HARD = 4;

function classify(game: Game, state: GameState, i: number): number {
  if (walkStamp[i] === gen) return walkCache[i];
  const tiles = state.tiles;
  const t = tiles.terrain[i];
  let res: number;
  if (t === Terrain.Grass || t === Terrain.Sand) {
    const b = tiles.building[i];
    if (b >= 0) {
      const bd = game.buildingById.get(b);
      res = bd && BUILDINGS[bd.type]?.walkable ? WALK_OK : WALK_BUILDING;
    } else res = WALK_OK;
  } else if (tiles.road[i] === Road.Bridge) {
    res = WALK_OK;
  } else if (t === Terrain.Water) {
    res = WALK_TERRAIN;
  } else {
    res = WALK_HARD;
  }
  walkStamp[i] = gen;
  walkCache[i] = res;
  return res;
}

function costOf(state: GameState, i: number): number {
  // The contract's cost model (roads/bridges cheaper, dense forest slower) — single source of truth.
  return tileCost(state, i);
}

// ---------------------------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------------------------

/**
 * Find a path from tile (sx, sz) to tile (tx, tz). The start tile is always treated as walkable.
 * Returns tile indices EXCLUDING the start tile and INCLUDING the final tile, [] if already there, or null if unreachable.
 * 8-directional movement, no corner cutting past blocked tiles, costs from core/world tileCost.
 */
export function findPath(game: Game, sx: number, sz: number, tx: number, tz: number, opts?: PathOptions): number[] | null {
  const state = game.state;
  const W = state.W;
  const H = state.H;
  sx |= 0;
  sz |= 0;
  tx |= 0;
  tz |= 0;
  if (sx < 0 || sz < 0 || sx >= W || sz >= H) return null;
  if (tx < 0 || tz < 0 || tx >= W || tz >= H) return null;
  const N = W * H;
  ensureCapacity(N);
  nextGen();
  statSearches++;

  const start = sz * W + sx;
  const goal = tz * W + tx;
  if (start === goal) return [];

  const adjacent = opts?.adjacent ?? true;
  const maxNodes = opts?.maxNodes ?? N;

  const goalClass = classify(game, state, goal);
  const goalWalkable = goalClass === WALK_OK;
  const startClass = classify(game, state, start);
  const startBlocked = startClass !== WALK_OK;
  // Escaping from a blocked start only crosses tiles of the same kind (out of a building footprint, or off a water
  // tile) — never e.g. from a riverside building straight through the river.
  escapeClass = startClass;

  // Region-based early rejection (terrain + bridges; ignores buildings, so it never rejects a reachable goal).
  ensureRegions(state);
  const region = state.tiles.region;
  const rs = startBlocked ? 0 : region[start];
  // ring > 0: the search ends on any walkable tile within Chebyshev distance `ring` of a blocked goal.
  let ring = 0;
  if (goalWalkable) {
    const rg = region[goal];
    if (rs !== 0 && rg !== 0 && rg !== rs) return null;
  } else {
    const r = goalRing(game, state, tx, tz, rs);
    if (r < 0) return null;
    if (adjacent) {
      ring = r;
      if (!startBlocked && Math.max(Math.abs(sx - tx), Math.abs(sz - tz)) <= ring) return [];
    } else if (r !== 1) {
      return null; // the blocked goal has no walkable neighbour to step in from
    }
  }

  const cache = getMapCache(state);
  // Exact (admissible) for normal trips; long trips gradually become weighted A* (bounded suboptimality) so a
  // cross-map search on a road-rich map does not degenerate into a near-Dijkstra flood.
  const tripLen = octile(sx, sz, tx, tz);
  let w = cache.minCost;
  if (tripLen > LONG_TRIP) w = Math.min(COST_GRASS, w + (tripLen - LONG_TRIP) / LONG_TRIP_RAMP);
  const hw = w * TIE_BREAK;
  const ringSlack = ring * SQRT2;

  gScore[start] = 0;
  parent[start] = -1;
  seenStamp[start] = gen;
  nodeFlags[start] = startBlocked ? 1 : 0;
  heapSize = 0;
  heapPush(start, heur(sx, sz, tx, tz, ringSlack) * hw);

  let expanded = 0;
  let found = -1;

  while (heapSize > 0) {
    const cur = heapPop();
    closedStamp[cur] = gen;
    expanded++;

    const cx = cur % W;
    const cz = (cur - cx) / W;

    if (cur === goal) {
      found = cur;
      break;
    }
    if (ring > 0 && cur !== start && (nodeFlags[cur] & 1) === 0 && Math.abs(cx - tx) <= ring && Math.abs(cz - tz) <= ring) {
      found = cur;
      break;
    }
    if (expanded > maxNodes) break;

    const escaping = (nodeFlags[cur] & 1) !== 0;
    const gCur = gScore[cur];

    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d];
      const nz = cz + DZ[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const ni = nz * W + nx;
      if (closedStamp[ni] === gen) continue;

      const cls = classify(game, state, ni);
      let nEscaping = false;
      let mult: number;
      if (cls === WALK_OK) {
        mult = costOf(state, ni);
      } else if (ni === goal && !adjacent) {
        // Final step into a blocked goal tile.
        mult = COST_GRASS;
      } else if (escaping && canEscapeThrough(cls)) {
        mult = ESCAPE_COST;
        nEscaping = true;
      } else {
        continue;
      }

      let step: number;
      if (d >= 4) {
        // Diagonal: forbid corner cutting — both orthogonal tiles must be passable for this mover.
        const ai = cz * W + nx;
        const bi = nz * W + cx;
        if (!cornerPassable(game, state, ai, escaping) || !cornerPassable(game, state, bi, escaping)) continue;
        step = SQRT2 * mult;
      } else {
        step = mult;
      }

      const g = gCur + step;
      if (seenStamp[ni] === gen) {
        if (g >= gScore[ni]) continue;
        gScore[ni] = g;
        parent[ni] = cur;
        nodeFlags[ni] = nEscaping ? 1 : 0;
        const f = g + heur(nx, nz, tx, tz, ringSlack) * hw;
        if (heapPos[ni] >= 0) heapDecrease(ni, f);
        else heapPush(ni, f);
      } else {
        seenStamp[ni] = gen;
        gScore[ni] = g;
        parent[ni] = cur;
        nodeFlags[ni] = nEscaping ? 1 : 0;
        heapPush(ni, g + heur(nx, nz, tx, tz, ringSlack) * hw);
      }
    }
  }

  statNodes += expanded;
  if (found < 0) return null;

  // Reconstruct (excluding start).
  let len = 0;
  for (let n = found; n !== start; n = parent[n]) len++;
  const path = new Array<number>(len);
  let k = len - 1;
  for (let n = found; n !== start; n = parent[n]) path[k--] = n;
  return path;
}

/** Class of the blocked start tile for the current search (see findPath). */
let escapeClass = WALK_OK;

function canEscapeThrough(cls: number): boolean {
  if (cls === WALK_OK) return false;
  // A start on mountain/deep water (should not happen) may leave through any blocked tile.
  return escapeClass === WALK_HARD || cls === escapeClass;
}

function cornerPassable(game: Game, state: GameState, i: number, escaping: boolean): boolean {
  const cls = classify(game, state, i);
  if (cls === WALK_OK) return true;
  return escaping && canEscapeThrough(cls);
}

function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dz = az > bz ? az - bz : bz - az;
  return dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx;
}

/** Admissible distance estimate to the goal area (goal tile, or any tile within `ringSlack/√2` rings of it). */
function heur(ax: number, az: number, bx: number, bz: number, ringSlack: number): number {
  const h = octile(ax, az, bx, bz) - ringSlack;
  return h > 0 ? h : 0;
}

/**
 * Smallest Chebyshev ring (1..MAX_GOAL_RING) around a blocked goal that contains a walkable tile in region `rs`
 * (any region when rs = 0). -1 if none.
 */
function goalRing(game: Game, state: GameState, tx: number, tz: number, rs: number): number {
  const W = state.W;
  const H = state.H;
  const region = state.tiles.region;
  for (let r = 1; r <= MAX_GOAL_RING; r++) {
    for (let dz = -r; dz <= r; dz++) {
      const z = tz + dz;
      if (z < 0 || z >= H) continue;
      const edgeRow = dz === -r || dz === r;
      for (let dx = -r; dx <= r; dx += edgeRow ? 1 : 2 * r) {
        const x = tx + dx;
        if (x < 0 || x >= W) continue;
        const i = z * W + x;
        if (classify(game, state, i) !== WALK_OK) continue;
        if (rs !== 0 && region[i] !== 0 && region[i] !== rs) continue;
        return r;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------------------------

let regionQueue = new Int32Array(0);

function terrainWalkable(state: GameState, i: number): boolean {
  const t = state.tiles.terrain[i];
  return t === Terrain.Grass || t === Terrain.Sand || state.tiles.road[i] === Road.Bridge;
}

/** Recompute state.tiles.region (connected components of terrain walkability incl. bridges; buildings ignored). */
export function computeRegions(state: GameState): void {
  const W = state.W;
  const H = state.H;
  const N = W * H;
  const region = state.tiles.region;
  region.fill(0);
  if (regionQueue.length < N) regionQueue = new Int32Array(N);
  const q = regionQueue;
  let label = 0;
  for (let s = 0; s < N; s++) {
    if (region[s] !== 0 || !terrainWalkable(state, s)) continue;
    label++;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    region[s] = label;
    while (head < tail) {
      const i = q[head++];
      const x = i % W;
      // 4-connectivity is equivalent to 8-connectivity without corner cutting.
      if (x > 0) {
        const n = i - 1;
        if (region[n] === 0 && terrainWalkable(state, n)) {
          region[n] = label;
          q[tail++] = n;
        }
      }
      if (x < W - 1) {
        const n = i + 1;
        if (region[n] === 0 && terrainWalkable(state, n)) {
          region[n] = label;
          q[tail++] = n;
        }
      }
      if (i >= W) {
        const n = i - W;
        if (region[n] === 0 && terrainWalkable(state, n)) {
          region[n] = label;
          q[tail++] = n;
        }
      }
      if (i < N - W) {
        const n = i + W;
        if (region[n] === 0 && terrainWalkable(state, n)) {
          region[n] = label;
          q[tail++] = n;
        }
      }
    }
  }
  const c = getMapCache(state);
  c.regionRoadsRev = state.rev.roads;
  c.regionTerrainRev = state.rev.terrain;
}

/**
 * Region of the tile; for non-walkable tiles (water, mountains) the regions found on the nearest Chebyshev ring
 * (1..MAX_GOAL_RING) that contains any walkable tile — the same "nearest approach" rule findPath uses.
 */
function regionsNear(state: GameState, x: number, z: number, out: number[]): void {
  out.length = 0;
  const W = state.W;
  const H = state.H;
  if (x < 0 || z < 0 || x >= W || z >= H) return;
  const region = state.tiles.region;
  const r = region[z * W + x];
  if (r !== 0) {
    out.push(r);
    return;
  }
  for (let ring = 1; ring <= MAX_GOAL_RING && out.length === 0; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= H) continue;
      const edgeRow = dz === -ring || dz === ring;
      for (let dx = -ring; dx <= ring; dx += edgeRow ? 1 : 2 * ring) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const rr = region[zz * W + xx];
        if (rr !== 0 && out.indexOf(rr) < 0) out.push(rr);
      }
    }
  }
}

const regA: number[] = [];
const regB: number[] = [];

/** Cheap reachability test using regions (ignores buildings). Water/mountain tiles use their nearest walkable neighbour's region. */
export function sameRegion(state: GameState, ax: number, az: number, bx: number, bz: number): boolean {
  ensureRegions(state);
  regionsNear(state, ax | 0, az | 0, regA);
  if (regA.length === 0) return false;
  regionsNear(state, bx | 0, bz | 0, regB);
  for (let i = 0; i < regA.length; i++) if (regB.indexOf(regA[i]) >= 0) return true;
  return false;
}

/** Number of A* searches performed (for perf HUD). */
export function pathStats(): { searches: number; nodes: number } {
  return { searches: statSearches, nodes: statNodes };
}

/** Reset the perf counters (tests / HUD sampling). */
export function resetPathStats(): void {
  statSearches = 0;
  statNodes = 0;
}
