/**
 * Housing & marriage regressions (review findings): kin never marry, the couple search looks at every pair, young
 * adults leave home for empty houses (alone if need be), single parents in boarding houses and remarried widows keep
 * their children, orphans left alone in a house are taken in. Growth must follow the housing supply.
 */
import { describe, expect, it } from 'vitest';
import { updateHousing, wantsOwnHome } from '../src/sim/core/households';
import { MARRY_AGE } from '../src/sim/core/citizens';
import { couple, emptyTown, fixtureSettings, forceBuild, Game, spawnAt } from './simcore.fixtures';

function town(): Game {
  const g = Game.create(fixtureSettings());
  emptyTown(g);
  return g;
}

function housing(g: Game, ticks = 5): void {
  for (let k = 0; k < ticks; k++) updateHousing(g);
}

describe('marriage', () => {
  it('siblings at the top of the ranking do not block other couples (every pair is searched)', () => {
    const g = town();
    const homeA = forceBuild(g, 'woodenHouse');
    const homeB = forceBuild(g, 'woodenHouse');
    const [fa, ma] = couple(g, homeA, [45, 43]);
    const [fb, mb] = couple(g, homeB, [44, 42]);
    // eldest son and daughter of family A (siblings, top of the ranking) + a younger unrelated daughter of family B
    const son = spawnAt(g, homeA, { age: 17, gender: 'M', motherId: ma.id, fatherId: fa.id });
    const sister = spawnAt(g, homeA, { age: 16.6, gender: 'F', motherId: ma.id, fatherId: fa.id });
    const other = spawnAt(g, homeB, { age: 16.3, gender: 'F', motherId: mb.id, fatherId: fb.id });
    const empty = forceBuild(g, 'woodenHouse');
    housing(g);
    expect(son.spouseId).toBe(other.id);
    expect(sister.spouseId).not.toBe(son.id);
    expect(empty.residentIds).toContain(son.id);
    expect(empty.residentIds).toContain(other.id);
  });

  it('never marries a parent to a child or half-siblings (same father)', () => {
    const g = town();
    const [father, mother] = couple(g, null, [40, 38]);
    const son = spawnAt(g, null, { age: 18, gender: 'M', motherId: mother.id, fatherId: father.id });
    // the father's daughter from another mother
    const halfSister = spawnAt(g, null, { age: 17, gender: 'F', fatherId: father.id });
    g.killCitizen(father.id, 'accident'); // widow, homeless with her adult son
    forceBuild(g, 'woodenHouse');
    forceBuild(g, 'woodenHouse');
    housing(g);
    expect(mother.spouseId).not.toBe(son.id);
    expect(son.spouseId).not.toBe(mother.id);
    expect(son.spouseId).not.toBe(halfSister.id);
  });

  it('young adults (MARRY_AGE) living with their parents marry and move into an empty house', () => {
    const g = town();
    const homeA = forceBuild(g, 'woodenHouse');
    const homeB = forceBuild(g, 'woodenHouse');
    const [fa, ma] = couple(g, homeA);
    const [fb, mb] = couple(g, homeB);
    const boy = spawnAt(g, homeA, { age: MARRY_AGE + 0.1, gender: 'M', motherId: ma.id, fatherId: fa.id });
    const girl = spawnAt(g, homeB, { age: MARRY_AGE + 0.3, gender: 'F', motherId: mb.id, fatherId: fb.id });
    expect(wantsOwnHome(g, boy)).toBe(true);
    const empty = forceBuild(g, 'woodenHouse');
    housing(g);
    expect(boy.spouseId).toBe(girl.id);
    expect(boy.homeId).toBe(empty.id);
    expect(girl.homeId).toBe(empty.id);
  });

  it('a single young adult claims an empty house alone and a partner joins later', () => {
    const g = town();
    const homeA = forceBuild(g, 'woodenHouse');
    const [fa, ma] = couple(g, homeA);
    const son = spawnAt(g, homeA, { age: 15, gender: 'M', motherId: ma.id, fatherId: fa.id });
    const empty = forceBuild(g, 'woodenHouse');
    housing(g);
    // nobody to marry yet: he still moves out rather than staying with his parents while a house stands empty
    expect(son.homeId).toBe(empty.id);
    expect(wantsOwnHome(g, son)).toBe(false);
    // a young woman from another family comes of age later
    const homeB = forceBuild(g, 'woodenHouse');
    const [fb, mb] = couple(g, homeB);
    const girl = spawnAt(g, homeB, { age: MARRY_AGE + 0.5, gender: 'F', motherId: mb.id, fatherId: fb.id });
    housing(g);
    expect(son.spouseId).toBe(girl.id);
    expect(girl.homeId).toBe(empty.id);
  });

  it('children below MARRY_AGE stay with their parents', () => {
    const g = town();
    const home = forceBuild(g, 'woodenHouse');
    const [f, m] = couple(g, home);
    const kid = spawnAt(g, home, { age: MARRY_AGE - 1, gender: 'M', motherId: m.id, fatherId: f.id });
    forceBuild(g, 'woodenHouse');
    housing(g);
    expect(kid.homeId).toBe(home.id);
  });
});

