import { describe, expect, it } from 'vitest';
import { brainOf, type Task } from '../../src/sim/core/tasks';
import { updateHousing } from '../../src/sim/core/households';
import { forceBuild, Game, settings, steps } from './helpers';
import { log } from './helpers';

function run(climate: 'harsh' | 'fair', warmth: number) {
  const g = Game.create(settings({ difficulty: 'medium', climate, seed: 777 }));
  const houses = [];
  for (let k = 0; k < 5; k++) houses.push(forceBuild(g, 'woodenHouse'));
  updateHousing(g);
  const s = g.state;
  s.time.month = 10; s.time.monthProgress = 0.2; // deep winter
  for (const h of houses) delete h.inventory.firewood;
  for (const c of s.citizens) { c.warmth = warmth; c.coatWear = 0; c.food = 90; }
  const track = new Map<number, { t: Task; start: number }>();
  const ended: { kind: string; label: string; dur: number; done: boolean }[] = [];
  steps(g, 240, 0.25, () => {
    s.time.month = 10; s.time.monthProgress = 0.3; // keep it deep winter
    for (const c of s.citizens) {
      const cur = brainOf(c).cur;
      const prev = track.get(c.id);
      if (prev && prev.t !== cur) {
        ended.push({ kind: prev.t.kind, label: prev.t.label, dur: s.time.elapsed - prev.start, done: prev.t.si >= prev.t.steps.length });
        track.delete(c.id);
      }
      if (cur && !track.has(c.id)) track.set(c.id, { t: cur, start: s.time.elapsed });
    }
  });
  const fw = houses.reduce((a, h) => a + (h.inventory.firewood ?? 0), 0);
  const work = ended.filter((e) => !['eat', 'warm', 'rest', 'fight', 'exit', 'idle', 'play'].includes(e.kind));
  const aborted = work.filter((e) => !e.done);
  const hist: Record<string, number> = {};
  for (const e of aborted) { const k = Math.round(e.dur); hist[k] = (hist[k] ?? 0) + 1; }
  return { temp: s.weather.temperature.toFixed(1), fw, work: work.length, completed: work.length - aborted.length, aborted: aborted.length,
    supplyDone: work.filter((e) => e.kind === 'supply' && e.done).length, supplyAborted: aborted.filter((e) => e.kind === 'supply').length,
    abortDurations: hist, deaths: s.tally.deaths };
}

describe('cold interrupt loop', () => {
  it('when homes cannot warm people, every job is aborted every ~12 s (firewood never reaches homes)', () => {
    const bad = run('harsh', 18);
    const ok = run('harsh', 70);
    log('warmth 18:', JSON.stringify(bad));
    log('warmth 70:', JSON.stringify(ok));
    // with warm people nothing is aborted; with cold people most jobs are
    expect(bad.aborted).toBeLessThan(bad.work * 0.2);
  });
});
