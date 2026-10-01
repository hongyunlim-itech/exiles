/**
 * Main menu / title screen: "EXILES" title, navigation (Resume/Save when in game, Continue from the latest save,
 * New Game, Load, Settings, Controls) and a content page area. Also shows the loading veil while a world generates.
 */
import type { AppSettings } from '../../core/app';
import type { NewGameSettings } from '../../core/types';
import type { UIContext } from '../context';
import type { CoopController } from '../coop/controller';
import { MenuCoop } from '../coop/menu-coop';
import { h, setClass, setText, show } from '../dom';
import { fmtRelTime, monthName } from '../format';
import { controlsReference } from '../windows/help';
import { NewGameForm } from './newgame';
import { LoadPage, SavePage } from './saves';
import { SettingsPage } from './settings';

type Page = 'new' | 'load' | 'save' | 'settings' | 'controls';

/** Nav entries that start another town (locked while following a host's town in co-op). */
const LOCKED_IN_GUEST = ['new', 'load', 'continue'];
const GUEST_LOCK_TIP = 'Leave the shared town first';

export class MainMenu {
  readonly el: HTMLElement;
  private inGame = false;
  private page: Page | null = null;
  private pages: Record<Page, HTMLElement>;
  private content: HTMLElement;
  private navBtns = new Map<string, HTMLButtonElement>();
  private resumeBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private continueBtn: HTMLButtonElement;
  private continueSub: HTMLElement;
  private newForm: NewGameForm;
  private loadPage: LoadPage;
  private savePage: SavePage;
  private settingsPage: SettingsPage;
  private loading: HTMLElement;
  private loadingText: HTMLElement;
  private footer: HTMLElement;
  private coopBlock: MenuCoop | null = null;
  private locked = false;

