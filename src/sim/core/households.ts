/**
 * Housing & marriage (ARCHITECTURE §3.4, Banished-style): homeless families move into empty family homes, young
 * adults (from MARRY_AGE) leave their parents to marry and found a household in an empty home — or claim one alone
 * and are joined by a partner later — single adults take boarding-house beds, and orphans are taken in by another
 * household. Population growth therefore follows the housing supply. OWNER: sim-core.
 */
import { ADULT_AGE } from '../../core/constants';
import { BUILDINGS } from '../../core/defs';
import type { Building, Citizen } from '../../core/types';
import type { Game } from '../game';
import { MARRY_AGE } from './citizens';

function capacity(h: Building): number {
  return BUILDINGS[h.type].housing ?? 0;
}

function space(h: Building): number {
  return capacity(h) - h.residentIds.length;
}

function isFamilyHome(h: Building | undefined | null): h is Building {
  return !!h && !!BUILDINGS[h.type].familyHome;
}

export function moveIn(g: Game, c: Citizen, h: Building): void {
  if (c.homeId === h.id) return;
  if (c.homeId >= 0) {
    const old = g.buildingById.get(c.homeId);
    if (old) old.residentIds = old.residentIds.filter((x) => x !== c.id);
  }
  c.homeId = h.id;
  if (!h.residentIds.includes(c.id)) h.residentIds.push(c.id);
}

/** Close kin who must never marry: (half-)siblings and parent/child. */
export function related(a: Citizen, b: Citizen): boolean {
  if (a.id === b.id) return true;
  if (a.motherId >= 0 && a.motherId === b.motherId) return true;
  if (a.fatherId >= 0 && a.fatherId === b.fatherId) return true;
  return a.motherId === b.id || a.fatherId === b.id || b.motherId === a.id || b.fatherId === a.id;
}

/** Too young to leave the family: children and young teens stay with (and move with) their parents. */
function isDependant(c: Citizen): boolean {
  return c.age < MARRY_AGE && c.spouseId < 0;
}

function homeOfC(g: Game, c: Citizen): Building | undefined {
  return c.homeId >= 0 ? g.buildingById.get(c.homeId) : undefined;
}

function inBoarding(g: Game, c: Citizen): boolean {
  const h = homeOfC(g, c);
  return !!h && !BUILDINGS[h.type].familyHome;
}

/** Residents of a home who are old enough to marry. */
function grownResidents(g: Game, h: Building): Citizen[] {
  const out: Citizen[] = [];
  for (const id of h.residentIds) {
    const c = g.citizenById.get(id);
    if (c && c.age >= MARRY_AGE) out.push(c);
  }
  return out;
}

/**
 * How a single adult of marrying age is housed: 'homeless', 'boarding', 'sharing' (lives in a family home with
 * other grown-ups — parents, foster family, siblings) or 'head' (the only grown-up of their family home).
 * null when not a single of marrying age.
 */
type SingleStatus = 'homeless' | 'boarding' | 'sharing' | 'head';

function singleStatus(g: Game, c: Citizen): SingleStatus | null {
  if (c.age < MARRY_AGE || c.spouseId >= 0) return null;
  const h = homeOfC(g, c);
  if (!h) return 'homeless';
  if (!BUILDINGS[h.type].familyHome) return 'boarding';
  for (const id of h.residentIds) {
    if (id === c.id) continue;
    const o = g.citizenById.get(id);
    if (o && o.age >= MARRY_AGE) return 'sharing';
  }
  return 'head';
}

/**
 * True for a single young adult who would move into an empty family home if one were available (homeless, in a
 * boarding house, or still living with parents / foster family). Used by the UI/bot to judge housing demand.
 */
export function wantsOwnHome(g: Game, c: Citizen): boolean {
  const st = singleStatus(g, c);
  return st === 'homeless' || st === 'boarding' || st === 'sharing';
}

/** Couples are formed only between people at most this many years apart. */
const MAX_AGE_GAP = 20;

const STATUS_SCORE: Record<SingleStatus, number> = { homeless: 300, boarding: 200, sharing: 100, head: 0 };

