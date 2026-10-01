/**
 * Dev transport (net-core): tabs of one browser play together over a BroadcastChannel ('exiles-net'), emulating the
 * Claude artifact room: presence objects merged per peer (latest wins, ≤ 4 KiB, coalesced ~30 Hz, re-sent with a
 * 1 s heartbeat), peers with updatedAt, leave detection when heartbeats stop (~3.5 s) or on page hide, admin-only
 * events delivered to everyone including the sender (isMe && sameTab), optional random event drops.
 *
 * URL: `?net=local` enables it; `&role=guest` makes this tab a non-admin viewer (tests the guest path);
 * `&drop=0.1` drops that fraction of incoming events.
 */
import type { Transport, TransportMessage, TransportPeer } from './transport';
import { jsonBytes, randomId } from './util';

const CHANNEL = 'exiles-net';
const PLATFORM_LIMIT = 4096;
const HEARTBEAT_MS = 1000;
const LEAVE_AFTER_MS = 3500;
const COALESCE_MS = 33;

type Wire =
  | { k: 'hello' | 'pres' | 'hb'; p: string; a: boolean; v: number; pres: Record<string, unknown> }
  | { k: 'evt'; p: string; topic: string; data: unknown }
  | { k: 'bye'; p: string };

interface Known {
  peer: TransportPeer;
  version: number;
  lastSeen: number;
}

