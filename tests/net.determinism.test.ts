/**
 * Determinism audit for lockstep co-op: Game.step must depend only on GameState + constant code. A game restored
 * from a snapshot (save → fromSave) at ANY tick must continue exactly like the original under the same command
 * stream (full-state comparison, not just the hash), and real-time driving (Game.update → rt.realTimeDriven) must not
 * change sim results.
 */
import { describe, expect, it } from 'vitest';
import { RESOURCES } from '../src/core/defs';
import type { NewGameSettings } from '../src/core/types';
import { Feature } from '../src/core/types';
import { applyCommand } from '../src/net/commands';
import type { Command } from '../src/net/types';
import { hashGameState } from '../src/net/hash';
import { NET_STEP } from '../src/net/types';
import { infectCitizen } from '../src/sim/ext/disease';
import { startFire } from '../src/sim/ext/fire';
import { spawnTornadoNow } from '../src/sim/ext/tornado';
import { Game } from '../src/sim/game';
import { summonNomads } from '../src/sim/nomads';
import { summonMerchant } from '../src/sim/trade';
import { forceBuild } from './simcore.fixtures';
import { Bot, type BotOptions } from './simcore.bot';
import { log, settings } from './simcore.helpers';
import { recordingProxy, stateDiff, type LoggedCommand } from './net.helpers';

/** A world event forced identically on every copy of the game at a tick (stands in for rare random events). */
interface Injection {
  tick: number;
  run: (g: Game) => void;
}

function applyAt(g: Game, cmds: LoggedCommand[], from: number, tick: number): number {
  let k = from;
  while (k < cmds.length && cmds[k].tick < tick) k++;
  while (k < cmds.length && cmds[k].tick === tick) applyCommand(g, cmds[k++].cmd);
  return k;
}

function injectAt(g: Game, inj: Injection[], tick: number): void {
  for (const i of inj) if (i.tick === tick) i.run(g);
}

/** The i-th building of a kind (by id order), or undefined. */
const nth = (g: Game, pred: (t: string) => boolean, i: number) => g.state.buildings.filter((b) => pred(b.type))[i];

const EVENTS: Injection[] = [
  // fires in houses and a workshop (spread, fire fighting, burn-down, ruins, salvage)
  { tick: 2100, run: (g) => { const b = nth(g, (t) => t === 'woodenHouse', 0); if (b) startFire(g, b, { cause: 'random' }); } },
  { tick: 2105, run: (g) => { const b = nth(g, (t) => t === 'woodenHouse', 2); if (b) startFire(g, b, { cause: 'random' }); } },
  { tick: 3300, run: (g) => { const b = nth(g, (t) => t === 'woodcutter', 0); if (b) startFire(g, b, { cause: 'random' }); } },
  // disease
  { tick: 2600, run: (g) => { for (const c of g.state.citizens.slice(0, 4)) infectCitizen(g, c, 0.5, { force: true }); } },
  // nomads (the bot accepts or declines through commands)
  { tick: 3000, run: (g) => void summonNomads(g, 6) },
  // tornado
  { tick: 4500, run: (g) => void spawnTornadoNow(g) },
];

/** A merchant at the trading post even when the town cannot staff it (identical on every copy of the game). */
function forceMerchant(g: Game): void {
  if (summonMerchant(g, 'general')) return;
  const post = g.state.buildings.find((b) => b.type === 'tradingPost' && b.state === 'active');
  if (!post || g.state.trade.merchant) return;
  g.state.trade.merchant = {
    id: g.newId(), kind: 'general', name: 'Test Trader', postId: post.id, leavesIn: 120, arrive: 0,
    offers: [{ kind: 'resource', id: 'wool', amount: 50, price: 4 }, { kind: 'livestock', id: 'sheep', amount: 1, price: 120 }],
  };
}

