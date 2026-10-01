/**
 * QA probes (bundled like run.ts): PROBE=yield|barn|fire|disease|coldhome ...
 *   npx rolldown dev/qa-balance/probes.ts -f esm -p node -o dev/qa-balance/build/probes.mjs (via rolldown.probes.mjs)
 */
import { MONTH_SECONDS, YEAR_SECONDS } from '../../src/core/constants';
import { BUILDINGS, FOOD_TYPES } from '../../src/core/defs';
import type { Building, BuildingType, Difficulty, Climate } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { place } from '../../tests/simcore.helpers';
import { QaBot } from './qabot';
import { writeResult } from './harness';

const env = process.env;
const log = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

function complete(g: Game, b: Building): void {
  b.state = 'active';
  b.progress = 1;
  b.delivered = { ...b.cost };
  b.incoming = {};
  b.workRemaining = 0;
  b.builtAt = g.state.time.elapsed;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const i = zz * g.state.W + xx;
      if (g.state.tiles.feature[i]) g.removeFeature(i);
    }
  }
  g.state.rev.buildings++;
  g.rt.dirty = true;
}

function foodAll(g: Game): number {
  let n = g.foodTotal();
  for (const b of g.state.buildings) if (!BUILDINGS[b.type].storage) for (const r of FOOD_TYPES) n += b.inventory[r] ?? 0;
  return n;
}

function yieldProbe(): void {
  const types: { t: BuildingType; w?: number; h?: number; workers: number; score?: string }[] = [
    { t: 'gathererHut', workers: 4 },
    { t: 'hunterCabin', workers: 3 },
    { t: 'fishingDock', workers: 4 },
    { t: 'cropField', w: 8, h: 8, workers: 3 },
    { t: 'cropField', w: 10, h: 10, workers: 5 },
    { t: 'orchard', w: 8, h: 8, workers: 3 },
    { t: 'pasture', w: 10, h: 10, workers: 2 },
    { t: 'foresterLodge', workers: 4 },
    { t: 'herbalist', workers: 2 },
  ];
  const seeds = (env.SEEDS ?? '11,22,33').split(',').map(Number);
  const climate = (env.CLIMATE ?? 'fair') as Climate;
  const out: any[] = [];
  for (const seed of seeds) {
    for (const spec of types) {
      const g = Game.create({ seed, townName: 'Y', mapSize: 'medium', terrain: 'valleys', climate, difficulty: 'easy', disasters: false });
      g.addToStorage('wheat', 1500);
      g.addToStorage('firewood', 300);
      const c = g.townCenter();
      // houses so nobody is homeless
      for (let k = 0; k < 4; k++) { const h = place(g, 'woodenHouse', c.x, c.z, { maxR: 30 }); if (h) complete(g, h); }
      let b: Building | null = null;
      if (spec.t === 'fishingDock') {
        // nearest shore spot
        for (let r = 10; r <= 60 && !b; r += 10) b = place(g, spec.t, c.x, c.z, { maxR: r });
      } else if (spec.t === 'gathererHut' || spec.t === 'hunterCabin' || spec.t === 'herbalist' || spec.t === 'foresterLodge') {
        // put it at the forest edge: best tree count within 30 tiles
        let best: { x: number; z: number; n: number } | null = null;
        for (let dz = -30; dz <= 30; dz += 3) for (let dx = -30; dx <= 30; dx += 3) {
          const n = g.countTrees(c.x + dx, c.z + dz, 12);
          if (!best || n > best.n) best = { x: c.x + dx, z: c.z + dz, n };
        }
        b = place(g, spec.t, (best!.x + c.x) / 2, (best!.z + c.z) / 2, { maxR: 20 });
      } else {
        b = place(g, spec.t, c.x, c.z, { maxR: 40, w: spec.w, h: spec.h });
      }
      if (!b) { log('no place', spec.t, seed); continue; }
      complete(g, b);
      if (spec.t === 'orchard') { g.setCrop?.(b.id, 'apple' as any); b.orchard = { type: 'apple', maturity: 1, fruit: 0 }; }
      if (spec.t === 'pasture') b.livestock = { type: 'chicken', count: 10, breed: 0, product: 0 };
      g.setWorkers(b.id, spec.workers);
      g.setPriority(b.id, true);
      g.setBuilders(0);
      const dist = Math.hypot(b.doorX - c.x, b.doorZ - c.z);
      const act: Record<string, number> = {};
      const prof = BUILDINGS[spec.t].profession!;
      let workerSec = 0;
      let acc = 0;
      for (let i = 0; i < (2 * YEAR_SECONDS) / 0.25; i++) {
        g.step(0.25);
        acc += 0.25;
        if (acc >= 1 && g.state.time.year >= 2) {
          acc = 0;
          for (const cz of g.state.citizens) {
            if (cz.workplaceId !== b.id) continue;
            workerSec++;
            const k = cz.activity === 'walking' || cz.activity === 'hauling' ? `walk:${cz.taskLabel.split(' ')[0]}` : cz.activity;
            act[k] = (act[k] ?? 0) + 1;
          }
        } else if (acc >= 1) acc = 0;
      }
      // year-2 production is in producedLastYear after the rollover at the start of year 3
      while (g.state.time.month !== 0) g.step(0.25);
      const bb = g.getBuilding(b.id);
      const prod = bb ? { ...bb.producedLastYear } : {};
      let food = 0;
      for (const r of FOOD_TYPES) food += (prod as any)[r] ?? 0;
      const wy = workerSec / YEAR_SECONDS;
      const row = { seed, type: spec.t, size: `${b.w}x${b.h}`, workers: spec.workers, workerYears: +wy.toFixed(2), dist: +dist.toFixed(0), prod, foodPerWorkerYear: +(food / Math.max(0.01, wy)).toFixed(0), act };
      out.push(row);
      log(JSON.stringify(row));
    }
  }
  writeResult(`probe_yield_${climate}`, out);
}

