/**
 * Claude artifact room transport (net-core): wraps `claude.use('room')` (+ `claude.use('user')` for admin level and
 * display names). See vendor/claude-artifact-types/0.2.54/room.d.ts. Never throws: every platform call is guarded,
 * agent peers (kind "agent") are filtered out, terminal errors read as a disconnect.
 */
import type { Transport, TransportMessage, TransportPeer } from './transport';

// ---- the subset of the platform API we use (the vendor .d.ts is not part of the build) ----------

interface RoomSender {
  peer: string;
  by: string | null;
  isMe: boolean;
  sameTab: boolean;
  kind: 'viewer' | 'agent';
  guest: boolean;
}
interface RoomPeer extends RoomSender {
  presence: Readonly<Record<string, unknown>>;
  updatedAt: number;
}
interface RoomMessage extends RoomSender {
  topic: string;
  data?: unknown;
}
type OnError = (e: { code: string; message: string }) => void;
interface RoomApi {
  emit(topic: string, data?: unknown): Promise<void>;
  on(topic: string, handler: (msg: RoomMessage) => void, onError?: OnError): () => void;
  presence(patch: Record<string, unknown>): Promise<void>;
  peers(): readonly RoomPeer[];
  onPeers(handler: (change: { peers: readonly RoomPeer[] }) => void, onError?: OnError): () => void;
  connected(): boolean;
  onConnection(handler: (connected: boolean) => void, onError?: OnError): () => void;
}
interface UserProfile {
  id: string;
  name: string;
}
interface UserApi {
  canEdit(): Promise<boolean>;
  profiles(ids: readonly string[]): Promise<Record<string, UserProfile>>;
}
interface ClaudeGlobal {
  use?: (name: string) => Promise<unknown>;
}

const TERMINAL = new Set(['revoked', 'not_granted', 'capability_disabled', 'capability_removed', 'transform_error']);

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Resolve the room (and user) capabilities, or null (no platform, not granted, or no answer within `ms`). */
export async function connectClaudeRoom(ms = 11_000): Promise<Transport | null> {
  try {
    const claude = (globalThis as { claude?: ClaudeGlobal }).claude;
    if (!claude || typeof claude.use !== 'function') return null;
    const use = claude.use.bind(claude);
    const safe = (name: string): Promise<unknown> => {
      try {
        return Promise.resolve(use(name)).catch(() => null);
      } catch {
        return Promise.resolve(null);
      }
    };
    const deadline = timeout(ms, null);
    const [room, user] = await Promise.all([
      Promise.race([safe('room'), deadline]),
      Promise.race([safe('user'), deadline]),
    ]);
    if (!room || typeof (room as RoomApi).emit !== 'function') return null;
    return new ClaudeRoomTransport(room as RoomApi, user && typeof (user as UserApi).canEdit === 'function' ? (user as UserApi) : null);
  } catch {
    return null;
  }
}

export class ClaudeRoomTransport implements Transport {
  readonly kind = 'claude' as const;
  private readonly room: RoomApi;
  private readonly user: UserApi | null;
  private readonly unsubs: (() => void)[] = [];
  private rawPeers: readonly RoomPeer[] | null = null;
  private mapped: readonly TransportPeer[] = [];
  private self = '';
  private dead = false;
  private canEmitP: Promise<boolean> | null = null;
  private readonly names = new Map<string, Promise<string>>();
  private readonly connFns = new Set<(c: boolean) => void>();
  private warned = new Set<string>();

  constructor(room: RoomApi, user: UserApi | null) {
    this.room = room;
    this.user = user;
    // one platform connection listener fans out to ours (and turns a terminal error into a permanent disconnect)
    try {
      this.unsubs.push(room.onConnection((c) => this.fanConnection(c), (e) => this.onError(e)));
    } catch {
      /* ignore */
    }
  }

  selfPeer(): string {
    if (!this.self) this.peers();
    return this.self;
  }

  connected(): boolean {
    if (this.dead) return false;
    try {
      return this.room.connected();
    } catch {
      return false;
    }
  }

