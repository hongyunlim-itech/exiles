/**
 * Public-room transport (net-core): a WebSocket to the Exiles relay (cloud/worker.ts → one Durable Object per room,
 * logic in cloud/room-core.ts, which also documents the wire protocol). Anyone who opens
 * `https://<host>/?room=<code>` joins the room — no sign-in. Semantics match the Claude room / LocalTransport:
 * presence = one latest-wins object per tab (≤ 4 KiB, applied locally at once, sent coalesced ≤ 20 Hz, handed to
 * newcomers, cleared on leave), events = admin-only moments (≤ 4 KiB), delivered to everyone including the sender
 * (isMe && sameTab; the sender's copy is delivered locally), dropped while disconnected. Differences: exactly ONE
 * admin — the relay gives the host seat to the oldest connected peer and moves it when that peer leaves
 * ({@link RelayTransport.onAdminChange}); no profiles (`by` null, names come from presence); the admin may kick.
 *
 * Connection: `wss://<page host>/api/room/<code>` (or `?relay=<base>` for development, e.g. ws://localhost:8787 while
 * the page comes from `vite`), subprotocols `exiles-relay.1`, `cid.<clientId>` (stable per tab: sessionStorage),
 * `tab.<nonce>` (per page load). Reconnects with exponential backoff (0.5 s … 10 s) after drops — never after being
 * kicked, a full room or a refused request — and resumes its seat (same peer label, presence, host seat) when it is
 * back within the relay's 5 s grace. A `ping` every 5 s (answered by the relay without waking it) keeps the socket
 * alive; no answer for 12 s → reconnect. Never throws.
 */
import {
  CID_PREFIX, CLIENT_ID_RE, CLOSE_BAD_REQUEST, CLOSE_DUPLICATE, CLOSE_KICKED, CLOSE_ROOM_FULL, MAX_PAYLOAD, PING, PONG,
  PRESENCE_KEY_RE, RELAY_PROTOCOL, ROOM_CODE_RE, TAB_PREFIX, TOPIC_RE, utf8Length,
} from '../../cloud/room-core';
import type { Transport, TransportMessage, TransportPeer } from './transport';

/** Coalescing interval of presence sends (the session flushes ≤ 20 Hz anyway). */
export const PRESENCE_FLUSH_MS = 50;
export const PING_MS = 5000;
/** A ping unanswered this long (and nothing else heard) → the socket is dead: reconnect. */
export const CLIENT_DEAD_MS = 12_000;
/** A socket that has not said hello this long after being opened → retry. */
export const CONNECT_TIMEOUT_MS = 10_000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;
const TICK_MS = 1000;
const CAN_EMIT_WAIT_MS = 11_000;
const CLIENT_ID_KEY = 'exiles.relay.cid';

/** The subset of the browser WebSocket the transport uses (tests inject a fake). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

/** Time source & timers (tests drive a virtual clock). */
export interface RelayClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RelayTransportOptions {
  /** Room code ([a-z0-9-]{3,32}; see {@link normalizeRoomCode}). */
  room: string;
  /** Full WebSocket URL of the room (overrides `base`; tests). */
  url?: string;
  /** ws(s):// base of the relay; default: the page's own host. */
  base?: string | null;
  /** The `?relay=` value to carry in invite links (development). */
  relayParam?: string | null;
  /** Page URL for invite links (default `location.href`). */
  pageUrl?: string | null;
  /** Fixed client id (tests); default: sessionStorage, else a new one. */
  clientId?: string;
  createSocket?: WebSocketFactory;
  clock?: RelayClock;
  /** Storage for the client id (default sessionStorage; null = none). */
  storage?: StorageLike | null;
  /** Random source for the reconnect jitter (tests). */
  random?: () => number;
}

interface Other {
  peer: TransportPeer;
  json: string;
  joinedAt: number;
}

const REAL_CLOCK: RelayClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A random id from [A-Za-z0-9_-] (crypto when available). */
export function secureId(len: number): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(len);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = '';
  for (let i = 0; i < len; i++) s += abc[bytes[i] & 63];
  return s;
}

/** A user-typed room code → the canonical one ([a-z0-9-]{3,32}), or null. */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 32)
    .replace(/-+$/, '');
  return ROOM_CODE_RE.test(s) ? s : null;
}

