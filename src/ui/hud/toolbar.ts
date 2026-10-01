/**
 * Bottom toolbar: build categories with flyout grids (icon, name, cost, affordability, rich tooltips), road / clear
 * / demolish tools, the active-tool hint, and the window toggle buttons (bottom right).
 */
import type { Tool } from '../../core/app';
import { BUILD_CATEGORIES, BUILDINGS, BUILDING_TYPES, ROAD_DEFS } from '../../core/defs';
import type { BuildCategory, BuildingType, Inventory, RemovalFilter, ResourceType } from '../../core/types';
import type { UIContext, WindowId } from '../context';
import { h, setClass, setText, show } from '../dom';
import { fmtInt } from '../format';
import { ICON } from '../icons';
import { richTip, type TipRow } from '../tooltip';
import { costChips, resIcon, resName } from '../widgets';

type FlyoutId = BuildCategory | 'roads' | 'clear';

interface FlyItem {
  el: HTMLButtonElement;
  tool: Tool;
  /** Buildings only: cost check. */
  type?: BuildingType;
  cost?: HTMLElement;
}

const WINDOW_BUTTONS: { id: WindowId; icon: string; name: string; key: string }[] = [
  { id: 'professions', icon: ICON.professions, name: 'Professions', key: 'P' },
  { id: 'overview', icon: ICON.overview, name: 'Town Overview', key: 'O' },
  { id: 'citizens', icon: ICON.citizens, name: 'Citizens', key: 'N' },
  { id: 'log', icon: ICON.log, name: 'Event Log', key: 'L' },
  { id: 'stats', icon: ICON.stats, name: 'Statistics', key: 'K' },
  { id: 'help', icon: ICON.help, name: 'Help & Controls', key: 'H' },
  // co-op: shown only while a room is available (see setCoopVisible)
  { id: 'players', icon: '👥', name: 'Players & chat', key: 'J' },
];

const CLEAR_ITEMS: { filter: RemovalFilter; name: string; icon: string; desc: string; key?: string }[] = [
  { filter: 'all', name: 'Clear All', icon: '🪓', desc: 'Mark trees, rocks and iron in an area. Laborers collect logs, stone and iron.', key: 'C' },
  { filter: 'trees', name: 'Clear Trees', icon: '🌲', desc: 'Mark only trees for cutting (logs).' },
  { filter: 'stone', name: 'Clear Stone', icon: '🪨', desc: 'Mark only rocks for collection (stone).' },
  { filter: 'iron', name: 'Clear Iron', icon: '⛓️', desc: 'Mark only iron deposits for collection.' },
];

export function toolKey(t: Tool): string {
  switch (t.kind) {
    case 'build': return `build:${t.type}`;
    case 'road': return `road:${t.road}`;
    case 'clear': return `clear:${t.filter}`;
    default: return t.kind;
  }
}

function toolGroup(t: Tool): FlyoutId | 'demolish' | null {
  switch (t.kind) {
    case 'build': return BUILDINGS[t.type].category;
    case 'road':
    case 'removeRoad': return 'roads';
    case 'clear':
    case 'unclear': return 'clear';
    case 'demolish': return 'demolish';
    default: return null;
  }
}

/** Effective construction cost for affordability checks (per-tile costs use the minimum zone size). */
function effectiveCost(type: BuildingType): { cost: Inventory; mult: number } {
  const def = BUILDINGS[type];
  if (def.costPerTile) {
    const min = def.resizable?.min ?? Math.min(def.size[0], def.size[1]);
    return { cost: def.cost, mult: min * min };
  }
  return { cost: def.cost, mult: 1 };
}

export class Toolbar {
  readonly el: HTMLElement;
  readonly windowsEl: HTMLElement;
  readonly flyoutEl: HTMLElement;
  readonly hintEl: HTMLElement;
  private groupBtns = new Map<FlyoutId | 'demolish', HTMLButtonElement>();
  private flyouts = new Map<FlyoutId, { el: HTMLElement; items: FlyItem[] }>();
  private openFly: FlyoutId | null = null;
  private tool: Tool = { kind: 'select' };
  private winBtns = new Map<WindowId, HTMLButtonElement>();
  private hintText: HTMLElement;
  private hintIcon: HTMLElement;

