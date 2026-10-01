// Localise the deterministic stats-phase freeze: step to just before it, then time the pieces.
import { open } from './lib.mjs';

const { browser, page, logs } = await open({ settings: { quality: 'low', shadows: false } });
const out = await page.evaluate(async () => {
  const g = window.__app.game;
  for (let i = 0; i < 779; i++) { g.step(0.25); if (i % 200 === 0) await new Promise((r) => setTimeout(r, 0)); }
  const adv = await import('/src/sim/ext/advisors.ts');
  const res = { el: g.state.time.elapsed };
  let t0 = performance.now(); const notices = adv.collectNotices(g); res.collectMs = +(performance.now() - t0).toFixed(1);
  res.notices = notices.map((n) => n.key + ':' + n.severity);
  // wrap addMessage + event listeners
  const origAdd = g.addMessage.bind(g);
  const calls = [];
  g.addMessage = (...a) => { const t = performance.now(); const r = origAdd(...a); calls.push({ text: String(a[0]).slice(0, 60), ms: +(performance.now() - t).toFixed(1) }); return r; };
  const origEmit = g.events.emit.bind(g.events);
  const emits = [];
  g.events.emit = (name, p) => { const t = performance.now(); const r = origEmit(name, p); const ms = performance.now() - t; if (ms > 5) emits.push({ name, ms: +ms.toFixed(1) }); return r; };
  g.profile = {};
  t0 = performance.now(); g.step(0.25); res.stepMs = +(performance.now() - t0).toFixed(1);
  res.prof = g.profile; g.profile = null;
  res.addMessage = calls; res.slowEmits = emits;
  res.messages = g.state.messages.slice(-3).map((m) => m.text.slice(0, 80));
  return res;
});
console.log(JSON.stringify(out, null, 1));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
