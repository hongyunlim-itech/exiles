/**
 * Fast deterministic hash of the lockstep-relevant simulation state (net-core).
 *
 * Every peer computes it for the same tick and the host broadcasts its value; a mismatch means this peer's town has
 * diverged and must resync from a fresh snapshot. Values are quantised ("rounded sensibly") so benign last-bit noise
 * (e.g. a transcendental function that differs by one ulp between JS engines) does not cause false alarms, while any
 * real divergence (a different decision, a different random draw) changes the RNG state or an integer field at once.
 * NaN / ±Infinity / null / -0 all quantise to 0, so a value that went through a JSON snapshot hashes like the
 * original.
 *
 * Cost: O(citizens + buildings + animals) plus a full pass over the small per-tile byte arrays (feature, road,
 * marked) and a sampled pass over feature amounts — well under a millisecond on a large map.
 */
import { brainOf } from '../sim/core/tasks';
import type { Game } from '../sim/game';

/** Hash accumulator (32-bit, murmur3-style mixing). */
export class StateHasher {
  h: number;

  constructor(seed = 0x9e3779b9) {
    this.h = seed | 0;
  }

  /** Mix one 32-bit integer. */
  int(v: number): this {
    let k = Math.imul(v | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    let h = this.h ^ k;
    h = (h << 13) | (h >>> 19);
    this.h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    return this;
  }

  /** Mix a number quantised to 1/scale (NaN, ±Infinity, null and -0 all hash as 0). */
  num(v: number | null | undefined, scale: number): this {
    const q = Math.round((v as number) * scale);
    return this.int(Number.isFinite(q) ? q | 0 : 0);
  }

  bool(v: unknown): this {
    return this.int(v ? 1 : 0);
  }

  str(s: string | null | undefined): this {
    if (!s) return this.int(0);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return this.int(h).int(s.length);
  }

  /** Inventory-like record: keys in sorted order (insertion order may legitimately differ after a JSON round trip of
   *  equal content — it does not, but sorting keeps the hash independent of it), amounts quantised. */
  inv(o: Record<string, number | undefined> | null | undefined, scale = 64): this {
    if (!o) return this.int(-1);
    const keys = Object.keys(o).filter((k) => (o[k] ?? 0) > 1e-9).sort();
    this.int(keys.length);
    for (const k of keys) this.str(k).num(o[k] ?? 0, scale);
    return this;
  }

  bytes(a: ArrayLike<number>, step = 1): this {
    // fold 4 bytes per word for speed
    let acc = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += step) {
      acc = (acc * 31 + (a[i] | 0)) | 0;
      if (++n === 4) {
        this.int(acc);
        acc = 0;
        n = 0;
      }
    }
    return this.int(acc).int(a.length);
  }

  result(): number {
    let h = this.h;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
}

/** Positions to 1/256 tile, needs to 1/16, fractions to 1/1024. */
const POS = 256;
const NEED = 16;
const FRAC = 1024;

/** Hash of the simulation state that matters for lockstep (see module doc). */
export function hashGameState(game: Game): number {
  const s = game.state;
  const h = new StateHasher();
  h.int(game.rng.state).num(s.time.elapsed, 64).int(s.time.year).int(s.time.month).int(s.nextId);
  h.num(s.weather.temperature, 16).num(s.weather.snow, FRAC).str(s.weather.precipitation);
  h.int(s.buildersDesired).int(s.unburied).bool(s.gameOver).int(s.tally.births).int(s.messages.length);
  h.int(s.unlocked.crops.length).int(s.unlocked.orchards.length).int(s.unlocked.livestock.length);
  h.num(s.trade.nextArrival, 4).str(s.trade.requested).int(s.trade.merchant ? s.trade.merchant.id : -1);
  if (s.nomads) h.int(s.nomads.count).num(s.nomads.expiresIn, 4);
  else h.int(-1);
  if (s.tornado) h.num(s.tornado.x, POS).num(s.tornado.z, POS);
  // citizens
  h.int(s.citizens.length);
  for (const c of s.citizens) {
    h.int(c.id).num(c.x, POS).num(c.z, POS).num(c.food, NEED).num(c.warmth, NEED).num(c.health, NEED)
      .num(c.happiness, NEED).num(c.sick, FRAC).num(c.age, FRAC).int(c.homeId).int(c.workplaceId).str(c.profession)
      .int(c.spouseId).num(c.toolWear, 4).num(c.coatWear, 4).str(c.activity);
    if (c.carrying) h.str(c.carrying.type).num(c.carrying.amount, 64);
    else h.int(-1);
    const t = brainOf(c).cur;
    if (t) h.str(t.kind).int(t.si).int(t.steps.length).int(t.claims.length);
    else h.int(-2);
    h.int(c.path ? c.path.length : -1).int(c.pathIndex);
  }
  // buildings
  h.int(s.buildings.length);
  for (const b of s.buildings) {
    h.int(b.id).str(b.type).int(b.x).int(b.z).int(b.w).int(b.h).str(b.state).num(b.progress, FRAC)
      .num(b.workRemaining, 16).int(b.workersDesired).int(b.workerIds.length).int(b.residentIds.length)
      .num(b.fire, FRAC).num(b.reservedIn, 64).bool(b.paused).bool(b.priority).int(b.recipe ?? -2)
      .inv(b.inventory).inv(b.delivered).inv(b.reservedOut).inv(b.incoming);
    if (b.livestock) h.str(b.livestock.type).num(b.livestock.count, 64).num(b.livestock.breed, FRAC);
    if (b.orchard) h.str(b.orchard.type).num(b.orchard.maturity, FRAC).num(b.orchard.fruit, FRAC);
    if (b.fieldTiles) {
      let acc = 0;
      for (const ft of b.fieldTiles) acc = (Math.imul(acc, 31) + ft.stage * 1024 + Math.round(ft.growth * 1000)) | 0;
      h.int(acc).str(b.crop);
    }
  }
  // animals
  h.int(s.animals.length);
  for (const a of s.animals) h.int(a.id).num(a.x, 64).num(a.z, 64).int(a.huntedBy);
  // tiles: byte layers in full, feature amounts sampled
  const t = s.tiles;
  h.bytes(t.feature).bytes(t.road).bytes(t.marked);
  const fa = t.featureAmount;
  for (let i = (s.time.month * 7) % 13; i < fa.length; i += 13) h.num(fa[i], 256);
  return h.result();
}
