/**
 * Selection panel content for a building. Built from blocks chosen by building type/state; each block updates its
 * values in place. The whole view is rebuilt only when the building's state or type changes.
 */
import { CROPS, BUILDINGS, LIVESTOCK, ORCHARDS, PROFESSIONS, RESOURCES } from '../../core/defs';
import type { Building, CropType, FieldTile, Inventory, LivestockType, OrchardType, ResourceType } from '../../core/types';
import { Feature } from '../../core/types';
import { buildingCenter } from '../../core/world';
import type { UIContext } from '../context';
import { h, setClass, setDisabled, setText, show } from '../dom';
import { fmtCompact, fmtInt, fmtMonths, pct } from '../format';
import { ICON, MERCHANT_KINDS, STATE_LABELS } from '../icons';
import { pendingKey } from '../pending';
import { offerInfo } from '../windows/trade';
import { Bar, ResourceChips, Segmented, Stepper, iconButton, resIcon, section, toneFor } from '../widgets';

interface Block {
  el: HTMLElement;
  update(b: Building): void;
}

const LIVESTOCK_ICONS: Record<LivestockType, string> = { sheep: '🐑', cattle: '🐄', chicken: '🐔' };

function invSum(inv: Inventory): number {
  let s = 0;
  for (const k in inv) s += inv[k as ResourceType] ?? 0;
  return s;
}

/** Keyed list of citizen links (workers / residents). */
class PeopleList {
  readonly el: HTMLElement;
  private key = '';
  constructor(private readonly ui: UIContext, private readonly detailed: boolean, emptyText: string) {
    this.el = h('div', { class: detailed ? 'people' : 'people compact' });
    this.el.dataset.empty = emptyText;
  }

  update(ids: number[]): void {
    const key = ids.join(',');
    if (key !== this.key) {
      this.key = key;
      this.el.replaceChildren();
      for (const id of ids) {
        const btn = h('button', { class: 'person', type: 'button', onclick: () => this.ui.selectCitizen(id, true) });
        btn.dataset.cid = String(id);
        this.el.appendChild(btn);
      }
      if (!ids.length) this.el.appendChild(h('span', { class: 'people-empty' }, this.el.dataset.empty ?? ''));
    }
    // refresh labels (ages/professions change)
    for (const btn of Array.from(this.el.children) as HTMLElement[]) {
      const id = Number(btn.dataset.cid);
      if (!Number.isFinite(id)) continue;
      const c = this.ui.game.getCitizen(id);
      if (!c) {
        setText(btn, '—');
        continue;
      }
      const p = PROFESSIONS[c.profession];
      const g = c.gender === 'M' ? ICON.male : ICON.female;
      setText(btn, this.detailed ? `${g} ${c.name}, ${Math.floor(c.age)} · ${p.icon} ${p.name}` : `${p.icon} ${c.name.split(' ')[0]}`);
      setClass(btn, 'sick', c.sick > 0);
    }
  }
}

export class BuildingView {
  readonly el: HTMLElement;
  readonly id: number;
  private blocks: Block[] = [];
  private sig: string;

  constructor(private readonly ui: UIContext, b: Building) {
    this.id = b.id;
    this.sig = BuildingView.signature(b);
    this.el = h('div', { class: 'sel-view bld' });
    this.build(b);
  }

  static signature(b: Building): string {
    return `${b.type}|${b.state}`;
  }

  /** Returns false if the building no longer exists or needs a rebuild (caller recreates the view). */
  update(): 'ok' | 'gone' | 'rebuild' {
    const b = this.ui.game.getBuilding(this.id);
    if (!b) return 'gone';
    if (BuildingView.signature(b) !== this.sig) return 'rebuild';
    for (const blk of this.blocks) blk.update(b);
    return 'ok';
  }

  private add(block: Block | null): void {
    if (!block) return;
    this.blocks.push(block);
    this.el.appendChild(block.el);
  }

