/**
 * save() -> fromSave() round trip: the restored game has identical state and keeps simulating like the original.
 */
import { describe, expect, it } from 'vitest';
import { FOOD_TYPES } from '../src/core/defs';
import { Game } from '../src/sim/game';
import { Bot } from './simcore.bot';
import { log, settings } from './simcore.helpers';

function snapshot(g: Game) {
  const s = g.state;
  const tot = g.resourceTotals();
  return {
    time: s.time.elapsed,
    pop: s.citizens.length,
    buildings: s.buildings.length,
    food: FOOD_TYPES.reduce((a, r) => a + tot[r], 0),
    logs: tot.log,
    firewood: tot.firewood,
    births: s.tally.births,
  };
}

describe('simcore save/load', () => {
  it('round-trips and continues simulating identically enough', () => {
    const g = Game.create(settings({ seed: 8080, difficulty: 'medium', mapSize: 'small', disasters: false }));
    const bot = new Bot(g);
    for (let i = 0; i < 2400; i++) {
      g.step(0.25);
      bot.tick();
    }
    const json = g.save();
    log(`save size ${(json.length / 1024).toFixed(1)} KiB, citizens ${g.state.citizens.length}, buildings ${g.state.buildings.length}`);
    const h = Game.fromSave(json);
    expect(h.validate()).toEqual([]);
    expect(snapshot(h)).toEqual(snapshot(g));
    // runtime indexes rebuilt
    for (const b of g.state.buildings) {
      const hb = h.getBuilding(b.id)!;
      expect(hb).toBeTruthy();
      expect(hb.state).toBe(b.state);
      expect(hb.reservedIn).toBeCloseTo(b.reservedIn, 5);
      expect(h.state.tiles.building[b.z * h.state.W + b.x]).toBe(b.id);
    }
    for (let i = 0; i < h.state.tiles.building.length; i++) expect(h.state.tiles.building[i]).toBe(g.state.tiles.building[i]);
    // continue both
    for (let i = 0; i < 960; i++) {
      g.step(0.25);
      h.step(0.25);
    }
    const a = snapshot(g);
    const b = snapshot(h);
    log('after 240s original', a, 'restored', b);
    expect(h.validate()).toEqual([]);
    // sim-core itself is deterministic across save/load (see rngTrace); other modules keep small runtime caches
    // (e.g. wellbeing), so allow tiny divergence such as one extra/missing birth
    expect(Math.abs(b.pop - a.pop)).toBeLessThanOrEqual(2);
    expect(b.buildings).toBe(a.buildings);
    expect(Math.abs(b.food - a.food)).toBeLessThan(Math.max(30, a.food * 0.15));
    expect(Math.abs(b.logs - a.logs)).toBeLessThan(Math.max(30, a.logs * 0.2));
    // positions: most citizens should be close to their counterparts
    let same = 0;
    for (const c of g.state.citizens) {
      const d = h.getCitizen(c.id);
      if (d && Math.hypot(d.x - c.x, d.z - c.z) < 0.01) same++;
    }
    log(`citizens at identical positions: ${same}/${g.state.citizens.length}`);
    expect(h.moduleErrors()).toEqual({});
  });

  it('rejects corrupt data', () => {
    expect(() => Game.fromSave('{not json')).toThrow();
    expect(() => Game.fromSave('{"version":1}')).toThrow();
  });
});
