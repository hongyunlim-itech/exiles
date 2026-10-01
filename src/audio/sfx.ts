/**
 * Procedural sound effects. Each function schedules one sound into an allocated Voice starting at context time t.
 * Everything is synthesized from oscillators, filtered noise and gain envelopes — no audio files.
 */
import type { Voice } from './engine';

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

/** Semitone multiplier. */
const semi = (n: number): number => Math.pow(2, n / 12);

// -----------------------------------------------------------------------------------------------
// Work & world sounds
// -----------------------------------------------------------------------------------------------

/** Axe biting into wood: low thump + woody crack + short resonance. */
export function chop(v: Voice, t: number): void {
  const pitch = rnd(0.9, 1.12);
  const thump = v.osc('sine', 150 * pitch, t, t + 0.2);
  thump.frequency.exponentialRampToValueAtTime(60 * pitch, t + 0.1);
  thump.connect(v.env(t, 0.002, 0.9, 0.14));

  const crack = v.noise(t, t + 0.12, rnd(0.9, 1.1));
  v.chain(crack, v.filter('bandpass', rnd(1300, 1900), 1.3), v.env(t, 0.001, 0.75, 0.07));

  const wood = v.osc('triangle', rnd(340, 420) * pitch, t, t + 0.2);
  wood.connect(v.env(t, 0.002, 0.22, 0.12));
}

/** Mallet on timber with a faint nail ping. */
export function hammer(v: Voice, t: number): void {
  const knock = v.osc('triangle', rnd(680, 880), t, t + 0.12);
  knock.frequency.exponentialRampToValueAtTime(rnd(420, 520), t + 0.06);
  knock.connect(v.env(t, 0.001, 0.5, 0.07));

  const click = v.noise(t, t + 0.05);
  v.chain(click, v.filter('highpass', 2600, 0.7), v.env(t, 0.001, 0.35, 0.025));

  const ping = v.osc('sine', rnd(2100, 2700), t, t + 0.25);
  ping.connect(v.env(t, 0.001, 0.07, 0.18));
}

/** Spade/pick into earth and stone: filtered scrape + pebble ticks (+ occasional stone clink). */
export function dig(v: Voice, t: number): void {
  const scrape = v.noise(t, t + 0.35, rnd(0.8, 1));
  const bp = v.filter('bandpass', 900, 0.9);
  bp.frequency.setValueAtTime(rnd(800, 1000), t);
  bp.frequency.exponentialRampToValueAtTime(rnd(350, 450), t + 0.22);
  v.chain(scrape, bp, v.env(t, 0.02, 0.6, 0.22));

  const pebbles = v.noise(t + 0.04, t + 0.2);
  const hp = v.filter('highpass', 3200, 0.8);
  pebbles.connect(hp);
  hp.connect(v.env(t + 0.05, 0.001, 0.2, 0.035));
  hp.connect(v.env(t + 0.11, 0.001, 0.14, 0.03));

  if (Math.random() < 0.45) {
    const clink = v.osc('sine', rnd(1700, 2300), t + 0.01, t + 0.2);
    clink.connect(v.env(t + 0.01, 0.001, 0.12, 0.12));
  }
}

/** Water splash: noise with a falling lowpass + a couple of bubbles. */
export function splash(v: Voice, t: number): void {
  const n = v.noise(t, t + 0.7, rnd(0.9, 1.1));
  const lp = v.filter('lowpass', 5000, 0.5);
  lp.frequency.setValueAtTime(rnd(4000, 6000), t);
  lp.frequency.exponentialRampToValueAtTime(350, t + 0.5);
  v.chain(n, lp, v.env(t, 0.006, 0.75, 0.5));

  const bubbles = 2 + Math.floor(Math.random() * 3);
  for (let k = 0; k < bubbles; k++) {
    const bt = t + rnd(0.05, 0.35);
    const b = v.osc('sine', rnd(350, 550), bt, bt + 0.08);
    b.frequency.exponentialRampToValueAtTime(rnd(900, 1400), bt + 0.05);
    b.connect(v.env(bt, 0.003, 0.12, 0.05));
  }
}

