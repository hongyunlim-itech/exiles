import { describe, expect, it } from 'vitest';
import { forceBuild, Game, settings, steps } from './helpers';
import { log } from './helpers';

describe('pasture', () => {
  it('toggling the livestock type spawns free animals and meat every click', () => {
    const g = Game.create(settings({ difficulty: 'easy' })); // chicken + sheep unlocked
    const p = forceBuild(g, 'pasture', undefined, undefined, 6, 6);
    const before = { ...p.inventory };
    for (let k = 0; k < 20; k++) {
      g.setCrop(p.id, 'sheep');
      g.setCrop(p.id, 'chicken');
    }
    log('before', before, 'after 20 toggles', p.inventory, 'livestock', p.livestock);
    // 20 sheep herds of 2 animals conjured from nothing and slaughtered: 20*36 mutton + 20*7 chicken
    expect((p.inventory.mutton ?? 0) + (p.inventory.chicken ?? 0)).toBe(0);
  });

  it('two herders can slaughter a 3-head cattle herd down to 1, which then never breeds again', () => {
    const g = Game.create(settings({ difficulty: 'easy' }));
    g.state.unlocked.livestock.push('cattle');
    const p = forceBuild(g, 'pasture', undefined, undefined, 6, 7); // 42 tiles -> cattle cap 4, cull at >= 3
    g.setCrop(p.id, 'cattle');
    p.livestock!.count = 3;
    g.setWorkers(p.id, 2);
    let min = 3;
    steps(g, 90, 0.25, () => { if (p.livestock) min = Math.min(min, p.livestock.count); });
    const afterCull = p.livestock!.count;
    // one more summer of breeding (months 0..8 breed)
    steps(g, 360, 0.25, () => { if (p.livestock) min = Math.min(min, p.livestock.count); });
    log('workers', p.workerIds.length, 'min count', min, 'after cull', afterCull, 'after 6 months', p.livestock, 'month', g.state.time.month);
    expect(min).toBeGreaterThanOrEqual(2);
  });
});
