/**
 * Shared scratch state for one world-generation run. OWNER: sim-world agent.
 */
import { Rng } from '../../core/rng';
import type { NewGameSettings, TerrainStyle, TileData } from '../../core/types';
import { Noise2D, mixSeed } from './noise';

/** Water mask values (per tile). */
export const WATER_NONE = 0;
export const WATER_RIVER = 1;
export const WATER_LAKE = 2;
export const WATER_POND = 3;

/** Corner classification used while shaping heights. */
export const CORNER_LAND = 0;
export const CORNER_SHORE = 1;
export const CORNER_WATER = 2;
export const CORNER_MOUNTAIN = 3;

/** Maximum water depth per water kind (world units below WATER_LEVEL). DeepWater = tile average below -1. */
export const DEPTH_CAP_RIVER = 0.72;
export const DEPTH_CAP_LAKE = 2.6;
export const DEPTH_CAP_POND = 0.95;
/** Tiles whose average corner height is below this are DeepWater (not bridgeable). */
export const DEEP_WATER_HEIGHT = -1.0;
/** Height of shoreline corners (just above the water surface). */
export const SHORE_HEIGHT = 0.05;
/** Heights are quantised to this grid so saves can store them losslessly as integers. */
export const HEIGHT_QUANT = 256;

/** Half size of the guaranteed clear, flat start area (24×24). */
export const START_HALF = 12;

export interface StyleParams {
  /** Amplitude of the rolling land (world units above the base). */
  landAmp: number;
  /** Wavelength (tiles) of the main land undulation. */
  landScale: number;
  /** Target fraction of interior tiles covered by mountains. */
  mountainCoverage: number;
  /** Wavelength (tiles) of mountain ranges. */
  mountainScale: number;
  /** Multiplier on mountain rise (how tall ranges get). */
  mountainHeight: number;
  /** Mean thickness (tiles) of the mountain ring along the map border, and its noise variation. */
  edgeThickness: number;
  edgeVariation: number;
  /** Number of map-crossing rivers (fractional part = probability of one more). */
  rivers: number;
  tributaryChance: number;
  /** River width range in tiles (diameter). */
  riverWidth: [number, number];
  /** Lake count range for a medium map (scaled by map area). */
  lakeCount: [number, number];
  /** Lake radius range (tiles) for a medium map (scaled by sqrt of map size). */
  lakeRadius: [number, number];
  /** Fraction of grass tiles covered by forest. */
  forestCoverage: number;
  /** Rock / iron clusters per 10 000 tiles. */
  rockClusters: number;
  ironClusters: number;
  /** Width (tiles) over which land slopes down to water. */
  bankWidth: number;
  /** Extra sand along shores (0..1). */
  sandiness: number;
}

export const STYLE_PARAMS: Record<TerrainStyle, StyleParams> = {
  valleys: {
    landAmp: 1.9, landScale: 62, mountainCoverage: 0.075, mountainScale: 58, mountainHeight: 1, edgeThickness: 7, edgeVariation: 6,
    rivers: 1, tributaryChance: 0.55, riverWidth: [3.4, 5.8], lakeCount: [1, 2], lakeRadius: [5, 8.5],
    forestCoverage: 0.4, rockClusters: 9, ironClusters: 5, bankWidth: 11, sandiness: 0.35,
  },
  mountains: {
    landAmp: 2.2, landScale: 50, mountainCoverage: 0.22, mountainScale: 46, mountainHeight: 1.25, edgeThickness: 9, edgeVariation: 7,
    rivers: 1, tributaryChance: 0.35, riverWidth: [3.2, 5.2], lakeCount: [1, 2], lakeRadius: [5, 8],
    forestCoverage: 0.46, rockClusters: 12, ironClusters: 7, bankWidth: 9, sandiness: 0.25,
  },
  lakes: {
    landAmp: 1.4, landScale: 70, mountainCoverage: 0.035, mountainScale: 60, mountainHeight: 0.9, edgeThickness: 4, edgeVariation: 6,
    rivers: 0.6, tributaryChance: 0, riverWidth: [3.2, 4.8], lakeCount: [4, 6], lakeRadius: [7, 14],
    forestCoverage: 0.38, rockClusters: 9, ironClusters: 5, bankWidth: 12, sandiness: 0.55,
  },
};

