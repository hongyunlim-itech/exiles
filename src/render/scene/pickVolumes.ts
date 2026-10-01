/**
 * Approximate pick volumes for buildings so clicking a roof selects the building even when the ray would hit the
 * ground behind it. Heights roughly follow the model scale in ARCHITECTURE §5. Pure. OWNER: render-scene.
 */
import type { Building, BuildingType } from '../../core/types';
import { rayBox } from './heightfield';

/** Approximate model height per building type (world units). Zones (walkable) use terrain picking only. */
export const PICK_HEIGHT: Record<BuildingType, number> = {
  woodenHouse: 2.1, stoneHouse: 2.2, boardingHouse: 2.6,
  stockpile: 0, storageBarn: 2.8,
  gathererHut: 1.9, hunterCabin: 1.9, fishingDock: 1.5, cropField: 0, orchard: 0, pasture: 0,
  foresterLodge: 2.0, woodcutter: 2.0, quarry: 0.6, mine: 2.4, blacksmith: 2.5, tailor: 2.1, herbalist: 1.9, brewery: 2.5,
  well: 1.5, school: 2.7, hospital: 2.8, chapel: 5, tavern: 2.7, market: 2.0, tradingPost: 2.8, townHall: 3.6, cemetery: 0,
};

/**
 * Nearest building whose pick box the ray enters before `maxT`. `groundOf` returns the ground height for a building.
 * Returns { id, t } or null.
 */
export function pickBuildingBox(
  buildings: readonly Building[], groundOf: (b: Building) => number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number,
): { id: number; t: number } | null {
  let best: { id: number; t: number } | null = null;
  let bestT = maxT;
  for (const b of buildings) {
    let hgt = PICK_HEIGHT[b.type] ?? 0;
    if (hgt <= 0) continue;
    if (b.state === 'clearing') hgt = 0.35;
    else if (b.state === 'ruin') hgt = Math.min(hgt, 0.8);
    else if (b.state === 'construction') hgt *= Math.max(0.3, b.progress);
    const g = groundOf(b);
    // inset slightly so clicks on neighbouring tiles still hit the ground
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x + 0.15, g - 0.3, b.z + 0.15, b.x + b.w - 0.15, g + hgt, b.z + b.h - 0.15);
    if (t >= 0 && t < bestT) {
      bestT = t;
      best = { id: b.id, t };
    }
  }
  return best;
}