/** Late-game buildings forced into existence at once (trading post, pasture, services, industry). */
const LATE_GAME: Injection[] = [
  {
    tick: 1200,
    run: (g) => {
      for (const [type, w, h] of [['tradingPost'], ['pasture', 8, 8], ['tavern'], ['brewery'], ['market'], ['school'], ['hospital'], ['chapel'], ['mine'], ['orchard', 6, 6]] as const) {
        try {
          forceBuild(g, type, undefined, undefined, w, h);
        } catch {
          /* no spot on this map */
        }
      }
    },
  },
  { tick: 1500, run: (g) => forceMerchant(g) },
  { tick: 3200, run: (g) => void summonMerchant(g, 'livestock') },
];

/** Player actions for the late-game buildings (as logged commands): livestock choice, trades, merchant requests. */
function lateGameCommands(g: Game, tick: number): Command[] {
  const out: Command[] = [];
  if (tick === 1250) {
    const pasture = g.state.buildings.find((b) => b.type === 'pasture');
    if (pasture) out.push({ op: 'crop', id: pasture.id, choice: g.state.unlocked.livestock[0] ?? 'chicken' });
    for (const b of g.state.buildings) if (b.type === 'tradingPost' || b.type === 'tavern' || b.type === 'brewery') out.push({ op: 'workers', id: b.id, n: 1 });
  }
  if (tick === 1520 || tick === 3220) {
    const m = g.state.trade.merchant;
    if (m) {
      // the cheapest goods on offer, paid with logs (and once more with stone)
      let k = -1;
      m.offers.forEach((o, i) => {
        if (o.kind === 'resource' && o.amount >= 2 && (k < 0 || o.price < m.offers[k].price)) k = i;
      });
      if (k >= 0) {
        const price = m.offers[k].price * 2;
        out.push({ op: 'trade', give: { log: Math.ceil(price / RESOURCES.log.value) + 1 }, take: [{ offerIndex: k, amount: 2 }] });
        out.push({ op: 'trade', give: { stone: Math.ceil(price / RESOURCES.stone.value) + 1 }, take: [{ offerIndex: k, amount: 2 }] });
      }
    }
  }
  if (tick === 2000) out.push({ op: 'requestMerchant', kind: 'seeds' });
  return out;
}

interface Scenario {
  name: string;
  settings: Partial<NewGameSettings>;
  years: number;
  bot?: BotOptions;
  events?: Injection[];
  /** A large clearing order (> 400 marked tiles: the laborers' ring-search / sampling path) at this tick. */
  bigMarkAt?: number;
  /** Extra player commands per tick (logged and replayed like the bot's). */
  extra?: (g: Game, tick: number) => Command[];
}

