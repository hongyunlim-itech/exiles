import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import { infectCitizen } from '../src/sim/ext/disease';
import { rt } from '../src/sim/ext/runtime';
import {
  conditionLabel, happinessFactors, healthFactors, updateWellbeing, wellbeingEfficiency, wellbeingTargets,
} from '../src/sim/wellbeing';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function run(g: FakeGame, seconds: number, dt = 0.25, each?: () => void): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    advanceTime(g, dt);
    each?.();
    updateWellbeing(g.asGame(), dt);
  }
}

describe('wellbeingEfficiency', () => {
  it('follows 0.6 + 0.4*happiness + 0.25*education with a poor-health penalty', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ happiness: 100, education: 1, health: 90 });
    expect(wellbeingEfficiency(c)).toBeCloseTo(1.25, 5);
    c.happiness = 50;
    c.education = 0;
    expect(wellbeingEfficiency(c)).toBeCloseTo(0.8, 5);
    c.health = 20;
    expect(wellbeingEfficiency(c)).toBeCloseTo(0.56, 5);
    c.happiness = 0;
    expect(wellbeingEfficiency(c)).toBeGreaterThanOrEqual(0.35);
  });

  it('never returns NaN for broken values', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ happiness: NaN, education: NaN, health: NaN });
    expect(Number.isFinite(wellbeingEfficiency(c))).toBe(true);
  });
});

describe('factors', () => {
  it('sum of factors equals the drift target', () => {
    const g = createFakeGame();
    const home = g.addBuilding('woodenHouse', 10, 10);
    const c = g.addCitizen({ homeId: home.id, dietMask: 7 });
    const hf = healthFactors(g.asGame(), c);
    const pf = happinessFactors(g.asGame(), c);
    expect(hf[0]).toEqual({ label: 'Base health', value: 70 });
    expect(pf[0]).toEqual({ label: 'Base happiness', value: 50 });
    const targets = wellbeingTargets(g.asGame(), c);
    expect(targets.health).toBeCloseTo(Math.min(100, hf.reduce((a, f) => a + f.value, 0)), 5);
    expect(targets.happiness).toBeCloseTo(Math.min(100, pf.reduce((a, f) => a + f.value, 0)), 5);
  });

  it('reflects services, housing, grief and unburied dead', () => {
    const g = createFakeGame();
    const home = g.addBuilding('stoneHouse', 10, 10);
    const chapel = g.addBuilding('chapel', 16, 10);
    const tavern = g.addBuilding('tavern', 10, 16, { inventory: { ale: 20 } });
    g.addBuilding('well', 14, 14);
    const priest = g.addCitizen({ profession: 'priest', workplaceId: chapel.id });
    chapel.workerIds.push(priest.id);
    const keeper = g.addCitizen({ profession: 'tavernkeeper', workplaceId: tavern.id });
    tavern.workerIds.push(keeper.id);
    home.inventory.herbs = 5;
    const c = g.addCitizen({ homeId: home.id, grief: 50, dietMask: 15 });
    g.state.unburied = 2;

    const labels = (f: { label: string }[]) => f.map((x) => x.label);
    const hp = happinessFactors(g.asGame(), c);
    expect(labels(hp)).toContain('Chapel with a priest nearby');
    expect(labels(hp)).toContain('Tavern serving ale nearby');
    expect(labels(hp)).toContain('Comfortable stone house');
    expect(labels(hp)).toContain('The dead lie unburied');
    expect(hp.find((f) => f.label === 'Grieving a loved one')?.value).toBeCloseTo(-15, 5);

    const hl = healthFactors(g.asGame(), c);
    expect(labels(hl)).toContain('Herbs at home');
    expect(labels(hl)).toContain('Clean water from a well');
    expect(hl.find((f) => f.label.startsWith('Varied diet'))?.value).toBe(20);

    // Tavern without ale no longer counts.
    tavern.inventory.ale = 0;
    rt(g.asGame()).services = null;
    expect(labels(happinessFactors(g.asGame(), c))).not.toContain('Tavern serving ale nearby');

    const homeless = g.addCitizen({ homeId: -1, x: 40, z: 40 });
    expect(happinessFactors(g.asGame(), homeless).find((f) => f.label === 'Homeless')?.value).toBe(-25);
  });

  it('labels conditions', () => {
    expect(conditionLabel(95)).toBe('Excellent');
    expect(conditionLabel(50)).toBe('Fair');
    expect(conditionLabel(5)).toBe('Critical');
  });
});

