import { describe, expect, it } from 'vitest';
import { brainOf } from '../../src/sim/core/tasks';
import { forceBuild, Game, settings, steps } from './helpers';
import { log } from './helpers';

describe('long work steps vs the task watchdog', () => {
  it('an elderly smith without a tool (happiness 45) can never finish a batch of tools', () => {
    const g = Game.create(settings({ difficulty: 'medium' }));
    const smith = forceBuild(g, 'blacksmith');
    // no tools left in town (the situation where the blacksmith matters most)
    g.takeFromStorage('tool', 1e9);
    g.addToStorage('iron', 50);
    g.setWorkers(smith.id, 1);
    let worker: ReturnType<typeof g.getCitizen> | undefined;
    const labels = new Map<string, number>();
    let fails = 0;
    let lastAge = 0;
    steps(g, 900, 0.25, () => {
      if (!worker && smith.workerIds.length > 0) {
        worker = g.getCitizen(smith.workerIds[0]);
        if (worker) { worker.age = 62; worker.lifespan = 90; worker.toolWear = 0; }
      }
      if (worker) {
        worker.happiness = 45; // pinned: typical for an elderly worker without chapel/tavern
        worker.toolWear = 0;
        const t = brainOf(worker).cur;
        if (t) { labels.set(t.label, (labels.get(t.label) ?? 0) + 1); if (t.label.startsWith('Making') && t.age < lastAge) fails++; lastAge = t.age; }
      }
    });
    const made = smith.producedThisYear.tool ?? 0;
    log('tools made', made, 'smith inv', smith.inventory, 'craft restarts', fails, [...labels.entries()].slice(0, 6));
    expect(made).toBeGreaterThan(0);
  });
});
