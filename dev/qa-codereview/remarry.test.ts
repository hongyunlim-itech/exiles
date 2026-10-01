import { describe, expect, it } from 'vitest';
import { updateHousing } from '../../src/sim/core/households';
import { forceBuild, Game, settings, spawnAt, log } from './helpers';

describe('remarriage (step e)', () => {
  it('moves a homeless single mother in without her children, who then stay homeless', () => {
    const g = Game.create(settings({ difficulty: 'medium' }));
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    updateHousing(g);
    const [hA, hB] = houses;
    const adA = hA.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const adB = hB.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    for (const h of [hA, hB]) for (const id of [...h.residentIds]) { const c = g.getCitizen(id)!; if (c.age < 16) g.killCitizen(id, 'oldAge'); }
    const widower = adA.find((c) => c.gender === 'M')!;
    const wifeA = adA.find((c) => c.gender === 'F')!;
    for (const a of [3, 5, 7]) spawnAt(g, hA, { age: a, gender: 'M', motherId: wifeA.id, fatherId: widower.id });
    g.killCitizen(wifeA.id, 'disease');
    const widow = adB.find((c) => c.gender === 'F')!;
    const husB = adB.find((c) => c.gender === 'M')!;
    const kb1 = spawnAt(g, hB, { age: 2, gender: 'F', motherId: widow.id, fatherId: husB.id, name: 'Kid B1' });
    const kb2 = spawnAt(g, hB, { age: 4, gender: 'M', motherId: widow.id, fatherId: husB.id, name: 'Kid B2' });
    g.killCitizen(husB.id, 'accident');
    g.removeBuilding(hB.id, 'fire'); // widow + kids homeless
    for (let k = 0; k < 10; k++) updateHousing(g);
    log('widow married to', g.getCitizen(widow.spouseId)?.name, 'widow home', widow.homeId, 'house A residents', hA.residentIds.length, 'her kids homes', kb1.homeId, kb2.homeId);
    expect(kb1.homeId).toBeGreaterThanOrEqual(0);
  });
});