/** Crackling fire: low roar + random sharp crackles. */
export function fire(v: Voice, t: number): void {
  const roar = v.noise(t, t + 1.2, 0.6);
  v.chain(roar, v.filter('lowpass', 260, 0.7), v.env(t, 0.12, 0.4, 0.9));

  const crack = v.noise(t, t + 1.0, 1.2);
  const bp = v.filter('bandpass', rnd(2200, 3600), 1.4);
  crack.connect(bp);
  const n = 6 + Math.floor(Math.random() * 6);
  for (let k = 0; k < n; k++) bp.connect(v.env(t + rnd(0, 0.85), 0.001, rnd(0.2, 0.65), rnd(0.008, 0.025)));
}

/** One bell strike from inharmonic partials. */
function bellStrike(v: Voice, t: number, f0: number, ratios: number[], gains: number[], decays: number[], level: number): void {
  for (let k = 0; k < ratios.length; k++) {
    const o = v.osc('sine', f0 * ratios[k], t, t + decays[k] + 0.1);
    o.connect(v.env(t, 0.002, gains[k] * level, decays[k]));
  }
  const clang = v.noise(t, t + 0.05);
  v.chain(clang, v.filter('bandpass', f0 * 3, 2), v.env(t, 0.001, 0.25 * level, 0.03));
}

/** Alarm bell (fire): three quick strikes of a small bright bell. */
export function alarmBell(v: Voice, t: number): void {
  const ratios = [1, 2.0, 2.76, 5.4, 8.93];
  const gains = [0.5, 0.3, 0.22, 0.1, 0.05];
  const decays = [1.3, 1.0, 0.8, 0.4, 0.25];
  for (let s = 0; s < 3; s++) bellStrike(v, t + s * 0.42, 880, ratios, gains, decays, s === 0 ? 1 : 0.85);
}

/** Generic 'bell' cue from the sim (single chapel-like bell). */
export function bell(v: Voice, t: number): void {
  bellStrike(v, t, 587.3, [0.5, 1, 1.2, 1.5, 2, 2.5], [0.25, 0.5, 0.3, 0.2, 0.22, 0.08], [2.2, 1.8, 1.4, 1.1, 0.9, 0.5], 0.8);
}

/** Funeral toll: a low church bell struck twice. */
export function deathToll(v: Voice, t: number): void {
  const f0 = 196; // G3
  const ratios = [0.5, 1, 1.003, 1.2, 1.5, 2, 2.5, 3];
  const gains = [0.32, 0.45, 0.25, 0.3, 0.2, 0.24, 0.08, 0.05];
  const decays = [4.0, 3.2, 3.2, 2.5, 2.0, 1.6, 1.0, 0.8];
  bellStrike(v, t, f0, ratios, gains, decays, 0.9);
  bellStrike(v, t + 2.1, f0, ratios, gains, decays, 0.6);
}

/** Birth: a soft rising chime arpeggio. */
export function birthChime(v: Voice, t: number): void {
  const notes = [1046.5, 1318.5, 1568, 2093];
  for (let k = 0; k < notes.length; k++) {
    const nt = t + k * 0.09;
    const o = v.osc('sine', notes[k], nt, nt + 1.1);
    o.connect(v.env(nt, 0.005, 0.32, 0.9));
    const h = v.osc('triangle', notes[k] * 2, nt, nt + 0.5);
    h.connect(v.env(nt, 0.005, 0.05, 0.35));
  }
}