  constructor(private readonly ui: UIContext, coop?: CoopController) {
    this.newForm = new NewGameForm((s) => this.startNewGame(s));
    this.loadPage = new LoadPage(ui, (slot) => this.load(slot));
    this.savePage = new SavePage(ui);
    this.settingsPage = new SettingsPage(ui);
    const controls = h('div', { class: 'menu-page' }, h('h2', { class: 'menu-h' }, 'Controls'), controlsReference());
    this.pages = { new: this.newForm.el, load: this.loadPage.el, save: this.savePage.el, settings: this.settingsPage.el, controls };

    const navBtn = (id: string, label: string, onClick: () => void, sub?: HTMLElement) => {
      const b = h('button', { class: 'menu-btn', type: 'button', onclick: () => {
        if (this.locked && LOCKED_IN_GUEST.includes(id)) {
          this.ui.sound('error');
          this.ui.toast(`${GUEST_LOCK_TIP} — you are playing in someone else's town.`, 'info', { silent: true });
          return;
        }
        this.ui.sound('click');
        onClick();
      } }, h('span', { class: 'menu-btn-l' }, label), sub ?? null);
      this.navBtns.set(id, b);
      return b;
    };
    this.resumeBtn = navBtn('resume', 'Resume', () => this.ui.app.closeMenu());
    this.continueSub = h('span', { class: 'menu-btn-sub' });
    this.continueBtn = navBtn('continue', 'Continue', () => this.continueLatest(), this.continueSub);
    this.saveBtn = navBtn('save', 'Save Game', () => this.showPage('save'));
    const nav = h('nav', { class: 'menu-nav', 'aria-label': 'Main menu' },
      this.resumeBtn,
      this.continueBtn,
      this.saveBtn,
      navBtn('new', 'New Game', () => this.showPage('new')),
      navBtn('load', 'Load Game', () => this.showPage('load')),
      navBtn('settings', 'Settings', () => this.showPage('settings')),
      navBtn('controls', 'Controls', () => this.showPage('controls')));

    const title = h('div', { class: 'menu-title' },
      h('h1', { class: 'menu-logo' }, 'EXILES'),
      h('div', { class: 'menu-tag' }, 'A frontier survival town builder'));
    this.content = h('div', { class: 'menu-content panel' });
    this.content.hidden = true;
    const back = h('button', { class: 'menu-back', type: 'button', 'aria-label': 'Back', onclick: () => this.showPage(null) }, '‹ Back');
    this.content.appendChild(back);
    for (const p of Object.values(this.pages)) {
      p.hidden = true;
      this.content.appendChild(p);
    }
    this.footer = h('div', { class: 'menu-foot' }, 'Inspired by Banished · Made with three.js');

    this.loadingText = h('div', { class: 'loading-t' }, 'Preparing the land…');
    this.loading = h('div', { class: 'loading-veil', role: 'status', 'aria-live': 'assertive' },
      h('div', { class: 'loading-logo' }, 'EXILES'), h('div', { class: 'loading-spin', 'aria-hidden': 'true' }), this.loadingText);
    this.loading.hidden = true;

    if (coop) this.coopBlock = new MenuCoop(ui, coop, () => this.inGame);
    this.el = h('div', { class: 'menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Main menu' },
      h('div', { class: 'menu-left' }, title, nav, this.coopBlock?.el ?? null), this.content, this.footer, this.loading);
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  show(inGame: boolean): void {
    this.inGame = inGame && !this.ui.game.state.gameOver;
    show(this.resumeBtn, this.inGame);
    show(this.saveBtn, this.inGame);
    const latest = this.ui.app.listSaves()[0];
    show(this.continueBtn, !this.inGame && !!latest);
    if (latest) setText(this.continueSub, `${latest.townName} · Year ${latest.year}, ${monthName(latest.month)} · ${fmtRelTime(latest.savedAt)}`);
    this.el.classList.toggle('in-game', this.inGame);
    this.el.hidden = false;
    this.hideLoading();
    this.showPage(null);
    this.refreshCoop();
    window.setTimeout(() => (this.inGame ? this.resumeBtn : this.navBtns.get(latest ? 'continue' : 'new'))?.focus(), 30);
  }

  hide(): void {
    this.el.hidden = true;
    this.hideLoading();
  }

  /** Esc: go back from a page; in game, resume. Always consumes the key while the menu is open. */
  handleEscape(): void {
    if (!this.loading.hidden) return;
    if (this.page) this.showPage(null);
    else if (this.inGame) this.ui.app.closeMenu();
  }

  showPage(page: Page | null): void {
    if (this.locked && (page === 'new' || page === 'load')) page = null;
    this.page = page;
    for (const [id, el] of Object.entries(this.pages)) el.hidden = id !== page;
    this.content.hidden = page === null;
    for (const [id, b] of this.navBtns) b.classList.toggle('on', id === page);
    if (page === 'load') this.loadPage.render();
    if (page === 'save') {
      this.savePage.render();
      window.setTimeout(() => this.savePage.focus(), 30);
    }
    if (page === 'new') this.newForm.reset();
    if (page === 'settings') this.settingsPage.sync(this.ui.app.settings);
  }

  /** Co-op block + guest lock of New Game / Load / Continue (called at the UI tick while the menu is open). */
  refreshCoop(): void {
    if (!this.coopBlock) return;
    try {
      this.coopBlock.refresh();
    } catch (err) {
      console.warn('[ui] menu co-op refresh failed', err);
    }
    const locked = this.coopBlock.guestLocked;
    if (locked === this.locked) return;
    this.locked = locked;
    for (const id of LOCKED_IN_GUEST) {
      const b = this.navBtns.get(id);
      if (!b) continue;
      setClass(b, 'locked', locked);
      b.setAttribute('aria-disabled', locked ? 'true' : 'false');
      if (locked) this.ui.tips.set(b, GUEST_LOCK_TIP);
      else this.ui.tips.set(b, null);
    }
    if (locked && (this.page === 'new' || this.page === 'load')) this.showPage(null);
  }

  syncSettings(s: AppSettings): void {
    this.settingsPage.sync(s);
  }

  private continueLatest(): void {
    const latest = this.ui.app.listSaves()[0];
    if (latest) this.load(latest.slot);
  }

  private load(slot: string): void {
    this.showLoading('Unpacking your settlement…');
    this.defer(() => {
      const ok = this.ui.app.loadGame(slot);
      if (!ok) this.hideLoading();
    });
  }

  private startNewGame(s: NewGameSettings): void {
    this.showLoading(`Leading the exiles to ${s.townName}…`);
    this.defer(() => {
      try {
        this.ui.app.newGame(s);
      } catch (err) {
        console.error('[ui] new game failed', err);
        this.ui.toast(`Could not create the world: ${(err as Error).message}`, 'danger');
        this.hideLoading();
      }
    });
  }

  /** Run after the loading veil has painted. */
  private defer(fn: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(fn, 0)));
  }

  private showLoading(text: string): void {
    setText(this.loadingText, text);
    this.loading.hidden = false;
  }

  private hideLoading(): void {
    this.loading.hidden = true;
  }
}
