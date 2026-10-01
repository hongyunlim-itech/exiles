/**
 * UIManager — all DOM UI (HUD, build menu, windows, panels, dialogs, main menu, tooltips, notifications).
 * OWNER: ui agent. Root element is #ui (overlay above the canvas). Must not block canvas input except over panels.
 *
 * Structure: components build their DOM once and update values in place from a ~4 Hz tick (`update`), reading
 * derived data through a per-tick DataCache. Game events (messages, game over, nomads) are rebound whenever the game
 * instance changes (`onGameChanged`).
 *
 * Co-op: every town mutation goes through `dispatch` (→ AppContext.dispatch → NetSession). The CoopController binds
 * the session's events (players, chat, rejected commands) and is rebound by `onNetChanged` when main.ts replaces the
 * session; the Players window (J) and the chat bar (Enter) live in ./coop.
 */
import './styles/base.css';
import './styles/hud.css';
import './styles/panels.css';
import './styles/windows.css';
import './styles/menu.css';
import './styles/coop.css';

import type { UiCue } from '../audio/audio';
import type { AppContext } from '../core/app';
import type { MessageSeverity } from '../core/types';
import { buildingCenter } from '../core/world';
import type { Transport } from '../net/transport';
import type { Command, CommandResult } from '../net/types';
import type { Game } from '../sim/game';
import type { ConfirmOptions, DispatchOptions, FocusTarget, ToastOptions, UIContext, WindowId } from './context';
import { CoopController } from './coop/controller';
import { PlayersWindow } from './coop/players';
import { DataCache, logThrottled } from './data';
import { h, isTypingTarget } from './dom';
import { FpsCounter } from './hud/fps';
import { Toasts } from './hud/toasts';
import { Toolbar } from './hud/toolbar';
import { TopBar } from './hud/topbar';
import { MainMenu } from './menu/mainmenu';
import { GameOverOverlay } from './overlays/gameover';
import { ConfirmModal } from './overlays/modal';
import { SelectionPanel } from './panels/selection';
import { PendingValues } from './pending';
import { uiRemPx } from './scale';
import { HoverInfo, TooltipManager } from './tooltip';
import { CitizensWindow } from './windows/citizens';
import { EventLogWindow } from './windows/eventlog';
import { HelpWindow } from './windows/help';
import { NomadsWindow } from './windows/nomads';
import { OverviewWindow } from './windows/overview';
import { ProfessionsWindow } from './windows/professions';
import { StatisticsWindow } from './windows/statistics';
import { TradeWindow } from './windows/trade';
import { WindowManager } from './windows/window';

/** UI refresh interval (seconds of real time). */
const TICK = 0.25;

const HOTKEY_WINDOWS: Record<string, WindowId> = {
  p: 'professions',
  o: 'overview',
  n: 'citizens',
  l: 'log',
  k: 'stats',
  h: 'help',
  j: 'players',
};

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Cinzel:wght@500;600;700&display=swap';

function injectFonts(): void {
  if (document.querySelector('link[data-exiles-fonts]')) return;
  try {
    const pre1 = h('link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' });
    const pre2 = h('link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' });
    const link = h('link', { rel: 'stylesheet', href: FONT_HREF, 'data-exiles-fonts': '1' });
    document.head.append(pre1, pre2, link);
  } catch {
    /* offline: serif/system fallbacks are used */
  }
}

/** Scale the rem-based UI with the viewport: 1rem = 10px at ~1280x720, up to 12px at 1440p+. */
function applyScale(): void {
  document.documentElement.style.fontSize = `${uiRemPx(window.innerWidth, window.innerHeight).toFixed(2)}px`;
}

