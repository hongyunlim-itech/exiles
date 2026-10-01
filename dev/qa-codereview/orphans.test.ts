import { describe, expect, it } from 'vitest';
import { updateHousing } from '../../src/sim/core/households';
import { forceBuild, Game, settings, spawnAt, steps, log } from './helpers';

describe('orphans left in their family home', () => {
  it('are never adopted and nobody stocks their firewood', () => {
    const g = Game.create(settings({ difficulty: 'medium', climate: 'harsh' }));
    const houses = [];
    for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
    updateHousing(g);
    const fam = houses[0];
    const adults = fam.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const mother = adults.find((c) => c.gender === 'F')!;
    const father = adults.find((c) => c.gender === 'M')!;
    for (const id of [...fam.residentIds]) { const c = g.getCitizen(id)!; if (c.age < 16) g.killCitizen(id, 'oldAge'); }
    const k1 = spawnAt(g, fam, { age: 5, gender: 'M', motherId: mother.id, fatherId: father.id, name: 'Orphan One' });
    const k2 = spawnAt(g, fam, { age: 7, gender: 'F', motherId: mother.id, fatherId: father.id, name: 'Orphan Two' });
    g.killCitizen(father.id, 'accident');
    g.killCitizen(mother.id, 'disease');
    const s = g.state;
    s.time.month = 9; s.time.monthProgress = 0.0;
    delete fam.inventory.firewood;
    let fwMax = 0;
    steps(g, 170, 0.25, () => { fwMax = Math.max(fwMax, fam.inventory.firewood ?? 0); });
    const others = houses.slice(1).map((h) => Math.round(h.inventory.firewood ?? 0));
    log('orphans still alone in house', fam.residentIds.map((id) => g.getCitizen(id)?.name), 'orphan house firewood max', fwMax.toFixed(1),
      'other houses firewood', others, 'kids warmth', [k1, k2].map((k) => g.getCitizen(k.id)?.warmth.toFixed(1) ?? 'dead'), 'deaths', s.tally.deaths, 'month', s.time.month);
    expect(fwMax).toBeGreaterThan(0);
  });
});
