/**
 * Public online rooms (the Cloudflare relay) — pure, DOM-free helpers shared by the UI and its tests: friendly room
 * codes, the `?room=` / `?relay=` / `?net=` URL parameters, room / invite / solo URLs, the relay health probe,
 * nickname cleaning, the "who can join" sentence per transport and the text for terminal close reasons.
 *
 * Nothing here touches `window`: callers pass `location.href` / `location.search` (and a fetch) in.
 */
import { relayBase } from '../../net/transport-relay';

/** Room codes the relay accepts (`/api/room/<code>`). */
export const ROOM_CODE_RE = /^[a-z0-9-]{3,32}$/;
/** Length of generated codes. */
export const ROOM_CODE_LENGTH = 6;
/** Friendly alphabet for generated codes: lowercase letters and digits without look-alikes (0/o, 1/l/i). */
export const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Max characters of a player nickname. */
export const NICK_MAX = 24;
/** localStorage key of the player's nickname. */
export const NICK_KEY = 'exiles.nick';
/** Players per relay room (the relay refuses more). */
export const MAX_ROOM_PLAYERS = 16;
/** Relay health probe timeout (ms). */
export const HEALTH_TIMEOUT_MS = 2000;
/** Health endpoint path of the relay Worker. */
export const HEALTH_PATH = '/api/health';

export type RoomKind = 'claude' | 'local' | 'memory' | 'relay';

// ---- room codes ----------------------------------------------------------------------------------

export function isValidRoomCode(code: unknown): code is string {
  return typeof code === 'string' && ROOM_CODE_RE.test(code);
}

/** Uniform [0, 1) from the platform's crypto RNG when available (codes should not be guessable). */
function secureRandom(): number {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.getRandomValues === 'function') {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      return a[0] / 4294967296;
    }
  } catch {
    /* fall back */
  }
  return Math.random();
}

/** A fresh friendly room code: ROOM_CODE_LENGTH characters from ROOM_CODE_ALPHABET. */
export function generateRoomCode(random: () => number = secureRandom, length = ROOM_CODE_LENGTH): string {
  const n = ROOM_CODE_ALPHABET.length;
  let out = '';
  for (let i = 0; i < length; i++) {
    const r = random();
    const idx = Number.isFinite(r) ? Math.min(n - 1, Math.max(0, Math.floor(r * n))) : 0;
    out += ROOM_CODE_ALPHABET[idx];
  }
  return out;
}

/**
 * What the player typed or pasted into "Join with code" → a valid room code, or null. Accepts any case, surrounding
 * or inner spaces, a leading '#', and a pasted invite link (`https://host/?room=abc123`).
 */
export function normalizeRoomCode(input: unknown): string | null {
  let s = typeof input === 'string' ? input.trim() : '';
  if (!s) return null;
  if (/room=/i.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const url = new URL(s, 'https://invite.invalid/');
      s = url.searchParams.get('room') ?? url.searchParams.get('ROOM') ?? '';
    } catch {
      return null;
    }
  }
  s = s.replace(/\s+/g, '').replace(/^#/, '').toLowerCase();
  return isValidRoomCode(s) ? s : null;
}

function params(search: string): URLSearchParams {
  try {
    return new URLSearchParams(search || '');
  } catch {
    return new URLSearchParams();
  }
}

/** The room code in a page's query string (`?room=`), lower-cased, or null when absent/invalid. */
export function readRoomParam(search: string): string | null {
  const raw = params(search).get('room');
  if (raw === null) return null;
  const s = raw.trim().toLowerCase();
  return isValidRoomCode(s) ? s : null;
}

/** Is any `?room=` parameter present (valid or not)? */
export function hasRoomParam(search: string): boolean {
  return params(search).has('room');
}

/**
 * Dev override of the relay base (`?relay=http://localhost:8787`, e.g. the Vite dev server + `wrangler dev`) as an
 * http(s) base without a trailing slash (ws → http for fetches), or null. Same rule as the transport's `relayBase`
 * (src/net/transport-relay.ts): only a local / LAN development host or this page's own host (`pageHref`) is accepted,
 * so a crafted link cannot make the page contact a stranger's server.
 */
export function readRelayOverride(search: string, pageHref: string | null = null): string | null {
  const raw = params(search).get('relay');
  if (!raw) return null;
  const ws = relayBase(pageHref, raw);
  if (!ws || ws === relayBase(pageHref, null)) return null; // refused (→ the page's own host) or the page's own host
  return ws.replace(/^ws/, 'http');
}

/** URL of the relay health endpoint for this page (same origin, or the `?relay=` override). */
export function relayHealthUrl(search: string, pageHref: string | null = null): string {
  const base = readRelayOverride(search, pageHref);
  return base ? `${base}${HEALTH_PATH}` : HEALTH_PATH;
}