/** Construction complete: two wooden knocks, then a bright two-note chime. */
export function buildComplete(v: Voice, t: number): void {
  for (let k = 0; k < 2; k++) {
    const kt = t + k * 0.11;
    const knock = v.osc('triangle', 620 - k * 90, kt, kt + 0.12);
    knock.frequency.exponentialRampToValueAtTime(380, kt + 0.06);
    knock.connect(v.env(kt, 0.001, 0.45, 0.07));
  }
  const n1 = v.osc('sine', 784, t + 0.24, t + 1.0);
  n1.connect(v.env(t + 0.24, 0.004, 0.3, 0.6));
  const n2 = v.osc('sine', 1046.5, t + 0.36, t + 1.3);
  n2.connect(v.env(t + 0.36, 0.004, 0.32, 0.85));
  const sp = v.osc('triangle', 2093, t + 0.36, t + 0.8);
  sp.connect(v.env(t + 0.36, 0.004, 0.05, 0.4));
}

/** Merchant horn: two sustained brassy notes with vibrato. */
export function merchantHorn(v: Voice, t: number): void {
  const notes: Array<[number, number, number]> = [[220, 0, 0.55], [329.6, 0.6, 0.9]];
  const lp = v.filter('lowpass', 1100, 1.2);
  const master = v.gain(1);
  v.chain(lp, master, v.out);
  for (const [f, start, dur] of notes) {
    const nt = t + start;
    const g = v.gain(0);
    g.gain.setValueAtTime(0, nt);
    g.gain.linearRampToValueAtTime(0.4, nt + 0.08);
    g.gain.linearRampToValueAtTime(0.32, nt + 0.25);
    g.gain.setValueAtTime(0.32, nt + dur - 0.15);
    g.gain.linearRampToValueAtTime(0, nt + dur);
    g.connect(lp);
    for (const det of [1, 1.006]) {
      const o = v.osc('sawtooth', f * det, nt, nt + dur + 0.05);
      const vib = v.osc('sine', 5.2, nt, nt + dur + 0.05);
      const depth = v.gain(f * 0.008);
      vib.connect(depth);
      depth.connect(o.frequency);
      o.connect(g);
    }
  }
}

// -----------------------------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------------------------

export function uiClick(v: Voice, t: number): void {
  v.osc('sine', 1500, t, t + 0.06).connect(v.env(t, 0.001, 0.3, 0.035));
  v.osc('triangle', 3000, t, t + 0.04).connect(v.env(t, 0.001, 0.06, 0.02));
}

export function uiPlace(v: Voice, t: number): void {
  const thunk = v.osc('sine', 170, t, t + 0.2);
  thunk.frequency.exponentialRampToValueAtTime(80, t + 0.1);
  thunk.connect(v.env(t, 0.002, 0.75, 0.14));
  const dust = v.noise(t, t + 0.1);
  v.chain(dust, v.filter('lowpass', 900, 0.7), v.env(t, 0.001, 0.35, 0.06));
  v.osc('triangle', 520, t, t + 0.12).connect(v.env(t, 0.001, 0.2, 0.07));
}

export function uiError(v: Voice, t: number): void {
  const lp = v.filter('lowpass', 1400, 0.8);
  lp.connect(v.out);
  const a = v.osc('square', 233, t, t + 0.14);
  const ea = v.gain(0);
  ea.gain.setValueAtTime(0.0001, t);
  ea.gain.linearRampToValueAtTime(0.22, t + 0.005);
  ea.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  a.connect(ea);
  ea.connect(lp);
  const b = v.osc('square', 185, t + 0.1, t + 0.26);
  const eb = v.gain(0);
  eb.gain.setValueAtTime(0.0001, t + 0.1);
  eb.gain.linearRampToValueAtTime(0.22, t + 0.105);
  eb.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  b.connect(eb);
  eb.connect(lp);
}

function sweep(v: Voice, t: number, f0: number, f1: number): void {
  const o = v.osc('sine', f0, t, t + 0.22);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
  o.connect(v.env(t, 0.005, 0.22, 0.16));
}

export function uiOpen(v: Voice, t: number): void {
  sweep(v, t, 520, 880);
}

export function uiClose(v: Voice, t: number): void {
  sweep(v, t, 880, 520);
}

