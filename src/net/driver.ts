/**
 * App-side co-op driver (integration): the DOM-free half of main.ts's co-op glue, so the app and the headless
 * end-to-end test (tests/net.e2e.test.ts) run exactly the same decisions.
 *
 *  - owns the app's NetSession (solo at once; `attachTransport` lights the room up when connectTransport() resolves)
 *  - `startGame(game)` — New Game / Load / Continue: a guest leaves the shared town first; a connected admin hosts the
 *    town unless someone else already hosts one (then it stays local and the player is told)
 *  - 'gameReplaced' → `view.showGame(net.game, soft)`: the first adoption as a guest is the join (full swap, then
 *    `view.followed`); a re-created copy of the same town (resync) is a soft swap that keeps camera, tool & selection
 *  - `frame(realDt, inMenu, now)` — every animation frame: advances the session (a shared town keeps running while
 *    the menu is open; solo/lobby freeze in the menu), polls the status, announces shared-speed changes
 *  - `backgroundTick(elapsed)` — hidden tab (no rAF): keeps a shared town's clock / catch-up going
 *  - `dispatch` / `setSpeed` — THE way UI & input change the town (AppContext.dispatch / setSpeed forward here)
 *
 * Never throws out of its public methods (a broken session must not take the game down).
 */
import type { GameSpeed, MessageSeverity } from '../core/types';
import type { Game } from '../sim/game';
import { NetSession, type NetSessionOptions } from './session';
import type { Transport } from './transport';
import type { Command, CommandResult, NetMode, NetStatus, PlayerInfo } from './types';

/** How often the app re-reads the session status (ms), in addition to its 'status' events. */
export const STATUS_POLL_MS = 250;
/** Largest real-time step (s) a hidden tab's timer hands to the session. */
export const BG_MAX_DT = 1;

const SOLO_STATUS: NetStatus = {
  mode: 'solo', connected: false, canHost: false, joinProgress: 0, ticksBehind: 0, resyncs: 0, pendingCommands: 0, label: 'Single player',
};

/** Modes in which this tab takes part in a shared town (its clock must keep running: menu, idle, hidden tab). */
export function isCoopMode(mode: NetMode): boolean {
  return mode === 'host' || mode === 'guest' || mode === 'joining';
}

/** Same town, re-created (co-op resync from a fresh snapshot): the view keeps camera, selection and tool. */
export function sameWorld(a: Game, b: Game): boolean {
  const x = a.state;
  const y = b.state;
  return x.W === y.W && x.H === y.H && x.settings.seed === y.settings.seed && x.settings.townName === y.settings.townName;
}

/** What the driver needs from the app (main.ts: renderer/UI/input/audio; tests: a recording fake). */
export interface CoopView {
  /** The town on screen. */
  readonly game: Game;
  /** Put `game` on screen (renderer, UI, input, audio, game-event bindings). `soft`: same town re-created. */
  showGame(game: Game, soft: boolean): void;
  /**
   * A town from the room was put on screen with a full swap: `initialJoin` = this guest just joined (close the menu,
   * look where the host looks); otherwise the host opened another town.
   */
  followed(info: { initialJoin: boolean; townName: string }): void;
  toast(text: string, severity: MessageSeverity): void;
  /** The effective (shared) game speed changed — e.g. another player paused. */
  speedChanged(speed: GameSpeed): void;
}

export class CoopDriver {
  readonly net: NetSession;
  private readonly view: CoopView;
  private readonly offs: (() => void)[] = [];
  /** Latest session mode (from 'status' events, re-polled every STATUS_POLL_MS). */
  private mode: NetMode = 'solo';
  private lastStatusPoll = -Infinity;
  /** Effective speed last announced through `view.speedChanged`. */
  private lastSpeed: GameSpeed;
  /** Set while the driver itself installs a town into the session (hostGame): its 'gameReplaced' is handled inline. */
  private suppressAdopt = false;
  /** This tab follows a host's town (guest/joining): the first adoption is the join, later ones are resyncs. */
  private followingTown = false;
  private lastError = -Infinity;

  constructor(view: CoopView, opts: NetSessionOptions = {}) {
    this.view = view;
    this.net = new NetSession(view.game, null, opts);
    this.offs.push(
      this.net.events.on('gameReplaced', () => {
        if (!this.suppressAdopt) this.adopt();
      }),
      this.net.events.on('status', (st) => this.onStatus(st)),
    );
    this.lastSpeed = this.speed();
  }

  // ---- room ----------------------------------------------------------------------------------

  /** Light co-op up on `transport` (solo → lobby; nothing is hosted until the player starts or shares a town). */
  attachTransport(transport: Transport): boolean {
    try {
      this.net.attachTransport(transport);
    } catch (err) {
      console.error('[net] could not start the co-op session — staying single player', err);
      try {
        transport.dispose();
      } catch {
        /* ignore */
      }
      return false;
    }
    this.onStatus(this.status());
    this.syncSpeed(true);
    return true;
  }

  // ---- safe reads ----------------------------------------------------------------------------

  /** Latest known mode (events + polling). */
  get netMode(): NetMode {
    return this.mode;
  }

  /** Hosting, following or joining a shared town. */
  get coopActive(): boolean {
    return isCoopMode(this.mode);
  }

  /** Autosave only the player's own towns — a guest's copy of the host's town never overwrites their saves. */
  get mayAutosave(): boolean {
    const m = this.status().mode;
    return m !== 'guest' && m !== 'joining';
  }

  status(): NetStatus {
    try {
      return this.net.status();
    } catch {
      return SOLO_STATUS;
    }
  }

  players(): readonly PlayerInfo[] {
    try {
      return this.net.players();
    } catch {
      return [];
    }
  }

