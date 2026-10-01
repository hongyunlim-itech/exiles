/**
 * sim-ext regressions (review findings): first nomads / merchant timers, the food advisor counting workplace
 * buffers, cold homes, runtime state (advisor cooldowns, immunity) surviving save/load, the disease course
 * (herbs and hospitals decide the outcome, nobody stays ill forever), coats comfort in the cold only, unhappy
 * citizens work slower.
 */
import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import { collectNotices } from '../src/sim/ext/advisors';
import { infectCitizen } from '../src/sim/ext/disease';
import { computeHappinessFactors } from '../src/sim/ext/factors';
import { rt } from '../src/sim/ext/runtime';
import { MERCHANT_FIRST_DELAY, NOMAD_FIRST_DELAY } from '../src/sim/ext/tuning';
import { Game } from '../src/sim/game';
import { updateNomads } from '../src/sim/nomads';
import { updateTrade } from '../src/sim/trade';
import { updateWellbeing, wellbeingEfficiency } from '../src/sim/wellbeing';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function run(g: FakeGame, seconds: number, fn: (dt: number) => void, dt = 0.5): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    advanceTime(g, dt);
    fn(dt);
  }
}

describe('first arrivals', () => {
  it('the first nomads come NOMAD_FIRST_DELAY after a Town Hall opens (not after the initial 2-year timer)', () => {
    const g = createFakeGame();
    g.addCitizen();
    g.state.nextNomads = 2 * YEAR_SECONDS; // as set up by a new game
    run(g, MONTH_SECONDS, (dt) => updateNomads(g.asGame(), dt));
    expect(g.state.nomads).toBeNull();
    g.addBuilding('townHall', 20, 20);
    run(g, NOMAD_FIRST_DELAY + 2, (dt) => updateNomads(g.asGame(), dt));
    expect(g.state.nomads).not.toBeNull();
  });

  it('the first merchant comes MERCHANT_FIRST_DELAY after the trading post is staffed', () => {
    const g = createFakeGame();
    g.state.trade.nextArrival = 6 * MONTH_SECONDS;
    g.state.time.month = 3;
    run(g, 10, (dt) => updateTrade(g.asGame(), dt));
    const post = g.addBuilding('tradingPost', 20, 20);
    const trader = g.addCitizen({ profession: 'trader', workplaceId: post.id });
    post.workerIds.push(trader.id);
    run(g, MERCHANT_FIRST_DELAY + 2, (dt) => updateTrade(g.asGame(), dt));
    expect(g.state.trade.merchant).not.toBeNull();
  });
});

describe('advisors', () => {
  it('food waiting at workplaces counts: no "running low" warning while the huts hold months of food', () => {
    const g = createFakeGame();
    g.addBuilding('storageBarn', 5, 5, { inventory: { wheat: 5 } });
    g.addBuilding('gathererHut', 20, 5, { inventory: { berries: 400 } });
    for (let i = 0; i < 6; i++) g.addCitizen();
    const keys = collectNotices(g.asGame()).map((n) => n.key);
    expect(keys).not.toContain('food');
    expect(keys).toContain('foodStranded');
  });

  it('warns when homes have no firewood in the cold and the stockpile cannot refill them', () => {
    const g = createFakeGame();
    const house = g.addBuilding('woodenHouse', 20, 20);
    g.addCitizen({ homeId: house.id });
    house.residentIds.push(g.state.citizens[0].id);
    g.state.time.month = 10;
    g.state.weather.temperature = -5;
    expect(collectNotices(g.asGame()).some((n) => n.key === 'coldHomes')).toBe(true);
  });
});

