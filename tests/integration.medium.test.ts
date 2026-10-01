/**
 * Integration: a medium game played for 6 years by the scripted bot (sensible Banished build order) with every
 * sim module and disasters on. The town must survive and grow, with no exceptions, module errors or invariant
 * violations; a save taken at the end must load and keep running.
 */
import { describe, expect, it, vi } from 'vitest';
import { Game } from '../src/sim/game';
import { integrationSettings, playYears, report } from './integration.helpers';

const CASES = [
  { terrain: 'valleys' as const, seed: 101 },
  { terrain: 'lakes' as const, seed: 102 },
];

describe('integration: medium, 6 years', () => {
  for (const { terrain, seed } of CASES) {
    it(`medium / ${terrain} / seed ${seed} survives and grows`, () => {
      const r = playYears(integrationSettings('medium', terrain, seed), 6);
      report(`medium/${terrain}/${seed}`, r);
      const g = r.game;
      expect(r.errors).toEqual([]);
      expect(g.moduleErrors()).toEqual({});
      expect(r.problems).toEqual([]);
      expect(g.state.gameOver).toBe(false);
      expect(r.rows).toHaveLength(6);
      const last = r.rows[r.rows.length - 1];
      expect(last.pop).toBeGreaterThan(r.startPop);
      expect(r.minPop).toBeGreaterThanOrEqual(r.startPop - 2);
      // a real economy: many buildings finished, food & firewood stocked at the end
      expect(last.buildings).toBeGreaterThan(15);
      expect(last.food).toBeGreaterThan(last.pop * 12);
      expect(last.firewood).toBeGreaterThan(0);
      // nobody died of starvation or cold in a well-run town
      const deaths = g.state.tally.deaths;
      expect(deaths.starvation ?? 0).toBe(0);
      expect(deaths.freezing ?? 0).toBeLessThanOrEqual(2);
      // history samples for the statistics window: one per month plus the initial one
      expect(g.state.history.length).toBeGreaterThanOrEqual(6 * 12);

      // the save at the end loads and the restored town keeps running cleanly
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const g2 = Game.fromSave(g.save());
        expect(g2.state.citizens.length).toBe(g.state.citizens.length);
        expect(g2.state.buildings.length).toBe(g.state.buildings.length);
        expect(g2.validate()).toEqual([]);
        for (let i = 0; i < 240; i++) g2.step(0.25);
        expect(g2.validate()).toEqual([]);
        expect(g2.moduleErrors()).toEqual({});
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  }
});
