/**
 * Advisor warnings: short, actionable Banished-style notices about food, firewood, housing, tools, construction,
 * storage, graves, sickness and morale. Each warning has its own cooldown (>= 2 months) so the log isn't flooded.
 */
import { ADULT_AGE, COLD_TEMP, FIREWOOD_BURN_RATE, MONTH_SECONDS } from '../../core/constants';
import { BUILDINGS, CLIMATE_OFFSET, CLOTHING_TYPES, MONTH_TEMPERATURE, RESOURCES } from '../../core/defs';
import type { Building, GameMessage, GameState, MessageSeverity, ResourceType } from '../../core/types';
import type { Game } from '../game';
import { dietGroups } from './factors';
import { rt } from './runtime';
import { getServices, graveCapacity } from './services';
import { CHILD_HUNGER_FACTOR } from '../core/citizens';
import { ADVISOR_COOLDOWN, FOOD_PER_CITIZEN_MONTH } from './tuning';
import { buildingName, resourceName } from './util';

export interface AdvisorNotice {
  key: string;
  text: string;
  severity: MessageSeverity;
  target?: GameMessage['target'];
  /** Cooldown override in seconds (never below ADVISOR_COOLDOWN = 2 months). */
  cooldown?: number;
}

/** Don't nag during the first moments of a new game. */
const ADVISOR_START_DELAY = 30;
/** At most this many advisor messages per evaluation. */
const MAX_PER_EVAL = 2;

const SEVERITY_ORDER: Record<MessageSeverity, number> = { danger: 0, warning: 1, info: 2, good: 3 };

/** Evaluate all advisors and post the ones that are due. */
export function runAdvisors(game: Game): AdvisorNotice[] {
  const s = game.state;
  if (s.gameOver || s.citizens.length === 0 || s.time.elapsed < ADVISOR_START_DELAY) return [];
  const r = rt(game);
  const now = s.time.elapsed;
  const due = collectNotices(game).filter((n) => (r.advisorNext.get(n.key) ?? -Infinity) <= now);
  due.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const posted = due.slice(0, MAX_PER_EVAL);
  for (const n of posted) {
    r.advisorNext.set(n.key, now + Math.max(ADVISOR_COOLDOWN, n.cooldown ?? ADVISOR_COOLDOWN));
    game.addMessage(n.text, n.severity, n.target);
  }
  return posted;
}

