/**
 * Merchants & trading. OWNER: sim-ext agent.
 *
 * - An active Trading Post with at least one trader attracts a merchant every ~4–8 months (never in winter).
 *   The first visit comes no sooner than ~1.5 months after the post is staffed. Merchants stay 2 months.
 * - Kinds: food, goods, livestock (unlocks), seeds (crop/orchard unlocks), general. A requested kind
 *   (requestMerchant) is used for the next visit and then cleared.
 * - executeTrade barters town goods (valued at their def value) for merchant offers (valued at offer price).
 *   Purchased goods go into the trading post first (then other storage); unlocks append to state.unlocked.
 * - Visiting crews raise the chance of a disease outbreak (when disasters are enabled).
 */
import { BUILDINGS, RESOURCES } from '../core/defs';
import type {
  Building, CropType, Inventory, LivestockType, Merchant, MerchantKind, MerchantOffer, OrchardType, ResourceType,
} from '../core/types';
import {
  generateOffers, isOwnedUnlock, merchantKindLabel, merchantName, offerLabel, randomMerchantKind,
} from './ext/merchants';
import { addOutbreakRisk, startOutbreak } from './ext/outbreak';
import { rt } from './ext/runtime';
import {
  MERCHANT_DISEASE_CHANCE, MERCHANT_FIRST_DELAY, MERCHANT_INTERVAL_MAX, MERCHANT_INTERVAL_MIN, MERCHANT_SAIL_SECONDS,
  MERCHANT_STAY, OUTBREAK_RISK_MERCHANT,
} from './ext/tuning';
import { describeInventory, isWinterMonth, resourceName, wholeUnits } from './ext/util';
import type { Game, TradeResult, TradeTake } from './game';

export { merchantKindLabel, offerLabel };

/** Seconds before departure when the town is warned that the merchant is about to leave. */
const LEAVING_SOON = 20;

export function updateTrade(game: Game, dt: number): void {
  if (!(dt > 0)) return;
  const s = game.state;
  const t = s.trade;

  if (t.merchant) {
    const m = t.merchant;
    const post = game.getBuilding(m.postId);
    if (!post || post.state !== 'active') {
      departMerchant(game, 'The merchant cast off in haste — the trading post is gone.');
      return;
    }
    const before = m.leavesIn;
    m.leavesIn -= dt;
    if (m.leavesIn > MERCHANT_SAIL_SECONDS) m.arrive = Math.min(1, m.arrive + dt / MERCHANT_SAIL_SECONDS);
    else m.arrive = Math.max(0, Math.min(m.arrive, m.leavesIn / MERCHANT_SAIL_SECONDS));
    if (before > LEAVING_SOON && m.leavesIn <= LEAVING_SOON) {
      game.addMessage(`${m.name} is making ready to sail. Trade now or wait for the next visit.`, 'info', { kind: 'building', id: post.id });
    }
    if (m.leavesIn <= 0) departMerchant(game);
    return;
  }

  const post = findTradingPost(game);
  if (!post || s.gameOver) {
    // No staffed post: the first merchant comes MERCHANT_FIRST_DELAY after one opens (not the moment it opens, and
    // not after whatever the initial timer was).
    t.nextArrival = MERCHANT_FIRST_DELAY;
    return;
  }
  t.nextArrival -= dt;
  if (t.nextArrival > 0) return;
  if (isWinterMonth(s.time.month)) {
    t.nextArrival = 0; // rivers are frozen — wait for spring
    return;
  }
  arriveMerchant(game, post);
}

