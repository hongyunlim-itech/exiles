/**
 * Application bootstrap: wires Game (sim), GameRenderer, InputManager, UIManager and AudioManager together and runs
 * the main loop. Implements AppContext. Architect/integration-owned.
 *
 * Co-op: the simulation is driven through a NetSession owned by a CoopDriver (src/net/driver.ts — the DOM-free half
 * of this glue, shared with the headless end-to-end test). At boot the session is solo (no transport) so the game works
 * at once; `connectTransport()` runs in the background and, when a room is available, it is attached to the same
 * session (solo → lobby). Every town mutation goes through `dispatch` → NetSession. When the session replaces the
 * shared town (host started/loaded a town, this guest joined or resynced) the driver shows `net.game` via swapGame.
 * While a shared town runs, the clock never stops for this tab: not in the menu, not while the frame pacer idles, and
 * not while the tab is hidden (a worker timer keeps `net.update` going when requestAnimationFrame is suspended).
 */
import { AudioManager } from './audio/audio';
import { DEFAULT_SETTINGS, migrateSettings, type AppContext, type AppEvents, type AppSettings, type SaveSlotInfo, type Selection, type Tool } from './core/app';
import { EventBus } from './core/events';
import type { GameSpeed, MerchantKind, NewGameSettings } from './core/types';
import { InputManager } from './input/input';
import { CoopDriver } from './net/driver';
import type { NetSession } from './net/session';
import { connectTransport, type Transport } from './net/transport';
import type { Command, CommandResult, PlayerInfo } from './net/types';
import { GameRenderer } from './render/renderer';
import { classifyGpu, effectiveFpsCap, FramePacer, resolveQuality } from './render/scene/perf';
import { detectGpuRenderer } from './render/scene/rendererSetup';
import { igniteBuilding, makeSick, spawnTornado, startOutbreak } from './sim/disasters';
import { Game } from './sim/game';
import { summonNomads } from './sim/nomads';
import { summonMerchant } from './sim/trade';
import { setFpsPerfSource } from './ui/hud/fps';
import { UIManager } from './ui/ui';

const SAVE_PREFIX = 'exiles.save.';
const SAVE_INDEX = 'exiles.saves';
const SETTINGS_KEY = 'exiles.settings';
/** Seconds without input (while paused, camera still) before the loop drops to the idle frame rate. */
const IDLE_AFTER_MS = 1000;
/** Background (hidden tab) co-op ticks: interval (ms). The driver caps each step at BG_MAX_DT. */
const BG_TICK_MS = 250;

const NO_PLAYERS: readonly PlayerInfo[] = Object.freeze([]);

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  localStorage.setItem(key, value); // may throw (quota) — callers handle
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function defaultNewGameSettings(seed = Math.floor(Math.random() * 1e9)): NewGameSettings {
  return {
    seed,
    townName: 'Hollowmere',
    mapSize: 'medium',
    terrain: 'valleys',
    climate: 'fair',
    difficulty: 'medium',
    disasters: true,
  };
}

class App implements AppContext {
  game: Game;
  /** Co-op glue: owns the NetSession (solo until a room transport connects; then the room is attached to it). */
  readonly coop: CoopDriver;
  readonly renderer: GameRenderer;
  readonly input: InputManager;
  readonly ui: UIManager;
  readonly audio: AudioManager;
  readonly events = new EventBus<AppEvents>();
  settings: AppSettings;
  selection: Selection = null;
  inMenu = true;

  /**
   * Debug helpers for manual testing from the browser console (`__app.debug.fire()` etc.). Not used by gameplay.
   * Each acts on the current game and returns something printable.
   */
  readonly debug = {
    /** Set a building on fire (default: a random non-zone building). */
    fire: (buildingId?: number): number | null => {
      const g = this.game;
      const b = buildingId !== undefined ? g.getBuilding(buildingId)
        : g.state.buildings.find((x) => x.state === 'active' && x.type !== 'stockpile' && x.type !== 'cropField');
      if (!b) return null;
      igniteBuilding(g, b.id);
      return b.id;
    },
    tornado: (): boolean => {
      spawnTornado(this.game);
      return !!this.game.state.tornado;
    },
    sick: (citizenId?: number, severity = 0.5): number | null => {
      const g = this.game;
      const c = citizenId !== undefined ? g.getCitizen(citizenId) : g.state.citizens[0];
      if (!c) return null;
      makeSick(g, c, severity);
      return c.id;
    },
    outbreak: (): number | null => startOutbreak(this.game)?.id ?? null,
    merchant: (kind?: MerchantKind): boolean => summonMerchant(this.game, kind),
    nomads: (count?: number): boolean => summonNomads(this.game, count),
    /** Invariant problems + errors caught from modules. */
    health: (): { invariants: string[]; moduleErrors: Record<string, number> } => ({
      invariants: this.game.validate(),
      moduleErrors: this.game.moduleErrors(),
    }),
    /** Toggle per-phase sim timing (read back with `__app.game.profile`). */
    profile: (on = true): void => {
      this.game.profile = on ? {} : null;
    },
  };

