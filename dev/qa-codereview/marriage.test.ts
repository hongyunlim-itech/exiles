import { describe, expect, it } from 'vitest';
import { updateHousing } from '../../src/sim/core/households';
import { forceBuild, Game, settings, spawnAt } from './helpers';
import { log } from './helpers';

function housedTown() {
  const g = Game.create(settings({ difficulty: 'medium' }));
  // house every starting family
  const houses = [];
  for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
  updateHousing(g);
  const homeless = g.state.citizens.filter((c) => c.homeId < 0);
  return { g, houses, homeless };
}

describe('marriage / housing', () => {
  it('siblings at the top of the single ranking block every new marriage (empty house stays empty)', () => {
    const { g, houses, homeless } = housedTown();
    expect(homeless.length).toBe(0);
    const famA = houses[0];
    const famB = houses[1];
    const [fa, ma] = famA.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const motherA = fa.gender === 'F' ? fa : ma;
    const fatherA = fa.gender === 'M' ? fa : ma;
    const parentsB = famB.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const motherB = parentsB.find((c) => c.gender === 'F')!;
    const fatherB = parentsB.find((c) => c.gender === 'M')!;
    // make room in the family homes (kids from setup are irrelevant here)
    for (const h of [famA, famB]) for (const id of [...h.residentIds]) { const c = g.getCitizen(id)!; if (c.age < 16) g.killCitizen(id, 'oldAge'); }
    // family A: eldest son 17 and eldest daughter 16.6 (siblings) live with their parents
    const son = spawnAt(g, famA, { age: 17, gender: 'M', motherId: motherA.id, fatherId: fatherA.id, name: 'Son A' });
    const daughterA = spawnAt(g, famA, { age: 16.6, gender: 'F', motherId: motherA.id, fatherId: fatherA.id, name: 'Daughter A' });
    // family B: an unrelated single daughter 16.3
    const daughterB = spawnAt(g, famB, { age: 16.3, gender: 'F', motherId: motherB.id, fatherId: fatherB.id, name: 'Daughter B' });
    const empty = forceBuild(g, 'woodenHouse');
    for (let k = 0; k < 50; k++) updateHousing(g); // 100 s of housing ticks
    log('empty house residents', empty.residentIds.length, 'son spouse', son.spouseId, 'daughterB spouse', daughterB.spouseId, daughterA.spouseId);
    // Son A and Daughter B are both eligible and unrelated: they should marry and take the empty house.
    expect(empty.residentIds.length).toBeGreaterThan(0);
  });

  it('a homeless widow can marry her own adult son', () => {
    const { g, houses } = housedTown();
    const fam = houses[0];
    const adults = fam.residentIds.map((id) => g.getCitizen(id)!).filter((c) => c.age >= 16);
    const mother = adults.find((c) => c.gender === 'F')!;
    const father = adults.find((c) => c.gender === 'M')!;
    mother.age = 38;
    for (const id of [...fam.residentIds]) { const c = g.getCitizen(id)!; if (c.age < 16) g.killCitizen(id, 'oldAge'); }
    const son = spawnAt(g, fam, { age: 18, gender: 'M', motherId: mother.id, fatherId: father.id, name: 'Son' });
    g.killCitizen(father.id, 'accident'); // widow
    // their house burns / is demolished -> both homeless
    g.removeBuilding(fam.id, 'demolish');
    expect(mother.homeId).toBe(-1);
    expect(son.homeId).toBe(-1);
    const empty = forceBuild(g, 'woodenHouse');
    updateHousing(g);
    log('mother.spouseId', mother.spouseId, 'son.id', son.id, 'empty residents', empty.residentIds);
    expect(mother.spouseId).not.toBe(son.id);
  });
});
