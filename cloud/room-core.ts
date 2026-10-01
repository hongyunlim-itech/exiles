/**
 * Exiles relay — ROOM CORE. A pure, framework-free state machine for one public co-op room (no Cloudflare APIs, so
 * it runs unchanged in the Durable Object (cloud/worker.ts), in vitest and against the client's RelayTransport).
 * It mirrors the Claude artifact `room` capability that the game was built on (src/net/transport.ts):
 *
 *   presence  one small JSON object per peer (≤ 4 KiB merged), latest wins, handed to newcomers, cleared on leave;
 *             anyone may set it
 *   events    moments on topics (≤ 4 KiB data), never stored or replayed; ONLY THE ADMIN may emit
 *   admin     the relay decides who holds the host seat: the oldest connected, non-banned peer. The seat is sticky —
 *             it moves only when its holder leaves (then the oldest CONNECTED peer gets it) — so a peer that comes
 *             back never takes it away from a peer who already hosts in its place.
 *
 * ── WIRE PROTOCOL (WebSocket text frames, subprotocol `exiles-relay.1`) ──────────────────────────────────────────
 * Handshake: `GET /api/room/<code>` (code [a-z0-9-]{3,32}) with `Sec-WebSocket-Protocol:
 *   exiles-relay.1, cid.<clientId>, tab.<tabNonce>` — clientId [A-Za-z0-9_-]{16,64} is stable per browser tab
 *   (sessionStorage; bans key on it), tabNonce [A-Za-z0-9_-]{4,32} is new per page load. The server answers
 *   `exiles-relay.1`. The peer label everyone sees is derived from (code, clientId) by SHA-256 ({@link peerLabel}), so
 *   it is stable across reconnects but does not reveal the clientId.
 * Keepalive: the client sends the bare text `ping` every few seconds; the server answers `pong` (the Durable Object
 *   answers it without waking up).
 *
 * client → server
 *   {t:'p', patch, r?:1}      presence: merge `patch` into this peer's object (a top-level null deletes a field);
 *                             r:1 replaces the whole object instead (the client sends that after every (re)connect)
 *   {t:'e', topic, data}      event (admin only; topic ^[a-z][a-z0-9_.-]{0,47}$; JSON of data ≤ 4096 bytes)
 *   {t:'kick', peer}          admin only: close that peer (4001) and ban its clientId for the room's lifetime
 * server → client
 *   {t:'hello', self, admin, peers:[{peer, joinedAt, presence}]}   after connect (peers includes self, oldest first;
 *                             `admin` = peer label of the host seat, '' when none)
 *   {t:'join', peer, joinedAt}  ·  {t:'leave', peer}  ·  {t:'admin', peer}
 *   {t:'p', peer, presence}   full presence object of another peer (never echoed to its sender)
 *   {t:'e', peer, topic, data}  an event (never echoed: the client delivers its own emits locally)
 *   {t:'err', code, msg?}     not_permitted | invalid_argument | too_large | kicked | room_full | duplicate | bad_request
 *
 * Close codes: 4001 kicked/banned · 4002 replaced (the same tab reconnected on another socket) · 4003 duplicate (a
 *   second tab with a copied clientId: pick a new id and reconnect) · 4004 room full · 4005 bad request ·
 *   4006 timeout (the relay heard nothing for too long; reconnect) · 4007 reset (the relay lost this socket's state,
 *   e.g. after an eviction: reconnect). Clients do not reconnect after 4001/4004/4005.
 *
 * Limits: 16 seats (a peer that dropped without a clean close keeps its seat — presence, seniority, host seat — for a
 *   5 s grace period, so a reconnect is seamless); client frames ≤ 4608 bytes (4 KiB payload + envelope); merged
 *   presence and event data ≤ 4096 bytes; per socket two token buckets (events+kicks, presence) of 40/s, burst 80 —
 *   frames past them are dropped silently; a socket silent for 90 s (no frame, no ping) is closed, the host seat's
 *   holder after 12 s when it was emitting in the last 30 s (a hosting tab emits turns every second, even hidden).
 */

