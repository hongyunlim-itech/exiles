/**
 * Tornadoes: a funnel enters at a map edge, wanders across the land toward the town and destroys the buildings,
 * trees and animals it touches. Citizens caught in it may die. State lives in GameState.tornado.
 */
import { MONTH_SECONDS } from '../../core/constants';
import { Feature } from '../../core/types';
import { forTilesInRadius, isWalkableBuildingType } from '../../core/world';
import type { Game } from '../game';
import { removeAnimal } from '../nature';
import { rt } from './runtime';
import { TORNADO_CHANCE_PER_SUMMER, TORNADO_DEATH_CHANCE, TORNADO_RADIUS, TORNADO_SPEED } from './tuning';
import { buildingName } from './util';
import * as dm from '../core/dmath';

/** Spawn a tornado at a random map edge heading across the map. No-op if one is already active. */
export function spawnTornadoNow(game: Game): boolean {
  const s = game.state;
  if (s.tornado || s.W <= 4 || s.H <= 4) return false;
  const rng = game.rng;
  const W = s.W;
  const H = s.H;

  // Aim near the town (average of building centers) so it's a real threat, with plenty of jitter.
  let tx = W / 2;
  let tz = H / 2;
  if (s.buildings.length > 0) {
    let sx = 0;
    let sz = 0;
    for (const b of s.buildings) {
      sx += b.x + b.w / 2;
      sz += b.z + b.h / 2;
    }
    tx = sx / s.buildings.length;
    tz = sz / s.buildings.length;
  }
  const jitter = Math.min(W, H) * 0.18;
  tx = Math.min(W - 2, Math.max(2, tx + rng.range(-jitter, jitter)));
  tz = Math.min(H - 2, Math.max(2, tz + rng.range(-jitter, jitter)));

  let x: number;
  let z: number;
  switch (rng.int(0, 3)) {
    case 0: x = 0.5; z = rng.range(H * 0.1, H * 0.9); break;
    case 1: x = W - 0.5; z = rng.range(H * 0.1, H * 0.9); break;
    case 2: x = rng.range(W * 0.1, W * 0.9); z = 0.5; break;
    default: x = rng.range(W * 0.1, W * 0.9); z = H - 0.5; break;
  }
  let dx = tx - x;
  let dz = tz - z;
  const len = dm.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const life = dm.hypot(W, H) / TORNADO_SPEED + 10;
  s.tornado = { x, z, dirX: dx, dirZ: dz, life };

  const r = rt(game);
  r.tornadoRolled.clear();
  r.tornadoDestroyed = 0;
  r.tornadoKilled = 0;
  r.tornadoTrees = 0;
  r.tornadoTurn = 0;

  const tile = Math.floor(Math.min(H - 1, z)) * W + Math.floor(Math.min(W - 1, x));
  game.addMessage('A tornado is tearing across the land! Pray it passes the town by.', 'danger', { kind: 'tile', id: tile });
  game.events.emit('sound', { cue: 'bell', x, z });
  return true;
}

/** Roll for a random tornado (summer only). Call ~1 Hz. */
export function rollTornado(game: Game, tickDt: number): void {
  const s = game.state;
  if (s.tornado) return;
  const m = s.time.month;
  if (m < 3 || m > 5) return;
  const p = (TORNADO_CHANCE_PER_SUMMER * tickDt) / (3 * MONTH_SECONDS);
  if (game.rng.next() < p) spawnTornadoNow(game);
}