/** Destroy the (only) storage barn at a given time; compare with a control run. */
function barnProbe(): void {
  const seeds = (env.SEEDS ?? '11,22,33').split(',').map(Number);
  const diff = (env.DIFF ?? 'medium') as Difficulty;
  const at = Number(env.AT_MONTH ?? 20); // game month index (0-based from start)
  const how = env.HOW ?? 'fire';
  const years = Number(env.YEARS ?? 5);
  const out: any[] = [];
  for (const seed of seeds) {
    for (const variant of ['control', 'lose']) {
      const g = Game.create({ seed, townName: 'B', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: diff, disasters: false });
      const bot = new QaBot(g);
      let did = false;
      let lost: any = null;
      const pops: number[] = [];
      for (let i = 0; i < (years * YEAR_SECONDS) / 0.25 && !g.state.gameOver; i++) {
        g.step(0.25);
        bot.tick();
        const monthIdx = Math.floor(g.state.time.elapsed / MONTH_SECONDS);
        if (!did && monthIdx >= at) {
          did = true;
          const barns = g.state.buildings.filter((b) => b.type === 'storageBarn' && b.state === 'active');
          const target = barns.sort((a, b2) => (b2.inventory ? Object.values(b2.inventory).reduce((x, y) => x + (y ?? 0), 0) : 0) - Object.values(a.inventory).reduce((x, y) => x + (y ?? 0), 0))[0];
          const before = foodAll(g);
          if (variant === 'lose' && target) {
            const inv = { ...target.inventory };
            g.removeBuilding(target.id, how as 'fire');
            lost = { barns: barns.length, foodBefore: Math.round(before), foodAfter: Math.round(foodAll(g)), tools: Math.round(inv.tool ?? 0), coats: Math.round((inv.woolCoat ?? 0) + (inv.leatherCoat ?? 0)), herbs: Math.round(inv.herbs ?? 0) };
          } else lost = { barns: barns.length, foodBefore: Math.round(before) };
        }
        if (i % ((6 * MONTH_SECONDS) / 0.25) === 0) pops.push(g.state.citizens.length);
      }
      const row = { seed, diff, variant, at, lost, pops, deaths: g.state.tally.deaths, over: g.state.gameOver, end: +(g.state.time.elapsed / YEAR_SECONDS).toFixed(2) };
      out.push(row);
      log(JSON.stringify(row));
    }
  }
  writeResult(`probe_barn_${diff}_${at}_${how}`, out);
}