  constructor(private readonly ui: UIContext) {
    const bar = h('nav', { class: 'toolbar', 'aria-label': 'Build tools' });

    for (const cat of BUILD_CATEGORIES) {
      bar.appendChild(this.groupButton(cat.id, cat.icon, cat.name.split(' ')[0], cat.name));
      this.flyouts.set(cat.id, this.buildCategoryFlyout(cat.id, cat.name));
    }
    bar.appendChild(h('span', { class: 'tb-sep', 'aria-hidden': 'true' }));
    bar.appendChild(this.groupButton('roads', ICON.road, 'Roads', 'Roads & bridges'));
    this.flyouts.set('roads', this.buildRoadsFlyout());
    bar.appendChild(this.groupButton('clear', ICON.clear, 'Clear', 'Clear trees, rocks & iron'));
    this.flyouts.set('clear', this.buildClearFlyout());
    const demo = this.groupButton('demolish', ICON.demolish, 'Demolish', 'Demolish buildings');
    bar.appendChild(demo);

    this.flyoutEl = h('div', { class: 'flyout-host' });
    for (const f of this.flyouts.values()) {
      f.el.hidden = true;
      this.flyoutEl.appendChild(f.el);
    }

    this.hintIcon = h('span', { class: 'hint-i', 'aria-hidden': 'true' });
    this.hintText = h('span', { class: 'hint-t' });
    this.hintEl = h('div', { class: 'tool-hint', role: 'status' },
      this.hintIcon, this.hintText,
      h('button', { class: 'hint-x', type: 'button', 'aria-label': 'Cancel tool', tip: 'Cancel [Esc / right-click]', onclick: () => this.setToolFromUI({ kind: 'select' }) }, ICON.close));
    this.hintEl.hidden = true;

    this.el = h('div', { class: 'toolbar-wrap' }, this.hintEl, this.flyoutEl, bar);

    // windows cluster
    this.windowsEl = h('nav', { class: 'winbar', 'aria-label': 'Windows' });
    for (const w of WINDOW_BUTTONS) {
      const b = h('button', {
        class: 'win-btn', type: 'button', 'aria-label': w.name, 'aria-pressed': 'false', tip: `${w.name} [${w.key}]`,
        onclick: () => ui.toggleWindow(w.id),
      }, h('span', { 'aria-hidden': 'true' }, w.icon), h('span', { class: 'win-key', 'aria-hidden': 'true' }, w.key));
      this.winBtns.set(w.id, b);
      this.windowsEl.appendChild(b);
    }
    this.setCoopVisible(false);

    // clicking anywhere outside the toolbar closes an open flyout
    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
  }

  private onWindowPointerDown = (e: PointerEvent): void => {
    if (!this.openFly) return;
    const t = e.target as Node | null;
    if (t && this.el.contains(t)) return;
    this.closeFlyout();
  };

  dispose(): void {
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
  }

  // ---- construction helpers ----

  private groupButton(id: FlyoutId | 'demolish', icon: string, label: string, name: string): HTMLButtonElement {
    const isFly = id !== 'demolish';
    const b = h('button', {
      class: 'tool-btn', type: 'button', 'aria-label': name, 'aria-haspopup': isFly ? 'true' : null, 'aria-expanded': isFly ? 'false' : null,
      onclick: () => {
        if (id === 'demolish') {
          this.closeFlyout();
          this.setToolFromUI(this.tool.kind === 'demolish' ? { kind: 'select' } : { kind: 'demolish' });
        } else this.toggleFlyout(id);
      },
    }, h('span', { class: 'tool-i', 'aria-hidden': 'true' }, icon), h('span', { class: 'tool-l' }, label));
    this.ui.tips.set(b, id === 'demolish' ? 'Demolish — click a building to tear it down (returns some materials)' : name);
    this.groupBtns.set(id, b);
    return b;
  }

  private flyout(title: string, cls = ''): { el: HTMLElement; grid: HTMLElement } {
    const grid = h('div', { class: `fly-grid ${cls}` });
    const el = h('div', { class: 'flyout panel', role: 'menu', 'aria-label': title }, h('div', { class: 'fly-title' }, title), grid);
    return { el, grid };
  }

