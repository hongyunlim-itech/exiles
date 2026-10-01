/**
 * Low-level WebAudio plumbing: context + mix buses (master → limiter → out; sfx and ambient buses into master),
 * a shared noise buffer, and a polyphony-limited voice pool with priority-based stealing.
 */

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Returns the AudioContext constructor if the platform has one (never throws). */
export function audioContextCtor(): AudioContextCtor | null {
  try {
    if (typeof globalThis === 'undefined') return null;
    const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return g.AudioContext ?? g.webkitAudioContext ?? null;
  } catch {
    return null;
  }
}

/** One sounding voice: its own output gain (and optional pan) plus the scheduled sources/nodes it owns. */
export class Voice {
  readonly out: GainNode;
  private readonly tail: AudioNode;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  /** Scheduled stop time per source (parallel to `sources`). */
  private readonly stops: number[] = [];
  /** Context time when the last source stops. */
  end = 0;
  readonly start: number;
  stopped = false;

  constructor(
    readonly ctx: AudioContext,
    dest: AudioNode,
    gain: number,
    pan: number,
    readonly priority: number,
    private readonly noiseBuffer: AudioBuffer,
  ) {
    this.start = ctx.currentTime;
    this.out = ctx.createGain();
    this.out.gain.value = gain;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      this.out.connect(p);
      p.connect(dest);
      this.tail = p;
    } else {
      this.out.connect(dest);
      this.tail = this.out;
    }
  }

  /** An oscillator running t0..t1 (not connected). */
  osc(type: OscillatorType, freq: number, t0: number, t1: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    this.track(o, t0, t1);
    return o;
  }

  /** A looping white-noise source running t0..t1 (not connected). */
  noise(t0: number, t1: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuffer;
    s.loop = true;
    s.playbackRate.value = rate;
    this.track(s, t0, t1, Math.random() * Math.max(0, this.noiseBuffer.duration - 0.1));
    return s;
  }

  /**
   * Envelope gain connected to the voice output: silent → peak in `attack` → exponential decay to silence over
   * `decay`. Returns the gain node to connect sources into.
   */
  env(t0: number, attack: number, peak: number, decay: number): GainNode {
    const g = this.ctx.createGain();
    const a = Math.max(0.001, attack);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + Math.max(0.005, decay));
    g.connect(this.out);
    this.nodes.push(g);
    return g;
  }

  /** A plain gain node (not connected). */
  gain(value: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  /** Connect a chain of nodes left to right; returns the last. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let k = 0; k < nodes.length - 1; k++) nodes[k].connect(nodes[k + 1]);
    return nodes[nodes.length - 1];
  }

  /** Fade out quickly and stop everything (voice stealing / dispose). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    try {
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setValueAtTime(this.out.gain.value, now);
      this.out.gain.linearRampToValueAtTime(0, now + 0.04);
      for (const s of this.sources) {
        try {
          s.stop(now + 0.05);
        } catch {
          /* already stopped */
        }
      }
    } catch {
      /* ignore */
    }
    this.end = Math.min(this.end, now + 0.05);
  }

  /** Re-schedule the stop time of a source created by this voice (e.g. once a song's length is known). */
  stopAt(src: AudioScheduledSourceNode, t1: number): void {
    const k = this.sources.indexOf(src);
    if (k < 0) return;
    src.stop(t1);
    this.stops[k] = t1;
    let end = 0;
    for (const s of this.stops) if (s > end) end = s;
    this.end = end;
  }

  private track(src: AudioScheduledSourceNode, t0: number, t1: number, offset?: number): void {
    if (offset !== undefined) (src as AudioBufferSourceNode).start(t0, offset);
    else src.start(t0);
    src.stop(t1);
    this.sources.push(src);
    this.stops.push(t1);
    if (t1 > this.end) this.end = t1;
    // Disconnect the voice graph once its last source has finished.
    src.onended = this.onSourceEnded;
  }

  private cleanupDone = false;

  private readonly onSourceEnded = (): void => {
    if (this.cleanupDone) return;
    // Other sources may still be scheduled to play — only clean up when all are done.
    if (!this.stopped && this.ctx.currentTime + 0.02 < this.end) return;
    this.cleanupDone = true;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    try {
      this.out.disconnect();
      if (this.tail !== this.out) this.tail.disconnect();
    } catch {
      /* ignore */
    }
  };
}

export class AudioEngine {
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly ambient: GainNode;
  readonly noiseBuffer: AudioBuffer;
  private readonly limiter: DynamicsCompressorNode;
  private readonly voices: Voice[] = [];

  constructor(readonly ctx: AudioContext, readonly maxVoices: number) {
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.2;
    this.master = ctx.createGain();
    this.sfx = ctx.createGain();
    this.ambient = ctx.createGain();
    this.sfx.connect(this.master);
    this.ambient.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.noiseBuffer = AudioEngine.makeNoise(ctx, 3);
  }

  /** Mono white noise with a gentle 1/f tilt (less harsh than pure white). */
  static makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      // cheap pinking filter (Paul Kellet economy)
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      d[i] = (b0 + b1 + w * 0.1848) * 0.35 + w * 0.25;
    }
    return buf;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Voices currently sounding. */
  get activeVoices(): number {
    this.purge();
    return this.voices.length;
  }

  /**
   * Allocate a voice routed to `dest` (default: the sfx bus), or null when the polyphony limit is reached and no
   * sounding voice has a lower (or equal, older) priority to steal.
   */
  voice(priority: number, gain: number, pan = 0, dest: AudioNode = this.sfx): Voice | null {
    this.purge();
    if (this.voices.length >= this.maxVoices) {
      let victim = -1;
      for (let k = 0; k < this.voices.length; k++) {
        const v = this.voices[k];
        if (v.priority > priority) continue;
        if (victim < 0 || v.priority < this.voices[victim].priority || (v.priority === this.voices[victim].priority && v.start < this.voices[victim].start)) victim = k;
      }
      if (victim < 0) return null;
      this.voices[victim].stop();
      this.voices.splice(victim, 1);
    }
    const v = new Voice(this.ctx, dest, gain, pan, priority, this.noiseBuffer);
    this.voices.push(v);
    return v;
  }

  /** A voice outside the polyphony pool (ambient one-shots use their own counters). */
  freeVoice(gain: number, pan: number, dest: AudioNode): Voice {
    return new Voice(this.ctx, dest, gain, pan, 0, this.noiseBuffer);
  }

  stopAll(): void {
    for (const v of this.voices) v.stop();
    this.voices.length = 0;
  }

  private purge(): void {
    const t = this.ctx.currentTime;
    for (let k = this.voices.length - 1; k >= 0; k--) {
      if (this.voices[k].end <= t) this.voices.splice(k, 1);
    }
  }
}