export class UIManager implements UIContext {
  readonly app: AppContext;
  readonly root: HTMLElement;
  readonly data: DataCache;
  readonly tips: TooltipManager;
  readonly pending = new PendingValues();
  /** Co-op glue (players, chat, net banner, rejected-command toasts). */
  readonly coop: CoopController;
  private readonly hover: HoverInfo;
  private readonly topbar: TopBar;
  private readonly toolbar: Toolbar;
  private readonly selection: SelectionPanel;
  private readonly toasts: Toasts;
  private readonly modal: ConfirmModal;
  private readonly menu: MainMenu;
  private readonly gameOver: GameOverOverlay;
  private readonly fps: FpsCounter;
  private readonly windows: WindowManager;
  private readonly hudLayer: HTMLElement;
  private accum = TICK;
  private overUI = false;
  private pointerX = 0;
  private pointerY = 0;
  private toolKind = 'select';
  private nomadsSeen: unknown = null;
  private chatSeen = 0;
  private appOffs: (() => void)[] = [];
  private gameOffs: (() => void)[] = [];
  private disposed = false;

  constructor(root: HTMLElement, app: AppContext) {
    this.root = root;
    this.app = app;
    root.classList.add('exiles-ui');
    injectFonts();
    applyScale();

    this.data = new DataCache(() => this.app.game);
    this.tips = new TooltipManager(root);
    this.hover = new HoverInfo(root);
    this.fps = new FpsCounter();
    this.coop = new CoopController(this);

    this.topbar = new TopBar(this);
    this.toolbar = new Toolbar(this);
    this.selection = new SelectionPanel(this);
    this.toasts = new Toasts(this);
    this.windows = new WindowManager(root, (id, open) => this.toolbar.setWindowOpen(id, open));
    this.modal = new ConfirmModal((cue) => this.sound(cue));
    this.menu = new MainMenu(this, this.coop);
    this.gameOver = new GameOverOverlay(this, {
      newGame: () => {
        this.gameOver.hide();
        this.app.openMenu();
        this.menu.showPage('new');
      },
      load: () => {
        this.gameOver.hide();
        this.app.openMenu();
        this.menu.showPage('load');
      },
    });

    this.hudLayer = h('div', { class: 'hud' }, this.topbar.el, this.toolbar.el, this.toolbar.windowsEl, this.selection.el, this.fps.el,
      this.coop.bannerEl, this.coop.chatEl);
    root.prepend(this.hudLayer);
    this.windows.register(new ProfessionsWindow(this));
    this.windows.register(new OverviewWindow(this));
    this.windows.register(new CitizensWindow(this));
    this.windows.register(new EventLogWindow(this));
    this.windows.register(new StatisticsWindow(this));
    this.windows.register(new HelpWindow(this));
    this.windows.register(new TradeWindow(this));
    this.windows.register(new NomadsWindow(this));
    this.windows.register(new PlayersWindow(this, this.coop));
    root.append(this.gameOver.el, this.menu.el, this.toasts.el, this.modal.el);
    // tooltips & hover info stay on top of everything
    root.append(this.tips.el, this.hover.el);

    // ---- DOM listeners ----
    window.addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
    window.addEventListener('pointerdown', this.onPointer, { capture: true, passive: true });
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    // keep wheel scrolling of UI lists from zooming the camera
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    root.addEventListener('contextmenu', (e) => {
      if (!isTypingTarget(e.target)) e.preventDefault();
    });

    // ---- app events ----
    const ev = app.events;
    this.appOffs.push(
      ev.on('toolChanged', ({ tool }) => {
        this.toolKind = tool.kind;
        this.toolbar.setTool(tool);
      }),
      ev.on('selectionChanged', ({ selection }) => this.selection.setSelection(selection)),
      ev.on('settingsChanged', ({ settings }) => {
        this.fps.setEnabled(settings.showFps);
        this.menu.syncSettings(settings);
      }),
      ev.on('speedChanged', ({ speed }) => this.topbar.setSpeed(speed)),
      ev.on('hoverInfo', ({ text }) => this.hover.setText(text)),
    );

    this.fps.setEnabled(app.settings.showFps);
    this.topbar.setSpeed(this.safeSpeed());
    this.bindGame();
    this.coop.bind();
    this.syncMenuClass();
  }

