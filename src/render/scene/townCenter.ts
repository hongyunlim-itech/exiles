/**
 * Where the camera should focus for a game: the town (average of building centres), else the first citizen,
 * else the map centre. Pure — OWNER: render-scene.
 */
import type { GameState } from '../../core/types';

export function townCenter(state: Pick<GameState, 'W' | 'H' | 'buildings' | 'citizens'>): { x: number; z: number } {
  const bs = state.buildings;
  if (bs.length > 0) {
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const b of bs) {
      if (b.state === 'ruin') continue;
      sx += b.x + b.w / 2;
      sz += b.z + b.h / 2;
      n++;
    }
    if (n > 0) return { x: sx / n, z: sz / n };
  }
  const c = state.citizens[0];
  if (c) return { x: c.x, z: c.z };
  return { x: state.W / 2, z: state.H / 2 };
}

/**
 * Camera focus for a live game: the simulation's own town centre (centre of the storage buildings, which ignores
 * far-flung docks, fields and mines), falling back to the pure estimate above.
 */
export function gameTownCenter(game: { state: Pick<GameState, 'W' | 'H' | 'buildings' | 'citizens'>; townCenter?: () => { x: number; z: number } }): { x: number; z: number } {
  try {
    const c = game.townCenter?.();
    if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) return c;
  } catch {
    /* fall through */
  }
  return townCenter(game.state);
}
