/**
 * Test harness for the public-room relay: a virtual clock, fake WebSockets and an in-process RoomCore that plays the
 * Durable Object (cloud/worker.ts) — auto-answered pings, attachments, bans, the grace/liveness timer — so
 * RelayTransport and NetSession run against the real relay logic with latency and injectable network faults.
 */
import { createHash } from 'node:crypto';
import {
  parseProtocols, PING, PONG, ROOM_CODE_RE, RoomCore, type PeerAttachment, type RoomCoreOptions, type RoomIO,
} from '../cloud/room-core';
import { RelayTransport, type RelayClock, type WebSocketLike } from '../src/net/transport-relay';

/** Same label as cloud/room-core.ts `peerLabel` (sync, via node:crypto). */
export function syncPeerLabel(code: string, clientId: string): string {
  return createHash('sha256').update(`exiles-peer\n${code}\n${clientId}`).digest('hex').slice(0, 16);
}

interface Task {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/** A virtual clock with cancellable timers (delivers everything due, in time order, on advance()). */
export class VirtualClock implements RelayClock {
  private t = 0;
  private seq = 0;
  private queue: Task[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const task: Task = { at: this.t + Math.max(0, Number.isFinite(ms) ? ms : 0), seq: this.seq++, fn, cancelled: false };
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      if (q.at < task.at || (q.at === task.at && q.seq < task.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, task);
    return task;
  }

  clearTimeout(h: unknown): void {
    if (h && typeof h === 'object') (h as Task).cancelled = true;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    let guard = 0;
    for (;;) {
      const next = this.queue[0];
      if (!next || next.at > end) break;
      if (++guard > 2_000_000) throw new Error(`VirtualClock: runaway timers at t=${this.t}`);
      this.queue.shift();
      this.t = Math.max(this.t, next.at);
      if (!next.cancelled) next.fn();
    }
    this.t = end;
  }
}

/** The relay's end of one socket. */
export class ServerConn {
  open = true;
  lastPing = 0;
  constructor(readonly client: FakeSocket, readonly id: number) {}
}

/** Client end (what RelayTransport holds). */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  conn: ServerConn | null = null;
  /** The link is cut: nothing travels any more in either direction (no close frames either). */
  severed = false;
  /** Frames this socket sent (after the handshake). */
  sent: string[] = [];
  closeCode: number | null = null;

  constructor(readonly net: RelayNet, readonly url: string, readonly protocols: string[]) {}

  get cid(): string {
    return parseProtocols(this.protocols.join(', ')).cid;
  }

  send(data: string): void {
    if (this.readyState === 0) throw new Error('InvalidStateError: still connecting');
    if (this.readyState !== 1) return;
    this.sent.push(data);
    const conn = this.conn;
    if (this.severed || !conn) return;
    this.net.clock.setTimeout(() => this.net.serverReceive(conn, data), this.net.latencyMs);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closeCode = code;
    const conn = this.conn;
    if (!this.severed && conn) this.net.clock.setTimeout(() => this.net.serverClosed(conn, code), this.net.latencyMs);
    this.net.clock.setTimeout(() => this.finish(code, reason), this.net.latencyMs * 2);
  }

  /** Delivered by the relay. */
  deliver(text: string): void {
    if (this.readyState !== 1 || this.severed) return;
    this.onmessage?.({ data: text });
  }