  // =============================================================================================
  // Public API (fixed contract)
  // =============================================================================================

  /** Called every frame; refresh visible widgets (throttle expensive DOM work to ~4 Hz). */
  update(realDt: number): void {
    if (this.disposed) return;
    const dt = Math.max(0, Math.min(0.25, realDt || 0));
    this.fps.frame(dt);
    this.toasts.update(dt);
    if (!this.app.inMenu) this.selection.perFrame();
    this.accum += dt;
    if (this.accum < TICK) return;
    this.accum = 0;
    this.tick();
  }

  /**
   * The game instance changed (new/load): rebind event listeners, close stale panels.
   * `soft` (co-op resync: the same shared town re-created from a fresh snapshot) keeps the selection, open dialogs and
   * toasts — entity ids are stable across a snapshot.
   */
  onGameChanged(opts: { soft?: boolean } = {}): void {
    this.bindGame();
    this.data.invalidate();
    this.windows.onGameChanged();
    if (!opts.soft) {
      this.selection.setSelection(null);
      this.windows.close('trade');
      this.windows.close('nomads');
      this.toasts.clear();
      this.gameOver.reset();
      this.toolbar.closeFlyout();
      this.pending.clear();
      this.nomadsSeen = this.app.game.state.nomads;
    } else {
      this.selection.setSelection(this.app.selection);
      // a nomads group already answered in the previous instance is the same group
      if (this.nomadsSeen && this.app.game.state.nomads) this.nomadsSeen = this.app.game.state.nomads;
    }
    this.topbar.setSpeed(this.safeSpeed());
    this.accum = TICK; // refresh on the next frame
  }

  /**
   * main.ts attached the room to the co-op session (solo → lobby): rebind its events, drop stale pending values.
   * `transport` (when given) is the attached room — read by the co-op UI for its kind, close reason and host seat.
   */
  onNetChanged(transport?: Transport | null): void {
    if (transport !== undefined) this.coop.attachRoom(transport);
    this.coop.bind();
    this.pending.clear();
    this.accum = TICK;
  }

  /** connectTransport() found no room (or it could not be attached): the page plays solo. */
  onNetUnavailable(): void {
    this.coop.attachRoom(null);
    this.accum = TICK;
  }

  /** Show the title/main menu. `inGame` shows Resume/Save options. */
  showMainMenu(inGame: boolean): void {
    this.toolbar.closeFlyout();
    this.coop.closeChat();
    this.tips.hide();
    this.hover.setText(null);
    this.gameOver.hide();
    this.menu.show(inGame);
    this.syncMenuClass(true);
  }

  hideMainMenu(): void {
    this.menu.hide();
    this.syncMenuClass(false);
    this.accum = TICK;
  }

  /** True if the pointer is currently over an interactive UI element (input ignores canvas clicks then). */
  isPointerOverUI(): boolean {
    return this.overUI || this.menu.isOpen || this.modal.isOpen;
  }

  /**
   * Issue a player command through the app (solo: applied now; co-op: queued for the host). Refusals are toasted with
   * the error cue unless disabled; derived data is invalidated so panels show the effect on their next refresh.
   */
  dispatch(cmd: Command, opts: DispatchOptions = {}): CommandResult {
    let res: CommandResult;
    try {
      res = this.app.dispatch(cmd);
    } catch (err) {
      logThrottled('dispatch', err);
      res = { ok: false, reason: 'That could not be done right now.' };
    }
    if (!res || typeof res.ok !== 'boolean') res = { ok: false, reason: 'That could not be done right now.' };
    if (!res.ok) {
      if (opts.toastFailure !== false) this.toast(res.reason || 'That is not possible right now.', 'warning');
      if (opts.errorSound !== false) this.sound('error');
    }
    this.data.invalidate();
    return res;
  }