  private last = performance.now();
  private lastErrorLog = 0;
  private readonly pacer = new FramePacer();
  /** performance.now() of the last user input (pointer, keys, wheel) or UI-driven change. */
  private lastActivity = performance.now();
  private wasIdle = false;
  private unbindGame: (() => void) | null = null;

  // ---- co-op: hidden-tab ticker ----
  private bgTimer: number | null = null;
  private bgWorker: Worker | null = null;

  constructor() {
    let saved: Partial<AppSettings> = {};
    try {
      saved = JSON.parse(safeGet(SETTINGS_KEY) ?? '{}') as Partial<AppSettings>;
    } catch {
      saved = {};
    }
    this.settings = { ...DEFAULT_SETTINGS, ...migrateSettings(saved) };
    this.game = Game.create(defaultNewGameSettings());
    // solo right away; the room is attached when connectTransport() resolves (see connectCoop)
    const app = this;
    this.coop = new CoopDriver({
      get game() {
        return app.game;
      },
      showGame: (game, soft) => this.swapGame(game, { soft }),
      followed: ({ initialJoin }) => this.onFollowedTown(initialJoin),
      toast: (text, severity) => this.ui.toast(text, severity),
      speedChanged: (speed) => this.events.emit('speedChanged', { speed }),
    });
    const container = document.getElementById('app')!;
    // MSAA is fixed at context creation: off only for the 'low' tier (software renderers under 'auto')
    const gpuName = this.settings.quality === 'auto' ? detectGpuRenderer() : '';
    const tier = resolveQuality(this.settings.quality, classifyGpu(gpuName));
    this.renderer = new GameRenderer(container, this.game, { antialias: tier !== 'low', gpuName });
    setFpsPerfSource(() => this.renderer.perf());
    this.audio = new AudioManager();
    this.input = new InputManager(this, this.renderer.canvas);
    this.ui = new UIManager(document.getElementById('ui')!, this);
    // other players' cursors / ghosts only make sense while this tab shows the shared town (host or following guest)
    this.renderer.remotePlayers.setSource(() => {
      const mode = this.coop.netMode;
      return mode === 'host' || mode === 'guest' ? this.coop.players() : NO_PLAYERS;
    });
    this.applySettings();
    this.bindGame();
    this.audio.attach(this.game);

    window.addEventListener('resize', () => this.renderer.resize());
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // any input wakes the loop from the idle frame rate immediately
    const wake = () => this.markActivity();
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup'] as const) {
      window.addEventListener(type, wake, { capture: true, passive: true });
    }
    this.events.on('selectionChanged', wake);
    this.events.on('toolChanged', wake);
    this.events.on('settingsChanged', wake);
    this.events.on('speedChanged', wake);
    // leave the room promptly (other tabs drop our cursor at once) — unless the page may come back from bfcache
    window.addEventListener('pagehide', (e) => {
      if (e.persisted) return;
      this.coop.dispose();
    });

