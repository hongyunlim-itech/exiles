/**
 * Save-game (de)serialization. OWNER: sim-world agent.
 * Must round-trip GameState exactly (typed arrays included). Keep output compact for localStorage
 * (RLE / base64 typed arrays; derivable arrays such as `region` and `building` may be omitted and rebuilt).
 *
 * Format (a JSON string):
 * ```
 * { "format": "exiles-save", "version": SAVE_VERSION, "W": 160, "H": 160,
 *   "state": { ...every GameState field except `tiles`... },
 *   "tiles": { "height": "<enc>", "terrain": "<enc>", "feature": "<enc>", "featureAmount": "<enc>",
 *              "variant": "<enc>", "road": "<enc>", "building": "<enc>", "marked": "<enc>" } }
 * ```
 * Typed-array encodings (`<codec>:<base64 payload>`), all lossless:
 * - `rle:`    Uint8Array → PackBits RLE.
 * - `g<scale>:` corner heights whose values are exact multiples of 1/scale (256 … 65536) → residuals of a 2D gradient
 *             predictor as zigzag varints → RLE. (World generation quantises heights to 1/256; flattening averages of
 *             four such corners stay on the 1/1024 grid, repeated flattening on finer power-of-two grids.)
 * - `sp:`     mostly-zero Float32Array (feature amounts) → zero/non-zero run lengths + non-zero values (quantised
 *             deltas when exact, else byte-shuffled float32) → RLE.
 * - `q10:`    Float32Array, exact multiples of 1/1024 → row deltas as zigzag varints → RLE (generic fallback).
 * - `f32s:`   Float32Array (general) → byte-plane shuffle → RLE (generic fallback).
 * - `i32s:`   Int32Array → byte-plane shuffle → RLE.
 *
 * `tiles.building` IS stored (it is tiny once encoded — almost all -1) so a load reproduces it exactly.
 * `tiles.region` is NOT stored: `deserializeState` rebuilds it with `computeRegions` (deterministic labels).
 * The returned GameState is therefore complete; Game.fromSave only needs to rebuild its runtime indexes
 * (citizenById / buildingById / animalById, job boards, etc.).
 */
import { SAVE_VERSION } from '../core/constants';
import type { GameState, TileData } from '../core/types';
import { Feature, Road, Terrain } from '../core/types';
import { computeRegions } from './pathfinding';
import {
  decodeQuantGrid, decodeSparseF32, decodeZigzagVarints, encodeQuantGrid, encodeSparseF32, encodeZigzagVarints, fromBase64,
  packBits, shuffleBytes, toBase64, unpackBits, unpackBitsAuto, unshuffleBytes,
} from './world/codec';

const FORMAT = 'exiles-save';
const MAX_MAP = 1024;
const QUANT = 1024;
/** Quantisation grids tried for heights (repeated flattening averages move values to finer grids). */
const GRID_SCALES = [256, 1024, 4096, 16384, 65536];

type EncodedTiles = Record<Exclude<keyof TileData, 'region'>, string>;

interface SaveEnvelope {
  format: string;
  version: number;
  W: number;
  H: number;
  state: Omit<GameState, 'tiles'>;
  tiles: EncodedTiles;
}

// ---------------------------------------------------------------------------------------------
// typed array encoders
// ---------------------------------------------------------------------------------------------

function encU8(a: Uint8Array): string {
  return 'rle:' + toBase64(packBits(a));
}

function bytesOf(a: Float32Array | Int32Array): Uint8Array {
  // Copy so the result is independent of the original buffer & byte offset.
  return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
}

/** Generic lossless float array encoding: quantised row deltas when exact, else byte-shuffled float32. */
function encF32(a: Float32Array): string {
  let ok = true;
  const q = new Int32Array(a.length);
  let prev = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    const k = Math.round(v * QUANT);
    if (!(Math.abs(k) < 1 << 26) || Math.fround(k / QUANT) !== v || (v === 0 && 1 / v < 0)) {
      ok = false;
      break;
    }
    q[i] = k - prev;
    prev = k;
  }
  if (ok) return 'q10:' + toBase64(packBits(encodeZigzagVarints(q)));
  return 'f32s:' + toBase64(packBits(shuffleBytes(bytesOf(a), 4)));
}

