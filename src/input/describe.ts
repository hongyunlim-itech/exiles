/**
 * Concise hover descriptions for tiles and buildings (pure; no three.js / DOM). Used for the `hoverInfo` app event.
 */
import { BUILDINGS, CROPS, LIVESTOCK, ORCHARDS } from '../core/defs';
import type { Building, GameState } from '../core/types';
import { Feature, Road, Terrain } from '../core/types';

const TERRAIN_NAMES: Record<number, string> = {
  [Terrain.Grass]: 'Grassland',
  [Terrain.Sand]: 'Sand',
  [Terrain.Water]: 'Shallow water',
  [Terrain.DeepWater]: 'Deep water',
  [Terrain.Mountain]: 'Mountain',
};

const ROAD_NAMES: Record<number, string> = {
  [Road.Dirt]: 'Dirt road',
  [Road.Stone]: 'Stone road',
  [Road.Bridge]: 'Bridge',
};

const TREE_SPECIES = ['Pine', 'Oak', 'Birch'];

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

/** Short status line for a building, e.g. "Under construction 45%" or "3/5 residents". */
export function buildingStatus(b: Building): string {
  const def = BUILDINGS[b.type];
  const parts: string[] = [];
  if (b.fire > 0) parts.push('on fire!');
  switch (b.state) {
    case 'clearing':
      parts.push('waiting for the site to be cleared');
      break;
    case 'construction': {
      let delivered = 0;
      let needed = 0;
      for (const k in b.cost) {
        const key = k as keyof typeof b.cost;
        needed += b.cost[key] ?? 0;
        delivered += Math.min(b.cost[key] ?? 0, b.delivered[key] ?? 0);
      }
      parts.push(`under construction ${pct(b.progress)}`);
      if (needed > 0 && delivered < needed) parts.push(`materials ${delivered}/${needed}`);
      break;
    }
    case 'demolishing':
      parts.push(`being demolished ${pct(b.progress)}`);
      break;
    case 'ruin':
      parts.push('burnt ruins');
      break;
    case 'active': {
      if (def.housing) parts.push(`${b.residentIds.length}/${def.housing} residents`);
      if (def.maxWorkers > 0) parts.push(`${b.workerIds.length}/${b.workersDesired} workers`);
      if (b.type === 'cropField' && b.crop) parts.push(CROPS[b.crop].name);
      if (b.type === 'orchard' && b.orchard) parts.push(`${ORCHARDS[b.orchard.type].name} trees ${pct(b.orchard.maturity)} grown`);
      if (b.type === 'pasture') {
        parts.push(b.livestock ? `${b.livestock.count} ${LIVESTOCK[b.livestock.type].name.toLowerCase()}` : 'no livestock');
      }
      if (def.storage) {
        let used = 0;
        for (const k in b.inventory) used += b.inventory[k as keyof typeof b.inventory] ?? 0;
        const cap = def.storage.capacity * (def.storage.perTile ? b.w * b.h : 1);
        parts.push(`${Math.round(used)}/${cap} stored`);
      }
      if (b.type === 'cemetery' && def.gravesPerTile) {
        const cap = Math.floor(b.w * b.h * def.gravesPerTile);
        parts.push(`${b.graves ?? 0}/${cap} graves`);
      }
      break;
    }
  }
  if (b.paused) parts.push('paused');
  return parts.join(', ');
}

/** "🏠 Wooden House — 3/5 residents" */
export function describeBuilding(b: Building): string {
  const def = BUILDINGS[b.type];
  const status = buildingStatus(b);
  return status ? `${def.icon} ${def.name} — ${status}` : `${def.icon} ${def.name}`;
}

/**
 * Tile description: building (if any) or terrain, road and feature details.
 * `getBuilding` resolves building ids (Game.getBuilding).
 */
export function describeTile(
  state: GameState,
  getBuilding: (id: number) => Building | undefined,
  x: number,
  z: number,
): string | null {
  if (x < 0 || z < 0 || x >= state.W || z >= state.H) return null;
  const i = z * state.W + x;
  const t = state.tiles;
  const bid = t.building[i];
  if (bid >= 0) {
    const b = getBuilding(bid);
    if (b) return describeBuilding(b);
  }
  const parts: string[] = [];
  const road = t.road[i];
  parts.push(road !== Road.None ? ROAD_NAMES[road] ?? 'Road' : TERRAIN_NAMES[t.terrain[i]] ?? 'Unknown');
  const f = t.feature[i];
  const amount = t.featureAmount[i];
  if (f === Feature.Tree) {
    const species = TREE_SPECIES[t.variant[i] % 3] ?? 'Tree';
    parts.push(amount < 1 ? `${species} sapling (${pct(amount)} grown)` : `${species} tree`);
  } else if (f === Feature.Rock) {
    parts.push(`Stone deposit (${Math.ceil(amount)} left)`);
  } else if (f === Feature.Iron) {
    parts.push(`Iron deposit (${Math.ceil(amount)} left)`);
  }
  if (f !== Feature.None && t.marked[i]) parts.push('marked for removal');
  return parts.join(' · ');
}
