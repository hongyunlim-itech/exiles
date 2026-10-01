/**
 * Exiles on Cloudflare: ONE Worker serves the Vite build (`dist/`, Workers Static Assets — see wrangler.jsonc) and the
 * public co-op relay:
 *
 *   GET /api/health             → 200 JSON
 *   GET /api/room/<code>        → WebSocket (code [a-z0-9-]{3,32}), one Durable Object per room (idFromName(code))
 *   everything else            → the static assets (single-page-application fallback)
 *
 * The room logic lives in ./room-core.ts (pure, unit-tested; it documents the wire protocol). This file is the
 * Cloudflare glue: the WebSocket Hibernation API (ctx.acceptWebSocket; per-socket state in serializeAttachment so a
 * woken object rebuilds the room from ctx.getWebSockets(); `ping` → `pong` answered by setWebSocketAutoResponse
 * without waking the object), bans in the object's storage for the room's lifetime (cleared when the room empties),
 * an in-memory timer only while something is due soon (a reconnect grace, the hosting peer's liveness) and a
 * once-a-minute alarm while the room is occupied to close silently dead sockets.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_KICKED, CLOSE_RESET, parseProtocols, peerLabel, PING, PONG, readAttachment, RELAY_PROTOCOL, ROOM_CODE_RE, RoomCore,
  type PeerAttachment, type RoomIO,
} from './room-core';

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
}

const ROOM_PATH = /^\/api\/room\/([^/]*)\/?$/;
const BANS_KEY = 'bans';
/** Slow liveness sweep while the room is occupied (each alarm is one storage row write). */
const SWEEP_MS = 60_000;
/** The in-memory housekeeping timer never fires sooner than this (no busy loop, whatever the core answers). */
const MIN_TIMER_MS = 100;

/** /api/health may be probed cross-origin: a `vite` dev page (localhost:5173) with `?relay=http://localhost:8787`. */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

/**
 * Browsers send Origin on WebSocket handshakes: accept our own host (any port: a `vite` dev page on a LAN address
 * talking to `wrangler dev --ip 0.0.0.0` on the same machine) and local development pages. Rooms carry no cookies or
 * credentials, so this only keeps other websites from using the relay as their own backend.
 */
export function originAllowed(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // not a browser (a browser always sends it); such a client could forge it anyway
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.hostname === url.hostname) return true;
  const h = o.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return json({ ok: true, service: 'exiles', protocol: RELAY_PROTOCOL, time: Date.now() }, 200, CORS);
    }
    const m = ROOM_PATH.exec(url.pathname);
    if (m) {
      let code = '';
      try {
        code = decodeURIComponent(m[1]);
      } catch {
        code = '';
      }
      if (!ROOM_CODE_RE.test(code)) return json({ error: 'bad_room_code' }, 400);
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
        return json({ error: 'expected_websocket' }, 426);
      }
      if (!originAllowed(request, url)) return json({ error: 'origin_not_allowed' }, 403);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** One public co-op room. */
export class Room extends DurableObject<Env> {
  private core: RoomCore<WebSocket> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  /** Whether the sweep alarm is set (null = unknown, e.g. after a wake-up). */
  private alarmSet: boolean | null = null;

