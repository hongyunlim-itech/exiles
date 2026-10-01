/**
 * In-memory "room" for tests (net-core): any number of transports on one hub with a virtual clock, configurable
 * event latency / jitter / drop rate, per-peer admin flags and room-like semantics (presence = latest-wins object
 * that always converges; events may be dropped and reordered, only admins may emit, everyone including the sender
 * receives them; payload limits enforced).
 */
import { Rng } from '../core/rng';
import type { Transport, TransportMessage, TransportPeer } from './transport';
import { jsonBytes } from './util';

/** Platform limit (UTF-8 bytes of JSON) for events and the merged presence object. */
const PLATFORM_LIMIT = 4096;

export interface MemoryHubOptions {
  /** Base one-way latency (ms) for events and presence. */
  latencyMs?: number;
  /** Extra uniformly random latency (ms) per delivery (events may arrive out of order). */
  jitterMs?: number;
  /** Fraction of event deliveries dropped (per receiver; never the sender's own echo). */
  drop?: number;
  seed?: number;
}

export interface MemoryPeerOptions {
  admin?: boolean;
  guest?: boolean;
  peer?: string;
  by?: string | null;
  name?: string;
}

interface Pending {
  at: number;
  seq: number;
  fn: () => void;
}

export interface MemoryHubStats {
  events: number;
  dropped: number;
  maxEventBytes: number;
  maxPresenceBytes: number;
  /** Events per topic. */
  topics: Record<string, number>;
}

export class MemoryHub {
  /** Virtual clock (ms). */
  now = 0;
  latencyMs: number;
  jitterMs: number;
  drop: number;
  readonly stats: MemoryHubStats = { events: 0, dropped: 0, maxEventBytes: 0, maxPresenceBytes: 0, topics: {} };
  private readonly rng: Rng;
  private queue: Pending[] = [];
  private seq = 0;
  private readonly members = new Set<MemoryTransport>();
  private nextPeer = 1;

  constructor(opts: MemoryHubOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 30;
    this.jitterMs = opts.jitterMs ?? 0;
    this.drop = opts.drop ?? 0;
    this.rng = new Rng(opts.seed ?? 1);
  }

  /** A new participant (joins the room right away; others hear about it after the latency). */
  connect(opts: MemoryPeerOptions = {}): MemoryTransport {
    const peer = opts.peer ?? `peer${String(this.nextPeer++).padStart(3, '0')}`;
    const t = new MemoryTransport(this, peer, opts);
    this.members.add(t);
    t.localJoin(t);
    for (const o of this.members) {
      if (o === t) continue;
      this.schedule(this.delay(), () => o.remoteJoin(t));
      this.schedule(this.delay(), () => t.remoteJoin(o));
    }
    return t;
  }

  /** Remove a participant (tab closed / crashed): everyone else sees it leave. */
  disconnect(t: MemoryTransport): void {
    if (!this.members.delete(t)) return;
    t.markDisconnected();
    for (const o of this.members) this.schedule(this.delay(), () => o.remoteLeave(t.peer));
  }

  members_(): readonly MemoryTransport[] {
    return [...this.members];
  }

  /** Advance the virtual clock, delivering everything due (in time order). */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    this.now = end;
  }

  /** Deliver everything queued (including what that delivery schedules), advancing the clock as needed. */
  flush(maxMs = 10_000): void {
    const end = this.now + maxMs;
    while (this.queue.length > 0 && this.queue[0].at <= end) this.advance(this.queue[0].at - this.now);
  }

  delay(): number {
    return this.latencyMs + (this.jitterMs > 0 ? this.rng.next() * this.jitterMs : 0);
  }

  schedule(delayMs: number, fn: () => void): void {
    const p: Pending = { at: this.now + Math.max(0, delayMs), seq: this.seq++, fn };
    // keep sorted by (at, seq)
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      if (q.at < p.at || (q.at === p.at && q.seq < p.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, p);
  }

  broadcastPresence(from: MemoryTransport, presence: Readonly<Record<string, unknown>>, version: number): void {
    this.stats.maxPresenceBytes = Math.max(this.stats.maxPresenceBytes, jsonBytes(presence));
    for (const o of this.members) {
      if (o === from) continue;
      this.schedule(this.delay(), () => o.remotePresence(from.peer, presence, version));
    }
  }

  broadcastEvent(from: MemoryTransport, topic: string, data: unknown): void {
    const bytes = jsonBytes(data);
    this.stats.events++;
    this.stats.topics[topic] = (this.stats.topics[topic] ?? 0) + 1;
    this.stats.maxEventBytes = Math.max(this.stats.maxEventBytes, bytes);
    const frozen = JSON.parse(JSON.stringify(data ?? null)) as unknown;
    for (const o of this.members) {
      const self = o === from;
      if (!self && this.drop > 0 && this.rng.next() < this.drop) {
        this.stats.dropped++;
        continue;
      }
      this.schedule(self ? 0 : this.delay(), () => o.deliver({ topic, data: frozen, peer: from.peer, isMe: self, sameTab: self }));
    }
  }
}

