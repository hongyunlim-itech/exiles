import { describe, expect, it } from 'vitest';
import { Feature } from '../../src/core/types';
import { brainOf } from '../../src/sim/core/tasks';
import { Game, settings, steps, log } from './helpers';

describe('misc 2', () => {
  it('pausing a site that is still being cleared does not stop the clearing', () => {
    const g = Game.create(settings({ difficulty: 'medium', seed: 4242 }));
    const s = g.state;
    let spot: { x: number; z: number } | null = null;
    const c = g.townCenter();
    for (let r = 5; r < 50 && !spot; r++) for (let a = 0; a < 32 && !spot; a++) {
      const x = Math.floor(c.x + Math.cos(a) * r), z = Math.floor(c.z + Math.sin(a) * r);
      const chk = g.checkPlacement('woodenHouse', x, z, 0);
      if (chk.ok && chk.clearing.length >= 6) spot = { x, z };
    }
    const b = g.placeBuilding('woodenHouse', spot!.x, spot!.z, 0)!;
    g.setPaused(b.id, true);
    const tiles: number[] = [];
    for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) if (s.tiles.feature[zz * s.W + xx] === Feature.Tree) tiles.push(zz * s.W + xx);
    steps(g, 180);
    const felled = tiles.filter((i) => s.tiles.feature[i] !== Feature.Tree).length;
    log('paused site trees', tiles.length, 'felled while paused', felled, 'state', b.state);
    expect(felled).toBe(0);
  });

  it('a sick citizen resting outdoors (homeless) is sheltered from the cold', () => {
    const g = Game.create(settings({ difficulty: 'medium', seed: 4242, climate: 'harsh' }));
    const s = g.state;
    s.time.month = 10; s.time.monthProgress = 0.5;
    const sick = s.citizens.find((x) => x.age > 16)!;
    const well = s.citizens.find((x) => x.age > 16 && x !== sick && x.homeId < 0)!;
    for (const c of [sick, well]) { g.abortTask(c); c.warmth = 60; c.coatWear = 0; c.food = 90; }
    sick.sick = 0.8;
    let sickMin = 100, wellMin = 100;
    const acts = new Set<string>();
    steps(g, 25, 0.25, () => { s.time.month = 10; sick.sick = Math.max(sick.sick, 0.8); sickMin = Math.min(sickMin, sick.warmth); wellMin = Math.min(wellMin, well.warmth); acts.add(sick.activity + ':' + (brainOf(sick).cur?.label ?? '')); });
    log('temp', s.weather.temperature.toFixed(1), 'homeless sick warmth min', sickMin.toFixed(1), 'homeless healthy warmth min', wellMin.toFixed(1), [...acts]);
    expect(sickMin).toBeLessThan(50);
  });
});
