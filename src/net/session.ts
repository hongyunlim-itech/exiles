/**
 * NetSession — co-op lockstep session. PUBLIC API is an architect-owned contract; implementation by the net-core agent.
 *
 * Lifecycle (driven by main.ts):
 *   const session = new NetSession(initialGame, transport /* may be null → solo *\/);
 *   every frame: session.update(realDt)   // in solo/lobby it calls game.update(realDt) itself; in host/guest it
 *                                          // advances whole NET_STEP ticks per the lockstep protocol
 *   UI/input mutate ONLY via session.dispatch(cmd)
 *   host starts/loads a town: session.hostGame(game)
 *   a guest joins the host's running town: session.join()
 *   session.events 'gameReplaced' → app swaps session.game into renderer/UI/input/audio
 *
 * Protocol: see ./protocol.ts. In short — the HOST steps whole ticks at the shared speed, applies every command at
 * its current tick the moment it is issued (its own) or gathered (guests' presence queues), and broadcasts TURNS at
 * 5 Hz ("you may simulate up to tick k; here are the commands since the oldest one some guest still misses; here are
 * my latest state hashes"). GUESTS never simulate past the confirmed tick, apply command entries in seq order at their
 * tick, report the first missing seq in their presence (the host re-sends from there), compare state hashes every
 * HASH_INTERVAL ticks and resync from a fresh snapshot on a mismatch. Late joiners download a gzip snapshot in
 * chunks, then fast-forward. When the host leaves, the in-sync admin guest with the smallest peer label takes over
 * (epoch + 1); everyone else continues from its own state when it is not ahead of the new host's base, else resyncs.
 */
import { GAME_SPEEDS } from '../core/constants';
import { BUILDINGS } from '../core/defs';
import { EventBus } from '../core/events';
import type { BuildingType, GameSpeed, Rotation } from '../core/types';
import { Game } from '../sim/game';
import { applyCommand, precheckCommand, sanitizeCommand } from './commands';
import { hashGameState } from './hash';
import * as P from './protocol';
import { chunkString, packSnapshot, unpackSnapshot } from './snapshot';
import { MAX_PAYLOAD_BYTES, type Transport, type TransportMessage, type TransportPeer } from './transport';
import {
  NET_STEP, type ChatLine, type Command, type CommandResult, type LocalPresence, type NetEvents, type NetMode, type NetStatus,
  type PlayerInfo,
} from './types';
import { cleanText, jsonBytes, PLAYER_COLORS, randomId, strHash } from './util';

export interface NetSessionOptions {
  /** Wall clock in ms (Date.now by default; tests pass the MemoryHub's virtual clock). */
  now?: () => number;
  /** CPU clock for the per-frame simulation budget (performance.now by default). */
  cpuNow?: () => number;
  /** Max milliseconds of simulation per update() while playing (host stepping / guest catch-up). Default 8. */
  frameBudgetMs?: number;
  /** Max milliseconds per update() while fast-forwarding after a join (progress overlay is up). Default 20. */
  joinBudgetMs?: number;
}

/** Counters for diagnostics & tests (additive public API). */
export interface NetStats {
  turnsSent: number;
  cmdMsgsSent: number;
  chunksSent: number;
  chatSent: number;
  /** Emits skipped because the local rate budget was exhausted. */
  emitsDeferred: number;
  maxEmitBytes: number;
  maxPresenceBytes: number;
  commandsApplied: number;
  hashChecks: number;
  hashMismatches: number;
  lastSnapshot: { tick: number; rawBytes: number; packedBytes: number; chunks: number; saveMs: number; packMs: number } | null;
  lastJoin: { chunks: number; downloadMs: number; unpackMs: number; loadMs: number; catchUpTicks: number } | null;
}

interface HostSnap {
  id: string;
  tick: number;
  ns: number;
  speed: number;
  epoch: number;
  z: number;
  chunks: string[] | null;
  createdAt: number;
  lastUsed: number;
  reqs: Set<string>;
}

interface JoinState {
  gameId: string;
  reqId: string;
  ask: number;
  missing: number[] | null;
  snapId: string | null;
  n: number;
  chunks: Map<number, string>;
  meta: { k: number; ns: number; s: number; z: number; e: number } | null;
  startedAt: number;
  lastProgressAt: number;
  decoding: boolean;
  loaded: boolean;
  loadTick: number;
  resync: boolean;
}

interface BufEntry {
  e: P.Entry;
  epoch: number;
}

interface Claim {
  peer: string;
  h: P.HostClaim;
}

const SPEEDS = GAME_SPEEDS as readonly number[];
/** update() steps longer than this (s) come from a hidden tab's timer, not from animation frames. */
const BACKGROUND_DT = 0.15;
/** CPU budget (ms) of such a background update (nothing is rendered then). */
const BACKGROUND_BUDGET_MS = 40;

/** Road drags longer than ROAD_SPLIT tiles become several commands (each fits a queue entry / a turn). */
function splitRaw(cmd: Command): Command[] {
  if ((cmd?.op === 'road' || cmd?.op === 'removeRoad') && Array.isArray(cmd.tiles) && cmd.tiles.length > P.ROAD_SPLIT) {
    const out: Command[] = [];
    for (let i = 0; i < cmd.tiles.length; i += P.ROAD_SPLIT) out.push({ ...cmd, tiles: cmd.tiles.slice(i, i + P.ROAD_SPLIT) });
    return out;
  }
  return [cmd];
}

function mergeResult(a: CommandResult | null, b: CommandResult): CommandResult {
  if (!a) return b;
  const ok = a.ok || b.ok;
  const out: CommandResult = { ok };
  if (!ok) out.reason = a.reason ?? b.reason;
  if (a.pending || b.pending) out.pending = true;
  const id = a.buildingId ?? b.buildingId;
  if (id !== undefined) out.buildingId = id;
  if (a.count !== undefined || b.count !== undefined) out.count = (a.count ?? 0) + (b.count ?? 0);
  return out;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number, q: number): number => Math.round(v * q) / q;

export class NetSession {
  readonly events = new EventBus<NetEvents>();
  /** The game this peer is running/following right now. Replaced on host new-game/load and on guest join/resync. */
  game: Game;
  readonly stats: NetStats = {
    turnsSent: 0, cmdMsgsSent: 0, chunksSent: 0, chatSent: 0, emitsDeferred: 0, maxEmitBytes: 0, maxPresenceBytes: 0,
    commandsApplied: 0, hashChecks: 0, hashMismatches: 0, lastSnapshot: null, lastJoin: null,
  };

  private transport: Transport | null = null;
  private readonly now: () => number;
  private readonly cpuNow: () => number;
  private readonly frameBudget: number;
  private readonly joinBudget: number;
  private readonly unsubs: (() => void)[] = [];
  private disposed = false;

  private role: NetMode;
  private canHost = false;
  private wantHost = false;
  private me = '';

  // ---- shared lockstep state ----
  private tick = 0;
  private gameId = '';
  private epoch = 0;
  private since = 0;
  private sharedSpeed: GameSpeed = 1;
  private acc = 0;
  /** Host: next seq to assign. Guest: next seq to apply. */
  private nextSeq = 1;
  /** Applied command entries (contiguous seqs), bounded — the host's resend log; kept by guests for failover. */
  private log: P.Entry[] = [];
  private readonly entryBytes = new WeakMap<P.Entry, number>();
  /** Hashes this peer computed (tick → hash). */
  private readonly hashes = new Map<number, number>();
  private townName = '';
  private townYear = 1;
  private townPop = 0;

  // ---- host ----
  private lastTurnAt = -Infinity;
  private lastTurnTick = -1;
  private lastTurnSeq = 0;
  private recentHashes: [number, number][] = [];
  private baseInfo: [number, number] | null = null;
  private readonly hostAcked = new Map<string, number>();
  private readonly served = new Map<string, { r: string; q: number; snapId: string }>();
  private snaps: HostSnap[] = [];
  private chunkQueue: { snap: HostSnap; i: number; r: Set<string> }[] = [];
  private readonly relayedChat = new Map<string, number>();
  private hostWire: P.HostClaim | null = null;
  private lastHostPeers: readonly TransportPeer[] | null = null;
  private hostWireAt = -Infinity;

  // ---- guest ----
  private hostPeer = '';
  private confirmed = 0;
  private lastSeq = 0;
  private logLow = 1;
  private readonly buffer = new Map<number, BufEntry>();
  private readonly hostHashes = new Map<number, number>();
  private join_: JoinState | null = null;
  private outbox: { lseq: number; cmd: Command; bytes: number }[] = [];
  private lseq = 0;
  private resyncs = 0;
  private lastResyncAt = -Infinity;
  private pendingResync = false;
  private hostLostSince = -1;
  private lastHostClaim: P.HostClaim | null = null;
  private waiting = false;
  /** Host that stopped sharing: tell that town's followers for a while (presence `x`). */
  private closed: { id: string; until: number } | null = null;

  // ---- presence / UI ----
  private localWire: P.LocalWire | undefined;
  private localAt = -Infinity;
  private pendingLocal: LocalPresence | null = null;
  private followWire: P.FollowInfo | undefined;
  private followAt = -Infinity;
  private presenceUrgent = true;
  private lastPresenceJson = '';
  private lastPresenceKeys: string[] = [];
  private lastFlushAt = -Infinity;
  private chatOut: [number, string, number][] = [];
  /** Chat ids seen recently (every line is emitted twice and relays may repeat after a failover): dedupe. */
  private readonly chatSeen = new Set<string>();
  /** Chat events to emit once more (events may be dropped). */
  private chatResend: { msg: P.ChatMsg; at: number }[] = [];
  private cseq = 0;
  private readonly names = new Map<string, string>();
  private readonly nameAsked = new Set<string>();
  private nickname = '';
  /** Host-seat changes reported by a relay transport (onAdminChange). */
  private adminChanges = 0;
  private myColor = '';
  private tokens = P.EMIT_BURST;
  private statusSig = '';
  private statusAt = -Infinity;
  private playersSig = '';
  private playersAt = -Infinity;