/** Dependants (children & young teens) of these parents that should follow them into a new home. */
function dependants(g: Game, parents: Citizen[]): Citizen[] {
  const ids = new Set(parents.map((p) => p.id));
  const oldHomes = new Set(parents.map((p) => p.homeId).filter((x) => x >= 0));
  const out: Citizen[] = [];
  for (const p of parents) {
    for (const kid of p.childIds) {
      const k = g.citizenById.get(kid);
      if (!k || ids.has(k.id) || !isDependant(k)) continue;
      if (k.homeId < 0 || oldHomes.has(k.homeId) || inBoarding(g, k)) {
        ids.add(k.id);
        out.push(k);
      }
    }
  }
  return out;
}

/** Move adults (+ their dependants, as far as there is room) into h. */
function moveFamily(g: Game, adults: Citizen[], h: Building): void {
  const kids = dependants(g, adults);
  for (const a of adults) moveIn(g, a, h);
  for (const k of kids) {
    if (space(h) <= 0) break;
    moveIn(g, k, h);
  }
}

/** Repair home links (dead residents, destroyed homes). */
function sanitize(g: Game): void {
  const s = g.state;
  for (const h of g.rt.houses(s)) {
    if (h.residentIds.length === 0) continue;
    h.residentIds = h.residentIds.filter((id) => {
      const c = g.citizenById.get(id);
      return !!c && c.homeId === h.id;
    });
    if (h.state !== 'active') {
      for (const id of h.residentIds) {
        const c = g.citizenById.get(id);
        if (c) c.homeId = -1;
      }
      h.residentIds = [];
    }
  }
  for (const c of s.citizens) {
    if (c.homeId < 0) continue;
    const h = g.buildingById.get(c.homeId);
    if (!h || h.state !== 'active' || !BUILDINGS[h.type].housing) {
      c.homeId = -1;
      continue;
    }
    if (!h.residentIds.includes(c.id)) h.residentIds.push(c.id);
  }
}

/** A family home whose residents are all children (nobody old enough to work and keep the house supplied). */
function childOnly(g: Game, h: Building): boolean {
  if (h.residentIds.length === 0) return false;
  for (const id of h.residentIds) {
    const c = g.citizenById.get(id);
    if (c && c.age >= ADULT_AGE) return false;
  }
  return true;
}

