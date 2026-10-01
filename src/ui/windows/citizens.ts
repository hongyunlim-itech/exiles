/**
 * Citizens window (N): sortable, filterable list of every citizen. Rows are pooled by citizen id and updated in
 * place; the DOM order is only touched when the sorted order actually changes.
 */
import { PROFESSIONS, PROFESSION_TYPES } from '../../core/defs';
import type { Citizen, Profession } from '../../core/types';
import type { UIContext } from '../context';
import { h, setClass, setFrac, setText, show } from '../dom';
import { fmtInt } from '../format';
import { ICON } from '../icons';
import { toneFor } from '../widgets';
import { UIWindow } from './window';

type SortKey = 'name' | 'age' | 'job' | 'health' | 'happiness' | 'home';

interface Row {
  el: HTMLElement;
  name: HTMLElement;
  age: HTMLElement;
  job: HTMLElement;
  healthFill: HTMLElement;
  happyFill: HTMLElement;
  home: HTMLElement;
  task: HTMLElement;
  tone: string;
}

const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
  { key: 'name', label: 'Name', cls: 'c-name' },
  { key: 'age', label: 'Age', cls: 'c-age' },
  { key: 'job', label: 'Profession', cls: 'c-job' },
  { key: 'health', label: 'Health', cls: 'c-bar' },
  { key: 'happiness', label: 'Happiness', cls: 'c-bar' },
  { key: 'home', label: 'Home', cls: 'c-home' },
];

function miniBar(): { el: HTMLElement; fill: HTMLElement } {
  const fill = h('span', { class: 'mini-fill' });
  return { el: h('span', { class: 'mini-bar' }, fill), fill };
}

export class CitizensWindow extends UIWindow {
  private list!: HTMLElement;
  private rows = new Map<number, Row>();
  private order = '';
  private sortKey: SortKey = 'name';
  private sortDir = 1;
  private filterText = '';
  private filterProf: Profession | 'all' | 'sick' | 'homeless' = 'all';
  private headers = new Map<SortKey, HTMLElement>();
  private countEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private profSelect!: HTMLSelectElement;
  private lastRefresh = 0;

  constructor(ui: UIContext) {
    super(ui, { id: 'citizens', title: 'Citizens', icon: ICON.citizens, width: 80, hotkey: 'N', className: 'w-citizens' });
  }

  protected build(): void {
    const search = h('input', {
      class: 'input search', type: 'search', placeholder: 'Search by name…', 'aria-label': 'Search citizens',
      oninput: () => {
        this.filterText = search.value.trim().toLowerCase();
        this.refresh(true);
      },
    });
    this.profSelect = h('select', {
      class: 'input', 'aria-label': 'Filter by profession',
      onchange: () => {
        this.filterProf = this.profSelect.value as typeof this.filterProf;
        this.refresh(true);
      },
    },
    h('option', { value: 'all' }, 'Everyone'),
    h('option', { value: 'sick' }, 'Sick'),
    h('option', { value: 'homeless' }, 'Homeless'),
    ...PROFESSION_TYPES.map((p) => h('option', { value: p }, `${PROFESSIONS[p].name}s`)));
    this.countEl = h('span', { class: 'cl-count' });
    this.body.appendChild(h('div', { class: 'cl-tools' }, search, this.profSelect, this.countEl));

    const head = h('div', { class: 'cl-head', role: 'row' });
    for (const c of COLUMNS) {
      const el = h('button', {
        class: `cl-h ${c.cls}`, type: 'button', role: 'columnheader', 'aria-sort': 'none',
        onclick: () => {
          if (this.sortKey === c.key) this.sortDir = -this.sortDir;
          else {
            this.sortKey = c.key;
            this.sortDir = c.key === 'name' || c.key === 'job' ? 1 : -1;
          }
          this.syncHeaders();
          this.refresh(true);
        },
      }, c.label);
      this.headers.set(c.key, el);
      head.appendChild(el);
    }
    head.appendChild(h('span', { class: 'cl-h c-task', role: 'columnheader' }, 'Doing'));
    this.list = h('div', { class: 'cl-list', role: 'rowgroup' });
    this.emptyEl = h('div', { class: 'cl-empty' }, 'No citizens match.');
    this.body.appendChild(h('div', { class: 'cl-table', role: 'table', 'aria-label': 'Citizens' }, head, this.list, this.emptyEl));
    this.syncHeaders();
  }

  private syncHeaders(): void {
    for (const [k, el] of this.headers) {
      const on = k === this.sortKey;
      setClass(el, 'on', on);
      setClass(el, 'desc', on && this.sortDir < 0);
      el.setAttribute('aria-sort', on ? (this.sortDir > 0 ? 'ascending' : 'descending') : 'none');
    }
  }

