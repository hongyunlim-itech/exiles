/**
 * Professions window (P): every profession with current count, builders −/+, per-profession workplace totals
 * (assigned / desired / capacity) with −/+ that distributes across workplaces, and an expandable per-building list.
 */
import { BUILDINGS, PROFESSIONS } from '../../core/defs';
import type { Building, Profession } from '../../core/types';
import type { UIContext } from '../context';
import { h, setClass, setText } from '../dom';
import { fmtInt } from '../format';
import { ICON, STATE_LABELS } from '../icons';
import { pendingKey } from '../pending';
import { Stepper } from '../widgets';
import { UIWindow } from './window';

const GROUPS: { name: string; profs: Profession[] }[] = [
  { name: 'Food', profs: ['farmer', 'herder', 'gatherer', 'hunter', 'fisherman'] },
  { name: 'Resources & industry', profs: ['forester', 'woodcutter', 'stonecutter', 'miner', 'blacksmith', 'tailor', 'herbalist', 'brewer'] },
  { name: 'Services', profs: ['vendor', 'teacher', 'healer', 'priest', 'tavernkeeper', 'trader'] },
];

interface ProfRow {
  prof: Profession;
  row: HTMLElement;
  count: HTMLElement;
  info: HTMLElement;
  stepper: Stepper;
  detail: HTMLElement;
  expander: HTMLButtonElement;
  expanded: boolean;
  detailKey: string;
  detailRows: Map<number, { el: HTMLElement; text: HTMLElement; stepper: Stepper }>;
}

/** Buildings that can employ a profession (not ruined / being demolished). */
export function workplacesFor(ui: UIContext, prof: Profession): Building[] {
  const out: Building[] = [];
  for (const type of PROFESSIONS[prof].workplaces) {
    for (const b of ui.data.buildingsOfType(type)) if (b.state !== 'ruin' && b.state !== 'demolishing') out.push(b);
  }
  return out;
}

/** Desired workers of `b` as the player last requested them (co-op: before the host applied the change). */
export function desiredWorkers(ui: UIContext, b: Building): number {
  return ui.pending ? ui.pending.get(pendingKey.workers(b.id), b.workersDesired) : b.workersDesired;
}

/** Request `n` desired workers for building `id`. Returns true when accepted (solo: applied; co-op: queued). */
export function requestWorkers(ui: UIContext, id: number, n: number): boolean {
  const res = ui.dispatch({ op: 'workers', id, n }, { errorSound: false });
  if (!res.ok) return false;
  if (res.pending) ui.pending?.set(pendingKey.workers(id), n);
  return true;
}

/** Add/remove one desired worker, distributing across workplaces like Banished. Returns true if changed. */
export function adjustProfession(ui: UIContext, prof: Profession, delta: number): boolean {
  const list = workplacesFor(ui, prof);
  // work on the requested values (co-op: earlier clicks may not be applied yet)
  const desired = new Map<number, number>();
  for (const b of list) desired.set(b.id, desiredWorkers(ui, b));
  let changed = false;
  for (let n = 0; n < Math.abs(delta); n++) {
    if (delta > 0) {
      let best: Building | null = null;
      let bestRatio = Infinity;
      for (const b of list) {
        const max = BUILDINGS[b.type].maxWorkers;
        const cur = desired.get(b.id)!;
        if (cur >= max) continue;
        const ratio = cur / max;
        if (ratio < bestRatio || (ratio === bestRatio && best && b.state === 'active' && best.state !== 'active')) {
          best = b;
          bestRatio = ratio;
        }
      }
      if (!best) break;
      const next = desired.get(best.id)! + 1;
      if (!requestWorkers(ui, best.id, next)) break;
      desired.set(best.id, next);
      changed = true;
    } else {
      let best: Building | null = null;
      let bestRatio = -1;
      for (const b of list) {
        const cur = desired.get(b.id)!;
        if (cur <= 0) continue;
        const ratio = cur / BUILDINGS[b.type].maxWorkers;
        if (ratio > bestRatio) {
          best = b;
          bestRatio = ratio;
        }
      }
      if (!best) break;
      const next = desired.get(best.id)! - 1;
      if (!requestWorkers(ui, best.id, next)) break;
      desired.set(best.id, next);
      changed = true;
    }
  }
  return changed;
}

export class ProfessionsWindow extends UIWindow {
  private rows: ProfRow[] = [];
  private laborers!: HTMLElement;
  private laborersNote!: HTMLElement;
  private builders!: HTMLElement;
  private buildersStepper!: Stepper;
  private children!: HTMLElement;
  private students!: HTMLElement;
  private workforce!: HTMLElement;

