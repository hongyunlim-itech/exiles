/**
 * Promise-based confirmation modal. Enter confirms, Esc cancels (handled by UIManager's key capture), clicking the
 * backdrop cancels. Opening a new confirm resolves any pending one as false.
 */
import type { ConfirmOptions } from '../context';
import { h, setText } from '../dom';

export class ConfirmModal {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private msg: HTMLElement;
  private ok: HTMLButtonElement;
  private cancel: HTMLButtonElement;
  private resolve: ((v: boolean) => void) | null = null;
  private prevFocus: Element | null = null;

  constructor(private readonly onSound: (cue: 'open' | 'close' | 'click') => void) {
    this.title = h('h3', { class: 'modal-title', id: 'modal-title' });
    this.msg = h('p', { class: 'modal-msg', id: 'modal-msg' });
    this.ok = h('button', { class: 'btn primary', type: 'button', onclick: () => this.finish(true) });
    this.cancel = h('button', { class: 'btn', type: 'button', onclick: () => this.finish(false) });
    const box = h('div', { class: 'modal panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title', 'aria-describedby': 'modal-msg' },
      this.title, this.msg, h('div', { class: 'dlg-actions' }, this.cancel, this.ok));
    this.el = h('div', { class: 'modal-backdrop' }, box);
    this.el.hidden = true;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.finish(false);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // UIManager blocks default key actions while the modal is open, so activate buttons here
        e.preventDefault();
        this.finish(document.activeElement !== this.cancel);
      } else if (e.key === 'Tab') {
        // simple focus trap between the two buttons
        e.preventDefault();
        (document.activeElement === this.ok ? this.cancel : this.ok).focus();
      }
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(message: string, confirmLabel = 'OK', opts: ConfirmOptions = {}): Promise<boolean> {
    if (this.resolve) this.finish(false);
    setText(this.title, opts.title ?? 'Are you sure?');
    setText(this.msg, message);
    setText(this.ok, confirmLabel);
    setText(this.cancel, opts.cancelLabel ?? 'Cancel');
    this.ok.className = `btn ${opts.danger ? 'danger solid' : 'primary'}`;
    this.prevFocus = document.activeElement;
    this.el.hidden = false;
    this.onSound('open');
    window.setTimeout(() => this.ok.focus(), 0);
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Cancel (Esc). */
  dismiss(): void {
    this.finish(false);
  }

  private finish(v: boolean): void {
    const r = this.resolve;
    this.resolve = null;
    this.el.hidden = true;
    if (this.prevFocus instanceof HTMLElement && this.prevFocus.isConnected) this.prevFocus.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
    this.prevFocus = null;
    if (r) {
      this.onSound(v ? 'click' : 'close');
      r(v);
    }
  }
}