  private readonly io: RoomIO<WebSocket> = {
    send: (ws, text) => {
      try {
        ws.send(text);
      } catch {
        /* closed meanwhile */
      }
    },
    close: (ws, code, reason) => {
      // tombstone first: a closing socket must never be rebuilt as a seat after a wake-up
      try {
        ws.serializeAttachment(null);
      } catch {
        /* ignore */
      }
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    persist: (ws, att: PeerAttachment) => {
      try {
        ws.serializeAttachment(att);
      } catch (err) {
        console.warn('[room] could not store the socket state', err);
      }
    },
    saveBans: (bans) => {
      try {
        if (bans.length > 0) this.ctx.storage.kv.put(BANS_KEY, bans.slice());
        else this.ctx.storage.kv.delete(BANS_KEY);
      } catch (err) {
        console.warn('[room] could not store the bans', err);
      }
    },
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // keepalives are answered by the runtime: they never wake a hibernated room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = ROOM_PATH.exec(url.pathname);
    let code = '';
    try {
      code = m ? decodeURIComponent(m[1]) : '';
    } catch {
      code = '';
    }
    if (!ROOM_CODE_RE.test(code)) return json({ error: 'bad_room_code' }, 400);
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') return json({ error: 'expected_websocket' }, 426);
    const proto = parseProtocols(request.headers.get('Sec-WebSocket-Protocol'));
    if (!proto.ok) return json({ error: 'unsupported_protocol', expected: RELAY_PROTOCOL }, 400);
    let peer = '';
    try {
      peer = await peerLabel(code, proto.cid);
    } catch {
      peer = '';
    }
    const core = this.room(); // before accepting: a rebuild must not see the new socket without its attachment
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    core.connect(server, proto.cid, proto.tab, peer); // a refusal sends {t:'err'} and closes with its code
    this.afterEvent();
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': RELAY_PROTOCOL } });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const core = this.room();
    if (!core.has(ws)) {
      core.message(ws, message, () => ws.deserializeAttachment());
      if (!core.has(ws)) {
        // no seat for this socket (its state is gone): the client reconnects and gets a fresh one
        this.io.close(ws, CLOSE_RESET, 'unknown connection');
        return;
      }
    } else core.message(ws, message);
    this.afterEvent();
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.room().disconnect(ws, code, () => ws.deserializeAttachment());
    this.afterEvent();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.room().disconnect(ws, 1006, () => ws.deserializeAttachment());
    this.afterEvent();
  }

  override async alarm(): Promise<void> {
    this.alarmSet = false;
    this.room();
    this.afterEvent();
  }

  // ---- glue -------------------------------------------------------------------------------------

  private readonly pingAt = (ws: WebSocket): number => {
    try {
      return this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    } catch {
      return 0;
    }
  };

  /** The room state, rebuilt from the open sockets' attachments after a wake-up. */
  private room(): RoomCore<WebSocket> {
    if (this.core) return this.core;
    let bans: string[] = [];
    try {
      const stored = this.ctx.storage.kv.get<string[]>(BANS_KEY);
      if (Array.isArray(stored)) bans = stored.filter((b) => typeof b === 'string');
    } catch {
      bans = [];
    }
    const core = new RoomCore<WebSocket>(this.io, { bans });
    for (const ws of this.ctx.getWebSockets()) {
      let att: unknown = null;
      try {
        att = ws.deserializeAttachment();
      } catch {
        att = null;
      }
      if (att === null) continue; // a socket we are closing
      if (!core.restore(ws, att)) {
        // unusable state: a banned id stays out, anyone else reconnects (4005 would stop the client for good)
        const a = readAttachment(att);
        if (a && core.isBanned(a.cid)) this.io.close(ws, CLOSE_KICKED, 'kicked');
        else this.io.close(ws, CLOSE_RESET, 'lost state');
      }
    }
    core.finishRestore();
    this.core = core;
    return core;
  }

  /** After every event: housekeeping, and the timers that keep it going. */
  private afterEvent(): void {
    const core = this.core;
    if (!core) return;
    core.tick(this.pingAt);
    if (core.isEmpty()) {
      this.clearTimer();
      if (this.alarmSet !== false) {
        this.alarmSet = false;
        this.ctx.storage.deleteAlarm().catch(() => undefined);
      }
      return;
    }
    // something due soon (a seat's reconnect grace, the hosting peer's liveness): an in-memory timer — it keeps the
    // object awake, which it is anyway while a town is hosted
    const at = core.nextDeadline();
    if (Number.isFinite(at) && (this.timer === null || at < this.timerAt - 25)) {
      this.clearTimer();
      this.timerAt = at;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.timerAt = Infinity;
        this.afterEvent();
      }, Math.max(MIN_TIMER_MS, at - Date.now()));
    }
    // slow sweep for silently dead sockets: an alarm (it wakes a hibernated room)
    if (this.alarmSet !== true) {
      const known = this.alarmSet;
      this.alarmSet = true;
      const set = (): Promise<void> => this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
      const p = known === false ? set() : this.ctx.storage.getAlarm().then((a) => (a === null ? set() : undefined));
      p.catch(() => {
        this.alarmSet = null;
      });
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }
}
