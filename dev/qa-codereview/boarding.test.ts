import { describe, expect, it } from 'vitest';
import { updateHousing } from '../../src/sim/core/households';
import { forceBuild, Game, settings, spawnAt, steps, log } from './helpers';

describe('single parent in a boarding house', () => {
  it('her homeless children are never rehoused, even with an empty family house', () => {
    const g = Game.create(settings({ difficulty: 'medium' }));
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    forceBuild(g, 'boardingHouse');
    updateHousing(g);
    const fam = houses[0];
    const adults = fam.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const mother = adults.find((c) => c.gender === 'F')!;
    const father = adults.find((c) => c.gender === 'M')!;
    for (const id of [...fam.residentIds]) { const c = g.getCitizen(id)!; if (c.age < 16) g.killCitizen(id, 'oldAge'); }
    const k1 = spawnAt(g, fam, { age: 4, gender: 'M', motherId: mother.id, fatherId: father.id, name: 'Kid One' });
    const k2 = spawnAt(g, fam, { age: 6, gender: 'F', motherId: mother.id, fatherId: father.id, name: 'Kid Two' });
    g.killCitizen(father.id, 'accident');
    g.removeBuilding(fam.id, 'fire'); // the family home burns down -> ruin, everybody homeless
    updateHousing(g);
    log('after fire: mother home', g.getBuilding(mother.homeId)?.type, 'kids homes', k1.homeId, k2.homeId);
    const empty = forceBuild(g, 'woodenHouse');
    for (let k = 0; k < 30; k++) updateHousing(g);
    log('with an empty family house: mother home', g.getBuilding(mother.homeId)?.type, 'kids', k1.homeId, k2.homeId, 'empty house residents', empty.residentIds);
    expect(k1.homeId).toBeGreaterThanOrEqual(0);
  });

  it('...and the homeless children freeze in winter', () => {
    const g = Game.create(settings({ difficulty: 'medium', climate: 'fair' }));
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    forceBuild(g, 'boardingHouse');
    updateHousing(g);
    const fam = houses[0];
    const adults = fam.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const mother = adults.find((c) => c.gender === 'F')!;
    const father = adults.find((c) => c.gender === 'M')!;
    for (const id of [...fam.residentIds]) { const c = g.getCitizen(id)!; if (c.age < 16) g.killCitizen(id, 'oldAge'); }
    const k1 = spawnAt(g, fam, { age: 4, gender: 'M', motherId: mother.id, fatherId: father.id, name: 'Kid One' });
    const k2 = spawnAt(g, fam, { age: 6, gender: 'F', motherId: mother.id, fatherId: father.id, name: 'Kid Two' });
    g.killCitizen(father.id, 'accident');
    g.removeBuilding(fam.id, 'fire');
    updateHousing(g); // mother -> boarding house, kids homeless
    forceBuild(g, 'woodenHouse'); // an empty family house is available from now on
    const s = g.state;
    s.time.month = 8; s.time.monthProgress = 0.5; // late autumn
    const before = s.tally.deaths.freezing ?? 0;
    let minWarm = 100;
    steps(g, 5 * 60, 0.25, () => { for (const k of [k1, k2]) if (g.getCitizen(k.id)) minWarm = Math.min(minWarm, k.warmth); });
    log('kids alive', [k1, k2].filter((k) => g.getCitizen(k.id)).length, 'min warmth', minWarm.toFixed(1), 'freezing deaths', (s.tally.deaths.freezing ?? 0) - before, 'deaths', s.tally.deaths, 'month', s.time.month);
    expect(minWarm).toBeGreaterThan(10);
  });
});