export function uiNotify(v: Voice, t: number): void {
  const notes = [1318.5, 1760];
  for (let k = 0; k < notes.length; k++) {
    const nt = t + k * 0.11;
    v.osc('sine', notes[k], nt, nt + 0.6).connect(v.env(nt, 0.004, 0.25, 0.5));
    v.osc('triangle', notes[k] * 2, nt, nt + 0.3).connect(v.env(nt, 0.004, 0.04, 0.2));
  }
}

export function uiDanger(v: Voice, t: number): void {
  const lp = v.filter('lowpass', 900, 1);
  lp.connect(v.out);
  for (let k = 0; k < 2; k++) {
    const pt = t + k * 0.28;
    const o = v.osc('sawtooth', 196, pt, pt + 0.26);
    const e = v.gain(0);
    e.gain.setValueAtTime(0.0001, pt);
    e.gain.linearRampToValueAtTime(0.3, pt + 0.01);
    e.gain.exponentialRampToValueAtTime(0.0001, pt + 0.24);
    o.connect(e);
    e.connect(lp);
    v.osc('sine', 98, pt, pt + 0.26).connect(v.env(pt, 0.01, 0.25, 0.22));
  }
}

// -----------------------------------------------------------------------------------------------
// Ambient one-shots
// -----------------------------------------------------------------------------------------------

/** A short bird song (one oscillator with per-note pitch & gain automation). Returns its duration. */
export function birdSong(v: Voice, t: number): number {
  const o = v.osc('sine', 3000, t, t + 3);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  o.connect(g);
  g.connect(v.out);
  const base = rnd(2300, 4300);
  const kind = Math.random();
  let nt = t;
  if (kind < 0.4) {
    // tweets: rising chirps
    const n = 2 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n; k++) {
      const f = base * rnd(0.9, 1.15);
      const d = rnd(0.05, 0.09);
      o.frequency.setValueAtTime(f, nt);
      o.frequency.exponentialRampToValueAtTime(f * rnd(1.2, 1.5), nt + d);
      note(g, nt, d, rnd(0.6, 1));
      nt += d + rnd(0.06, 0.13);
    }
  } else if (kind < 0.7) {
    // trill: fast repeated notes, slightly falling
    const n = 6 + Math.floor(Math.random() * 8);
    const period = rnd(0.045, 0.065);
    for (let k = 0; k < n; k++) {
      const f = base * (1 - k * 0.012);
      o.frequency.setValueAtTime(f * 1.08, nt);
      o.frequency.exponentialRampToValueAtTime(f, nt + period * 0.6);
      note(g, nt, period * 0.6, 0.8);
      nt += period;
    }
  } else {
    // warble: alternating pitches with glides
    const n = 4 + Math.floor(Math.random() * 5);
    const hi = base * semi(rnd(3, 5));
    for (let k = 0; k < n; k++) {
      const f = k % 2 === 0 ? base : hi;
      const d = rnd(0.07, 0.1);
      o.frequency.setValueAtTime(f, nt);
      o.frequency.linearRampToValueAtTime(k % 2 === 0 ? hi : base, nt + d);
      note(g, nt, d, rnd(0.6, 0.9));
      nt += d + 0.02;
    }
  }
  const end = nt + 0.05;
  v.stopAt(o, end);
  return end - t;
}

function note(g: GainNode, t: number, d: number, level: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(level, t + Math.min(0.012, d * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
}

/** A cricket chirp burst: a few quick pulses of a high sine, repeated in 1–3 groups. Returns its duration. */
export function cricketChirp(v: Voice, t: number): number {
  const f = rnd(4100, 4900);
  const o = v.osc('sine', f, t, t + 2);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  o.connect(g);
  g.connect(v.out);
  const groups = 1 + Math.floor(Math.random() * 3);
  const pulses = 3 + Math.floor(Math.random() * 3);
  let nt = t;
  for (let gi = 0; gi < groups; gi++) {
    for (let p = 0; p < pulses; p++) {
      note(g, nt, 0.022, 1);
      nt += 0.042;
    }
    nt += rnd(0.18, 0.3);
  }
  const end = nt;
  v.stopAt(o, end);
  return end - t;
}
