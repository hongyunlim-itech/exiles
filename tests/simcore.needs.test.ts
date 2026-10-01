/**
 * Needs & behaviour regressions (review findings): the cold-interrupt livelock, the zero-progress deposit loop,
 * dangerous winters (a cold hearth does not keep anyone safe), sick people resting in the open get cold, rationing,
 * long crafting steps vs the task watchdog, tools wearing out during work trips.
 */
import { describe, expect, it } from 'vitest';
import { COLD_TEMP, MONTH_SECONDS, TOOL_LIFETIME } from '../src/core/constants';
import { coldHomeLevel } from '../src/sim/core/citizens';
import { mealUnits, RATION_FILL } from '../src/sim/core/diet';
import { updateHousing } from '../src/sim/core/households';
import { brainOf, mkTask } from '../src/sim/core/tasks';
import { couple, emptyTown, fixtureSettings, forceBuild, Game, holdMonth, spawnAt, steps } from './simcore.fixtures';

describe('cold weather', () => {
  it('firewood reaches every home even when everybody is cold (no interrupt livelock)', () => {
    const g = Game.create(fixtureSettings({ climate: 'harsh', seed: 777 }));
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    updateHousing(g);
    holdMonth(g, 10);
    for (const h of houses) delete h.inventory.firewood;
    for (const c of g.state.citizens) {
      c.warmth = 18;
      c.coatWear = 0;
      c.food = 90;
    }
    steps(g, 200, 0.25, () => holdMonth(g, 10));
    // every household got firewood from the stockpile (before the fix, cold fetchers were interrupted every 12 s
    // while carrying it, re-deposited it in the stockpile and some homes never got any)
    const occupied = houses.filter((h) => h.residentIds.length > 0);
    expect(occupied.length).toBeGreaterThan(3);
    for (const h of occupied) expect(h.inventory.firewood ?? 0).toBeGreaterThan(0);
    // ...and warmed their people up again
    const adults = g.state.citizens.filter((c) => c.age >= 16);
    expect(adults.filter((c) => c.warmth > 50).length).toBeGreaterThan(adults.length * 0.7);
  });

  it('an unheated home cannot keep its residents from freezing in a hard winter; a heated one can', () => {
    const run = (firewood: boolean): { freezing: number; minWarmth: number } => {
      const g = Game.create(fixtureSettings({ climate: 'harsh', seed: 99 }));
      emptyTown(g);
      g.takeFromStorage('firewood', 1e6);
      g.takeFromStorage('woolCoat', 1e6);
      g.takeFromStorage('leatherCoat', 1e6);
      const home = forceBuild(g, 'woodenHouse');
      const [f, m] = couple(g, home);
      spawnAt(g, home, { age: 4, gender: 'F', motherId: m.id, fatherId: f.id });
      for (const c of g.state.citizens) c.coatWear = 0;
      if (firewood) {
        home.inventory.firewood = 30;
        g.addToStorage('firewood', 400);
      }
      holdMonth(g, 10);
      let minWarmth = 100;
      steps(g, 3 * MONTH_SECONDS, 0.25, () => {
        holdMonth(g, 10);
        for (const c of g.state.citizens) minWarmth = Math.min(minWarmth, c.warmth);
      });
      return { freezing: g.state.tally.deaths.freezing ?? 0, minWarmth };
    };
    const cold = run(false);
    const warm = run(true);
    expect(cold.freezing).toBeGreaterThan(0);
    expect(warm.freezing).toBe(0);
    expect(warm.minWarmth).toBeGreaterThan(5);
  });

  it('a cold hearth offers no warmth below about -3 C', () => {
    expect(coldHomeLevel(-5)).toBe(0);
    expect(coldHomeLevel(COLD_TEMP)).toBeGreaterThan(20);
  });

  it('a sick citizen resting in the open (no home) still gets cold', () => {
    const g = Game.create(fixtureSettings({ climate: 'harsh' }));
    emptyTown(g);
    const c = spawnAt(g, null, { age: 30, gender: 'M' });
    c.sick = 0.8;
    c.warmth = 60;
    c.coatWear = 0;
    holdMonth(g, 10);
    steps(g, 25, 0.25, () => {
      holdMonth(g, 10);
      c.sick = 0.8;
    });
    expect(c.warmth).toBeLessThan(50);
  });
});

