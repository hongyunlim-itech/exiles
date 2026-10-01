/**
 * Top-level decision making: what should this citizen do next? Needs first (unstick, store load, sickness,
 * hunger, cold, equipment, household supply), then the profession's work, then idling. OWNER: sim-core.
 */
import { COLD_TEMP, HUNGER_THRESHOLD } from '../../core/constants';
import type { Citizen } from '../../core/types';
import type { Game } from '../game';
import { tileIndexOf } from './movement';
import type { Brain, Task } from './tasks';
import { reachableB } from './work/common';
import { RATION_HUNGER_THRESHOLD, SICK_REST, URGENT_WARMTH, WARM_THRESHOLD } from './tuning';
import { planCropFarmer, planHerder } from './work/farm';
import { planForager, planFisherman, planForester, planHunter } from './work/gather';
import { planBuilder, planLaborer } from './work/laborer';
import {
  hungerIsUrgent, planDeposit, planEat, planEquip, planExit, planIdle, planPlay, planRest, planStudy, planSupply, planWarm,
} from './work/needs';
import { planHealer, planServiceStaff, planTavernkeeper, planVendor } from './work/services';
import { planExtraction, planWorkshop } from './work/workshop';

export function planTask(g: Game, c: Citizen, brain: Brain): Task {
  const s = g.state;
  const now = s.time.elapsed;

  // 0. standing on a blocked tile (building placed on top, bridge removed, left inside a site) -> step off
  if (!g.isWalkableTile(tileIndexOf(g, c))) return planExit(g, c);

  const cold = s.weather.temperature < COLD_TEMP;
  // 1. urgent needs come before storing the load in the hands (it stays in the hands meanwhile): otherwise a need
  //    interrupt would only lead to another deposit trip, interrupted again and again
  if (now >= brain.cdEat && hungerIsUrgent(g, c)) {
    const t = planEat(g, c);
    if (t) return t;
    brain.cdEat = now + 8;
  }
  if (cold && c.warmth < URGENT_WARMTH && now >= brain.cdWarm) {
    const t = planWarm(g, c);
    if (t) return t;
    brain.cdWarm = now + 12;
  }

  // 2. store whatever is in the hands
  if (c.carrying) {
    const t = planDeposit(g, c, brain);
    if (t) return t;
  }

  // 3. hunger (while food is rationed people wait until they are really hungry, and eat smaller meals)
  if (c.food < (g.rt.rationing ? RATION_HUNGER_THRESHOLD : HUNGER_THRESHOLD) && now >= brain.cdEat) {
    const t = planEat(g, c);
    if (t) return t;
    brain.cdEat = now + 8;
  }

  // 4. cold
  if (cold && c.warmth < WARM_THRESHOLD && now >= brain.cdWarm) {
    const t = planWarm(g, c);
    if (t) return t;
    brain.cdWarm = now + 12;
  }

  // 4. sickness: rest at home
  if (c.sick > SICK_REST) return planRest(g, c);

  // 5. children & students
  if (c.profession === 'child') return planPlay(g, c);
  if (c.profession === 'student') return planStudy(g, c, brain) ?? planPlay(g, c);

  // 6. equipment
  if (c.toolWear <= 0 && now >= brain.cdTool) {
    const t = planEquip(g, c, 'tool');
    if (t) return t;
    brain.cdTool = now + 30;
  }
  const coatSeason = s.time.month >= 7 || s.time.month <= 1 || s.weather.temperature < COLD_TEMP;
  if (c.coatWear <= 0 && coatSeason && now >= brain.cdCoat) {
    const t = planEquip(g, c, 'coat');
    if (t) return t;
    brain.cdCoat = now + 40;
  }

  // 7. household supply
  if (c.homeId >= 0 && now >= brain.cdFetch) {
    const t = planSupply(g, c);
    if (t) {
      brain.cdFetch = now + 20;
      return t;
    }
    brain.cdFetch = now + 6;
  }

  // 8. work
  const w = planWork(g, c, brain);
  if (w) return w;

  // 9. idle
  const wp = c.workplaceId >= 0 ? g.buildingById.get(c.workplaceId) : null;
  return planIdle(g, c, wp && wp.state === 'active' ? wp : null);
}

function planWork(g: Game, c: Citizen, brain: Brain): Task | null {
  switch (c.profession) {
    case 'laborer':
      return planLaborer(g, c, brain);
    case 'builder':
      return planBuilder(g, c, brain);
    case 'child':
    case 'student':
      return null;
  }
  const w = c.workplaceId >= 0 ? g.buildingById.get(c.workplaceId) : undefined;
  if (!w || w.state !== 'active') return planLaborer(g, c, brain);
  // cut off from the workplace (bridge removed...): help out as a laborer instead of failing every plan
  if (!reachableB(g, c, w)) return planLaborer(g, c, brain);
  if (w.paused) return planLaborer(g, c, brain, { nearX: w.doorX, nearZ: w.doorZ, maxDist: 40 });
  let t: Task | null = null;
  switch (w.type) {
    case 'gathererHut': t = planForager(g, c, w, brain, false); break;
    case 'herbalist': t = planForager(g, c, w, brain, true); break;
    case 'hunterCabin': t = planHunter(g, c, w, brain); break;
    case 'fishingDock': t = planFisherman(g, c, w, brain); break;
    case 'foresterLodge': t = planForester(g, c, w, brain); break;
    case 'woodcutter':
    case 'blacksmith':
    case 'tailor':
    case 'brewery': t = planWorkshop(g, c, w); break;
    case 'quarry':
    case 'mine': t = planExtraction(g, c, w); break;
    case 'cropField':
    case 'orchard': t = planCropFarmer(g, c, w, brain); break;
    case 'pasture': t = planHerder(g, c, w); break;
    case 'market': t = planVendor(g, c, w); break;
    case 'hospital': t = planHealer(g, c, w); break;
    case 'tavern': t = planTavernkeeper(g, c, w); break;
    default: t = planServiceStaff(w); break;
  }
  if (t) return t;
  // nothing to do at the workplace (winter fields, no deer...): help out nearby as a laborer
  return planLaborer(g, c, brain, { nearX: w.doorX, nearZ: w.doorZ, maxDist: 45 });
}