export class MemoryTransport implements Transport {
  readonly kind = 'memory' as const;
  readonly peer: string;
  readonly admin: boolean;
  readonly guestFlag: boolean;
  readonly by: string | null;
  readonly name: string;
  private readonly hub: MemoryHub;
  private presence: Record<string, unknown> = {};
  private version = 0;
  private readonly view = new Map<string, { peer: TransportPeer; version: number }>();
  private snapshot: readonly TransportPeer[] = [];
  private readonly peerFns = new Set<(p: readonly TransportPeer[]) => void>();
  private readonly topicFns = new Map<string, Set<(m: TransportMessage) => void>>();
  private readonly connFns = new Set<(c: boolean) => void>();
  private live = true;

  constructor(hub: MemoryHub, peer: string, opts: MemoryPeerOptions) {
    this.hub = hub;
    this.peer = peer;
    this.admin = opts.admin ?? true;
    this.guestFlag = opts.guest ?? false;
    this.by = opts.by === undefined ? `u_${peer}` : opts.by;
    this.name = opts.name ?? '';
  }

  selfPeer(): string {
    return this.live ? this.peer : '';
  }

  connected(): boolean {
    return this.live;
  }

  canEmit(): Promise<boolean> {
    return Promise.resolve(this.admin);
  }

  displayName(p: TransportPeer): Promise<string> {
    const t = this.hub.members_().find((m) => m.peer === p.peer);
    return Promise.resolve(t?.name ?? '');
  }

  setPresence(patch: Record<string, unknown>): Promise<void> {
    if (!this.live) return Promise.resolve();
    const next: Record<string, unknown> = { ...this.presence };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (jsonBytes(next) > PLATFORM_LIMIT) return Promise.reject(new Error('invalid_argument: presence over 4 KiB'));
    this.presence = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
    this.version++;
    this.localJoin(this);
    this.hub.broadcastPresence(this, this.presence, this.version);
    return Promise.resolve();
  }

  peers(): readonly TransportPeer[] {
    return this.snapshot;
  }

  onPeers(fn: (peers: readonly TransportPeer[]) => void): () => void {
    this.peerFns.add(fn);
    return () => this.peerFns.delete(fn);
  }

  emit(topic: string, data: unknown): Promise<void> {
    if (!this.live) return Promise.resolve();
    if (!this.admin) return Promise.reject(new Error('not_permitted'));
    if (jsonBytes(data) > PLATFORM_LIMIT) return Promise.reject(new Error('invalid_argument: event over 4 KiB'));
    this.hub.broadcastEvent(this, topic, data);
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
    this.hub.schedule(0, () => {
      if (this.connFns.has(fn)) fn(this.live);
    });
    return () => this.connFns.delete(fn);
  }

  dispose(): void {
    this.hub.disconnect(this);
    this.peerFns.clear();
    this.topicFns.clear();
    this.connFns.clear();
  }

  // ---- hub side -------------------------------------------------------------------------------

  markDisconnected(): void {
    this.live = false;
    for (const fn of [...this.connFns]) fn(false);
  }

  localJoin(t: MemoryTransport): void {
    this.upsert(t, t.presence, t.version, true);
  }

  remoteJoin(t: MemoryTransport): void {
    if (!this.live || !this.hub.members_().includes(t)) return;
    this.upsert(t, t.presence, t.version, false);
  }

  remotePresence(peer: string, presence: Readonly<Record<string, unknown>>, version: number): void {
    if (!this.live) return;
    const t = this.hub.members_().find((m) => m.peer === peer);
    if (!t) return;
    this.upsert(t, presence, version, false);
  }

  remoteLeave(peer: string): void {
    if (!this.live || !this.view.delete(peer)) return;
    this.publish();
  }

  deliver(msg: TransportMessage): void {
    if (!this.live) return;
    const set = this.topicFns.get(msg.topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch (err) {
        console.error('[memory transport] listener threw', err);
      }
    }
  }

  private upsert(t: MemoryTransport, presence: Readonly<Record<string, unknown>>, version: number, self: boolean): void {
    const cur = this.view.get(t.peer);
    if (cur && cur.version > version) return; // stale (reordered) presence: latest wins
    if (cur && cur.version === version && cur.peer.presence === presence) return;
    const changed = !cur || cur.version !== version;
    const p: TransportPeer = Object.freeze({
      peer: t.peer, by: t.by, isMe: self, sameTab: self, guest: t.guestFlag, presence,
      updatedAt: changed ? this.hub.now : cur!.peer.updatedAt,
    });
    this.view.set(t.peer, { peer: p, version });
    this.publish();
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.view.values()].map((v) => v.peer).sort((a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0)));
    for (const fn of [...this.peerFns]) fn(this.snapshot);
  }
}