export interface LocalTransportOptions {
  admin: boolean;
  /** Fraction of incoming events to drop (0..1). */
  drop?: number;
}

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  private readonly peer = randomId(16);
  private readonly admin: boolean;
  private readonly drop: number;
  private readonly channel: BroadcastChannel;
  private presence: Record<string, unknown> = {};
  private version = 0;
  private readonly known = new Map<string, Known>();
  private snapshot: readonly TransportPeer[] = [];
  private readonly peerFns = new Set<(p: readonly TransportPeer[]) => void>();
  private readonly topicFns = new Map<string, Set<(m: TransportMessage) => void>>();
  private readonly connFns = new Set<(c: boolean) => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private disposed = false;
  private readonly onHide = (): void => this.post({ k: 'bye', p: this.peer });

  constructor(opts: LocalTransportOptions) {
    this.admin = opts.admin;
    this.drop = Math.max(0, Math.min(1, opts.drop ?? 0));
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e: MessageEvent) => this.receive(e.data);
    this.upsertSelf();
    this.post({ k: 'hello', p: this.peer, a: this.admin, v: this.version, pres: this.presence });
    this.timers.push(setInterval(() => {
      this.post({ k: 'hb', p: this.peer, a: this.admin, v: this.version, pres: this.presence });
      this.sweep();
    }, HEARTBEAT_MS));
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onHide);
  }

  selfPeer(): string {
    return this.peer;
  }

  connected(): boolean {
    return !this.disposed;
  }

  canEmit(): Promise<boolean> {
    return Promise.resolve(this.admin);
  }

  displayName(): Promise<string> {
    return Promise.resolve(''); // no user capability in local dev: the session falls back to the nickname
  }

  setPresence(patch: Record<string, unknown>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const next: Record<string, unknown> = { ...this.presence };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (jsonBytes(next) > PLATFORM_LIMIT) return Promise.reject(new Error('invalid_argument: presence over 4 KiB'));
    this.presence = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
    this.version++;
    this.upsertSelf();
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.post({ k: 'pres', p: this.peer, a: this.admin, v: this.version, pres: this.presence });
      }, COALESCE_MS);
    }
    return Promise.resolve();
  }

  peers(): readonly TransportPeer[] {
    return this.snapshot;
  }

  onPeers(fn: (peers: readonly TransportPeer[]) => void): () => void {
    this.peerFns.add(fn);
    queueMicrotask(() => {
      if (this.peerFns.has(fn)) fn(this.snapshot);
    });
    return () => this.peerFns.delete(fn);
  }

  emit(topic: string, data: unknown): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.admin) return Promise.reject(new Error('not_permitted'));
    if (jsonBytes(data) > PLATFORM_LIMIT) return Promise.reject(new Error('invalid_argument: event over 4 KiB'));
    const copy = JSON.parse(JSON.stringify(data ?? null)) as unknown;
    this.post({ k: 'evt', p: this.peer, topic, data: copy });
    setTimeout(() => this.deliver({ topic, data: copy, peer: this.peer, isMe: true, sameTab: true }), 0);
    return Promise.resolve();
  }

  on(topic: string, fn: (msg: TransportMessage) => void): () => void {
    let set = this.topicFns.get(topic);
    if (!set) {
      set = new Set();
      this.topicFns.set(topic, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connFns.add(fn);
    queueMicrotask(() => {
      if (this.connFns.has(fn)) fn(!this.disposed);
    });
    return () => this.connFns.delete(fn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.post({ k: 'bye', p: this.peer });
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onHide);
    this.channel.close();
    for (const fn of [...this.connFns]) fn(false);
    this.peerFns.clear();
    this.topicFns.clear();
    this.connFns.clear();
  }

  // ---- internals ------------------------------------------------------------------------------

  private post(m: Wire): void {
    if (this.disposed) return;
    try {
      this.channel.postMessage(JSON.stringify(m));
    } catch (err) {
      console.warn('[net/local] postMessage failed', err);
    }
  }

  private receive(raw: unknown): void {
    if (this.disposed || typeof raw !== 'string') return;
    let m: Wire;
    try {
      m = JSON.parse(raw) as Wire;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.p !== 'string' || m.p === this.peer) return;
    switch (m.k) {
      case 'hello':
      case 'pres':
      case 'hb': {
        const isNew = !this.known.has(m.p);
        this.upsertRemote(m.p, m.a, m.v, m.pres);
        // introduce ourselves to newcomers right away
        if (m.k === 'hello' || isNew) this.post({ k: 'pres', p: this.peer, a: this.admin, v: this.version, pres: this.presence });
        break;
      }
      case 'evt':
        if (this.drop > 0 && Math.random() < this.drop) return;
        this.deliver({ topic: m.topic, data: m.data, peer: m.p, isMe: false, sameTab: false });
        break;
      case 'bye':
        if (this.known.delete(m.p)) this.publish();
        break;
    }
  }

  private deliver(msg: TransportMessage): void {
    const set = this.topicFns.get(msg.topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch (err) {
        console.error('[net/local] listener threw', err);
      }
    }
  }

  private upsertSelf(): void {
    const cur = this.known.get(this.peer);
    const changed = !cur || cur.version !== this.version;
    const peer: TransportPeer = Object.freeze({
      peer: this.peer, by: null, isMe: true, sameTab: true, guest: false, presence: this.presence,
      updatedAt: changed ? Date.now() : cur!.peer.updatedAt,
    });
    this.known.set(this.peer, { peer, version: this.version, lastSeen: Date.now() });
    this.publish();
  }

  private upsertRemote(p: string, admin: boolean, version: number, pres: Record<string, unknown>): void {
    const cur = this.known.get(p);
    const now = Date.now();
    if (cur && cur.version >= version) {
      cur.lastSeen = now; // keepalive: updatedAt unchanged
      return;
    }
    void admin;
    const peer: TransportPeer = Object.freeze({
      peer: p, by: null, isMe: false, sameTab: false, guest: false, presence: Object.freeze({ ...(pres ?? {}) }), updatedAt: now,
    });
    this.known.set(p, { peer, version, lastSeen: now });
    this.publish();
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [p, k] of this.known) {
      if (p === this.peer) continue;
      if (now - k.lastSeen > LEAVE_AFTER_MS) {
        this.known.delete(p);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.known.values()].map((k) => k.peer));
    for (const fn of [...this.peerFns]) {
      try {
        fn(this.snapshot);
      } catch (err) {
        console.error('[net/local] peers listener threw', err);
      }
    }
  }
}