  hostedTown(): ReturnType<NetSession['hostedTown']> {
    try {
      return this.net.hostedTown();
    } catch {
      return null;
    }
  }

  /** Effective game speed (co-op: the shared speed; 0 while a guest waits for its host). */
  speed(): GameSpeed {
    try {
      return this.net.speed();
    } catch {
      return this.view.game.speed;
    }
  }

  // ---- game lifecycle ------------------------------------------------------------------------

  /**
   * Make `game` the town this tab plays (New Game / Load / Continue) and put it on screen. A guest leaves the shared
   * town first (the UI locks these actions and explains); an admin with a connected room hosts it for everyone, unless
   * someone else already hosts a town here (then it is played locally, and the player is told).
   */
  startGame(game: Game): void {
    let st = this.status();
    if (st.mode === 'guest' || st.mode === 'joining') {
      try {
        this.net.leave();
      } catch (err) {
        console.warn('[net] leave failed', err);
      }
      st = this.status();
    }
    let shown = game;
    let notice = '';
    const otherHost = st.mode !== 'host' ? this.hostedTown() : null;
    if (st.connected && st.canHost && (st.mode === 'lobby' || st.mode === 'host') && !otherHost) {
      this.suppressAdopt = true;
      try {
        this.net.hostGame(game);
        shown = this.net.game ?? game;
      } catch (err) {
        console.error('[net] hostGame failed — playing on your own', err);
        this.setLocalGame(game);
      } finally {
        this.suppressAdopt = false;
      }
    } else {
      this.setLocalGame(game);
      if (otherHost && st.connected) notice = `${otherHost.hostName} is already hosting a town here — this one is yours alone.`;
    }
    this.onStatus(this.status());
    this.view.showGame(shown, false);
    this.syncSpeed(true);
    if (notice) this.view.toast(notice, 'info'); // after the swap (a full swap clears the toasts)
  }

  /** Solo / lobby: the session simulates this game locally. */
  private setLocalGame(game: Game): void {
    try {
      this.net.setLocalGame(game);
    } catch (err) {
      console.warn('[net] could not hand the game to the session', err);
    }
  }

  /** The session replaced the shared town (join, resync, host started/loaded a town): show `net.game`. */
  private adopt(): void {
    const next = this.net.game;
    const cur = this.view.game;
    if (!next || next === cur) return;
    const st = this.status();
    const following = st.mode === 'guest' || st.mode === 'joining';
    const initialJoin = following && !this.followingTown;
    if (following) this.followingTown = true;
    const soft = sameWorld(cur, next) && !initialJoin;
    this.view.showGame(next, soft);
    this.syncSpeed(true);
    if (!soft && following) this.view.followed({ initialJoin, townName: next.state.settings.townName });
  }

  private onStatus(st: NetStatus): void {
    this.mode = st.mode;
    if (st.mode !== 'guest' && st.mode !== 'joining') this.followingTown = false;
  }

  // ---- commands ------------------------------------------------------------------------------

  /** THE way UI and input mutate the town: solo applies at once, co-op routes through the lockstep session. */
  dispatch(cmd: Command): CommandResult {
    let res: CommandResult;
    try {
      res = this.net.dispatch(cmd);
    } catch (err) {
      console.error(`[net] dispatch ${cmd?.op} failed`, err);
      return { ok: false, reason: 'That could not be done right now' };
    }
    if (cmd.op === 'speed') this.syncSpeed();
    return res;
  }

  /** Solo: applied at once. Co-op: a shared-speed command; the display follows when the host applies it. */
  setSpeed(speed: GameSpeed): void {
    try {
      this.net.setSpeed(speed);
    } catch (err) {
      console.warn('[net] setSpeed failed — applying locally', err);
      this.view.game.speed = speed;
    }
    this.syncSpeed(true);
  }

  // ---- per frame -----------------------------------------------------------------------------

  /**
   * One animation frame: advance the session (solo: the menu freezes the game; a shared town keeps running for
   * everyone, menu or not), poll the status, announce shared-speed changes. Returns the game seconds simulated.
   */
  frame(realDt: number, inMenu: boolean, nowMs: number): number {
    if (nowMs - this.lastStatusPoll > STATUS_POLL_MS) {
      this.lastStatusPoll = nowMs;
      this.onStatus(this.status());
    }
    let gameDt = 0;
    try {
      const d = this.net.update(inMenu && !this.coopActive ? 0 : realDt);
      gameDt = Number.isFinite(d) && d > 0 ? d : 0;
    } catch (err) {
      this.logError(err);
    }
    this.syncSpeed();
    return gameDt;
  }

  /**
   * Hidden tab (requestAnimationFrame suspended): keep a shared town's clock (host) and catch-up (guest) running.
   * `elapsed` = real seconds since the last frame or tick. Returns whether the session was advanced.
   */
  backgroundTick(elapsed: number): boolean {
    if (!this.coopActive) return false;
    try {
      this.net.update(Math.min(BG_MAX_DT, Math.max(0, elapsed)));
    } catch (err) {
      this.logError(err);
    }
    return true;
  }

  /** Announce the effective speed when it changed (co-op: another player may have changed it). */
  syncSpeed(force = false): void {
    const speed = this.speed();
    if (!force && speed === this.lastSpeed) return;
    this.lastSpeed = speed;
    try {
      this.view.speedChanged(speed);
    } catch (err) {
      console.warn('[net] speed listener failed', err);
    }
  }

  /** Leave the room for good (tab closing). */
  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    try {
      this.net.dispose();
    } catch {
      /* ignore */
    }
  }

  private logError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastError < 2000) return;
    this.lastError = now;
    console.error('[net] update failed', err);
  }
}