  private buildCategoryFlyout(cat: BuildCategory, title: string): { el: HTMLElement; items: FlyItem[] } {
    const { el, grid } = this.flyout(title);
    const items: FlyItem[] = [];
    for (const type of BUILDING_TYPES) {
      const def = BUILDINGS[type];
      if (def.category !== cat) continue;
      const cost = h('span', { class: 'fly-cost' });
      const btn = h('button', {
        class: 'fly-item', type: 'button', role: 'menuitem', 'aria-label': def.name,
        onclick: () => this.pick({ kind: 'build', type }, btn),
      },
      h('span', { class: 'fly-i', 'aria-hidden': 'true' }, def.icon),
      h('span', { class: 'fly-text' }, h('span', { class: 'fly-name' }, def.name), cost));
      this.ui.tips.set(btn, () => this.buildingTip(type));
      grid.appendChild(btn);
      items.push({ el: btn, tool: { kind: 'build', type }, type, cost });
    }
    return { el, items };
  }

  private buildRoadsFlyout(): { el: HTMLElement; items: FlyItem[] } {
    const { el, grid } = this.flyout('Roads', 'narrow');
    const items: FlyItem[] = [];
    const mk = (tool: Tool, icon: string, name: string, costText: string, tip: HTMLElement | string) => {
      const btn = h('button', { class: 'fly-item', type: 'button', role: 'menuitem', 'aria-label': name, onclick: () => this.pick(tool, btn) },
        h('span', { class: 'fly-i', 'aria-hidden': 'true' }, icon),
        h('span', { class: 'fly-text' }, h('span', { class: 'fly-name' }, name), h('span', { class: 'fly-cost' }, h('span', { class: 'cost-free' }, costText))));
      this.ui.tips.set(btn, () => tip);
      grid.appendChild(btn);
      items.push({ el: btn, tool });
    };
    const bridge = `Bridges over shallow water cost ${fmtInt(ROAD_DEFS.bridge.cost.log ?? 0)} ${resIcon('log')} + ${fmtInt(ROAD_DEFS.bridge.cost.stone ?? 0)} ${resIcon('stone')} per tile.`;
    mk({ kind: 'road', road: 'dirt' }, '🟫', ROAD_DEFS.dirt.name, 'Free',
      richTip({ title: ROAD_DEFS.dirt.name, desc: `${ROAD_DEFS.dirt.description} Drag to lay a road.`, rows: [{ label: 'Cost', value: 'Free' }, { label: 'Hotkey', value: 'V' }], note: bridge, noteTone: 'dim' }));
    mk({ kind: 'road', road: 'stone' }, '⬜', ROAD_DEFS.stone.name, `1 ${resIcon('stone')} / tile`,
      richTip({ title: ROAD_DEFS.stone.name, desc: `${ROAD_DEFS.stone.description} Drag to lay a road.`, rows: [{ label: 'Cost', value: `1 ${resName('stone')} per tile` }], note: bridge, noteTone: 'dim' }));
    mk({ kind: 'removeRoad' }, ICON.removeRoad, 'Remove Road', 'Drag an area',
      richTip({ title: 'Remove Road', desc: 'Drag over an area to remove roads and bridges.' }));
    return { el, items };
  }

  private buildClearFlyout(): { el: HTMLElement; items: FlyItem[] } {
    const { el, grid } = this.flyout('Clear & gather', 'narrow');
    const items: FlyItem[] = [];
    const mk = (tool: Tool, icon: string, name: string, desc: string, key?: string) => {
      const btn = h('button', { class: 'fly-item', type: 'button', role: 'menuitem', 'aria-label': name, onclick: () => this.pick(tool, btn) },
        h('span', { class: 'fly-i', 'aria-hidden': 'true' }, icon),
        h('span', { class: 'fly-text' }, h('span', { class: 'fly-name' }, name), h('span', { class: 'fly-cost' }, h('span', { class: 'cost-free' }, key ? `Hotkey ${key}` : 'Drag an area'))));
      this.ui.tips.set(btn, () => richTip({ title: name, desc, note: 'Drag over an area on the map.', noteTone: 'dim' }));
      grid.appendChild(btn);
      items.push({ el: btn, tool });
    };
    for (const c of CLEAR_ITEMS) mk({ kind: 'clear', filter: c.filter }, c.icon, c.name, c.desc, c.key);
    mk({ kind: 'unclear' }, ICON.unclear, 'Unmark', 'Remove clearing marks from an area.');
    return { el, items };
  }

