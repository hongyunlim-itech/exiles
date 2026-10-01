// Offline (deterministic) level calibration: renders every sound through the real AudioEngine/mix buses in an
// OfflineAudioContext inside Chromium and reports peak / RMS in dBFS at the default volume settings.
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:5205';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${base}/dev/input/index.html`);
await page.waitForFunction(() => window.__sb?.ready, null, { timeout: 60000 });
const report = await page.evaluate(async () => {
  const { AudioEngine } = await import('/src/audio/engine.ts');
  const sfx = await import('/src/audio/sfx.ts');
  const { AmbientBed, AMBIENT_LEVELS } = await import('/src/audio/ambient.ts');
  const { SFX_CUES, UI_CUE_DEFS } = await import('/src/audio/audio.ts');
  const { DEFAULT_SETTINGS } = await import('/src/core/app.ts');
  const sr = 44100;
  const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
  function levels(buf, from = 0) {
    const d = buf.getChannelData(0);
    const d2 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d;
    let peak = 0; let sum = 0; let n = 0;
    for (let i = Math.floor(from * sr); i < d.length; i++) {
      const v = Math.max(Math.abs(d[i]), Math.abs(d2[i]));
      if (v > peak) peak = v;
      sum += d[i] * d[i]; n++;
    }
    return { peak: db(peak), rms: db(Math.sqrt(sum / Math.max(1, n))) };
  }
  function makeEngine(seconds) {
    const ctx = new OfflineAudioContext(2, Math.floor(sr * seconds), sr);
    const e = new AudioEngine(ctx, 8);
    const s = DEFAULT_SETTINGS;
    e.master.gain.value = s.masterVolume * s.masterVolume;
    e.sfx.gain.value = s.sfxVolume * s.sfxVolume;
    e.ambient.gain.value = s.ambientVolume * s.ambientVolume * 0.9;
    return e;
  }
  const out = {};
  // one-shot cues at their manager gains (UI: def gain; world: def gain × positional 1.0)
  const cues = {};
  for (const [k, d] of Object.entries(UI_CUE_DEFS)) cues[`ui ${k}`] = [d.play, d.gain];
  for (const [k, d] of Object.entries(SFX_CUES)) if (k !== 'bell') cues[k] = [d.play, d.gain];
  for (const [name, [fn, gain]] of Object.entries(cues)) {
    const e = makeEngine(name === 'death' ? 7 : 3);
    fn(e.voice(2, gain), 0.05);
    out[name] = levels(await e.ctx.startRendering());
  }
  // ambient one-shots (their own gains inside AmbientBed are ~0.035-0.095 birds, 0.012-0.032 crickets)
  const L = AMBIENT_LEVELS;
  for (const [name, fn, g] of [['bird (mid gain)', sfx.birdSong, (L.birdMin + L.birdMax) / 2], ['cricket (mid gain)', sfx.cricketChirp, (L.cricketMin + L.cricketMax) / 2]]) {
    const e = makeEngine(3);
    fn(e.freeVoice(g, 0, e.ambient), 0.05);
    out[name] = levels(await e.ctx.startRendering());
  }
  // ambient beds at representative targets (measure the steady-state last 2 s of 4 s)
  const beds = {
    'wind calm (summer, near)': { wind: 0.25, windBright: 0.4, rain: 0, water: 0, birdRate: 0, cricketRate: 0 },
    'wind winter (far)': { wind: 0.9, windBright: 0.8, rain: 0, water: 0, birdRate: 0, cricketRate: 0 },
    'rain heavy': { wind: 0.3, windBright: 0.4, rain: 1, water: 0, birdRate: 0, cricketRate: 0 },
    'water near': { wind: 0.25, windBright: 0.4, rain: 0, water: 1, birdRate: 0, cricketRate: 0 },
  };
  for (const [name, tg] of Object.entries(beds)) {
    const e = makeEngine(4);
    const bed = new AmbientBed(e);
    bed.update(0.2, tg);
    out[name] = levels(await e.ctx.startRendering(), 2);
  }
  return out;
});
for (const [k, v] of Object.entries(report)) console.log(k.padEnd(26), `peak ${v.peak.padStart(6)} dB   rms ${v.rms.padStart(6)} dB`);
await browser.close();
