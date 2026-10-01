/**
 * Service workers: market vendors (keep the market stocked), healers (herbs), tavern keepers (ale), teachers,
 * priests and traders (stay at their building). ARCHITECTURE §3.5 "Market vendors" / "Teacher/healer/...".
 * OWNER: sim-core.
 */
import { FOOD_TYPES, RESOURCES } from '../../../core/defs';
import type { Activity, Building, Citizen, ResourceType } from '../../../core/types';
import type { Game } from '../../game';
import { availableInStorage, findSource, storageFree, unreserved } from '../storage';
import { brainOf, mkTask, type Task } from '../tasks';
import { HOSPITAL_HERBS_TARGET, MARKET_FOOD_TARGET, MARKET_TARGETS, TAVERN_ALE_TARGET, VENDOR_CARRY } from '../tuning';
import { invFood, invGet, resName } from '../util';
import { fetchIntoTask, goDoor, reachableB } from './common';

function serveTask(b: Building, act: Activity, t: number, label: string): Task {
  return mkTask('work', label, [goDoor(b), { op: 'serve', b: b.id, t, act }], { job: true });
}

/** Fetch r (up to n) from the nearest non-market storage into building w. */
function restock(g: Game, c: Citizen, w: Building, r: ResourceType, n: number): Task | null {
  const src = findSource(g, r, w.doorX + 0.5, w.doorZ + 0.5, { markets: false, exclude: w.id, filter: (b) => reachableB(g, c, b) });
  if (!src) return null;
  let amount = Math.min(Math.floor(unreserved(src, r)), Math.ceil(n), VENDOR_CARRY);
  if (w.type === 'market') amount = Math.min(amount, Math.floor(storageFree(w)));
  if (amount < 1) return null;
  return fetchIntoTask(src, w, r, amount, `Stocking ${resName(r).toLowerCase()}`);
}

/** Goods already on their way into building w (claimed or carried by its workers). */
function inflightTo(g: Game, w: Building, r: ResourceType | 'food'): number {
  let n = 0;
  for (const id of w.workerIds) {
    const c = g.citizenById.get(id);
    const t = c ? brainOf(c).cur : null;
    if (!c || !t) continue;
    let delivers = false;
    for (let k = t.si; k < t.steps.length; k++) {
      const st = t.steps[k];
      if (st.op === 'deposit' && st.b === w.id) delivers = true;
    }
    if (!delivers) continue;
    const match = (x: ResourceType) => (r === 'food' ? RESOURCES[x].category === 'food' : x === r);
    for (const cl of t.claims) if (cl.k === 'out' && cl.b !== w.id && match(cl.r)) n += cl.n;
    if (c.carrying && match(c.carrying.type)) n += c.carrying.amount;
  }
  return n;
}

export function planVendor(g: Game, c: Citizen, m: Building): Task | null {
  // candidate restock items with their deficit ratio (food weighted: it is what markets are for)
  const cands: { r: ResourceType; deficit: number; ratio: number }[] = [];
  const food = invFood(m.inventory) + inflightTo(g, m, 'food');
  if (food < MARKET_FOOD_TARGET) {
    // bring the food type that is plentiful in storage and scarce in the market
    let bestR: ResourceType | null = null;
    let bestScore = 0;
    for (const r of FOOD_TYPES) {
      const avail = availableInStorage(g, r);
      if (avail < 1) continue;
      const score = avail / (1 + invGet(m.inventory, r) * 4);
      if (score > bestScore) {
        bestScore = score;
        bestR = r;
      }
    }
    if (bestR) cands.push({ r: bestR, deficit: MARKET_FOOD_TARGET - food, ratio: 1.5 * (1 - food / MARKET_FOOD_TARGET) });
  }
  for (const k in MARKET_TARGETS) {
    const r = k as ResourceType;
    const target = MARKET_TARGETS[k] ?? 0;
    const have = invGet(m.inventory, r) + inflightTo(g, m, r);
    if (have >= target || availableInStorage(g, r) < 1) continue;
    cands.push({ r, deficit: target - have, ratio: 1 - have / target });
  }
  cands.sort((a, b) => b.ratio - a.ratio);
  for (const cd of cands) {
    const t = restock(g, c, m, cd.r, cd.deficit);
    if (t) return t;
  }
  return serveTask(m, 'working', 10, 'Selling goods at the market');
}

export function planHealer(g: Game, c: Citizen, h: Building): Task {
  const herbs = invGet(h.inventory, 'herbs') + inflightTo(g, h, 'herbs');
  if (herbs < HOSPITAL_HERBS_TARGET * 0.6) {
    const t = restock(g, c, h, 'herbs', HOSPITAL_HERBS_TARGET - herbs);
    if (t) return t;
  }
  return serveTask(h, 'healing', 15, 'Tending to the sick');
}

export function planTavernkeeper(g: Game, c: Citizen, h: Building): Task {
  const ale = invGet(h.inventory, 'ale') + inflightTo(g, h, 'ale');
  if (ale < TAVERN_ALE_TARGET * 0.6) {
    const t = restock(g, c, h, 'ale', TAVERN_ALE_TARGET - ale);
    if (t) return t;
  }
  return serveTask(h, 'working', 15, 'Serving ale');
}

export function planServiceStaff(b: Building): Task {
  switch (b.type) {
    case 'school': return serveTask(b, 'working', 20, 'Teaching');
    case 'chapel': return serveTask(b, 'praying', 20, 'Leading prayers');
    case 'tradingPost': return serveTask(b, 'working', 20, 'Keeping the trading post');
    default: return serveTask(b, 'working', 15, 'Working');
  }
}