  constructor(game: Game, transport: Transport | null, opts: NetSessionOptions = {}) {
    this.game = game;
    this.now = opts.now ?? (() => Date.now());
    this.cpuNow = opts.cpuNow ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.frameBudget = opts.frameBudgetMs ?? 8;
    this.joinBudget = opts.joinBudgetMs ?? 20;
    this.sharedSpeed = SPEEDS.includes(game.speed) ? game.speed : 1;
    this.role = 'solo';
    if (transport) this.attachTransport(transport);
  }

  /**
   * Attach the room once it is available (additive API): the app can start in solo play at once and light co-op up
   * when connectTransport() resolves (it may take a few seconds). Solo → lobby; a town passed to hostGame() before is
   * hosted as soon as this viewer is known to be an admin. No-op when a transport is already attached.
   */
  attachTransport(transport: Transport): void {
    if (this.disposed || this.transport) return;
    this.transport = transport;
    if (this.role === 'solo') this.role = 'lobby';
    this.statusAt = -Infinity;
    this.me = transport.selfPeer();
    this.unsubs.push(
      transport.on(P.TOPIC_TURN, (m) => this.onTurn(m)),
      transport.on(P.TOPIC_CMDS, (m) => this.onCmds(m)),
      transport.on(P.TOPIC_SNAP, (m) => this.onSnap(m)),
      transport.on(P.TOPIC_CHAT, (m) => this.onChat(m)),
      transport.onPeers(() => {
        this.playersAt = -Infinity;
      }),
      transport.onConnection((c) => {
        this.statusAt = -Infinity;
        this.presenceUrgent = true;
        if (!c) this.checkClosedForGood();
      }),
    );
    if (typeof transport.onAdminChange === 'function') {
      try {
        this.unsubs.push(transport.onAdminChange((admin) => this.onAdminChange(admin)));
      } catch (err) {
        console.warn('[net] could not follow the host seat', err);
      }
    }
    transport.canEmit().then((v) => {
      // a relay reports host-seat changes itself (onAdminChange): its first answer may be stale by now
      if (this.disposed || this.adminChanges > 0) return;
      this.canHost = v === true;
      this.presenceUrgent = true;
      this.statusAt = -Infinity;
      if (this.canHost && this.wantHost && this.role === 'lobby') this.startHosting();
    }, () => undefined);
  }

  // =============================================================================================
  // Public API
  // =============================================================================================

  status(): NetStatus {
    const t = this.transport;
    return {
      mode: this.role,
      connected: !!t && t.connected(),
      canHost: this.canHost,
      joinProgress: this.joinProgress(),
      ticksBehind: this.role === 'guest' || this.role === 'joining' ? Math.max(0, this.confirmed - this.tick) : 0,
      resyncs: this.resyncs,
      pendingCommands: this.outbox.length,
      label: this.label(),
    };
  }

  players(): PlayerInfo[] {
    const t = this.transport;
    const peers = t ? t.peers() : [];
    const now = this.now();
    if (peers.length === 0) {
      return [{
        peer: this.me || 'local', name: this.myName(), color: PLAYER_COLORS[0], isMe: true, isHost: this.role === 'host',
        guest: false, cursor: null, camera: null, ghost: null, tool: this.pendingLocal?.tool ?? '', idleMs: 0,
      }];
    }
    const colors = this.colorMap(peers);
    const seat = this.seatPeer();
    // cursors, cameras and ghosts are world positions: only meaningful for peers in the town this tab shows
    const shared = (this.role === 'host' || this.role === 'guest' || this.role === 'joining') && this.gameId ? this.gameId : '';
    const out: PlayerInfo[] = [];
    for (const p of peers) {
      const pr = p.presence as Record<string, unknown>;
      const l = (pr.l && typeof pr.l === 'object' ? pr.l : {}) as Record<string, unknown>;
      this.askName(p);
      const claim = seat === null || p.peer === seat ? P.readHostClaim(pr.h) : null;
      const follow = P.readFollow(pr.f);
      const inTown = p.sameTab || (!!shared && ((!!claim && claim.id === shared) || (!!follow && follow.id === shared)));
      out.push({
        peer: p.peer,
        name: p.sameTab ? this.myName() : this.nameOf(p.peer, pr),
        color: colors.get(p.peer) ?? PLAYER_COLORS[0],
        isMe: p.sameTab,
        isHost: p.sameTab ? this.role === 'host' : !!claim && (this.role === 'lobby' || this.role === 'host' || p.peer === this.hostPeer),
        guest: p.guest,
        cursor: inTown ? readCursor(l.cu) : null,
        camera: inTown ? readCamera(l.ca) : null,
        ghost: inTown ? readGhost(l.gh) : null,
        tool: typeof l.t === 'string' ? l.t.slice(0, 60) : '',
        idleMs: Math.max(0, now - p.updatedAt),
      });
    }
    return out;
  }

  /** Issue a player command. Solo/lobby: applied immediately to `game`. Host: queued for the next turn (applied at a
   *  tick on every peer, including this one). Guest: pre-validated, then sent to the host via presence. */
  dispatch(cmd: Command): CommandResult {
    if (this.disposed) return { ok: false, reason: 'The session has ended.' };
    const pieces: Command[] = [];
    for (const raw of splitRaw(cmd)) {
      const c = sanitizeCommand(raw);
      if (!c) return { ok: false, reason: 'Invalid command.' };
      pieces.push(c);
    }
    if (pieces[0].op === 'speed') {
      this.setSpeed(pieces[0].speed);
      return { ok: true, pending: this.role === 'guest' };
    }
    switch (this.role) {
      case 'solo':
      case 'lobby': {
        let res: CommandResult | null = null;
        for (const c of pieces) res = mergeResult(res, applyCommand(this.game, c));
        return res!;
      }
      case 'host': {
        let res: CommandResult | null = null;
        for (const c of pieces) res = mergeResult(res, this.hostApplyNew(this.me, 0, c));
        this.lastTurnAt = Math.min(this.lastTurnAt, this.now() - P.TURN_INTERVAL_MS + 60); // broadcast soon
        return res!;
      }
      case 'guest': {
        let pre: CommandResult | null = null;
        for (const c of pieces) pre = mergeResult(pre, precheckCommand(this.game, c));
        if (!pre!.ok) return pre!;
        if (this.outbox.length + pieces.length > P.MAX_PENDING) {
          return { ok: false, reason: 'Too many actions are waiting for the host — try again in a moment.' };
        }
        for (const c of pieces) this.enqueue(c);
        const out: CommandResult = { ok: true, pending: true };
        if (pre!.count !== undefined) out.count = pre!.count;
        return out;
      }
      case 'joining':
        return { ok: false, reason: 'Still joining the shared town…' };
    }
  }

  /** Shared speed. Solo: game.speed = s. Co-op: dispatches a 'speed' command. */
  setSpeed(speed: GameSpeed): void {
    if (this.disposed || !SPEEDS.includes(speed)) return;
    switch (this.role) {
      case 'solo':
      case 'lobby':
        this.game.speed = speed;
        this.sharedSpeed = speed;
        break;
      case 'host':
        if (speed !== this.sharedSpeed) this.hostApplyNew(this.me, 0, { op: 'speed', speed });
        this.lastTurnAt = -Infinity;
        break;
      case 'guest':
        if (speed !== this.sharedSpeed || this.outbox.some((o) => o.cmd.op === 'speed')) this.enqueue({ op: 'speed', speed });
        break;
      case 'joining':
        break;
    }
  }

  /** Effective speed for UI display (the host's shared speed in co-op). */
  speed(): GameSpeed {
    if (this.role === 'solo' || this.role === 'lobby') return this.game.speed;
    if (this.role === 'guest' && this.waiting) return 0;
    return this.sharedSpeed;
  }

