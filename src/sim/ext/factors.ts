/**
 * Health & happiness factor breakdowns. The same functions drive the simulation targets and the UI tooltips, so
 * what the player reads is exactly what the citizen experiences. The first factor is always the base value; the
 * sum of all factor values is the target the stat drifts toward.
 */
import { ADULT_AGE, COLD_TEMP, ELDERLY_AGE } from '../../core/constants';
import type { Building, Citizen, GameState } from '../../core/types';
import type { Game } from '../game';
import type { Factor } from '../wellbeing';
import { COVER_CHAPEL, COVER_HOSPITAL, COVER_TAVERN, COVER_WELL, coverageAt, type ServiceIndex } from './services';
import {
  BOARDING_HOUSE_HAPPINESS, CHAPEL_HAPPINESS, CHILD_HAPPINESS, COAT_HAPPINESS, COLD_HAPPINESS, DIET_HAPPINESS,
  DIET_HEALTH, ELDERLY_HEALTH, GRIEF_HAPPINESS_FACTOR, HAPPINESS_BASE, HEALTH_BASE, HERBS_HOME_HEALTH, HOMELESS_HAPPINESS,
  HOSPITAL_HEALTH, HUNGRY_HAPPINESS, SICK_HAPPINESS, STONE_HOUSE_HAPPINESS, TAVERN_HAPPINESS, UNBURIED_HAPPINESS,
  UNWELL_HAPPINESS, WELL_HAPPINESS, WELL_HEALTH,
} from './tuning';
import { availableIn } from './util';

/** Where a citizen "lives" for service coverage: the home's center, or their current position when homeless. */
export interface Anchor {
  x: number;
  z: number;
  home: Building | null;
}

export function anchorOf(game: Game, c: Citizen): Anchor {
  if (c.homeId >= 0) {
    const home = game.getBuilding(c.homeId);
    if (home) return { x: home.x + home.w / 2, z: home.z + home.h / 2, home };
  }
  return { x: c.x, z: c.z, home: null };
}

/** Number of food groups (0..4) eaten recently. */
export function dietGroups(c: Citizen): number {
  const m = c.dietMask & 15;
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
}

export function homeHasHerbs(home: Building | null): boolean {
  return !!home && availableIn(home, 'herbs') > 0;
}

function push(out: Factor[], label: string, value: number): void {
  const v = Math.round(value * 10) / 10;
  if (v !== 0) out.push({ label, value: v });
}

/** Health factors. `cover` is the COVER_* mask at the citizen's anchor. */
export function computeHealthFactors(c: Citizen, anchor: Anchor, cover: number): Factor[] {
  const out: Factor[] = [{ label: 'Base health', value: HEALTH_BASE }];
  const groups = dietGroups(c);
  const diet = DIET_HEALTH[groups] ?? 0;
  if (groups >= 3) push(out, `Varied diet (${groups} food types)`, diet);
  else if (groups === 1) push(out, 'Poor diet (one kind of food)', diet);
  else if (groups === 0 && c.food < 50) push(out, 'No proper meals lately', diet);

  if (homeHasHerbs(anchor.home)) push(out, 'Herbs at home', HERBS_HOME_HEALTH);
  if (cover & COVER_WELL) push(out, 'Clean water from a well', WELL_HEALTH);
  if (cover & COVER_HOSPITAL) push(out, 'Hospital nearby', HOSPITAL_HEALTH);
  if (c.age >= ELDERLY_AGE) push(out, 'Old age', ELDERLY_HEALTH);

  if (c.food <= 0.5) push(out, 'Starving', -45);
  else if (c.food < 10) push(out, 'Starving', -(20 + (10 - c.food) * 3));
  else if (c.food < 20) push(out, 'Hungry', -(20 - c.food) * 0.5);

  if (c.warmth <= 0.5) push(out, 'Freezing', -50);
  else if (c.warmth < 30) push(out, 'Cold', -(30 - c.warmth) * 0.8);

  if (c.sick > 0) push(out, cover & COVER_HOSPITAL ? 'Sick (being treated)' : 'Sick', -(15 + c.sick * 30));
  return out;
}

/** Happiness factors. */
export function computeHappinessFactors(s: GameState, c: Citizen, anchor: Anchor, cover: number): Factor[] {
  const out: Factor[] = [{ label: 'Base happiness', value: HAPPINESS_BASE }];
  if (cover & COVER_CHAPEL) push(out, 'Chapel with a priest nearby', CHAPEL_HAPPINESS);
  if (cover & COVER_TAVERN) push(out, 'Tavern serving ale nearby', TAVERN_HAPPINESS);
  if (cover & COVER_WELL) push(out, 'Well nearby', WELL_HAPPINESS);

  const groups = dietGroups(c);
  if (groups >= 2) push(out, `Varied diet (${groups} food types)`, DIET_HAPPINESS[groups] ?? 0);

  // a warm coat is a comfort in the cold season only
  const m = s.time.month;
  if (c.coatWear > 0 && (m >= 8 || m <= 1 || s.weather.temperature < COLD_TEMP)) push(out, 'Warm coat', COAT_HAPPINESS);
  if (c.age < ADULT_AGE) push(out, 'Carefree childhood', CHILD_HAPPINESS);

  if (!anchor.home) push(out, 'Homeless', HOMELESS_HAPPINESS);
  else if (anchor.home.type === 'stoneHouse') push(out, 'Comfortable stone house', STONE_HOUSE_HAPPINESS);
  else if (anchor.home.type === 'boardingHouse') push(out, 'Crowded boarding house', BOARDING_HOUSE_HAPPINESS);

  if (c.grief > 0.5) push(out, 'Grieving a loved one', -c.grief * GRIEF_HAPPINESS_FACTOR);
  if (s.unburied > 0) push(out, 'The dead lie unburied', UNBURIED_HAPPINESS);

  if (c.food < 20) push(out, 'Hungry', HUNGRY_HAPPINESS);
  if (c.warmth < 30) push(out, 'Cold', COLD_HAPPINESS);
  if (c.sick > 0) push(out, 'Feeling ill', SICK_HAPPINESS);
  else if (c.health < 30) push(out, 'Poor health', UNWELL_HAPPINESS);
  return out;
}

export function sumFactors(f: Factor[]): number {
  let t = 0;
  for (const x of f) t += x.value;
  return t;
}

/** Convenience: coverage mask at the citizen's anchor. */
export function citizenCoverage(services: ServiceIndex, anchor: Anchor): number {
  return coverageAt(services, anchor.x, anchor.z);
}
