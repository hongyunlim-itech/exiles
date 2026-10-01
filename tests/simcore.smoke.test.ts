import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { log, run, settings, stuckReport } from './simcore.helpers';

describe('simcore smoke', () => {
  it('creates and steps a medium game', () => {
    const t0 = performance.now();
    const g = Game.create(settings());
    const t1 = performance.now();
    log('create ms', (t1 - t0).toFixed(1), 'citizens', g.state.citizens.length, 'buildings', g.state.buildings.map((b) => b.type).join(','));
    expect(g.state.citizens.length).toBeGreaterThan(0);
    expect(g.validate()).toEqual([]);
    run(g, 120);
    const t2 = performance.now();
    log('120s ms', (t2 - t1).toFixed(1), 'errors', JSON.stringify(g.moduleErrors()));
    log(g.state.citizens.map((c) => `${c.name} ${c.profession} ${c.activity} ${c.taskLabel} food=${c.food.toFixed(0)}`).join('\n'));
    log('validate', g.validate().slice(0, 10));
    log('stuck', stuckReport(g));
    log('totals', JSON.stringify(g.resourceTotals()));
  });
});