  /** Per frame. Advances the simulation (solo: game.update; co-op: lockstep ticks) and pumps the protocol.
   *  Returns the game seconds simulated this frame (for the renderer's gameDt). */
  update(realDt: number): number {
    if (this.disposed) return 0;
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 1) : 0;
    let gameDt = 0;
    if (this.transport) {
      this.tokens = Math.min(P.EMIT_BURST, this.tokens + dt * P.EMIT_RATE);
      const me = this.transport.selfPeer();
      if (me) this.me = me;
      this.pumpRoom();
    }
    switch (this.role) {
      case 'solo':
      case 'lobby': {
        const before = this.game.state.time.elapsed;
        this.game.update(dt);
        gameDt = this.game.state.time.elapsed - before;
        break;
      }
      case 'host':
        this.refillSound(dt);
        gameDt = this.hostUpdate(dt);
        this.maybeEmitTurn(false);
        this.emitChunks();
        break;
      case 'guest':
      case 'joining':
        this.refillSound(dt);
        gameDt = this.guestUpdate(dt);
        break;
    }
    if (this.transport) {
      if (this.chatResend.length > 0) this.pumpChatResend();
      this.flushPresence();
    }
    this.refreshStatus();
    this.refreshPlayers();
    return gameDt;
  }

  /** Local UI state to share with other players (throttled internally; call every frame). */
  setLocalPresence(p: LocalPresence): void {
    this.pendingLocal = p;
  }

  /** This admin peer starts hosting `game` as the shared town (new game / load / continue). Guests get it next. */
  hostGame(game: Game): void {
    if (this.disposed) return;
    this.game = game;
    this.sharedSpeed = SPEEDS.includes(game.speed) ? game.speed : 1;
    this.join_ = null;
    this.outbox = [];
    this.waiting = false;
    this.wantHost = true;
    if (!this.transport) {
      this.role = 'solo';
    } else if (this.canHost) this.startHosting();
    else this.role = 'lobby';
    this.statusAt = -Infinity; // 'status' follows on the next update(), after the app has shown the town
    this.events.emit('gameReplaced', {});
  }

  /**
   * Play `game` locally, not shared (additive API): solo, or lobby while connected. Leaves a shared town first. Unlike
   * {@link hostGame} it never starts hosting and emits no 'gameReplaced' (the caller shows `game` itself).
   */
  setLocalGame(game: Game): void {
    if (this.disposed) return;
    if (this.role === 'host' || this.role === 'guest' || this.role === 'joining') this.leave();
    this.wantHost = false;
    this.game = game;
    this.sharedSpeed = SPEEDS.includes(game.speed) ? game.speed : 1;
    this.statusAt = -Infinity;
    this.refreshStatus();
  }

  /**
   * Stop sharing (host) or leave the shared town (guest) → lobby (solo without a room) with the current game.
   * A host that stops sharing also tells its followers (presence `x`), who then keep their copy and go to the lobby
   * instead of electing a new host — that only happens when a host vanishes (tab closed / crashed).
   */
  leave(): void {
    if (this.disposed) return;
    this.wantHost = false;
    if (this.role === 'host' || this.role === 'guest' || this.role === 'joining') {
      if (this.role === 'host' && this.gameId) this.closed = { id: this.gameId, until: this.now() + P.CLOSED_MARK_MS };
      this.role = this.transport ? 'lobby' : 'solo';
      this.join_ = null;
      this.outbox = [];
      this.buffer.clear();
      this.snaps = [];
      this.chunkQueue = [];
      this.waiting = false;
      this.pendingResync = false;
      this.hostLostSince = -1;
      this.game.speed = this.sharedSpeed;
      this.presenceUrgent = true;
      this.statusAt = -Infinity;
      this.refreshStatus();
    }
  }

  /** Guest: join the town currently hosted in the room (snapshot + catch-up). No-op if none. */
  join(): void {
    if (this.disposed || !this.transport) return;
    const c = this.winningClaim(this.claims(this.transport.peers()));
    if (!c) return;
    if (this.role === 'host') this.leave();
    this.wantHost = false;
    this.startJoin(c.h.id, c.peer, c.h.e, false);
    this.refreshStatus();
  }

  /** Guest: the host's town is not hosted right now (host tab gone, nobody could take over): the clock stands still. */
  get waitingForHost(): boolean {
    return this.role === 'guest' && this.waiting;
  }

  /** Is someone hosting a shared town in the room right now (for the main menu's "Join" button)? */
  hostedTown(): { hostName: string; townName: string; year: number; population: number } | null {
    if (!this.transport) return null;
    const peers = this.transport.peers();
    const c = this.winningClaim(this.claims(peers));
    if (!c) return null;
    const p = peers.find((x) => x.peer === c.peer);
    return { hostName: this.nameOf(c.peer, (p?.presence ?? {}) as Record<string, unknown>), townName: c.h.t, year: c.h.y, population: c.h.p };
  }

  sendChat(text: string): void {
    if (this.disposed) return;
    const t = cleanText(text, P.CHAT_MAX);
    if (!t) return;
    this.pushChat(this.me || 'local', this.myName(), t);
    const tr = this.transport;
    if (!tr || !tr.connected()) return;
    if (this.canHost && this.tokens >= 1) {
      const msg: P.ChatMsg = { t, i: randomId(10) };
      this.rememberChat(msg.i!);
      if (this.emitChat(msg)) return;
    }
    this.chatOut.push([++this.cseq, t, this.now()]);
    if (this.chatOut.length > P.CHAT_OUTBOX) this.chatOut.shift();
    this.presenceUrgent = true;
  }

  // ---- public rooms (relay transport) ---------------------------------------------------------------------------

  /**
   * Player-chosen display name (public rooms have no Claude profile), shared in presence (`n`); '' goes back to the
   * profile name / the default "Settler NN". Persisted by the UI, not here.
   */
  setNickname(name: string): void {
    if (this.disposed) return;
    const n = cleanText(name, 40);
    if (n === this.nickname) return;
    this.nickname = n;
    this.presenceUrgent = true;
    this.playersAt = -Infinity;
  }

  /** The name this player shows as: the nickname, else the profile name, else the default "Settler NN". */
  getNickname(): string {
    return this.myName();
  }

  /** Which transport is attached right now (null = solo). */
  transportKind(): 'claude' | 'local' | 'memory' | 'relay' | null {
    return this.transport ? this.transport.kind : null;
  }

  /** Link others can open to join this room (relay: https://<host>/?room=<code>), else null. */
  inviteLink(): string | null {
    const t = this.transport;
    if (!t || typeof t.inviteUrl !== 'function') return null;
    try {
      return t.inviteUrl();
    } catch {
      return null;
    }
  }

  /** Can this peer kick others right now (relay + this peer holds the host seat)? */
  canKick(): boolean {
    const t = this.transport;
    return !this.disposed && !!t && t.kind === 'relay' && typeof t.kick === 'function' && this.canHost && t.connected();
  }

  /** Kick a peer from the room (host only; no-op otherwise). The relay bans its client id for the room's lifetime. */
  kick(peer: string): void {
    if (!this.canKick() || typeof peer !== 'string' || !peer || peer === this.me) return;
    try {
      this.transport!.kick!(peer);
    } catch (err) {
      console.warn('[net] kick failed', err);
    }
  }

  /**
   * Why the room connection ended for good (additive): 'kicked' (the host removed this player), 'room_full',
   * 'bad_request' — else null (connected, reconnecting, or no room).
   */
  closeReason(): string | null {
    const t = this.transport;
    if (!t || typeof t.closeReason !== 'function') return null;
    try {
      return t.closeReason();
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    if (this.transport && this.lastPresenceKeys.length > 0) {
      const patch: Record<string, null> = {};
      for (const k of this.lastPresenceKeys) patch[k] = null;
      this.transport.setPresence(patch).catch(() => undefined);
    }
    this.events.clear();
  }

  // ---- additive helpers (diagnostics / tests / UI) ------------------------------------------------

  /** Current lockstep tick (co-op) — 0 in solo. */
  get currentTick(): number {
    return this.tick;
  }

  /** The shared town's id (co-op), '' otherwise. */
  get sharedGameId(): string {
    return this.role === 'solo' || this.role === 'lobby' ? '' : this.gameId;
  }

  /** State hashes this peer computed recently (tick → hash). */
  recentStateHashes(): ReadonlyMap<number, number> {
    return this.hashes;
  }

  // =============================================================================================
  // Common lockstep machinery
  // =============================================================================================

  private refillSound(dt: number): void {
    // lockstep steps the game directly: sound cues are throttled by real time exactly like Game.update does
    const rt = this.game.rt;
    rt.soundTokens = Math.min(4, rt.soundTokens + Math.min(dt, 0.1) * 4);
  }

  private stepOnce(): void {
    const g = this.game;
    g.rt.realTimeDriven = true;
    try {
      g.step(NET_STEP);
    } finally {
      g.rt.realTimeDriven = false;
    }
    this.tick++;
    if (this.tick % P.HASH_INTERVAL === 0) {
      const h = hashGameState(g);
      this.hashes.set(this.tick, h);
      if (this.hashes.size > 32) {
        for (const k of this.hashes.keys()) {
          if (this.hashes.size <= 24) break;
          this.hashes.delete(k);
        }
      }
      if (this.role === 'host') {
        this.recentHashes.push([this.tick, h]);
        if (this.recentHashes.length > 2) this.recentHashes.shift();
      } else this.checkHash(this.tick);
    }
    if (this.role !== 'host') this.applyDue();
  }

  /** Apply a command entry to the game (every peer, in seq order, at the entry's tick). */
  private applyEntry(e: P.Entry): CommandResult {
    const [, , peer, lseq, cmd] = e;
    let res: CommandResult;
    if (cmd && (cmd as { op?: string }).op === 'speed') {
      const c = sanitizeCommand(cmd);
      if (c && c.op === 'speed') {
        this.sharedSpeed = c.speed;
        this.game.speed = c.speed;
        res = { ok: true };
      } else res = { ok: false, reason: 'Invalid command.' };
    } else {
      try {
        res = applyCommand(this.game, cmd);
      } catch (err) {
        console.error('[net] command failed', cmd, err);
        res = { ok: false, reason: 'The action failed.' };
      }
    }
    this.log.push(e);
    if (this.log.length > P.LOG_KEEP + 500) this.log.splice(0, this.log.length - P.LOG_KEEP);
    this.stats.commandsApplied++;
    if (lseq > 0 && peer === this.me && !res.ok) {
      this.events.emit('rejected', { cmd, reason: res.reason ?? 'The host could not apply this action.' });
    }
    return res;
  }

  private emit(topic: string, data: unknown): boolean {
    const t = this.transport;
    if (!t || this.tokens < 1) {
      this.stats.emitsDeferred++;
      return false;
    }
    const bytes = jsonBytes(data);
    if (bytes > MAX_PAYLOAD_BYTES) {
      console.error(`[net] refusing to emit an oversized "${topic}" message (${bytes} bytes)`);
      return false;
    }
    this.stats.maxEmitBytes = Math.max(this.stats.maxEmitBytes, bytes);
    this.tokens -= 1;
    t.emit(topic, data).catch(() => undefined);
    return true;
  }

  private sizeOf(e: P.Entry): number {
    let b = this.entryBytes.get(e);
    if (b === undefined) {
      b = jsonBytes(e);
      this.entryBytes.set(e, b);
    }
    return b;
  }

  /**
   * Relay rooms: the relay's host seat (the only peer that may emit turns and snapshots), '' while unknown. null for
   * other transports (every admin may host there). Everyone may write presence in a public room, so in a relay room a
   * host claim (`h`) from anyone but the seat is ignored: a forged claim with an early `since` must neither make the
   * real host give way nor lure players into a town nobody can send.
   */
  private seatPeer(): string | null {
    const t = this.transport;
    if (!t || typeof t.adminPeer !== 'function') return null;
    try {
      return t.adminPeer();
    } catch {
      return '';
    }
  }

  private claims(peers: readonly TransportPeer[]): Claim[] {
    const out: Claim[] = [];
    const seat = this.seatPeer();
    for (const p of peers) {
      if (p.sameTab || (seat !== null && p.peer !== seat)) continue;
      const h = P.readHostClaim((p.presence as Record<string, unknown>).h);
      if (h) out.push({ peer: p.peer, h });
    }
    return out;
  }

  /** Conflict resolution between hosts: same town → higher epoch wins; else earliest `since`; ties → smaller peer. */
  private beats(a: Claim, b: Claim): boolean {
    if (a.h.id === b.h.id) return a.h.e > b.h.e || (a.h.e === b.h.e && a.peer < b.peer);
    return a.h.s < b.h.s || (a.h.s === b.h.s && a.peer < b.peer);
  }

  private winningClaim(cs: Claim[]): Claim | null {
    let best: Claim | null = null;
    for (const c of cs) if (!best || this.beats(c, best)) best = c;
    return best;
  }

  // =============================================================================================
  // Room pump (presence of everyone)
  // =============================================================================================

  private pumpRoom(): void {
    const t = this.transport!;
    const peers = t.peers();
    switch (this.role) {
      case 'host':
        this.hostPump(peers);
        break;
      case 'guest':
      case 'joining':
        this.guestPump(peers);
        break;
      case 'lobby':
        if (this.wantHost && this.canHost) this.startHosting();
        break;
      default:
        break;
    }
  }

  // =============================================================================================
  // Host
  // =============================================================================================

  private startHosting(): void {
    const now = this.now();
    this.role = 'host';
    this.gameId = randomId(10);
    this.epoch = 1;
    this.since = now;
    this.tick = 0;
    this.acc = 0;
    this.nextSeq = 1;
    this.log = [];
    this.hashes.clear();
    this.recentHashes = [];
    this.baseInfo = null;
    this.hostAcked.clear();
    this.served.clear();
    this.snaps = [];
    this.chunkQueue = [];
    this.relayedChat.clear();
    this.buffer.clear();
    this.join_ = null;
    this.outbox = [];
    this.hostPeer = this.me;
    this.lastTurnAt = -Infinity;
    this.lastTurnTick = -1;
    this.lastTurnSeq = 0;
    this.waiting = false;
    this.hostWireAt = -Infinity;
    this.game.speed = this.sharedSpeed;
    this.presenceUrgent = true;
    this.statusAt = -Infinity;
  }

  /** Assign the next seq to a command, apply it at the current tick and log it for broadcasting. */
  private hostApplyNew(peer: string, lseq: number, cmd: Command): CommandResult {
    const e: P.Entry = [this.nextSeq++, this.tick, peer, lseq, cmd];
    return this.applyEntry(e);
  }

  private hostPump(peers: readonly TransportPeer[]): void {
    const now = this.now();
    // another host that wins the conflict → give way and join it
    for (const c of this.claims(peers)) {
      const mine: Claim = { peer: this.me, h: this.hostClaim(now) };
      if (this.beats(c, mine)) {
        this.startJoin(c.h.id, c.peer, c.h.e, false);
        return;
      }
    }
    for (const p of peers) {
      if (p.sameTab) continue;
      const pr = p.presence as Record<string, unknown>;
      const f = P.readFollow(pr.f);
      const j = P.readJoin(pr.j);
      const mine = (f && f.id === this.gameId) || (j && j.id === this.gameId);
      // guests' queued commands: apply now (dedupe by the issuer's local seq), acked in the next turn
      if (mine && pr.q) {
        let acked = this.hostAcked.get(p.peer) ?? 0;
        for (const [lseq, raw] of P.readQueue(pr.q)) {
          if (lseq <= acked) continue;
          const cmd = sanitizeCommand(raw) ?? ({ op: 'invalid' } as unknown as Command);
          this.hostApplyNew(p.peer, lseq, cmd);
          acked = lseq;
        }
        this.hostAcked.set(p.peer, acked);
      }
      if (j && j.id === this.gameId) this.serveJoin(p.peer, j, now);
      // relay chat of viewers who cannot emit
      if (pr.ch) {
        let seen = this.relayedChat.get(p.peer) ?? 0;
        for (const [cs, text] of P.readChatOutbox(pr.ch)) {
          if (cs <= seen) continue;
          const nm = this.nameOf(p.peer, pr);
          const clean = cleanText(text, P.CHAT_MAX);
          const id = `${p.peer}.${cs}`;
          if (clean && !this.emitChat({ t: clean, rp: p.peer, rn: cleanText(nm, 40), i: id })) break;
          seen = cs;
          if (!clean) continue;
          // a host that took over relays the viewer's recent lines again: show each line once
          if (this.rememberChat(id)) this.pushChat(p.peer, nm, clean);
        }
        this.relayedChat.set(p.peer, seen);
      }
    }
    // forget snapshots nobody asked about for a while, and bookkeeping of peers who left
    if (this.snaps.length > 0) this.snaps = this.snaps.filter((s) => now - s.lastUsed < P.SNAP_KEEP_MS);
    if (this.served.size + this.relayedChat.size > 0 && peers !== this.lastHostPeers) {
      this.lastHostPeers = peers;
      const here = new Set(peers.map((p) => p.peer));
      for (const k of this.served.keys()) if (!here.has(k)) this.served.delete(k);
      for (const k of this.relayedChat.keys()) if (!here.has(k)) this.relayedChat.delete(k);
    }
  }

  private hostClaim(now: number): P.HostClaim {
    if (!this.hostWire || now - this.hostWireAt >= 1000 || this.hostWire.id !== this.gameId || this.hostWire.e !== this.epoch) {
      const s = this.game.state;
      this.townName = s.settings.townName;
      this.townYear = s.time.year;
      this.townPop = s.citizens.length;
      this.hostWire = {
        id: this.gameId, s: this.since, e: this.epoch, t: cleanText(this.townName, 40) || 'Unnamed town', y: this.townYear, p: this.townPop,
        k: this.tick,
      };
      this.hostWireAt = now;
    }
    return this.hostWire;
  }

  /**
   * CPU budget for one update(): a frame's worth normally; more for the long steps of a hidden tab's timer (no
   * rendering then, and a backgrounded host must keep the shared clock at real-time pace).
   */
  private budgetFor(realDt: number): number {
    return realDt > BACKGROUND_DT ? Math.max(this.frameBudget, BACKGROUND_BUDGET_MS) : this.frameBudget;
  }

  private hostUpdate(realDt: number): number {
    const speed = this.sharedSpeed;
    // realDt is already clamped to 1 s by update(): rAF frames bring ≤ 0.1 s, a hidden tab's timer ~0.25–1 s
    if (speed <= 0 || this.game.state.gameOver) this.acc = 0;
    else this.acc += (realDt * speed) / NET_STEP;
    const budget = this.budgetFor(realDt);
    const t0 = this.cpuNow();
    let n = 0;
    while (this.acc >= 1) {
      if (n > 0 && this.cpuNow() - t0 > budget) {
        this.acc = Math.min(this.acc, 1); // like solo play: drop the backlog instead of spiralling
        break;
      }
      this.stepOnce();
      this.acc -= 1;
      n++;
      if (this.game.state.gameOver) {
        this.acc = 0;
        break;
      }
    }
    return n * NET_STEP;
  }

  private maybeEmitTurn(force: boolean): void {
    if (this.role !== 'host' || !this.transport) return;
    const now = this.now();
    if (!force && now - this.lastTurnAt < P.TURN_INTERVAL_MS) return;
    const changed = this.tick !== this.lastTurnTick || this.nextSeq - 1 !== this.lastTurnSeq;
    if (!force && !changed && now - this.lastTurnAt < P.KEEPALIVE_MS) return;
    if (this.tokens < 1) {
      this.stats.emitsDeferred++;
      return;
    }
    const peers = this.transport.peers();
    // redundant window: from the first seq some follower still misses (or a joiner's snapshot base)
    let from = this.lastTurnSeq + 1;
    let ackPeers: string[] | null = null;
    for (const p of peers) {
      if (p.sameTab) continue;
      const pr = p.presence as Record<string, unknown>;
      const f = P.readFollow(pr.f);
      if (f && f.id === this.gameId && f.e === this.epoch) from = Math.min(from, f.a);
      const j = P.readJoin(pr.j);
      if (j && j.id === this.gameId) {
        const sv = this.served.get(p.peer);
        const snap = sv && this.snaps.find((s) => s.id === sv.snapId);
        if (snap) from = Math.min(from, snap.ns);
      }
      if (Array.isArray(pr.q) && pr.q.length > 0 && this.hostAcked.has(p.peer)) (ackPeers ??= []).push(p.peer);
    }
    const lo = this.log.length > 0 ? this.log[0][0] : this.nextSeq;
    from = Math.max(from, lo);
    const s = this.game.state;
    const msg: P.TurnMsg = {
      v: P.PROTOCOL_VERSION, g: this.gameId, e: this.epoch, k: this.tick, s: this.sharedSpeed, ls: this.nextSeq - 1, lo,
      t: cleanText(s.settings.townName, 40), y: s.time.year, p: s.citizens.length,
    };
    if (ackPeers) {
      msg.a = {};
      for (const p of ackPeers) msg.a[p] = this.hostAcked.get(p) ?? 0;
    }
    if (this.recentHashes.length > 0) msg.h = this.recentHashes.slice();
    if (this.baseInfo) msg.b = this.baseInfo;
    // entries to send: everything new since the last turn, preceded by re-sends from the first seq some follower
    // still misses (a lagging follower gets at most one extra message of re-sends per cycle)
    const entries: P.Entry[] = [];
    const fresh = this.lastTurnSeq + 1;
    let resendBudget = MAX_PAYLOAD_BYTES * 2;
    if (from <= this.nextSeq - 1 && this.log.length > 0) {
      const base = this.log[0][0];
      for (let seq = from; seq <= this.nextSeq - 1; seq++) {
        const e = this.log[seq - base];
        if (!e) continue;
        if (seq < fresh) {
          resendBudget -= this.sizeOf(e) + 1;
          if (resendBudget < 0) {
            seq = fresh - 1; // skip the rest of the old ones this cycle
            continue;
          }
        }
        entries.push(e);
      }
    }
    let budget = MAX_PAYLOAD_BYTES - jsonBytes(msg) - 16;
    let k = 0;
    const inTurn: P.Entry[] = [];
    while (k < entries.length) {
      const b = this.sizeOf(entries[k]) + 1;
      if (b > budget) break;
      budget -= b;
      inTurn.push(entries[k++]);
    }
    if (inTurn.length > 0) msg.c = inTurn;
    if (!this.emit(P.TOPIC_TURN, msg)) return;
    this.stats.turnsSent++;
    let extra = 0;
    while (k < entries.length && extra < P.MAX_CMDS_MSGS_PER_TURN && this.tokens >= 1) {
      const c: P.Entry[] = [];
      let bud = MAX_PAYLOAD_BYTES - 96;
      while (k < entries.length) {
        const b = this.sizeOf(entries[k]) + 1;
        if (b > bud && c.length > 0) break;
        bud -= b;
        c.push(entries[k++]);
      }
      if (!this.emit(P.TOPIC_CMDS, { v: P.PROTOCOL_VERSION, g: this.gameId, e: this.epoch, c } satisfies P.CmdsMsg)) break;
      this.stats.cmdMsgsSent++;
      extra++;
    }
    this.lastTurnAt = now;
    this.lastTurnTick = this.tick;
    this.lastTurnSeq = this.nextSeq - 1;
  }

  private serveJoin(peer: string, j: P.JoinRequest, now: number): void {
    const sv = this.served.get(peer);
    if (!sv || sv.r !== j.r) {
      const snap = this.snapshotFor(now);
      if (!snap) return;
      snap.reqs.add(j.r);
      snap.lastUsed = now;
      this.served.set(peer, { r: j.r, q: j.q, snapId: snap.id });
      this.enqueueChunks(snap, null, j.r);
      return;
    }
    if (sv.q === j.q) return;
    sv.q = j.q;
    const snap = this.snaps.find((s) => s.id === sv.snapId);
    if (!snap) {
      this.served.delete(peer); // expired: the next pump answers with a fresh snapshot
      return;
    }
    snap.lastUsed = now;
    this.enqueueChunks(snap, j.m && j.m.length > 0 ? j.m : null, j.r);
  }

  /** A recent snapshot to share, or a new one (save now at the current tick; gzip asynchronously). */
  private snapshotFor(now: number): HostSnap | null {
    const reuse = this.snaps.find((s) => s.epoch === this.epoch && now - s.createdAt < P.SNAP_REUSE_MS);
    if (reuse) return reuse;
    const t0 = this.cpuNow();
    let save: string;
    try {
      save = this.game.save();
    } catch (err) {
      console.error('[net] snapshot failed', err);
      return null;
    }
    const saveMs = this.cpuNow() - t0;
    const snap: HostSnap = {
      id: randomId(8), tick: this.tick, ns: this.nextSeq, speed: this.sharedSpeed, epoch: this.epoch, z: 0, chunks: null,
      createdAt: now, lastUsed: now, reqs: new Set(),
    };
    this.snaps.push(snap);
    const t1 = this.cpuNow();
    packSnapshot(save).then((p) => {
      if (this.disposed) return;
      snap.z = p.z;
      snap.chunks = chunkString(p.data, P.SNAP_CHUNK_CHARS);
      this.stats.lastSnapshot = {
        tick: snap.tick, rawBytes: p.rawBytes, packedBytes: p.packedBytes, chunks: snap.chunks.length, saveMs, packMs: this.cpuNow() - t1,
      };
      for (const r of snap.reqs) this.enqueueChunks(snap, null, r);
    }, (err: unknown) => {
      console.error('[net] snapshot compression failed', err);
      this.snaps = this.snaps.filter((s) => s !== snap);
      for (const [peer, sv] of this.served) if (sv.snapId === snap.id) this.served.delete(peer);
    });
    return snap;
  }

  private enqueueChunks(snap: HostSnap, indices: number[] | null, r: string): void {
    if (!snap.chunks) return; // queued for everyone once packed
    const n = snap.chunks.length;
    const list = indices ?? Array.from({ length: n }, (_, i) => i);
    for (const i of list) {
      if (i < 0 || i >= n) continue;
      const q = this.chunkQueue.find((c) => c.snap === snap && c.i === i);
      if (q) q.r.add(r);
      else this.chunkQueue.push({ snap, i, r: new Set([r]) });
    }
  }

  private emitChunks(): void {
    while (this.chunkQueue.length > 0 && this.tokens > P.CHUNK_TOKEN_RESERVE) {
      const c = this.chunkQueue.shift()!;
      const s = c.snap;
      if (!s.chunks) continue;
      const msg: P.SnapMsg = {
        v: P.PROTOCOL_VERSION, g: this.gameId, e: s.epoch, id: s.id, i: c.i, n: s.chunks.length, k: s.tick, ns: s.ns,
        s: s.speed, z: s.z, r: [...c.r].slice(0, 8), d: s.chunks[c.i],
      };
      if (!this.emit(P.TOPIC_SNAP, msg)) {
        this.chunkQueue.unshift(c);
        break;
      }
      this.stats.chunksSent++;
    }
  }

  // =============================================================================================
  // Guest
  // =============================================================================================

  private startJoin(gameId: string, hostPeer: string, epoch: number, resync: boolean): void {
    const now = this.now();
    const sameGame = gameId === this.gameId;
    this.role = 'joining';
    this.gameId = gameId;
    this.hostPeer = hostPeer;
    this.epoch = epoch;
    this.join_ = {
      gameId, reqId: randomId(8), ask: 0, missing: null, snapId: null, n: 0, chunks: new Map(), meta: null, startedAt: now,
      lastProgressAt: now, decoding: false, loaded: false, loadTick: 0, resync,
    };
    this.buffer.clear();
    this.hostHashes.clear();
    this.hashes.clear();
    this.confirmed = 0;
    this.lastSeq = 0;
    this.acc = 0;
    this.pendingResync = false;
    this.waiting = false;
    this.hostLostSince = -1;
    this.snaps = [];
    this.chunkQueue = [];
    this.baseInfo = null;
    if (!sameGame) this.outbox = [];
    this.presenceUrgent = true;
    this.statusAt = -Infinity;
  }

  private resync(reason: string): void {
    const now = this.now();
    if (now - this.lastResyncAt < P.RESYNC_MIN_MS) {
      this.pendingResync = true;
      return;
    }
    this.lastResyncAt = now;
    this.resyncs++;
    console.warn(`[net] resyncing with the host: ${reason}`);
    this.startJoin(this.gameId, this.hostPeer, this.epoch, true);
  }

  private guestPump(peers: readonly TransportPeer[]): void {
    const now = this.now();
    // the host stopped sharing our town on purpose: keep our copy and go back to the lobby (no host election)
    for (const p of peers) {
      if (!p.sameTab && p.peer === this.hostPeer && (p.presence as Record<string, unknown>).x === this.gameId && this.gameId) {
        console.info('[net] the host stopped sharing the town');
        this.leave();
        return;
      }
    }
    const claims = this.claims(peers);
    const cur = claims.find((c) => c.peer === this.hostPeer);
    if (cur && cur.h.id !== this.gameId) {
      // our host started or loaded another town: follow it there
      this.startJoin(cur.h.id, cur.peer, cur.h.e, false);
      return;
    }
    const mine = this.winningClaim(claims.filter((c) => c.h.id === this.gameId));
    if (mine) {
      this.lastHostClaim = mine.h;
      this.hostLostSince = -1;
      this.waiting = false;
      if (this.join_ && !this.join_.loaded && mine.peer !== this.hostPeer && mine.h.e > this.epoch) {
        this.startJoin(mine.h.id, mine.peer, mine.h.e, this.join_.resync); // the host changed while we downloaded
      }
      return;
    }
    // nobody hosts our town right now (brief reconnects are normal: only a loss that persists counts, and never
    // decide anything while we ourselves are disconnected)
    if (!this.transport!.connected()) return;
    if (this.hostLostSince < 0) this.hostLostSince = now;
    const lostFor = now - this.hostLostSince;
    if (lostFor < P.HOST_LOST_MS) return;
    this.waiting = true;
    this.statusAt = -Infinity;
    // failover: an admin follower with a loaded town takes over — in-sync ones first, then the smallest peer label
    const loaded = !this.join_ || this.join_.loaded;
    const cands: [string, number][] = [];
    if (this.canHost && loaded && this.me) cands.push([this.me, this.role === 'guest' && !this.pendingResync ? 1 : 0]);
    // a relay knows its single admin (the host seat); elsewhere every peer says in its presence whether it is one
    const seat = this.seatPeer();
    for (const p of peers) {
      if (p.sameTab) continue;
      const pr = p.presence as Record<string, unknown>;
      const f = P.readFollow(pr.f);
      const admin = seat !== null ? p.peer === seat : pr.ad === 1;
      if (admin && f && f.id === this.gameId) cands.push([p.peer, f.sy]);
    }
    cands.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (cands.length > 0 && cands[0][0] === this.me) {
      this.promote();
      return;
    }
    if (cands.length > 0 || lostFor <= P.HOST_LOST_MS * 2) return;
    // nobody can take over: join another town if one is hosted, else wait for the host (a joiner that never got
    // the town goes back to the lobby with the game it had)
    if (claims.length > 0) {
      const other = this.winningClaim(claims)!;
      this.startJoin(other.h.id, other.peer, other.h.e, false);
    } else if (!loaded) {
      this.leave();
    }
  }

  /**
   * Relay: the relay moved the host seat (admin) — gained: a town left behind by its host is taken over through the
   * usual failover in guestPump (this peer is now the admin candidate), and a town waiting in the lobby for this admin
   * is hosted by pumpRoom; lost while hosting (we came back after the relay's reconnect grace and someone else holds
   * the seat now): we can no longer emit turns, so we step down.
   */
  private onAdminChange(admin: boolean): void {
    if (this.disposed) return;
    this.adminChanges++;
    const was = this.canHost;
    this.canHost = admin;
    this.presenceUrgent = true;
    this.statusAt = -Infinity;
    this.playersAt = -Infinity;
    if (was === admin) return;
    console.info(`[net] ${admin ? 'this tab now holds' : 'this tab lost'} the host seat`);
    if (!admin && this.role === 'host') this.stepDown();
  }

  /**
   * Stop hosting without closing the town: follow it under whoever takes over (the new admin, a follower of this town,
   * after the usual host-lost delay) — we resync from their snapshot, since we are ahead of what they confirmed.
   * Commands we applied but never broadcast are lost with our copy.
   */
  private stepDown(): void {
    this.wantHost = false;
    if (!this.gameId) {
      this.role = this.transport ? 'lobby' : 'solo';
      return;
    }
    console.info('[net] stepping down: following our town under the next host');
    this.startJoin(this.gameId, '', this.epoch, true);
  }

  /** The transport stopped for good (kicked, room full): leave the shared town and keep playing our copy locally. */
  private checkClosedForGood(): void {
    if (this.disposed || !this.closeReason()) return;
    this.canHost = false;
    if (this.role === 'host' || this.role === 'guest' || this.role === 'joining') this.leave();
    this.statusAt = -Infinity;
    this.playersAt = -Infinity;
  }

  /** Take over hosting of the town we follow (the previous host left). */
  private promote(): void {
    const now = this.now();
    // catch up with everything the old host confirmed, as far as our commands allow
    const t0 = this.cpuNow();
    while (this.canStep() && this.cpuNow() - t0 < 100) this.stepOnce();
    this.buffer.clear(); // unapplied entries of the old epoch are gone with their host
    this.pendingResync = false;
    this.role = 'host';
    this.epoch += 1;
    this.since = this.lastHostClaim?.s ?? now;
    this.baseInfo = [this.tick, this.nextSeq];
    this.hostAcked.clear();
    for (const e of this.log) if (e[3] > 0) this.hostAcked.set(e[2], Math.max(this.hostAcked.get(e[2]) ?? 0, e[3]));
    this.served.clear();
    this.snaps = [];
    this.chunkQueue = [];
    this.relayedChat.clear();
    this.recentHashes = [];
    this.hostPeer = this.me;
    this.join_ = null;
    this.waiting = false;
    this.hostLostSince = -1;
    this.lastTurnAt = -Infinity;
    this.lastTurnTick = -1;
    this.lastTurnSeq = this.nextSeq - 1;
    this.hostWireAt = -Infinity;
    this.acc = 0;
    // our own commands that never reached the old host: issue them ourselves
    const mine = this.outbox;
    this.outbox = [];
    for (const o of mine) this.hostApplyNew(this.me, 0, o.cmd);
    this.game.speed = this.sharedSpeed;
    this.presenceUrgent = true;
    this.statusAt = -Infinity;
    console.info(`[net] took over hosting at tick ${this.tick} (epoch ${this.epoch})`);
    this.maybeEmitTurn(true);
  }

  private onTurn(msg: TransportMessage): void {
    if (this.disposed || msg.sameTab) return;
    if (this.role !== 'guest' && this.role !== 'joining') return;
    const d = msg.data as P.TurnMsg;
    if (!d || typeof d !== 'object' || d.v !== P.PROTOCOL_VERSION || d.g !== this.gameId || !finite(d.k) || !finite(d.e)) return;
    if (d.e < this.epoch) return;
    if (d.e > this.epoch) {
      if (!this.acceptNewEpoch(msg.peer, d)) return;
    } else if (this.hostPeer && msg.peer !== this.hostPeer) return;
    this.hostPeer = msg.peer;
    this.hostLostSince = -1;
    this.waiting = false;
    if (d.k > this.confirmed) this.confirmed = d.k;
    if (finite(d.ls) && d.ls > this.lastSeq) this.lastSeq = d.ls;
    if (finite(d.lo)) this.logLow = d.lo;
    if (SPEEDS.includes(d.s)) {
      this.sharedSpeed = d.s as GameSpeed;
      if (!this.join_ || this.join_.loaded) this.game.speed = this.sharedSpeed;
    }
    if (typeof d.t === 'string') this.townName = d.t;
    if (finite(d.y)) this.townYear = d.y;
    if (finite(d.p)) this.townPop = d.p;
    if (d.a && typeof d.a === 'object' && this.me && finite(d.a[this.me])) this.ack(d.a[this.me]);
    if (Array.isArray(d.c)) this.takeEntries(d.c, d.e);
    if (Array.isArray(d.h)) {
      for (const x of d.h) {
        if (Array.isArray(x) && finite(x[0]) && finite(x[1])) {
          this.hostHashes.set(x[0], x[1]);
          this.checkHash(x[0]);
        }
      }
      if (this.hostHashes.size > 64) {
        for (const k of this.hostHashes.keys()) {
          if (this.hostHashes.size <= 48) break;
          this.hostHashes.delete(k);
        }
      }
    }
    if (this.join_ && !this.join_.loaded) return;
    if (this.nextSeq < this.logLow && this.lastSeq >= this.nextSeq && !this.buffer.has(this.nextSeq)) {
      this.resync('the host no longer has the commands we missed');
      return;
    }
    this.applyDue();
  }

  /** A turn of a newer epoch (host failover): continue if we are not ahead of the new host's base, else resync. */
  private acceptNewEpoch(peer: string, d: P.TurnMsg): boolean {
    const b = d.b;
    if (!Array.isArray(b) || !finite(b[0]) || !finite(b[1])) return false;
    const [bt, bs] = b;
    if (this.join_ && !this.join_.loaded) {
      this.startJoin(this.gameId, peer, d.e, this.join_.resync);
      return false;
    }
    this.epoch = d.e;
    this.hostPeer = peer;
    if (this.tick > bt || this.nextSeq > bs) {
      this.resync(`the new host (tick ${bt}) is behind us (tick ${this.tick})`);
      return false;
    }
    for (const [seq, be] of this.buffer) if (seq >= bs && be.epoch < d.e) this.buffer.delete(seq);
    for (const k of [...this.hostHashes.keys()]) if (k > bt) this.hostHashes.delete(k); // the old host's future
    this.confirmed = d.k;
    this.lastSeq = Math.min(this.lastSeq, bs - 1);
    this.followAt = -Infinity;
    return true;
  }

  private onCmds(msg: TransportMessage): void {
    if (this.disposed || msg.sameTab) return;
    if (this.role !== 'guest' && this.role !== 'joining') return;
    const d = msg.data as P.CmdsMsg;
    if (!d || d.v !== P.PROTOCOL_VERSION || d.g !== this.gameId || d.e !== this.epoch || msg.peer !== this.hostPeer) return;
    if (!Array.isArray(d.c)) return;
    this.takeEntries(d.c, d.e);
    if (!this.join_ || this.join_.loaded) this.applyDue();
  }

  private takeEntries(list: unknown[], epoch: number): void {
    for (const e of list) {
      if (!P.isEntry(e)) continue;
      if (e[0] < this.nextSeq && (!this.join_ || this.join_.loaded)) continue;
      const cur = this.buffer.get(e[0]);
      if (!cur || cur.epoch < epoch) this.buffer.set(e[0], { e, epoch });
      if (e[0] > this.lastSeq) this.lastSeq = e[0];
    }
    if (this.buffer.size > P.LOG_KEEP) {
      const keys = [...this.buffer.keys()].sort((a, b) => a - b);
      for (const k of keys.slice(0, this.buffer.size - P.LOG_KEEP)) this.buffer.delete(k);
    }
  }

  /** Apply every contiguous command entry that is due at the current tick. */
  private applyDue(): void {
    if (this.role !== 'guest' && this.role !== 'joining') return;
    if (this.join_ && !this.join_.loaded) return;
    for (;;) {
      const be = this.buffer.get(this.nextSeq);
      if (!be) return;
      const t = be.e[1];
      if (t > this.tick) return;
      if (t < this.tick) {
        this.resync(`command ${this.nextSeq} was due at tick ${t} but we are at ${this.tick}`);
        return;
      }
      this.buffer.delete(this.nextSeq);
      this.nextSeq++;
      this.applyEntry(be.e);
    }
  }

  /** May we step from the current tick? (Confirmed by the host, and every command due now is known & applied.) */
  private canStep(): boolean {
    if (this.tick >= this.confirmed || this.pendingResync) return false;
    if (this.nextSeq <= this.lastSeq) {
      const be = this.buffer.get(this.nextSeq);
      if (!be || be.e[1] <= this.tick) return false;
    }
    return true;
  }

  private checkHash(tick: number): void {
    const mine = this.hashes.get(tick);
    const theirs = this.hostHashes.get(tick);
    if (mine === undefined || theirs === undefined) return;
    this.hostHashes.delete(tick);
    this.stats.hashChecks++;
    if (mine !== theirs) {
      this.stats.hashMismatches++;
      this.resync(`state hash mismatch at tick ${tick}`);
    }
  }

  private ack(lseq: number): void {
    if (this.outbox.length === 0 || this.outbox[0].lseq > lseq) return;
    this.outbox = this.outbox.filter((o) => o.lseq > lseq);
    this.presenceUrgent = true;
  }

  private enqueue(cmd: Command): void {
    this.outbox.push({ lseq: ++this.lseq, cmd, bytes: jsonBytes([this.lseq, cmd]) + 1 });
    this.presenceUrgent = true;
  }

  private guestUpdate(realDt: number): number {
    const now = this.now();
    if (this.pendingResync && now - this.lastResyncAt >= P.RESYNC_MIN_MS) this.resync('retrying');
    const j = this.join_;
    if (j && !j.loaded) {
      this.joinRetry(j, now);
      return 0;
    }
    if (this.pendingResync) return 0;
    this.applyDue();
    const behind = this.confirmed - this.tick;
    if (behind <= 0) {
      this.acc = Math.min(this.acc, 1);
      this.maybeFinishJoin();
      return 0;
    }
    const speed = this.sharedSpeed;
    const turnTicks = Math.max(1, (speed * P.TURN_INTERVAL_MS) / 1000 / NET_STEP);
    let want: number;
    let budget = this.budgetFor(realDt);
    if (j || speed === 0 || behind > turnTicks * 3 + 8) {
      // fast-forward (after a join, while paused, or when far behind)
      want = behind;
      if (j) budget = Math.max(budget, this.joinBudget);
      this.acc = 0;
    } else {
      // stay about one turn behind the host, gently speeding up / slowing down
      const rate = behind > turnTicks * 1.5 ? 1.3 : behind < turnTicks * 0.5 ? 0.8 : 1;
      this.acc += ((realDt * speed) / NET_STEP) * rate;
      want = Math.min(Math.floor(this.acc), behind);
      this.acc -= want;
      if (want === behind) this.acc = Math.min(this.acc, 1);
    }
    const t0 = this.cpuNow();
    let n = 0;
    while (n < want && this.canStep()) {
      if (n > 0 && this.cpuNow() - t0 > budget) break;
      this.stepOnce();
      n++;
      if (this.join_ !== j || this.pendingResync || this.game.state.gameOver) break;
      if (this.role !== 'guest' && this.role !== 'joining') break;
    }
    this.maybeFinishJoin();
    return n * NET_STEP;
  }

  private maybeFinishJoin(): void {
    const j = this.join_;
    if (!j || !j.loaded) return;
    const turnTicks = Math.max(1, (this.sharedSpeed * P.TURN_INTERVAL_MS) / 1000 / NET_STEP);
    if (this.confirmed - this.tick > turnTicks + 2) return;
    if (this.stats.lastJoin) this.stats.lastJoin.catchUpTicks = this.tick - j.loadTick;
    this.join_ = null;
    this.role = 'guest';
    this.followAt = -Infinity;
    this.presenceUrgent = true;
    this.statusAt = -Infinity;
  }

  private joinRetry(j: JoinState, now: number): void {
    if (j.decoding) return;
    if (j.snapId && j.n > 0) {
      if (now - j.lastProgressAt > P.CHUNK_RETRY_MS) {
        const missing: number[] = [];
        for (let i = 0; i < j.n && missing.length < 200; i++) if (!j.chunks.has(i)) missing.push(i);
        j.missing = missing;
        j.ask++;
        j.lastProgressAt = now;
        this.presenceUrgent = true;
      }
      if (now - j.startedAt > 90_000) this.startJoin(j.gameId, this.hostPeer, this.epoch, j.resync);
    } else if (now - j.lastProgressAt > 4000) {
      // no answer at all: ask again with a fresh request id
      j.reqId = randomId(8);
      j.ask = 0;
      j.missing = null;
      j.lastProgressAt = now;
      this.presenceUrgent = true;
    }
  }

  private onSnap(msg: TransportMessage): void {
    const j = this.join_;
    if (this.disposed || msg.sameTab || !j || j.loaded || j.decoding) return;
    const d = msg.data as P.SnapMsg;
    if (!d || d.v !== P.PROTOCOL_VERSION || d.g !== j.gameId || typeof d.id !== 'string' || typeof d.d !== 'string') return;
    if (!Number.isInteger(d.i) || !Number.isInteger(d.n) || d.i < 0 || d.i >= d.n || d.n > 4096) return;
    if (!j.snapId) {
      if (!Array.isArray(d.r) || !d.r.includes(j.reqId)) return;
      if (!finite(d.k) || !finite(d.ns) || !finite(d.e)) return;
      j.snapId = d.id;
      j.n = d.n;
      j.meta = { k: d.k, ns: d.ns, s: SPEEDS.includes(d.s) ? d.s : 1, z: d.z === 1 ? 1 : 0, e: d.e };
      if (d.e > this.epoch) this.epoch = d.e;
      this.hostPeer = msg.peer;
    }
    if (d.id !== j.snapId) {
      // the host answered our (same) request with a newer snapshot (the old one expired): switch to it
      if (!Array.isArray(d.r) || !d.r.includes(j.reqId) || !finite(d.k) || !finite(d.ns) || !finite(d.e)) return;
      j.snapId = d.id;
      j.n = d.n;
      j.chunks.clear();
      j.meta = { k: d.k, ns: d.ns, s: SPEEDS.includes(d.s) ? d.s : 1, z: d.z === 1 ? 1 : 0, e: d.e };
    }
    if (!j.chunks.has(d.i)) {
      j.chunks.set(d.i, d.d);
      j.lastProgressAt = this.now();
      this.statusAt = -Infinity;
    }
    if (j.chunks.size === j.n) this.finishDownload(j);
  }

  private finishDownload(j: JoinState): void {
    j.decoding = true;
    const meta = j.meta!;
    let data = '';
    for (let i = 0; i < j.n; i++) data += j.chunks.get(i) ?? '';
    const downloadMs = this.now() - j.startedAt;
    const t0 = this.cpuNow();
    unpackSnapshot(data, meta.z).then((save) => {
      if (this.disposed || this.join_ !== j) return;
      const unpackMs = this.cpuNow() - t0;
      const t1 = this.cpuNow();
      let g: Game;
      try {
        g = Game.fromSave(save);
      } catch (err) {
        console.error('[net] could not load the host snapshot', err);
        this.startJoin(j.gameId, this.hostPeer, this.epoch, j.resync);
        return;
      }
      const loadMs = this.cpuNow() - t1;
      this.game = g;
      this.sharedSpeed = (this.lastSeq > 0 || this.confirmed > 0 ? this.sharedSpeed : meta.s) as GameSpeed;
      g.speed = this.sharedSpeed;
      this.tick = meta.k;
      this.nextSeq = meta.ns;
      this.log = [];
      this.hashes.clear();
      this.acc = 0;
      for (const seq of [...this.buffer.keys()]) if (seq < meta.ns) this.buffer.delete(seq);
      if (this.confirmed < meta.k) this.confirmed = meta.k;
      j.loaded = true;
      j.decoding = false;
      j.loadTick = meta.k;
      this.stats.lastJoin = { chunks: j.n, downloadMs, unpackMs, loadMs, catchUpTicks: 0 };
      this.followAt = -Infinity;
      this.presenceUrgent = true;
      this.statusAt = -Infinity;
      this.events.emit('gameReplaced', {});
      this.applyDue();
    }, (err: unknown) => {
      console.error('[net] corrupt snapshot', err);
      if (this.join_ === j) this.startJoin(j.gameId, this.hostPeer, this.epoch, j.resync);
    });
  }

  /** First command seq we have not received yet (the host re-sends from there). */
  private firstMissing(): number {
    let s = this.nextSeq;
    while (this.buffer.has(s)) s++;
    return s;
  }

  // =============================================================================================
  // Presence
  // =============================================================================================

  private flushPresence(): void {
    const t = this.transport!;
    const now = this.now();
    if (!this.presenceUrgent && now - this.lastFlushAt < 50) return;
    // local UI state, throttled
    if (this.pendingLocal && now - this.localAt >= P.LOCAL_PRESENCE_MS) {
      this.localWire = packLocal(this.pendingLocal);
      this.pendingLocal = null;
      this.localAt = now;
    }
    const o: Record<string, unknown> = { v: P.PROTOCOL_VERSION, n: cleanText(this.myName(), 40) || this.defaultNick(), ad: this.canHost ? 1 : 0 };
    const color = this.pickColor();
    if (color) o.c = color;
    if (this.localWire) o.l = this.localWire;
    if (this.role === 'host') o.h = this.hostClaim(now);
    if (this.closed) {
      if (now < this.closed.until && this.role !== 'host') o.x = this.closed.id;
      else this.closed = null;
    }
    const j = this.join_;
    if ((this.role === 'guest' || (this.role === 'joining' && j?.loaded)) && this.gameId) {
      const a = this.firstMissing();
      const inSync = this.role === 'guest' && !this.pendingResync ? 1 : 0;
      const fw = this.followWire;
      if (!fw || now - this.followAt >= P.FOLLOW_PRESENCE_MS || fw.a !== a || fw.e !== this.epoch || fw.sy !== inSync || fw.id !== this.gameId) {
        this.followWire = { id: this.gameId, e: this.epoch, k: this.tick, a, sy: inSync };
        this.followAt = now;
      }
      o.f = this.followWire;
    }
    if (this.role === 'joining' && j && !j.loaded) {
      const jr: P.JoinRequest = { id: j.gameId, r: j.reqId, q: j.ask };
      if (j.missing && j.ask > 0) jr.m = j.missing;
      o.j = jr;
    }
    if ((this.role === 'guest' || this.role === 'joining') && this.outbox.length > 0) {
      const q: [number, Command][] = [];
      let bytes = 0;
      for (const e of this.outbox) {
        if (q.length >= P.MAX_QUEUE || bytes + e.bytes > P.QUEUE_BYTES) break;
        q.push([e.lseq, e.cmd]);
        bytes += e.bytes;
      }
      if (q.length > 0) o.q = q;
    }
    if (this.chatOut.length > 0) {
      this.chatOut = this.chatOut.filter((c) => now - c[2] < P.CHAT_OUTBOX_MS);
      if (this.chatOut.length > 0) o.ch = this.chatOut.map((c) => [c[0], c[1]]);
    }
    // keep within the payload limit: cosmetic fields first, then chat, then trim the command queue
    let size = jsonBytes(o);
    if (size > MAX_PAYLOAD_BYTES && o.l) {
      const l = { ...(o.l as P.LocalWire) };
      delete l.gh;
      o.l = l;
      size = jsonBytes(o);
    }
    if (size > MAX_PAYLOAD_BYTES) {
      delete o.l;
      size = jsonBytes(o);
    }
    if (size > MAX_PAYLOAD_BYTES) {
      delete o.ch;
      size = jsonBytes(o);
    }
    while (size > MAX_PAYLOAD_BYTES && Array.isArray(o.q) && (o.q as unknown[]).length > 0) {
      (o.q as unknown[]).pop();
      if ((o.q as unknown[]).length === 0) delete o.q;
      size = jsonBytes(o);
    }
    if (size > MAX_PAYLOAD_BYTES && o.j) {
      delete (o.j as P.JoinRequest).m;
      size = jsonBytes(o);
    }
    this.lastFlushAt = now;
    this.presenceUrgent = false;
    const json = JSON.stringify(o);
    if (json === this.lastPresenceJson) return;
    const patch: Record<string, unknown> = { ...o };
    for (const k of this.lastPresenceKeys) if (!(k in o)) patch[k] = null;
    this.lastPresenceJson = json;
    this.lastPresenceKeys = Object.keys(o);
    this.stats.maxPresenceBytes = Math.max(this.stats.maxPresenceBytes, size);
    t.setPresence(patch).catch((err: unknown) => {
      // refused (e.g. invalid_argument): drop the free-text fields that could be the cause and try again next frame
      console.warn('[net] presence update refused', err);
      this.chatOut = [];
      if (this.localWire) delete this.localWire.t;
      this.lastPresenceJson = '';
      this.presenceUrgent = true;
    });
  }

  // =============================================================================================
  // Chat, names, status
  // =============================================================================================

  private onChat(msg: TransportMessage): void {
    if (this.disposed || msg.sameTab) return;
    const d = msg.data as P.ChatMsg;
    if (!d || typeof d.t !== 'string') return;
    const text = cleanText(d.t, P.CHAT_MAX);
    if (!text) return;
    let peer = msg.peer;
    let fallback = '';
    if (typeof d.rp === 'string') {
      if (d.rp === this.me) return; // our own relayed line (shown when sent)
      peer = d.rp;
      fallback = cleanText(d.rn, 40);
    }
    if (typeof d.i === 'string' && !this.rememberChat(d.i.slice(0, 64))) return; // a resend / repeated relay
    const p = this.transport?.peers().find((x) => x.peer === peer);
    const name = p ? this.nameOf(peer, p.presence as Record<string, unknown>) : fallback || this.defaultNick(peer);
    this.pushChat(peer, name, text);
  }

  /** Emit a chat line now and once more a little later (events may be dropped; receivers dedupe by `i`). */
  private emitChat(msg: P.ChatMsg): boolean {
    if (!this.emit(P.TOPIC_CHAT, msg)) return false;
    this.stats.chatSent++;
    this.chatResend.push({ msg, at: this.now() + P.CHAT_RESEND_MS });
    return true;
  }

  private pumpChatResend(): void {
    const now = this.now();
    while (this.chatResend.length > 0 && this.chatResend[0].at <= now) {
      const r = this.chatResend[0];
      if (now - r.at > P.CHAT_RESEND_MS * 10) {
        this.chatResend.shift(); // could not be repeated for a long while: the first emit has to do
        continue;
      }
      if (this.tokens <= P.CHUNK_TOKEN_RESERVE || !this.emit(P.TOPIC_CHAT, r.msg)) break; // turns come first
      this.chatResend.shift();
    }
  }

  /** Remember a chat id; false if it was seen recently. */
  private rememberChat(id: string): boolean {
    if (this.chatSeen.has(id)) return false;
    this.chatSeen.add(id);
    if (this.chatSeen.size > 256) {
      for (const k of this.chatSeen) {
        if (this.chatSeen.size <= 192) break;
        this.chatSeen.delete(k);
      }
    }
    return true;
  }

  private pushChat(peer: string, name: string, text: string): void {
    const colors = this.transport ? this.colorMap(this.transport.peers()) : null;
    const line: ChatLine = { peer, name, color: colors?.get(peer) ?? PLAYER_COLORS[strHash(peer) % PLAYER_COLORS.length], text, at: this.now() };
    this.events.emit('chat', line);
  }

  private askName(p: TransportPeer): void {
    if (!this.transport || this.nameAsked.has(p.peer)) return;
    this.nameAsked.add(p.peer);
    this.transport.displayName(p).then((n) => {
      if (!n || this.disposed) return;
      this.names.set(p.peer, n.slice(0, 40));
      if (p.sameTab && !this.nickname) {
        this.nickname = n.slice(0, 40);
        this.presenceUrgent = true;
      }
      this.playersAt = -Infinity;
    }, () => undefined);
  }

  private defaultNick(peer = this.me): string {
    return `Settler ${(strHash(peer || 'local') % 90) + 10}`;
  }

  private myName(): string {
    if (this.transport && this.me) {
      const self = this.transport.peers().find((p) => p.sameTab);
      if (self) this.askName(self);
    }
    return this.nickname || this.names.get(this.me) || this.defaultNick();
  }

  private nameOf(peer: string, presence: Record<string, unknown>): string {
    const resolved = this.names.get(peer);
    if (resolved) return resolved;
    return cleanText(presence.n, 40) || this.defaultNick(peer);
  }

  /**
   * Player colours: every peer publishes the palette colour it picked for itself (presence `c`, kept for the session so
   * it is the same on every screen); peers that have not (yet) take their hashed palette slot or the next free one.
   */
  private colorMap(peers: readonly TransportPeer[]): Map<string, string> {
    const out = new Map<string, string>();
    const used = new Set<number>();
    for (const p of peers) {
      const c = p.sameTab ? this.myColor : (p.presence as Record<string, unknown>).c;
      const k = typeof c === 'string' ? PLAYER_COLORS.indexOf(c) : -1;
      if (k >= 0) {
        out.set(p.peer, PLAYER_COLORS[k]);
        used.add(k);
      }
    }
    for (const id of peers.map((p) => p.peer).sort()) {
      if (out.has(id)) continue;
      let k = strHash(id) % PLAYER_COLORS.length;
      for (let n = 0; n < PLAYER_COLORS.length && used.has(k); n++) k = (k + 1) % PLAYER_COLORS.length;
      used.add(k);
      out.set(id, PLAYER_COLORS[k]);
    }
    return out;
  }

  /** Pick our own colour once (the hashed slot, or the next one nobody else here uses). */
  private pickColor(): string {
    if (this.myColor) return this.myColor;
    const t = this.transport;
    if (!t || !this.me) return '';
    const taken = new Set<string>();
    for (const p of t.peers()) {
      const c = (p.presence as Record<string, unknown>).c;
      if (!p.sameTab && typeof c === 'string') taken.add(c);
    }
    let k = strHash(this.me) % PLAYER_COLORS.length;
    for (let n = 0; n < PLAYER_COLORS.length && taken.has(PLAYER_COLORS[k]); n++) k = (k + 1) % PLAYER_COLORS.length;
    this.myColor = PLAYER_COLORS[k];
    return this.myColor;
  }

  private joinProgress(): number {
    const j = this.join_;
    if (!j) return this.role === 'joining' ? 0 : 1;
    if (!j.loaded) return j.n > 0 ? 0.05 + 0.65 * (j.chunks.size / j.n) : 0.02;
    const span = Math.max(1, this.confirmed - j.loadTick);
    return Math.min(0.99, 0.7 + 0.3 * ((this.tick - j.loadTick) / span));
  }

  private label(): string {
    const t = this.transport;
    const n = t ? Math.max(1, t.peers().length) : 1;
    const players = `${n} player${n === 1 ? '' : 's'}`;
    const town = this.townName || this.game.state.settings.townName;
    switch (this.role) {
      case 'solo':
        return 'Single player';
      case 'lobby': {
        if (t && !t.connected()) {
          const why = this.closeReason();
          if (why === 'kicked') return 'Removed from the room by the host';
          if (why === 'room_full') return 'The room is full';
          if (why) return 'Could not join the room';
          return 'Offline';
        }
        const h = this.hostedTown();
        return h ? `Online · ${h.hostName} is hosting ${h.townName}` : `Online · ${players}`;
      }
      case 'host':
        return `Hosting ${town} · ${players}`;
      case 'guest': {
        if (this.waiting) return `Waiting for the host… (${town})`;
        const behind = this.confirmed - this.tick;
        return `Playing in ${town} · ${players}${behind > 40 ? ' · catching up' : ''}`;
      }
      case 'joining':
        return `${this.join_?.resync ? 'Resyncing with' : 'Joining'} ${town}… ${Math.round(this.joinProgress() * 100)}%`;
    }
  }

  private refreshStatus(): void {
    const now = this.now();
    if (now - this.statusAt < 200) return;
    this.statusAt = now;
    const st = this.status();
    const sig = JSON.stringify([st.mode, st.connected, st.canHost, Math.round(st.joinProgress * 50), Math.min(st.ticksBehind, 999) >> 3,
      st.resyncs, st.pendingCommands, st.label]);
    if (sig === this.statusSig) return;
    this.statusSig = sig;
    this.events.emit('status', st);
  }

  private refreshPlayers(): void {
    if (!this.transport) return;
    const now = this.now();
    if (now - this.playersAt < 200) return;
    this.playersAt = now;
    const list = this.players();
    const sig = JSON.stringify(list.map((p) => [p.peer, p.name, p.color, p.isHost, p.cursor, p.camera, p.ghost, p.tool, p.idleMs > 30_000]));
    if (sig === this.playersSig) return;
    this.playersSig = sig;
    this.events.emit('players', list);
  }
}