  private build(b: Building): void {
    const def = BUILDINGS[b.type];
    this.add(this.header(b));
    this.add(this.fireBlock());
    if (b.state === 'clearing' || b.state === 'construction' || b.state === 'demolishing' || b.state === 'ruin') this.add(this.progressBlock(b));
    if (b.state === 'construction' && invSum(b.cost) > 0) this.add(this.materialsBlock());
    if (b.state !== 'ruin') this.add(this.descBlock(b));
    if (b.state === 'ruin' || b.state === 'demolishing') {
      this.add(this.actionsBlock(b));
      this.update();
      return;
    }
    if (def.maxWorkers > 0) this.add(this.workersBlock(b));
    if (b.state === 'active') {
      if (def.housing) this.add(this.residentsBlock(b));
      if (b.type === 'cropField') this.add(this.cropBlock());
      if (b.type === 'orchard') this.add(this.orchardBlock());
      if (b.type === 'pasture') this.add(this.pastureBlock());
      if (def.recipes && def.recipes.length) this.add(this.recipeBlock(b));
      if (b.type === 'tradingPost') this.add(this.tradeBlock());
      if (b.type === 'cemetery') this.add(this.cemeteryBlock());
      if (def.storage) this.add(this.storageBlock(b));
      else if (!def.housing && (def.bufferCapacity || def.stocks)) this.add(this.bufferBlock(b));
      if (def.maxWorkers > 0 && (def.profession && !['teacher', 'priest', 'healer', 'tavernkeeper', 'vendor', 'trader'].includes(def.profession))) this.add(this.productionBlock());
    } else if (def.recipes && def.recipes.length > 1) this.add(this.recipeBlock(b));
    this.add(this.actionsBlock(b));
    this.update();
  }

  // ---- blocks --------------------------------------------------------------------------------

  private header(b: Building): Block {
    const def = BUILDINGS[b.type];
    const state = h('span', { class: 'badge' });
    const paused = h('span', { class: 'badge warn' }, 'Paused');
    const prio = h('span', { class: 'badge gold' }, `${ICON.priority} Priority`);
    const focus = iconButton(ICON.focus, 'Go to building', () => {
      const [x, z] = buildingCenter(b);
      this.ui.app.focusOn(x, z);
    });
    const close = iconButton(ICON.close, 'Close', () => this.ui.app.select(null), { tip: 'Close [Esc]' });
    const el = h('div', { class: 'sel-head' },
      h('span', { class: 'sel-icon', 'aria-hidden': 'true' }, def.icon),
      h('div', { class: 'sel-titles' }, h('h3', { class: 'sel-name' }, def.name), h('div', { class: 'sel-badges' }, state, paused, prio)),
      h('div', { class: 'sel-btns' }, focus, close));
    return {
      el,
      update: (bb) => {
        setText(state, STATE_LABELS[bb.state]);
        state.className = `badge ${bb.state === 'active' ? 'good' : bb.state === 'ruin' ? 'bad' : 'info'}`;
        show(paused, this.effPaused(bb));
        show(prio, this.effPriority(bb) && bb.state !== 'ruin' && bb.state !== 'demolishing');
      },
    };
  }

  private fireBlock(): Block {
    const text = h('span', { class: 'fire-t' });
    const bar = new Bar({ tone: 'bad', label: false });
    const el = h('div', { class: 'fire-banner', role: 'alert' }, h('span', { class: 'fire-i', 'aria-hidden': 'true' }, ICON.fire), h('div', { class: 'fire-body' }, text, bar.el));
    return {
      el,
      update: (b) => {
        show(el, b.fire > 0);
        if (b.fire > 0) {
          bar.set(b.fire);
          setText(text, `On fire! ${b.fireFighters > 0 ? `${b.fireFighters} fighting the blaze` : 'No one is fighting it — build a well nearby'}`);
        }
      },
    };
  }

  private progressBlock(b: Building): Block {
    const bar = new Bar({ tone: b.state === 'demolishing' ? 'warn' : 'gold' });
    const note = h('div', { class: 'sel-note' });
    const el = h('div', { class: 'sel-progress' }, bar.el, note);
    const countFeatures = (bb: Building) => {
      const s = this.ui.game.state;
      let n = 0;
      for (let z = bb.z; z < bb.z + bb.h; z++) {
        for (let x = bb.x; x < bb.x + bb.w; x++) {
          if (x < 0 || z < 0 || x >= s.W || z >= s.H) continue;
          if (s.tiles.feature[z * s.W + x] !== Feature.None) n++;
        }
      }
      return n;
    };
    return {
      el,
      update: (bb) => {
        switch (bb.state) {
          case 'clearing': {
            const n = countFeatures(bb);
            bar.set(0, 'Clearing');
            setText(note, n > 0 ? `Laborers must clear ${n} tree${n === 1 ? '' : 's'} or rock${n === 1 ? '' : 's'} first.` : 'Site cleared — construction will begin shortly.');
            break;
          }
          case 'construction': {
            bar.set(bb.progress, `${pct(bb.progress)} built`);
            const pop = this.ui.data.population();
            const s = this.ui.game.state;
            let msg = '';
            if (bb.paused) msg = 'Construction is paused.';
            else if (s.buildersDesired === 0 && pop.builders === 0) msg = 'No builders assigned! Add builders in the Professions window.';
            else {
              const t = this.ui.data.totals();
              const missing: string[] = [];
              for (const k in bb.cost) {
                const r = k as ResourceType;
                const need = (bb.cost[r] ?? 0) - (bb.delivered[r] ?? 0) - (bb.incoming[r] ?? 0);
                if (need > 0 && t[r] < need) missing.push(`${RESOURCES[r].icon} ${RESOURCES[r].name}`);
              }
              if (missing.length) msg = `Waiting for materials: ${missing.join(', ')}`;
            }
            setText(note, msg);
            setClass(note, 't-warn', !!msg);
            break;
          }
          case 'demolishing':
            bar.set(bb.progress, `${pct(bb.progress)} demolished`);
            setText(note, 'Laborers are tearing it down. Half of the materials will be returned.');
            break;
          case 'ruin':
            bar.set(1, 'Ruins');
            bar.setTone('bad');
            setText(note, 'Burnt-out ruins. Laborers will clear them away.');
            break;
          default:
            break;
        }
        show(note, !!note.textContent);
      },
    };
  }