  /** Show a transient toast (e.g. "Not enough stone"). */
  toast(text: string, severity: MessageSeverity = 'info', opts?: ToastOptions): void {
    this.toasts.show(text, severity, opts);
  }

  /** Modal yes/no confirmation (e.g. demolish). Resolves true on confirm. */
  confirm(message: string, confirmLabel?: string, opts?: ConfirmOptions): Promise<boolean> {
    this.tips.hide();
    return this.modal.open(message, confirmLabel ?? 'Confirm', opts);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.appOffs) off();
    for (const off of this.gameOffs) off();
    this.coop.dispose();
    this.appOffs = [];
    this.gameOffs = [];
    window.removeEventListener('pointermove', this.onPointer, true);
    window.removeEventListener('pointerdown', this.onPointer, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    this.modal.dismiss();
    this.toolbar.dispose();
    this.tips.dispose();
    this.windows.dispose();
    this.root.replaceChildren();
    this.root.classList.remove('exiles-ui', 'ui-menu-open');
  }

  // =============================================================================================
  // UIContext services
  // =============================================================================================

  get game(): Game {
    return this.app.game;
  }

  sound(cue: UiCue): void {
    try {
      this.app.audio.playUi(cue);
    } catch {
      /* audio unavailable */
    }
  }

  goTo(target: FocusTarget, select = true): void {
    const g = this.game;
    switch (target.kind) {
      case 'building': {
        const b = g.getBuilding(target.id);
        if (!b) {
          this.toast('That building no longer exists.', 'info', { silent: true });
          return;
        }
        const [x, z] = buildingCenter(b);
        this.app.focusOn(x, z);
        if (select) this.app.select({ kind: 'building', id: b.id });
        break;
      }
      case 'citizen': {
        const c = g.getCitizen(target.id);
        if (!c) {
          this.toast('That person is no longer with us.', 'info', { silent: true });
          return;
        }
        this.app.focusOn(c.x, c.z);
        if (select) this.app.select({ kind: 'citizen', id: c.id });
        break;
      }
      case 'tile': {
        const W = g.state.W;
        this.app.focusOn((target.id % W) + 0.5, Math.floor(target.id / W) + 0.5);
        break;
      }
    }
  }

  selectBuilding(id: number, focus = false): void {
    const b = this.game.getBuilding(id);
    if (!b) return;
    if (focus) {
      const [x, z] = buildingCenter(b);
      this.app.focusOn(x, z);
    }
    this.app.select({ kind: 'building', id });
    this.sound('click');
  }

  selectCitizen(id: number, focus = false): void {
    const c = this.game.getCitizen(id);
    if (!c) return;
    if (focus) this.app.focusOn(c.x, c.z);
    this.app.select({ kind: 'citizen', id });
    this.sound('click');
  }

  openWindow(id: WindowId): void {
    this.windows.open(id);
  }

  closeWindow(id: WindowId): void {
    this.windows.close(id);
  }

  toggleWindow(id: WindowId): void {
    this.windows.toggle(id);
  }

  isWindowOpen(id: WindowId): boolean {
    return this.windows.isOpen(id);
  }

  /** Close every floating window (dev/debug helper). */
  closeAllWindows(): void {
    this.windows.closeAll();
  }

  // =============================================================================================
  // internals
  // =============================================================================================