describe('save / load keeps the sim-ext state', () => {
  it('advisor cooldowns and disease immunity survive a reload', () => {
    const g = Game.create({ seed: 5, townName: 'S', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false });
    for (let i = 0; i < 200; i++) g.step(0.25); // homeless families -> the "no home" advisor fires once
    const posted = g.state.messages.filter((m) => m.text.includes('no home')).length;
    expect(posted).toBe(1);
    const c = g.state.citizens[0];
    rt(g).immuneUntil.set(c.id, g.state.time.elapsed + YEAR_SECONDS);
    const h = Game.fromSave(g.save());
    expect(rt(h).immuneUntil.get(c.id)).toBe(rt(g).immuneUntil.get(c.id));
    for (let i = 0; i < 240; i++) h.step(0.25);
    expect(h.state.messages.filter((m) => m.text.includes('no home')).length).toBe(posted);
    expect(infectCitizen(h, h.getCitizen(c.id)!, 0.5)).toBe(false);
  });

  it('the rain/snow spell target is part of the saved weather', () => {
    const g = Game.create({ seed: 5, townName: 'S', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false });
    let guard = 0;
    while (g.state.weather.precipitation === 'none' && guard++ < 20000) g.step(0.25);
    expect(g.state.weather.precipTarget).toBeDefined();
    const h = Game.fromSave(g.save());
    expect(h.state.weather.precipTarget).toBe(g.state.weather.precipTarget);
  });
});

describe('disease', () => {
  function sickTown(opts: { herbs: boolean; health: number; dietMask: number; age?: number }) {
    const g = createFakeGame();
    const home = g.addBuilding('woodenHouse', 10, 10, { inventory: opts.herbs ? { herbs: 50 } : {} });
    const c = g.addCitizen({ homeId: home.id, health: opts.health, dietMask: opts.dietMask, age: opts.age ?? 30 });
    home.residentIds.push(c.id);
    infectCitizen(g.asGame(), c, 0.5, { force: true });
    return { g, c };
  }

  it('herbs at home cure an illness much faster; nobody stays ill forever', () => {
    const recoveredBy = (herbs: boolean): number => {
      const { g, c } = sickTown({ herbs, health: 85, dietMask: 7 });
      let t = 0;
      while (c.sick > 0 && t < 12 * MONTH_SECONDS && !g.killed.length) {
        advanceTime(g, 0.5);
        updateWellbeing(g.asGame(), 0.5);
        t += 0.5;
      }
      return c.sick > 0 || g.killed.length ? Infinity : t;
    };
    const withHerbs = recoveredBy(true);
    const without = recoveredBy(false);
    expect(withHerbs).toBeLessThan(2.5 * MONTH_SECONDS);
    expect(without).toBeLessThan(9 * MONTH_SECONDS);
    expect(without).toBeGreaterThan(withHerbs * 1.5);
  });

  it('untreated, the weak (poor diet, old) die of it; with herbs they pull through', () => {
    const outcome = (herbs: boolean): boolean => {
      const { g, c } = sickTown({ herbs, health: 50, dietMask: 1, age: 66 });
      run(g, 8 * MONTH_SECONDS, (dt) => updateWellbeing(g.asGame(), dt));
      return g.killed.some((k) => k.id === c.id && k.cause === 'disease');
    };
    expect(outcome(false)).toBe(true);
    expect(outcome(true)).toBe(false);
  });
});

describe('wellbeing', () => {
  it('a coat is a comfort in the cold season only', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ coatWear: 100 });
    const anchor = { x: c.x, z: c.z, home: null };
    g.state.time.month = 4;
    g.state.weather.temperature = 20;
    expect(computeHappinessFactors(g.state, c, anchor, 0).some((f) => f.label === 'Warm coat')).toBe(false);
    g.state.time.month = 10;
    g.state.weather.temperature = -3;
    expect(computeHappinessFactors(g.state, c, anchor, 0).some((f) => f.label === 'Warm coat')).toBe(true);
  });

  it('miserable citizens work noticeably slower', () => {
    const g = createFakeGame();
    const content = g.addCitizen({ happiness: 31, health: 80 });
    const miserable = g.addCitizen({ happiness: 29, health: 80 });
    expect(wellbeingEfficiency(miserable)).toBeLessThan(wellbeingEfficiency(content) * 0.8);
  });
});
