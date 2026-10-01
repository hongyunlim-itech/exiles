/**
 * Lockstep co-op wire protocol (net-core). All messages are compact JSON (≤ MAX_PAYLOAD_BYTES).
 *
 * TOPICS (events; admin-only, emitted by the HOST except 'chat', which any admin may emit):
 *   'turn'  { v, g, e, k, s, ls, lo, c?, a?, h?, b?, t, y, p }
 *           g gameId · e epoch (bumped on host failover) · k confirmed tick (peers may simulate up to k) · s shared speed
 *           ls last assigned command seq · lo oldest seq still in the host log · c command entries (redundant window)
 *           a acks {peer: highest accepted local seq} for peers with queued commands · h recent state hashes
 *           [[tick, hash]] · b [baseTick, baseNextSeq] (new epoch only) · t/y/p town name, year, population
 *   'cmds'  { v, g, e, c }                     overflow / resend of command entries
 *   'snap'  { v, g, e, id, i, n, k, ns, s, z, r, d }  snapshot chunk i of n (gzip+base64 when z = 1) of the town at
 *           tick k; ns = first command seq NOT contained in it; r = join request ids it answers
 *   'chat'  { t, rp?, rn?, i? }                chat text; rp/rn = original peer & nickname when relayed by the host;
 *           i = line id (every line is emitted twice, CHAT_RESEND_MS apart — receivers show each id once)
 *
 * PRESENCE (everyone; guests can only use presence):
 *   { v, n, c, ad, l?, h?, f?, q?, j?, ch?, x? }
 *   n nickname · c player colour (picked once) · ad 1 = admin (may host) · l local UI state {cu, ca, gh, t}
 *   h hosting {id, s since, e epoch, t town, y year, p pop, k tick}
 *   f following {id, e, k tick, a first command seq still missing (= resend request), sy 1 in sync}
 *   q command queue [[lseq, cmd]...] (host applies, acks via turn.a) · j join request {id, r, q ask counter, m?}
 *   ch chat outbox [[cseq, text]...] (non-admins; the host relays)
 *   x id of a town this peer hosted and stopped sharing on purpose (~30 s): its followers leave it (lobby, keeping
 *     their copy) instead of electing a new host
 *
 * COMMAND ENTRY: [seq, tick, issuerPeer, lseq, cmd] — applied by every peer at `tick` (before stepping to tick+1) in
 * seq order. The host assigns tick = its current tick (guests can never be past the last confirmed tick, which is ≤ the
 * host's current tick, so a delay of 0 is safe) and applies it at once.
 */
import type { Command } from './types';
import { cleanText } from './util';

export const PROTOCOL_VERSION = 1;

export const TOPIC_TURN = 'turn';
export const TOPIC_CMDS = 'cmds';
export const TOPIC_SNAP = 'snap';
export const TOPIC_CHAT = 'chat';

/** Host turn broadcast period (5 Hz) and keep-alive period while nothing changes (paused). */
export const TURN_INTERVAL_MS = 200;
export const KEEPALIVE_MS = 1000;
/** State hash every N ticks (5 game seconds). */
export const HASH_INTERVAL = 20;
/** Command entries the host (and every guest, for failover) keeps for resends. */
export const LOG_KEEP = 4000;
/** Extra 'cmds' messages per turn cycle when the redundant window does not fit into the turn. */
export const MAX_CMDS_MSGS_PER_TURN = 3;
/** Base64 characters per snapshot chunk. */
export const SNAP_CHUNK_CHARS = 3300;
/** A snapshot younger than this is shared with new joiners instead of making a new one. */
export const SNAP_REUSE_MS = 10_000;
/** Snapshots are kept for chunk resends this long after the last request. */
export const SNAP_KEEP_MS = 60_000;
/** Joiner: ask again for missing chunks after this long without progress. */
export const CHUNK_RETRY_MS = 1500;
/** Guest presence command queue budget (bytes of JSON) and entries. */
export const QUEUE_BYTES = 2000;
export const MAX_QUEUE = 24;
/** Unacknowledged commands (queue + overflow) before new ones are refused. */
export const MAX_PENDING = 80;
/** Road drags are split into commands of at most this many tiles (fits the presence queue & a turn). */
export const ROAD_SPLIT = 120;
/** Emit budget (events per second / burst) — the room starts dropping past ~40/s. */
export const EMIT_RATE = 30;
export const EMIT_BURST = 40;
/** Snapshot chunks are only sent while more than this many emit tokens are left (turns come first). */
export const CHUNK_TOKEN_RESERVE = 6;
/** A host whose peer vanished (or stopped claiming) this long ago is considered gone. */
export const HOST_LOST_MS = 2500;
/** A host that stops sharing marks the town closed in its presence (`x`) this long, so followers leave it. */
export const CLOSED_MARK_MS = 30_000;
/** Minimum time between two resyncs of a guest. */
export const RESYNC_MIN_MS = 3000;
/** Local UI presence (cursor/camera/ghost/tool) publish rate, and following-state (tick) publish rate. */
export const LOCAL_PRESENCE_MS = 100;
export const FOLLOW_PRESENCE_MS = 250;
/** Chat: max characters, outbox entries, outbox lifetime. */
export const CHAT_MAX = 240;
export const CHAT_OUTBOX = 3;
export const CHAT_OUTBOX_MS = 20_000;
/** Every chat event is emitted once more after this long (events may be dropped); receivers dedupe by id. */
export const CHAT_RESEND_MS = 400;

