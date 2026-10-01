import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager, MAX_VOICES, stereoPan, type UiCue } from '../src/audio/audio';
import { AudioEngine } from '../src/audio/engine';
import { computeAmbientTargets, daylightFactor, positionalGain, sampleEnvironment, zoomFactor } from '../src/audio/environment';
import * as sfx from '../src/audio/sfx';
import { EventBus } from '../src/core/events';
import type { GameEvents, GameState } from '../src/core/types';
import { Feature, Terrain } from '../src/core/types';
import type { Game } from '../src/sim/game';

// ---- strict WebAudio mock -----------------------------------------------------------------------

function finite(v: number, what: string): void {
  if (!Number.isFinite(v)) throw new TypeError(`${what}: non-finite value ${v}`);
}

class MockParam {
  value = 0;
  setValueAtTime(v: number, t: number) { finite(v, 'setValueAtTime'); finite(t, 'setValueAtTime(t)'); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { finite(v, 'linearRamp'); finite(t, 'linearRamp(t)'); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) {
    finite(v, 'expRamp'); finite(t, 'expRamp(t)');
    if (v <= 0) throw new RangeError('exponentialRampToValueAtTime: value must be positive');
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number) { finite(v, 'setTarget'); finite(t, 'setTarget(t)'); finite(c, 'setTarget(c)'); return this; }
  cancelScheduledValues(t: number) { finite(t, 'cancel'); return this; }
}

let liveSources = 0;

class MockNode {
  connect<T>(n: T): T {
    if (!n) throw new TypeError('connect(undefined)');
    return n;
  }
  disconnect(): void {}
}
class MockGain extends MockNode { gain = new MockParam(); }
class MockBiquad extends MockNode { type = 'lowpass'; frequency = new MockParam(); Q = new MockParam(); }
class MockPanner extends MockNode { pan = new MockParam(); }
class MockCompressor extends MockNode {
  threshold = new MockParam(); knee = new MockParam(); ratio = new MockParam(); attack = new MockParam(); release = new MockParam();
}
class MockSource extends MockNode {
  onended: (() => void) | null = null;
  private started = false;
  start(t = 0, offset = 0): void {
    finite(t, 'start'); finite(offset, 'start(offset)');
    if (this.started) throw new Error('InvalidStateError: start twice');
    this.started = true;
    liveSources++;
  }
  stop(t = 0): void {
    finite(t, 'stop');
    if (!this.started) throw new Error('InvalidStateError: stop before start');
  }
}
class MockOsc extends MockSource { type = 'sine'; frequency = new MockParam(); detune = new MockParam(); }
class MockBufferSource extends MockSource { buffer: unknown = null; loop = false; playbackRate = new MockParam(); }
class MockBuffer {
  private readonly data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = new Float32Array(length);
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(): Float32Array { return this.data; }
}
class MockAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = new MockNode();
  createGain() { return new MockGain(); }
  createBiquadFilter() { return new MockBiquad(); }
  createStereoPanner() { return new MockPanner(); }
  createDynamicsCompressor() { return new MockCompressor(); }
  createOscillator() { return new MockOsc(); }
  createBufferSource() { return new MockBufferSource(); }
  createBuffer(ch: number, len: number, sr: number) { return new MockBuffer(ch, len, sr); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

// ---- fake game ------------------------------------------------------------------------------------

function fakeState(): GameState {
  const W = 32;
  const H = 32;
  const n = W * H;
  const terrain = new Uint8Array(n);
  const feature = new Uint8Array(n);
  const featureAmount = new Float32Array(n);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (x < 8) terrain[i] = Terrain.Water;
      else if (x > 20) {
        feature[i] = Feature.Tree;
        featureAmount[i] = 1;
      }
    }
  }
  return {
    W, H,
    tiles: {
      height: new Float32Array((W + 1) * (H + 1)), terrain, feature, featureAmount, variant: new Uint8Array(n),
      road: new Uint8Array(n), building: new Int32Array(n).fill(-1), marked: new Uint8Array(n), region: new Int32Array(n),
    },
    time: { elapsed: 0, year: 1, month: 4, monthProgress: 0.5, dayTime: 0.5 },
    weather: { temperature: 20, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0, windStrength: 0.5 },
    rev: { terrain: 0, features: 0, roads: 0, buildings: 0, fields: 0 },
  } as unknown as GameState;
}

function fakeGame(): Game {
  const state = fakeState();
  return {
    state,
    events: new EventBus<GameEvents>(),
    getBuilding: (id: number) => (id === 5 ? { id: 5, x: 10, z: 10, w: 3, h: 3 } : undefined),
    getCitizen: (id: number) => (id === 9 ? { id: 9, x: 12, z: 12 } : undefined),
  } as unknown as Game;
}

