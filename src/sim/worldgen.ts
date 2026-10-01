/**
 * Procedural world generation. OWNER: sim-world agent.
 *
 * Pipeline (ARCHITECTURE.md §4), all deterministic from settings.seed (+ terrain style & map size):
 *  1. base land heights (fBm simplex)                                   world/relief.ts
 *  2. rivers (meandering, 3–6 wide, crossing the map) + tributary       world/hydrology.ts
 *  3. lakes / ponds (DeepWater cores, shallow rims)                      world/hydrology.ts
 *  4. mountains (ridged noise ranges + noisy border ring), cleanup      world/relief.ts
 *  5. start location on the masks (+ pond if no water nearby)            world/start.ts
 *  6. final corner heights (water depth, banks, mountain rise), start flattening, terrain classes (sand shores)
 *  7. forests (3 species, clustered), rocks & iron clusters             world/vegetation.ts
 *  8. clear start area, walkability regions, guarantee reachable forest/stone/iron/water near the start
 *  9. deer herds in forests                                             world/deer.ts
 *
 * Heights are quantised to 1/256 world units so saves can store them losslessly as small integers.
 * The passed `rng` is not consumed: generation uses its own RNG streams derived from settings.seed, so the same
 * settings always produce the same world regardless of how the caller seeded/used its RNG.
 */
import { MAP_SIZES } from '../core/constants';
import type { Rng } from '../core/rng';
import type { Animal, GameState, NewGameSettings, TileData } from '../core/types';
import { computeRegions } from './pathfinding';
import { createContext } from './world/context';
import { spawnDeerHerds } from './world/deer';
import { carveRivers, cleanupWater, placeLakes } from './world/hydrology';
import { classifyTerrain, cleanupMountains, computeHeights, flattenStartArea, generateBaseLand, generateMountains } from './world/relief';
import { chooseStart, clearStartArea, guaranteeStartResources } from './world/start';
import { placeRocksAndIron, plantForests } from './world/vegetation';

export interface WorldGenResult {
  W: number;
  H: number;
  tiles: TileData;
  /** A good starting location (flat grass, near forest & water, room for ~20x20 of buildings). World tile coords. */
  startX: number;
  startZ: number;
  /** Initial wild deer herds (ids allocated with allocId). */
  animals: Animal[];
}

/** Generate terrain, water, mountains, forests, rocks, iron and deer herds. Must be deterministic for (settings.seed). */
export function generateWorld(settings: NewGameSettings, rng: Rng, allocId: () => number): WorldGenResult {
  void rng;
  const size = MAP_SIZES[settings.mapSize] ?? MAP_SIZES.medium;
  const ctx = createContext(settings, size, size);

  generateBaseLand(ctx);
  carveRivers(ctx);
  placeLakes(ctx);
  cleanupWater(ctx, 2);
  generateMountains(ctx);
  cleanupMountains(ctx);
  chooseStart(ctx);

  computeHeights(ctx);
  flattenStartArea(ctx);
  classifyTerrain(ctx);

  plantForests(ctx);
  placeRocksAndIron(ctx);
  clearStartArea(ctx);

  // Regions are needed to make sure the start's resources are reachable without bridges.
  const regionState = { W: ctx.W, H: ctx.H, tiles: ctx.tiles, rev: { terrain: 0, features: 0, roads: 0, buildings: 0, fields: 0 } };
  computeRegions(regionState as unknown as GameState);
  guaranteeStartResources(ctx);

  const animals = spawnDeerHerds(ctx, allocId);
  return { W: ctx.W, H: ctx.H, tiles: ctx.tiles, startX: ctx.startX, startZ: ctx.startZ, animals };
}