/** Corner heights: 2D-predicted quantised grid (1/256 or 1/1024 units) when exact, else the generic codec. */
function encHeights(a: Float32Array, w: number, h: number): string {
  const g = encodeQuantGrid(a, w, h, GRID_SCALES);
  if (g) return `g${g.scale}:` + toBase64(g.bytes);
  return encF32(a);
}

/** Mostly-zero feature amounts: sparse codec. */
function encSparse(a: Float32Array): string {
  return 'sp:' + toBase64(encodeSparseF32(a));
}

function encI32(a: Int32Array): string {
  return 'i32s:' + toBase64(packBits(shuffleBytes(bytesOf(a), 4)));
}

function splitCodec(name: string, s: unknown): [string, Uint8Array] {
  if (typeof s !== 'string') throw new Error(`Save is corrupt: tiles.${name} is missing`);
  const c = s.indexOf(':');
  if (c < 0) throw new Error(`Save is corrupt: tiles.${name} has no codec prefix`);
  let payload: Uint8Array;
  try {
    payload = fromBase64(s.slice(c + 1));
  } catch (e) {
    throw new Error(`Save is corrupt: tiles.${name}: ${(e as Error).message}`);
  }
  return [s.slice(0, c), payload];
}

function decU8(name: string, s: unknown, n: number): Uint8Array {
  const [codec, payload] = splitCodec(name, s);
  if (codec !== 'rle') throw new Error(`Save is corrupt: tiles.${name} has unknown codec "${codec}"`);
  try {
    return unpackBits(payload, n);
  } catch (e) {
    throw new Error(`Save is corrupt: tiles.${name}: ${(e as Error).message}`);
  }
}

function decF32(name: string, s: unknown, n: number, gridW = 0, gridH = 0): Float32Array {
  const [codec, payload] = splitCodec(name, s);
  try {
    if (codec.startsWith('g')) {
      const scale = Number(codec.slice(1));
      if (!GRID_SCALES.includes(scale)) throw new Error(`unknown grid scale ${codec}`);
      if (gridW * gridH !== n) throw new Error('grid codec used for a non-grid array');
      return decodeQuantGrid(payload, scale, gridW, gridH);
    }
    if (codec === 'sp') return decodeSparseF32(payload, n);
    if (codec === 'q10') {
      const d = decodeZigzagVarints(unpackBitsAuto(payload), n);
      const out = new Float32Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += d[i];
        out[i] = acc / QUANT;
      }
      return out;
    }
    if (codec === 'f32s') {
      const planes = unpackBits(payload, n * 4);
      const bytes = unshuffleBytes(planes, 4);
      return new Float32Array(bytes.buffer, 0, n);
    }
  } catch (e) {
    throw new Error(`Save is corrupt: tiles.${name}: ${(e as Error).message}`);
  }
  throw new Error(`Save is corrupt: tiles.${name} has unknown codec "${codec}"`);
}

