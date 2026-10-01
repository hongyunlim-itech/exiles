/**
 * Top bar: town & calendar, weather, key resources (with trends and breakdown tooltips), population, alerts
 * (merchant, nomads, fires), speed controls and the menu button.
 */
import { COLD_TEMP, HUNGER_RATE, MEAL_SIZE, MONTH_SECONDS } from '../../core/constants';
import { CLOTHING_TYPES, FOOD_TYPES, RESOURCES } from '../../core/defs';
import type { GameSpeed, ResourceType, StatsSample } from '../../core/types';
import { currentSeason } from '../../core/world';
import type { UIContext } from '../context';
import { h, setClass, setText, show } from '../dom';
import { dateLabel, fmtCompact, fmtInt, fmtMonths, fmtSigned, fmtTemp, monthName, pct } from '../format';
import { FOOD_GROUP_ICONS, FOOD_GROUP_NAMES, FOOD_GROUPS, ICON, SEASON_ICONS, SEASON_NAMES } from '../icons';
import { richTip, type TipRow } from '../tooltip';

type ResKey = 'food' | 'firewood' | 'log' | 'stone' | 'iron' | 'tool' | 'coats' | 'herbs';

interface ResCell {
  key: ResKey;
  el: HTMLElement;
  num: HTMLElement;
  trend: HTMLElement;
  value: number;
}

const RES_CELLS: { key: ResKey; icon: string; name: string; hist: keyof StatsSample; desc: string }[] = [
  { key: 'food', icon: ICON.food, name: 'Food', hist: 'food', desc: 'All food in barns, markets and stockpiles.' },
  { key: 'firewood', icon: RESOURCES.firewood.icon, name: 'Firewood', hist: 'firewood', desc: 'Homes burn firewood to stay warm in cold weather.' },
  { key: 'log', icon: RESOURCES.log.icon, name: 'Logs', hist: 'logs', desc: 'Building material; woodcutters split logs into firewood.' },
  { key: 'stone', icon: RESOURCES.stone.icon, name: 'Stone', hist: 'stone', desc: 'Building material from rocks and quarries.' },
  { key: 'iron', icon: RESOURCES.iron.icon, name: 'Iron', hist: 'iron', desc: 'Needed for advanced buildings and tools.' },
  { key: 'tool', icon: RESOURCES.tool.icon, name: 'Tools', hist: 'tools', desc: 'Workers without tools work at half speed.' },
  { key: 'coats', icon: ICON.coat, name: 'Coats', hist: 'clothing', desc: 'Coats keep people warm outdoors in winter.' },
  { key: 'herbs', icon: RESOURCES.herbs.icon, name: 'Herbs', hist: 'herbs', desc: 'Herbs keep families healthy and cure disease.' },
];

const SPEEDS: { speed: GameSpeed; label: string; aria: string; key: string }[] = [
  { speed: 0, label: ICON.pause, aria: 'Pause', key: 'Space' },
  { speed: 1, label: '1×', aria: 'Normal speed', key: '1' },
  { speed: 2, label: '2×', aria: 'Double speed', key: '2' },
  { speed: 5, label: '5×', aria: 'Fast speed (5×)', key: '3' },
  { speed: 10, label: '10×', aria: 'Fastest speed (10×)', key: '4' },
];

/** Approximate food eaten per citizen per month (for "months of food" estimates). */
export const FOOD_PER_CITIZEN_MONTH = (MEAL_SIZE * HUNGER_RATE * MONTH_SECONDS) / 100;

export class TopBar {
  readonly el: HTMLElement;
  private town: HTMLElement;
  private date: HTMLElement;
  private season: HTMLElement;
  private temp: HTMLElement;
  private weather: HTMLElement;
  private cells: ResCell[] = [];
  private popAdults: HTMLElement;
  private popStudents: HTMLElement;
  private popChildren: HTMLElement;
  private popHomeless: HTMLElement;
  private popEl: HTMLElement;
  private merchantBtn: HTMLButtonElement;
  private nomadsBtn: HTMLButtonElement;
  private fireBtn: HTMLButtonElement;
  private fireNum: HTMLElement;
  private speedBtns = new Map<GameSpeed, HTMLButtonElement>();
  private pausedBadge: HTMLElement;
  private fireCursor = 0;