  private makeRow(c: Citizen): Row {
    const name = h('span', { class: 'c-name' });
    const age = h('span', { class: 'c-age' });
    const job = h('span', { class: 'c-job' });
    const hb = miniBar();
    const pb = miniBar();
    const home = h('span', { class: 'c-home' });
    const task = h('span', { class: 'c-task' });
    const el = h('div', {
      class: 'cl-row', role: 'row', tabindex: '0',
      onclick: () => this.ui.selectCitizen(c.id, true),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.ui.selectCitizen(c.id, true);
      },
    }, name, age, job, h('span', { class: 'c-bar' }, hb.el), h('span', { class: 'c-bar' }, pb.el), home, task);
    return { el, name, age, job, healthFill: hb.fill, happyFill: pb.fill, home, task, tone: '' };
  }

  private matches(c: Citizen): boolean {
    if (this.filterText && !c.name.toLowerCase().includes(this.filterText)) return false;
    switch (this.filterProf) {
      case 'all': return true;
      case 'sick': return c.sick > 0;
      case 'homeless': return c.homeId < 0;
      default: return c.profession === this.filterProf;
    }
  }

  private compare = (a: Citizen, b: Citizen): number => {
    let d = 0;
    switch (this.sortKey) {
      case 'name': d = a.name.localeCompare(b.name); break;
      case 'age': d = a.age - b.age; break;
      case 'job': d = PROFESSIONS[a.profession].name.localeCompare(PROFESSIONS[b.profession].name); break;
      case 'health': d = a.health - b.health; break;
      case 'happiness': d = a.happiness - b.happiness; break;
      case 'home': d = (a.homeId >= 0 ? 1 : 0) - (b.homeId >= 0 ? 1 : 0); break;
    }
    return d * this.sortDir || a.id - b.id;
  };

  override refresh(force = false): void {
    if (!this.list) return;
    const now = performance.now();
    // the list can be long: refresh at ~2 Hz unless forced
    if (!force && now - this.lastRefresh < 480) return;
    this.lastRefresh = now;
    const game = this.ui.game;
    const all = game.state.citizens;
    const visible = all.filter((c) => this.matches(c)).sort(this.compare);
    const alive = new Set<number>();
    for (const c of all) alive.add(c.id);
    for (const [id, row] of this.rows) {
      if (!alive.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
    const sel = this.ui.app.selection;
    for (const c of visible) {
      let row = this.rows.get(c.id);
      if (!row) {
        row = this.makeRow(c);
        this.rows.set(c.id, row);
      }
      setText(row.name, `${c.gender === 'M' ? ICON.male : ICON.female} ${c.name}`);
      setText(row.age, fmtInt(c.age));
      const p = PROFESSIONS[c.profession];
      setText(row.job, `${p.icon} ${p.name}`);
      setFrac(row.healthFill, c.health / 100);
      setFrac(row.happyFill, c.happiness / 100);
      const ht = `t-${toneFor(c.health / 100)}`;
      const pt = `t-${toneFor(c.happiness / 100)}`;
      const tone = `${ht}|${pt}`;
      if (tone !== row.tone) {
        row.tone = tone;
        row.healthFill.className = `mini-fill ${ht}`;
        row.happyFill.className = `mini-fill ${pt}`;
      }
      const home = c.homeId >= 0 ? game.getBuilding(c.homeId) : undefined;
      setText(row.home, home ? '🏠' : ICON.homeless);
      setClass(row.home, 't-bad', !home);
      setText(row.task, c.sick > 0 ? `${ICON.sick} ${c.taskLabel || 'Sick'}` : c.taskLabel || '—');
      setClass(row.el, 'sel', sel?.kind === 'citizen' && sel.id === c.id);
    }
    const order = visible.map((c) => c.id).join(',');
    if (order !== this.order) {
      this.order = order;
      const frag = document.createDocumentFragment();
      for (const c of visible) frag.appendChild(this.rows.get(c.id)!.el);
      // detach rows that are filtered out
      const shown = new Set<number>();
      for (const c of visible) shown.add(c.id);
      for (const [id, row] of this.rows) if (!shown.has(id) && row.el.parentNode) row.el.remove();
      this.list.appendChild(frag);
    }
    setText(this.countEl, visible.length === all.length ? `${fmtInt(all.length)} citizens` : `${fmtInt(visible.length)} of ${fmtInt(all.length)}`);
    show(this.emptyEl, visible.length === 0);
  }

  override onGameChanged(): void {
    for (const r of this.rows.values()) r.el.remove();
    this.rows.clear();
    this.order = '';
  }
}