/** [seq, tick, issuerPeer, issuer's local seq (0 = host-issued), command] */
export type Entry = [number, number, string, number, Command];

export interface TurnMsg {
  v: number;
  g: string;
  e: number;
  k: number;
  s: number;
  ls: number;
  lo: number;
  c?: Entry[];
  a?: Record<string, number>;
  h?: [number, number][];
  b?: [number, number];
  t?: string;
  y?: number;
  p?: number;
}

export interface CmdsMsg {
  v: number;
  g: string;
  e: number;
  c: Entry[];
}

export interface SnapMsg {
  v: number;
  g: string;
  e: number;
  id: string;
  i: number;
  n: number;
  k: number;
  ns: number;
  s: number;
  z: number;
  r: string[];
  d: string;
}

export interface ChatMsg {
  t: string;
  rp?: string;
  rn?: string;
  i?: string;
}

export interface HostClaim {
  id: string;
  s: number;
  e: number;
  t: string;
  y: number;
  p: number;
  k: number;
}

export interface FollowInfo {
  id: string;
  e: number;
  k: number;
  a: number;
  sy: number;
}

export interface JoinRequest {
  id: string;
  r: string;
  q: number;
  m?: number[];
}

export interface LocalWire {
  cu?: [number, number];
  ca?: [number, number, number, number];
  gh?: [string, number, number, number, number, number, number];
  t?: string;
}

export interface PresenceWire {
  v: number;
  n: string;
  c?: string;
  ad: number;
  l?: LocalWire;
  h?: HostClaim;
  f?: FollowInfo;
  q?: [number, Command][];
  j?: JoinRequest;
  ch?: [number, string][];
  x?: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

/** Validated host claim from untrusted presence, or null. */
export function readHostClaim(v: unknown): HostClaim | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as Record<string, unknown>;
  if (!str(h.id) || !num(h.s) || !num(h.e) || !num(h.k)) return null;
  return {
    id: h.id, s: h.s, e: h.e, k: h.k, t: cleanText(h.t, 60) || 'Unnamed town', y: num(h.y) ? h.y : 1, p: num(h.p) ? h.p : 0,
  };
}

export function readFollow(v: unknown): FollowInfo | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  if (!str(f.id) || !num(f.e) || !num(f.k) || !num(f.a)) return null;
  return { id: f.id, e: f.e, k: f.k, a: f.a, sy: f.sy === 1 ? 1 : 0 };
}

export function readJoin(v: unknown): JoinRequest | null {
  if (!v || typeof v !== 'object') return null;
  const j = v as Record<string, unknown>;
  if (!str(j.id) || !str(j.r) || !num(j.q)) return null;
  const m = Array.isArray(j.m) ? j.m.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0).slice(0, 256) : undefined;
  return { id: j.id, r: j.r.slice(0, 32), q: j.q, m };
}

export function readQueue(v: unknown): [number, unknown][] {
  if (!Array.isArray(v)) return [];
  const out: [number, unknown][] = [];
  for (const e of v.slice(0, 64)) if (Array.isArray(e) && Number.isInteger(e[0]) && e[0] > 0) out.push([e[0] as number, e[1]]);
  return out;
}

export function readChatOutbox(v: unknown): [number, string][] {
  if (!Array.isArray(v)) return [];
  const out: [number, string][] = [];
  for (const e of v.slice(0, 8)) if (Array.isArray(e) && Number.isInteger(e[0]) && str(e[1])) out.push([e[0] as number, cleanText(e[1], CHAT_MAX)]);
  return out;
}

export function isEntry(v: unknown): v is Entry {
  return Array.isArray(v) && v.length === 5 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && str(v[2]) &&
    Number.isInteger(v[3]) && !!v[4] && typeof v[4] === 'object';
}
