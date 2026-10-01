/**
 * Farmers (crop fields, orchards) and herders (pastures). ARCHITECTURE §3.5 "Crop field / Orchard / Pasture".
 * OWNER: sim-core.
 */
import { BUILDINGS } from '../../../core/defs';
import type { Building, Citizen } from '../../../core/types';
import type { Game } from '../../game';
import { bufferUsed } from '../buildings';
import { claimTile, tileFree } from '../claims';
import { CROP_MIN_TEMP, PLANT_MONTHS, pastureWantsSlaughter } from '../farming';
import { isBlacklisted, mkTask, type Brain, type Task } from '../tasks';
import { goTile } from './common';
import { haulOwn } from './gather';

/** Nearest unclaimed field tile that needs `act`, as a world tile index, or -1. */
function nearestFieldTile(g: Game, c: Citizen, b: Building, brain: Brain, want: (stage: number) => boolean): number {
  const tiles = b.fieldTiles;
  if (!tiles) return -1;
  const W = g.state.W;
  const now = g.state.time.elapsed;
  let best = -1;
  let bestD = Infinity;
  for (let li = 0; li < tiles.length; li++) {
    if (!want(tiles[li].stage)) continue;
    const x = b.x + (li % b.w);
    const z = b.z + Math.floor(li / b.w);
    const i = z * W + x;
    if (!tileFree(g, i, c)) continue;
    // serpentine preference: rows in order, slight bias to keep farmers moving along rows
    const d = Math.abs(x + 0.5 - c.x) + Math.abs(z + 0.5 - c.z) * 1.15;
    if (d >= bestD) continue;
    if (isBlacklisted(brain, `t${i}`, now)) continue;
    best = i;
    bestD = d;
  }
  return best;
}

function fieldTask(g: Game, c: Citizen, b: Building, i: number, act: 'plant' | 'harvest'): Task | null {
  const label = act === 'plant' ? 'Planting crops' : b.type === 'orchard' ? 'Picking fruit' : 'Harvesting crops';
  const t = mkTask('work', label, [goTile(g, i, b.id), { op: 'field', b: b.id, i, act }], { job: true });
  if (!claimTile(g, t, c, i)) return null;
  return t;
}

export function planCropFarmer(g: Game, c: Citizen, b: Building, brain: Brain): Task | null {
  const s = g.state;
  const buf = bufferUsed(b);
  if (buf >= (BUILDINGS[b.type].bufferCapacity ?? 400) * 0.85) {
    const t = haulOwn(g, c, b, 0, true);
    if (t) return t;
  }
  // harvest first
  let i = nearestFieldTile(g, c, b, brain, (st) => st === 3);
  if (i >= 0) return fieldTask(g, c, b, i, 'harvest');
  if (b.type === 'cropField' && PLANT_MONTHS.includes(s.time.month) && s.weather.temperature >= CROP_MIN_TEMP - 4 && !b.paused) {
    i = nearestFieldTile(g, c, b, brain, (st) => st === 0 || st === 1 || st === 4);
    if (i >= 0) return fieldTask(g, c, b, i, 'plant');
  }
  if (buf >= 1) return haulOwn(g, c, b, 0, true);
  return null;
}

export function planHerder(g: Game, c: Citizen, b: Building): Task | null {
  if (bufferUsed(b) >= 20) {
    const t = haulOwn(g, c, b, 0, true);
    if (t) return t;
  }
  const l = b.livestock;
  if (!l) return bufferUsed(b) >= 1 ? haulOwn(g, c, b, 0, true) : null;
  const W = g.state.W;
  const x = b.x + Math.floor(g.rng.next() * b.w);
  const z = b.z + Math.floor(g.rng.next() * b.h);
  const i = z * W + x;
  if (pastureWantsSlaughter(b)) {
    return mkTask('work', `Slaughtering livestock`, [goTile(g, i, b.id), { op: 'herd', b: b.id, act: 'slaughter' }], { job: true });
  }
  if (l.product >= 1) {
    return mkTask('work', `Collecting ${l.type === 'sheep' ? 'wool' : l.type === 'chicken' ? 'eggs' : 'hides'}`, [
      goTile(g, i, b.id), { op: 'herd', b: b.id, act: 'collect' },
    ], { job: true });
  }
  if (bufferUsed(b) >= 5) {
    const t = haulOwn(g, c, b, 0, true);
    if (t) return t;
  }
  return mkTask('work', 'Tending livestock', [goTile(g, i, b.id), { op: 'herd', b: b.id, act: 'tend' }], { job: true });
}