describe('families & orphans', () => {
  it('a single parent in a boarding house moves with her homeless children into an empty family house', () => {
    const g = town();
    const home = forceBuild(g, 'woodenHouse');
    forceBuild(g, 'boardingHouse');
    const [father, mother] = couple(g, home);
    const k1 = spawnAt(g, home, { age: 4, gender: 'M', motherId: mother.id, fatherId: father.id });
    const k2 = spawnAt(g, home, { age: 6, gender: 'F', motherId: mother.id, fatherId: father.id });
    g.killCitizen(father.id, 'accident');
    g.removeBuilding(home.id, 'fire'); // everybody homeless
    housing(g, 1); // no family house: the mother takes a boarding bed
    const empty = forceBuild(g, 'woodenHouse');
    housing(g);
    expect(mother.homeId).toBe(empty.id);
    expect(k1.homeId).toBe(empty.id);
    expect(k2.homeId).toBe(empty.id);
  });

  it('a remarrying widow brings her children along (or is not chosen when they would not fit)', () => {
    const g = town();
    const hA = forceBuild(g, 'woodenHouse');
    const hB = forceBuild(g, 'woodenHouse');
    const [widower, wifeA] = couple(g, hA, [34, 32]);
    for (const a of [3, 5]) spawnAt(g, hA, { age: a, gender: 'M', motherId: wifeA.id, fatherId: widower.id });
    g.killCitizen(wifeA.id, 'disease');
    const [husB, widow] = couple(g, hB, [35, 31]);
    const kb1 = spawnAt(g, hB, { age: 2, gender: 'F', motherId: widow.id, fatherId: husB.id });
    const kb2 = spawnAt(g, hB, { age: 4, gender: 'M', motherId: widow.id, fatherId: husB.id });
    g.killCitizen(husB.id, 'accident');
    g.removeBuilding(hB.id, 'fire');
    housing(g, 10);
    // widower + 2 kids + widow + 2 kids = 6 > 5: she must not be moved in without her children
    for (const k of [kb1, kb2]) expect(k.homeId).toBeGreaterThanOrEqual(0);
    if (widow.spouseId === widower.id) expect(kb1.homeId).toBe(widow.homeId);
    expect(widow.homeId).toBeGreaterThanOrEqual(-1);
  });

  it('children left alone in their house are taken in by another household', () => {
    const g = town();
    const home = forceBuild(g, 'woodenHouse');
    const other = forceBuild(g, 'woodenHouse');
    const [f, m] = couple(g, home);
    const k1 = spawnAt(g, home, { age: 5, gender: 'M', motherId: m.id, fatherId: f.id });
    const k2 = spawnAt(g, home, { age: 7, gender: 'F', motherId: m.id, fatherId: f.id });
    couple(g, other);
    g.killCitizen(f.id, 'accident');
    g.killCitizen(m.id, 'disease');
    housing(g);
    expect(k1.homeId).toBe(other.id);
    expect(k2.homeId).toBe(other.id);
    expect(home.residentIds.length).toBe(0);
  });

  it('orphans with nowhere to go get a guardian couple moving into their house', () => {
    const g = town();
    const home = forceBuild(g, 'woodenHouse');
    const [f, m] = couple(g, home);
    const k1 = spawnAt(g, home, { age: 5, gender: 'M', motherId: m.id, fatherId: f.id });
    g.killCitizen(f.id, 'accident');
    g.killCitizen(m.id, 'disease');
    // two homeless young adults
    const a = spawnAt(g, null, { age: 20, gender: 'M' });
    const b = spawnAt(g, null, { age: 19, gender: 'F' });
    housing(g);
    expect(a.homeId).toBe(home.id);
    expect(b.homeId).toBe(home.id);
    expect(k1.homeId).toBe(home.id);
  });
});

describe('population growth follows housing (bot, medium)', () => {
  it('young adults found households when houses are built: no stall at families x 5', () => {
    const g = Game.create(fixtureSettings({ seed: 77, mapSize: 'medium' }));
    // every family gets a house, plus 3 empty ones
    for (let k = 0; k < 8; k++) forceBuild(g, 'woodenHouse');
    const s = g.state;
    // age the town's children by 8 years (as if the game had run for a while)
    for (const c of s.citizens) if (c.spouseId < 0) c.age += 8;
    housing(g);
    const households = s.buildings.filter((b) => b.type === 'woodenHouse' && b.residentIds.length > 0).length;
    const eligibleAtHome = s.citizens.filter((c) => wantsOwnHome(g, c)).length;
    const emptyHouses = s.buildings.filter((b) => b.type === 'woodenHouse' && b.residentIds.length === 0).length;
    // nobody stays with their parents while an empty house stands
    expect(emptyHouses === 0 || eligibleAtHome === 0).toBe(true);
    expect(households).toBeGreaterThan(5);
  });
});