/** Warmth/health of residents of a house with and without firewood through a winter (no bot). */
function coldHomeProbe(): void {
  const out: any[] = [];
  for (const climate of ['fair', 'harsh'] as Climate[]) {
    for (const wood of [true, false]) {
      const g = Game.create({ seed: 11, townName: 'C', mapSize: 'medium', terrain: 'valleys', climate, difficulty: 'medium', disasters: false });
      g.addToStorage('wheat', 2000);
      const c = g.townCenter();
      for (let k = 0; k < 5; k++) { const h = place(g, 'woodenHouse', c.x, c.z, { maxR: 30 }); if (h) complete(g, h); }
      if (!wood) g.takeFromStorage('firewood', 1e6);
      for (const cz of g.state.citizens) cz.coatWear = 0;
      g.takeFromStorage('woolCoat', 1e6);
      g.takeFromStorage('leatherCoat', 1e6);
      g.setBuilders(0);
      const series: any[] = [];
      for (let i = 0; i < (1.5 * YEAR_SECONDS) / 0.25; i++) {
        g.step(0.25);
        if (!wood) for (const h of g.state.buildings) if (BUILDINGS[h.type].housing) h.inventory.firewood = 0;
        if (i % ((MONTH_SECONDS / 2) / 0.25) === 0) {
          const cs = g.state.citizens;
          const n = cs.length || 1;
          series.push({ y: g.state.time.year, m: g.state.time.month, T: +g.state.weather.temperature.toFixed(1), pop: cs.length, warm: +(cs.reduce((a, x) => a + x.warmth, 0) / n).toFixed(0), warmMin: +Math.min(...cs.map((x) => x.warmth)).toFixed(0), health: +(cs.reduce((a, x) => a + x.health, 0) / n).toFixed(0), happy: +(cs.reduce((a, x) => a + x.happiness, 0) / n).toFixed(0), freezeT: +Math.max(...cs.map((x) => x.freezeTime)).toFixed(0) });
        }
      }
      const row = { climate, wood, deaths: g.state.tally.deaths, series };
      out.push(row);
      log(climate, 'wood', wood, 'deaths', JSON.stringify(g.state.tally.deaths));
      for (const s of series) if (s.m >= 8 || s.m <= 2) log('  ', JSON.stringify(s));
    }
  }
  writeResult('probe_coldhome', out);
}

/** Dump marriage candidates over time (why does a town stop forming households?). */
function singlesProbe(): void {
  const seed = Number(env.SEED ?? 33);
  const years = Number(env.YEARS ?? 14);
  const g = Game.create({ seed, townName: 'S', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: (env.DIFF ?? 'medium') as Difficulty, disasters: true });
  const bot = new QaBot(g);
  const marry = (globalThis as any).__QA?.MARRY_AGE ?? 16;
  for (let i = 0; i < (years * YEAR_SECONDS) / 0.25 && !g.state.gameOver; i++) {
    g.step(0.25);
    bot.tick();
    if (g.state.time.month === 0 && g.state.time.monthProgress < 0.25 / MONTH_SECONDS + 1e-9) {
      const s = g.state;
      const singles = s.citizens.filter((c) => c.age >= marry && c.spouseId < 0);
      const empty = s.buildings.filter((b) => BUILDINGS[b.type].familyHome && b.state === 'active' && b.residentIds.length === 0).length;
      const fam = s.buildings.filter((b) => BUILDINGS[b.type].familyHome && b.state === 'active').map((b) => b.residentIds.length).join(',');
      log(`Y${s.time.year} pop ${s.citizens.length} emptyHouses ${empty} residents[${fam}] singles: ${singles.map((c) => `${c.name.split(' ')[0]}(${c.gender},${c.age.toFixed(1)},mom${c.motherId},home${c.homeId})`).join(' ')}`);
    }
  }
}