    document.getElementById('boot')?.remove();
    this.ui.showMainMenu(false);
    requestAnimationFrame(this.frame);
    void this.connectCoop();
  }

  // ---- game lifecycle ------------------------------------------------------------------------

  /** The co-op session (`__app.net`: status(), players(), stats …). */
  get net(): NetSession {
    return this.coop.net;
  }

  newGame(settings: NewGameSettings): void {
    this.startGame(Game.create(settings));
  }

  /**
   * Make `game` the town this tab plays (new game / load): the driver decides between hosting it for the room and
   * local play (a guest leaves the shared town first) and shows it via swapGame.
   */
  private startGame(game: Game): void {
    this.coop.startGame(game);
    this.closeMenu();
  }

  /**
   * Swap the displayed game (called by the driver). `soft` = the same town re-created (co-op resync): the camera,
   * tool, selection, open dialogs and toasts are kept.
   */
  private swapGame(game: Game, opts: { soft?: boolean } = {}): void {
    const soft = !!opts.soft;
    this.unbindGame?.();
    if (this.game !== game) this.game.events.clear();
    const cc = this.renderer.cameraController;
    const view = soft ? { x: cc.target.x, z: cc.target.z, distance: cc.distance, yaw: cc.yaw, pitch: cc.pitch } : null;
    const keep = soft ? this.selection : null;
    this.game = game;
    this.selection = keep && this.selectionExists(game, keep) ? keep : null;
    this.renderer.setGame(game);
    if (view) cc.jumpToView(view.x, view.z, view);
    this.audio.attach(game);
    this.input.onGameChanged();
    if (!soft) this.setTool({ kind: 'select' });
    this.ui.onGameChanged({ soft });
    this.bindGame();
    this.events.emit('gameChanged', { game });
    this.select(this.selection);
  }

  /** A town from the room is on screen after a full swap: the join (close the menu) or the host's new town. */
  private onFollowedTown(initialJoin: boolean): void {
    this.focusOnHost();
    if (!initialJoin) this.ui.toast(`The host opened another town: ${this.game.state.settings.townName}.`, 'info');
    if (initialJoin && this.inMenu) this.closeMenu();
  }

  private selectionExists(game: Game, sel: NonNullable<Selection>): boolean {
    return sel.kind === 'building' ? !!game.getBuilding(sel.id) : !!game.getCitizen(sel.id);
  }

  private bindGame(): void {
    const off = this.game.events.on('yearChanged', () => {
      // guests follow the host's town: only the host (and solo players) autosave it
      if (this.settings.autosave && this.coop.mayAutosave) this.saveGame('autosave');
    });
    this.unbindGame = off;
  }

  // ---- co-op session -------------------------------------------------------------------------

  /** Resolve the room transport in the background; on success attach it to the running (solo) session. */
  private async connectCoop(): Promise<void> {
    let transport: Transport | null = null;
    try {
      transport = await connectTransport();
    } catch (err) {
      console.warn('[net] no co-op transport — single player', err);
      transport = null;
    }
    if (!transport || !this.coop.attachTransport(transport)) {
      this.ui.onNetUnavailable();
      return;
    }
    this.ui.onNetChanged(transport);
    this.startBackgroundTicker();
  }

  private focusOnHost(): void {
    const host = this.coop.players().find((p) => p.isHost && !p.isMe);
    const cam = host?.camera;
    if (!cam) return;
    try {
      this.renderer.cameraController.jumpToView(cam.x, cam.z, { distance: cam.dist, yaw: cam.yaw });
    } catch {
      /* keep the default town view */
    }
  }

  /**
   * Hidden tabs get no requestAnimationFrame: keep a shared town's clock (host) and catch-up (guest) running from a
   * timer. A dedicated worker's timer is not throttled like the page's own timers; fall back to setInterval.
   */
  private startBackgroundTicker(): void {
    if (this.bgWorker || this.bgTimer !== null) return;
    const fallback = () => {
      if (this.bgTimer === null) this.bgTimer = window.setInterval(this.backgroundTick, BG_TICK_MS);
    };
    try {
      const src = `setInterval(function () { postMessage(0); }, ${BG_TICK_MS});`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
      let revoked = false;
      worker.onmessage = () => {
        if (!revoked) {
          revoked = true;
          URL.revokeObjectURL(url);
        }
        this.backgroundTick();
      };
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        if (!revoked) URL.revokeObjectURL(url);
        revoked = true;
        if (this.bgWorker === worker) this.bgWorker = null;
        fallback();
      };
      this.bgWorker = worker;
    } catch {
      fallback();
    }
  }

  private backgroundTick = (): void => {
    // Keyed on "no frame drawn lately", not document.hidden: occluded/minimised windows and embedded panes can suspend
    // requestAnimationFrame while still reporting visible, and a stalled host freezes the town for every player.
    if (!this.coop.coopActive) return;
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    if (elapsed < BG_TICK_MS / 2000) return; // frames are still being drawn
    this.last = now;
    this.coop.backgroundTick(elapsed);
  };

  saveGame(slot: string): boolean {
    try {
      const data = this.game.save();
      safeSet(SAVE_PREFIX + slot, data);
      const s = this.game.state;
      const info: SaveSlotInfo = {
        slot,
        townName: s.settings.townName,
        year: s.time.year,
        month: s.time.month,
        population: s.citizens.length,
        savedAt: Date.now(),
      };
      const list = this.listSaves().filter((x) => x.slot !== slot);
      list.push(info);
      safeSet(SAVE_INDEX, JSON.stringify(list));
      return true;
    } catch (err) {
      console.error('[save] failed', err);
      this.ui.toast(`Save failed: ${(err as Error).message}`, 'danger');
      return false;
    }
  }

  loadGame(slot: string): boolean {
    const data = safeGet(SAVE_PREFIX + slot);
    if (!data) {
      this.ui.toast('Save not found', 'danger');
      return false;
    }
    try {
      const game = Game.fromSave(data);
      game.speed = 1;
      this.startGame(game);
      return true;
    } catch (err) {
      console.error('[load] failed', err);
      this.ui.toast(`Load failed: ${(err as Error).message}`, 'danger');
      return false;
    }
  }

  listSaves(): SaveSlotInfo[] {
    try {
      const list = JSON.parse(safeGet(SAVE_INDEX) ?? '[]') as SaveSlotInfo[];
      return list.filter((x) => safeGet(SAVE_PREFIX + x.slot) !== null).sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  deleteSave(slot: string): void {
    safeRemove(SAVE_PREFIX + slot);
    const list = this.listSaves().filter((x) => x.slot !== slot);
    try {
      safeSet(SAVE_INDEX, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  // ---- interaction ---------------------------------------------------------------------------

  setTool(tool: Tool): void {
    this.input.setTool(tool);
    this.events.emit('toolChanged', { tool });
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.renderer.buildings.setHighlight(sel?.kind === 'building' ? sel.id : null);
    this.renderer.citizens.setHighlight(sel?.kind === 'citizen' ? sel.id : null);
    this.events.emit('selectionChanged', { selection: sel });
  }

  setSpeed(speed: GameSpeed): void {
    // solo: applied at once; co-op: the display follows when the host applies it (the driver announces changes)
    this.coop.setSpeed(speed);
  }

  /** THE way UI and input mutate the town: solo applies at once, co-op routes through the lockstep session. */
  dispatch(cmd: Command): CommandResult {
    this.markActivity();
    return this.coop.dispatch(cmd);
  }

  focusOn(wx: number, wz: number): void {
    this.renderer.focusOn(wx, wz);
  }

  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      safeSet(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applySettings();
    this.events.emit('settingsChanged', { settings: this.settings });
  }

  private applySettings(): void {
    const s = this.settings;
    this.renderer.applySettings({ shadows: s.shadows, quality: s.quality });
    this.renderer.cameraController.edgeScroll = s.edgeScroll;
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.ambientVolume);
  }

  /** Note user activity: leave the idle frame rate and render on the next animation frame. */
  private markActivity(): void {
    this.lastActivity = performance.now();
    if (this.wasIdle) this.pacer.wake();
  }

  /**
   * Idle = nothing on screen needs smooth animation: the main menu is open, or the game is paused / over with a
   * still camera and no input for IDLE_AFTER_MS. The loop then renders at ≤ 30 fps.
   */
  private isIdle(now: number): boolean {
    // joining: catch-up runs per frame — never throttle it (a shared town otherwise keeps running at the idle rate)
    if (this.coop.netMode === 'joining') return false;
    if (this.inMenu) return true;
    const g = this.game;
    if (this.coop.speed() !== 0 && !g.state.gameOver) return false;
    if (now - this.lastActivity < IDLE_AFTER_MS) return false;
    const cc = this.renderer.cameraController;
    return !cc.isMoving && cc.viewSpeed < 0.002;
  }

  openMenu(): void {
    this.inMenu = true;
    this.ui.showMainMenu(true);
  }

  closeMenu(): void {
    this.inMenu = false;
    this.ui.hideMainMenu();
  }

  // ---- main loop -----------------------------------------------------------------------------

  private frame = (now: number): void => {
    // ---- frame pacing: FPS cap (skips refreshes on high-refresh displays) and idle throttling ----
    const idle = this.isIdle(now);
    this.wasIdle = idle;
    const cap = effectiveFpsCap(this.settings.fpsCap ?? 60, idle);
    if (!this.pacer.shouldRender(now, cap)) {
      requestAnimationFrame(this.frame);
      return;
    }
    const frameMs = now - this.last;
    // the sim advances by real elapsed time, so skipped refreshes never change the game speed
    const realDt = Math.min(0.1, Math.max(0, frameMs / 1000));
    this.last = now;
    const workStart = performance.now();
    try {
      // solo: the menu freezes the game; a shared town keeps running for everyone (menu or not)
      const gameDt = this.coop.frame(realDt, this.inMenu, now);
      this.input.update(realDt);
      this.renderer.render(realDt, gameDt);
      this.ui.update(realDt);
      const cc = this.renderer.cameraController;
      this.audio.update(realDt, cc.target.x, cc.target.z, cc.distance);
      if (cc.lastInputAt > this.lastActivity) this.lastActivity = cc.lastInputAt;
      // dynamic resolution feedback (not while idle: those frames are deliberately slow)
      if (!idle) this.renderer.reportFrame(frameMs, performance.now() - workStart, cap > 0 ? 1000 / cap : 1000 / 60);
    } catch (err) {
      if (now - this.lastErrorLog > 2000) {
        this.lastErrorLog = now;
        console.error('[frame] error', err);
      }
    }
    requestAnimationFrame(this.frame);
  };
}

function boot(): void {
  try {
    const app = new App();
    // debug handle: __app.game, __app.net (co-op session: status(), players()), __app.setSpeed(10) …
    (window as unknown as { __app: AppContext }).__app = app;
  } catch (err) {
    console.error('[boot] failed', err);
    const el = document.getElementById('boot');
    if (el) el.textContent = `Failed to start: ${(err as Error).message}`;
  }
}

boot();
