/** Trace for the cold-interrupt livelock: prints every aborted (non-idle) task in a harsh winter with empty home hearths. */
import { it } from 'vitest';
import { brainOf, type Task } from '../../src/sim/core/tasks';
import { updateHousing } from '../../src/sim/core/households';
import { forceBuild, Game, settings, steps, log } from './helpers';

it('trace aborted tasks when homes cannot warm people', () => {
  const g = Game.create(settings({ difficulty: 'medium', climate: 'harsh', seed: 777 }));
  const houses = [];
  for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
  updateHousing(g);
  const s = g.state;
  for (const h of houses) delete h.inventory.firewood;
  for (const c of s.citizens) { c.warmth = 18; c.coatWear = 0; c.food = 90; }
  const track = new Map<number, { t: Task; start: number }>();
  let n = 0;
  steps(g, 200, 0.25, () => {
    s.time.month = 10; s.time.monthProgress = 0.3;
    for (const c of s.citizens) {
      const cur = brainOf(c).cur;
      const p = track.get(c.id);
      if (p && p.t !== cur) {
        if (p.t.si < p.t.steps.length && !['idle', 'play', 'warm', 'eat'].includes(p.t.kind) && n++ < 40) log(`t=${s.time.elapsed.toFixed(1)} c${c.id} ${c.profession} ABORT after ${(s.time.elapsed - p.start).toFixed(1)}s ${p.t.kind} "${p.t.label}" si=${p.t.si}/${p.t.steps.length} warmth ${c.warmth.toFixed(1)} home=${c.homeId}`);
        track.delete(c.id);
      }
      if (cur && !track.has(c.id)) track.set(c.id, { t: cur, start: s.time.elapsed });
    }
  });
  log('house firewood', houses.map((h) => `${h.id}:${(h.inventory.firewood ?? 0).toFixed(0)}`), 'deaths', s.tally.deaths, 'temp', s.weather.temperature.toFixed(1));
});
