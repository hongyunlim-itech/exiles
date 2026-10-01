/**
 * Statistics window (K): canvas line charts from `state.history` (monthly samples) — population, food & fuel,
 * materials & goods, wellbeing, births & deaths — with range selection and series toggles.
 */
import type { StatsSample } from '../../core/types';
import type { UIContext } from '../context';
import { h, setClass } from '../dom';
import { fmtCompact } from '../format';
import { ICON } from '../icons';
import { LineChart, type ChartSeries } from './chart';
import { UIWindow } from './window';

type TabId = 'population' | 'food' | 'materials' | 'wellbeing' | 'vital';

interface SeriesDef {
  key: keyof StatsSample;
  label: string;
  color: string;
  /** Multiply values (e.g. education 0..1 → %). 'auto100' scales 0..1 data to percent. */
  scale?: number | 'auto100';
  hidden?: boolean;
}

const C = {
  gold: '#e0b252', green: '#8fc45a', blue: '#6fa8dc', red: '#e06a52', purple: '#b58ad8', teal: '#5cc0b0',
  orange: '#e8964a', pink: '#d77fa1', sand: '#d8cfb8', brown: '#b08058', slate: '#9aa6b2',
};

const TABS: { id: TabId; label: string; series: SeriesDef[]; percent?: boolean }[] = [
  {
    id: 'population', label: 'Population', series: [
      { key: 'population', label: 'Total', color: C.gold },
      { key: 'adults', label: 'Adults', color: C.green },
      { key: 'children', label: 'Children', color: C.blue },
      { key: 'students', label: 'Students', color: C.purple },
      { key: 'elderly', label: 'Elderly', color: C.sand },
    ],
  },
  {
    id: 'food', label: 'Food & fuel', series: [
      { key: 'food', label: 'Food', color: C.gold },
      { key: 'firewood', label: 'Firewood', color: C.orange },
      { key: 'herbs', label: 'Herbs', color: C.green, hidden: true },
    ],
  },
  {
    id: 'materials', label: 'Materials', series: [
      { key: 'logs', label: 'Logs', color: C.brown },
      { key: 'stone', label: 'Stone', color: C.slate },
      { key: 'iron', label: 'Iron', color: C.red },
      { key: 'tools', label: 'Tools', color: C.blue },
      { key: 'clothing', label: 'Coats', color: C.purple },
      { key: 'ale', label: 'Ale', color: C.gold, hidden: true },
    ],
  },
  {
    id: 'wellbeing', label: 'Wellbeing', percent: true, series: [
      { key: 'avgHealth', label: 'Health', color: C.red },
      { key: 'avgHappiness', label: 'Happiness', color: C.gold },
      { key: 'avgEducation', label: 'Education', color: C.blue, scale: 'auto100' },
    ],
  },
  {
    id: 'vital', label: 'Births & deaths', series: [
      { key: 'births', label: 'Births', color: C.green },
      { key: 'deaths', label: 'Deaths', color: C.red },
    ],
  },
];

const RANGES: { id: number; label: string }[] = [
  { id: 24, label: '2 years' },
  { id: 120, label: '10 years' },
  { id: 0, label: 'All' },
];

export class StatisticsWindow extends UIWindow {
  private chart!: LineChart;
  private tab: TabId = 'population';
  private range = 120;
  private tabBtns = new Map<TabId, HTMLButtonElement>();
  private rangeBtns = new Map<number, HTMLButtonElement>();
  private legend!: HTMLElement;
  private hidden = new Set<string>();
  private key = '';

  constructor(ui: UIContext) {
    super(ui, { id: 'stats', title: 'Statistics', icon: ICON.stats, width: 66, hotkey: 'K', className: 'w-stats' });
    for (const t of TABS) for (const s of t.series) if (s.hidden) this.hidden.add(`${t.id}.${String(s.key)}`);
  }

  protected build(): void {
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    for (const t of TABS) {
      const b = h('button', {
        class: 'tab', type: 'button', role: 'tab',
        onclick: () => {
          this.tab = t.id;
          this.sync(true);
        },
      }, t.label);
      this.tabBtns.set(t.id, b);
      tabs.appendChild(b);
    }
    const ranges = h('div', { class: 'seg small', role: 'radiogroup', 'aria-label': 'Time range' });
    for (const r of RANGES) {
      const b = h('button', {
        class: 'seg-btn', type: 'button', role: 'radio',
        onclick: () => {
          this.range = r.id;
          this.sync(true);
        },
      }, r.label);
      this.rangeBtns.set(r.id, b);
      ranges.appendChild(b);
    }
    this.chart = new LineChart();
    this.legend = h('div', { class: 'legend' });
    this.body.append(tabs, this.chart.el, h('div', { class: 'stats-bottom' }, this.legend, ranges));
  }

  protected override onOpen(): void {
    this.key = '';
  }

  override refresh(): void {
    if (!this.chart) return;
    const hist = this.ui.game.state.history;
    const last = hist.length ? hist[hist.length - 1] : null;
    const key = `${hist.length}:${last ? `${last.year}.${last.month}` : ''}`;
    if (key !== this.key) this.sync(false);
  }

  private sync(uiChanged: boolean): void {
    const hist = this.ui.game.state.history;
    const last = hist.length ? hist[hist.length - 1] : null;
    this.key = `${hist.length}:${last ? `${last.year}.${last.month}` : ''}`;
    for (const [id, b] of this.tabBtns) {
      setClass(b, 'on', id === this.tab);
      b.setAttribute('aria-selected', id === this.tab ? 'true' : 'false');
    }
    for (const [id, b] of this.rangeBtns) setClass(b, 'on', id === this.range);

    const tab = TABS.find((t) => t.id === this.tab)!;
    const samples = this.range > 0 ? hist.slice(-this.range) : hist;
    const series: ChartSeries[] = tab.series.map((sd) => {
      let values = samples.map((s) => Number(s[sd.key]) || 0);
      if (sd.scale === 'auto100') {
        const mx = Math.max(0, ...values);
        if (mx <= 1.5) values = values.map((v) => v * 100);
      } else if (typeof sd.scale === 'number') {
        const k = sd.scale;
        values = values.map((v) => v * k);
      }
      const id = `${tab.id}.${String(sd.key)}`;
      return { key: id, label: sd.label, color: sd.color, values, visible: !this.hidden.has(id) };
    });
    this.chart.setData(samples.map((s) => ({ year: s.year, month: s.month })), series, {
      yFormat: tab.percent ? (v) => `${Math.round(v)}%` : fmtCompact,
    });
    if (uiChanged || this.legend.childElementCount !== series.length) this.buildLegend(series);
  }

  private buildLegend(series: ChartSeries[]): void {
    this.legend.replaceChildren();
    for (const s of series) {
      const b = h('button', {
        class: `legend-item ${s.visible ? 'on' : ''}`, type: 'button', 'aria-pressed': s.visible ? 'true' : 'false',
        tip: s.visible ? `Hide ${s.label}` : `Show ${s.label}`,
        onclick: () => {
          if (this.hidden.has(s.key)) this.hidden.delete(s.key);
          else this.hidden.add(s.key);
          this.sync(true);
        },
      }, h('span', { class: 'legend-sw', style: `background:${s.color}` }), s.label);
      this.legend.appendChild(b);
    }
  }

  override onGameChanged(): void {
    this.key = '';
  }

  override dispose(): void {
    this.chart?.dispose();
    super.dispose();
  }
}