/** Barter: `give` resources from town storage for merchant offers. Value of give must cover value of take. */
export function executeTrade(game: Game, give: Inventory, take: TradeTake[]): TradeResult {
  const s = game.state;
  const m = s.trade.merchant;
  if (!m) return fail('There is no merchant at the trading post.');
  if (m.leavesIn <= 0) return fail('The merchant has already set sail.');

  // ---- validate what we take ----
  const takeMap = new Map<number, number>();
  for (const t of take ?? []) {
    if (!t || !Number.isInteger(t.offerIndex)) return fail('Invalid trade selection.');
    const n = wholeUnits(t.amount);
    if (!(n >= 0)) return fail('Invalid amount.');
    if (n === 0) continue;
    if (!m.offers[t.offerIndex]) return fail('That offer is no longer available.');
    takeMap.set(t.offerIndex, (takeMap.get(t.offerIndex) ?? 0) + n);
  }
  if (takeMap.size === 0) return fail('Choose something to buy from the merchant.');
  let takeValue = 0;
  for (const [i, n] of takeMap) {
    const offer = m.offers[i];
    const label = offerLabel(offer);
    if (offer.kind !== 'resource') {
      if (isOwnedUnlock(s, offer)) return fail(`Your town already has ${label}.`);
      if (n > 1) takeMap.set(i, 1);
    }
    const qty = takeMap.get(i) ?? 0;
    if (qty > offer.amount) {
      return fail(offer.amount <= 0 ? `The merchant has no more ${label}.` : `The merchant only has ${offer.amount} ${label}.`);
    }
    takeValue += qty * offer.price;
  }

  // ---- validate what we give ----
  const giveInv: Inventory = {};
  for (const k of Object.keys(give ?? {})) {
    const r = k as ResourceType;
    if (!RESOURCES[r]) return fail(`Unknown goods: ${k}.`);
    const n = wholeUnits(give[r]);
    if (!(n >= 0)) return fail('Invalid amount.');
    if (n > 0) giveInv[r] = n;
  }
  if (Object.keys(giveInv).length === 0) return fail('Choose goods to offer in exchange.');
  const totals = game.resourceTotals();
  for (const k of Object.keys(giveInv) as ResourceType[]) {
    const have = Math.floor(totals[k] ?? 0);
    if (have < (giveInv[k] ?? 0)) return fail(`Not enough ${resourceName(k)} in storage (you have ${have}).`);
  }
  const giveValue = inventoryValue(giveInv);
  if (giveValue + 1e-6 < takeValue) {
    return fail(`The merchant wants goods worth ${fmt(takeValue)}; your offer is worth only ${fmt(giveValue)}.`);
  }

  // ---- storage space for purchased goods ----
  const bought: Inventory = {};
  for (const [i, n] of takeMap) {
    const offer = m.offers[i];
    if (offer.kind === 'resource') bought[offer.id as ResourceType] = (bought[offer.id as ResourceType] ?? 0) + n;
  }
  const spaceError = checkSpace(game, giveInv, bought);
  if (spaceError) return fail(spaceError);

  // ---- execute: hand over our goods (transactional) ----
  const taken: Inventory = {};
  for (const k of Object.keys(giveInv) as ResourceType[]) {
    const want = giveInv[k] ?? 0;
    const got = game.takeFromStorage(k, want);
    taken[k] = got;
    if (got + 1e-6 < want) {
      restore(game, taken);
      return fail(`Some of the ${resourceName(k)} is already promised to workers. Offer a little less.`);
    }
  }

  // ---- receive purchased goods ----
  const post = game.getBuilding(m.postId);
  const px = post ? post.x + post.w / 2 : undefined;
  const pz = post ? post.z + post.h / 2 : undefined;
  const added: Inventory = {};
  const atPost: Inventory = {};
  for (const k of Object.keys(bought) as ResourceType[]) {
    const want = bought[k] ?? 0;
    // purchases are unloaded into the trading post first; laborers take them on from there
    const put = storeAtPost(post ?? undefined, k, want);
    atPost[k] = put;
    const stored = put + game.addToStorage(k, want - put, px, pz);
    added[k] = stored;
    if (stored + 1e-6 < want) {
      // Not enough room after all: undo everything.
      for (const a of Object.keys(added) as ResourceType[]) {
        const p = atPost[a] ?? 0;
        if (post && p > 0) post.inventory[a] = Math.max(0, (post.inventory[a] ?? 0) - p);
        game.takeFromStorage(a, (added[a] ?? 0) - p);
      }
      restore(game, taken);
      return fail('There is not enough storage space for the purchased goods.');
    }
  }

  // ---- unlocks & offer bookkeeping ----
  const unlockedNames: string[] = [];
  for (const [i, n] of takeMap) {
    const offer = m.offers[i];
    offer.amount = Math.max(0, offer.amount - n);
    if (offer.kind !== 'resource') {
      applyUnlock(game, offer);
      unlockedNames.push(offer.kind === 'livestock' ? offerLabel(offer) : offerLabel(offer).toLowerCase());
    }
  }

  const gaveText = describeInventory(giveInv);
  const parts: string[] = [];
  const boughtText = describeInventory(bought);
  if (boughtText) parts.push(boughtText);
  if (unlockedNames.length) parts.push(unlockedNames.join(', '));
  game.addMessage(`Traded ${gaveText} with ${m.name} for ${parts.join(' and ')}.`, 'good', post ? { kind: 'building', id: post.id } : undefined);
  return { ok: true };
}