  finish(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

export interface RelayNetOptions {
  latencyMs?: number;
  code?: string;
  core?: RoomCoreOptions;
  /** Liveness sweep period (the Durable Object's alarm). */
  sweepMs?: number;
}

/** An in-process relay room + network. */
export class RelayNet {
  readonly clock = new VirtualClock();
  readonly code: string;
  latencyMs: number;
  readonly core: RoomCore<ServerConn>;
  readonly attachments = new Map<ServerConn, PeerAttachment | null>();
  readonly sockets: FakeSocket[] = [];
  bans: string[] = [];
  /** Client ids whose connection attempts fail until this virtual time. */
  readonly offlineUntil = new Map<string, number>();
  readonly stats = { toServer: 0, toClients: 0, maxClientFrame: 0, maxServerFrame: 0 };
  private nextConn = 1;
  private timer: unknown = null;
  private timerAt = Infinity;
  private readonly sweepMs: number;

  readonly io: RoomIO<ServerConn> = {
    send: (conn, text) => {
      if (!conn.open) return;
      this.stats.toClients++;
      this.stats.maxServerFrame = Math.max(this.stats.maxServerFrame, Buffer.byteLength(text));
      const c = conn.client;
      if (c.severed) return;
      this.clock.setTimeout(() => c.deliver(text), this.latencyMs);
    },
    close: (conn, code, reason) => {
      if (!conn.open) return;
      conn.open = false;
      this.attachments.set(conn, null);
      const c = conn.client;
      if (!c.severed) this.clock.setTimeout(() => c.finish(code, reason), this.latencyMs);
    },
    persist: (conn, att) => {
      this.attachments.set(conn, structuredClone(att));
    },
    saveBans: (b) => {
      this.bans = [...b];
    },
  };

  constructor(opts: RelayNetOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 25;
    this.code = opts.code ?? 'test-room';
    this.sweepMs = opts.sweepMs ?? 60_000;
    this.core = new RoomCore<ServerConn>(this.io, { now: () => this.clock.now(), ...opts.core });
    const sweep = (): void => {
      this.afterEvent();
      this.clock.setTimeout(sweep, this.sweepMs);
    };
    this.clock.setTimeout(sweep, this.sweepMs);
  }

  readonly createSocket = (url: string, protocols: string[]): WebSocketLike => {
    const s = new FakeSocket(this, url, protocols);
    this.sockets.push(s);
    this.clock.setTimeout(() => this.accept(s), this.latencyMs);
    return s;
  };

  /** A transport for this room (virtual clock, no storage, deterministic jitter). */
  transport(clientId: string): RelayTransport {
    return new RelayTransport({
      room: this.code, url: `ws://relay.test/api/room/${this.code}`, clientId, createSocket: this.createSocket, clock: this.clock,
      storage: null, random: () => 0.5, pageUrl: 'https://exiles.example/',
    });
  }

  /** The newest socket opened with this client id. */
  socketOf(clientId: string): FakeSocket | undefined {
    for (let i = this.sockets.length - 1; i >= 0; i--) if (this.sockets[i].cid === clientId) return this.sockets[i];
    return undefined;
  }

  /** The connection drops: both ends see an abnormal close (1006) after the latency. */
  drop(s: FakeSocket): void {
    if (s.readyState >= 2) return;
    const conn = s.conn;
    s.severed = true;
    if (conn) this.clock.setTimeout(() => this.serverClosed(conn, 1006), this.latencyMs);
    this.clock.setTimeout(() => s.finish(1006, ''), this.latencyMs);
  }

  /** The tab crashes / the machine vanishes: the relay sees 1006, the client never hears anything again. */
  crash(s: FakeSocket): void {
    const conn = s.conn;
    s.severed = true;
    s.onclose = null;
    s.onmessage = null;
    if (conn) this.clock.setTimeout(() => this.serverClosed(conn, 1006), this.latencyMs);
  }

  /** The link goes silent (no close on either side). */
  partition(s: FakeSocket): void {
    s.severed = true;
  }

  advance(ms: number): void {
    this.clock.advance(ms);
  }

  // ---- relay side -------------------------------------------------------------------------------

  private accept(s: FakeSocket): void {
    if (s.readyState !== 0) return;
    const code = /\/api\/room\/([^/?]+)/.exec(s.url)?.[1] ?? '';
    const proto = parseProtocols(s.protocols.join(', '));
    const off = this.offlineUntil.get(proto.cid);
    if (!proto.ok || !ROOM_CODE_RE.test(code) || (off !== undefined && this.clock.now() < off)) {
      s.finish(1006, 'handshake failed');
      return;
    }
    const conn = new ServerConn(s, this.nextConn++);
    s.conn = conn;
    s.readyState = 1;
    s.onopen?.({});
    this.core.connect(conn, proto.cid, proto.tab, syncPeerLabel(code, proto.cid));
    this.afterEvent();
  }

  serverReceive(conn: ServerConn, data: string): void {
    if (!conn.open) return;
    if (data === PING) {
      // the Durable Object's auto-response: answered without the room code
      conn.lastPing = this.clock.now();
      const c = conn.client;
      if (!c.severed) this.clock.setTimeout(() => c.deliver(PONG), this.latencyMs);
      return;
    }
    this.stats.toServer++;
    this.stats.maxClientFrame = Math.max(this.stats.maxClientFrame, Buffer.byteLength(data));
    this.core.message(conn, data);
    this.afterEvent();
  }

  serverClosed(conn: ServerConn, code: number): void {
    if (!conn.open) return;
    conn.open = false;
    this.core.disconnect(conn, code);
    this.afterEvent();
  }

  /** What the Durable Object does after every event: housekeeping + a timer for the next deadline. */
  afterEvent(): void {
    this.core.tick((c) => c.lastPing);
    const at = this.core.nextDeadline();
    if (Number.isFinite(at) && (this.timer === null || at < this.timerAt - 25)) {
      if (this.timer !== null) this.clock.clearTimeout(this.timer);
      this.timerAt = at;
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.timerAt = Infinity;
        this.afterEvent();
      }, Math.max(100, at - this.clock.now()));
    }
  }
}
