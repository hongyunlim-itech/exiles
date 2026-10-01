/**
 * Selection panel content for a citizen: needs & wellbeing bars (with factor tooltips from sim/wellbeing), diet,
 * equipment, current task, carried goods, home/workplace links and family.
 */
import { COAT_LIFETIME, TOOL_LIFETIME } from '../../core/constants';
import { BUILDINGS, FOOD_GROUP_BIT, PROFESSIONS, RESOURCES } from '../../core/defs';
import type { Citizen } from '../../core/types';
import { ageClassOf } from '../../core/world';
import type { UIContext } from '../context';
import { h, setClass, setText, show } from '../dom';
import { fmtInt, fmtSignedDec, pct } from '../format';
import { ACTIVITY_LABELS, FOOD_GROUP_ICONS, FOOD_GROUP_NAMES, FOOD_GROUPS, ICON } from '../icons';
import { simBridge, type Factor } from '../sim-bridge';
import { richTip, type TipRow } from '../tooltip';
import { Bar, iconButton, section, toneFor } from '../widgets';

type NeedKey = 'health' | 'happiness' | 'food' | 'warmth' | 'education';

const NEEDS: { key: NeedKey; label: string; icon: string }[] = [
  { key: 'health', label: 'Health', icon: ICON.heart },
  { key: 'happiness', label: 'Happiness', icon: ICON.smile },
  { key: 'food', label: 'Food', icon: ICON.food },
  { key: 'warmth', label: 'Warmth', icon: '🔥' },
  { key: 'education', label: 'Education', icon: ICON.book },
];

function factorRows(factors: Factor[] | null): TipRow[] {
  if (!factors) return [{ label: 'No details available', tone: 'dim' }];
  if (!factors.length) return [{ label: 'Nothing special', tone: 'dim' }];
  return factors
    .slice()
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map((f) => ({ label: f.label, value: fmtSignedDec(f.value), tone: f.value > 0.05 ? 'good' : f.value < -0.05 ? 'bad' : 'dim' }));
}

export class CitizenView {
  readonly el: HTMLElement;
  readonly id: number;
  private following = false;
  private name!: HTMLElement;
  private genderEl!: HTMLElement;
  private sub!: HTMLElement;
  private badges!: { sick: HTMLElement; grief: HTMLElement; homeless: HTMLElement; elderly: HTMLElement; hungry: HTMLElement; cold: HTMLElement };
  private bars = new Map<NeedKey, { row: HTMLElement; bar: Bar }>();
  private diet = new Map<string, HTMLElement>();
  private tool!: HTMLElement;
  private coat!: HTMLElement;
  private task!: HTMLElement;
  private activity!: HTMLElement;
  private carrying!: HTMLElement;
  private home!: HTMLButtonElement;
  private work!: HTMLButtonElement;
  private workLabel!: HTMLElement;
  private family!: HTMLElement;
  private familyKey = '';
  private followBtn!: HTMLButtonElement;

  constructor(private readonly ui: UIContext, c: Citizen) {
    this.id = c.id;
    this.el = h('div', { class: 'sel-view cit' });
    this.build();
    this.update();
  }

  get isFollowing(): boolean {
    return this.following;
  }

  setFollowing(on: boolean): void {
    this.following = on;
    setClass(this.followBtn, 'on', on);
    this.followBtn.setAttribute('aria-pressed', String(on));
  }