  constructor(ui: UIContext) {
    super(ui, { id: 'professions', title: 'Professions', icon: ICON.professions, width: 50, hotkey: 'P', className: 'w-prof' });
  }

  protected build(): void {
    const b = this.body;
    this.workforce = h('div', { class: 'prof-summary' });
    b.appendChild(this.workforce);

    // general
    this.laborers = h('span', { class: 'prof-count' });
    this.laborersNote = h('span', { class: 'prof-info' });
    this.builders = h('span', { class: 'prof-count' });
    this.buildersStepper = new Stepper({
      decLabel: 'Fewer builders', incLabel: 'More builders',
      onStep: (d) => {
        const key = pendingKey.builders();
        const cur = this.ui.pending.get(key, this.ui.game.state.buildersDesired);
        const n = Math.max(0, cur + d);
        if (n === cur) return;
        const res = this.ui.dispatch({ op: 'builders', n });
        if (!res.ok) return;
        if (res.pending) this.ui.pending.set(key, n);
        this.ui.sound('click');
        this.refresh();
      },
    });
    const general = h('div', { class: 'prof-group' },
      h('div', { class: 'prof-group-h' }, 'General'),
      h('div', { class: 'prof-row' },
        h('span', { class: 'prof-i' }, PROFESSIONS.laborer.icon),
        h('span', { class: 'prof-name', tip: 'Unassigned adults. They clear land, haul goods and help builders.' }, h('span', { class: 'prof-exp-ph' }), 'Laborers'),
        this.laborers, this.laborersNote, h('span', { class: 'prof-ctl' })),
      h('div', { class: 'prof-row' },
        h('span', { class: 'prof-i' }, PROFESSIONS.builder.icon),
        h('span', { class: 'prof-name', tip: 'Builders construct new buildings. When idle they work as laborers.' }, h('span', { class: 'prof-exp-ph' }), 'Builders'),
        this.builders, h('span', { class: 'prof-info' }, 'desired'), h('span', { class: 'prof-ctl' }, this.buildersStepper.el)),
    );
    b.appendChild(general);

    for (const g of GROUPS) {
      const grp = h('div', { class: 'prof-group' }, h('div', { class: 'prof-group-h' }, g.name));
      for (const prof of g.profs) grp.appendChild(this.makeRow(prof));
      b.appendChild(grp);
    }

    this.children = h('span', { class: 'prof-count' });
    this.students = h('span', { class: 'prof-count' });
    b.appendChild(h('div', { class: 'prof-group' },
      h('div', { class: 'prof-group-h' }, 'Not working'),
      h('div', { class: 'prof-row' }, h('span', { class: 'prof-i' }, PROFESSIONS.student.icon), h('span', { class: 'prof-name' }, h('span', { class: 'prof-exp-ph' }), 'Students'), this.students, h('span', { class: 'prof-info' }, 'at school until 14'), h('span', { class: 'prof-ctl' })),
      h('div', { class: 'prof-row' }, h('span', { class: 'prof-i' }, PROFESSIONS.child.icon), h('span', { class: 'prof-name' }, h('span', { class: 'prof-exp-ph' }), 'Children'), this.children, h('span', { class: 'prof-info' }, 'under 10'), h('span', { class: 'prof-ctl' })),
    ));
    b.appendChild(h('div', { class: 'win-foot-note' }, 'Tip: Shift-click −/+ to change by 5. Workers are taken from laborers.'));
  }

  private makeRow(prof: Profession): HTMLElement {
    const def = PROFESSIONS[prof];
    const count = h('span', { class: 'prof-count' });
    const info = h('span', { class: 'prof-info' });
    const detail = h('div', { class: 'prof-detail' });
    detail.hidden = true;
    const stepper = new Stepper({
      decLabel: `Fewer ${def.name.toLowerCase()}s`, incLabel: `More ${def.name.toLowerCase()}s`,
      onStep: (d) => {
        if (adjustProfession(this.ui, prof, d)) this.ui.sound('click');
        else this.ui.sound('error');
        this.ui.data.invalidate();
        this.refresh();
      },
    });
    const expander = h('button', { class: 'prof-exp', type: 'button', 'aria-label': `Show ${def.name} workplaces`, 'aria-expanded': 'false' }, '▸');
    const row = h('div', { class: 'prof-row' },
      h('span', { class: 'prof-i' }, def.icon),
      h('span', { class: 'prof-name' }, expander, def.name),
      count, info, h('span', { class: 'prof-ctl' }, stepper.el));
    const r: ProfRow = { prof, row, count, info, stepper, detail, expander, expanded: false, detailKey: '', detailRows: new Map() };
    expander.addEventListener('click', () => {
      r.expanded = !r.expanded;
      expander.setAttribute('aria-expanded', String(r.expanded));
      setClass(expander, 'open', r.expanded);
      detail.hidden = !r.expanded;
      this.refresh();
    });
    this.ui.tips.set(info, `Workers assigned / desired (capacity of all ${def.name.toLowerCase()} workplaces)`);
    this.rows.push(r);
    return h('div', { class: 'prof-block' }, row, detail);
  }