export function updateHousing(g: Game): void {
  const s = g.state;
  sanitize(g);
  const houses = g.rt.houses(s).filter((h) => h.state === 'active');
  if (houses.length === 0) return;
  const family = houses.filter((h) => BUILDINGS[h.type].familyHome);
  const boarding = houses.filter((h) => !BUILDINGS[h.type].familyHome);
  const emptyFamily = (): Building | undefined => family.find((h) => h.residentIds.length === 0);

  // (a) homeless / boarding dependants join a parent living in a family home with room
  for (const c of s.citizens) {
    if (!isDependant(c) || (c.homeId >= 0 && !inBoarding(g, c))) continue;
    for (const pid of [c.motherId, c.fatherId]) {
      const p = pid >= 0 ? g.citizenById.get(pid) : undefined;
      const h = p ? homeOfC(g, p) : undefined;
      if (isFamilyHome(h) && space(h) > 0) {
        moveIn(g, c, h);
        break;
      }
    }
  }

  // (b) married couples without a family home (homeless or boarding) -> the spouse's family home, else an empty one
  for (const c of s.citizens) {
    if (c.spouseId < 0 || c.gender !== 'F') continue;
    const sp = g.citizenById.get(c.spouseId);
    if (!sp) continue;
    const hc = homeOfC(g, c);
    const hs = homeOfC(g, sp);
    if (isFamilyHome(hc) && hc === hs) continue; // settled
    if (isFamilyHome(hc) && !isFamilyHome(hs) && space(hc) > 0) {
      moveFamily(g, [sp], hc);
      continue;
    }
    if (isFamilyHome(hs) && !isFamilyHome(hc) && space(hs) > 0) {
      moveFamily(g, [c], hs);
      continue;
    }
    const h = emptyFamily();
    if (h) moveFamily(g, [c, sp], h);
  }

  // (c) single parents without a family home: join their children's home if it has room, else take an empty home
  //     together with their homeless dependants
  for (const c of s.citizens) {
    if (c.age < MARRY_AGE || c.spouseId >= 0) continue;
    if (c.homeId >= 0 && !inBoarding(g, c)) continue;
    let joined = false;
    for (const kid of c.childIds) {
      const k = g.citizenById.get(kid);
      const h = k && isDependant(k) ? homeOfC(g, k) : undefined;
      if (isFamilyHome(h) && space(h) > 0) {
        moveFamily(g, [c], h);
        joined = true;
        break;
      }
    }
    if (joined) continue;
    const kids = dependants(g, [c]).filter((k) => k.homeId < 0 || inBoarding(g, k));
    if (kids.length === 0) continue;
    const h = emptyFamily();
    if (h) moveFamily(g, [c], h);
  }

  // homeless single adults take a boarding-house bed (they can still marry into a family home below)
  for (const c of s.citizens) {
    if (c.homeId >= 0 || isDependant(c) || c.spouseId >= 0) continue;
    const b = boarding.find((h) => space(h) > 0);
    if (b) moveIn(g, c, b);
  }

  // (d) orphans: homeless dependants nobody took in, and children left alone in a home, move in with a relative or
  //     the smallest household with room (siblings together where possible)
  placeOrphans(g, family);

  // (e) empty family homes (and homes of orphaned children, who need a guardian) -> newly married couples
  let guard = 0;
  while (guard++ < 16) {
    const target = family.find((h) => h.residentIds.length === 0) ?? family.find((h) => childOnly(g, h) && space(h) >= 2);
    if (!target) break;
    const pair = findCouple(g, target);
    if (!pair) break;
    const [m, f] = pair;
    m.spouseId = f.id;
    f.spouseId = m.id;
    moveFamily(g, [m, f], target);
  }

  // (f) homes still empty (or with orphans only) -> a single young adult claims it; a partner joins later (g)
  guard = 0;
  while (guard++ < 16) {
    const target = family.find((h) => h.residentIds.length === 0) ?? family.find((h) => childOnly(g, h) && space(h) >= 1);
    if (!target) break;
    const single = findSingle(g, target);
    if (!single) break;
    moveFamily(g, [single], target);
  }

  // (g) singles heading a family home alone take a spouse, who moves in (with their dependants)
  for (const h of family) {
    if (h.residentIds.length === 0 || space(h) <= 0) continue;
    const grown = grownResidents(g, h);
    if (grown.length !== 1) continue;
    const a = grown[0];
    if (a.spouseId >= 0) continue;
    const partner = findPartner(g, a, h);
    if (!partner) continue;
    a.spouseId = partner.id;
    partner.spouseId = a.id;
    moveFamily(g, [partner], h);
  }

  // (h) anyone of working age still homeless (e.g. a married newcomer whose spouse is housed apart): an empty home
  for (const c of s.citizens) {
    if (c.homeId >= 0 || isDependant(c)) continue;
    const h = emptyFamily();
    if (!h) break;
    const sp = c.spouseId >= 0 ? g.citizenById.get(c.spouseId) : undefined;
    moveFamily(g, sp && sp.homeId < 0 ? [c, sp] : [c], h);
  }

  // (i) anyone still homeless and too young to live alone: any family home with room (last resort)
  for (const c of s.citizens) {
    if (c.homeId >= 0 || !isDependant(c)) continue;
    const h = smallestWithRoom(family, 1);
    if (h) moveIn(g, c, h);
  }
}

function smallestWithRoom(family: Building[], need: number): Building | undefined {
  let best: Building | undefined;
  for (const h of family) {
    if (h.residentIds.length === 0 || space(h) < need) continue;
    if (!best || h.residentIds.length < best.residentIds.length) best = h;
  }
  return best;
}

/**
 * Orphans (dependants without a parent able to house them): siblings are kept together and taken in by the home
 * of an older sibling, else the smallest household with room. Children alone in their own home are moved too, so the
 * house can be used by a new family. Groups that fit nowhere stay put (or claim an empty home) and wait for a
 * guardian (steps e/f).
 */