/** Move the active tornado and apply destruction. */
export function updateTornado(game: Game, dt: number): void {
  const s = game.state;
  const t = s.tornado;
  if (!t) return;
  const r = rt(game);
  const rng = game.rng;

  // Wander: the turn rate itself drifts slowly, so the path curves smoothly instead of jittering.
  r.tornadoTurn = Math.max(-0.12, Math.min(0.12, r.tornadoTurn + (rng.next() - 0.5) * 0.25 * dt));
  const turn = r.tornadoTurn * dt;
  const cos = dm.cos(turn);
  const sin = dm.sin(turn);
  let dx = t.dirX * cos - t.dirZ * sin;
  let dz = t.dirX * sin + t.dirZ * cos;
  const len = dm.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  t.dirX = dx;
  t.dirZ = dz;
  const speed = TORNADO_SPEED * (0.8 + 0.4 * rng.next());
  t.x += dx * speed * dt;
  t.z += dz * speed * dt;
  t.life -= dt;

  const out = t.x < -2 || t.z < -2 || t.x > s.W + 2 || t.z > s.H + 2;
  if (t.life <= 0 || out) {
    finish(game);
    return;
  }
  if (t.x < 0 || t.z < 0 || t.x >= s.W || t.z >= s.H) return;

  // Trees and buildings under the funnel.
  let treesHit = 0;
  const hitBuildings = new Set<number>();
  const tiles = s.tiles;
  forTilesInRadius(s, t.x, t.z, TORNADO_RADIUS, (i) => {
    if (tiles.feature[i] === Feature.Tree) {
      tiles.feature[i] = Feature.None;
      tiles.featureAmount[i] = 0;
      tiles.marked[i] = 0;
      treesHit++;
    }
    const bid = tiles.building[i];
    if (bid >= 0) hitBuildings.add(bid);
  });
  if (treesHit > 0) {
    r.tornadoTrees += treesHit;
    game.bumpFeatures();
  }
  for (const id of hitBuildings) {
    const b = game.getBuilding(id);
    if (!b || b.state === 'ruin' || isWalkableBuildingType(b.type)) continue;
    const name = buildingName(b);
    game.removeBuilding(id, 'tornado');
    r.tornadoDestroyed++;
    if (r.tornadoDestroyed <= 3) {
      const tile = Math.floor(t.z) * s.W + Math.floor(t.x);
      game.addMessage(`The tornado has destroyed the ${name}.`, 'danger', { kind: 'tile', id: tile });
    }
  }

  // Citizens caught in the funnel (each rolls once per tornado).
  const reach2 = (TORNADO_RADIUS + 0.3) * (TORNADO_RADIUS + 0.3);
  let victims: number[] | null = null;
  for (const c of s.citizens) {
    const ddx = c.x - t.x;
    const ddz = c.z - t.z;
    if (ddx * ddx + ddz * ddz > reach2 || r.tornadoRolled.has(c.id)) continue;
    r.tornadoRolled.add(c.id);
    if (rng.next() < TORNADO_DEATH_CHANCE) (victims ??= []).push(c.id);
  }
  if (victims) {
    for (const id of victims) {
      if (game.getCitizen(id)) {
        game.killCitizen(id, 'tornado');
        r.tornadoKilled++;
      }
    }
  }

  // Deer caught in the funnel.
  let deer: number[] | null = null;
  for (const a of s.animals) {
    const ddx = a.x - t.x;
    const ddz = a.z - t.z;
    if (ddx * ddx + ddz * ddz <= reach2) (deer ??= []).push(a.id);
  }
  if (deer) {
    for (const id of deer) {
      try {
        removeAnimal(game, id);
      } catch {
        /* nature module unavailable — leave the deer be */
      }
    }
  }
}

function finish(game: Game): void {
  const s = game.state;
  const r = rt(game);
  s.tornado = null;
  const parts: string[] = [];
  if (r.tornadoDestroyed > 0) parts.push(`${r.tornadoDestroyed} building${r.tornadoDestroyed === 1 ? '' : 's'} destroyed`);
  if (r.tornadoKilled > 0) parts.push(`${r.tornadoKilled} ${r.tornadoKilled === 1 ? 'life' : 'lives'} lost`);
  if (parts.length > 0) game.addMessage(`The tornado has passed: ${parts.join(', ')}.`, 'warning');
  else game.addMessage('The tornado has passed without touching the town.', 'info');
  r.tornadoRolled.clear();
  r.tornadoDestroyed = 0;
  r.tornadoKilled = 0;
  r.tornadoTrees = 0;
}
