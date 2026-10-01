/**
 * Hunger regressions from browser testing:
 *  (a) citizens let their satiation reach 0 while finishing long hauls although the barn was full — hungry workers
 *      must interrupt non-urgent work in time to reach food (distance-aware), and eat where food is nearest;
 *  (b) the "people are starving — put more workers on food" advisor fired with 1,600+ food in the barn — it may only
 *      blame food production when town food is actually short.
 */
import { describe, expect, it } from 'vitest';
import { brainOf } from '../src/sim/core/tasks';
import { collectNotices } from '../src/sim/ext/advisors';
import { Bot } from './simcore.bot';
import { log, settings } from './simcore.helpers';
import { emptyTown, fixtureSettings, forceBuild, Game, spawnAt } from './simcore.fixtures';

/** A town whose only barn (full of food) sits far from a construction site that needs lots of materials. */
function farHaulTown(): { g: Game; carriers: number[] } {
  const g = Game.create(fixtureSettings({ seed: 4242, difficulty: 'easy' }));
  emptyTown(g);
  const c = g.townCenter();
  const s = g.state;
  // the far site: the farthest reachable spot ~45-60 tiles from the centre
  let site = null;
  for (const [dx, dz] of [[55, 0], [-55, 0], [0, 55], [0, -55], [45, 45], [-45, -45], [45, -45], [-45, 45]] as const) {
    const x = Math.floor(c.x + dx);
    const z = Math.floor(c.z + dz);
    if (x < 4 || z < 4 || x > s.W - 8 || z > s.H - 8) continue;
    const b = g.placeBuilding('stoneHouse', x, z, 0);
    if (b && g.sameRegionSafe(b.doorX, b.doorZ, Math.floor(c.x), Math.floor(c.z))) {
      site = b;
      break;
    }
    if (b) g.demolish(b.id);
  }
  expect(site).toBeTruthy();
  const home = forceBuild(g, 'woodenHouse');
  const carriers: number[] = [];
  for (let k = 0; k < 4; k++) {
    const p = spawnAt(g, home, { age: 30, gender: k % 2 ? 'F' : 'M' });
    p.food = 47; // just fed enough to start a long job without eating first
    carriers.push(p.id);
  }
  home.inventory = {}; // nothing to eat at home: the barn is the only food
  g.setBuilders(0);
  return { g, carriers };
}

describe('hunger during long jobs', () => {
  it('carriers on long hauls interrupt in time and eat — satiation never reaches 0 with food in the barn', () => {
    const { g, carriers } = farHaulTown();
    let minFood = 100;
    let ate = 0;
    const lowTasks = new Map<string, number>();
    for (let i = 0; i < 4 * 400; i++) {
      g.step(0.25);
      for (const id of carriers) {
        const c = g.getCitizen(id);
        if (!c) continue;
        minFood = Math.min(minFood, c.food);
        if (c.food < 3) {
          const t = brainOf(c).cur;
          const k = `${t?.kind}:${t?.label}`;
          lowTasks.set(k, (lowTasks.get(k) ?? 0) + 1);
        }
        if (brainOf(c).cur?.kind === 'eat') ate++;
      }
    }
    log(`far hauls: min satiation ${minFood.toFixed(1)}, eating samples ${ate}, low-food tasks ${JSON.stringify([...lowTasks])}`);
    expect(ate).toBeGreaterThan(0);
    expect(minFood).toBeGreaterThan(2);
  });

  it('a town with plenty of food has (almost) no one at zero satiation over several years', () => {
    const g = Game.create(settings({ seed: 8080, difficulty: 'easy', mapSize: 'medium', disasters: false }));
    const bot = new Bot(g);
    let zero = 0;
    let samples = 0;
    for (let i = 0; i < 3 * 2880; i++) {
      g.step(0.25);
      bot.tick();
      if (i % 8 !== 0) continue;
      if (g.rt.townFood < g.state.citizens.length * 30) continue;
      for (const c of g.state.citizens) {
        samples++;
        if (c.food <= 0.5) zero++;
      }
    }
    log(`plenty of food: ${zero}/${samples} citizen samples at zero satiation, pop ${g.state.citizens.length}`);
    expect(zero).toBeLessThanOrEqual(samples * 0.001);
  });
});

describe('starvation advisor', () => {
  it('does not blame food production while the barn is full; says what is actually wrong', () => {
    const g = Game.create(fixtureSettings({ seed: 4242, difficulty: 'easy' }));
    g.state.time.elapsed = 400; // past the advisors' start delay
    const c0 = g.state.citizens[0];
    c0.food = 0; // someone is starving (e.g. stranded far away) while the storages hold hundreds of food
    const food = g.foodTotal();
    expect(food).toBeGreaterThan(300);
    const notices = collectNotices(g);
    const starving = notices.find((n) => n.key === 'starving');
    expect(starving).toBeUndefined();
    const hungry = notices.find((n) => n.key === 'hungryWithFood');
    expect(hungry).toBeTruthy();
    expect(hungry!.text).not.toMatch(/more workers on food/i);
    log(`advisor with ${Math.round(food)} food: ${hungry!.text}`);
  });

  it('still warns about starvation when food is actually short', () => {
    const g = Game.create(fixtureSettings({ seed: 4242, difficulty: 'easy' }));
    g.state.time.elapsed = 400;
    for (const b of g.state.buildings) {
      for (const k of Object.keys(b.inventory)) if (['berries', 'venison', 'wheat', 'beans', 'fish', 'roots', 'mushrooms', 'apple', 'corn', 'potato', 'pear'].includes(k)) delete (b.inventory as Record<string, number>)[k];
    }
    g.state.citizens[0].food = 0;
    const notices = collectNotices(g);
    expect(notices.find((n) => n.key === 'starving')?.text).toMatch(/starving/i);
  });
});
