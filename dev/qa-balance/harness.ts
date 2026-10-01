/**
 * QA balance harness (scratch): run a full headless game with the QA bot, sample monthly metrics, activity
 * time-use, advisor messages with context, and write a JSON report.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { MONTH_SECONDS, YEAR_SECONDS, COLD_TEMP } from '../../src/core/constants';
import { BUILDINGS, FOOD_TYPES, RESOURCES } from '../../src/core/defs';
import type { Climate, Difficulty, NewGameSettings, TerrainStyle, ResourceType } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { QaBot, type QaBotOpts } from './qabot';

export interface RunCfg {
  name: string;
  difficulty: Difficulty;
  climate: Climate;
  terrain: TerrainStyle;
  seed: number;
  years: number;
  disasters?: boolean;
  mapSize?: 'small' | 'medium' | 'large';
  bot?: QaBotOpts | null;
  /** hook run every step */
  each?: (g: Game, bot: QaBot | null) => void;
  /** hook run once after creation */
  init?: (g: Game) => void;
  dt?: number;
}

const WORK_ACTS = new Set(['working', 'building', 'gathering', 'chopping', 'mining', 'farming', 'fishing', 'hunting', 'healing', 'praying']);

function bucket(act: string, taskLabel: string): string {
  if (act === 'walking' || act === 'hauling') {
    if (/^Idle/.test(taskLabel)) return 'idleWalk';
    return 'travel';
  }
  if (WORK_ACTS.has(act)) return 'work';
  if (act === 'idle') return 'idle';
  if (act === 'eating') return 'eat';
  if (act === 'warming') return 'warm';
  if (act === 'sick') return 'sick';
  if (act === 'firefighting') return 'fire';
  return act;
}

