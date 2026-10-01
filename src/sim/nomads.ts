/**
 * Nomads arriving at the Town Hall asking to join. OWNER: sim-ext agent.
 *
 * With an active Town Hall, every ~1–2 years a group of 3–12 nomads may arrive (state.nomads) and wait a month
 * for an answer. Accepting spawns them as homeless adults near the Town Hall; some may carry disease (only when
 * disasters are enabled), which also raises the chance of an outbreak.
 */
import { ADULT_AGE } from '../core/constants';
import type { Building, Citizen, Gender } from '../core/types';
import { inBounds } from '../core/world';
import { infectCitizen } from './ext/disease';
import { addOutbreakRisk } from './ext/outbreak';
import {
  NOMAD_FIRST_DELAY, NOMAD_INTERVAL_MAX, NOMAD_INTERVAL_MIN, NOMAD_MAX, NOMAD_MIN, NOMAD_WAIT, OUTBREAK_RISK_NOMADS,
} from './ext/tuning';
import { walkableTile } from './ext/util';
import type { Game } from './game';

export function updateNomads(game: Game, dt: number): void {
  if (!(dt > 0)) return;
  const s = game.state;

  if (s.nomads) {
    s.nomads.expiresIn -= dt;
    if (s.nomads.expiresIn <= 0) {
      s.nomads = null;
      s.nextNomads = game.rng.range(NOMAD_INTERVAL_MIN, NOMAD_INTERVAL_MAX);
      game.addMessage('The nomads grew tired of waiting and moved on.', 'info');
    }
    return;
  }

  const hall = findTownHall(game);
  if (!hall || s.gameOver || s.citizens.length === 0) {
    // the first group comes NOMAD_FIRST_DELAY after a Town Hall opens (not after whatever the initial timer was)
    s.nextNomads = NOMAD_FIRST_DELAY;
    return;
  }
  s.nextNomads -= dt;
  if (s.nextNomads > 0) return;
  nomadsArrive(game, hall);
}

export function respondToNomads(game: Game, accept: boolean): void {
  const s = game.state;
  const group = s.nomads;
  if (!group) return;
  s.nomads = null;
  s.nextNomads = game.rng.range(NOMAD_INTERVAL_MIN, NOMAD_INTERVAL_MAX);

  if (!accept) {
    game.addMessage('The nomads were turned away and wandered off down the road.', 'info');
    return;
  }

  const hall = findTownHall(game) ?? anyBuilding(game);
  const spots = spawnSpots(game, hall, group.count);
  const ids: number[] = [];
  const sickOnes: Citizen[] = [];
  const carriers = s.settings.disasters && game.rng.next() < group.diseaseRisk;
  for (let k = 0; k < group.count; k++) {
    const [x, z] = spots[k % spots.length];
    const gender: Gender = k % 2 === 0 ? 'M' : 'F';
    const age = ADULT_AGE + 6 + game.rng.range(0, 30);
    let c: Citizen;
    try {
      c = game.spawnCitizen({ x, z, age, gender });
    } catch (err) {
      console.error('[nomads] spawnCitizen failed', err);
      break;
    }
    ids.push(c.id);
    if (carriers && game.rng.next() < 0.5) sickOnes.push(c);
  }
  if (ids.length === 0) return;

  for (const c of sickOnes) infectCitizen(game, c, 0.3 + game.rng.next() * 0.3, { force: true });
  if (carriers) addOutbreakRisk(game, OUTBREAK_RISK_NOMADS);

  game.events.emit('citizenArrived', { ids });
  const target = hall ? { kind: 'building' as const, id: hall.id } : { kind: 'citizen' as const, id: ids[0] };
  game.addMessage(`${ids.length} nomads have joined ${s.settings.townName}. They will need homes and work.`, 'good', target);
  if (sickOnes.length > 0) {
    game.addMessage(
      `Some of the newcomers are ill. Keep herbs in homes and build a Hospital before the sickness spreads.`,
      'warning',
      { kind: 'citizen', id: sickOnes[0].id },
    );
  }
}

/** Force a nomad group to arrive now (debug). Returns false if no Town Hall or a group is already waiting. */
export function summonNomads(game: Game, count?: number): boolean {
  if (game.state.nomads) return false;
  const hall = findTownHall(game);
  if (!hall) return false;
  nomadsArrive(game, hall, count);
  return true;
}

// ---------------------------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------------------------

function findTownHall(game: Game): Building | null {
  for (const b of game.state.buildings) if (b.type === 'townHall' && b.state === 'active') return b;
  return null;
}

function anyBuilding(game: Game): Building | null {
  return game.state.buildings.find((b) => b.state === 'active') ?? game.state.buildings[0] ?? null;
}

function nomadsArrive(game: Game, hall: Building, count?: number): void {
  const s = game.state;
  const rng = game.rng;
  const n = count ?? rng.int(NOMAD_MIN, NOMAD_MAX);
  s.nomads = {
    count: Math.max(1, Math.round(n)),
    expiresIn: NOMAD_WAIT,
    diseaseRisk: s.settings.disasters ? Math.round(rng.range(0.05, 0.3) * 100) / 100 : 0,
  };
  game.events.emit('nomadsArrived', { count: s.nomads.count });
  game.addMessage(
    `${s.nomads.count} nomads have arrived at the Town Hall seeking a home. Will you take them in?`,
    'warning',
    { kind: 'building', id: hall.id },
  );
}

/** Walkable tiles (world centers) around the building's door, nearest first. */
function spawnSpots(game: Game, b: Building | null, want: number): [number, number][] {
  const s = game.state;
  const cx = b ? b.doorX : Math.floor(s.W / 2);
  const cz = b ? b.doorZ : Math.floor(s.H / 2);
  const spots: [number, number][] = [];
  for (let radius = 0; radius <= 6 && spots.length < want; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (!inBounds(s, x, z)) continue;
        if (!walkableTile(game, z * s.W + x)) continue;
        spots.push([x + 0.3 + game.rng.next() * 0.4, z + 0.3 + game.rng.next() * 0.4]);
      }
    }
  }
  if (spots.length === 0) spots.push([cx + 0.5, cz + 0.5]);
  return spots;
}
