/**
 * Ambient bed: continuous filtered-noise layers (stereo wind with slow gusts, rain hiss, water hush) whose levels
 * crossfade toward targets computed from the game state, plus scheduled one-shot bird songs and cricket chirps.
 * Audio params are updated at ~10 Hz with smoothing (setTargetAtTime) — never per sample, never per frame.
 */
import type { AmbientTargets } from './environment';
import type { AudioEngine } from './engine';
import { birdSong, cricketChirp } from './sfx';

interface NoiseLayer {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  nodes: AudioNode[];
}

/** Loudness calibration (dev/input/audiolevels.mjs): bed levels at target 1, one-shot voice gain ranges. */
export const AMBIENT_LEVELS = {
  wind: 1.2,
  rain: 0.75,
  water: 0.55,
  birdMin: 0.17,
  birdMax: 0.47,
  cricketMin: 0.055,
  cricketMax: 0.145,
} as const;

const PARAM_INTERVAL = 0.1;
const SMOOTH = 0.35;
const MAX_BIRDS = 4;
const MAX_CRICKETS = 6;

/** Slow pseudo-random gust envelope 0..1 from a sum of incommensurate sines. */
function gust(t: number, phase: number): number {
  const v = 0.5 + 0.28 * Math.sin(0.23 * t + phase) + 0.14 * Math.sin(0.61 * t + 2.1 * phase) + 0.08 * Math.sin(1.73 * t + 3.7 * phase);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Exponentially distributed wait (seconds) for a Poisson process of `rate` events/second. */
function nextWait(rate: number): number {
  if (rate <= 0.001) return 0.5;
  const w = -Math.log(1 - Math.random()) / rate;
  return Math.max(0.12, Math.min(20, w));
}

export class AmbientBed {
  private readonly windL: NoiseLayer;
  private readonly windR: NoiseLayer;
  private readonly rain: NoiseLayer;
  private readonly water: NoiseLayer;
  private t = Math.random() * 100;
  private paramTimer = 0;
  private birdTimer = 2;
  private cricketTimer = 1;
  private readonly birdEnds: number[] = [];
  private readonly cricketEnds: number[] = [];
  private disposed = false;

  constructor(private readonly engine: AudioEngine) {
    const ctx = engine.ctx;
    this.windL = this.layer('lowpass', 500, 0.5, 0.9, -0.55, [this.highpass(90)]);
    this.windR = this.layer('lowpass', 500, 0.5, 0.83, 0.55, [this.highpass(90)]);
    this.rain = this.layer('lowpass', 7000, 0.4, 1, 0, [this.highpass(1000)]);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.6;
    this.water = this.layer('lowpass', 1500, 0.5, 0.7, 0, [bp]);
  }

  /** Advance scheduling and (at ~10 Hz) steer layer levels toward `targets`. */
  update(dt: number, targets: AmbientTargets): void {
    if (this.disposed) return;
    this.t += dt;
    this.paramTimer -= dt;
    if (this.paramTimer <= 0) {
      this.paramTimer = PARAM_INTERVAL;
      this.applyParams(targets);
    }
    this.scheduleOneShots(dt, targets);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const l of [this.windL, this.windR, this.rain, this.water]) {
      try {
        l.src.stop();
      } catch {
        /* ignore */
      }
      for (const n of l.nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------

  private highpass(freq: number): BiquadFilterNode {
    const f = this.engine.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = freq;
    f.Q.value = 0.5;
    return f;
  }

  /** noise → pre filters → main filter → gain → (panner) → ambient bus; starts silent. */
  private layer(type: BiquadFilterType, freq: number, q: number, rate: number, pan: number, pre: BiquadFilterNode[]): NoiseLayer {
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const nodes: AudioNode[] = [src, ...pre, filter, gain];
    for (let k = 0; k < nodes.length - 1; k++) nodes[k].connect(nodes[k + 1]);
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      gain.connect(p);
      p.connect(this.engine.ambient);
      nodes.push(p);
    } else {
      gain.connect(this.engine.ambient);
    }
    src.start(ctx.currentTime, Math.random() * Math.max(0, this.engine.noiseBuffer.duration - 0.1));
    return { src, filter, gain, nodes };
  }

  private applyParams(tg: AmbientTargets): void {
    const now = this.engine.ctx.currentTime;
    const t = this.t;
    // wind: two independently gusting channels
    for (let k = 0; k < 2; k++) {
      const layer = k === 0 ? this.windL : this.windR;
      const g = gust(t, k * 1.7);
      layer.gain.gain.setTargetAtTime(tg.wind * (0.25 + 0.75 * g) * AMBIENT_LEVELS.wind, now, SMOOTH);
      layer.filter.frequency.setTargetAtTime(180 + (320 + 900 * tg.windBright) * (0.3 + 0.7 * g), now, SMOOTH);
    }
    this.rain.gain.gain.setTargetAtTime(tg.rain * AMBIENT_LEVELS.rain, now, 0.6);
    this.water.gain.gain.setTargetAtTime(tg.water * AMBIENT_LEVELS.water * (0.8 + 0.2 * Math.sin(t * 0.45)), now, 0.6);
    this.water.filter.frequency.setTargetAtTime(1300 + 300 * Math.sin(t * 0.31), now, 0.6);
  }

  private scheduleOneShots(dt: number, tg: AmbientTargets): void {
    const engine = this.engine;
    const now = engine.ctx.currentTime;
    prune(this.birdEnds, now);
    prune(this.cricketEnds, now);

    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = nextWait(tg.birdRate);
      if (tg.birdRate > 0.001 && this.birdEnds.length < MAX_BIRDS) {
        const L = AMBIENT_LEVELS;
        const v = engine.freeVoice(L.birdMin + Math.random() * (L.birdMax - L.birdMin), Math.random() * 1.6 - 0.8, engine.ambient);
        const dur = birdSong(v, now + 0.01);
        this.birdEnds.push(now + dur);
        // a reply from another bird now and then
        if (Math.random() < 0.3) this.birdTimer = Math.min(this.birdTimer, 0.4 + Math.random() * 0.6);
      }
    }

    this.cricketTimer -= dt;
    if (this.cricketTimer <= 0) {
      this.cricketTimer = nextWait(tg.cricketRate);
      if (tg.cricketRate > 0.001 && this.cricketEnds.length < MAX_CRICKETS) {
        const L = AMBIENT_LEVELS;
        const v = engine.freeVoice(L.cricketMin + Math.random() * (L.cricketMax - L.cricketMin), Math.random() * 1.8 - 0.9, engine.ambient);
        const dur = cricketChirp(v, now + 0.01);
        this.cricketEnds.push(now + dur);
      }
    }
  }
}

function prune(ends: number[], now: number): void {
  for (let k = ends.length - 1; k >= 0; k--) if (ends[k] <= now) ends.splice(k, 1);
}