/**
 * The `?room=` parameter of a page → its room code, or null when it is not one. Strict (trim + lower-case only), exactly
 * like the UI's `readRoomParam` (src/ui/coop/rooms.ts): a link names one room, it is never "corrected" into another.
 */
export function roomCodeFromParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return ROOM_CODE_RE.test(s) ? s : null;
}

const WORDS_A = ['amber', 'brisk', 'cedar', 'dusky', 'early', 'frost', 'golden', 'hazel', 'ivory', 'jolly', 'keen', 'lunar',
  'misty', 'noble', 'olive', 'pine', 'quiet', 'rustic', 'silver', 'tawny', 'upland', 'velvet', 'wild', 'young'];
const WORDS_B = ['acre', 'brook', 'cairn', 'dale', 'elm', 'ford', 'glen', 'heath', 'isle', 'knoll', 'loch', 'marsh', 'nook',
  'orchard', 'pond', 'ridge', 'shore', 'thicket', 'vale', 'weir', 'yard', 'barrow', 'copse', 'field'];

/** A fresh, hard-to-guess room code, e.g. "misty-glen-k3v6q2" (for "Create a public room"). */
export function randomRoomCode(): string {
  const id = secureId(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  const a = WORDS_A[Math.floor(Math.random() * WORDS_A.length)];
  const b = WORDS_B[Math.floor(Math.random() * WORDS_B.length)];
  return `${a}-${b}-${id}`;
}

function isLocalHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.local') ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/**
 * The relay's ws(s):// base for this page: the `?relay=` override when it points at a development host (localhost, a
 * LAN address or the page's own host — an invite link must not send players to a stranger's server), else the page's
 * own host. Null when there is none (not an http(s) page).
 */