// ---- tests ------------------------------------------------------------------------------------------

describe('AudioManager without WebAudio (headless)', () => {
  it('never throws and stays silent', () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = new AudioManager();
    a.setVolumes(0.5, 0.5, 0.5);
    a.unlock();
    a.unlock();
    const g = fakeGame();
    a.attach(g);
    g.events.emit('sound', { cue: 'chop', x: 1, z: 1 });
    g.events.emit('citizenDied', { id: 1, name: 'x', cause: 'oldAge' });
    for (const cue of ['click', 'place', 'error', 'open', 'close', 'notify', 'danger'] as UiCue[]) a.playUi(cue);
    a.update(0.016, 10, 10, 40);
    a.update(NaN, NaN, NaN, NaN);
    expect(a.activeVoices).toBe(0);
    expect(a.running).toBe(false);
    a.dispose();
    a.dispose();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AudioManager with a (mock) AudioContext', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    warn.mockRestore();
  });

  it('plays every cue and ambient layer without errors, respecting the voice limit', () => {
    const a = new AudioManager();
    a.unlock();
    expect(a.running).toBe(true);
    const ctx = (a as unknown as { engine: AudioEngine }).engine.ctx as unknown as MockAudioContext;
    const g = fakeGame();
    a.attach(g);
    a.setVolumes(1, 1, 1);
    const cues = ['chop', 'hammer', 'dig', 'splash', 'fire', 'bell', 'birth', 'death', 'build'] as const;
    for (let k = 0; k < 40; k++) {
      ctx.currentTime += 0.05;
      g.events.emit('sound', { cue: cues[k % cues.length], x: 10 + (k % 5), z: 10 });
      a.update(0.05, 10, 10, 20);
      expect(a.activeVoices).toBeLessThanOrEqual(MAX_VOICES);
    }
    g.events.emit('buildingCompleted', { id: 5 });
    g.events.emit('citizenBorn', { id: 9 });
    g.events.emit('citizenDied', { id: 1, name: 'x', cause: 'oldAge' });
    g.events.emit('fireStarted', { buildingId: 5 });
    g.events.emit('merchantArrived', { merchantId: 3 });
    for (const cue of ['click', 'place', 'error', 'open', 'close', 'notify', 'danger'] as UiCue[]) {
      ctx.currentTime += 0.4;
      a.playUi(cue);
    }
    expect(a.activeVoices).toBeLessThanOrEqual(MAX_VOICES);
    // Run the ambient bed through day & night, all seasons and weathers.
    for (let step = 0; step < 400; step++) {
      g.state.time.month = step % 12;
      g.state.time.dayTime = (step * 0.037) % 1;
      g.state.weather.precipitation = step % 3 === 0 ? 'rain' : step % 3 === 1 ? 'snow' : 'none';
      g.state.weather.precipIntensity = 0.7;
      ctx.currentTime += 0.1;
      a.update(0.1, 8 + (step % 20), 16, 10 + (step % 100));
    }
    expect(liveSources).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    a.dispose();
    expect(ctx.state).toBe('closed');
  });

  it('far-away sounds are culled; distant zoom attenuates', () => {
    const a = new AudioManager();
    a.unlock();
    const g = fakeGame();
    a.attach(g);
    a.update(0.016, 0, 0, 20);
    const before = liveSources;
    g.events.emit('sound', { cue: 'chop', x: 500, z: 500 });
    expect(liveSources).toBe(before);
    g.events.emit('sound', { cue: 'chop', x: 1, z: 1 });
    expect(liveSources).toBeGreaterThan(before);
    a.dispose();
  });
});

