/**
 * Small shared helpers for the sim-ext modules.
 */
import { BUILDINGS, RESOURCES, seasonOfMonth } from '../../core/defs';
import type { Building, GameState, Inventory, ResourceType, Season } from '../../core/types';
import { isWalkable } from '../../core/world';
import type { Game } from '../game';
import * as dm from '../core/dmath';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function seasonNow(s: GameState): Season {
  return seasonOfMonth(s.time.month);
}

/** Whether the month is one of the winter months (9..11). */
export function isWinterMonth(month: number): boolean {
  return month >= 9;
}

/** Unreserved amount of a resource in a building's inventory. */
export function availableIn(b: Building, type: ResourceType): number {
  const have = b.inventory[type] ?? 0;
  const reserved = b.reservedOut?.[type] ?? 0;
  return Math.max(0, have - reserved);
}

/** Remove up to `amount` unreserved units from a building's inventory. Returns the amount removed. */
export function consumeFrom(b: Building, type: ResourceType, amount: number): number {
  const take = Math.min(amount, availableIn(b, type));
  if (take <= 0) return 0;
  const left = (b.inventory[type] ?? 0) - take;
  if (left <= 1e-6) delete b.inventory[type];
  else b.inventory[type] = left;
  return take;
}

/** Gap (in tiles) between two building footprints; 0 when touching or overlapping. */
export function footprintGap(a: Pick<Building, 'x' | 'z' | 'w' | 'h'>, b: Pick<Building, 'x' | 'z' | 'w' | 'h'>): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dz = Math.max(0, Math.max(a.z, b.z) - Math.min(a.z + a.h, b.z + b.h));
  return dm.hypot(dx, dz);
}

/** Whether a world point lies inside a building footprint (optionally grown by `margin` tiles). */
export function pointInFootprint(b: Pick<Building, 'x' | 'z' | 'w' | 'h'>, px: number, pz: number, margin = 0): boolean {
  return px >= b.x - margin && px <= b.x + b.w + margin && pz >= b.z - margin && pz <= b.z + b.h + margin;
}

export function buildingName(b: Building): string {
  return BUILDINGS[b.type]?.name ?? b.type;
}

export function resourceName(r: ResourceType): string {
  return RESOURCES[r]?.name ?? r;
}

/** "12 Logs, 3 Tools" — compact inventory description for messages. */
export function describeInventory(inv: Inventory, max = 4): string {
  const parts: string[] = [];
  for (const k of Object.keys(inv) as ResourceType[]) {
    const n = inv[k] ?? 0;
    if (n > 0) parts.push(`${Math.round(n)} ${resourceName(k)}`);
  }
  if (parts.length > max) return `${parts.slice(0, max).join(', ')} and more`;
  return parts.join(', ');
}

/** Walkability using the game's building lookup (zones walkable, other buildings blocked). */
export function walkableTile(game: Game, i: number): boolean {
  return isWalkable(game.state, i, (id) => game.getBuilding(id)?.type);
}

/** Integer-safe amount (trade quantities etc.). */
export function wholeUnits(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return NaN;
  return Math.floor(n + 1e-9);
}