export function requestMerchant(game: Game, kind: MerchantKind | null): void {
  const t = game.state.trade;
  if (t.requested === kind) return;
  t.requested = kind;
  if (kind) game.addMessage(`Word has been sent downriver: the next merchant should be a ${merchantKindLabel(kind)}.`, 'info');
}

/** Trade value of a set of resources (for UI). */
export function inventoryValue(inv: Inventory): number {
  let v = 0;
  for (const k of Object.keys(inv ?? {}) as ResourceType[]) {
    const n = inv[k] ?? 0;
    const def = RESOURCES[k];
    if (def && n > 0) v += def.value * n;
  }
  return v;
}

/** Total price of a selection of merchant offers (for UI). Invalid entries count as 0. */
export function offersValue(merchant: Merchant | null, take: TradeTake[]): number {
  if (!merchant) return 0;
  let v = 0;
  for (const t of take) {
    const offer = merchant.offers[t.offerIndex];
    if (offer && t.amount > 0) v += offer.price * (offer.kind === 'resource' ? Math.floor(t.amount) : 1);
  }
  return v;
}

/** Trade value of one unit of a resource. */
export function resourceValue(r: ResourceType): number {
  return RESOURCES[r]?.value ?? 0;
}

/** Force a merchant to arrive now at the first staffed trading post (debug). Returns false without a post. */
export function summonMerchant(game: Game, kind?: MerchantKind): boolean {
  if (game.state.trade.merchant) return false;
  const post = findTradingPost(game);
  if (!post) return false;
  if (kind) game.state.trade.requested = kind;
  arriveMerchant(game, post);
  return true;
}

// ---------------------------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------------------------