/** All advisor notices whose condition currently holds (ignores cooldowns). Exposed for tests/UI. */
export function collectNotices(game: Game): AdvisorNotice[] {
  const s = game.state;
  const out: AdvisorNotice[] = [];
  const pop = s.citizens.length;
  const totals = game.resourceTotals();
  const services = getServices(game);

  // ---- per-citizen tallies ----
  let starving = 0;
  let freezing = 0;
  let children = 0;
  let homeless = 0;
  let adults = 0;
  let noTool = 0;
  let noCoat = 0;
  let sick = 0;
  let happySum = 0;
  let poorDiet = 0;
  let firstStarving = -1;
  let firstFreezing = -1;
  let firstHomeless = -1;
  for (const c of s.citizens) {
    if (c.food <= 0.5) {
      starving++;
      if (firstStarving < 0) firstStarving = c.id;
    }
    if (c.warmth < 15) {
      freezing++;
      if (firstFreezing < 0) firstFreezing = c.id;
    }
    if (c.sick > 0) sick++;
    if (c.age < ADULT_AGE) children++;
    if (c.age < ADULT_AGE || c.profession === 'student') continue;
    adults++;
    happySum += c.happiness;
    const groups = dietGroups(c);
    if (groups === 1 || (groups === 0 && c.food < 50)) poorDiet++; // newcomers who haven't eaten yet don't count
    if (c.homeId < 0) {
      homeless++;
      if (firstHomeless < 0) firstHomeless = c.id;
    }
    if (c.toolWear <= 0 && c.profession !== 'child') noTool++;
    if (c.coatWear <= 0) noCoat++;
  }

  // ---- food ----
  let houseFood = 0;
  let houseFirewood = 0;
  let burnPerMonth = 0;
  let coldHomes = 0;
  let firstColdHome = -1;
  const coldNow = s.weather.temperature < COLD_TEMP;
  for (const h of services.houses) {
    if (h.state !== 'active') continue;
    for (const k of Object.keys(h.inventory) as ResourceType[]) {
      if (RESOURCES[k]?.category === 'food') houseFood += h.inventory[k] ?? 0;
    }
    houseFirewood += h.inventory.firewood ?? 0;
    if (h.residentIds.length > 0) {
      burnPerMonth += FIREWOOD_BURN_RATE * (BUILDINGS[h.type].heatEfficiency ?? 1) * MONTH_SECONDS;
      if (coldNow && (h.inventory.firewood ?? 0) <= 0.01) {
        coldHomes++;
        if (firstColdHome < 0) firstColdHome = h.id;
      }
    }
  }
  // food waiting at workplaces (gatherers, fields, docks...) and in ruins is food too — it just isn't stored yet
  let bufferFood = 0;
  for (const b of s.buildings) {
    const def = BUILDINGS[b.type];
    if (!def || def.housing || def.storage || (b.state !== 'active' && b.state !== 'ruin')) continue;
    for (const k of Object.keys(b.inventory) as ResourceType[]) {
      if (RESOURCES[k]?.category === 'food') bufferFood += b.inventory[k] ?? 0;
    }
  }
  // children eat less (sim-core CHILD_HUNGER_FACTOR)
  const perMonth = Math.max(1e-6, (pop - children * (1 - CHILD_HUNGER_FACTOR)) * FOOD_PER_CITIZEN_MONTH);
  const stored = game.foodTotal() + houseFood;
  const months = (stored + bufferFood) / perMonth;
  if (starving > 0) {
    const who = `${starving} ${starving === 1 ? 'person is' : 'people are'}`;
    const target: GameMessage['target'] = firstStarving >= 0 ? { kind: 'citizen', id: firstStarving } : undefined;
    if (months < 2) {
      // food really is short: more food production is the fix
      out.push({
        key: 'starving',
        severity: 'danger',
        text: `${who} starving! Put more workers on food and make sure it reaches a storage barn.`,
        target,
      });
    } else {
      // plenty of food in town: blaming food production would be wrong - they cannot get to it in time
      out.push({
        key: 'hungryWithFood',
        severity: 'warning',
        text: `${who} going hungry although the town has ${Math.round(stored + bufferFood)} food. They live or work too far from it: ` +
          'build a Storage Barn or Market nearer their homes and workplaces, and roads to speed them up.',
        target,
      });
    }
  } else if (pop > 0) {
    if (months < 2) {
      out.push({
        key: 'food',
        severity: months < 1 ? 'danger' : 'warning',
        text: `Food is running low — about ${months < 1 ? 'a few weeks' : `${months.toFixed(1)} months`} left. Build gatherers, hunters, fishing docks or fields.`,
      });
    } else if (stored / perMonth < 1 && bufferFood >= perMonth) {
      out.push({
        key: 'foodStranded',
        severity: 'warning',
        text: `Food is piling up at the workplaces (${Math.round(bufferFood)}) while the storage barns are nearly empty. Free some laborers to haul it, or build a Storage Barn closer to them.`,
      });
    }
  }

  // ---- firewood & cold ----
  const coldAhead = coldMonthsAhead(s);
  if (coldAhead > 0 && burnPerMonth > 0) {
    const stock = (totals.firewood ?? 0) + houseFirewood;
    const need = burnPerMonth * coldAhead;
    if (stock < need * 0.5 || stock < burnPerMonth * 1.5) {
      const hasCutter = s.buildings.some((b) => b.type === 'woodcutter' && b.state === 'active');
      out.push({
        key: 'firewood',
        severity: stock < burnPerMonth ? 'danger' : 'warning',
        text: hasCutter
          ? 'Firewood is running low with the cold months ahead. Add woodcutters and keep logs in the stockpile.'
          : 'Firewood is running low with the cold months ahead. Build a Woodcutter and keep it supplied with logs.',
      });
    }
  }
  // homes with a cold hearth while the stockpile can't refill them (a fetcher already on the way is fine)
  if (coldHomes > 0 && burnPerMonth > 0 && (totals.firewood ?? 0) < coldHomes * 5) {
    out.push({
      key: 'coldHomes',
      severity: 'danger',
      text: `${coldHomes} ${coldHomes === 1 ? 'home has' : 'homes have'} no firewood in the cold — the people living there will freeze. Keep firewood in the stockpile (Woodcutter + logs).`,
      target: firstColdHome >= 0 ? { kind: 'building', id: firstColdHome } : undefined,
    });
  }
  if (freezing >= 3) {
    out.push({
      key: 'freezing',
      severity: 'danger',
      text: 'People are freezing! Keep homes stocked with firewood and have a Tailor sew warm coats.',
      target: firstFreezing >= 0 ? { kind: 'citizen', id: firstFreezing } : undefined,
    });
  }
  const clothing = CLOTHING_TYPES.reduce((a, k) => a + (totals[k] ?? 0), 0);
  if (coldAhead > 0 && clothing <= 0 && adults >= 4 && noCoat >= adults * 0.3) {
    out.push({
      key: 'coats',
      severity: 'info',
      text: 'Many townsfolk lack warm coats for the cold. A Tailor can sew them from leather or wool.',
      cooldown: 4 * MONTH_SECONDS,
    });
  }

  // ---- housing ----
  if (homeless >= 2) {
    out.push({
      key: 'homeless',
      severity: 'warning',
      text: `${homeless} townsfolk have no home. Build more houses — the homeless are unhappy and freeze in winter.`,
      target: firstHomeless >= 0 ? { kind: 'citizen', id: firstHomeless } : undefined,
    });
  }

  // ---- tools ----
  if ((totals.tool ?? 0) <= 0 && noTool >= 3) {
    const hasSmith = s.buildings.some((b) => b.type === 'blacksmith' && b.state === 'active');
    out.push({
      key: 'tools',
      severity: 'warning',
      text: hasSmith
        ? 'Tools have run out and workers labour at half speed. Keep the Blacksmith supplied with iron and logs.'
        : 'Your workers have no tools and labour at half speed. Build a Blacksmith and supply it with iron and logs.',
    });
  }

  // ---- construction ----
  const sites = s.buildings.filter((b) => b.state === 'construction');
  if (sites.length > 0) {
    const builders = s.citizens.reduce((n, c) => n + (c.profession === 'builder' ? 1 : 0), 0);
    if (builders === 0) {
      out.push({
        key: 'builders',
        severity: 'warning',
        text: 'Construction has stalled: nobody is assigned as a builder. Assign builders in the Professions window.',
        target: { kind: 'building', id: sites[0].id },
      });
    } else {
      const missing = missingMaterials(sites, totals);
      if (missing) {
        const others = missing.count > 1 ? ` (and ${missing.count - 1} more site${missing.count > 2 ? 's' : ''})` : '';
        out.push({
          key: 'materials',
          severity: 'warning',
          text: `Construction of the ${buildingName(missing.site)}${others} is waiting for ${resourceName(missing.resource).toLowerCase()}. Gather more or reorder your priorities.`,
          target: { kind: 'building', id: missing.site.id },
          cooldown: 3 * MONTH_SECONDS,
        });
      }
    }
  }

  // ---- storage ----
  try {
    const u = game.storageUsage();
    // no storage of a kind at all (e.g. the only barn burnt down): production piles up at the workplaces
    if (u.barnCap <= 0) {
      out.push({
        key: 'noBarn',
        severity: 'danger',
        text: 'The town has no Storage Barn! Food, tools and clothing pile up at the workplaces where nobody can use them. Build a Storage Barn.',
      });
    }
    if (u.stockpileCap <= 0) {
      out.push({ key: 'noStockpile', severity: 'warning', text: 'The town has no Stockpile. Build one so laborers can store logs, stone, iron and firewood.' });
    }
    if (u.stockpileCap > 0 && u.stockpileUsed >= u.stockpileCap * 0.95) {
      out.push({ key: 'stockpileFull', severity: 'warning', text: 'Stockpiles are full. Build another Stockpile so laborers have somewhere to put materials.' });
    }
    if (u.barnCap > 0 && u.barnUsed >= u.barnCap * 0.95) {
      out.push({ key: 'barnFull', severity: 'warning', text: 'Storage barns are full. Build another Storage Barn to keep food and goods safe.' });
    }
  } catch {
    /* storage usage unavailable */
  }

  // ---- graves ----
  if (s.unburied > 0) {
    const cems = services.cemeteries.filter((b) => b.state === 'active');
    if (cems.length === 0) {
      const planned = s.buildings.find((b) => b.type === 'cemetery' && b.state !== 'ruin');
      out.push({
        key: 'graves',
        severity: 'warning',
        text: planned
          ? 'The dead lie unburied and the town grieves. Finish the Cemetery so they can be laid to rest.'
          : 'The dead lie unburied and the town grieves. Build a Cemetery to lay them to rest.',
        target: planned ? { kind: 'building', id: planned.id } : undefined,
      });
    } else if (cems.every((b) => (b.graves ?? 0) >= graveCapacity(b))) {
      out.push({
        key: 'graves',
        severity: 'warning',
        text: 'The cemetery is full and the dead lie unburied. Build a larger or second Cemetery.',
        target: { kind: 'building', id: cems[0].id },
      });
    }
  }

  // ---- sickness ----
  if (sick >= 3) {
    const hasHospital = services.hospitalsStaffed.length > 0;
    const hasHerbs = services.hospitals.length > 0;
    if (!hasHospital || !hasHerbs) {
      out.push({
        key: 'sickness',
        severity: 'warning',
        text: !hasHospital
          ? `${sick} people are sick. Build a Hospital with a healer — herbs from an Herbalist cure the ill.`
          : `${sick} people are sick and the hospital is out of herbs. Build an Herbalist or buy herbs from a merchant.`,
      });
    }
  }

  // ---- morale & diet ----
  if (adults >= 5 && happySum / adults < 30) {
    out.push({
      key: 'unhappy',
      severity: 'info',
      text: 'Spirits in town are low. A Chapel, a Tavern serving ale, or a Well near homes would lift them.',
      cooldown: 4 * MONTH_SECONDS,
    });
  }
  // Diet memory lasts a few months, so only judge variety once the town has been eating for a while.
  if (s.time.elapsed > 3 * MONTH_SECONDS && adults >= 5 && poorDiet >= adults * 0.5 && starving === 0) {
    out.push({
      key: 'diet',
      severity: 'info',
      text: 'Most people eat only one kind of food. A varied diet of meat, grain, vegetables and fruit keeps them healthy.',
      cooldown: 6 * MONTH_SECONDS,
    });
  }
  return out;
}

