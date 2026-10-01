import { it } from 'vitest';
import { Bot } from '../../tests/simcore.bot';
import { brainOf } from '../../src/sim/core/tasks';
import { Game, settings, steps, log } from './helpers';

it('find first rng divergence after load', () => {
  const g = Game.create(settings({ difficulty: 'medium', disasters: false, seed: 99 }));
  const bot = new Bot(g);
  steps(g, 600.1, 0.25, () => bot.tick());
  const h = Game.fromSave(g.save());
  for (let i = 0; i < 400; i++) {
    g.rngTrace = []; h.rngTrace = [];
    const before = JSON.stringify(g.state.citizens.map((c) => [c.id, c.x, c.z, c.food, c.warmth, c.health, c.happiness]));
    const beforeH = JSON.stringify(h.state.citizens.map((c) => [c.id, c.x, c.z, c.food, c.warmth, c.health, c.happiness]));
    g.step(0.25); h.step(0.25);
    const a = g.rngTrace, b = h.rngTrace;
    let k = 0;
    while (k < Math.max(a.length, b.length) && a[k] === b[k]) k++;
    if (k < Math.max(a.length, b.length)) {
      log('step', i, 't', g.state.time.elapsed, 'state equal before step?', before === beforeH);
      log('first diff at', k, 'g:', a.slice(Math.max(0, k - 2), k + 3), '\nh:', b.slice(Math.max(0, k - 2), k + 3));
      const m = /^c(\d+):/.exec(a[k] ?? b[k] ?? '');
      if (m) {
        const id = +m[1];
        const cg = g.getCitizen(id)!, ch = h.getCitizen(id)!;
        log('citizen g', JSON.stringify({ ...cg, task: undefined }), '\nbrain g', JSON.stringify(brainOf(cg)));
        log('citizen h', JSON.stringify({ ...ch, task: undefined }), '\nbrain h', JSON.stringify(brainOf(ch)));
      }
      // compare state deeply to find differing fields
      const sg = JSON.parse(g.save()), sh = JSON.parse(h.save());
      const diffs: string[] = [];
      const walk = (x: unknown, y: unknown, p: string) => {
        if (diffs.length > 20) return;
        if (typeof x !== typeof y) { diffs.push(p); return; }
        if (x && typeof x === 'object') { for (const key of new Set([...Object.keys(x as object), ...Object.keys(y as object)])) walk((x as any)[key], (y as any)[key], p + '.' + key); return; }
        if (x !== y) diffs.push(`${p}: ${String(x).slice(0, 40)} vs ${String(y).slice(0, 40)}`);
      };
      walk(sg, sh, '');
      log('state diffs after step', diffs);
      break;
    }
  }
});
