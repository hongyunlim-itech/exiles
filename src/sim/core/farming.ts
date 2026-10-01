/**
 * Crop fields, orchards and pastures: growth, ripening, frost, breeding and products (the building-side half of
 * farming; the worker-side lives in work/farm.ts). ARCHITECTURE §3.5 "Crop field / Orchard / Pasture". OWNER: sim-core.
 */
import { MONTH_SECONDS, YEAR_SECONDS } from '../../core/constants';
import { CROPS, LIVESTOCK, ORCHARDS } from '../../core/defs';
import type { Building } from '../../core/types';
import type { Game } from '../game';
import { makeFieldTiles } from './buildings';
import { clamp } from './util';

/** Farming runs at this interval (seconds) with accumulated dt. */
export const FARM_INTERVAL = 0.5;
/** Crops stall below this temperature. */
export const CROP_MIN_TEMP = 3;
/** Months (0-based) in which crops may be planted. */
export const PLANT_MONTHS = [0, 1, 2];
/** Orchard fruit needs this many months of warm-season ripening. */
const FRUIT_MONTHS = 3.2;
/** Orchard trees yield only above this maturity. */
export const ORCHARD_MIN_MATURITY = 0.3;
/** Product units collected per herder "collect" action. */
export const PRODUCT_BATCH = 5;
/** Slaughter when the herd exceeds this share of capacity. */
export const SLAUGHTER_SHARE = 0.6;

export function pastureCapacity(b: Building): number {
  if (!b.livestock) return 0;
  return Math.max(2, Math.floor((b.w * b.h) / LIVESTOCK[b.livestock.type].tilesPerAnimal));
}

/** Months in which a livestock type yields its secondary product. */
function productMonths(type: string): number[] {
  if (type === 'sheep') return [3, 4, 5];
  if (type === 'chicken') return [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return [0, 1, 2, 3, 4, 5, 6, 7, 8];
}

export function updateFarming(g: Game, dt: number): void {
  const s = g.state;
  let fieldsChanged = false;
  for (const b of g.rt.workplaces(s)) {
    if (b.state !== 'active') continue;
    if (b.type === 'cropField') fieldsChanged = updateCropField(g, b, dt) || fieldsChanged;
    else if (b.type === 'orchard') fieldsChanged = updateOrchard(g, b, dt) || fieldsChanged;
    else if (b.type === 'pasture') updatePasture(g, b, dt);
  }
  if (fieldsChanged) s.rev.fields++;
}

function frostNow(g: Game): boolean {
  const s = g.state;
  return s.time.month >= 6 && s.weather.temperature < 0;
}

const FROST_TEXT = 'Frost has destroyed the unharvested';

/**
 * One frost message per field and month. The "already told" check reads the (saved) message log instead of a
 * runtime map, so a game restored from a snapshot posts exactly the messages the original does (lockstep co-op).
 */
function notifyFrost(g: Game, b: Building, what: string): void {
  const s = g.state;
  const key = s.time.year * 12 + s.time.month;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.year * 12 + m.month !== key) break;
    if (m.target?.kind === 'building' && m.target.id === b.id && m.text.startsWith(FROST_TEXT)) return;
  }
  g.addMessage(`${FROST_TEXT} ${what}.`, 'warning', { kind: 'building', id: b.id });
}

function updateCropField(g: Game, b: Building, dt: number): boolean {
  const s = g.state;
  const n = b.w * b.h;
  if (!b.fieldTiles || b.fieldTiles.length !== n) b.fieldTiles = makeFieldTiles(n, 0);
  const crop = CROPS[b.crop ?? 'wheat'];
  const tiles = b.fieldTiles;
  let changed = false;
  if (frostNow(g)) {
    let lost = 0;
    for (const t of tiles) {
      if (t.stage === 2 || t.stage === 3) {
        t.stage = 4;
        t.growth = 0;
        lost++;
      }
    }
    if (lost > 0) {
      notifyFrost(g, b, `${crop.name.toLowerCase()} at a crop field`);
      changed = true;
    }
    return changed;
  }
  if (s.weather.temperature < CROP_MIN_TEMP || b.paused) return false;
  // crops grow at the same pace however many farmers there are: too few farmers only plant and harvest fewer tiles
  // (slower growth made understaffed fields lose nearly everything to the first frost)
  const rate = dt / (crop.growMonths * MONTH_SECONDS);
  for (const t of tiles) {
    if (t.stage !== 2) continue;
    const before = Math.floor(t.growth * 10);
    t.growth += rate;
    if (t.growth >= 1) {
      t.growth = 1;
      t.stage = 3;
      changed = true;
    } else if (Math.floor(t.growth * 10) !== before) changed = true;
  }
  return changed;
}