  private materialsBlock(): Block {
    const chips = new ResourceChips({ className: 'mats' });
    const incoming = h('div', { class: 'sel-note dim' });
    const el = section('Materials delivered', chips.el, incoming);
    return {
      el,
      update: (b) => {
        chips.set(b.delivered, b.cost);
        const inc = invSum(b.incoming);
        setText(incoming, inc > 0 ? `${fmtInt(inc)} more on the way` : '');
        show(incoming, inc > 0);
      },
    };
  }

  private descBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const extra = h('div', { class: 'sel-note dim' });
    const lines: string[] = [];
    if (def.workRadius) lines.push(`Work area: ${def.workRadius} tiles around the building.`);
    const el = h('div', { class: 'sel-desc' }, h('p', {}, def.description), lines.length ? h('p', { class: 'sel-note dim' }, lines.join(' ')) : null, extra);
    return {
      el,
      update: (bb) => {
        const s = this.ui.game.state;
        let t = '';
        switch (bb.type) {
          case 'school': {
            const students = this.ui.data.population().students;
            t = bb.workerIds.length ? `${fmtInt(students)} students in town.` : 'No teacher — children will not study.';
            break;
          }
          case 'hospital': {
            const herbs = bb.inventory.herbs ?? 0;
            t = `${fmtInt(this.ui.data.population().sick)} citizens sick · ${fmtInt(herbs)} herbs stocked.${bb.workerIds.length ? '' : ' No healer!'}`;
            break;
          }
          case 'chapel':
            t = bb.workerIds.length ? 'The priest lifts spirits of families nearby.' : 'No priest — the chapel stands empty.';
            break;
          case 'tavern':
            t = `${fmtInt(bb.inventory.ale ?? 0)} ale in stock.${(bb.inventory.ale ?? 0) < 1 ? ' Ale is brewed at a brewery.' : ''}`;
            break;
          case 'townHall': {
            const n = s.nomads;
            t = n ? `${n.count} nomads are waiting outside!` : `Nomads may arrive every year or two. ${fmtInt(s.history.length ? s.history[s.history.length - 1].population : s.citizens.length)} citizens last month.`;
            break;
          }
          case 'well':
            t = 'Homes nearby are healthier; townsfolk fight fires with its water.';
            break;
          default:
            break;
        }
        setText(extra, t);
        show(extra, !!t);
      },
    };
  }

  private workersBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const prof = def.profession ? PROFESSIONS[def.profession] : null;
    const stepper = new Stepper({
      decLabel: 'Fewer workers', incLabel: 'More workers',
      onStep: (d) => {
        const cur = this.ui.game.getBuilding(this.id);
        if (!cur) return;
        const key = pendingKey.workers(this.id);
        const base = this.ui.pending.get(key, cur.workersDesired);
        const n = Math.max(0, Math.min(def.maxWorkers, base + d));
        if (n === base) {
          this.ui.sound('error');
          return;
        }
        const res = this.ui.dispatch({ op: 'workers', id: this.id, n });
        if (!res.ok) return;
        if (res.pending) this.ui.pending.set(key, n);
        this.ui.sound('click');
        this.update();
      },
    });
    const status = h('span', { class: 'wk-status' });
    const list = new PeopleList(this.ui, false, 'No workers yet.');
    const title = `${prof ? `${prof.icon} ${prof.name}s` : 'Workers'}`;
    const el = section(title, h('div', { class: 'wk-row' }, stepper.el, status), list.el);
    return {
      el,
      update: (bb) => {
        const desired = this.ui.pending.get(pendingKey.workers(bb.id), bb.workersDesired);
        stepper.set(`${desired} / ${def.maxWorkers}`, desired > 0, desired < def.maxWorkers);
        setClass(stepper.el, 'pending', desired !== bb.workersDesired);
        const free = this.ui.data.professions().laborer;
        const assigned = bb.workerIds.length;
        let text: string;
        if (bb.state !== 'active') text = 'Workers will start when built.';
        else if (assigned < bb.workersDesired) text = `${assigned} working · ${free > 0 ? `${free} laborers free` : 'no free laborers!'}`;
        else text = `${assigned} working`;
        setText(status, text);
        setClass(status, 't-warn', bb.state === 'active' && assigned < bb.workersDesired && free === 0);
        list.update(bb.workerIds);
      },
    };
  }

  private residentsBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const count = h('span', { class: 'sec-aside' });
    const list = new PeopleList(this.ui, true, 'Nobody lives here yet.');
    const food = h('span', { class: 'hh-v' });
    const wood = h('span', { class: 'hh-v' });
    const herbs = h('span', { class: 'hh-v' });
    const heat = h('span', { class: 'hh-heat' });
    const household = h('div', { class: 'household' },
      h('span', { class: 'hh', tip: 'Food at home' }, h('span', { class: 'hh-i' }, ICON.food), food),
      h('span', { class: 'hh', tip: 'Firewood at home' }, h('span', { class: 'hh-i' }, resIcon('firewood')), wood),
      h('span', { class: 'hh', tip: 'Herbs at home' }, h('span', { class: 'hh-i' }, resIcon('herbs')), herbs),
      heat);
    const el = section('Residents', list.el, household);
    el.querySelector('.sec-h')?.appendChild(count);
    const kind = def.familyHome ? '' : ' · singles only';
    return {
      el,
      update: (bb) => {
        setText(count, `${bb.residentIds.length} / ${def.housing ?? 0}${kind}`);
        list.update(bb.residentIds);
        let f = 0;
        for (const k in bb.inventory) {
          const r = k as ResourceType;
          if (RESOURCES[r]?.category === 'food') f += bb.inventory[r] ?? 0;
        }
        setText(food, fmtInt(f));
        setText(wood, fmtInt(bb.inventory.firewood ?? 0));
        setText(herbs, fmtInt(bb.inventory.herbs ?? 0));
        const cold = this.ui.game.state.weather.temperature < 8;
        setText(heat, bb.smoking ? '🔥 Heated' : cold ? '❄ Cold' : '');
        setClass(heat, 't-bad', !bb.smoking && cold && bb.residentIds.length > 0);
        setClass(heat, 't-good', bb.smoking);
      },
    };
  }

  private storageBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const bar = new Bar({ tone: 'gold' });
    const chips = new ResourceChips({ empty: 'Nothing stored yet.' });
    const kinds = def.storage!.kinds.map((k) => (k === 'barn' ? 'food & goods' : 'raw materials')).join(', ');
    const el = section('Storage', h('div', { class: 'sel-note dim' }, `Holds ${kinds}.`), bar.el, chips.el);
    const cap = def.storage!.perTile ? def.storage!.capacity * b.w * b.h : def.storage!.capacity;
    return {
      el,
      update: (bb) => {
        const used = invSum(bb.inventory);
        const f = cap > 0 ? used / cap : 0;
        bar.set(f, `${fmtCompact(used)} / ${fmtCompact(cap)}`, f > 0.92 ? 'bad' : f > 0.75 ? 'warn' : 'gold');
        chips.set(bb.inventory);
      },
    };
  }

  private bufferBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const chips = new ResourceChips({ empty: 'Empty.' });
    const bar = new Bar({ tone: 'info' });
    const title = def.stocks ? 'Supplies' : 'Output waiting for pickup';
    const el = section(title, def.bufferCapacity ? bar.el : null, chips.el);
    return {
      el,
      update: (bb) => {
        if (def.bufferCapacity) {
          const used = invSum(bb.inventory);
          const f = used / def.bufferCapacity;
          bar.set(f, `${fmtInt(used)} / ${fmtInt(def.bufferCapacity)}`, f > 0.9 ? 'warn' : 'info');
        }
        chips.set(bb.inventory);
      },
    };
  }

  private productionBlock(): Block {
    const thisYear = new ResourceChips({ empty: 'Nothing yet.' });
    const lastYear = new ResourceChips({ empty: '—' });
    const el = section('Production',
      h('div', { class: 'prod-row' }, h('span', { class: 'prod-l' }, 'This year'), thisYear.el),
      h('div', { class: 'prod-row' }, h('span', { class: 'prod-l' }, 'Last year'), lastYear.el));
    return {
      el,
      update: (bb) => {
        thisYear.set(bb.producedThisYear);
        lastYear.set(bb.producedLastYear);
      },
    };
  }

  private cropBlock(): Block {
    const seg = new Segmented<CropType>([], (id) => {
      if (!this.sendChoice(id)) return;
      seg.set(id);
    }, { label: 'Crop' });
    const status = h('div', { class: 'farm-status' });
    const bar = new Bar({ tone: 'good' });
    const hint = h('div', { class: 'sel-note dim' });
    const el = section('Crop', seg.el, bar.el, status, hint);
    return {
      el,
      update: (b) => {
        const un = this.ui.game.state.unlocked.crops;
        seg.setOptions(un.map((c) => ({ id: c, label: CROPS[c].name, icon: RESOURCES[CROPS[c].resource].icon, tip: `${CROPS[c].name}: ripens in ~${CROPS[c].growMonths} months, ${CROPS[c].yieldPerTile} per tile` })));
        seg.set(this.ui.pending.get(pendingKey.crop(b.id), b.crop ?? null));
        const tiles: FieldTile[] = b.fieldTiles ?? [];
        const n = tiles.length || b.w * b.h;
        let growing = 0;
        let ripe = 0;
        let harvested = 0;
        let bare = 0;
        let growth = 0;
        for (const t of tiles) {
          if (t.stage === 2) {
            growing++;
            growth += t.growth;
          } else if (t.stage === 3) ripe++;
          else if (t.stage === 4) harvested++;
          else bare++;
        }
        let text: string;
        let frac: number;
        if (ripe > 0) {
          text = `Ripe — harvesting (${ripe} of ${n} tiles left)`;
          frac = 1;
          bar.setTone('gold');
        } else if (growing > 0) {
          frac = growth / growing;
          text = `Growing ${pct(frac)} · ${growing} tiles planted`;
          bar.setTone('good');
        } else if (harvested > 0) {
          text = `Harvested ${harvested} tiles`;
          frac = 0;
        } else {
          text = bare === n ? 'Fallow — waiting for spring planting' : `${bare} tiles to plow & plant`;
          frac = 0;
        }
        bar.set(frac, text);
        const crop = b.crop ? CROPS[b.crop] : null;
        setText(status, crop ? `Expected harvest ≈ ${fmtInt(crop.yieldPerTile * n)} ${RESOURCES[crop.resource].name.toLowerCase()} (${b.w}×${b.h} field)` : '');
        setText(hint, un.length < Object.keys(CROPS).length ? 'More seeds can be bought from merchants.' : 'Plant in spring, harvest before the autumn frost.');
      },
    };
  }

  private orchardBlock(): Block {
    const seg = new Segmented<OrchardType>([], (id) => {
      const b = this.ui.game.getBuilding(this.id);
      const apply = () => {
        if (this.sendChoice(id)) seg.set(id);
        else seg.set(b?.orchard?.type ?? null);
      };
      if (b?.orchard && b.orchard.maturity > 0.05 && b.orchard.type !== id) {
        void this.ui.confirm('Replant the orchard with a different tree? The new trees will need years to mature.', 'Replant', { title: 'Replant orchard' }).then((ok) => {
          if (ok) apply();
          else seg.set(b.orchard?.type ?? null);
        });
      } else apply();
    }, { label: 'Fruit tree' });
    const maturity = new Bar({ tone: 'good' });
    const fruit = new Bar({ tone: 'gold' });
    const note = h('div', { class: 'sel-note dim' });
    const el = section('Orchard', seg.el,
      h('div', { class: 'bar-row' }, h('span', { class: 'bar-l' }, 'Maturity'), maturity.el),
      h('div', { class: 'bar-row' }, h('span', { class: 'bar-l' }, 'Fruit'), fruit.el), note);
    return {
      el,
      update: (b) => {
        const un = this.ui.game.state.unlocked.orchards;
        seg.setOptions(un.map((o) => ({ id: o, label: ORCHARDS[o].name, icon: RESOURCES[ORCHARDS[o].resource].icon, tip: `${ORCHARDS[o].name}: matures in ${ORCHARDS[o].matureYears} years` })));
        const o = b.orchard;
        seg.set(this.ui.pending.get(pendingKey.crop(b.id), o?.type ?? null));
        maturity.set(o?.maturity ?? 0, o ? (o.maturity >= 1 ? 'Mature' : pct(o.maturity)) : '—');
        fruit.set(o?.fruit ?? 0, o ? pct(o.fruit) : '—');
        const def = o ? ORCHARDS[o.type] : null;
        setText(note, def ? (o!.maturity < 1 ? `Young trees bear little fruit. Full yield ≈ ${fmtInt(def.yieldPerTile * b.w * b.h)} per year.` : `Fruit ripens by late summer. Yield ≈ ${fmtInt(def.yieldPerTile * b.w * b.h)} per year.`) : 'Choose a fruit tree to plant.');
      },
    };
  }

  private pastureBlock(): Block {
    const seg = new Segmented<LivestockType>([], (id) => {
      const b = this.ui.game.getBuilding(this.id);
      const apply = () => {
        if (this.sendChoice(id)) seg.set(id);
        else seg.set(b?.livestock?.type ?? null);
      };
      if (b?.livestock && b.livestock.count > 0 && b.livestock.type !== id) {
        void this.ui.confirm(`Switch to ${LIVESTOCK[id].name.toLowerCase()}? The current animals will be released.`, 'Switch', { title: 'Change livestock' }).then((ok) => {
          if (ok) apply();
          else seg.set(b.livestock?.type ?? null);
        });
      } else apply();
    }, { label: 'Livestock' });
    const herd = new Bar({ tone: 'good' });
    const breed = new Bar({ tone: 'info' });
    const product = new Bar({ tone: 'gold' });
    const productLabel = h('span', { class: 'bar-l' }, 'Product');
    const none = h('div', { class: 'sel-note t-warn' }, 'No livestock available. Buy animals from a livestock merchant at a Trading Post.');
    const bars = h('div', {},
      h('div', { class: 'bar-row' }, h('span', { class: 'bar-l' }, 'Herd'), herd.el),
      h('div', { class: 'bar-row' }, h('span', { class: 'bar-l' }, 'Breeding'), breed.el),
      h('div', { class: 'bar-row' }, productLabel, product.el));
    const el = section('Livestock', seg.el, none, bars);
    return {
      el,
      update: (b) => {
        const un = this.ui.game.state.unlocked.livestock;
        seg.setOptions(un.map((l) => ({ id: l, label: LIVESTOCK[l].name, icon: LIVESTOCK_ICONS[l], tip: `${LIVESTOCK[l].name}: ${RESOURCES[LIVESTOCK[l].meat].name.toLowerCase()} & ${RESOURCES[LIVESTOCK[l].product].name.toLowerCase()}` })));
        show(seg.el, un.length > 0);
        show(none, un.length === 0);
        const ls = b.livestock;
        show(bars, !!ls);
        seg.set(this.ui.pending.get(pendingKey.crop(b.id), ls?.type ?? null));
        if (ls) {
          const def = LIVESTOCK[ls.type];
          const cap = Math.max(1, Math.floor((b.w * b.h) / def.tilesPerAnimal));
          herd.set(ls.count / cap, `${fmtInt(ls.count)} / ${fmtInt(cap)} ${def.name.toLowerCase()}`);
          breed.set(ls.breed, ls.count < 2 ? 'Need a pair' : pct(ls.breed));
          setText(productLabel, RESOURCES[def.product].name);
          product.set(ls.product, pct(ls.product));
        }
      },
    };
  }

  private recipeBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const recipes = def.recipes ?? [];
    const recipeText = (i: number) => {
      const r = recipes[i];
      const fmt = (inv: Inventory) => Object.entries(inv).map(([k, v]) => `${v} ${resIcon(k as ResourceType)}`).join(' + ');
      return `${fmt(r.inputs)} → ${fmt(r.outputs)}`;
    };
    const info = h('div', { class: 'recipe-info' });
    if (recipes.length === 1) {
      info.textContent = `${recipes[0].label}: ${recipeText(0)}`;
      return { el: section('Recipe', info), update: () => {} };
    }
    const seg = new Segmented<number>([
      { id: -1, label: 'Auto', tip: 'Make whatever the town has materials for' },
      ...recipes.map((r, i) => ({ id: i, label: r.label, tip: `${recipeText(i)} · ${r.seconds}s per batch` })),
    ], (id) => {
      const res = this.ui.dispatch({ op: 'recipe', id: this.id, recipe: id });
      if (!res.ok) return;
      if (res.pending) this.ui.pending.set(pendingKey.recipe(this.id), id);
      this.ui.sound('click');
      seg.set(id);
    }, { className: 'wrap', label: 'Recipe' });
    const el = section('Recipe', seg.el, info);
    return {
      el,
      update: (bb) => {
        const cur = this.ui.pending.get(pendingKey.recipe(bb.id), bb.recipe ?? -1);
        seg.set(cur);
        setText(info, cur >= 0 && recipes[cur] ? recipeText(cur) : 'Automatic: uses whichever inputs are in stock.');
      },
    };
  }

  private tradeBlock(): Block {
    const status = h('div', { class: 'sel-note' });
    const offers = h('div', { class: 'chips' });
    const open = h('button', { class: 'btn primary block', type: 'button', onclick: () => this.ui.openWindow('trade') }, `${ICON.trade} Open trade`);
    const req = new Segmented<string>([
      { id: 'any', label: 'Any' },
      ...MERCHANT_KINDS.map((k) => ({ id: k.id as string, label: k.name, icon: k.icon, tip: k.desc })),
    ], (id) => {
      const res = this.ui.dispatch({ op: 'requestMerchant', kind: id === 'any' ? null : (id as (typeof MERCHANT_KINDS)[number]['id']) });
      if (!res.ok) return;
      if (res.pending) this.ui.pending.set(pendingKey.merchant(), id);
      req.set(id);
      this.ui.sound('click');
    }, { className: 'small wrap', label: 'Request merchant' });
    let lastMerchant = -2;
    const el = section('Merchants', status, offers, open, h('div', { class: 'sel-sub' }, 'Request next merchant'), req.el);
    return {
      el,
      update: (b) => {
        const s = this.ui.game.state;
        const m = s.trade.merchant;
        req.set(this.ui.pending.get<string>(pendingKey.merchant(), s.trade.requested ?? 'any'));
        if (m && m.postId === b.id) {
          setText(status, `${m.name} is docked — leaves in ${fmtMonths(m.leavesIn)}.`);
          setClass(status, 't-good', true);
          if (lastMerchant !== m.id) {
            lastMerchant = m.id;
            offers.replaceChildren(...m.offers.slice(0, 10).map((o) => {
              const info = offerInfo(o);
              return h('span', { class: 'chip', tip: `${info.name} · ${o.amount} available` }, h('span', { class: 'chip-i' }, info.icon), h('span', { class: 'chip-n' }, info.unlock ? 'new' : fmtCompact(o.amount)));
            }));
          }
        } else {
          lastMerchant = -2;
          offers.replaceChildren();
          setClass(status, 't-good', false);
          setText(status, m ? `${m.name} is docked at another trading post.` : b.workerIds.length ? `No merchant in port. Next arrival in about ${fmtMonths(s.trade.nextArrival)}.` : 'Assign a trader so merchants will visit.');
        }
        show(open, !!m);
      },
    };
  }

  private cemeteryBlock(): Block {
    const bar = new Bar({ tone: 'neutral' });
    const note = h('div', { class: 'sel-note' });
    const el = section('Graves', bar.el, note);
    return {
      el,
      update: (b) => {
        const cap = Math.floor(b.w * b.h * (BUILDINGS.cemetery.gravesPerTile ?? 0.5));
        const used = b.graves ?? 0;
        bar.set(cap > 0 ? used / cap : 0, `${fmtInt(used)} / ${fmtInt(cap)} graves`, used >= cap ? 'bad' : 'neutral');
        const unb = this.ui.game.state.unburied;
        setText(note, unb > 0 ? `${fmtInt(unb)} of the dead await burial — the town is grieving.` : used >= cap ? 'The cemetery is full. Build another.' : 'The departed rest in peace here.');
        setClass(note, 't-bad', unb > 0 || used >= cap);
      },
    };
  }

  private actionsBlock(b: Building): Block {
    const def = BUILDINGS[b.type];
    const pause = h('button', { class: 'btn small', type: 'button', onclick: () => this.togglePause() });
    const prio = h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false', onclick: () => this.togglePriority() }, `${ICON.priority} Priority`);
    const demolish = h('button', { class: 'btn small danger', type: 'button', onclick: () => void this.demolish() });
    const showPause = b.state !== 'ruin' && b.state !== 'demolishing' && (b.state !== 'active' || def.maxWorkers > 0 || !!def.housing);
    // priority: builders go to priority sites first; an active priority workplace is staffed first (sim-core jobs)
    const showPrio = b.state === 'clearing' || b.state === 'construction' || (b.state === 'active' && def.maxWorkers > 0);
    const el = h('div', { class: 'sel-actions' }, showPause ? pause : null, showPrio ? prio : null, b.state !== 'demolishing' ? demolish : null);
    return {
      el,
      update: (bb) => {
        const building = bb.state === 'clearing' || bb.state === 'construction';
        const paused = this.effPaused(bb);
        const priority = this.effPriority(bb);
        setText(pause, paused ? `${ICON.play} Resume` : `${ICON.pause} Pause`);
        this.ui.tips.set(pause, building ? (paused ? 'Resume construction' : 'Pause construction') : paused ? 'Resume work' : 'Stop work here (workers become laborers)');
        setClass(pause, 'pending', paused !== bb.paused);
        setClass(prio, 'on', priority);
        setClass(prio, 'pending', priority !== bb.priority);
        prio.setAttribute('aria-pressed', String(priority));
        this.ui.tips.set(prio, building
          ? 'Builders work on priority sites first (and it is staffed first once built)'
          : 'Priority workplace: staffed first — takes workers from non-priority workplaces when no laborers are free');
        setText(demolish, building ? `${ICON.close} Cancel` : bb.state === 'ruin' ? `${ICON.demolish} Clear ruins` : `${ICON.demolish} Demolish`);
        this.ui.tips.set(demolish, building ? 'Cancel construction (delivered materials are refunded)' : 'Demolish [Delete] — half of the materials are returned');
        setDisabled(demolish, bb.state === 'demolishing');
      },
    };
  }

  // ---- actions ----

  /** Paused as the player last requested it (co-op: before the host applied it). */
  private effPaused(b: Building): boolean {
    return this.ui.pending.get(pendingKey.paused(b.id), b.paused);
  }

  private effPriority(b: Building): boolean {
    return this.ui.pending.get(pendingKey.priority(b.id), b.priority);
  }

  /** Crop / orchard tree / livestock choice. Returns true when accepted (solo: applied; co-op: queued). */
  private sendChoice(choice: CropType | OrchardType | LivestockType): boolean {
    const res = this.ui.dispatch({ op: 'crop', id: this.id, choice });
    if (!res.ok) return false;
    if (res.pending) this.ui.pending.set(pendingKey.crop(this.id), choice);
    this.ui.sound('click');
    return true;
  }

  private togglePause(): void {
    const b = this.ui.game.getBuilding(this.id);
    if (!b) return;
    const next = !this.effPaused(b);
    const res = this.ui.dispatch({ op: 'pause', id: this.id, paused: next });
    if (!res.ok) return;
    if (res.pending) this.ui.pending.set(pendingKey.paused(this.id), next);
    this.ui.sound('click');
    this.update();
  }

  private togglePriority(): void {
    const b = this.ui.game.getBuilding(this.id);
    if (!b) return;
    const next = !this.effPriority(b);
    const res = this.ui.dispatch({ op: 'priority', id: this.id, priority: next });
    if (!res.ok) return;
    if (res.pending) this.ui.pending.set(pendingKey.priority(this.id), next);
    this.ui.sound('click');
    this.update();
  }

  private async demolish(): Promise<void> {
    const b = this.ui.game.getBuilding(this.id);
    if (!b) return;
    const def = BUILDINGS[b.type];
    const building = b.state === 'clearing' || b.state === 'construction';
    let msg: string;
    if (building) msg = `Cancel construction of this ${def.name}? Delivered materials will be returned to storage.`;
    else if (b.state === 'ruin') msg = 'Clear away these ruins?';
    else {
      msg = `Demolish this ${def.name}? Half of its materials will be returned.`;
      if (b.residentIds.length) msg += ` ${b.residentIds.length} resident${b.residentIds.length === 1 ? '' : 's'} will lose their home.`;
      if (def.storage && invSum(b.inventory) > 0) msg += ' Stored goods will be moved or lost.';
    }
    const ok = await this.ui.confirm(msg, building ? 'Cancel construction' : b.state === 'ruin' ? 'Clear' : 'Demolish', { danger: true, title: building ? 'Cancel construction' : 'Demolish', cancelLabel: 'Keep' });
    if (!ok || !this.ui.game.getBuilding(this.id)) return;
    const res = this.ui.dispatch({ op: 'demolish', id: this.id });
    if (!res.ok) return;
    this.ui.sound('click');
    // solo: a cancelled construction site is gone at once (co-op: the panel closes when the host applies it)
    if (!res.pending && building && !this.ui.game.getBuilding(this.id)) this.ui.app.select(null);
  }
}

/** Utility for tone of a 0..100 need. */
export function needTone(v: number): 'good' | 'warn' | 'bad' {
  return toneFor(v / 100) as 'good' | 'warn' | 'bad';
}