  private build(): void {
    const ui = this.ui;
    this.genderEl = h('span', { class: 'sel-icon gender', 'aria-hidden': 'true' });
    this.name = h('h3', { class: 'sel-name' });
    this.sub = h('div', { class: 'sel-sub' });
    const mk = (text: string, cls: string) => {
      const e = h('span', { class: `badge ${cls}` }, text);
      e.hidden = true;
      return e;
    };
    this.badges = {
      sick: mk(`${ICON.sick} Sick`, 'bad'),
      grief: mk('💧 Grieving', 'info'),
      homeless: mk(`${ICON.homeless} Homeless`, 'bad'),
      elderly: mk(`${ICON.elderly} Elderly`, 'neutral'),
      hungry: mk('Hungry', 'warn'),
      cold: mk('Freezing', 'warn'),
    };
    this.followBtn = iconButton(ICON.follow, 'Follow with the camera', () => this.setFollowing(!this.following), { tip: 'Follow with the camera' });
    this.followBtn.setAttribute('aria-pressed', 'false');
    const focus = iconButton(ICON.focus, 'Go to citizen', () => {
      const c = ui.game.getCitizen(this.id);
      if (c) ui.app.focusOn(c.x, c.z);
    });
    const close = iconButton(ICON.close, 'Close', () => ui.app.select(null), { tip: 'Close [Esc]' });
    this.el.appendChild(h('div', { class: 'sel-head' },
      this.genderEl,
      h('div', { class: 'sel-titles' }, this.name, this.sub, h('div', { class: 'sel-badges' }, ...Object.values(this.badges))),
      h('div', { class: 'sel-btns' }, this.followBtn, focus, close)));

    // needs
    const needs = h('div', { class: 'needs' });
    for (const n of NEEDS) {
      const bar = new Bar({ tone: 'good' });
      const row = h('div', { class: 'need', 'data-tip-pos': 'left' }, h('span', { class: 'need-l' }, h('span', { class: 'need-i', 'aria-hidden': 'true' }, n.icon), n.label), bar.el);
      this.bars.set(n.key, { row, bar });
      needs.appendChild(row);
      ui.tips.set(row, () => this.needTip(n.key));
    }
    this.el.appendChild(section('Wellbeing', needs));

    // diet & equipment
    const dietRow = h('div', { class: 'diet', 'data-tip-pos': 'left' });
    for (const g of FOOD_GROUPS) {
      const e = h('span', { class: 'diet-g', 'aria-label': FOOD_GROUP_NAMES[g] }, FOOD_GROUP_ICONS[g]);
      this.diet.set(g, e);
      dietRow.appendChild(e);
    }
    ui.tips.set(dietRow, () => {
      const c = ui.game.getCitizen(this.id);
      if (!c) return null;
      const rows: TipRow[] = FOOD_GROUPS.map((g) => ({
        label: FOOD_GROUP_NAMES[g], icon: FOOD_GROUP_ICONS[g], value: c.dietMask & FOOD_GROUP_BIT[g] ? 'eaten recently' : 'missing', tone: c.dietMask & FOOD_GROUP_BIT[g] ? 'good' : 'dim',
      }));
      return richTip({ title: 'Diet variety', desc: 'Eating from more food groups improves health and happiness.', rows });
    });
    this.tool = h('span', { class: 'equip' });
    this.coat = h('span', { class: 'equip' });
    ui.tips.set(this.tool, 'Tools double work speed. They wear out and are replaced from storage.');
    ui.tips.set(this.coat, 'A coat keeps its wearer warm outdoors in cold weather.');
    this.el.appendChild(section('Diet & equipment', h('div', { class: 'equip-row' }, dietRow, h('div', { class: 'equip-list' }, this.tool, this.coat))));

    // task
    this.activity = h('span', { class: 'badge neutral' });
    this.task = h('div', { class: 'task' });
    this.carrying = h('div', { class: 'carrying' });
    this.el.appendChild(section('Current task', h('div', { class: 'task-row' }, this.activity, this.task), this.carrying));

    // home & work
    this.home = h('button', { class: 'link', type: 'button', onclick: () => this.goBuilding('home') });
    this.work = h('button', { class: 'link', type: 'button', onclick: () => this.goBuilding('work') });
    this.workLabel = h('span', { class: 'kv-l' }, 'Work');
    this.el.appendChild(section('Home & work',
      h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, 'Home'), this.home),
      h('div', { class: 'kv' }, this.workLabel, this.work)));

    this.family = h('div', { class: 'family' });
    this.el.appendChild(section('Family', this.family));
  }

  private goBuilding(which: 'home' | 'work'): void {
    const c = this.ui.game.getCitizen(this.id);
    if (!c) return;
    const id = which === 'home' ? c.homeId : c.workplaceId;
    if (id >= 0 && this.ui.game.getBuilding(id)) this.ui.selectBuilding(id, true);
  }

  /** Returns false if the citizen no longer exists. */
  update(): boolean {
    const c = this.ui.game.getCitizen(this.id);
    if (!c) return false;
    const prof = PROFESSIONS[c.profession];
    setText(this.genderEl, c.gender === 'M' ? ICON.male : ICON.female);
    setClass(this.genderEl, 'female', c.gender === 'F');
    setText(this.name, c.name);
    const age = ageClassOf(c);
    setText(this.sub, `${Math.floor(c.age)} years · ${prof.icon} ${prof.name}`);
    show(this.badges.sick, c.sick > 0);
    show(this.badges.grief, c.grief > 5);
    show(this.badges.homeless, c.homeId < 0);
    show(this.badges.elderly, age === 'elderly');
    show(this.badges.hungry, c.food < 15);
    show(this.badges.cold, c.warmth < 20);

    const vals: Record<NeedKey, number> = {
      health: c.health / 100,
      happiness: c.happiness / 100,
      food: c.food / 100,
      warmth: c.warmth / 100,
      education: c.education,
    };
    for (const [k, { bar, row }] of this.bars) {
      const v = vals[k];
      bar.set(v, pct(v), k === 'education' ? 'info' : toneFor(v));
      if (k === 'education') show(row, age !== 'child');
    }

    for (const g of FOOD_GROUPS) setClass(this.diet.get(g)!, 'on', !!(c.dietMask & FOOD_GROUP_BIT[g]));
    const worker = age === 'adult' || age === 'elderly';
    setText(this.tool, c.toolWear > 0 ? `${RESOURCES.tool.icon} Tool ${pct(c.toolWear / TOOL_LIFETIME)}` : `${RESOURCES.tool.icon} No tool`);
    setClass(this.tool, 't-bad', c.toolWear <= 0 && worker);
    show(this.tool, worker);
    setText(this.coat, c.coatWear > 0 ? `${ICON.coat} Coat ${pct(c.coatWear / COAT_LIFETIME)}` : `${ICON.coat} No coat`);
    setClass(this.coat, 't-warn', c.coatWear <= 0);

    setText(this.activity, ACTIVITY_LABELS[c.activity] ?? c.activity);
    setText(this.task, c.taskLabel || (c.moving ? 'On the move' : 'Idle'));
    if (c.carrying && c.carrying.amount > 0) {
      const r = RESOURCES[c.carrying.type];
      setText(this.carrying, `Carrying ${r?.icon ?? ''} ${fmtInt(c.carrying.amount)} ${r?.name ?? c.carrying.type}`);
      show(this.carrying, true);
    } else show(this.carrying, false);

    const home = c.homeId >= 0 ? this.ui.game.getBuilding(c.homeId) : undefined;
    setText(this.home, home ? `${BUILDINGS[home.type].icon} ${BUILDINGS[home.type].name}` : `${ICON.homeless} Homeless`);
    this.home.disabled = !home;
    const wp = c.workplaceId >= 0 ? this.ui.game.getBuilding(c.workplaceId) : undefined;
    if (wp) {
      setText(this.workLabel, 'Work');
      setText(this.work, `${BUILDINGS[wp.type].icon} ${BUILDINGS[wp.type].name}`);
      this.work.disabled = false;
    } else {
      setText(this.workLabel, c.profession === 'student' ? 'School' : 'Work');
      const txt: Record<string, string> = {
        laborer: 'Laborer — goes wherever needed', builder: 'Builder — at construction sites', child: 'Too young to work', student: 'Studying',
      };
      setText(this.work, txt[c.profession] ?? '—');
      this.work.disabled = true;
    }
    this.updateFamily(c);
    return true;
  }

  private updateFamily(c: Citizen): void {
    const key = `${c.spouseId}|${c.motherId}|${c.fatherId}|${c.childIds.join(',')}`;
    const g = this.ui.game;
    const alive = (id: number) => id >= 0 && !!g.getCitizen(id);
    const aliveKey = `${key}|${[c.spouseId, c.motherId, c.fatherId, ...c.childIds].map((id) => (alive(id) ? 1 : 0)).join('')}`;
    if (aliveKey === this.familyKey) return;
    this.familyKey = aliveKey;
    this.family.replaceChildren();
    const person = (label: string, id: number) => {
      if (id < 0) return;
      const p = g.getCitizen(id);
      const val = p
        ? h('button', { class: 'link', type: 'button', onclick: () => this.ui.selectCitizen(id, true) }, `${p.name} (${Math.floor(p.age)})`)
        : h('span', { class: 'kv-v dim' }, 'deceased');
      this.family.appendChild(h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, label), val));
    };
    person(c.gender === 'M' ? 'Wife' : 'Husband', c.spouseId);
    person('Mother', c.motherId);
    person('Father', c.fatherId);
    if (c.childIds.length) {
      const kids = h('div', { class: 'kids' });
      for (const id of c.childIds) {
        const p = g.getCitizen(id);
        kids.appendChild(p
          ? h('button', { class: 'link', type: 'button', onclick: () => this.ui.selectCitizen(id, true) }, `${p.gender === 'M' ? ICON.male : ICON.female} ${p.name.split(' ')[0]} (${Math.floor(p.age)})`)
          : h('span', { class: 'dim' }, '✝'));
      }
      this.family.appendChild(h('div', { class: 'kv top' }, h('span', { class: 'kv-l' }, 'Children'), kids));
    }
    if (!this.family.childElementCount) this.family.appendChild(h('div', { class: 'sel-note dim' }, 'No family.'));
  }

  private needTip(key: NeedKey): HTMLElement | null {
    const c = this.ui.game.getCitizen(this.id);
    if (!c) return null;
    switch (key) {
      case 'health':
        return richTip({ title: `Health ${Math.round(c.health)}%`, icon: ICON.heart, rows: factorRows(simBridge.healthFactors(this.ui.game, c)), note: c.sick > 0 ? `Sick (${pct(c.sick)} severity). A hospital with herbs can cure disease.` : 'At 0 health a citizen dies.', noteTone: c.sick > 0 ? 'bad' : 'dim' });
      case 'happiness':
        return richTip({ title: `Happiness ${Math.round(c.happiness)}%`, icon: ICON.smile, rows: factorRows(simBridge.happinessFactors(this.ui.game, c)), note: 'Happy people work faster and have more children.', noteTone: 'dim' });
      case 'food':
        return richTip({ title: `Food ${Math.round(c.food)}%`, icon: ICON.food, desc: 'Drops over time. Citizens eat at home, or from a barn or market when home is empty.', note: c.starveTime > 0 ? 'Starving!' : undefined, noteTone: 'bad' });
      case 'warmth':
        return richTip({ title: `Warmth ${Math.round(c.warmth)}%`, icon: '🔥', desc: 'Drops outdoors in cold weather (slower with a coat). A heated home warms people up.', note: c.freezeTime > 0 ? 'Freezing!' : undefined, noteTone: 'bad' });
      case 'education':
        return richTip({ title: `Education ${pct(c.education)}`, icon: ICON.book, desc: 'Children who study at a school with a teacher become more productive adults.' });
    }
  }
}
