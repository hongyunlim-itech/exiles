/**
 * Town Overview window (O): population breakdown, housing, storage usage, food by group and every resource by
 * category, plus births/deaths tallies.
 */
import { BUILDINGS, RESOURCES, RESOURCE_TYPES } from '../../core/defs';
import type { CauseOfDeath, FoodGroup, ResourceCategory, ResourceType } from '../../core/types';
import type { UIContext } from '../context';
import { h, setClass, setText, show } from '../dom';
import { fmtCompact, fmtInt, pct } from '../format';
import { DEATH_CAUSE_LABELS, FOOD_GROUP_ICONS, FOOD_GROUP_NAMES, FOOD_GROUPS, ICON } from '../icons';
import { FOOD_PER_CITIZEN_MONTH } from '../hud/topbar';
import { Bar, section } from '../widgets';
import { UIWindow } from './window';

const CATEGORIES: { id: ResourceCategory; name: string }[] = [
  { id: 'material', name: 'Materials' },
  { id: 'fuel', name: 'Fuel' },
  { id: 'tool', name: 'Tools' },
  { id: 'clothing', name: 'Clothing' },
  { id: 'textile', name: 'Textiles' },
  { id: 'health', name: 'Health' },
  { id: 'luxury', name: 'Luxury' },
  { id: 'food', name: 'Food' },
];

interface Stat {
  el: HTMLElement;
  value: HTMLElement;
}

function stat(icon: string, label: string, tip?: string): Stat {
  const value = h('span', { class: 'st-v' });
  const el = h('div', { class: 'stat', tip }, h('span', { class: 'st-i', 'aria-hidden': 'true' }, icon), h('span', { class: 'st-body' }, value, h('span', { class: 'st-l' }, label)));
  return { el, value };
}

export class OverviewWindow extends UIWindow {
  private stats: Record<string, Stat> = {};
  private stockBar!: Bar;
  private barnBar!: Bar;
  private foodGroupBars = new Map<FoodGroup, { bar: Bar; val: HTMLElement }>();
  private foodMonths!: HTMLElement;
  private resCells = new Map<ResourceType, { el: HTMLElement; val: HTMLElement }>();
  private deathRows = new Map<CauseOfDeath, { el: HTMLElement; val: HTMLElement }>();
  private births!: HTMLElement;
  private buildingsLine!: HTMLElement;

  constructor(ui: UIContext) {
    super(ui, { id: 'overview', title: 'Town Overview', icon: ICON.overview, width: 46, hotkey: 'O', className: 'w-overview' });
  }