  constructor(private readonly ui: UIContext) {
    const tips = ui.tips;

    // ---- left: town & calendar ----
    this.town = h('div', { class: 'tb-town' });
    this.date = h('div', { class: 'tb-date' });
    this.season = h('span', { class: 'tb-season', 'aria-hidden': 'true' });
    this.temp = h('span', { class: 'tb-temp' });
    this.weather = h('span', { class: 'tb-weather', 'aria-hidden': 'true' });
    const cal = h('div', { class: 'tb-cal', 'data-tip-pos': 'below' }, this.season, h('div', { class: 'tb-cal-text' }, this.town, this.date));
    const wx = h('div', { class: 'tb-wx', 'data-tip-pos': 'below' }, this.temp, this.weather);
    tips.set(cal, () => this.calendarTip());
    tips.set(wx, () => this.weatherTip());
    const left = h('div', { class: 'tb-left' }, cal, wx);

    // ---- center: resources ----
    const res = h('div', { class: 'tb-res', role: 'list', 'aria-label': 'Town resources' });
    for (const def of RES_CELLS) {
      const num = h('span', { class: 'tb-num' });
      const trend = h('span', { class: 'tb-trend', 'aria-hidden': 'true' });
      const el = h('div', { class: 'tb-cell', role: 'listitem', 'aria-label': def.name, 'data-tip-pos': 'below' },
        h('span', { class: 'tb-icon', 'aria-hidden': 'true' }, def.icon), num, trend);
      const cell: ResCell = { key: def.key, el, num, trend, value: 0 };
      tips.set(el, () => this.resourceTip(def));
      if (def.key === 'food') el.addEventListener('click', () => ui.toggleWindow('overview'));
      this.cells.push(cell);
      res.appendChild(el);
    }

    // ---- population ----
    this.popAdults = h('span', { class: 'tb-num' });
    this.popStudents = h('span', { class: 'tb-num' });
    this.popChildren = h('span', { class: 'tb-num' });
    this.popHomeless = h('span', { class: 'tb-homeless' });
    this.popEl = h('button', {
      class: 'tb-pop', type: 'button', 'aria-label': 'Population — open citizens list', 'data-tip-pos': 'below',
      onclick: () => ui.toggleWindow('citizens'),
    },
    h('span', { class: 'tb-pop-g' }, h('span', { class: 'tb-icon' }, ICON.people), this.popAdults),
    h('span', { class: 'tb-pop-g' }, h('span', { class: 'tb-icon' }, ICON.student), this.popStudents),
    h('span', { class: 'tb-pop-g' }, h('span', { class: 'tb-icon' }, ICON.child), this.popChildren),
    this.popHomeless);
    tips.set(this.popEl, () => this.populationTip());

    // ---- alerts ----
    this.merchantBtn = h('button', { class: 'tb-alert merchant', type: 'button', 'aria-label': 'Merchant docked — open trade', onclick: () => ui.openWindow('trade') }, ICON.merchant);
    tips.set(this.merchantBtn, () => {
      const m = this.ui.game.state.trade.merchant;
      return m ? richTip({ title: m.name, icon: ICON.merchant, sub: `Merchant docked · leaves in ${fmtMonths(m.leavesIn)}`, note: 'Click to trade' }) : null;
    });
    this.nomadsBtn = h('button', { class: 'tb-alert nomads', type: 'button', 'aria-label': 'Nomads waiting — respond', onclick: () => ui.openWindow('nomads') }, ICON.nomads);
    tips.set(this.nomadsBtn, () => {
      const n = this.ui.game.state.nomads;
      return n ? richTip({ title: `${n.count} nomads at the Town Hall`, icon: ICON.nomads, sub: `They will leave in ${fmtMonths(n.expiresIn)}`, note: 'Click to respond' }) : null;
    });
    this.fireNum = h('span', { class: 'tb-alert-n' });
    this.fireBtn = h('button', { class: 'tb-alert fire', type: 'button', 'aria-label': 'Buildings on fire — go to', onclick: () => this.cycleFire() }, ICON.fire, this.fireNum);
    tips.set(this.fireBtn, 'Buildings are burning! Click to go to the fire.');
    const alerts = h('div', { class: 'tb-alerts' }, this.fireBtn, this.nomadsBtn, this.merchantBtn);

    // ---- speed ----
    const speed = h('div', { class: 'tb-speed', role: 'group', 'aria-label': 'Game speed' });
    for (const s of SPEEDS) {
      const b = h('button', {
        class: `tb-spd ${s.speed === 0 ? 'pause' : ''}`, type: 'button', 'aria-label': s.aria, 'aria-pressed': 'false',
        tip: `${s.aria} [${s.key}]`, 'data-tip-pos': 'below',
        onclick: () => {
          const cur = this.ui.app.net.speed();
          // clicking pause while paused resumes at normal speed (co-op: the shared speed)
          this.ui.app.setSpeed(s.speed === 0 && cur === 0 ? 1 : s.speed);
          this.ui.sound('click');
        },
      }, s.label);
      this.speedBtns.set(s.speed, b);
      speed.appendChild(b);
    }
    const menuBtn = h('button', {
      class: 'tb-menu', type: 'button', 'aria-label': 'Main menu', tip: 'Menu [Esc]', 'data-tip-pos': 'below',
      onclick: () => {
        this.ui.sound('open');
        this.ui.app.openMenu();
      },
    }, ICON.menu);

    const right = h('div', { class: 'tb-right' }, this.popEl, alerts, speed, menuBtn);
    this.pausedBadge = h('div', { class: 'paused-badge', 'aria-live': 'polite' }, 'Paused');
    this.pausedBadge.hidden = true;
    this.el = h('header', { class: 'topbar', role: 'banner' }, left, res, right, this.pausedBadge);
  }

