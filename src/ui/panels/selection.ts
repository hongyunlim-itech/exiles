/**
 * Right-hand selection panel: hosts a BuildingView or CitizenView for the current selection, refreshes it at the UI
 * tick rate, rebuilds it on state changes, closes it when the entity disappears and drives citizen follow-cam.
 */
import type { Selection } from '../../core/app';
import type { UIContext } from '../context';
import { h, setClass } from '../dom';
import { BuildingView } from './building-view';
import { CitizenView } from './citizen-view';

export class SelectionPanel {
  readonly el: HTMLElement;
  private view: BuildingView | CitizenView | null = null;
  private selection: Selection = null;

  constructor(private readonly ui: UIContext) {
    this.el = h('aside', { class: 'sel-panel panel', 'aria-label': 'Selection details', 'aria-live': 'off' });
    this.el.hidden = true;
  }

  get current(): Selection {
    return this.selection;
  }

  setSelection(sel: Selection): void {
    const same = sel && this.selection && sel.kind === this.selection.kind && sel.id === this.selection.id && this.view;
    this.selection = sel;
    if (same) return;
    this.view?.el.remove();
    this.view = null;
    if (!sel) {
      this.el.hidden = true;
      return;
    }
    try {
      if (sel.kind === 'building') {
        const b = this.ui.game.getBuilding(sel.id);
        if (b) this.view = new BuildingView(this.ui, b);
      } else {
        const c = this.ui.game.getCitizen(sel.id);
        if (c) this.view = new CitizenView(this.ui, c);
      }
    } catch (err) {
      console.error('[ui] failed to build selection view', err);
      this.view = null;
    }
    if (!this.view) {
      this.el.hidden = true;
      return;
    }
    setClass(this.el, 'is-citizen', sel.kind === 'citizen');
    this.el.appendChild(this.view.el);
    this.el.hidden = false;
    this.el.scrollTop = 0;
    this.el.classList.remove('pop');
    void this.el.offsetWidth;
    this.el.classList.add('pop');
  }

  refresh(): void {
    const v = this.view;
    if (!v || !this.selection) return;
    if (v instanceof BuildingView) {
      const r = v.update();
      if (r === 'gone') this.ui.app.select(null);
      else if (r === 'rebuild') {
        const scroll = this.el.scrollTop;
        const sel = this.selection;
        v.el.remove();
        this.view = null;
        this.setSelection(sel);
        this.el.scrollTop = scroll;
      }
    } else if (!v.update()) this.ui.app.select(null);
  }

  /** Per-frame: keep the camera on a followed citizen. */
  perFrame(): void {
    const v = this.view;
    if (!(v instanceof CitizenView) || !v.isFollowing) return;
    const c = this.ui.game.getCitizen(v.id);
    if (c) this.ui.app.focusOn(c.x, c.z);
    else v.setFollowing(false);
  }
}