// ---- presence (de)serialisation of the local UI state -------------------------------------------

function packLocal(p: LocalPresence): P.LocalWire {
  const w: P.LocalWire = {};
  if (p.cursor && finite(p.cursor[0]) && finite(p.cursor[1])) w.cu = [round(p.cursor[0], 20), round(p.cursor[1], 20)];
  if (p.camera && finite(p.camera.x) && finite(p.camera.z)) {
    w.ca = [round(p.camera.x, 10), round(p.camera.z, 10), round(p.camera.yaw, 100), round(p.camera.dist, 10)];
  }
  if (p.ghost) {
    const g = p.ghost;
    w.gh = [g.type, g.x | 0, g.z | 0, g.rot, g.w | 0, g.h | 0, g.valid ? 1 : 0];
  }
  const tool = cleanText(p.tool, 60);
  if (tool) w.t = tool;
  return w;
}

function readCursor(v: unknown): [number, number] | null {
  return Array.isArray(v) && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : null;
}

function readCamera(v: unknown): PlayerInfo['camera'] {
  if (!Array.isArray(v) || !v.slice(0, 4).every(finite)) return null;
  return { x: v[0], z: v[1], yaw: v[2], dist: v[3] };
}

function readGhost(v: unknown): PlayerInfo['ghost'] {
  if (!Array.isArray(v) || typeof v[0] !== 'string' || !Object.prototype.hasOwnProperty.call(BUILDINGS, v[0])) return null;
  const nums = v.slice(1, 7);
  if (nums.length < 6 || !nums.every(finite)) return null;
  const rot = ((Math.round(v[3]) % 4) + 4) % 4;
  return { type: v[0] as BuildingType, x: v[1], z: v[2], rot: rot as Rotation, w: v[4], h: v[5], valid: v[6] === 1 };
}
