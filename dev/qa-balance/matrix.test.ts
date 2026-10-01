/** QA matrix: difficulties x climates x terrains x seeds with the QA bot, sharded via env SHARD/NSHARD/SET. */
import { it } from 'vitest';
import { YEAR_SECONDS } from '../../src/core/constants';
import type { Climate, Difficulty, TerrainStyle } from '../../src/core/types';
import { runGame, summaryLine, writeResult, type RunCfg } from './harness';

function cases(): RunCfg[] {
  const set = process.env.SET ?? 'matrix';
  const years = Number(process.env.YEARS ?? 10);
  const out: RunCfg[] = [];
  if (set === 'matrix') {
    const seeds = (process.env.SEEDS ?? '11,22').split(',').map(Number);
    for (const difficulty of ['easy', 'medium', 'hard'] as Difficulty[]) {
      for (const climate of ['mild', 'fair', 'harsh'] as Climate[]) {
        for (const terrain of ['valleys', 'lakes', 'mountains'] as TerrainStyle[]) {
          for (const seed of seeds) out.push({ name: `m_${difficulty}_${climate}_${terrain}_${seed}`, difficulty, climate, terrain, seed, years });
        }
      }
    }
  } else if (set === 'neglect') {
    const seeds = (process.env.SEEDS ?? '11,22,33').split(',').map(Number);
    for (const difficulty of ['medium', 'hard'] as Difficulty[]) {
      for (const seed of seeds) {
        const base = { difficulty, climate: 'fair' as Climate, terrain: 'valleys' as TerrainStyle, seed, years: Math.min(years, 6) };
        out.push({ ...base, name: `n_${difficulty}_base_${seed}` });
        out.push({ ...base, name: `n_${difficulty}_noWood_${seed}`, bot: { noWoodcutter: true } });
        out.push({ ...base, name: `n_${difficulty}_noFood_${seed}`, bot: { neglectFood: true } });
        out.push({ ...base, name: `n_${difficulty}_noHouseW1_${seed}`, bot: { housesAfter: 11 * 60 + 30 } });
        out.push({ ...base, name: `n_${difficulty}_minStaff_${seed}`, bot: { minimalStaff: true } });
        out.push({ ...base, name: `n_${difficulty}_noSmith_${seed}`, bot: { noBlacksmith: true } });
        out.push({ ...base, name: `n_${difficulty}_noTailor_${seed}`, bot: { noTailor: true } });
        out.push({ ...base, name: `n_${difficulty}_noHealth_${seed}`, bot: { noHealth: true } });
        out.push({ ...base, name: `n_${difficulty}_harshNoWood_${seed}`, climate: 'harsh', bot: { noWoodcutter: true } });
        out.push({
          ...base, name: `n_${difficulty}_noTools_${seed}`, bot: { noBlacksmith: true },
          init: (g) => {
            g.takeFromStorage('tool', 1e6);
            for (const c of g.state.citizens) c.toolWear = 0;
          },
        });
        out.push({
          ...base, name: `n_${difficulty}_zeroWood_${seed}`, bot: { noWoodcutter: true },
          init: (g) => { g.takeFromStorage('firewood', 1e6); },
        });
      }
    }
  } else if (set === 'extras') {
    const seeds = (process.env.SEEDS ?? '11,22,33').split(',').map(Number);
    for (const seed of seeds) {
      out.push({ name: `x_medium_hall_${seed}`, difficulty: 'medium', climate: 'fair', terrain: 'valleys', seed, years, bot: { townHall: true, tradingPost: true } });
      out.push({ name: `x_medium_nodis_${seed}`, difficulty: 'medium', climate: 'fair', terrain: 'valleys', seed, years, disasters: false });
    }
  }
  return out;
}

const all = cases();
const shard = Number(process.env.SHARD ?? 0);
const nshard = Number(process.env.NSHARD ?? 1);
const mine = all.filter((_, i) => i % nshard === shard);
const nomads = process.env.NOMADS; // 'accept' | 'decline'

it(`qa ${process.env.SET ?? 'matrix'} shard ${shard}/${nshard} (${mine.length} runs)`, () => {
  for (const cfg of mine) {
    if (nomads) {
      cfg.each = (g) => {
        if (g.state.nomads) g.respondToNomads(nomads === 'accept');
      };
    }
    const r = runGame(cfg);
    writeResult(cfg.name, r);
    process.stderr.write(summaryLine(r) + '\n');
  }
  void YEAR_SECONDS;
});