/** findCouple sibling deadlock check: oldest single M and F are siblings, a younger unrelated F exists. */
function siblingProbe(): void {
  const g = Game.create({ seed: 5, townName: 'S', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false });
  const s = g.state;
  const c0 = g.townCenter();
  const homes: Building[] = [];
  for (let k = 0; k < 7; k++) { const h = place(g, 'woodenHouse', c0.x, c0.z, { maxR: 30 }); if (h) { complete(g, h); homes.push(h); } }
  g.step(0.25);
  for (let i = 0; i < 20; i++) g.step(0.25); // housing tick
  const fams = s.citizens.filter((c) => c.gender === 'F' && c.spouseId >= 0);
  const momA = fams[0];
  const momB = fams[1];
  const mk = (gender: 'M' | 'F', age: number, mom: typeof momA) => {
    const c = g.spawnCitizen({ x: c0.x, z: c0.z, age, gender });
    c.motherId = mom.id;
    c.fatherId = mom.spouseId;
    mom.childIds.push(c.id);
    g.getCitizen(mom.spouseId)?.childIds.push(c.id);
    // live with parents
    const h = g.getBuilding(mom.homeId)!;
    if (c.homeId >= 0) { const old = g.getBuilding(c.homeId); if (old) old.residentIds = old.residentIds.filter((x) => x !== c.id); }
    c.homeId = h.id;
    h.residentIds.push(c.id);
    return c;
  };
  // siblings are the oldest singles; an unrelated younger woman also lives with her parents
  const bro = mk('M', 18, momA);
  const sis = mk('F', env.NOSIS ? 14 : 18.5, momA);
  const other = mk('F', 16.5, momB);
  const empty = () => s.buildings.filter((b) => b.type === 'woodenHouse' && b.state === 'active' && b.residentIds.length === 0).length;
  log('before: empty houses', empty(), 'bro spouse', bro.spouseId, 'other spouse', other.spouseId);
  for (let i = 0; i < 4 * 60 * 4; i++) g.step(0.25); // 4 months
  log('after 4 months: empty houses', empty(), 'bro spouse', bro.spouseId, '(other id', other.id, ') sis spouse', sis.spouseId, 'homes', bro.homeId, sis.homeId, other.homeId);
}

/** Crop tiles harvested vs lost to frost (bot games). */
function frostProbe(): void {
  const seeds = (env.SEEDS ?? '11,22').split(',').map(Number);
  const out: any[] = [];
  for (const climate of (env.CLIMATES ?? 'mild,fair,harsh').split(',') as Climate[]) {
    for (const seed of seeds) {
      const g = Game.create({ seed, townName: 'F', mapSize: 'medium', terrain: 'valleys', climate, difficulty: 'medium', disasters: false });
      const bot = new QaBot(g);
      const prev = new Map<number, number[]>();
      const perYear: Record<number, { planted: number; harvested: number; frost: number; staff: number[] }> = {};
      for (let i = 0; i < (Number(env.YEARS ?? 5) * YEAR_SECONDS) / 0.25; i++) {
        g.step(0.25);
        bot.tick();
        const y = g.state.time.year;
        const e = (perYear[y] ??= { planted: 0, harvested: 0, frost: 0, staff: [] });
        const frosty = g.state.time.month >= 6 && g.state.weather.temperature < 0;
        for (const b of g.state.buildings) {
          if (b.type !== 'cropField' || !b.fieldTiles) continue;
          const now = b.fieldTiles.map((t) => t.stage);
          const was = prev.get(b.id);
          if (was && was.length === now.length) {
            for (let k = 0; k < now.length; k++) {
              if ((was[k] === 0 || was[k] === 1 || was[k] === 4) && now[k] === 2) e.planted++;
              if ((was[k] === 2 || was[k] === 3) && now[k] === 4) { if (frosty && was[k] !== 3) e.frost++; else if (frosty) e.frost++; else e.harvested++; }
            }
          }
          prev.set(b.id, now);
          if (g.state.time.month === 4 && g.state.time.monthProgress < 0.005) e.staff.push(+(b.workerIds.length / Math.ceil(b.w * b.h / 22)).toFixed(2));
        }
      }
      const row = { climate, seed, perYear };
      out.push(row);
      log(climate, seed, JSON.stringify(perYear));
    }
  }
  writeResult('probe_frost', out);
}

