// Same as simstep.mjs (profile on every step) but with emit/addMessage wrappers to catch the stall source.
import { open } from './lib.mjs';
const { browser, page, logs } = await open({ settings: { quality: 'low', shadows: false } });
const out = await page.evaluate(async () => {
  const g = window.__app.game;
  const slow = [];
  const origEmit = g.events.emit.bind(g.events);
  g.events.emit = (name, p) => { const t = performance.now(); const r = origEmit(name, p); const ms = performance.now() - t; if (ms > 20) slow.push({ what: 'emit:' + name, ms: +ms.toFixed(1), el: g.state.time.elapsed }); return r; };
  const origAdd = g.addMessage.bind(g);
  g.addMessage = (...a) => { const t = performance.now(); const r = origAdd(...a); const ms = performance.now() - t; if (ms > 20) slow.push({ what: 'addMessage:' + String(a[0]).slice(0, 50) + ':' + a[1], ms: +ms.toFixed(1) }); return r; };
  const rows = [];
  for (let i = 0; i < 800; i++) {
    g.profile = {};
    const t0 = performance.now(); g.step(0.25); const t = performance.now() - t0;
    if (t > 1000) rows.push({ i, t: +t.toFixed(1), el: g.state.time.elapsed, prof: Object.fromEntries(Object.entries(g.profile).filter(([, v]) => v > 5)) });
    if (i % 200 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  g.profile = null;
  return { rows, slow, msgs: g.state.messages.slice(-4).map((m) => m.severity + ' ' + m.text.slice(0, 70)) };
});
console.log(JSON.stringify(out, null, 1));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
