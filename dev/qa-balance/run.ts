/**
 * QA CLI runner (bundled with rolldown, run with plain node for speed):
 *   npx rolldown dev/qa-balance/run.ts --format esm --platform node -o dev/qa-balance/build/run.mjs
 *   SET=matrix SHARD=0 NSHARD=8 node dev/qa-balance/build/run.mjs
 */
import type { Climate, Difficulty, TerrainStyle } from '../../src/core/types';
import type { Game } from '../../src/sim/game';
import { BUILDINGS } from '../../src/core/defs';
import { runGame, summaryLine, writeResult, type RunCfg } from './harness';

const env = process.env;
const TAG = env.TAG ?? '';

function cases(): RunCfg[] {
  const set = env.SET ?? 'matrix';
  const years = Number(env.YEARS ?? 10);
  const out: RunCfg[] = [];
  const seeds = (env.SEEDS ?? '11,22').split(',').map(Number);
  if (set === 'matrix') {
    const diffs = (env.DIFFS ?? 'easy,medium,hard').split(',') as Difficulty[];
    const climates = (env.CLIMATES ?? 'mild,fair,harsh').split(',') as Climate[];
    const terrains = (env.TERRAINS ?? 'valleys,lakes,mountains').split(',') as TerrainStyle[];
    for (const difficulty of diffs) for (const climate of climates) for (const terrain of terrains) for (const seed of seeds) {
      out.push({ name: `m${TAG}_${difficulty}_${climate}_${terrain}_${seed}`, difficulty, climate, terrain, seed, years });
    }
  } else if (set === 'neglect') {
    const diffs = (env.DIFFS ?? 'medium,hard').split(',') as Difficulty[];
    const which = env.WHICH ? env.WHICH.split(',') : null;
    for (const difficulty of diffs) {
      for (const seed of seeds) {
        const base = { difficulty, climate: (env.CLIMATE ?? 'fair') as Climate, terrain: 'valleys' as TerrainStyle, seed, years };
        const list: RunCfg[] = [
          { ...base, name: `base` },
          { ...base, name: `noWood`, bot: { noWoodcutter: true } },
          {
            ...base, name: `zeroWood`, bot: { noWoodcutter: true },
            init: (g: Game) => { g.takeFromStorage('firewood', 1e6); },
          },
          { ...base, name: `noFood`, bot: { neglectFood: true } },
          { ...base, name: `foodStopY3`, bot: { foodStopAt: 2 * 720 } },
          { ...base, name: `noHouseW1`, bot: { housesAfter: 12 * 60 } },
          { ...base, name: `minStaff`, bot: { minimalStaff: true } },
          { ...base, name: `noSmith`, bot: { noBlacksmith: true } },
          {
            ...base, name: `noTools`, bot: { noBlacksmith: true },
            init: (g: Game) => {
              g.takeFromStorage('tool', 1e6);
              for (const c of g.state.citizens) c.toolWear = 0;
            },
          },
          { ...base, name: `noTailor`, bot: { noTailor: true } },
          {
            ...base, name: `noCoats`, bot: { noTailor: true },
            init: (g: Game) => {
              g.takeFromStorage('woolCoat', 1e6);
              g.takeFromStorage('leatherCoat', 1e6);
              for (const c of g.state.citizens) c.coatWear = 0;
            },
          },
          { ...base, name: `noHealth`, bot: { noHealth: true } },
        ];
        for (const c of list) {
          if (which && !which.includes(c.name)) continue;
          c.name = `n${TAG}_${difficulty}_${base.climate}_${c.name}_${seed}`;
          out.push(c);
        }
      }
    }
  } else if (set === 'demog') {
    const diffs = (env.DIFFS ?? 'medium').split(',') as Difficulty[];
    const which = env.WHICH ? env.WHICH.split(',') : null;
    for (const difficulty of diffs) for (const seed of seeds) {
      const base = { difficulty, climate: (env.CLIMATE ?? 'fair') as Climate, terrain: 'valleys' as TerrainStyle, seed, years };
      const olderKids = (g: Game) => {
        // starting children spread over 4..15 instead of 0.5..9.5
        for (const c of g.state.citizens) if (c.age < 10) { c.age = 4 + ((c.id * 7919) % 1000) / 1000 * 11; c.bornAt = -c.age * 720; }
      };
      const list: RunCfg[] = [
        { ...base, name: 'base' },
        { ...base, name: 'olderKids', init: olderKids },
        { ...base, name: 'house6', init: () => { (BUILDINGS.woodenHouse as any).housing = 6; } },
        { ...base, name: 'hall', bot: { townHall: true } },
      ];
      for (const c of list) {
        if (which && !which.includes(c.name)) continue;
        c.name = `d${TAG}_${difficulty}_${c.name}_${seed}`;
        out.push(c);
      }
    }
  } else if (set === 'growth') {
    // emulate "young adults may move out alone into an empty family house" (Banished-like) with a per-step hook
    const moveAge = Number(env.MOVE_AGE ?? 10);
    const moveOut = (g: Game) => {
      const s = g.state;
      if (Math.floor(s.time.elapsed / 2) === Math.floor((s.time.elapsed - 0.25) / 2)) return;
      for (const h of s.buildings) {
        if (!BUILDINGS[h.type].familyHome || h.state !== 'active' || h.residentIds.length > 0) continue;
        let best: any = null;
        for (const c of s.citizens) {
          if (c.age < moveAge || c.spouseId >= 0 || c.homeId < 0) continue;
          const home = g.getBuilding(c.homeId);
          if (!home || !(home.residentIds.includes(c.motherId) || home.residentIds.includes(c.fatherId))) continue;
          if (!best || c.age > best.age) best = c;
        }
        if (!best) break;
        const old = g.getBuilding(best.homeId)!;
        old.residentIds = old.residentIds.filter((x: number) => x !== best.id);
        best.homeId = h.id;
        h.residentIds.push(best.id);
      }
    };
    const olderKids = (g: Game) => {
      for (const c of g.state.citizens) if (c.age < 10) { c.age = 4 + ((c.id * 7919) % 1000) / 1000 * 11; c.bornAt = -c.age * 720; }
    };
    for (const difficulty of (env.DIFFS ?? 'medium,hard').split(',') as Difficulty[]) for (const seed of seeds) {
      const base = { difficulty, climate: 'fair' as Climate, terrain: 'valleys' as TerrainStyle, seed, years };
      const list: RunCfg[] = [
        { ...base, name: 'moveOut', each: moveOut },
        { ...base, name: 'moveOutOlder', each: moveOut, init: olderKids },
      ];
      for (const c of list) { c.name = `g${TAG}_${difficulty}_${c.name}_${seed}`; out.push(c); }
    }
  } else if (set === 'hardfix') {
    const climates = (env.CLIMATES ?? 'mild,fair,harsh').split(',') as Climate[];
    for (const climate of climates) for (const seed of seeds) {
      const base = { difficulty: 'hard' as Difficulty, climate, terrain: 'valleys' as TerrainStyle, seed, years };
      const list: RunCfg[] = [
        { ...base, name: 'base' },
        { ...base, name: 'stone15', init: (g: Game) => { g.addToStorage('stone', 15); } },
        { ...base, name: 'food150', init: (g: Game) => { g.addToStorage('wheat', 75); g.addToStorage('roots', 75); } },
        { ...base, name: 'both', init: (g: Game) => { g.addToStorage('stone', 15); g.addToStorage('wheat', 75); g.addToStorage('roots', 75); } },
      ];
      for (const c of list) {
        c.name = `h${TAG}_${climate}_${c.name}_${seed}`;
        out.push(c);
      }
    }
  } else if (set === 'extras') {
    for (const seed of seeds) {
      out.push({ name: `x${TAG}_medium_hall_${seed}`, difficulty: 'medium', climate: 'fair', terrain: 'valleys', seed, years, bot: { townHall: true, tradingPost: true } });
    }
  }
  return out;
}

const all = cases();
const shard = Number(env.SHARD ?? 0);
const nshard = Number(env.NSHARD ?? 1);
const mine = all.filter((_, i) => i % nshard === shard);
const nomads = env.NOMADS;
process.stderr.write(`shard ${shard}/${nshard}: ${mine.length} runs\n`);
for (const cfg of mine) {
  if (nomads) {
    cfg.each = (g) => {
      if (g.state.nomads) g.respondToNomads(nomads === 'accept');
    };
  }
  const housing = BUILDINGS.woodenHouse.housing;
  const r = runGame(cfg);
  (BUILDINGS.woodenHouse as any).housing = housing;
  writeResult(cfg.name, r);
  process.stderr.write(summaryLine(r) + '\n');
}
