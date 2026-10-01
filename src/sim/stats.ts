/**
 * Monthly statistics history & advisor warnings (starvation, cold, homelessness, no tools...). OWNER: sim-ext agent.
 *
 * - A StatsSample is appended to `state.history` at the start of every month (and once at game start), capped at
 *   HISTORY_CAP entries. `births`/`deaths` are the tallies accumulated since the previous sample (then reset).
 *   `avgHealth`/`avgHappiness` are 0..100; `avgEducation` is 0..1 (same scale as Citizen.education), averaged over
 *   citizens aged 10+.
 * - Advisors run every few seconds; each warning has its own cooldown (see ext/advisors.ts).
 */
import { ADULT_AGE } from '../core/constants';
import type { StatsSample } from '../core/types';
import { ageClassOf } from '../core/world';
import { collectNotices, runAdvisors, type AdvisorNotice } from './ext/advisors';
import { rt } from './ext/runtime';
import { ADVISOR_INTERVAL, HISTORY_CAP } from './ext/tuning';
import type { Game } from './game';

export { collectNotices, type AdvisorNotice };

export function updateStats(game: Game, dt: number): void {
  const s = game.state;
  const key = s.time.year * 12 + s.time.month;
  const last = s.history.length > 0 ? s.history[s.history.length - 1] : null;
  const lastKey = last ? last.year * 12 + last.month : -1;
  if (key > lastKey) recordSample(game);

  if (!(dt > 0)) return;
  const r = rt(game);
  r.advisorTimer += dt;
  if (r.advisorTimer >= ADVISOR_INTERVAL) {
    r.advisorTimer = 0;
    runAdvisors(game);
  }
}

/** Append a sample for the current month and reset the monthly birth/death tallies. */
export function recordSample(game: Game): StatsSample {
  const s = game.state;
  const sample = takeSample(game);
  s.history.push(sample);
  if (s.history.length > HISTORY_CAP) s.history.splice(0, s.history.length - HISTORY_CAP);
  s.tally.monthBirths = 0;
  s.tally.monthDeaths = 0;
  return sample;
}

/** Snapshot of the town right now (births/deaths = tallies since the last sample). */
export function takeSample(game: Game): StatsSample {
  const s = game.state;
  let adults = 0;
  let children = 0;
  let students = 0;
  let elderly = 0;
  let health = 0;
  let happiness = 0;
  let education = 0;
  let educationN = 0;
  for (const c of s.citizens) {
    switch (ageClassOf(c)) {
      case 'adult': adults++; break;
      case 'child': children++; break;
      case 'student': students++; break;
      case 'elderly': elderly++; break;
    }
    health += c.health;
    happiness += c.happiness;
    if (c.age >= ADULT_AGE) {
      education += c.education;
      educationN++;
    }
  }
  const n = s.citizens.length;
  const totals = game.resourceTotals();
  const whole = (v: number | undefined) => Math.round(v ?? 0);
  const one = (v: number) => Math.round(v * 10) / 10;
  return {
    year: s.time.year,
    month: s.time.month,
    population: n,
    adults,
    children,
    students,
    elderly,
    births: s.tally.monthBirths,
    deaths: s.tally.monthDeaths,
    food: whole(game.foodTotal()),
    firewood: whole(totals.firewood),
    logs: whole(totals.log),
    stone: whole(totals.stone),
    iron: whole(totals.iron),
    tools: whole(totals.tool),
    clothing: whole((totals.woolCoat ?? 0) + (totals.leatherCoat ?? 0)),
    herbs: whole(totals.herbs),
    ale: whole(totals.ale),
    avgHealth: n > 0 ? one(health / n) : 0,
    avgHappiness: n > 0 ? one(happiness / n) : 0,
    avgEducation: educationN > 0 ? Math.round((education / educationN) * 1000) / 1000 : 0,
  };
}
