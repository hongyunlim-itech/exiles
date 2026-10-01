/**
 * Ground height lookups for entities (terrain via heightAt, bridge decks over water).
 */
import { WATER_LEVEL } from '../../core/constants';
import type { GameState } from '../../core/types';
import { Road } from '../../core/types';
import { heightAt } from '../../core/world';

/** Deck height of bridges (see ARCHITECTURE §2). */
export const BRIDGE_DECK_Y = WATER_LEVEL + 0.25;

/** Height an entity standing at (x, z) should be drawn at: terrain, or the bridge deck on bridge tiles. */
export function entityGroundY(s: GameState, x: number, z: number): number {
  const h = heightAt(s, x, z);
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  if (tx >= 0 && tz >= 0 && tx < s.W && tz < s.H) {
    if (s.tiles.road[tz * s.W + tx] === Road.Bridge) return h > BRIDGE_DECK_Y ? h : BRIDGE_DECK_Y;
  }
  return h;
}

/**
 * Terrain plane of a tile as a shear: y = base + sx * (x - cx) + sz * (z - cz) around the tile centre.
 * Writes [base, sx, sz] into `out`. Used to lay crops/furrows on sloped tiles while keeping stalks vertical.
 */
export function tilePlane(s: GameState, tx: number, tz: number, out: Float32Array | number[]): void {
  const W1 = s.W + 1;
  const hs = s.tiles.height;
  const cx0 = Math.max(0, Math.min(s.W, tx));
  const cz0 = Math.max(0, Math.min(s.H, tz));
  const cx1 = Math.min(s.W, cx0 + 1);
  const cz1 = Math.min(s.H, cz0 + 1);
  const h00 = hs[cz0 * W1 + cx0];
  const h10 = hs[cz0 * W1 + cx1];
  const h01 = hs[cz1 * W1 + cx0];
  const h11 = hs[cz1 * W1 + cx1];
  out[0] = (h00 + h10 + h01 + h11) * 0.25;
  out[1] = (h10 + h11 - h00 - h01) * 0.5;
  out[2] = (h01 + h11 - h00 - h10) * 0.5;
}