describe('updateWellbeing', () => {
  it('health and happiness drift toward their targets and stay within 0..100', () => {
    const g = createFakeGame();
    const home = g.addBuilding('woodenHouse', 10, 10, { inventory: { herbs: 50 } });
    g.addBuilding('well', 14, 10);
    const c = g.addCitizen({ homeId: home.id, dietMask: 15, health: 40, happiness: 20 });
    run(g, 4 * MONTH_SECONDS);
    expect(c.health).toBeGreaterThan(90);
    expect(c.happiness).toBeGreaterThan(40);
    for (const x of g.state.citizens) {
      expect(x.health).toBeGreaterThanOrEqual(0);
      expect(x.health).toBeLessThanOrEqual(100);
      expect(x.happiness).toBeGreaterThanOrEqual(0);
      expect(x.happiness).toBeLessThanOrEqual(100);
    }
  });

  it('starving citizens lose health and die of starvation (gradually: the weak first)', () => {
    const g = createFakeGame();
    const weak = g.addCitizen({ food: 0, health: 60, dietMask: 0, age: 70 });
    const strong = g.addCitizen({ food: 0, health: 95, dietMask: 15 });
    run(g, 1 * MONTH_SECONDS);
    expect(g.killed).toEqual([]);
    run(g, 3 * MONTH_SECONDS);
    expect(g.killed[0]).toEqual({ id: weak.id, cause: 'starvation' });
    expect(strong.health).toBeLessThan(60);
  });

  it('freezing citizens die of freezing', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ warmth: 0, health: 70 });
    run(g, 2 * MONTH_SECONDS);
    expect(g.killed[0]).toEqual({ id: c.id, cause: 'freezing' });
  });

  it('grief decays over months', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ grief: 100 });
    run(g, 4 * MONTH_SECONDS);
    expect(c.grief).toBeGreaterThan(30);
    expect(c.grief).toBeLessThan(70);
    run(g, 5 * MONTH_SECONDS);
    expect(c.grief).toBe(0);
  });

  it('students studying at a staffed school gain education', () => {
    const g = createFakeGame();
    const school = g.addBuilding('school', 20, 20);
    const t = g.addCitizen({ profession: 'teacher', workplaceId: school.id });
    school.workerIds.push(t.id);
    const s = g.addCitizen({ profession: 'student', age: 11, activity: 'studying', x: 22, z: 22 });
    const other = g.addCitizen({ profession: 'student', age: 11, activity: 'playing', x: 22, z: 22 });
    run(g, YEAR_SECONDS * 0.45 * 2); // two school-years of studying time
    expect(s.education).toBeGreaterThan(0.45);
    expect(s.education).toBeLessThan(0.55);
    expect(other.education).toBe(0);

    // Without a teacher nothing is learned.
    school.workerIds = [];
    rt(g.asGame()).services = null;
    const before = s.education;
    run(g, 60);
    expect(s.education).toBe(before);
  });

  it('moves unburied dead into free cemetery graves', () => {
    const g = createFakeGame();
    const cem = g.addBuilding('cemetery', 30, 30, { w: 4, h: 4 }); // 8 graves
    g.addCitizen();
    g.state.unburied = 3;
    run(g, 30);
    expect(g.state.unburied).toBe(0);
    expect(cem.graves).toBe(3);
    expect(g.state.messages.some((m) => m.text.includes('laid to rest'))).toBe(true);

    g.state.unburied = 10;
    run(g, 120);
    expect(cem.graves).toBe(8);
    expect(g.state.unburied).toBe(5);
  });

  it('taverns pour ale and households use herbs over time', () => {
    const g = createFakeGame();
    const home = g.addBuilding('woodenHouse', 10, 10, { inventory: { herbs: 10 } });
    const tavern = g.addBuilding('tavern', 16, 10, { inventory: { ale: 50 } });
    const keeper = g.addCitizen({ profession: 'tavernkeeper' });
    tavern.workerIds.push(keeper.id);
    for (let i = 0; i < 4; i++) g.addCitizen({ homeId: home.id });
    run(g, 6 * MONTH_SECONDS);
    expect(tavern.inventory.ale ?? 0).toBeLessThan(50);
    expect(tavern.inventory.ale ?? 0).toBeGreaterThan(40);
    expect(home.inventory.herbs ?? 0).toBeLessThanOrEqual(8);
    expect(home.inventory.herbs ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe('disease', () => {
  it('a hospital with a healer and herbs cures the sick and uses herbs', () => {
    const g = createFakeGame();
    const home = g.addBuilding('woodenHouse', 10, 10);
    const hospital = g.addBuilding('hospital', 18, 10, { inventory: { herbs: 40 } });
    const healer = g.addCitizen({ profession: 'healer', x: 40, z: 40 });
    hospital.workerIds.push(healer.id);
    const c = g.addCitizen({ homeId: home.id, health: 80 });
    infectCitizen(g.asGame(), c, 0.6, { force: true });
    run(g, 45);
    expect(c.sick).toBe(0);
    expect(c.health).toBeGreaterThan(40);
    expect(hospital.inventory.herbs ?? 0).toBeLessThan(40);
    expect(g.killed).toHaveLength(0);
  });

  it('untreated disease spreads within a household', () => {
    const g = createFakeGame({ seed: 7 });
    const home = g.addBuilding('woodenHouse', 10, 10);
    const members = [0, 1, 2, 3].map(() => g.addCitizen({ homeId: home.id, x: 40, z: 5, health: 60 }));
    // Spread them out so only household contact matters.
    members.forEach((m, i) => (m.x = 5 + i * 8));
    infectCitizen(g.asGame(), members[0], 0.8, { force: true });
    run(g, 2 * MONTH_SECONDS);
    const sickOrDead = members.filter((m) => m.sick > 0 || g.killed.some((k) => k.id === m.id)).length;
    expect(sickOrDead).toBeGreaterThan(1);
  });

  it('recovered citizens are immune for a while', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ health: 100 });
    infectCitizen(g.asGame(), c, 0.1, { force: true });
    run(g, 4 * MONTH_SECONDS); // untreated, even a light illness takes a few months
    expect(c.sick).toBe(0);
    expect(infectCitizen(g.asGame(), c, 0.5)).toBe(false);
    expect(c.sick).toBe(0);
  });

  it('gravely ill, weak citizens can die of disease', () => {
    const g = createFakeGame();
    const c = g.addCitizen({ health: 25, dietMask: 1, age: 70 });
    infectCitizen(g.asGame(), c, 1, { force: true });
    run(g, 6 * MONTH_SECONDS);
    expect(g.killed.find((k) => k.id === c.id)?.cause).toBe('disease');
  });
});