export function runGame(cfg: RunCfg): any {
  const settings: NewGameSettings = {
    seed: cfg.seed, townName: 'QA', mapSize: cfg.mapSize ?? 'medium', terrain: cfg.terrain, climate: cfg.climate,
    difficulty: cfg.difficulty, disasters: cfg.disasters ?? true,
  };
  const t0 = performance.now();
  const g = Game.create(settings);
  cfg.init?.(g);
  const bot = cfg.bot === null ? null : new QaBot(g, cfg.bot ?? {});
  const s = g.state;
  const dt = cfg.dt ?? 0.25;
  const months: any[] = [];
  const messages: any[] = [];
  const startPop = s.citizens.length;
  // activity accounting (adults 10+ non-students), per month
  let actAcc: Record<string, number> = {};
  let taskAcc: Record<string, number> = {};
  let profAct: Record<string, Record<string, number>> = {};
  let coldAcc = { adultSecCold: 0, adultSecWarmthLow: 0, adultSecFreezing: 0, houseSecNoWood: 0, houseSecCold: 0, homelessSec: 0, noToolWorkSec: 0, workSec: 0, coatlessColdOutdoorSec: 0, coldOutdoorSec: 0 };
  let tempMin = 99;
  let tempSum = 0;
  let tempN = 0;
  let deathsPrev: Record<string, number> = {};
  let birthsPrev = 0;
  let lastSampleKey = -1;
  let sampleTimer = 0;
  // loops/stuck tracker
  const stuck: Record<string, number> = {};
  const labelStart = new Map<number, { label: string; since: number }>();
  const unsub = g.events.on('message', (m) => {
    const pop = s.citizens.length;
    let houseFood = 0;
    for (const b of s.buildings) if (BUILDINGS[b.type].housing) for (const r of FOOD_TYPES) houseFood += b.inventory[r] ?? 0;
    let bufFood = 0;
    for (const b of s.buildings) if (!BUILDINGS[b.type].housing && !BUILDINGS[b.type].storage) for (const r of FOOD_TYPES) bufFood += b.inventory[r] ?? 0;
    messages.push({ t: +(s.time.elapsed / YEAR_SECONDS).toFixed(3), y: m.year, m: m.month, sev: m.severity, text: m.text, pop, storeFood: Math.round(g.foodTotal()), houseFood: Math.round(houseFood), bufFood: Math.round(bufFood), fw: Math.round(g.resourceTotals().firewood) });
  });
  const totalSteps = Math.round((cfg.years * YEAR_SECONDS) / dt);
  for (let i = 0; i < totalSteps && !s.gameOver; i++) {
    g.step(dt);
    bot?.tick();
    cfg.each?.(g, bot);
    sampleTimer += dt;
    if (sampleTimer >= 1) {
      sampleTimer -= 1;
      const temp = s.weather.temperature;
      tempMin = Math.min(tempMin, temp);
      tempSum += temp;
      tempN++;
      const cold = temp < COLD_TEMP;
      for (const c of s.citizens) {
        if (c.age < 10 || c.profession === 'student') continue;
        const k = bucket(c.activity, c.taskLabel);
        actAcc[k] = (actAcc[k] ?? 0) + 1;
        const pa = (profAct[c.profession] ??= {});
        pa[k] = (pa[k] ?? 0) + 1;
        const tl = c.taskLabel.replace(/ (in|at|to|from|for) (the )?.*$/, '');
        taskAcc[tl] = (taskAcc[tl] ?? 0) + 1;
        if (cold) {
          coldAcc.adultSecCold++;
          if (c.warmth < 30) coldAcc.adultSecWarmthLow++;
          if (c.warmth <= 0.5) coldAcc.adultSecFreezing++;
          const outdoors = !['warming', 'eating', 'sick', 'studying', 'working', 'healing', 'praying'].includes(c.activity);
          if (outdoors) {
            coldAcc.coldOutdoorSec++;
            if (c.coatWear <= 0) coldAcc.coatlessColdOutdoorSec++;
          }
        }
        if (c.homeId < 0) coldAcc.homelessSec++;
        if (WORK_ACTS.has(c.activity)) {
          coldAcc.workSec++;
          if (c.toolWear <= 0) coldAcc.noToolWorkSec++;
        }
        // stuck: same non-idle label for > 150 s
        const ls = labelStart.get(c.id);
        if (!ls || ls.label !== c.taskLabel) labelStart.set(c.id, { label: c.taskLabel, since: s.time.elapsed });
        else if (s.time.elapsed - ls.since > 150 && !/^Idle|Playing|Studying|Resting/.test(c.taskLabel)) {
          const key = `${c.profession}:${c.taskLabel.replace(/\d+/g, '#')}`;
          stuck[key] = (stuck[key] ?? 0) + 1;
          ls.since = s.time.elapsed; // count once per 150 s
        }
      }
      if (cold) {
        for (const b of s.buildings) {
          if (!BUILDINGS[b.type].housing || b.state !== 'active' || b.residentIds.length === 0) continue;
          coldAcc.houseSecCold++;
          if ((b.inventory.firewood ?? 0) <= 0.01) coldAcc.houseSecNoWood++;
        }
      }
    }
    const key = s.time.year * 12 + s.time.month;
    if (key !== lastSampleKey) {
      lastSampleKey = key;
      const mo = sample(g, actAcc, taskAcc, coldAcc, deathsPrev, birthsPrev, tempMin, tempN ? tempSum / tempN : 0);
      mo.profAct = profAct;
      profAct = {};
      months.push(mo);
      deathsPrev = { ...s.tally.deaths } as Record<string, number>;
      birthsPrev = s.tally.births;
      actAcc = {};
      taskAcc = {};
      coldAcc = { adultSecCold: 0, adultSecWarmthLow: 0, adultSecFreezing: 0, houseSecNoWood: 0, houseSecCold: 0, homelessSec: 0, noToolWorkSec: 0, workSec: 0, coatlessColdOutdoorSec: 0, coldOutdoorSec: 0 };
      tempMin = 99;
      tempSum = 0;
      tempN = 0;
    }
  }
  unsub();
  months.push(sample(g, actAcc, taskAcc, coldAcc, deathsPrev, birthsPrev, tempMin, tempN ? tempSum / tempN : 0));
  const prod: Record<string, Record<string, number>> = {};
  for (const b of s.buildings) {
    for (const k in b.producedLastYear) {
      (prod[b.type] ??= {})[k] = Math.round(((prod[b.type] ??= {})[k] ?? 0) + (b.producedLastYear as any)[k]);
    }
  }
  const out = {
    cfg: { ...cfg, each: undefined, init: undefined },
    ms: Math.round(performance.now() - t0),
    startPop,
    gameOver: s.gameOver,
    endYear: +(s.time.elapsed / YEAR_SECONDS).toFixed(2),
    deaths: s.tally.deaths,
    births: s.tally.births,
    placed: bot?.placed ?? [],
    skipped: bot?.skipped ?? [],
    prodLastYear: prod,
    buildings: summarizeBuildings(g),
    moduleErrors: g.moduleErrors(),
    stuck,
    months,
    messages,
  };
  return out;
}

