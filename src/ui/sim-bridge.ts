/**
 * Safe access to sim-ext helper functions used by the UI. Wrapping them means a missing/failing helper degrades a
 * tooltip instead of breaking the whole HUD, and dev sandboxes can swap in mock providers.
 */
import { RESOURCES } from '../core/defs';
import type { Citizen, Inventory, ResourceType } from '../core/types';
import type { Game } from '../sim/game';
import { inventoryValue } from '../sim/trade';
import type { Factor } from '../sim/wellbeing';
import { happinessFactors, healthFactors } from '../sim/wellbeing';

export type { Factor };

export interface SimBridge {
  happinessFactors(game: Game, c: Citizen): Factor[] | null;
  healthFactors(game: Game, c: Citizen): Factor[] | null;
  inventoryValue(inv: Inventory): number;
}

/** Trade value computed from resource definitions (fallback). */
export function localInventoryValue(inv: Inventory): number {
  let v = 0;
  for (const k in inv) {
    const n = inv[k as ResourceType] ?? 0;
    const def = RESOURCES[k as ResourceType];
    if (def && n > 0) v += def.value * n;
  }
  return v;
}

export const simBridge: SimBridge = {
  happinessFactors(game, c) {
    try {
      return happinessFactors(game, c);
    } catch {
      return null;
    }
  },
  healthFactors(game, c) {
    try {
      return healthFactors(game, c);
    } catch {
      return null;
    }
  },
  inventoryValue(inv) {
    try {
      const v = inventoryValue(inv);
      return Number.isFinite(v) ? v : localInventoryValue(inv);
    } catch {
      return localInventoryValue(inv);
    }
  },
};

/** Dev sandboxes may override providers with mocks. */
export function overrideSimBridge(patch: Partial<SimBridge>): void {
  Object.assign(simBridge, patch);
}