/**
 * Should the main menu probe for the relay ("Play online")? Only on a plain web page: not inside a Claude artifact
 * (which blocks outside connections and has its own room), not already in a room, not with a `?net=` dev/off switch,
 * and only over http(s).
 */
export function shouldProbeRelay(env: { inClaude: boolean; search: string; protocol: string }): boolean {
  if (env.inClaude) return false;
  if (env.protocol !== 'http:' && env.protocol !== 'https:') return false;
  const p = params(env.search);
  return !p.has('room') && !p.has('net');
}

// ---- URLs ----------------------------------------------------------------------------------------

/**
 * `href` with `?room=<code>` set (other parameters such as `relay` kept), or with `room` removed when `code` is null
 * ("Play solo"). The fragment is dropped.
 */
export function withRoom(href: string, code: string | null): string {
  const url = new URL(href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  url.hash = '';
  return url.toString();
}

/**
 * The link to hand to friends: this page's origin and path with only `?room=<code>` (plus a `relay` dev override,
 * which the friend needs to reach the same relay). `https://<host>/?room=<code>` on the deployed Worker.
 */
export function buildInviteUrl(href: string, code: string): string {
  const url = new URL(href);
  const relay = url.searchParams.get('relay');
  const out = new URL(url.origin + url.pathname);
  out.searchParams.set('room', code);
  if (relay) out.searchParams.set('relay', relay);
  return out.toString();
}

// ---- relay probe ---------------------------------------------------------------------------------

export type FetchLike = (url: string, init?: { signal?: AbortSignal; cache?: RequestCache; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  text(): Promise<string>;
}>;

/**
 * Does a relay answer at `url`? True for a 2xx JSON object that does not say `ok: false` within `timeoutMs`; false on
 * errors, timeouts, non-2xx and non-JSON answers (a static host or the Vite dev server answers `/api/health` with
 * index.html). Never throws.
 */
export async function probeRelay(url: string, fetchFn: FetchLike | null | undefined, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  if (typeof fetchFn !== 'function') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      try {
        ctrl?.abort();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, Math.max(0, timeoutMs));
  });
  const attempt = (async (): Promise<boolean> => {
    try {
      const res = await fetchFn(url, { signal: ctrl?.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      if (!res || !res.ok) return false;
      const body = JSON.parse(await res.text()) as unknown;
      return !!body && typeof body === 'object' && !Array.isArray(body) && (body as { ok?: unknown }).ok !== false;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- nicknames -----------------------------------------------------------------------------------

/**
 * A nickname as typed → what is stored and shown: control / format / private-use characters removed (the room refuses
 * them), whitespace collapsed, trimmed, at most NICK_MAX characters (never splitting a character).
 */
export function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, NICK_MAX).join('').trim();
}

// ---- texts ---------------------------------------------------------------------------------------

/** Who can join a town hosted over this kind of room (the host notice in the menu / Players window / toasts). */
export function joinHint(kind: RoomKind | null): string {
  switch (kind) {
    case 'relay': return 'Anyone with the invite link can join.';
    case 'claude': return 'People you invite by email (Share menu) can join.';
    case 'local': return 'Other ?net=local windows of this browser can join.';
    default: return 'Other players in the room can join.';
  }
}

/** "Anyone with…" → "anyone with…" (a hint continuing a sentence). */
export function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export interface CloseInfo {
  /** Short heading ("Removed from the room"). */
  title: string;
  /** Full sentence for the player. */
  text: string;
  /** Is trying again (reloading the room link) worthwhile? */
  retry: boolean;
}

/**
 * Text for a transport's terminal close reason (`closeReason()` of the relay transport), or null when the connection
 * is not closed for good. Unknown codes read as a generic closed connection.
 */
export function closeReasonInfo(reason: string | null | undefined): CloseInfo | null {
  if (reason === null || reason === undefined || reason === '') return null;
  switch (String(reason).toLowerCase()) {
    case 'kicked':
    case 'banned':
      return { title: 'Removed from the room', text: 'You were removed from this room.', retry: false };
    case 'room_full':
    case 'full':
      return { title: 'Room full', text: `This room is full (${MAX_ROOM_PLAYERS} players).`, retry: true };
    case 'bad_room':
    case 'invalid_room':
    case 'bad_code':
      return { title: 'Invalid room', text: 'That room code is not valid.', retry: false };
    case 'bad_request':
      return { title: 'Connection refused', text: 'The online room refused this connection. Reload the page to try again.', retry: true };
    case 'version':
    case 'outdated':
    case 'protocol':
      return { title: 'Different version', text: 'This room runs a different version of the game — reload the page to update.', retry: true };
    case 'unreachable':
    case 'no_relay':
    case 'connect_failed':
    case 'failed':
      return { title: 'Could not connect', text: 'Could not reach the online room. Check your connection and try again.', retry: true };
    default:
      return { title: 'Disconnected', text: 'The connection to this room was closed.', retry: true };
  }
}
