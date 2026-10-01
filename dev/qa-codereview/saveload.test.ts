import { describe, expect, it } from 'vitest';
import { Bot } from '../../tests/simcore.bot';
import { rt } from '../../src/sim/ext/runtime';
import { Game, settings, steps, log } from './helpers';

function diverge(disasters: boolean, saveAt: number) {
  const g = Game.create(settings({ difficulty: 'medium', disasters, seed: 99 }));
  const bot = new Bot(g);
  steps(g, saveAt, 0.25, () => bot.tick());
  const h = Game.fromSave(g.save());
  let firstDiff = -1;
  for (let i = 0; i < 2400; i++) {
    g.step(0.25); h.step(0.25);
    if (firstDiff < 0 && g.rng.state !== h.rng.state) firstDiff = i * 0.25;
  }
  return { firstDiff, pop: [g.state.citizens.length, h.state.citizens.length] };
}

describe('save/load', () => {
  it('continues identically (rng stream) after load', () => {
    const off = diverge(false, 600.1);
    const on = diverge(true, 600.1);
    log('disasters off: first rng divergence at', off.firstDiff, 's', off.pop, '| disasters on:', on.firstDiff, 's', on.pop);
    expect(on.firstDiff).toBe(-1);
  });

  it('advisor cooldowns / disease immunity are runtime-only', () => {
    const g = Game.create(settings({ difficulty: 'medium', seed: 5 }));
    steps(g, 60);
    // make an advisor condition true: no builders while a site exists, lots of homeless (medium start = no houses)
    g.setBuilders(0);
    g.placeBuilding('woodenHouse', Math.floor(g.townCenter().x) + 12, Math.floor(g.townCenter().z) + 12, 0);
    steps(g, 20);
    const n0 = g.state.messages.length;
    steps(g, 60);
    const perMinuteLive = g.state.messages.length - n0;
    const h = Game.fromSave(g.save());
    const m0 = h.state.messages.length;
    steps(h, 60);
    const perMinuteAfterLoad = h.state.messages.length - m0;
    const texts = h.state.messages.slice(m0).map((m) => m.text.slice(0, 50));
    // immunity
    const c = g.state.citizens[0];
    rt(g).immuneUntil.set(c.id, g.state.time.elapsed + 600);
    const h2 = Game.fromSave(g.save());
    log('messages in next minute: live', perMinuteLive, 'after load', perMinuteAfterLoad, texts, '| immunity entries live', rt(g).immuneUntil.size, 'after load', rt(h2).immuneUntil.size);
    expect(perMinuteAfterLoad).toBeLessThanOrEqual(perMinuteLive);
  });
});