function updateOrchard(g: Game, b: Building, dt: number): boolean {
  const s = g.state;
  const o = b.orchard;
  if (!o) return false;
  const n = b.w * b.h;
  if (!b.fieldTiles || b.fieldTiles.length !== n) b.fieldTiles = makeFieldTiles(n, 2);
  const def = ORCHARDS[o.type];
  const tiles = b.fieldTiles;
  const month = s.time.month;
  let changed = false;
  if (month < 9 && !b.paused) {
    const before = Math.floor(o.maturity * 20);
    o.maturity = Math.min(1, o.maturity + (dt / (def.matureYears * YEAR_SECONDS)) * (b.workerIds.length > 0 ? 1 : 0.5));
    if (Math.floor(o.maturity * 20) !== before) changed = true;
  }
  if (month <= 2) {
    // new season: blossoms; reset last year's tiles
    if (o.fruit !== 0) o.fruit = 0;
    for (const t of tiles) {
      if (t.stage !== 2 || t.growth !== 0) {
        t.stage = 2;
        t.growth = 0;
        changed = true;
      }
    }
    return changed;
  }
  if (frostNow(g)) {
    let lost = 0;
    for (const t of tiles) {
      if (t.stage === 3 || (t.stage === 2 && t.growth > 0)) {
        if (t.stage === 3) lost++;
        t.stage = 4;
        t.growth = 0;
      }
    }
    o.fruit = 0;
    if (lost > 0) {
      notifyFrost(g, b, `${def.name.toLowerCase()}s in an orchard`);
      changed = true;
    }
    return changed;
  }
  if (o.maturity < ORCHARD_MIN_MATURITY) return changed;
  // ripening through summer
  let ripe = 0;
  let growing = 0;
  for (const t of tiles) {
    if (t.stage === 3) ripe++;
    else if (t.stage === 2) growing++;
  }
  if (growing > 0 && month >= 3 && s.weather.temperature >= CROP_MIN_TEMP && !b.paused) {
    const inc = dt / (FRUIT_MONTHS * MONTH_SECONDS);
    let becameRipe = false;
    for (const t of tiles) {
      if (t.stage !== 2) continue;
      const before = Math.floor(t.growth * 10);
      t.growth = Math.min(1, t.growth + inc);
      if (t.growth >= 1) {
        t.stage = 3;
        becameRipe = true;
      }
      if (Math.floor(t.growth * 10) !== before) changed = true;
    }
    if (becameRipe) {
      ripe = 0;
      for (const t of tiles) if (t.stage === 3) ripe++;
      changed = true;
    }
  }
  const newFruit = growing + ripe > 0 && ripe > 0 ? ripe / n : tiles.length > 0 ? avgGrowth(tiles) : 0;
  if (Math.abs(newFruit - o.fruit) > 0.02) changed = true;
  o.fruit = clamp(newFruit, 0, 1);
  return changed;
}

function avgGrowth(tiles: { stage: number; growth: number }[]): number {
  let t = 0;
  for (const x of tiles) if (x.stage === 2) t += x.growth;
  return t / tiles.length;
}

function updatePasture(g: Game, b: Building, dt: number): void {
  const s = g.state;
  const l = b.livestock;
  if (!l) return;
  const def = LIVESTOCK[l.type];
  const cap = pastureCapacity(b);
  const month = s.time.month;
  const herders = b.workerIds.length;
  if (b.paused || herders === 0) return;
  if (month < 9 && l.count >= 2 && l.count < cap) {
    l.breed += (def.breedRate * l.count * dt) / YEAR_SECONDS;
    while (l.breed >= 1 && l.count < cap) {
      l.breed -= 1;
      l.count += 1;
    }
    if (l.count >= cap) l.breed = Math.min(l.breed, 0.99);
  }
  const months = productMonths(l.type);
  if (months.includes(month) && l.count > 0) {
    const perSecond = (def.productPerYear * l.count) / (months.length * MONTH_SECONDS);
    l.product = Math.min(1, l.product + (perSecond * dt) / PRODUCT_BATCH);
  }
}

/** Should herders cull the herd? */
export function pastureWantsSlaughter(b: Building): boolean {
  const l = b.livestock;
  if (!l) return false;
  return l.count >= 3 && l.count > pastureCapacity(b) * SLAUGHTER_SHARE;
}