function summarizeBuildings(g: Game): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of g.state.buildings) {
    const k = `${b.type}${b.state === 'active' ? '' : ':' + b.state}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function sample(g: Game, act: Record<string, number>, tasks: Record<string, number>, cold: any, deathsPrev: Record<string, number>, birthsPrev: number, tempMin: number, tempAvg: number): any {
  const s = g.state;
  const cs = s.citizens;
  let adults = 0, kids = 0, students = 0, elderly = 0, a10to15 = 0, single16 = 0, couples = 0, homeless = 0, sick = 0;
  let health = 0, happy = 0, warmthMin = 100, lowWarm = 0, noTool = 0, noCoat = 0, laborers = 0, builders = 0, fertileCouples = 0;
  let livingWithParents16 = 0;
  const profs: Record<string, number> = {};
  for (const c of cs) {
    health += c.health;
    happy += c.happiness;
    if (c.sick > 0) sick++;
    if (c.homeId < 0) homeless++;
    warmthMin = Math.min(warmthMin, c.warmth);
    if (c.warmth < 30) lowWarm++;
    if (c.age < 10) { kids++; continue; }
    if (c.profession === 'student') { students++; continue; }
    adults++;
    if (c.age >= 60) elderly++;
    profs[c.profession] = (profs[c.profession] ?? 0) + 1;
    if (c.profession === 'laborer') laborers++;
    if (c.profession === 'builder') builders++;
    if (c.toolWear <= 0) noTool++;
    if (c.coatWear <= 0) noCoat++;
    if (c.age < 16) a10to15++;
    if (c.spouseId < 0 && c.age >= 16) single16++;
    if (c.spouseId >= 0 && c.gender === 'F') {
      couples++;
      if (c.age >= 16 && c.age <= 45) fertileCouples++;
    }
    if (c.spouseId < 0 && c.homeId >= 0) {
      const h = g.getBuilding(c.homeId);
      if (h && (h.residentIds.includes(c.motherId) || h.residentIds.includes(c.fatherId))) livingWithParents16++;
    }
  }
  let houses = 0, emptyHouses = 0, houseFood = 0, houseFw = 0, bufFood = 0, housesFull = 0;
  for (const b of s.buildings) {
    const def = BUILDINGS[b.type];
    if (def.housing && b.state === 'active') {
      houses++;
      if (b.residentIds.length === 0) emptyHouses++;
      if (b.residentIds.length >= (def.housing ?? 5)) housesFull++;
      for (const r of FOOD_TYPES) houseFood += b.inventory[r] ?? 0;
      houseFw += b.inventory.firewood ?? 0;
    } else if (!def.storage) {
      for (const r of FOOD_TYPES) bufFood += b.inventory[r] ?? 0;
    }
  }
  const wk: Record<string, number> = {};
  for (const b of s.buildings) if (b.workerIds.length) wk[b.type] = (wk[b.type] ?? 0) + b.workerIds.length;
  let prodY: Record<string, Record<string, number>> | undefined;
  if (s.time.month === 0) {
    prodY = {};
    for (const b of s.buildings) for (const k in b.producedLastYear) { const t = (prodY[b.type] ??= {}); t[k] = Math.round((t[k] ?? 0) + (b.producedLastYear as any)[k]); }
  }
  const tot = g.resourceTotals();
  const foodByGroup: Record<string, number> = {};
  for (const r of FOOD_TYPES) {
    const grp = RESOURCES[r].foodGroup!;
    foodByGroup[grp] = Math.round((foodByGroup[grp] ?? 0) + tot[r]);
  }
  const deaths: Record<string, number> = {};
  for (const k in s.tally.deaths) {
    const d = ((s.tally.deaths as any)[k] ?? 0) - (deathsPrev[k] ?? 0);
    if (d) deaths[k] = d;
  }
  const n = Math.max(1, cs.length);
  const r = (x: number) => Math.round(x);
  return {
    y: s.time.year, m: s.time.month, pop: cs.length, adults, kids, students, elderly, a10to15, single16, livingWithParents16, couples, fertileCouples,
    homeless, sick, houses, emptyHouses, housesFull,
    food: r(g.foodTotal()), houseFood: r(houseFood), bufFood: r(bufFood), foodByGroup,
    firewood: r(tot.firewood), houseFw: r(houseFw), logs: r(tot.log), stone: r(tot.stone), iron: r(tot.iron), tools: r(tot.tool),
    coats: r(tot.woolCoat + tot.leatherCoat), herbs: r(tot.herbs), leather: r(tot.leather), wool: r(tot.wool),
    health: r(health / n), happy: r(happy / n), warmthMin: r(warmthMin), lowWarm, noTool, noCoat, laborers, builders, profs,
    births: s.tally.births - birthsPrev, deaths,
    wk, prodY, profAct: undefined, act, tasks, cold, tempMin: +tempMin.toFixed(1), tempAvg: +tempAvg.toFixed(1),
  };
}

export function writeResult(name: string, data: unknown): void {
  mkdirSync('dev/qa-balance/out', { recursive: true });
  writeFileSync(`dev/qa-balance/out/${name}.json`, JSON.stringify(data));
}

export function summaryLine(r: any): string {
  const ys: string[] = [];
  for (const m of r.months) if (m.m === 0) ys.push(`${m.pop}`);
  const d = r.deaths;
  return `${r.cfg.name}: ${r.gameOver ? 'GAMEOVER@' + r.endYear : 'ok'} pop[y1..]=${ys.join(',')} deaths=${JSON.stringify(d)} births=${r.births} ms=${r.ms}`;
}

export { MONTH_SECONDS, YEAR_SECONDS };
export type { ResourceType };