  setSpeed(speed: GameSpeed): void {
    for (const [s, b] of this.speedBtns) {
      const on = s === speed;
      setClass(b, 'on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    show(this.pausedBadge, speed === 0);
  }

  refresh(): void {
    const game = this.ui.game;
    const s = game.state;
    const data = this.ui.data;
    const t = data.totals();

    setText(this.town, s.settings.townName);
    setText(this.date, `Year ${s.time.year} · ${monthName(s.time.month)}`);
    const season = currentSeason(s);
    setText(this.season, SEASON_ICONS[season]);
    setText(this.temp, fmtTemp(s.weather.temperature));
    const temp = s.weather.temperature;
    setClass(this.temp, 'cold', temp < 0);
    setClass(this.temp, 'cool', temp >= 0 && temp < COLD_TEMP);
    setClass(this.temp, 'warm', temp >= 22);
    const p = s.weather.precipitation;
    setText(this.weather, p === 'rain' ? ICON.rain : p === 'snow' ? ICON.snow : '');

    const prev = s.history.length ? s.history[s.history.length - 1] : null;
    const pop = data.population();
    for (const cell of this.cells) {
      const v = this.cellValue(cell.key, t);
      cell.value = v;
      setText(cell.num, fmtCompact(v));
      const def = RES_CELLS.find((d) => d.key === cell.key)!;
      const pv = prev ? Number(prev[def.hist]) : NaN;
      let trend = '';
      if (Number.isFinite(pv)) {
        const d = v - pv;
        if (Math.abs(d) >= Math.max(1, pv * 0.02)) trend = d > 0 ? '▲' : '▼';
        setClass(cell.trend, 'up', d > 0);
        setClass(cell.trend, 'down', d < 0);
      }
      setText(cell.trend, trend);
      // low-stock warnings
      let low = false;
      if (cell.key === 'food') low = v < pop.total * FOOD_PER_CITIZEN_MONTH * 2;
      else if (cell.key === 'firewood') low = v < Math.max(20, data.housing().houses * 8);
      else if (cell.key === 'tool') low = v < Math.max(1, pop.adults * 0.1);
      setClass(cell.el, 'low', low && pop.total > 0);
    }

    setText(this.popAdults, fmtInt(Math.max(0, pop.total - pop.students - pop.children)));
    setText(this.popStudents, fmtInt(pop.students));
    setText(this.popChildren, fmtInt(pop.children));
    setText(this.popHomeless, pop.homeless > 0 ? `${ICON.homeless}${pop.homeless}` : '');
    show(this.popHomeless, pop.homeless > 0);

    show(this.merchantBtn, !!s.trade.merchant);
    show(this.nomadsBtn, !!s.nomads);
    let burning = 0;
    for (const b of s.buildings) if (b.fire > 0) burning++;
    show(this.fireBtn, burning > 0);
    setText(this.fireNum, burning > 1 ? String(burning) : '');
  }

  private cellValue(key: ResKey, t: Record<ResourceType, number>): number {
    switch (key) {
      case 'food': return this.ui.data.food();
      case 'coats': return this.ui.data.coats();
      default: return t[key];
    }
  }

  private cycleFire(): void {
    const burning = this.ui.game.state.buildings.filter((b) => b.fire > 0);
    if (!burning.length) return;
    const b = burning[this.fireCursor++ % burning.length];
    this.ui.goTo({ kind: 'building', id: b.id });
  }

  // ---- tooltips ----

  private calendarTip(): HTMLElement {
    const s = this.ui.game.state;
    const season = currentSeason(s);
    const hint: Record<string, string> = {
      spring: 'Farmers plow and plant their fields.',
      summer: 'Crops grow; a good time to build and stock firewood.',
      autumn: 'Harvest before the first frost destroys the crops!',
      winter: 'Cold weather: homes burn firewood and nothing grows.',
    };
    return richTip({
      title: s.settings.townName,
      sub: `${dateLabel(s.time.year, s.time.month)} — ${pct(s.time.monthProgress)} through the month`,
      rows: [{ label: 'Season', value: SEASON_NAMES[season], icon: SEASON_ICONS[season] }],
      note: hint[season],
      noteTone: 'dim',
    });
  }

  private weatherTip(): HTMLElement {
    const w = this.ui.game.state.weather;
    const rows: TipRow[] = [
      { label: 'Temperature', value: fmtTemp(w.temperature), icon: ICON.temp },
      { label: 'Precipitation', value: w.precipitation === 'none' ? 'None' : `${w.precipitation === 'rain' ? 'Rain' : 'Snow'} (${pct(w.precipIntensity)})` },
      { label: 'Snow cover', value: pct(w.snow) },
    ];
    let note = 'Mild weather.';
    let tone: 'good' | 'warn' | 'bad' = 'good';
    if (w.temperature < 0) {
      note = 'Freezing! Crops die, and people need coats and warm homes.';
      tone = 'bad';
    } else if (w.temperature < COLD_TEMP) {
      note = 'Cold: homes burn firewood and people chill outdoors.';
      tone = 'warn';
    }
    return richTip({ title: 'Weather', rows, note, noteTone: tone });
  }

  private resourceTip(def: (typeof RES_CELLS)[number]): HTMLElement {
    const t = this.ui.data.totals();
    const s = this.ui.game.state;
    const v = this.cellValue(def.key, t);
    const prev = s.history.length ? Number(s.history[s.history.length - 1][def.hist]) : NaN;
    const rows: TipRow[] = [];
    if (def.key === 'food') {
      const byGroup: Record<string, number> = { protein: 0, grain: 0, vegetable: 0, fruit: 0 };
      for (const f of FOOD_TYPES) byGroup[RESOURCES[f].foodGroup ?? 'protein'] += t[f];
      for (const g of FOOD_GROUPS) rows.push({ label: FOOD_GROUP_NAMES[g], value: fmtInt(byGroup[g]), icon: FOOD_GROUP_ICONS[g], tone: byGroup[g] < 1 ? 'dim' : '' });
      const pop = this.ui.data.population().total;
      if (pop > 0) {
        const months = v / (pop * FOOD_PER_CITIZEN_MONTH);
        rows.push({ label: 'Lasts about', value: months > 36 ? '3+ years' : `${Math.floor(months)} months`, tone: months < 3 ? 'bad' : months < 6 ? 'warn' : 'good' });
      }
    } else if (def.key === 'coats') {
      for (const c of CLOTHING_TYPES) rows.push({ label: RESOURCES[c].name, value: fmtInt(t[c]), icon: RESOURCES[c].icon });
    }
    if (Number.isFinite(prev)) rows.push({ label: 'Change this month', value: fmtSigned(v - prev), tone: v - prev < 0 ? 'bad' : v - prev > 0 ? 'good' : 'dim' });
    return richTip({ title: `${def.name}: ${fmtInt(v)}`, icon: def.icon, desc: def.desc, rows, note: def.key === 'food' ? 'Click for the town overview' : undefined, noteTone: 'dim' });
  }

  private populationTip(): HTMLElement {
    const p = this.ui.data.population();
    const hs = this.ui.data.housing();
    const rows: TipRow[] = [
      { label: 'Adults', value: fmtInt(p.adults), icon: ICON.people },
      { label: 'Elderly', value: fmtInt(p.elderly), icon: ICON.elderly },
      { label: 'Students', value: fmtInt(p.students), icon: ICON.student },
      { label: 'Children', value: fmtInt(p.children), icon: ICON.child },
      { label: 'Laborers', value: fmtInt(p.laborers) },
      { label: 'Builders', value: fmtInt(p.builders) },
      { label: 'Homes', value: `${fmtInt(hs.houses)} (${fmtInt(hs.emptyHouses)} empty)`, icon: ICON.house },
    ];
    if (p.homeless > 0) rows.push({ label: 'Homeless', value: fmtInt(p.homeless), icon: ICON.homeless, tone: 'bad' });
    if (p.sick > 0) rows.push({ label: 'Sick', value: fmtInt(p.sick), icon: ICON.sick, tone: 'warn' });
    return richTip({ title: `Population: ${fmtInt(p.total)}`, rows, note: 'Click for the citizens list [N]', noteTone: 'dim' });
  }
}