/** Number of cold months (temperature below COLD_TEMP) coming up within the next ~4 months, incl. the current one. */
export function coldMonthsAhead(s: GameState): number {
  const off = CLIMATE_OFFSET[s.settings.climate] ?? 0;
  let count = 0;
  let seenCold = false;
  for (let k = 0; k < 12; k++) {
    const m = (s.time.month + k) % 12;
    const cold = MONTH_TEMPERATURE[m] + off < COLD_TEMP;
    if (cold) {
      if (!seenCold && k > 3) break; // the cold season is still far off
      count++;
      seenCold = true;
    } else if (seenCold) {
      break;
    }
  }
  return count;
}

function missingMaterials(
  sites: Building[],
  totals: Record<ResourceType, number>,
): { site: Building; resource: ResourceType; count: number } | null {
  let first: { site: Building; resource: ResourceType } | null = null;
  let count = 0;
  const pending: Partial<Record<ResourceType, number>> = {};
  for (const b of sites) {
    if (b.paused) continue;
    let lacking: ResourceType | null = null;
    for (const k of Object.keys(b.cost) as ResourceType[]) {
      const need = (b.cost[k] ?? 0) - (b.delivered[k] ?? 0) - (b.incoming[k] ?? 0);
      if (need <= 0) continue;
      pending[k] = (pending[k] ?? 0) + need;
      if (!lacking && (totals[k] ?? 0) < (pending[k] ?? 0) && (totals[k] ?? 0) < need) lacking = k;
    }
    if (lacking) {
      count++;
      if (!first) first = { site: b, resource: lacking };
    }
  }
  return first ? { ...first, count } : null;
}
