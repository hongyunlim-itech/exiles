/**
 * sim-core balance runner (dev only, not shipped): plays full 10-year games with the suite bot (tests/simcore.bot.ts)
 * and writes one JSON line per run. Bundle + run with plain node (fast, one process):
 *   npx rolldown -c dev/sim-core/rolldown.config.mjs
 *   SEEDS=11,22,33 DIFFS=easy,medium,hard OUT=<file> node dev/sim-core/build/balance.mjs
 * Options (env): CLIMATES, TERRAINS, YEARS, SHARD/NSHARD, SCENARIO (base | zeroWood | noWood | noHealth | noSmith).
 */
import { appendFileSync } from 'node:fs';
import { YEAR_SECONDS } from '../../src/core/constants';
import { BUILDINGS, FOOD_TYPES } from '../../src/core/defs';
import type { Climate, Difficulty, TerrainStyle } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { Bot } from '../../tests/simcore.bot';

const env = process.env;
const only = env.ONLY ? env.ONLY.split(',') : null;
const seeds = (env.SEEDS ?? '11,22,33').split(',').map(Number);
const diffs = (env.DIFFS ?? 'easy,medium,hard').split(',') as Difficulty[];
const climates = (env.CLIMATES ?? 'mild,fair,harsh').split(',') as Climate[];
const terrains = (env.TERRAINS ?? 'valleys,lakes,mountains').split(',') as TerrainStyle[];
const years = Number(env.YEARS ?? 10);
const scenario = env.SCENARIO ?? 'base';
const out = env.OUT ?? 'balance.jsonl';
const shard = Number(env.SHARD ?? 0);
const nshard = Number(env.NSHARD ?? 1);

interface Cfg { difficulty: Difficulty; climate: Climate; terrain: TerrainStyle; seed: number }
const cases: Cfg[] = [];
for (const difficulty of diffs) for (const climate of climates) for (const terrain of terrains) for (const seed of seeds) {
  cases.push({ difficulty, climate, terrain, seed });
}

function bufferFood(g: Game): number {
  let n = 0;
  for (const b of g.state.buildings) {
    if (BUILDINGS[b.type].storage) continue;
    for (const r of FOOD_TYPES) n += b.inventory[r] ?? 0;
  }
  return n;
}

function run(cfg: Cfg): unknown {
  const t0 = performance.now();
  const g = Game.create({ seed: cfg.seed, townName: 'Bal', mapSize: 'medium', terrain: cfg.terrain, climate: cfg.climate, difficulty: cfg.difficulty, disasters: true });
  if (scenario === 'zeroWood') {
    g.takeFromStorage('firewood', 1e6);
  }
  const bot = new Bot(g, { noWoodcutter: scenario === "zeroWood" || scenario === "noWood", noHealth: scenario === "noHealth", noSmith: scenario === "noSmith" });
  const s = g.state;
  const startPop = s.citizens.length;
  const popY: number[] = [startPop];
  const yearly: unknown[] = [];
  let maxStudents = 0;
  let stepMs = 0;
  let steps = 0;
  const total = Math.round((years * YEAR_SECONDS) / 0.25);
  let lastYear = 1;
  for (let i = 0; i < total && !s.gameOver; i++) {
    const a = performance.now();
    g.step(0.25);
    stepMs += performance.now() - a;
    steps++;
    bot.tick();
    if (i % 240 === 0) maxStudents = Math.max(maxStudents, s.citizens.filter((c) => c.profession === 'student').length);
    if (s.time.year !== lastYear) {
      lastYear = s.time.year;
      popY.push(s.citizens.length);
      const prod: Record<string, number> = {};
      const workers: Record<string, number> = {};
      for (const b of s.buildings) {
        for (const k in b.producedLastYear) prod[`${b.type}.${k}`] = Math.round((prod[`${b.type}.${k}`] ?? 0) + (b.producedLastYear as Record<string, number>)[k]);
        if (b.workerIds.length) workers[b.type] = (workers[b.type] ?? 0) + b.workerIds.length;
      }
      const tot = g.resourceTotals();
      const houses = s.buildings.filter((b) => BUILDINGS[b.type].familyHome && b.state === 'active');
      yearly.push({
        y: s.time.year - 1, pop: s.citizens.length, adults: s.citizens.filter((c) => c.age >= 10).length,
        kids: s.citizens.filter((c) => c.age < 10).length, homeless: s.citizens.filter((c) => c.homeId < 0).length,
        houses: houses.length, emptyHouses: houses.filter((h) => h.residentIds.length === 0).length,
        food: Math.round(g.foodTotal()), buf: Math.round(bufferFood(g)), firewood: Math.round(tot.firewood), tools: Math.round(tot.tool),
        noTool: s.citizens.filter((c) => c.age >= 10 && c.profession !== 'student' && c.toolWear <= 0).length,
        herbs: Math.round(tot.herbs), coats: Math.round(tot.woolCoat + tot.leatherCoat), deer: s.animals.length,
        venison: prod['hunterCabin.venison'] ?? 0, fish: prod['fishingDock.fish'] ?? 0, hunters: workers.hunterCabin ?? 0,
        fishers: workers.fishingDock ?? 0, smithTools: prod['blacksmith.tool'] ?? 0, logs: Math.round(tot.log), stone: Math.round(tot.stone),
        iron: Math.round(tot.iron), wood: prod['woodcutter.firewood'] ?? 0, herbsMade: prod['herbalist.herbs'] ?? 0, workers,
        builders: s.citizens.filter((c) => c.profession === 'builder').length, laborers: s.citizens.filter((c) => c.profession === 'laborer').length,
        deaths: { ...s.tally.deaths }, births: s.tally.births,
      });
    }
  }
  return {
    ...cfg, scenario, gameOver: s.gameOver, endYear: +(s.time.elapsed / YEAR_SECONDS).toFixed(2), startPop, popY,
    deaths: s.tally.deaths, births: s.tally.births, maxStudents, msPerStep: +(stepMs / Math.max(1, steps)).toFixed(3),
    ms: Math.round(performance.now() - t0), errors: g.moduleErrors(), placed: bot.placed, skipped: bot.skipped, yearly,
  };
}

const mine = cases.filter((c, i) => i % nshard === shard && (!only || only.includes(`${c.difficulty}/${c.climate}/${c.terrain}/${c.seed}`)));
for (const cfg of mine) {
  const r = run(cfg) as { popY: number[]; gameOver: boolean; deaths: unknown; ms: number };
  appendFileSync(out, JSON.stringify(r) + '\n');
  process.stderr.write(`${cfg.difficulty}/${cfg.climate}/${cfg.terrain}/${cfg.seed}: ${r.gameOver ? 'GAMEOVER ' : ''}pop ${r.popY.join(',')} deaths ${JSON.stringify(r.deaths)} ${r.ms}ms\n`);
}