/** Deer population on the map and within hunting-cabin range, with venison produced per year (bot games). */
function deerProbe(): void {
  for (const seed of (env.SEEDS ?? '11,22,33').split(',').map(Number)) {
    const g = Game.create({ seed, townName: 'D', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false });
    const bot = new QaBot(g);
    const rows: string[] = [];
    for (let i = 0; i < (Number(env.YEARS ?? 6) * YEAR_SECONDS) / 0.25; i++) {
      g.step(0.25);
      bot.tick();
      const s = g.state;
      if (i % ((6 * MONTH_SECONDS) / 0.25) === 0) {
        const cabins = s.buildings.filter((b) => b.type === 'hunterCabin' && b.state === 'active');
        const inRange = s.animals.filter((a) => cabins.some((b) => Math.hypot(a.x - (b.x + b.w / 2), a.z - (b.z + b.h / 2)) <= 26)).length;
        const ven = cabins.reduce((n, b) => n + (b.producedThisYear.venison ?? 0), 0);
        const hunters = cabins.reduce((n, b) => n + b.workerIds.length, 0);
        rows.push(`y${s.time.year}m${s.time.month}: deer ${s.animals.length} inRange ${inRange} cabins ${cabins.length} hunters ${hunters} venisonThisYear ${Math.round(ven)}`);
      }
    }
    log(`seed ${seed}\n  ` + rows.join('\n  '));
  }
}

/** When does the first merchant / nomad group arrive after the post / hall is finished at a given time? */
function arrivalProbe(): void {
  for (const at of [1, 6, 24]) {
    const g = Game.create({ seed: 11, townName: 'A', mapSize: 'medium', terrain: 'lakes', climate: 'fair', difficulty: 'easy', disasters: false });
    g.addToStorage('wheat', 2000);
    const c = g.townCenter();
    let post: Building | null = null;
    let hall: Building | null = null;
    let tMer = -1;
    let tNom = -1;
    for (let i = 0; i < (4 * YEAR_SECONDS) / 0.25 && (tMer < 0 || tNom < 0); i++) {
      g.step(0.25);
      const month = g.state.time.elapsed / MONTH_SECONDS;
      if (!post && month >= at) {
        for (let r = 10; r <= 70 && !post; r += 10) post = place(g, 'tradingPost', c.x, c.z, { maxR: r });
        if (post) { complete(g, post); g.setWorkers(post.id, 1); g.setPriority(post.id, true); }
        hall = place(g, 'townHall', c.x, c.z, { maxR: 40 });
        if (hall) complete(g, hall);
      }
      if (post && tMer < 0 && g.state.trade.merchant) tMer = month;
      if (hall && tNom < 0 && g.state.nomads) tNom = month;
    }
    log(`built at month ${at}: post ${!!post} first merchant at month ${tMer.toFixed(1)} (delay ${(tMer - at).toFixed(1)}), hall ${!!hall} first nomads at month ${tNom.toFixed(1)} (delay ${(tNom - at).toFixed(1)})`);
  }
}

const p = env.PROBE ?? 'yield';
if (p === 'arrival') arrivalProbe();
else if (p === 'deer') deerProbe();
else if (p === 'frost') frostProbe();
else if (p === 'singles') singlesProbe();
else if (p === 'sibling') siblingProbe();
if (p === 'yield') yieldProbe();
else if (p === 'barn') barnProbe();
else if (p === 'coldhome') coldHomeProbe();