  // ---- behaviour ----

  private pick(tool: Tool, btn: HTMLButtonElement): void {
    if (btn.classList.contains('unaffordable')) {
      this.ui.sound('error');
      if (tool.kind === 'build') this.ui.toast(`Not enough materials for a ${BUILDINGS[tool.type].name}`, 'warning', { silent: true });
      return;
    }
    this.setToolFromUI(tool);
    this.closeFlyout();
  }

  private setToolFromUI(tool: Tool): void {
    this.ui.sound('click');
    this.ui.app.setTool(tool);
  }

  toggleFlyout(id: FlyoutId): void {
    if (this.openFly === id) this.closeFlyout();
    else this.openFlyout(id);
  }

  openFlyout(id: FlyoutId): void {
    if (this.openFly) this.flyouts.get(this.openFly)!.el.hidden = true;
    this.openFly = id;
    const f = this.flyouts.get(id)!;
    f.el.hidden = false;
    this.ui.sound('click');
    this.refreshAffordability();
    this.syncGroupButtons();
    // position the flyout above its button, clamped to the viewport
    const btn = this.groupBtns.get(id)!;
    const br = btn.getBoundingClientRect();
    const hostR = this.flyoutEl.getBoundingClientRect();
    const fw = f.el.offsetWidth;
    let left = br.left + br.width / 2 - fw / 2 - hostR.left;
    const minLeft = 8 - hostR.left;
    const maxLeft = window.innerWidth - 8 - fw - hostR.left;
    left = Math.max(minLeft, Math.min(maxLeft, left));
    f.el.style.left = `${Math.round(left)}px`;
  }

  /** Returns true if a flyout was open. */
  closeFlyout(): boolean {
    if (!this.openFly) return false;
    this.flyouts.get(this.openFly)!.el.hidden = true;
    this.openFly = null;
    this.syncGroupButtons();
    return true;
  }

  isFlyoutOpen(): boolean {
    return this.openFly !== null;
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    const key = toolKey(tool);
    for (const f of this.flyouts.values()) for (const it of f.items) setClass(it.el, 'on', toolKey(it.tool) === key);
    this.syncGroupButtons();
    this.updateHint();
  }

  private syncGroupButtons(): void {
    const active = toolGroup(this.tool);
    for (const [id, b] of this.groupBtns) {
      setClass(b, 'on', id === active);
      setClass(b, 'open', id === this.openFly);
      if (id !== 'demolish') b.setAttribute('aria-expanded', id === this.openFly ? 'true' : 'false');
    }
  }

  private updateHint(): void {
    const t = this.tool;
    let icon = '';
    let text = '';
    switch (t.kind) {
      case 'build': {
        const def = BUILDINGS[t.type];
        icon = def.icon;
        text = def.resizable
          ? `${def.name} — click, or drag to set the size (${def.resizable.min}–${def.resizable.max} tiles)`
          : `${def.name} — click to place · R to rotate`;
        break;
      }
      case 'road':
        icon = t.road === 'dirt' ? '🟫' : '⬜';
        text = `${ROAD_DEFS[t.road].name} — drag to lay a path`;
        break;
      case 'removeRoad':
        icon = ICON.removeRoad;
        text = 'Remove roads — drag over an area';
        break;
      case 'clear': {
        const c = CLEAR_ITEMS.find((x) => x.filter === t.filter)!;
        icon = c.icon;
        text = `${c.name} — drag over an area to mark for removal`;
        break;
      }
      case 'unclear':
        icon = ICON.unclear;
        text = 'Unmark — drag over an area to cancel clearing';
        break;
      case 'demolish':
        icon = ICON.demolish;
        text = 'Demolish — click a building';
        break;
      default:
        break;
    }
    setText(this.hintIcon, icon);
    setText(this.hintText, text);
    show(this.hintEl, t.kind !== 'select');
  }