describe('AudioEngine voice pool', () => {
  it('caps concurrent voices and steals only lower/equal priority', () => {
    const ctx = new MockAudioContext() as unknown as AudioContext;
    const e = new AudioEngine(ctx, 8);
    for (let k = 0; k < 8; k++) {
      const v = e.voice(1, 0.5);
      expect(v).not.toBeNull();
      v!.osc('sine', 440, 0, 10);
    }
    expect(e.activeVoices).toBe(8);
    expect(e.voice(0, 0.5)).toBeNull();
    const hi = e.voice(3, 0.5);
    expect(hi).not.toBeNull();
    hi!.osc('sine', 440, 0, 10);
    expect(e.activeVoices).toBe(8);
    (ctx as unknown as MockAudioContext).currentTime = 11;
    expect(e.activeVoices).toBe(0);
  });

  it('every synth function schedules valid automation', () => {
    const ctx = new MockAudioContext() as unknown as AudioContext;
    const e = new AudioEngine(ctx, 64);
    const fns = [
      sfx.chop, sfx.hammer, sfx.dig, sfx.splash, sfx.fire, sfx.bell, sfx.alarmBell, sfx.deathToll, sfx.birthChime,
      sfx.buildComplete, sfx.merchantHorn, sfx.uiClick, sfx.uiPlace, sfx.uiError, sfx.uiOpen, sfx.uiClose, sfx.uiNotify,
      sfx.uiDanger,
    ];
    for (let rep = 0; rep < 20; rep++) {
      for (const fn of fns) fn(e.freeVoice(0.5, 0.3, e.sfx), 1);
      expect(sfx.birdSong(e.freeVoice(0.1, -0.2, e.ambient), 1)).toBeGreaterThan(0);
      expect(sfx.cricketChirp(e.freeVoice(0.1, 0.2, e.ambient), 1)).toBeGreaterThan(0);
    }
  });
});

describe('stereoPan', () => {
  it('pans by the side relative to the listener right vector, gently near the centre', () => {
    expect(stereoPan(20, 0, 1, 0)).toBeCloseTo(0.8);
    expect(stereoPan(-20, 0, 1, 0)).toBeCloseTo(-0.8);
    expect(stereoPan(0, 20, 1, 0)).toBeCloseTo(0);
    expect(Math.abs(stereoPan(2, 0, 1, 0))).toBeLessThan(0.25);
    // rotated listener: right = +Z
    expect(stereoPan(0, 20, 0, 1)).toBeCloseTo(0.8);
    // unknown orientation → small random spread
    for (let k = 0; k < 20; k++) expect(Math.abs(stereoPan(30, 0, 0, 0))).toBeLessThanOrEqual(0.15);
  });
});

describe('audio environment helpers', () => {
  it('zoom and daylight factors', () => {
    expect(zoomFactor(8)).toBe(0);
    expect(zoomFactor(120)).toBe(1);
    expect(zoomFactor(500)).toBe(1);
    expect(daylightFactor(0.5)).toBe(1);
    expect(daylightFactor(0)).toBe(0);
    expect(daylightFactor(0.95)).toBe(0);
  });

  it('samples water and trees around the focus', () => {
    const s = fakeState();
    const nearWater = sampleEnvironment(s, 4, 16, 6);
    expect(nearWater.water).toBeGreaterThan(0.5);
    const inForest = sampleEnvironment(s, 27, 16, 6);
    expect(inForest.trees).toBeGreaterThan(0.5);
    expect(inForest.water).toBe(0);
  });

  it('ambient targets follow season, time and weather', () => {
    const s = fakeState();
    const env = { water: 0, trees: 0.6 };
    s.time.month = 1; // spring
    s.time.dayTime = 0.5;
    const spring = computeAmbientTargets(s, env, 20);
    expect(spring.birdRate).toBeGreaterThan(0.2);
    expect(spring.cricketRate).toBe(0);
    s.time.month = 10; // winter
    const winter = computeAmbientTargets(s, env, 20);
    expect(winter.birdRate).toBe(0);
    expect(winter.wind).toBeGreaterThan(spring.wind);
    s.time.month = 4; // summer night
    s.time.dayTime = 0.95;
    s.weather.temperature = 20;
    const night = computeAmbientTargets(s, env, 20);
    expect(night.birdRate).toBe(0);
    expect(night.cricketRate).toBeGreaterThan(0.5);
    s.weather.precipitation = 'rain';
    s.weather.precipIntensity = 1;
    expect(computeAmbientTargets(s, env, 20).rain).toBeGreaterThan(0.5);
    // zooming out raises wind and lowers close-up detail
    const far = computeAmbientTargets(s, env, 120);
    const near = computeAmbientTargets(s, env, 10);
    expect(far.wind).toBeGreaterThan(near.wind);
    expect(far.cricketRate).toBeLessThan(near.cricketRate);
  });

  it('positional gain falls off with distance and zoom', () => {
    expect(positionalGain(0, 0, 0, 0, 20)).toBeGreaterThan(0.9);
    expect(positionalGain(10, 0, 0, 0, 20)).toBeLessThan(positionalGain(2, 0, 0, 0, 20));
    expect(positionalGain(200, 0, 0, 0, 20)).toBe(0);
    expect(positionalGain(0, 0, 0, 0, 120)).toBeLessThan(positionalGain(0, 0, 0, 0, 20));
  });
});