describe('carried goods', () => {
  it('a hungry carrier with barns and home full eats instead of looping deposit trips', () => {
    const g = Game.create(fixtureSettings({ seed: 4242 }));
    const s = g.state;
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    updateHousing(g);
    const home = houses[0];
    const c = home.residentIds.map((id) => g.getCitizen(id)!).find((x) => x.age >= 16)!;
    for (const b of s.buildings) if (b.type === 'storageBarn') b.inventory.wheat = (b.inventory.wheat ?? 0) + 4000;
    home.inventory = { beans: 90, firewood: 30 };
    g.abortTask(c);
    c.carrying = { type: 'berries', amount: 12 };
    c.food = 20;
    let minFood = 100;
    let depositPlans = 0;
    let last: unknown = null;
    steps(g, 120, 0.25, () => {
      home.inventory.beans = 90;
      home.inventory.firewood = 30;
      const t = brainOf(c).cur;
      if (t && t !== last && t.kind === 'deposit') depositPlans++;
      last = t;
      if (g.getCitizen(c.id)) minFood = Math.min(minFood, c.food);
    });
    expect(g.getCitizen(c.id)).toBeTruthy();
    expect(minFood).toBeGreaterThan(5);
    expect(depositPlans).toBeLessThan(40);
  });
});

describe('food shortage', () => {
  it('meals are rationed while food is short', () => {
    const g = Game.create(fixtureSettings());
    const c = g.state.citizens[0];
    c.food = 10;
    expect(mealUnits(c, true)).toBeLessThan(mealUnits(c, false));
    c.food = RATION_FILL + 1;
    expect(mealUnits(c, true)).toBe(1);
  });

  it('starvation is gradual: a healthy citizen survives 1.5 months without food', () => {
    const g = Game.create(fixtureSettings());
    emptyTown(g);
    const c = spawnAt(g, null, { age: 30, gender: 'M' });
    for (const b of g.state.buildings) b.inventory = {};
    c.food = 0;
    c.health = 90;
    steps(g, 1.5 * MONTH_SECONDS, 0.25, () => {
      c.food = 0;
    });
    expect(g.getCitizen(c.id)).toBeTruthy();
  });
});

describe('work', () => {
  it('an elderly smith without a tool still finishes batches (long steps are not killed by the watchdog)', () => {
    const g = Game.create(fixtureSettings());
    const smith = forceBuild(g, 'blacksmith');
    g.takeFromStorage('tool', 1e9);
    g.addToStorage('iron', 50);
    g.setWorkers(smith.id, 1);
    let worker: ReturnType<typeof g.getCitizen>;
    steps(g, 900, 0.25, () => {
      if (!worker && smith.workerIds.length > 0) {
        worker = g.getCitizen(smith.workerIds[0]);
        if (worker) {
          worker.age = 62;
          worker.lifespan = 90;
        }
      }
      if (worker) {
        worker.happiness = 45;
        worker.toolWear = 0;
      }
    });
    expect((smith.producedThisYear.tool ?? 0) + (smith.producedLastYear.tool ?? 0)).toBeGreaterThan(0);
  });

  it('tools wear while walking and hauling for the job, not only while working', () => {
    const g = Game.create(fixtureSettings());
    emptyTown(g);
    const c = spawnAt(g, null, { age: 30, gender: 'M' });
    c.toolWear = TOOL_LIFETIME;
    const t = mkTask('haul', 'Hauling', [{ op: 'wait', t: 50, act: 'hauling' }]);
    brainOf(c).cur = t;
    c.activity = 'hauling';
    const before = c.toolWear;
    for (let i = 0; i < 40; i++) {
      g.step(0.25);
      c.activity = 'hauling';
    }
    expect(c.toolWear).toBeLessThan(before - 5);
  });
});