function runScenario(sc: Scenario): void {
  const a = Game.create(settings({ ...sc.settings }));
  const cmds: LoggedCommand[] = [];
  let tick = 0;
  const bot = new Bot(recordingProxy(a, cmds, () => tick), sc.bot);
  const events = sc.events ?? [];
  let tradesSeen = 0;
  a.events.on('message', (m) => {
    if (m.text.startsWith('Traded')) tradesSeen++;
  });
  const total = Math.round((sc.years * 720) / NET_STEP);
  const every = 397; // restore points at irregular ticks (never aligned to the sim's internal phases)
  let b: Game | null = null;
  let bFrom = 0;
  let bCursor = 0;
  const problems: string[] = [];
  let maxMarked = 0;
  for (tick = 1; tick <= total; tick++) {
    a.step(NET_STEP);
    injectAt(a, events, tick);
    bot.tick();
    for (const cmd of sc.extra?.(a, tick) ?? []) {
      cmds.push({ tick, cmd });
      applyCommand(a, cmd);
    }
    if (sc.bigMarkAt === tick) {
      const s = a.state;
      // the densest 40x40 forest window away from the town
      const c = a.townCenter();
      let best = { x: 0, z: 0, n: -1 };
      for (let z = 2; z + 40 < s.H; z += 8) {
        for (let x = 2; x + 40 < s.W; x += 8) {
          if (Math.hypot(x + 20 - c.x, z + 20 - c.z) < 30) continue;
          let n = 0;
          for (let zz = z; zz < z + 40; zz += 2) for (let xx = x; xx < x + 40; xx += 2) if (s.tiles.feature[zz * s.W + xx] === Feature.Tree) n++;
          if (n > best.n) best = { x, z, n };
        }
      }
      const cmd = { op: 'mark' as const, x0: best.x, z0: best.z, x1: best.x + 39, z1: best.z + 39, filter: 'trees' as const };
      cmds.push({ tick, cmd });
      applyCommand(a, cmd);
    }
    maxMarked = Math.max(maxMarked, a.rt.marked.size);
    if (b) {
      b.step(NET_STEP);
      injectAt(b, events, tick);
      bCursor = applyAt(b, cmds, bCursor, tick);
    }
    if (tick % every === 0) {
      if (b) {
        const d = stateDiff(a, b);
        if (d) problems.push(`restored@${bFrom} diverged by ${tick}: ${d}`);
        else if (hashGameState(b) !== hashGameState(a)) problems.push(`restored@${bFrom}: equal states but different hashes at ${tick}`);
      }
      b = Game.fromSave(a.save());
      bFrom = tick;
      bCursor = cmds.length;
    }
    if (a.state.gameOver) break;
  }
  const t = a.state.tally;
  log(`[${sc.name}] ${tick - 1} ticks, ${cmds.length} commands, pop ${a.state.citizens.length}, buildings ${a.state.buildings.length}, ` +
    `births ${t.births}, deaths ${JSON.stringify(t.deaths)}, max marked ${maxMarked}, trades ${tradesSeen}, ` +
    `types ${[...new Set(a.state.buildings.map((b) => b.type))].length}, problems ${problems.length}`);
  for (const p of problems.slice(0, 10)) log('  ' + p);
  expect(problems).toEqual([]);
  expect(a.moduleErrors()).toEqual({});
}

describe('lockstep determinism (snapshot restored at any tick continues exactly)', () => {
  it('medium town with disasters, 3 years', () => {
    runScenario({ name: 'medium', settings: { seed: 777, difficulty: 'medium', disasters: true }, years: 3 });
  });

  it('easy start on a medium map, harsh climate, forced fires/disease/nomads/tornado, big clearing order', () => {
    runScenario({
      name: 'events', settings: { seed: 4321, difficulty: 'easy', mapSize: 'medium', climate: 'harsh', disasters: true },
      years: 2.5, events: EVENTS, bigMarkAt: 1500,
    });
  });

  it('late game: trading post & merchants & trades, pasture, services, mine, orchard (4 years, medium map)', () => {
    runScenario({
      name: 'late', settings: { seed: 2718, difficulty: 'easy', mapSize: 'medium', disasters: true }, years: 4, events: LATE_GAME,
      extra: lateGameCommands,
    });
  });

  it('famine: no food production (rationing, starvation) on a hard start', () => {
    runScenario({ name: 'famine', settings: { seed: 99, difficulty: 'hard', climate: 'harsh', disasters: true }, years: 2, bot: { neglectFood: true } });
  });

  it('real-time driving (Game.update) produces the same states as fixed steps', () => {
    const a = Game.create(settings({ seed: 31337, difficulty: 'medium', disasters: true }));
    const cmds: LoggedCommand[] = [];
    let tick = 0;
    const bot = new Bot(recordingProxy(a, cmds, () => tick));
    const c = Game.fromSave(a.save());
    c.speed = 5;
    let cursor = 0;
    for (tick = 1; tick <= 2400; tick++) {
      a.step(NET_STEP);
      bot.tick();
      c.update(0.05); // 0.05 s real × speed 5 = exactly one 0.25 s step, with rt.realTimeDriven set
      cursor = applyAt(c, cmds, cursor, tick);
    }
    expect(stateDiff(a, c)).toBe('');
  });
});
