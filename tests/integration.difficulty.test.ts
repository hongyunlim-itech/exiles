/**
 * Integration: easy and hard games played for 3 years by the scripted bot (disasters on). Both must survive and
 * grow without exceptions, module errors or invariant violations.
 * Also regression tests for two whole-town stalls found during integration:
 *  - laborers froze when the cheapest job was hauling a full workplace buffer that no storage could take
 *    (e.g. the only barn burnt down or all barns full);
 *  - priority workplaces could stay unstaffed forever once every adult had a job.
 */
import { describe, expect, it } from 'vitest';
import { BUILDINGS, FOOD_TYPES } from '../src/core/defs';
import type { Building } from '../src/core/types';
import { Game } from '../src/sim/game';
import { integrationSettings, playYears, report } from './integration.helpers';
import { place, settings } from './simcore.helpers';

describe('integration: easy & hard, 3 years', () => {
  const CASES = [
    { difficulty: 'easy' as const, terrain: 'mountains' as const, seed: 103 },
    { difficulty: 'easy' as const, terrain: 'valleys' as const, seed: 204 },
    { difficulty: 'hard' as const, terrain: 'valleys' as const, seed: 104 },
    { difficulty: 'hard' as const, terrain: 'valleys' as const, seed: 205 },
  ];
  for (const { difficulty, terrain, seed } of CASES) {
    it(`${difficulty} / ${terrain} / seed ${seed} survives and grows`, () => {
      const r = playYears(integrationSettings(difficulty, terrain, seed), 3);
      report(`${difficulty}/${terrain}/${seed}`, r);
      const g = r.game;
      expect(r.errors).toEqual([]);
      expect(g.moduleErrors()).toEqual({});
      expect(r.problems).toEqual([]);
      expect(g.state.gameOver).toBe(false);
      expect(r.rows).toHaveLength(3);
      expect(r.rows[2].pop).toBeGreaterThan(r.startPop);
      expect(g.state.tally.deaths.starvation ?? 0).toBe(0);
    });
  }
});

/** Finish a placed building immediately (test shortcut). */
function complete(g: Game, b: Building): void {
  b.state = 'active';
  b.progress = 1;
  b.delivered = { ...b.cost };
  b.incoming = {};
  b.workRemaining = 0;
  b.builtAt = g.state.time.elapsed;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const i = zz * g.state.W + xx;
      if (g.state.tiles.feature[i]) g.removeFeature(i);
    }
  }
  g.state.rev.buildings++;
  g.rt.dirty = true;
}

describe('integration: stalls', () => {
  it('laborers keep working when a full buffer has nowhere to go (barn destroyed)', () => {
    const g = Game.create(settings({ seed: 4242, mapSize: 'medium', difficulty: 'medium' }));
    const c = g.townCenter();
    const hut = place(g, 'gathererHut', c.x, c.z, { maxR: 30 });
    expect(hut).not.toBeNull();
    complete(g, hut!);
    g.setWorkers(hut!.id, 0);
    hut!.inventory.berries = BUILDINGS.gathererHut.bufferCapacity ?? 60;
    const barn = g.state.buildings.find((b) => b.type === 'storageBarn')!;
    g.removeBuilding(barn.id, 'tornado');
    expect(g.getBuilding(barn.id)?.state).toBe('ruin');
    // half the contents survive as salvage in the ruin; food salvage waits there to be eaten (no other barn), the
    // rest (tools, coats...) has nowhere to go: take the food out so the ruin can be cleared right away
    for (const k of Object.keys(barn.inventory)) if (FOOD_TYPES.includes(k as never)) delete barn.inventory[k as keyof typeof barn.inventory];
    // the laborers must clear the ruin right away; before the fix the unhaulable berry buffer was everyone's
    // "best job", so the whole town idled until hungry citizens had eaten the buffer empty (~100 s)
    for (let i = 0; i < 160 && g.getBuilding(barn.id); i++) g.step(0.25);
    expect(g.getBuilding(barn.id)).toBeUndefined();
    expect(g.validate()).toEqual([]);
  });

  it('a priority workplace takes workers from non-priority ones when no laborers are free', () => {
    const g = Game.create(settings({ seed: 99, mapSize: 'medium', difficulty: 'medium' }));
    const c = g.townCenter();
    g.setBuilders(0);
    const hut = place(g, 'gathererHut', c.x, c.z, { maxR: 30 })!;
    const lodge = place(g, 'foresterLodge', c.x, c.z, { maxR: 30 })!;
    complete(g, hut);
    complete(g, lodge);
    // the forester lodge is staffed first, every other adult becomes a builder: no laborers are left
    g.setWorkers(hut.id, 0);
    g.setWorkers(lodge.id, BUILDINGS.foresterLodge.maxWorkers);
    for (let i = 0; i < 8; i++) g.step(0.25);
    expect(lodge.workerIds.length).toBe(BUILDINGS.foresterLodge.maxWorkers);
    g.setBuilders(999);
    for (let i = 0; i < 8; i++) g.step(0.25);
    expect(g.state.citizens.filter((x) => x.profession === 'laborer').length).toBe(0);
    // now the gatherer hut becomes a priority workplace that wants 3 workers: they come from the lodge
    g.setWorkers(hut.id, 3);
    g.setPriority(hut.id, true);
    for (let i = 0; i < 24; i++) g.step(0.25);
    expect(hut.workerIds.length).toBe(3);
    expect(lodge.workerIds.length).toBe(BUILDINGS.foresterLodge.maxWorkers - 3);
    for (const id of hut.workerIds) expect(g.getCitizen(id)?.profession).toBe('gatherer');
    // without priority the hut would not take anyone: the lodge keeps its remaining forester
    g.setPriority(hut.id, false);
    g.setWorkers(hut.id, 4);
    for (let i = 0; i < 24; i++) g.step(0.25);
    expect(lodge.workerIds.length).toBe(BUILDINGS.foresterLodge.maxWorkers - 3);
    expect(g.validate()).toEqual([]);
  });
});
