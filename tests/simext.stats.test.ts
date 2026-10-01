import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS } from '../src/core/constants';
import { coldMonthsAhead } from '../src/sim/ext/advisors';
import { collectNotices, updateStats } from '../src/sim/stats';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function run(g: FakeGame, seconds: number, dt = 0.5): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    advanceTime(g, dt);
    updateStats(g.asGame(), dt);
  }
}

describe('history samples', () => {
  it('records an initial sample and one per month, resetting monthly tallies', () => {
    const g = createFakeGame();
    g.addBuilding('storageBarn', 5, 5, { inventory: { wheat: 100, berries: 50, tool: 7, woolCoat: 2, leatherCoat: 3 } });
    g.addBuilding('stockpile', 12, 5, { inventory: { log: 40, firewood: 20 } });
    g.addCitizen({ age: 30, health: 80, happiness: 60, education: 0.5 });
    g.addCitizen({ age: 5, health: 60, happiness: 40 });
    g.addCitizen({ age: 12, profession: 'student', education: 0.25 });
    g.addCitizen({ age: 65 });
    updateStats(g.asGame(), 0);
    expect(g.state.history).toHaveLength(1);
    const s0 = g.state.history[0];
    expect(s0).toMatchObject({ year: 1, month: 0, population: 4, adults: 1, children: 1, students: 1, elderly: 1, food: 150, logs: 40, firewood: 20, tools: 7, clothing: 5 });
    expect(s0.avgEducation).toBeCloseTo((0.5 + 0.25 + 0) / 3, 2);

    g.state.tally.monthBirths = 2;
    g.state.tally.monthDeaths = 1;
    run(g, MONTH_SECONDS - 1);
    expect(g.state.history).toHaveLength(1);
    run(g, 2);
    expect(g.state.history).toHaveLength(2);
    expect(g.state.history[1]).toMatchObject({ month: 1, births: 2, deaths: 1 });
    expect(g.state.tally.monthBirths).toBe(0);
    expect(g.state.tally.monthDeaths).toBe(0);
  });

  it('caps history at 600 samples', () => {
    const g = createFakeGame();
    g.addCitizen();
    for (let i = 0; i < 620; i++) {
      advanceTime(g, MONTH_SECONDS);
      updateStats(g.asGame(), 0);
    }
    expect(g.state.history.length).toBe(600);
    const last = g.state.history.at(-1)!;
    expect(last.year * 12 + last.month).toBe(g.state.time.year * 12 + g.state.time.month);
  });
});

describe('advisors', () => {
  it('warns about low food, homelessness, missing tools and unburied dead', () => {
    const g = createFakeGame();
    g.addBuilding('storageBarn', 5, 5, { inventory: { wheat: 10 } });
    for (let i = 0; i < 6; i++) g.addCitizen({ homeId: -1, toolWear: 0 });
    g.state.unburied = 1;
    const keys = collectNotices(g.asGame()).map((n) => n.key);
    expect(keys).toEqual(expect.arrayContaining(['food', 'homeless', 'tools', 'graves']));
  });

  it('flags starvation as danger with a citizen target', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ food: 0 });
    const n = collectNotices(g.asGame()).find((x) => x.key === 'starving')!;
    expect(n.severity).toBe('danger');
    expect(n.target).toEqual({ kind: 'citizen', id: c.id });
  });

  it('reports stalled construction (no builders, then missing materials)', () => {
    const g = createFakeGame();
    g.addBuilding('stockpile', 5, 5, { inventory: { log: 5 } });
    const site = g.addBuilding('woodenHouse', 20, 20, { state: 'construction', progress: 0 });
    g.addCitizen({ profession: 'laborer' });
    expect(collectNotices(g.asGame()).find((n) => n.key === 'builders')?.target).toEqual({ kind: 'building', id: site.id });
    g.addCitizen({ profession: 'builder' });
    const m = collectNotices(g.asGame()).find((n) => n.key === 'materials');
    expect(m?.text).toMatch(/Wooden House/);
  });

  it('warns about firewood before winter only', () => {
    const g = createFakeGame();
    const house = g.addBuilding('woodenHouse', 20, 20);
    g.addCitizen({ homeId: house.id });
    g.state.time.month = 4; // summer
    expect(collectNotices(g.asGame()).some((n) => n.key === 'firewood')).toBe(false);
    g.state.time.month = 7; // autumn, cold ahead
    expect(collectNotices(g.asGame()).some((n) => n.key === 'firewood')).toBe(true);
  });

  it('posts advisor messages at most once per cooldown', () => {
    const g = createFakeGame();
    g.addBuilding('storageBarn', 5, 5, { inventory: { wheat: 10 } });
    for (let i = 0; i < 5; i++) g.addCitizen({ homeId: -1 });
    run(g, 60);
    const count = () => g.state.messages.filter((m) => m.text.includes('no home')).length;
    expect(count()).toBe(1);
    run(g, MONTH_SECONDS);
    expect(count()).toBe(1);
    run(g, MONTH_SECONDS + 10);
    expect(count()).toBe(2);
  });

  it('counts cold months ahead by climate', () => {
    const g = createFakeGame();
    g.state.time.month = 7;
    const fair = coldMonthsAhead(g.state);
    g.state.settings.climate = 'harsh';
    const harsh = coldMonthsAhead(g.state);
    g.state.settings.climate = 'mild';
    const mild = coldMonthsAhead(g.state);
    expect(harsh).toBeGreaterThan(fair);
    expect(mild).toBeLessThan(fair);
    g.state.settings.climate = 'fair';
    g.state.time.month = 3;
    expect(coldMonthsAhead(g.state)).toBe(0);
  });
});