function placeOrphans(g: Game, family: Building[]): void {
  const s = g.state;
  const done = new Set<number>();
  for (const c of s.citizens) {
    if (done.has(c.id) || !isDependant(c)) continue;
    const home = homeOfC(g, c);
    const homeless = !home || !BUILDINGS[home.type].familyHome;
    if (!homeless && !childOnly(g, home)) continue;
    // a parent who can still take them in is handled by steps (a)-(c)
    let parentAlive = false;
    for (const pid of [c.motherId, c.fatherId]) if (pid >= 0 && g.citizenById.has(pid)) parentAlive = true;
    if (homeless && parentAlive) continue;
    // the sibling group (same mother or father) in the same situation
    const group: Citizen[] = [c];
    for (const o of s.citizens) {
      if (o === c || done.has(o.id) || !isDependant(o)) continue;
      const sib = (c.motherId >= 0 && o.motherId === c.motherId) || (c.fatherId >= 0 && o.fatherId === c.fatherId);
      if (sib && o.homeId === c.homeId) group.push(o);
    }
    for (const o of group) done.add(o.id);
    // an older sibling's household first, then the smallest home with room for the whole group
    let target: Building | undefined;
    for (const o of s.citizens) {
      if (o.age < MARRY_AGE) continue;
      const sib = (c.motherId >= 0 && o.motherId === c.motherId) || (c.fatherId >= 0 && o.fatherId === c.fatherId);
      const h = sib ? homeOfC(g, o) : undefined;
      if (isFamilyHome(h) && h !== home && space(h) >= group.length) {
        target = h;
        break;
      }
    }
    target ??= smallestWithRoom(family.filter((x) => x !== home && !childOnly(g, x)), group.length);
    if (!target && homeless) {
      // nobody has room: shelter in an empty home until a guardian moves in
      target = family.find((h) => h.residentIds.length === 0);
    }
    if (!target) continue;
    for (const o of group) if (space(target) > 0) moveIn(g, o, target);
  }
}

/** Candidate singles for a new household in `target`, best first. */
function singlesRanked(g: Game, target: Building): { c: Citizen; score: number }[] {
  const out: { c: Citizen; score: number }[] = [];
  for (const c of g.state.citizens) {
    const st = singleStatus(g, c);
    if (!st || st === 'head') continue;
    if (c.homeId === target.id) continue;
    out.push({ c, score: STATUS_SCORE[st] + Math.min(c.age, 60) });
  }
  out.sort((a, b) => b.score - a.score || a.c.id - b.c.id);
  return out;
}

/** The best unrelated man & woman who both want their own home (searches every pair, not just the top ones). */
function findCouple(g: Game, target: Building): [Citizen, Citizen] | null {
  const ranked = singlesRanked(g, target);
  const men = ranked.filter((x) => x.c.gender === 'M');
  const women = ranked.filter((x) => x.c.gender === 'F');
  let best: [Citizen, Citizen] | null = null;
  let bestScore = -Infinity;
  if (space(target) < 2) return null;
  for (const m of men) {
    // ranked lists: once the best possible sum cannot beat the current pair, stop
    if (women.length === 0 || m.score + women[0].score <= bestScore) break;
    for (const f of women) {
      const sc = m.score + f.score - Math.abs(m.c.age - f.c.age) * 0.5;
      if (sc <= bestScore) continue;
      if (Math.abs(m.c.age - f.c.age) > MAX_AGE_GAP || related(m.c, f.c)) continue;
      best = [m.c, f.c];
      bestScore = sc;
    }
  }
  return best;
}

/** The single young adult with the strongest claim to an empty home (homeless > boarding > living with family). */
function findSingle(g: Game, target: Building): Citizen | null {
  const ranked = singlesRanked(g, target);
  return ranked.length > 0 ? ranked[0].c : null;
}

/** A partner for `a`, who lives alone in family home h: they move in with a (and bring their dependants). */
function findPartner(g: Game, a: Citizen, h: Building): Citizen | null {
  let best: Citizen | null = null;
  let bestScore = -Infinity;
  const room = space(h);
  for (const c of g.state.citizens) {
    if (c.gender === a.gender || c.homeId === h.id) continue;
    const st = singleStatus(g, c);
    if (!st) continue;
    if (Math.abs(a.age - c.age) > MAX_AGE_GAP || related(a, c)) continue;
    let score = STATUS_SCORE[st] - Math.abs(c.age - a.age);
    const kids = dependants(g, [c]).length;
    if (1 + kids > room) {
      // their children would not fit: only if they come alone (no dependants to leave behind)
      continue;
    }
    if (st === 'head') {
      // another household head moves in and leaves their home free — prefer the one with fewer dependants
      score -= kids * 5;
    }
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