export interface GenNoise {
  base: Noise2D;
  detail: Noise2D;
  mountain: Noise2D;
  mountain2: Noise2D;
  rock: Noise2D;
  river: Noise2D;
  lake: Noise2D;
  forest: Noise2D;
  forest2: Noise2D;
  species: Noise2D;
  species2: Noise2D;
  sand: Noise2D;
  edge: Noise2D;
}

export interface GenContext {
  settings: NewGameSettings;
  params: StyleParams;
  W: number;
  H: number;
  N: number;
  /** Corner grid width/height (W+1, H+1). */
  CW: number;
  CH: number;
  rng: Rng;
  noise: GenNoise;
  /** Base (pre-water, pre-mountain) land height per corner. */
  land: Float32Array;
  /** 1 = mountain tile. */
  mountain: Uint8Array;
  /** WATER_* per tile. */
  water: Uint8Array;
  /** Max depth per water tile. */
  waterCap: Float32Array;
  /** 1 = mountains forbidden (river corridors, lake shores, start area). */
  noMountain: Uint8Array;
  /** CORNER_* per corner (valid after heights are computed). */
  cornerType: Uint8Array;
  /** Per corner: distance (tiles) to the nearest water/shore corner (valid after heights are computed). */
  cornerWaterDist: Float32Array;
  tiles: TileData;
  startX: number;
  startZ: number;
}

export function createContext(settings: NewGameSettings, W: number, H: number): GenContext {
  const N = W * H;
  const CW = W + 1;
  const CH = H + 1;
  const style = STYLE_PARAMS[settings.terrain] ? settings.terrain : 'valleys';
  const seed = (settings.seed >>> 0) || 1;
  const styleSalt = style === 'valleys' ? 11 : style === 'mountains' ? 23 : 37;
  const mk = (salt: number) => new Noise2D(new Rng(mixSeed(seed, salt * 1000 + styleSalt)));
  return {
    settings,
    params: STYLE_PARAMS[style],
    W,
    H,
    N,
    CW,
    CH,
    rng: new Rng(mixSeed(seed, 7777 + styleSalt + W)),
    noise: {
      base: mk(1),
      detail: mk(2),
      mountain: mk(3),
      mountain2: mk(4),
      rock: mk(5),
      river: mk(6),
      lake: mk(7),
      forest: mk(8),
      forest2: mk(9),
      species: mk(10),
      species2: mk(11),
      sand: mk(12),
      edge: mk(13),
    },
    land: new Float32Array(CW * CH),
    mountain: new Uint8Array(N),
    water: new Uint8Array(N),
    waterCap: new Float32Array(N),
    noMountain: new Uint8Array(N),
    cornerType: new Uint8Array(CW * CH),
    cornerWaterDist: new Float32Array(CW * CH),
    tiles: {
      height: new Float32Array(CW * CH),
      terrain: new Uint8Array(N),
      feature: new Uint8Array(N),
      featureAmount: new Float32Array(N),
      variant: new Uint8Array(N),
      road: new Uint8Array(N),
      building: new Int32Array(N).fill(-1),
      marked: new Uint8Array(N),
      region: new Int32Array(N),
    },
    startX: W >> 1,
    startZ: H >> 1,
  };
}

/** Value at the given fraction of a sorted copy of `values` (0 = min, 1 = max). */
export function quantile(values: Float32Array, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const k = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[k];
}

export function quantize(h: number): number {
  return Math.round(h * HEIGHT_QUANT) / HEIGHT_QUANT;
}