function decI32(name: string, s: unknown, n: number): Int32Array {
  const [codec, payload] = splitCodec(name, s);
  if (codec !== 'i32s') throw new Error(`Save is corrupt: tiles.${name} has unknown codec "${codec}"`);
  try {
    const planes = unpackBits(payload, n * 4);
    const bytes = unshuffleBytes(planes, 4);
    return new Int32Array(bytes.buffer, 0, n);
  } catch (e) {
    throw new Error(`Save is corrupt: tiles.${name}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

export function serializeState(state: GameState): string {
  const { tiles, ...rest } = state;
  const env: SaveEnvelope = {
    format: FORMAT,
    version: SAVE_VERSION,
    W: state.W,
    H: state.H,
    state: { ...rest, version: SAVE_VERSION },
    tiles: {
      height: encHeights(tiles.height, state.W + 1, state.H + 1),
      terrain: encU8(tiles.terrain),
      feature: encU8(tiles.feature),
      featureAmount: encSparse(tiles.featureAmount),
      variant: encU8(tiles.variant),
      road: encU8(tiles.road),
      building: encI32(tiles.building),
      marked: encU8(tiles.marked),
    },
  };
  return JSON.stringify(env);
}

/** Throws a descriptive Error for corrupt/incompatible data. */
export function deserializeState(data: string): GameState {
  if (typeof data !== 'string' || data.length === 0) throw new Error('Save data is empty');
  let env: SaveEnvelope;
  try {
    env = JSON.parse(data) as SaveEnvelope;
  } catch (e) {
    throw new Error(`Save is not valid JSON: ${(e as Error).message}`);
  }
  if (!env || typeof env !== 'object') throw new Error('Save data is not an object');
  if (env.format !== FORMAT) throw new Error('Not an Exiles save file');
  if (typeof env.version !== 'number') throw new Error('Save has no version');
  if (env.version > SAVE_VERSION) {
    throw new Error(`Save was made by a newer version of the game (save v${env.version}, game v${SAVE_VERSION})`);
  }
  if (env.version < 1) throw new Error(`Unsupported save version ${env.version}`);
  const W = env.W;
  const H = env.H;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0 || W > MAX_MAP || H > MAX_MAP) {
    throw new Error(`Save has an invalid map size (${String(W)}x${String(H)})`);
  }
  const st = env.state as Partial<GameState> | undefined;
  if (!st || typeof st !== 'object') throw new Error('Save is corrupt: state is missing');
  if (st.W !== W || st.H !== H) throw new Error('Save is corrupt: map size mismatch');
  requireObj(st, 'settings');
  requireObj(st, 'time');
  requireObj(st, 'weather');
  requireObj(st, 'rev');
  requireObj(st, 'tally');
  requireObj(st, 'trade');
  requireObj(st, 'unlocked');
  requireArr(st, 'citizens');
  requireArr(st, 'buildings');
  requireArr(st, 'animals');
  requireArr(st, 'messages');
  requireArr(st, 'history');
  if (typeof st.nextId !== 'number' || !Number.isFinite(st.nextId)) throw new Error('Save is corrupt: nextId is missing');
  if (typeof st.rngState !== 'number') throw new Error('Save is corrupt: rngState is missing');

  const t = env.tiles as Partial<EncodedTiles> | undefined;
  if (!t || typeof t !== 'object') throw new Error('Save is corrupt: tile data is missing');
  const N = W * H;
  const tiles: TileData = {
    height: decF32('height', t.height, (W + 1) * (H + 1), W + 1, H + 1),
    terrain: decU8('terrain', t.terrain, N),
    feature: decU8('feature', t.feature, N),
    featureAmount: decF32('featureAmount', t.featureAmount, N),
    variant: decU8('variant', t.variant, N),
    road: decU8('road', t.road, N),
    building: decI32('building', t.building, N),
    marked: decU8('marked', t.marked, N),
    region: new Int32Array(N),
  };
  validateTiles(tiles);

  const state = { ...(st as Omit<GameState, 'tiles'>), tiles, version: SAVE_VERSION } as GameState;
  // Older saves could be migrated here (none yet: SAVE_VERSION === 1).
  repairBuildingTiles(state);
  computeRegions(state);
  return state;
}

/** Defensive repair: tiles pointing at buildings that do not exist become free (never happens for consistent saves). */
function repairBuildingTiles(state: GameState): void {
  const ids = new Set<number>();
  for (const b of state.buildings) if (b && typeof b.id === 'number') ids.add(b.id);
  const tb = state.tiles.building;
  let last = -2;
  let lastOk = true;
  for (let i = 0; i < tb.length; i++) {
    const id = tb[i];
    if (id < 0) continue;
    if (id !== last) {
      last = id;
      lastOk = ids.has(id);
    }
    if (!lastOk) tb[i] = -1;
  }
}

function requireObj(st: Partial<GameState>, key: keyof GameState): void {
  const v = st[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Save is corrupt: state.${String(key)} is missing`);
}

function requireArr(st: Partial<GameState>, key: keyof GameState): void {
  if (!Array.isArray(st[key])) throw new Error(`Save is corrupt: state.${String(key)} is not a list`);
}

function validateTiles(tiles: TileData): void {
  const n = tiles.terrain.length;
  for (let i = 0; i < n; i++) {
    if (tiles.terrain[i] > Terrain.Mountain) throw new Error(`Save is corrupt: invalid terrain value at tile ${i}`);
    if (tiles.feature[i] > Feature.Iron) throw new Error(`Save is corrupt: invalid feature value at tile ${i}`);
    if (tiles.road[i] > Road.Bridge) throw new Error(`Save is corrupt: invalid road value at tile ${i}`);
  }
  for (let i = 0; i < tiles.height.length; i++) {
    if (!Number.isFinite(tiles.height[i])) throw new Error(`Save is corrupt: invalid terrain height at corner ${i}`);
  }
}
