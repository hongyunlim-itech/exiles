/**
 * Event Log window (L): all game messages, newest first, with severity colours, filters and "go to" buttons.
 * Rows are keyed by message id and reconciled incrementally.
 */
import type { GameMessage, MessageSeverity } from '../../core/types';
import type { UIContext } from '../context';
import { h, setClass, show } from '../dom';
import { fmtInt, shortDate } from '../format';
import { ICON, SEVERITY_ICONS, SEVERITY_LABELS } from '../icons';
import { UIWindow } from './window';

type Filter = 'all' | MessageSeverity;
const MAX_ROWS = 300;

export class EventLogWindow extends UIWindow {
  private list!: HTMLElement;
  private rows = new Map<number, HTMLElement>();
  private key = '';
  private filter: Filter = 'all';
  private filterBtns = new Map<Filter, HTMLButtonElement>();
  private emptyEl!: HTMLElement;
  private counts = new Map<Filter, HTMLElement>();

  constructor(ui: UIContext) {
    super(ui, { id: 'log', title: 'Event Log', icon: ICON.log, width: 46, hotkey: 'L', className: 'w-log' });
  }

  protected build(): void {
    const bar = h('div', { class: 'log-filters', role: 'radiogroup', 'aria-label': 'Filter messages' });
    const filters: Filter[] = ['all', 'danger', 'warning', 'good', 'info'];
    for (const f of filters) {
      const count = h('span', { class: 'lf-n' });
      const b = h('button', {
        class: `lf-btn lf-${f}`, type: 'button', role: 'radio',
        onclick: () => {
          this.filter = f;
          this.syncFilter();
        },
      }, f === 'all' ? 'All' : `${SEVERITY_ICONS[f]} ${SEVERITY_LABELS[f]}`, count);
      this.filterBtns.set(f, b);
      this.counts.set(f, count);
      bar.appendChild(b);
    }
    this.list = h('div', { class: 'log-list f-all', role: 'log', 'aria-live': 'off' });
    this.emptyEl = h('div', { class: 'log-empty' }, 'Nothing has happened yet.');
    this.body.append(bar, this.list, this.emptyEl);
    this.syncFilter();
  }

  private syncFilter(): void {
    for (const [f, b] of this.filterBtns) {
      setClass(b, 'on', f === this.filter);
      b.setAttribute('aria-checked', f === this.filter ? 'true' : 'false');
    }
    this.list.className = `log-list f-${this.filter}`;
    this.updateEmpty();
  }

  private updateEmpty(): void {
    const msgs = this.ui.game.state.messages;
    const n = this.filter === 'all' ? msgs.length : msgs.filter((m) => m.severity === this.filter).length;
    show(this.emptyEl, n === 0);
    this.emptyEl.textContent = msgs.length === 0 ? 'Nothing has happened yet.' : 'No messages of this kind.';
  }

  private makeRow(m: GameMessage): HTMLElement {
    const target = m.target;
    return h('div', { class: `log-row sev-${m.severity}` },
      h('span', { class: 'log-sev', 'aria-hidden': 'true' }, SEVERITY_ICONS[m.severity]),
      h('span', { class: 'log-date' }, shortDate(m.year, m.month)),
      h('span', { class: 'log-text' }, m.text),
      target
        ? h('button', { class: 'log-go', type: 'button', 'aria-label': 'Go to', tip: 'Go to', onclick: () => this.ui.goTo(target) }, ICON.goTo)
        : h('span', { class: 'log-go-ph' }));
  }

  override refresh(): void {
    if (!this.list) return;
    const msgs = this.ui.game.state.messages;
    const first = msgs.length ? msgs[0].id : -1;
    const last = msgs.length ? msgs[msgs.length - 1].id : -1;
    const key = `${msgs.length}:${first}:${last}`;
    if (key === this.key) return;
    this.key = key;
    const start = Math.max(0, msgs.length - MAX_ROWS);
    const keep = new Set<number>();
    for (let i = start; i < msgs.length; i++) keep.add(msgs[i].id);
    for (const [id, el] of this.rows) {
      if (!keep.has(id)) {
        el.remove();
        this.rows.delete(id);
      }
    }
    // newest first: walk from the newest and insert missing rows in order
    let prev: HTMLElement | null = null;
    for (let i = msgs.length - 1; i >= start; i--) {
      const m = msgs[i];
      let row = this.rows.get(m.id);
      if (!row) {
        row = this.makeRow(m);
        this.rows.set(m.id, row);
        if (prev) prev.after(row);
        else this.list.prepend(row);
      }
      prev = row;
    }
    const counts: Record<Filter, number> = { all: msgs.length, info: 0, good: 0, warning: 0, danger: 0 };
    for (const m of msgs) counts[m.severity]++;
    for (const [f, el] of this.counts) el.textContent = counts[f] ? fmtInt(counts[f]) : '';
    this.updateEmpty();
  }

  override onGameChanged(): void {
    for (const el of this.rows.values()) el.remove();
    this.rows.clear();
    this.key = '';
  }
}
