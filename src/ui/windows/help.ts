/**
 * Help window (H) and the shared controls reference (also shown in the main menu).
 */
import type { UIContext } from '../context';
import { h } from '../dom';
import { ICON } from '../icons';
import { UIWindow } from './window';

const CONTROLS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Camera',
    rows: [
      ['W A S D / Arrows', 'Pan the camera'],
      ['Right-drag / Middle-drag', 'Pan / rotate the view'],
      ['Q / E', 'Rotate the view'],
      ['Mouse wheel / = −', 'Zoom in and out'],
      ['Home', 'Return to the town'],
    ],
  },
  {
    title: 'Building',
    rows: [
      ['Left click', 'Select, or use the current tool'],
      ['Right click / Esc', 'Cancel the tool, then deselect'],
      ['R', 'Rotate the building being placed'],
      ['Drag', 'Size zones (fields, pastures, stockpiles), lay roads, mark areas'],
      ['V', 'Dirt road tool'],
      ['C', 'Clear tool (trees, rocks, iron)'],
      ['Delete', 'Demolish the selected building'],
      ['G', 'Toggle the tile grid'],
    ],
  },
  {
    title: 'Time',
    rows: [
      ['Space', 'Pause / resume'],
      ['1  2  3  4', 'Speed 1×, 2×, 5×, 10×'],
    ],
  },
  {
    title: 'Windows',
    rows: [
      ['P', 'Professions'],
      ['O', 'Town overview'],
      ['N', 'Citizens'],
      ['L', 'Event log'],
      ['K', 'Statistics'],
      ['H', 'Help'],
      ['J', 'Players & chat (co-op)'],
      ['Enter', 'Chat with the other players (co-op)'],
      ['Esc', 'Close windows / open the menu'],
    ],
  },
];

const TIPS: [string, string][] = [
  ['🪵', 'Assign builders and laborers early: clear trees and rocks around the start to gather logs and stone.'],
  ['🔥', 'Winter is deadly. Build a woodcutter and keep a large stock of firewood before the first snow.'],
  ['🌾', 'Food first: gatherers and hunters near forests, fishing docks on water, then fields. Harvest before frost.'],
  ['🏠', 'Homes let families grow. Children only become workers after 10 years — plan ahead.'],
  ['⚒️', 'Workers without tools work at half speed. A blacksmith turns iron and logs into tools.'],
  ['🧥', 'Coats keep people warm outdoors. Tailors sew them from leather (hunters) or wool (sheep).'],
  ['🌿', 'A varied diet, herbs, wells and a hospital keep people healthy. Chapels and taverns keep them happy.'],
  ['⛵', 'A trading post attracts merchants who sell food, goods, seeds and livestock you cannot produce.'],
];

export function controlsReference(): HTMLElement {
  const wrap = h('div', { class: 'controls-ref' });
  for (const g of CONTROLS) {
    const tbl = h('div', { class: 'ctl-grid' });
    for (const [k, v] of g.rows) {
      tbl.appendChild(h('span', { class: 'ctl-keys' }, ...k.split(' / ').flatMap((part, i) => [i ? h('span', { class: 'ctl-or' }, 'or') : null, h('kbd', {}, part)])));
      tbl.appendChild(h('span', { class: 'ctl-desc' }, v));
    }
    wrap.appendChild(h('div', { class: 'ctl-group' }, h('h4', { class: 'sec-h' }, g.title), tbl));
  }
  return wrap;
}

export function tipsReference(): HTMLElement {
  const list = h('ul', { class: 'tips-list' });
  for (const [icon, text] of TIPS) list.appendChild(h('li', {}, h('span', { class: 'tips-i', 'aria-hidden': 'true' }, icon), h('span', {}, text)));
  return list;
}

export class HelpWindow extends UIWindow {
  private tab: 'tips' | 'controls' = 'tips';
  private tabs = new Map<string, HTMLButtonElement>();
  private panes = new Map<string, HTMLElement>();

  constructor(ui: UIContext) {
    super(ui, { id: 'help', title: 'Help & Controls', icon: ICON.help, width: 56, hotkey: 'H', className: 'w-help' });
  }

  protected build(): void {
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const mk = (id: 'tips' | 'controls', label: string, pane: HTMLElement) => {
      const b = h('button', { class: 'tab', type: 'button', role: 'tab', onclick: () => this.show(id) }, label);
      this.tabs.set(id, b);
      this.panes.set(id, pane);
      tabs.appendChild(b);
    };
    const intro = h('p', { class: 'help-intro' },
      'A group of exiles has settled in an untamed valley with only the clothes on their backs and a few supplies. ',
      'Keep them fed, warm, healthy and happy — and help the town grow for generations.');
    mk('tips', 'Survival guide', h('div', {}, intro, tipsReference()));
    mk('controls', 'Controls', controlsReference());
    this.body.appendChild(tabs);
    for (const p of this.panes.values()) this.body.appendChild(p);
    this.show(this.tab);
  }

  private show(id: 'tips' | 'controls'): void {
    this.tab = id;
    for (const [k, b] of this.tabs) {
      b.classList.toggle('on', k === id);
      b.setAttribute('aria-selected', String(k === id));
    }
    for (const [k, p] of this.panes) p.hidden = k !== id;
  }
}
