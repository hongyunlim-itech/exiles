import { describe, expect, it } from 'vitest';
import { brainOf } from '../../src/sim/core/tasks';
import { forceBuild, Game, settings, steps, log } from './helpers';

describe('workers cut off from their workplace', () => {
  it('are never released and burn a plan + a path search every step', () => {
    const g = Game.create(settings({ difficulty: 'easy', seed: 4242 }));
    const s = g.state;
    const shops = [forceBuild(g, 'woodcutter'), forceBuild(g, 'school'), forceBuild(g, 'blacksmith')];
    for (const b of shops) g.setWorkers(b.id, 2);
    steps(g, 5);
    const workers = shops.flatMap((b) => b.workerIds.map((id) => g.getCitizen(id)!));
    // find a walkable tile in another region (other river bank) and put the workers there — this is what removing
    // the only bridge does to people who were on the far side
    const c0 = g.townCenter();
    const home = s.tiles.region[Math.floor(c0.z) * s.W + Math.floor(c0.x)];
    let far = -1;
    for (let i = 0; i < s.W * s.H && far < 0; i++) if (s.tiles.region[i] > 0 && s.tiles.region[i] !== home && g.isWalkableTile(i)) {
      // prefer a decent-size region
      let n = 0; for (let j = 0; j < s.W * s.H; j++) if (s.tiles.region[j] === s.tiles.region[i]) n++;
      if (n > 200) far = i;
    }
    expect(far).toBeGreaterThanOrEqual(0);
    for (const c of workers) { g.abortTask(c); c.x = (far % s.W) + 0.5; c.z = Math.floor(far / s.W) + 0.5; }
    g.profile = {};
    steps(g, 60);
    const prof = g.profile!;
    const stillAssigned = workers.filter((c) => c.workplaceId >= 0).length;
    const labels = workers.map((c) => `${c.profession}:${brainOf(c).cur?.label ?? '-'}`);
    log('workers', workers.length, 'still assigned', stillAssigned, 'plans/s', ((prof['plan.n'] ?? 0) / 60).toFixed(1), 'paths/s', ((prof['path.n'] ?? 0) / 60).toFixed(1), labels);
    g.profile = {};
    for (const c of workers) { c.x = c0.x; c.z = c0.z; g.abortTask(c); }
    steps(g, 60);
    log('control (same town, workers back home): plans/s', ((g.profile!['plan.n'] ?? 0) / 60).toFixed(1), 'paths/s', ((g.profile!['path.n'] ?? 0) / 60).toFixed(1));
    expect(stillAssigned).toBe(0);
  });
});