export const RELAY_PROTOCOL = 'exiles-relay.1';
export const CID_PREFIX = 'cid.';
export const TAB_PREFIX = 'tab.';
export const PING = 'ping';
export const PONG = 'pong';

export const MAX_PEERS = 16;
/** UTF-8 bytes of JSON: event data and the merged presence object. */
export const MAX_PAYLOAD = 4096;
/** UTF-8 bytes of one client frame (payload + envelope). */
export const MAX_FRAME = MAX_PAYLOAD + 512;
export const RATE_PER_S = 40;
export const RATE_BURST = 80;
/** A seat whose socket dropped without a clean close is kept this long (reconnect → same seat). */
export const GRACE_MS = 5000;
/** A socket with no frame and no ping for this long is closed (hidden tabs may ping only once a minute). */
export const DEAD_MS = 90_000;
/** …the host seat's holder after this long, while it was emitting events recently. */
export const ADMIN_DEAD_MS = 12_000;
export const ADMIN_ACTIVE_MS = 30_000;
export const MAX_BANS = 256;

export const CLOSE_KICKED = 4001;
export const CLOSE_REPLACED = 4002;
export const CLOSE_DUPLICATE = 4003;
export const CLOSE_ROOM_FULL = 4004;
export const CLOSE_BAD_REQUEST = 4005;
export const CLOSE_TIMEOUT = 4006;
/** The relay could not match this socket to a seat (state lost, e.g. after an eviction): reconnect. */
export const CLOSE_RESET = 4007;

export const ROOM_CODE_RE = /^[a-z0-9-]{3,32}$/;
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const TAB_RE = /^[A-Za-z0-9_-]{4,32}$/;
export const PEER_RE = /^[0-9a-f]{16}$/;
export const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
/** Top-level presence keys: identifiers (never `__proto__` & co). */
export const PRESENCE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MAX_PRESENCE_KEYS = 64;

export type ErrCode =
  | 'not_permitted' | 'invalid_argument' | 'too_large' | 'kicked' | 'room_full' | 'duplicate' | 'bad_request';

/** What the relay keeps per socket so a Durable Object woken from hibernation can rebuild the room. */
export interface PeerAttachment {
  v: 1;
  /** Connection nonce (tells two sockets of one seat apart). */
  k: string;
  cid: string;
  tab: string;
  peer: string;
  joinedAt: number;
  presence: Record<string, unknown>;
  /** 1 = holds the host seat. */
  adm?: 1;
  /** Server time of the last write of this attachment (≥ connect time; liveness after a wake-up). */
  seen: number;
}

/** Side effects of the core (the Durable Object: WebSocket send/close/serializeAttachment, storage). */
export interface RoomIO<C> {
  send(conn: C, text: string): void;
  /** Close a socket (the host should make sure a closed socket is never restored as a seat). */
  close(conn: C, code: number, reason: string): void;
  /** Per-socket state that must survive hibernation. */
  persist(conn: C, att: PeerAttachment): void;
  /** The ban list changed (persist it; [] = forget). */
  saveBans(bans: readonly string[]): void;
}

export interface RoomCoreOptions {
  now?: () => number;
  bans?: Iterable<string>;
  maxPeers?: number;
  rate?: number;
  burst?: number;
  graceMs?: number;
  deadMs?: number;
  adminDeadMs?: number;
  /** Connection nonce generator (tests). */
  nonce?: () => string;
}

/** Public view of a seat (tests, diagnostics). */
export interface SeatInfo {
  peer: string;
  cid: string;
  joinedAt: number;
  presence: Readonly<Record<string, unknown>>;
  connected: boolean;
  admin: boolean;
}

class Bucket {
  private tokens: number;
  private last: number;