  protected build(): void {
    const b = this.body;
    // population
    const popGrid = h('div', { class: 'stat-grid' });
    const add = (key: string, icon: string, label: string, tip?: string) => {
      const s = stat(icon, label, tip);
      this.stats[key] = s;
      popGrid.appendChild(s.el);
    };
    add('total', ICON.people, 'Citizens');
    add('adults', '🧑', 'Adults');
    add('elderly', ICON.elderly, 'Elderly', 'Aged 60+; they work more slowly.');
    add('students', ICON.student, 'Students');
    add('children', ICON.child, 'Children');
    add('homeless', ICON.homeless, 'Homeless', 'Citizens without a home are cold and unhappy.');
    add('sick', ICON.sick, 'Sick');
    add('housing', ICON.house, 'Housing', 'Residents / capacity of finished homes.');
    b.appendChild(section('Population', popGrid));

    // storage
    this.stockBar = new Bar({ tone: 'gold' });
    this.barnBar = new Bar({ tone: 'gold' });
    b.appendChild(section('Storage',
      h('div', { class: 'ov-store' },
        h('div', { class: 'ov-store-row', tip: 'Stockpiles hold logs, stone, iron and firewood.' }, h('span', { class: 'ov-store-l' }, `${BUILDINGS.stockpile.icon} Stockpiles`), this.stockBar.el),
        h('div', { class: 'ov-store-row', tip: 'Barns hold food, tools, clothing and goods.' }, h('span', { class: 'ov-store-l' }, `${BUILDINGS.storageBarn.icon} Barns`), this.barnBar.el))));

    // food
    const foodBox = h('div', { class: 'ov-food' });
    for (const g of FOOD_GROUPS) {
      const bar = new Bar({ tone: 'good', label: false });
      const val = h('span', { class: 'ov-fg-v' });
      foodBox.appendChild(h('div', { class: 'ov-fg' }, h('span', { class: 'ov-fg-l' }, `${FOOD_GROUP_ICONS[g]} ${FOOD_GROUP_NAMES[g]}`), bar.el, val));
      this.foodGroupBars.set(g, { bar, val });
    }
    this.foodMonths = h('div', { class: 'ov-food-note' });
    b.appendChild(section('Food supply', foodBox, this.foodMonths));

    // resources by category
    const resWrap = h('div', { class: 'ov-cats' });
    for (const cat of CATEGORIES) {
      const types = RESOURCE_TYPES.filter((r) => RESOURCES[r].category === cat.id);
      if (!types.length) continue;
      const grid = h('div', { class: 'ov-res-grid' });
      for (const r of types) {
        const val = h('span', { class: 'ov-res-v' });
        const el = h('div', { class: 'ov-res', tip: RESOURCES[r].name }, h('span', { class: 'ov-res-i' }, RESOURCES[r].icon), h('span', { class: 'ov-res-n' }, RESOURCES[r].name), val);
        grid.appendChild(el);
        this.resCells.set(r, { el, val });
      }
      resWrap.appendChild(h('div', { class: 'ov-cat' }, h('div', { class: 'ov-cat-h' }, cat.name), grid));
    }
    b.appendChild(section('Resources', resWrap));

    // births & deaths
    this.births = h('span', { class: 'kv-v' });
    const deaths = h('div', { class: 'ov-deaths' });
    for (const cause of Object.keys(DEATH_CAUSE_LABELS) as CauseOfDeath[]) {
      const val = h('span', { class: 'kv-v' });
      const el = h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, DEATH_CAUSE_LABELS[cause]), val);
      deaths.appendChild(el);
      this.deathRows.set(cause, { el, val });
    }
    this.buildingsLine = h('div', { class: 'ov-buildings' });
    b.appendChild(section('Records',
      h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, 'Births'), this.births), deaths, this.buildingsLine));
  }

  override refresh(): void {
    if (!this.stockBar) return;
    const data = this.ui.data;
    const pop = data.population();
    const hs = data.housing();
    const st = this.stats;
    setText(st.total.value, fmtInt(pop.total));
    setText(st.adults.value, fmtInt(pop.adults));
    setText(st.elderly.value, fmtInt(pop.elderly));
    setText(st.students.value, fmtInt(pop.students));
    setText(st.children.value, fmtInt(pop.children));
    setText(st.homeless.value, fmtInt(pop.homeless));
    setClass(st.homeless.el, 'bad', pop.homeless > 0);
    setText(st.sick.value, fmtInt(pop.sick));
    setClass(st.sick.el, 'warn', pop.sick > 0);
    setText(st.housing.value, `${fmtInt(hs.residents)}/${fmtInt(hs.capacity)}`);

    const su = data.storage();
    const sf = su.stockpileCap > 0 ? su.stockpileUsed / su.stockpileCap : 0;
    const bf = su.barnCap > 0 ? su.barnUsed / su.barnCap : 0;
    this.stockBar.set(sf, `${fmtCompact(su.stockpileUsed)} / ${fmtCompact(su.stockpileCap)} (${pct(sf)})`, sf > 0.9 ? 'bad' : sf > 0.75 ? 'warn' : 'gold');
    this.barnBar.set(bf, `${fmtCompact(su.barnUsed)} / ${fmtCompact(su.barnCap)} (${pct(bf)})`, bf > 0.9 ? 'bad' : bf > 0.75 ? 'warn' : 'gold');

    const t = data.totals();
    const byGroup: Record<FoodGroup, number> = { protein: 0, grain: 0, vegetable: 0, fruit: 0 };
    for (const r of RESOURCE_TYPES) {
      const g = RESOURCES[r].foodGroup;
      if (g) byGroup[g] += t[r];
    }
    const food = data.food();
    for (const g of FOOD_GROUPS) {
      const e = this.foodGroupBars.get(g)!;
      e.bar.set(food > 0 ? byGroup[g] / food : 0);
      setText(e.val, fmtInt(byGroup[g]));
    }
    const groups = FOOD_GROUPS.filter((g) => byGroup[g] >= 1).length;
    const months = pop.total > 0 ? food / (pop.total * FOOD_PER_CITIZEN_MONTH) : 0;
    setText(this.foodMonths, pop.total > 0
      ? `${fmtInt(food)} food ≈ ${months > 36 ? '3+ years' : `${Math.floor(months)} months`} for ${fmtInt(pop.total)} people · ${groups}/4 food groups available${groups < 3 ? ' — a varied diet keeps people healthy' : ''}`
      : `${fmtInt(food)} food in storage`);
    setClass(this.foodMonths, 't-bad', pop.total > 0 && months < 3);

    for (const [r, cell] of this.resCells) {
      setText(cell.val, fmtCompact(t[r]));
      setClass(cell.el, 'zero', t[r] < 1);
    }

    const tally = this.ui.game.state.tally;
    setText(this.births, fmtInt(tally.births));
    let totalDeaths = 0;
    for (const [cause, row] of this.deathRows) {
      const n = tally.deaths[cause] ?? 0;
      totalDeaths += n;
      setText(row.val, fmtInt(n));
      show(row.el, n > 0);
    }
    let active = 0;
    let building = 0;
    for (const bl of this.ui.game.state.buildings) {
      if (bl.state === 'active') active++;
      else if (bl.state === 'construction' || bl.state === 'clearing') building++;
    }
    setText(this.buildingsLine, `${fmtInt(totalDeaths)} deaths in total · ${fmtInt(active)} buildings · ${fmtInt(building)} under construction`);
  }
}