  private tick(): void {
    this.data.invalidate();
    const dt = TICK;
    try {
      this.coop.tick(dt);
      const st = this.coop.current;
      this.toolbar.setCoopVisible(st.mode !== 'solo');
      // unread chat → dot on the Players button while its window is closed
      if (this.windows.isOpen('players')) this.chatSeen = this.coop.chatVersion;
      this.toolbar.setPlayersBadge(this.coop.chatVersion !== this.chatSeen);
      if (this.menu.isOpen) this.menu.refreshCoop();
    } catch (err) {
      logThrottled('coop', err);
    }
    if (this.app.inMenu) return;
    const run = (label: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        logThrottled(label, err);
      }
    };
    run('topbar', () => this.topbar.refresh());
    run('toolbar', () => this.toolbar.refresh());
    run('selection', () => this.selection.refresh());
    run('windows', () => this.windows.refreshOpen());
    run('tooltip', () => this.tips.refresh());
    run('events', () => this.checkGameState());
  }

  /** Detect state that may have been missed by events (e.g. after loading a save). */
  private checkGameState(): void {
    const s = this.game.state;
    if (s.gameOver) this.gameOver.maybeShow();
    if (s.nomads && s.nomads !== this.nomadsSeen) {
      this.nomadsSeen = s.nomads;
      this.windows.open('nomads');
    } else if (!s.nomads) this.nomadsSeen = null;
  }

  private bindGame(): void {
    for (const off of this.gameOffs) off();
    this.gameOffs = [];
    const game = this.app.game;
    const ev = game.events;
    this.gameOffs.push(
      ev.on('message', (m) => this.toast(m.text, m.severity, { target: m.target })),
      ev.on('gameOver', () => this.gameOver.maybeShow()),
      ev.on('nomadsArrived', () => {
        if (this.app.inMenu) return;
        this.nomadsSeen = game.state.nomads;
        this.windows.open('nomads');
      }),
      ev.on('merchantLeft', () => {
        if (this.windows.isOpen('trade')) this.windows.get('trade')?.refresh();
      }),
    );
  }

  private safeSpeed(): 0 | 1 | 2 | 5 | 10 {
    try {
      return this.app.net.speed();
    } catch {
      try {
        return this.app.game.speed;
      } catch {
        return 1;
      }
    }
  }

  private syncMenuClass(open = this.app.inMenu): void {
    this.root.classList.toggle('ui-menu-open', open);
  }

  private onResize = (): void => {
    applyScale();
    this.toolbar.closeFlyout();
  };

  private onPointer = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    const t = e.target as Node | null;
    const over = !!t && t !== this.root && t instanceof Node && this.root.contains(t);
    this.overUI = over;
    this.hover.setSuppressed(over || this.app.inMenu);
    this.hover.move(this.pointerX, this.pointerY);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    if (e.key === 'Escape') {
      if (this.handleEscape()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (this.modal.isOpen) {
      // swallow game hotkeys (Space, Delete, digits…) while a confirmation is pending
      if (e.key !== 'Tab') e.preventDefault();
      return;
    }
    if (this.menu.isOpen) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Enter' && !e.shiftKey && this.coop.chatAvailable && !this.app.inMenu) {
      // co-op chat (Enter is not bound to anything else; a focused button would otherwise re-click)
      e.preventDefault();
      this.coop.openChat();
      return;
    }
    const id = HOTKEY_WINDOWS[e.key.toLowerCase()];
    if (id && !e.shiftKey) {
      e.preventDefault();
      this.windows.toggle(id);
    }
  };

  /** Esc priority: modal → menu → flyout → dialogs → (tool/selection: leave to input) → windows → (input: menu). */
  private handleEscape(): boolean {
    if (this.modal.isOpen) {
      this.modal.dismiss();
      return true;
    }
    if (this.coop.chatOpen && !this.menu.isOpen) {
      this.coop.closeChat();
      return true;
    }
    if (this.menu.isOpen) {
      this.menu.handleEscape();
      return true;
    }
    if (this.gameOver.isOpen) {
      this.gameOver.hide();
      return true;
    }
    if (this.toolbar.closeFlyout()) return true;
    if (this.windows.closeTop(true)) return true;
    if (this.toolKind !== 'select') return false;
    if (this.app.selection) return false;
    if (this.windows.closeTop(false)) return true;
    return false;
  }
}