  override refresh(): void {
    if (!this.laborers) return;
    const data = this.ui.data;
    const counts = data.professions();
    const pop = data.population();
    const s = this.ui.game.state;

    const working = Math.max(0, pop.total - pop.children - pop.students);
    setText(this.workforce, `${fmtInt(working)} workers · ${fmtInt(counts.laborer)} laborers free · ${fmtInt(pop.total)} citizens`);
    setText(this.laborers, fmtInt(counts.laborer));
    setText(this.laborersNote, counts.laborer === 0 ? 'none free!' : 'available');
    setClass(this.laborersNote, 't-bad', counts.laborer === 0 && working > 0);
    const builders = this.ui.pending.get(pendingKey.builders(), s.buildersDesired);
    setText(this.builders, `${fmtInt(counts.builder)} / ${fmtInt(builders)}`);
    setClass(this.builders, 'pending', builders !== s.buildersDesired);
    this.buildersStepper.set('', builders > 0, builders < working);
    setText(this.children, fmtInt(pop.children));
    setText(this.students, fmtInt(pop.students));

    for (const r of this.rows) {
      const list = workplacesFor(this.ui, r.prof);
      let desired = 0;
      let max = 0;
      let assigned = 0;
      let pending = false;
      for (const b of list) {
        const want = desiredWorkers(this.ui, b);
        if (want !== b.workersDesired) pending = true;
        desired += want;
        max += BUILDINGS[b.type].maxWorkers;
        assigned += b.workerIds.length;
      }
      setText(r.count, fmtInt(counts[r.prof]));
      const none = list.length === 0;
      setText(r.info, none ? 'no workplace' : `${fmtInt(assigned)}/${fmtInt(desired)} of ${fmtInt(max)} · ${list.length} bldg`);
      setClass(r.row, 'none', none);
      setClass(r.info, 't-warn', !none && assigned < desired);
      setClass(r.info, 'pending', pending);
      r.stepper.set('', desired > 0, desired < max);
      if (r.expander.style.visibility !== (none ? 'hidden' : '')) r.expander.style.visibility = none ? 'hidden' : '';
      if (none && r.expanded) r.expander.click();
      if (r.expanded) this.refreshDetail(r, list);
    }
  }

  private refreshDetail(r: ProfRow, list: Building[]): void {
    const key = list.map((b) => b.id).join(',');
    if (key !== r.detailKey) {
      r.detailKey = key;
      r.detail.replaceChildren();
      r.detailRows.clear();
      for (const b of list) {
        const def = BUILDINGS[b.type];
        const text = h('span', { class: 'pd-t' });
        const stepper = new Stepper({
          decLabel: 'Fewer workers', incLabel: 'More workers',
          onStep: (d) => {
            const cur = this.ui.game.getBuilding(b.id);
            if (!cur) return;
            const base = desiredWorkers(this.ui, cur);
            const n = Math.max(0, Math.min(def.maxWorkers, base + d));
            if (n === base) return;
            if (!requestWorkers(this.ui, b.id, n)) return;
            this.ui.sound('click');
            this.ui.data.invalidate();
            this.refresh();
          },
        });
        const go = h('button', { class: 'link', type: 'button', onclick: () => this.ui.selectBuilding(b.id, true) }, `${def.icon} ${def.name} #${b.id}`);
        const el = h('div', { class: 'pd-row' }, go, text, stepper.el);
        r.detail.appendChild(el);
        r.detailRows.set(b.id, { el, text, stepper });
      }
      if (!list.length) r.detail.appendChild(h('div', { class: 'pd-empty' }, 'No workplaces built.'));
    }
    for (const b of list) {
      const dr = r.detailRows.get(b.id);
      if (!dr) continue;
      const max = BUILDINGS[b.type].maxWorkers;
      const want = desiredWorkers(this.ui, b);
      setText(dr.text, `${b.workerIds.length}/${want}${b.state !== 'active' ? ` · ${STATE_LABELS[b.state].toLowerCase()}` : ''}`);
      setClass(dr.text, 'pending', want !== b.workersDesired);
      dr.stepper.set('', want > 0, want < max);
    }
  }

  override onGameChanged(): void {
    for (const r of this.rows) {
      r.detailKey = '';
    }
  }
}