  constructor(private readonly rate: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    if (now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Seat<C> {
  cid: string;
  tab: string;
  peer: string;
  k: string;
  joinedAt: number;
  presence: Record<string, unknown>;
  json: string;
  conn: C | null;
  /** While `conn` is null: the seat is released at this time. */
  ghostUntil: number;
  lastMsgAt: number;
  lastEventAt: number;
  ev: Bucket;
  pr: Bucket;
}

/** UTF-8 byte length of a string. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function defaultNonce(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/**
 * The peer label everyone sees for `clientId` in room `code`: the first 16 hex digits of SHA-256 — stable across
 * reconnects (lockstep sessions key commands and the host claim on it) without revealing the id (bans key on the id).
 */
export async function peerLabel(code: string, clientId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`exiles-peer\n${code}\n${clientId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (let i = 0; i < 8; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

/** Parse a `Sec-WebSocket-Protocol` header into { ok, cid, tab } (ok = our protocol was offered). */
export function parseProtocols(header: string | null): { ok: boolean; cid: string; tab: string } {
  const list = (header ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const cid = list.find((p) => p.startsWith(CID_PREFIX))?.slice(CID_PREFIX.length) ?? '';
  const tab = list.find((p) => p.startsWith(TAB_PREFIX))?.slice(TAB_PREFIX.length) ?? '';
  return { ok: list.includes(RELAY_PROTOCOL), cid, tab };
}

export class RoomCore<C> {
  private readonly io: RoomIO<C>;
  private readonly now: () => number;
  private readonly maxPeers: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly graceMs: number;
  private readonly deadMs: number;
  private readonly adminDeadMs: number;
  private readonly nonce: () => string;
  /** Seats by peer label. */
  private readonly seats = new Map<string, Seat<C>>();
  private readonly byConn = new Map<C, Seat<C>>();
  private readonly bans: string[] = [];
  private admin = '';
  private lastJoined = 0;

  constructor(io: RoomIO<C>, opts: RoomCoreOptions = {}) {
    this.io = io;
    this.now = opts.now ?? (() => Date.now());
    this.maxPeers = opts.maxPeers ?? MAX_PEERS;
    this.rate = opts.rate ?? RATE_PER_S;
    this.burst = opts.burst ?? RATE_BURST;
    this.graceMs = opts.graceMs ?? GRACE_MS;
    this.deadMs = opts.deadMs ?? DEAD_MS;
    this.adminDeadMs = opts.adminDeadMs ?? ADMIN_DEAD_MS;
    this.nonce = opts.nonce ?? defaultNonce;
    for (const b of opts.bans ?? []) if (typeof b === 'string' && !this.bans.includes(b)) this.bans.push(b);
  }

  // ---- queries ----------------------------------------------------------------------------------

  /** Peer label of the host seat ('' when the room is empty). */
  adminPeer(): string {
    return this.admin;
  }

  /** Seats taken (connected + within their reconnect grace). */
  size(): number {
    return this.seats.size;
  }

  isEmpty(): boolean {
    return this.seats.size === 0;
  }

  has(conn: C): boolean {
    return this.byConn.has(conn);
  }

  isBanned(clientId: string): boolean {
    return this.bans.includes(clientId);
  }

  /** Seats, oldest first. */
  seatsView(): SeatInfo[] {
    return this.ordered().map((s) => ({
      peer: s.peer, cid: s.cid, joinedAt: s.joinedAt, presence: s.presence, connected: s.conn !== null, admin: s.peer === this.admin,
    }));
  }

  /**
   * When {@link tick} must run next at the latest (seat grace expiries; the host seat's liveness). Infinity = never.
   * Right after a tick it is always in the future.
   */
  nextDeadline(): number {
    const now = this.now();
    let t = Infinity;
    for (const s of this.seats.values()) {
      if (!s.conn) t = Math.min(t, s.ghostUntil);
      else if (s.peer === this.admin && now - s.lastEventAt < ADMIN_ACTIVE_MS) t = Math.min(t, s.lastMsgAt + this.adminDeadMs + 1);
    }
    return t;
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  /**
   * A socket completed the handshake. Returns the peer label, or null when refused (the socket has been sent an
   * `err` and closed: invalid ids, banned, duplicate tab, room full). `peer` must be {@link peerLabel}(code, clientId).
   */
  connect(conn: C, clientId: string, tab: string, peer: string): string | null {
    const now = this.now();
    if (!CLIENT_ID_RE.test(clientId) || !TAB_RE.test(tab) || !PEER_RE.test(peer)) {
      this.refuse(conn, 'bad_request', CLOSE_BAD_REQUEST);
      return null;
    }
    if (this.isBanned(clientId)) {
      this.refuse(conn, 'kicked', CLOSE_KICKED);
      return null;
    }
    const prev = this.byConn.get(conn);
    if (prev) this.detach(prev);
    const seat = this.seats.get(peer);
    if (seat) {
      if (seat.cid !== clientId) {
        this.refuse(conn, 'bad_request', CLOSE_BAD_REQUEST); // label collision (never in practice)
        return null;
      }
      if (seat.conn) {
        if (seat.tab !== tab) {
          // another tab with a copied sessionStorage: it must pick a new client id
          this.refuse(conn, 'duplicate', CLOSE_DUPLICATE);
          return null;
        }
        // the same page reconnected while we still thought its old socket was alive
        const old = seat.conn;
        this.detach(seat);
        this.io.close(old, CLOSE_REPLACED, 'replaced');
      }
      // resume the seat: same label, seniority, presence and host seat — nobody else notices
      seat.conn = conn;
      seat.tab = tab;
      seat.k = this.nonce();
      seat.ghostUntil = 0;
      seat.lastMsgAt = now;
      seat.ev = new Bucket(this.rate, this.burst, now);
      seat.pr = new Bucket(this.rate, this.burst, now);
      this.byConn.set(conn, seat);
      this.persist(seat);
      this.io.send(conn, this.helloFor(seat));
      return peer;
    }
    if (this.seats.size >= this.maxPeers) {
      this.refuse(conn, 'room_full', CLOSE_ROOM_FULL);
      return null;
    }
    const joinedAt = Math.max(now, this.lastJoined + 1);
    this.lastJoined = joinedAt;
    const s: Seat<C> = {
      cid: clientId, tab, peer, k: this.nonce(), joinedAt, presence: {}, json: '{}', conn, ghostUntil: 0, lastMsgAt: now,
      lastEventAt: 0, ev: new Bucket(this.rate, this.burst, now), pr: new Bucket(this.rate, this.burst, now),
    };
    this.seats.set(peer, s);
    this.byConn.set(conn, s);
    const newAdmin = !this.admin;
    if (newAdmin) this.admin = peer;
    this.persist(s);
    this.io.send(conn, this.helloFor(s));
    this.broadcast(JSON.stringify({ t: 'join', peer, joinedAt }), s);
    if (newAdmin) this.broadcast(JSON.stringify({ t: 'admin', peer }), s);
    return peer;
  }

  /**
   * The socket closed. A clean close (1000 / 1001: the tab left) frees the seat at once; anything else keeps it for
   * the reconnect grace. `hint` (the socket's attachment) finds the seat when the socket object is not known here
   * (a Durable Object woken by the close).
   */
  disconnect(conn: C, code: number, hint?: () => unknown): void {
    let seat = this.byConn.get(conn);
    if (!seat && hint) {
      // not a socket object we know: find its seat by the connection nonce in its attachment (an older socket of a
      // seat that moved on has another nonce — or none: closed sockets are tombstoned — and is ignored)
      const att = readAttachment(safeCall(hint));
      if (att) {
        const s = this.seats.get(att.peer);
        if (s && s.k === att.k) seat = s;
        else if (!s) {
          // a seat we never rebuilt (woken by its own close): make sure everyone forgets it
          this.broadcast(JSON.stringify({ t: 'leave', peer: att.peer }));
          return;
        }
      }
    }
    if (!seat) return;
    this.detach(seat);
    if (code === 1000 || code === 1001) this.removeSeat(seat);
    else seat.ghostUntil = this.now() + this.graceMs;
  }

  /** A text (or binary) frame arrived. `hint` as in {@link disconnect}. */
  message(conn: C, raw: unknown, hint?: () => unknown): void {
    let seat = this.byConn.get(conn);
    if (!seat && hint) seat = this.rebind(conn, hint);
    if (!seat) return;
    const now = this.now();
    seat.lastMsgAt = now;
    if (typeof raw !== 'string') {
      if (seat.ev.take(now)) this.err(seat, 'invalid_argument', 'binary frames are not supported');
      return;
    }
    if (raw === PING) {
      this.io.send(conn, PONG);
      return;
    }
    if (raw.length > MAX_FRAME || utf8Length(raw) > MAX_FRAME) {
      if (seat.ev.take(now)) this.err(seat, 'too_large', `frames are limited to ${MAX_FRAME} bytes`);
      return;
    }
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      m = null;
    }
    if (!isObj(m)) {
      if (seat.ev.take(now)) this.err(seat, 'invalid_argument', 'expected a JSON object');
      return;
    }
    switch (m.t) {
      case 'p':
        if (seat.pr.take(now)) this.onPresence(seat, m);
        return;
      case 'e':
        if (seat.ev.take(now)) this.onEvent(seat, m, now);
        return;
      case 'kick':
        if (seat.ev.take(now)) this.onKick(seat, m);
        return;
      default:
        if (seat.ev.take(now)) this.err(seat, 'invalid_argument', 'unknown frame type');
    }
  }

  /**
   * Housekeeping (call on every event and when {@link nextDeadline} / a periodic sweep is due): frees seats whose
   * grace ran out, and closes sockets that went silent (→ grace). `pingAt(conn)` = last keepalive answered for that
   * socket (ms; the Durable Object's auto-response timestamp). Returns the sockets closed for silence.
   */
  tick(pingAt?: (conn: C) => number): C[] {
    const now = this.now();
    const closed: C[] = [];
    for (const s of [...this.seats.values()]) {
      if (!s.conn) {
        if (now >= s.ghostUntil) this.removeSeat(s);
        continue;
      }
      const ping = pingAt ? safeNumber(() => pingAt(s.conn!)) : 0;
      // an answered keepalive counts as hearing from the socket (also moves nextDeadline() past it)
      if (ping > s.lastMsgAt) s.lastMsgAt = Math.min(ping, now);
      const last = s.lastMsgAt;
      const limit = s.peer === this.admin && now - s.lastEventAt < ADMIN_ACTIVE_MS ? this.adminDeadMs : this.deadMs;
      if (now - last > limit) {
        const c = s.conn;
        this.detach(s);
        s.ghostUntil = now + this.graceMs;
        this.io.close(c, CLOSE_TIMEOUT, 'timeout');
        closed.push(c);
      }
    }
    return closed;
  }

  /**
   * Rebuild a seat from a socket's attachment after hibernation (no broadcasts). Returns false when the attachment is
   * missing or invalid (the caller closes that socket). Call {@link finishRestore} after the last one.
   */
  restore(conn: C, attachment: unknown): boolean {
    const att = readAttachment(attachment);
    if (!att || this.isBanned(att.cid)) return false;
    const existing = this.seats.get(att.peer);
    if (existing) {
      if (existing.k !== att.k) return false;
      if (existing.conn && existing.conn !== conn) this.byConn.delete(existing.conn);
      existing.conn = conn;
      existing.ghostUntil = 0;
      this.byConn.set(conn, existing);
      return true;
    }
    const now = this.now();
    let json: string;
    try {
      json = JSON.stringify(att.presence);
    } catch {
      return false;
    }
    const s: Seat<C> = {
      cid: att.cid, tab: att.tab, peer: att.peer, k: att.k, joinedAt: att.joinedAt, presence: att.presence, json, conn,
      ghostUntil: 0, lastMsgAt: Math.min(now, att.seen), lastEventAt: 0, ev: new Bucket(this.rate, this.burst, now),
      pr: new Bucket(this.rate, this.burst, now),
    };
    this.seats.set(s.peer, s);
    this.byConn.set(conn, s);
    this.lastJoined = Math.max(this.lastJoined, s.joinedAt);
    if (att.adm === 1) {
      const cur = this.admin ? this.seats.get(this.admin) : undefined;
      if (!cur || s.joinedAt < cur.joinedAt) this.admin = s.peer;
    }
    return true;
  }

  /** After {@link restore}: make sure the host seat is taken (tells everyone when it had to be re-decided). */
  finishRestore(): void {
    if (this.admin && this.seats.has(this.admin)) return;
    this.admin = '';
    this.electAdmin();
  }

  // ---- internals ----------------------------------------------------------------------------------

  private onPresence(seat: Seat<C>, m: Record<string, unknown>): void {
    const patch = m.patch;
    if (!isObj(patch)) {
      this.err(seat, 'invalid_argument', 'presence patch must be an object');
      return;
    }
    const next: Record<string, unknown> = m.r === 1 ? {} : { ...seat.presence };
    for (const k of Object.keys(patch)) {
      if (!PRESENCE_KEY_RE.test(k)) {
        this.err(seat, 'invalid_argument', 'presence keys must be identifiers');
        return;
      }
      const v = patch[k];
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    if (Object.keys(next).length > MAX_PRESENCE_KEYS) {
      this.err(seat, 'invalid_argument', 'too many presence fields');
      return;
    }
    const json = JSON.stringify(next);
    if (utf8Length(json) > MAX_PAYLOAD) {
      this.err(seat, 'too_large', `presence is limited to ${MAX_PAYLOAD} bytes`);
      return;
    }
    if (json === seat.json) return;
    seat.presence = next;
    seat.json = json;
    this.persist(seat);
    this.broadcast(`{"t":"p","peer":${JSON.stringify(seat.peer)},"presence":${json}}`, seat);
  }

  private onEvent(seat: Seat<C>, m: Record<string, unknown>, now: number): void {
    if (seat.peer !== this.admin) {
      this.err(seat, 'not_permitted', 'only the host seat may emit events');
      return;
    }
    const topic = m.topic;
    if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
      this.err(seat, 'invalid_argument', 'bad topic');
      return;
    }
    const dj = JSON.stringify(m.data === undefined ? null : m.data);
    if (utf8Length(dj) > MAX_PAYLOAD) {
      this.err(seat, 'too_large', `event data is limited to ${MAX_PAYLOAD} bytes`);
      return;
    }
    seat.lastEventAt = now;
    this.broadcast(`{"t":"e","peer":${JSON.stringify(seat.peer)},"topic":${JSON.stringify(topic)},"data":${dj}}`, seat);
  }

  private onKick(seat: Seat<C>, m: Record<string, unknown>): void {
    if (seat.peer !== this.admin) {
      this.err(seat, 'not_permitted', 'only the host seat may kick');
      return;
    }
    const target = typeof m.peer === 'string' ? this.seats.get(m.peer) : undefined;
    if (!target || target === seat) {
      this.err(seat, 'invalid_argument', 'no such peer');
      return;
    }
    if (!this.bans.includes(target.cid)) {
      this.bans.push(target.cid);
      if (this.bans.length > MAX_BANS) this.bans.splice(0, this.bans.length - MAX_BANS);
      this.io.saveBans(this.bans.slice());
    }
    const c = target.conn;
    if (c) {
      this.detach(target);
      this.io.send(c, JSON.stringify({ t: 'err', code: 'kicked' }));
      this.io.close(c, CLOSE_KICKED, 'kicked');
    }
    this.removeSeat(target);
  }

  /** Find a seat for a socket object we do not know (woken from hibernation) via its attachment. */
  private rebind(conn: C, hint: () => unknown): Seat<C> | undefined {
    const att = readAttachment(safeCall(hint));
    if (!att) return undefined;
    const s = this.seats.get(att.peer);
    if (!s || s.k !== att.k) return undefined;
    if (s.conn && s.conn !== conn) this.byConn.delete(s.conn);
    s.conn = conn;
    s.ghostUntil = 0;
    this.byConn.set(conn, s);
    return s;
  }

  private detach(seat: Seat<C>): void {
    if (seat.conn) this.byConn.delete(seat.conn);
    for (const [c, s] of this.byConn) if (s === seat) this.byConn.delete(c);
    seat.conn = null;
  }

  private removeSeat(seat: Seat<C>): void {
    if (this.seats.get(seat.peer) !== seat) return;
    this.detach(seat);
    this.seats.delete(seat.peer);
    this.broadcast(JSON.stringify({ t: 'leave', peer: seat.peer }));
    if (this.admin === seat.peer) {
      this.admin = '';
      this.electAdmin();
    }
    if (this.seats.size === 0 && this.bans.length > 0) {
      // the room's lifetime is over: forget the bans (the code may be reused by anyone later)
      this.bans.length = 0;
      this.io.saveBans([]);
    }
  }

  /** The host seat is free: the oldest connected peer takes it (the oldest waiting one if nobody is connected). */
  private electAdmin(): void {
    if (this.admin || this.seats.size === 0) return;
    const all = this.ordered();
    const pick = all.find((s) => s.conn !== null) ?? all[0];
    this.admin = pick.peer;
    this.persist(pick);
    this.broadcast(JSON.stringify({ t: 'admin', peer: pick.peer }));
  }

  private ordered(): Seat<C>[] {
    return [...this.seats.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.peer < b.peer ? -1 : 1));
  }

  private helloFor(seat: Seat<C>): string {
    const peers = this.ordered().map((s) => `{"peer":${JSON.stringify(s.peer)},"joinedAt":${s.joinedAt},"presence":${s.json}}`);
    return `{"t":"hello","self":${JSON.stringify(seat.peer)},"admin":${JSON.stringify(this.admin)},"peers":[${peers.join(',')}]}`;
  }

  private persist(seat: Seat<C>): void {
    if (!seat.conn) return;
    const att: PeerAttachment = {
      v: 1, k: seat.k, cid: seat.cid, tab: seat.tab, peer: seat.peer, joinedAt: seat.joinedAt, presence: seat.presence,
      seen: this.now(),
    };
    if (seat.peer === this.admin) att.adm = 1;
    this.io.persist(seat.conn, att);
  }

  private broadcast(text: string, except?: Seat<C>): void {
    for (const s of this.seats.values()) if (s.conn && s !== except) this.io.send(s.conn, text);
  }

  private err(seat: Seat<C>, code: ErrCode, msg: string): void {
    if (seat.conn) this.io.send(seat.conn, JSON.stringify({ t: 'err', code, msg }));
  }

  private refuse(conn: C, code: ErrCode, closeCode: number): void {
    this.io.send(conn, JSON.stringify({ t: 'err', code }));
    this.io.close(conn, closeCode, code);
  }
}

function safeCall(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return null;
  }
}

function safeNumber(fn: () => number): number {
  try {
    const v = fn();
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Validate a stored attachment. */
export function readAttachment(v: unknown): PeerAttachment | null {
  if (!isObj(v) || v.v !== 1) return null;
  const { k, cid, tab, peer, joinedAt, presence, seen } = v;
  if (typeof k !== 'string' || typeof cid !== 'string' || typeof tab !== 'string' || typeof peer !== 'string') return null;
  if (!CLIENT_ID_RE.test(cid) || !PEER_RE.test(peer)) return null;
  if (typeof joinedAt !== 'number' || !Number.isFinite(joinedAt) || !isObj(presence)) return null;
  const att: PeerAttachment = {
    v: 1, k, cid, tab, peer, joinedAt, presence, seen: typeof seen === 'number' && Number.isFinite(seen) ? seen : 0,
  };
  if (v.adm === 1) att.adm = 1;
  return att;
}