  /** Show the Players button (co-op room available). */
  setCoopVisible(visible: boolean): void {
    const b = this.winBtns.get('players');
    if (b) show(b, visible);
  }

  /** Mark the Players button (e.g. unread chat while the window is closed). */
  setPlayersBadge(on: boolean): void {
    const b = this.winBtns.get('players');
    if (b) setClass(b, 'badge-dot', on);
  }

  setWindowOpen(id: WindowId, open: boolean): void {
    const b = this.winBtns.get(id);
    if (!b) return;
    setClass(b, 'on', open);
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  /** Periodic refresh: affordability of the open flyout. */
  refresh(): void {
    if (this.openFly) this.refreshAffordability();
  }

  private refreshAffordability(): void {
    if (!this.openFly) return;
    const f = this.flyouts.get(this.openFly)!;
    const have = this.ui.data.totals();
    for (const it of f.items) {
      if (!it.type || !it.cost) continue;
      const def = BUILDINGS[it.type];
      const { cost, mult } = effectiveCost(it.type);
      const ok = this.ui.data.canAfford(cost, mult);
      setClass(it.el, 'unaffordable', !ok);
      it.el.setAttribute('aria-disabled', ok ? 'false' : 'true');
      // rebuild cost chips only when affordability of any resource changed
      const sig = shortageSignature(cost, have, mult);
      if (it.cost.dataset.sig !== sig) {
        it.cost.dataset.sig = sig;
        it.cost.replaceChildren(costChips(cost, have, mult, def.costPerTile ? '/tile' : ''));
      }
    }
  }

  private buildingTip(type: BuildingType): HTMLElement {
    const def = BUILDINGS[type];
    const have = this.ui.data.totals();
    const { cost, mult } = effectiveCost(type);
    const rows: TipRow[] = [];
    let short = false;
    for (const k in cost) {
      const r = k as ResourceType;
      const need = (cost[r] ?? 0) * mult;
      if (!need) continue;
      const lacking = have[r] + 1e-6 < need;
      if (lacking) short = true;
      rows.push({ label: resName(r), icon: resIcon(r), value: `${fmtInt(need)}${def.costPerTile ? ` (${fmtInt(cost[r] ?? 0)}/tile)` : ''}  · have ${fmtInt(have[r])}`, tone: lacking ? 'bad' : '' });
    }
    if (!rows.length) rows.push({ label: 'Cost', value: 'Free' });
    const size = def.resizable ? `${def.resizable.min}–${def.resizable.max} per side (drag)` : `${def.size[0]} × ${def.size[1]}`;
    rows.push({ label: 'Size', value: size, tone: 'dim' });
    if (def.maxWorkers > 0) rows.push({ label: 'Workers', value: `up to ${def.maxWorkers}`, tone: 'dim' });
    if (def.housing) rows.push({ label: 'Residents', value: `up to ${def.housing}`, tone: 'dim' });
    if (def.storage) rows.push({ label: 'Storage', value: `${fmtInt(def.storage.capacity)}${def.storage.perTile ? ' per tile' : ''}`, tone: 'dim' });
    if (def.workRadius) rows.push({ label: 'Work radius', value: `${def.workRadius} tiles`, tone: 'dim' });
    let note: string | undefined;
    let tone: 'bad' | 'dim' | 'warn' = 'dim';
    if (short) {
      note = 'Not enough materials in storage.';
      tone = 'bad';
    } else if (def.placement === 'shore') {
      note = 'Must be built on the water\'s edge.';
      tone = 'warn';
    } else if (def.placement === 'mountain') {
      note = 'Must be built against a mountain.';
      tone = 'warn';
    }
    return richTip({ title: def.name, icon: def.icon, desc: def.description, rows, note, noteTone: tone });
  }
}

function shortageSignature(cost: Inventory, have: Record<ResourceType, number>, mult: number): string {
  let s = '';
  for (const k in cost) {
    const r = k as ResourceType;
    s += have[r] + 1e-6 < (cost[r] ?? 0) * mult ? '1' : '0';
  }
  return s;
}