  canEmit(): Promise<boolean> {
    if (!this.canEmitP) {
      const u = this.user;
      this.canEmitP = u ? Promise.resolve().then(() => u.canEdit()).then((v) => v === true).catch(() => false) : Promise.resolve(false);
    }
    return this.canEmitP;
  }

  displayName(p: TransportPeer): Promise<string> {
    const u = this.user;
    const by = p.by;
    if (!u || !by) return Promise.resolve('');
    let n = this.names.get(by);
    if (!n) {
      n = Promise.resolve()
        .then(() => u.profiles([by]))
        .then((ps) => (ps && ps[by] && typeof ps[by].name === 'string' ? ps[by].name : ''))
        .catch(() => '');
      this.names.set(by, n);
      // names can change / resolve later: forget the cached promise after a while
      setTimeout(() => this.names.delete(by), 60_000);
    }
    return n;
  }

  setPresence(patch: Record<string, unknown>): Promise<void> {
    if (this.dead) return Promise.resolve();
    try {
      return Promise.resolve(this.room.presence(patch));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  peers(): readonly TransportPeer[] {
    if (this.dead) return this.mapped.filter((p) => p.sameTab);
    let raw: readonly RoomPeer[];
    try {
      raw = this.room.peers();
    } catch {
      return this.mapped;
    }
    if (raw !== this.rawPeers) {
      this.rawPeers = raw;
      this.mapped = Object.freeze(raw.filter((p) => p.kind !== 'agent').map((p) => this.map(p)));
      const me = this.mapped.find((p) => p.sameTab);
      if (me) this.self = me.peer;
    }
    return this.mapped;
  }

  onPeers(fn: (peers: readonly TransportPeer[]) => void): () => void {
    try {
      const off = this.room.onPeers(() => {
        try {
          fn(this.peers());
        } catch (err) {
          console.error('[net/claude] peers listener threw', err);
        }
      }, (e) => this.onError(e));
      this.unsubs.push(off);
      return off;
    } catch {
      return () => {};
    }
  }

  emit(topic: string, data: unknown): Promise<void> {
    if (this.dead) return Promise.resolve();
    try {
      return Promise.resolve(this.room.emit(topic, data)).catch((err: unknown) => {
        const code = (err as { code?: string })?.code ?? String(err);
        if (!this.warned.has(code)) {
          this.warned.add(code);
          console.warn(`[net/claude] emit on "${topic}" failed: ${code}`);
        }
        if (TERMINAL.has(code)) this.markDead();
        throw err;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  on(topic: string, fn: (msg: TransportMessage) => void): () => void {
    try {
      const off = this.room.on(topic, (m) => {
        if (m.kind === 'agent') return;
        if (m.sameTab && !this.self) this.self = m.peer;
        try {
          fn({ topic: m.topic, data: m.data, peer: m.peer, isMe: m.isMe, sameTab: m.sameTab });
        } catch (err) {
          console.error('[net/claude] listener threw', err);
        }
      }, (e) => this.onError(e));
      this.unsubs.push(off);
      return off;
    } catch {
      return () => {};
    }
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connFns.add(fn);
    queueMicrotask(() => {
      if (this.connFns.has(fn)) fn(this.connected());
    });
    return () => this.connFns.delete(fn);
  }

  dispose(): void {
    for (const off of this.unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.connFns.clear();
  }

  private map(p: RoomPeer): TransportPeer {
    return Object.freeze({
      peer: p.peer, by: p.by ?? null, isMe: !!p.isMe, sameTab: !!p.sameTab, guest: !!p.guest,
      presence: p.presence ?? {}, updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
    });
  }

  private fanConnection(c: boolean): void {
    for (const fn of [...this.connFns]) {
      try {
        fn(c && !this.dead);
      } catch (err) {
        console.error('[net/claude] connection listener threw', err);
      }
    }
  }

  private onError(e: { code: string; message: string }): void {
    if (TERMINAL.has(e?.code)) this.markDead();
  }

  private markDead(): void {
    if (this.dead) return;
    this.dead = true;
    this.fanConnection(false);
  }
}