export function relayBase(pageUrl: string | null, relayParam: string | null): string | null {
  let page: URL | null = null;
  try {
    page = pageUrl ? new URL(pageUrl) : null;
  } catch {
    page = null;
  }
  if (relayParam) {
    try {
      let s = relayParam.trim();
      if (!/^[a-z]+:\/\//i.test(s)) s = `ws://${s}`;
      const u = new URL(s);
      const proto = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : '';
      if (proto && (isLocalHost(u.hostname) || (page && u.host === page.host))) {
        return `${proto}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
      }
      console.warn('[net/relay] ignoring ?relay= (only local development hosts are allowed):', relayParam);
    } catch {
      console.warn('[net/relay] ignoring an invalid ?relay= value:', relayParam);
    }
  }
  if (!page || (page.protocol !== 'http:' && page.protocol !== 'https:')) return null;
  return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function defaultSocket(url: string, protocols: string[]): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

export class RelayTransport implements Transport {
  readonly kind = 'relay' as const;
  /** The room code. */
  readonly room: string;
  private readonly url: string;
  private readonly relayParam: string | null;
  private readonly pageUrl: string | null;
  private readonly createSocket: WebSocketFactory;
  private readonly clock: RelayClock;
  private readonly storage: StorageLike | null;
  private readonly random: () => number;
  private readonly tab = secureId(10);
  private cid: string;

  private ws: WebSocketLike | null = null;
  /** Generation of the current socket: events of older sockets are ignored. */
  private gen = 0;
  private openedAt = 0;
  /** hello received on the current socket. */
  private live = false;
  /** Closed for good (kicked, room full, refused). */
  private dead = false;
  private disposed = false;
  private reason: string | null = null;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private tickTimer: unknown = null;
  private flushTimer: unknown = null;
  private awaitingSince = 0;
  private lastPingAt = -Infinity;

  private self = '';
  private admin = '';
  private isAdminNow = false;
  private presence: Record<string, unknown> = {};
  private selfUpdatedAt = 0;
  private selfJoinedAt = 0;
  private selfPeerObj: TransportPeer | null = null;
  private sentPresence: string | null = null;
  private others = new Map<string, Other>();
  private snapshot: readonly TransportPeer[] = Object.freeze([]);

  private readonly peerFns = new Set<(p: readonly TransportPeer[]) => void>();
  private readonly topicFns = new Map<string, Set<(m: TransportMessage) => void>>();
  private readonly connFns = new Set<(c: boolean) => void>();
  private readonly adminFns = new Set<(admin: boolean) => void>();
  private canEmitWaiters: (() => void)[] = [];
  private readonly warned = new Set<string>();
  private readonly onPageHide = (e: Event): void => {
    if ((e as { persisted?: boolean }).persisted) return;
    // leave at once: the relay frees our seat and tells everyone (a dropped socket would hold it for the grace)
    const ws = this.ws;
    if (ws) {
      this.gen++;
      this.ws = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    }
  };

  constructor(opts: RelayTransportOptions) {
    this.room = opts.room;
    this.relayParam = opts.relayParam ?? null;
    let page: string | null = opts.pageUrl ?? null;
    if (opts.pageUrl === undefined) {
      try {
        page = typeof location !== 'undefined' ? location.href : null;
      } catch {
        page = null;
      }
    }
    this.pageUrl = page;
    const base = opts.base !== undefined ? opts.base : relayBase(page, this.relayParam);
    this.url = opts.url ?? `${base ?? 'ws://localhost:8787'}/api/room/${encodeURIComponent(this.room)}`;
    this.createSocket = opts.createSocket ?? defaultSocket;
    this.clock = opts.clock ?? REAL_CLOCK;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.random = opts.random ?? Math.random;
    this.cid = opts.clientId && CLIENT_ID_RE.test(opts.clientId) ? opts.clientId : this.loadClientId();
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', this.onPageHide);
    } catch {
      /* ignore */
    }
    this.open();
    this.scheduleTick();
  }

  // ---- Transport ----------------------------------------------------------------------------------

  selfPeer(): string {
    return this.self;
  }

  connected(): boolean {
    return this.live && !this.dead && !this.disposed;
  }

  canEmit(): Promise<boolean> {
    if (this.live || this.dead || this.disposed) return Promise.resolve(this.isAdminNow);
    return new Promise<boolean>((resolve) => {
      const done = (): void => resolve(this.isAdminNow);
      this.canEmitWaiters.push(done);
      this.clock.setTimeout(() => {
        const i = this.canEmitWaiters.indexOf(done);
        if (i >= 0) {
          this.canEmitWaiters.splice(i, 1);
          done();
        }
      }, CAN_EMIT_WAIT_MS);
    });
  }

  displayName(_peer?: TransportPeer): Promise<string> {
    return Promise.resolve(''); // public rooms have no profiles: the session uses the presence nickname
  }

  setPresence(patch: Record<string, unknown>): Promise<void> {
    if (this.disposed || this.dead) return Promise.resolve();
    try {
      const next: Record<string, unknown> = { ...this.presence };
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (!PRESENCE_KEY_RE.test(k)) return Promise.reject(new Error('invalid_argument: presence keys must be identifiers'));
        if (v === null || v === undefined) delete next[k];
        else next[k] = v;
      }
      const json = JSON.stringify(next);
      if (utf8Length(json) > MAX_PAYLOAD) return Promise.reject(new Error('invalid_argument: presence over 4 KiB'));
      this.presence = JSON.parse(json) as Record<string, unknown>;
    } catch (err) {
      return Promise.reject(new Error(`invalid_argument: ${String(err)}`));
    }
    this.selfUpdatedAt = this.clock.now();
    this.selfPeerObj = null;
    this.publish();
    this.scheduleFlush();
    return Promise.resolve();
  }

  peers(): readonly TransportPeer[] {
    return this.snapshot;
  }

  onPeers(fn: (peers: readonly TransportPeer[]) => void): () => void {
    this.peerFns.add(fn);
    queueMicrotask(() => {
      if (this.peerFns.has(fn)) this.call(fn, this.snapshot);
    });
    return () => this.peerFns.delete(fn);
  }

  emit(topic: string, data: unknown): Promise<void> {
    if (this.disposed || this.dead) return Promise.resolve();
    if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) return Promise.reject(new Error('invalid_argument: bad topic'));
    let dj: string;
    try {
      dj = JSON.stringify(data === undefined ? null : data);
    } catch {
      return Promise.reject(new Error('invalid_argument: data is not JSON'));
    }
    if (utf8Length(dj) > MAX_PAYLOAD) return Promise.reject(new Error('invalid_argument: event over 4 KiB'));
    if (!this.live) return Promise.resolve(); // dropped while disconnected — no echo (room semantics)
    if (!this.isAdminNow) return Promise.reject(new Error('not_permitted'));
    this.send(`{"t":"e","topic":${JSON.stringify(topic)},"data":${dj}}`);
    const copy = JSON.parse(dj) as unknown;
    const self = this.self;
    this.clock.setTimeout(() => this.deliver({ topic, data: copy, peer: self, isMe: true, sameTab: true }), 0);
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
      if (this.connFns.has(fn)) this.call(fn, this.connected());
    });
    return () => this.connFns.delete(fn);
  }

  /** The relay moved the host seat: fires with whether THIS tab holds it now (after every change). */
  onAdminChange(fn: (admin: boolean) => void): () => void {
    this.adminFns.add(fn);
    return () => this.adminFns.delete(fn);
  }

  /** Peer label of the host seat ('' while unknown). */
  adminPeer(): string {
    return this.admin;
  }

  /** Host seat only: remove `peer` from the room (the relay closes it and bans its client id for the room's life). */
  kick(peer: string): void {
    if (!this.live || !this.isAdminNow || typeof peer !== 'string' || !peer || peer === this.self) return;
    this.send(JSON.stringify({ t: 'kick', peer }));
  }

  /** Link others can open to join this room. */
  inviteUrl(): string | null {
    if (!this.pageUrl) return null;
    try {
      const u = new URL(this.pageUrl);
      const q = new URLSearchParams();
      q.set('room', this.room);
      if (this.relayParam) q.set('relay', this.relayParam);
      return `${u.origin}${u.pathname}?${q.toString()}`;
    } catch {
      return null;
    }
  }

  /** Why the transport stopped for good: 'kicked' | 'room_full' | 'bad_request' (else null). */
  closeReason(): string | null {
    return this.reason;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer('reconnectTimer');
    this.clearTimer('tickTimer');
    this.clearTimer('flushTimer');
    const ws = this.ws;
    this.ws = null;
    this.gen++;
    this.live = false;
    if (ws) {
      try {
        ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    }
    try {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('pagehide', this.onPageHide);
    } catch {
      /* ignore */
    }
    this.resolveCanEmit();
    for (const fn of [...this.connFns]) this.call(fn, false);
    this.peerFns.clear();
    this.topicFns.clear();
    this.connFns.clear();
    this.adminFns.clear();
  }

  // ---- connection ---------------------------------------------------------------------------------

  private open(): void {
    if (this.disposed || this.dead) return;
    this.clearTimer('reconnectTimer');
    const gen = ++this.gen;
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.url, [RELAY_PROTOCOL, CID_PREFIX + this.cid, TAB_PREFIX + this.tab]);
    } catch (err) {
      this.warnOnce('open', `[net/relay] cannot open ${this.url}`, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.openedAt = this.clock.now();
    this.live = false;
    this.awaitingSince = 0;
    this.lastPingAt = this.openedAt;
    ws.onopen = null;
    ws.onmessage = (ev) => {
      if (gen === this.gen) this.onFrame(ev?.data);
    };
    ws.onclose = (ev) => {
      if (gen === this.gen) this.onClose(typeof ev?.code === 'number' ? ev.code : 1006);
    };
    ws.onerror = () => undefined; // a close follows
  }

  /** Give up on the current socket (no hello in time / no answer) and reconnect. */
  private abandon(why: string): void {
    const ws = this.ws;
    this.gen++;
    this.ws = null;
    if (ws) {
      try {
        ws.close(4000, why);
      } catch {
        /* ignore */
      }
    }
    this.dropped();
    this.scheduleReconnect();
  }

  private onClose(code: number): void {
    this.ws = null;
    let terminal: string | null = null;
    if (code === CLOSE_KICKED) terminal = 'kicked';
    else if (code === CLOSE_ROOM_FULL) terminal = 'room_full';
    else if (code === CLOSE_BAD_REQUEST) terminal = 'bad_request';
    if (terminal) {
      this.dead = true;
      this.reason = terminal;
      this.live = false;
      this.clearTimer('reconnectTimer');
      this.clearTimer('tickTimer');
      this.clearTimer('flushTimer');
      this.others.clear();
      this.publish();
      console.warn(`[net/relay] left the room: ${terminal}`);
      this.resolveCanEmit();
      for (const fn of [...this.connFns]) this.call(fn, false);
      this.setAdmin('');
      return;
    }
    this.dropped();
    if (code === CLOSE_DUPLICATE) {
      // another tab uses our (copied) client id: become someone new
      this.cid = secureId(22);
      try {
        this.storage?.setItem(CLIENT_ID_KEY, this.cid);
      } catch {
        /* ignore */
      }
      this.attempt = 0;
    }
    this.scheduleReconnect();
  }

  /** The socket is gone (we keep the last known peers and host seat until the next hello, like the room does). */
  private dropped(): void {
    const was = this.live;
    this.live = false;
    this.awaitingSince = 0;
    if (was) for (const fn of [...this.connFns]) this.call(fn, false);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.dead || this.reconnectTimer !== null) return;
    const jitter = 0.75 + this.random() * 0.5;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 10) * jitter);
    this.attempt++;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private scheduleTick(): void {
    if (this.disposed || this.dead || this.tickTimer !== null) return;
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null;
      this.tick();
    }, TICK_MS);
  }

  /** Keepalive & liveness (≈1 Hz; a hidden tab's throttled timer may run it only once a minute). */
  private tick(): void {
    if (this.disposed || this.dead) return;
    const now = this.clock.now();
    if (this.ws) {
      if (!this.live) {
        if (now - this.openedAt > CONNECT_TIMEOUT_MS) this.abandon('connect timeout');
      } else if (this.awaitingSince > 0 && now - this.awaitingSince > CLIENT_DEAD_MS) {
        this.abandon('no answer');
      } else if (now - this.lastPingAt >= PING_MS) {
        this.lastPingAt = now;
        if (this.awaitingSince === 0) this.awaitingSince = now;
        this.send(PING);
      }
    }
    this.scheduleTick();
  }

  private send(text: string): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.send(text);
    } catch (err) {
      this.warnOnce('send', '[net/relay] send failed', err);
    }
  }

  // ---- incoming -----------------------------------------------------------------------------------

  private onFrame(data: unknown): void {
    this.awaitingSince = 0;
    if (typeof data !== 'string' || data === PONG) return;
    let m: unknown;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    switch (m.t) {
      case 'hello':
        this.onHello(m);
        return;
      case 'p':
        if (typeof m.peer === 'string' && m.peer !== this.self && isObj(m.presence)) {
          const cur = this.others.get(m.peer);
          this.others.set(m.peer, this.other(m.peer, m.presence, cur?.joinedAt ?? this.clock.now(), null));
          this.publish();
        }
        return;
      case 'join':
        if (typeof m.peer === 'string' && m.peer !== this.self && !this.others.has(m.peer)) {
          this.others.set(m.peer, this.other(m.peer, {}, typeof m.joinedAt === 'number' ? m.joinedAt : this.clock.now(), null));
          this.publish();
        }
        return;
      case 'leave':
        if (typeof m.peer === 'string' && this.others.delete(m.peer)) this.publish();
        return;
      case 'admin':
        if (typeof m.peer === 'string') this.setAdmin(m.peer);
        return;
      case 'e':
        if (this.live && typeof m.topic === 'string' && typeof m.peer === 'string') {
          const me = m.peer === this.self;
          this.deliver({ topic: m.topic, data: m.data ?? null, peer: m.peer, isMe: me, sameTab: me });
        }
        return;
      case 'err':
        if (m.code !== 'kicked' && m.code !== 'room_full' && m.code !== 'bad_request' && m.code !== 'duplicate') {
          this.warnOnce(`err:${String(m.code)}`, `[net/relay] the relay refused a message: ${String(m.code)} ${typeof m.msg === 'string' ? m.msg : ''}`);
        }
        return;
      default:
        return;
    }
  }

  private onHello(m: Record<string, unknown>): void {
    const self = typeof m.self === 'string' ? m.self : '';
    if (!self || !Array.isArray(m.peers)) return;
    const prev = this.others;
    const next = new Map<string, Other>();
    let selfJson: string | null = null;
    for (const raw of m.peers) {
      if (!isObj(raw) || typeof raw.peer !== 'string') continue;
      const pres = isObj(raw.presence) ? raw.presence : {};
      const joinedAt = typeof raw.joinedAt === 'number' ? raw.joinedAt : 0;
      if (raw.peer === self) {
        this.selfJoinedAt = joinedAt;
        selfJson = JSON.stringify(pres);
        continue;
      }
      next.set(raw.peer, this.other(raw.peer, pres, joinedAt, prev.get(raw.peer) ?? null));
    }
    const wasLive = this.live;
    if (self !== this.self) this.selfPeerObj = null;
    this.self = self;
    this.others = next;
    this.live = true;
    this.attempt = 0;
    this.awaitingSince = 0;
    this.sentPresence = selfJson; // what the relay holds for us; ours follows (below) if it differs
    this.publish();
    this.setAdmin(typeof m.admin === 'string' ? m.admin : '');
    this.resolveCanEmit();
    if (!wasLive) for (const fn of [...this.connFns]) this.call(fn, true);
    // our own presence after a (re)connect — coalesced, so the app gets a frame to react to a host-seat change first
    this.scheduleFlush();
  }

  private other(peer: string, presence: Record<string, unknown>, joinedAt: number, prev: Other | null): Other {
    const json = JSON.stringify(presence);
    if (prev && prev.json === json) return { peer: prev.peer, json, joinedAt }; // unchanged: keep updatedAt (idle)
    const p: TransportPeer = Object.freeze({
      peer, by: null, isMe: false, sameTab: false, guest: false, presence: Object.freeze({ ...presence }), updatedAt: this.clock.now(),
    });
    return { peer: p, json, joinedAt };
  }

  private setAdmin(peer: string): void {
    this.admin = peer;
    const is = !!this.self && peer === this.self && !this.dead;
    if (is === this.isAdminNow) return;
    this.isAdminNow = is;
    for (const fn of [...this.adminFns]) this.call(fn, is);
  }

  private deliver(msg: TransportMessage): void {
    if (this.disposed) return;
    const set = this.topicFns.get(msg.topic);
    if (!set) return;
    for (const fn of [...set]) this.call(fn, msg);
  }

  // ---- presence -----------------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.disposed || this.dead) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flushPresence();
    }, PRESENCE_FLUSH_MS);
  }

  private flushPresence(): void {
    if (!this.live || !this.ws) return; // sent after the next hello
    const json = JSON.stringify(this.presence);
    if (json === this.sentPresence) return;
    this.sentPresence = json;
    this.send(`{"t":"p","r":1,"patch":${json}}`);
  }

  private publish(): void {
    const list: { p: TransportPeer; at: number }[] = [];
    if (this.self) {
      if (!this.selfPeerObj || this.selfPeerObj.peer !== this.self) {
        this.selfPeerObj = Object.freeze({
          peer: this.self, by: null, isMe: true, sameTab: true, guest: false, presence: Object.freeze({ ...this.presence }),
          updatedAt: this.selfUpdatedAt || this.clock.now(),
        });
      }
      list.push({ p: this.selfPeerObj, at: this.selfJoinedAt });
    }
    if (!this.dead) for (const o of this.others.values()) list.push({ p: o.peer, at: o.joinedAt });
    list.sort((a, b) => a.at - b.at || (a.p.peer < b.p.peer ? -1 : a.p.peer > b.p.peer ? 1 : 0));
    this.snapshot = Object.freeze(list.map((x) => x.p));
    for (const fn of [...this.peerFns]) this.call(fn, this.snapshot);
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private loadClientId(): string {
    try {
      const v = this.storage?.getItem(CLIENT_ID_KEY);
      if (v && CLIENT_ID_RE.test(v)) return v;
    } catch {
      /* ignore */
    }
    const id = secureId(22);
    try {
      this.storage?.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* ignore */
    }
    return id;
  }

  private resolveCanEmit(): void {
    const ws = this.canEmitWaiters;
    this.canEmitWaiters = [];
    for (const done of ws) done();
  }

  private clearTimer(which: 'reconnectTimer' | 'tickTimer' | 'flushTimer'): void {
    const h = this[which];
    if (h !== null) {
      try {
        this.clock.clearTimeout(h);
      } catch {
        /* ignore */
      }
    }
    this[which] = null;
  }

  private call<A>(fn: (a: A) => void, arg: A): void {
    try {
      fn(arg);
    } catch (err) {
      console.error('[net/relay] listener threw', err);
    }
  }

  private warnOnce(key: string, text: string, err?: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (err !== undefined) console.warn(text, err);
    else console.warn(text);
  }
}