function fail(reason: string): TradeResult {
  return { ok: false, reason };
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** First active trading post with a trader. */
export function findTradingPost(game: Game): Building | null {
  for (const b of game.state.buildings) {
    if (b.type === 'tradingPost' && b.state === 'active' && b.workerIds.length > 0) return b;
  }
  return null;
}

function arriveMerchant(game: Game, post: Building): void {
  const s = game.state;
  const t = s.trade;
  const rng = game.rng;
  const kind = t.requested ?? randomMerchantKind(rng, s);
  t.requested = null;
  const offers: MerchantOffer[] = generateOffers(rng, s, kind);
  const merchant: Merchant = {
    id: game.newId(),
    kind,
    name: merchantName(rng),
    postId: post.id,
    offers,
    leavesIn: MERCHANT_STAY,
    arrive: 0,
  };
  t.merchant = merchant;
  t.nextArrival = 0;
  const label = merchantKindLabel(kind);
  game.addMessage(`A ${label}, ${merchant.name}, has docked at the Trading Post.`, 'good', { kind: 'building', id: post.id });
  game.events.emit('merchantArrived', { merchantId: merchant.id });
  game.events.emit('sound', { cue: 'bell', x: post.x + post.w / 2, z: post.z + post.h / 2 });

  if (s.settings.disasters) {
    addOutbreakRisk(game, OUTBREAK_RISK_MERCHANT);
    if (!rt(game).outbreakActive && s.citizens.length > 0 && rng.next() < MERCHANT_DISEASE_CHANCE) {
      startOutbreak(game, { x: post.x + post.w / 2, z: post.z + post.h / 2 }, `Sailors from ${merchant.name}'s boat brought sickness ashore.`);
    }
  }
}

function departMerchant(game: Game, text?: string): void {
  const t = game.state.trade;
  const m = t.merchant;
  if (!m) return;
  t.merchant = null;
  t.nextArrival = game.rng.range(MERCHANT_INTERVAL_MIN, MERCHANT_INTERVAL_MAX);
  game.addMessage(text ?? `${m.name} has sailed away. Another merchant should come by in a few months.`, 'info');
  game.events.emit('merchantLeft', { merchantId: m.id });
}

function applyUnlock(game: Game, offer: MerchantOffer): void {
  const u = game.state.unlocked;
  switch (offer.kind) {
    case 'crop': {
      const id = offer.id as CropType;
      if (!u.crops.includes(id)) u.crops.push(id);
      game.addMessage(`Your farmers can now plant ${offerLabel(offer).replace(' seeds', '').toLowerCase()} in crop fields.`, 'good');
      break;
    }
    case 'orchard': {
      const id = offer.id as OrchardType;
      if (!u.orchards.includes(id)) u.orchards.push(id);
      game.addMessage(`${offerLabel(offer)} can now be planted in orchards.`, 'good');
      break;
    }
    case 'livestock': {
      const id = offer.id as LivestockType;
      if (!u.livestock.includes(id)) u.livestock.push(id);
      game.addMessage(`${offerLabel(offer)} can now be raised in pastures.`, 'good');
      break;
    }
  }
}

function restore(game: Game, inv: Inventory): void {
  for (const k of Object.keys(inv) as ResourceType[]) {
    const n = inv[k] ?? 0;
    if (n > 0) game.addToStorage(k, n);
  }
}

/**
 * Pre-check that bought goods fit into storage (after our own goods have left). Mixed storage (trading posts,
 * markets) counts for both kinds. The transactional add in executeTrade still guards against surprises.
 */
/** Put up to n units of r into the trading post itself (if it stores that kind and has room). Returns the amount. */
function storeAtPost(post: Building | undefined, r: ResourceType, n: number): number {
  if (!post || post.state !== 'active' || !(n > 0)) return 0;
  const st = BUILDINGS[post.type]?.storage;
  const kind = RESOURCES[r]?.storage;
  if (!st || !kind || !st.kinds.includes(kind)) return 0;
  const cap = st.perTile ? st.capacity * post.w * post.h : st.capacity;
  let used = 0;
  for (const k of Object.keys(post.inventory) as ResourceType[]) used += post.inventory[k] ?? 0;
  const put = Math.max(0, Math.min(n, cap - used - (post.reservedIn ?? 0)));
  if (put > 0) post.inventory[r] = (post.inventory[r] ?? 0) + put;
  return put;
}

function checkSpace(game: Game, give: Inventory, bought: Inventory): string | null {
  let barnFree = 0;
  let pileFree = 0;
  let totalFree = 0;
  for (const b of game.state.buildings) {
    const st = BUILDINGS[b.type]?.storage;
    if (!st || b.state !== 'active') continue;
    const cap = st.perTile ? st.capacity * b.w * b.h : st.capacity;
    let used = 0;
    for (const k of Object.keys(b.inventory) as ResourceType[]) used += b.inventory[k] ?? 0;
    const free = Math.max(0, cap - used - (b.reservedIn ?? 0));
    totalFree += free;
    if (st.kinds.includes('barn')) barnFree += free;
    if (st.kinds.includes('stockpile')) pileFree += free;
  }
  let needBarn = 0;
  let needPile = 0;
  for (const k of Object.keys(bought) as ResourceType[]) {
    if (RESOURCES[k].storage === 'barn') needBarn += bought[k] ?? 0;
    else needPile += bought[k] ?? 0;
  }
  // Goods we hand over free up room of their kind.
  for (const k of Object.keys(give) as ResourceType[]) {
    const n = give[k] ?? 0;
    if (RESOURCES[k].storage === 'barn') barnFree += n;
    else pileFree += n;
    totalFree += n;
  }
  if (needBarn > barnFree + 1e-6) return 'There is not enough room in your storage barns for the purchased goods.';
  if (needPile > pileFree + 1e-6) return 'There is not enough room in your stockpiles for the purchased goods.';
  if (needBarn + needPile > totalFree + 1e-6) return 'There is not enough storage space for the purchased goods.';
  return null;
}
