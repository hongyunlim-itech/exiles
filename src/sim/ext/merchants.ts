/**
 * Merchant generation: names, kinds and priced offers. Unlock offers (seeds, livestock) are only generated for
 * items the town has not unlocked yet.
 */
import { CROPS, FEMALE_NAMES, FOOD_TYPES, LIVESTOCK, MALE_NAMES, ORCHARDS, RESOURCES } from '../../core/defs';
import type { Rng } from '../../core/rng';
import type {
  CropType, GameState, LivestockType, MerchantKind, MerchantOffer, OrchardType, ResourceType,
} from '../../core/types';

export const MERCHANT_KINDS: MerchantKind[] = ['food', 'goods', 'livestock', 'seeds', 'general'];

const KIND_LABELS: Record<MerchantKind, string> = {
  food: 'food merchant',
  goods: 'goods trader',
  livestock: 'livestock trader',
  seeds: 'seed merchant',
  general: 'general trader',
};

/** "seed merchant", "food merchant", ... */
export function merchantKindLabel(kind: MerchantKind): string {
  return KIND_LABELS[kind] ?? 'merchant';
}

const PLACES = [
  'Saltmarsh', 'Eastmoor', 'Kingsbridge', 'Harrowgate', 'Wexmouth', 'Dunmere', 'Coldharbour', 'Ravenshore', 'Ashford',
  'Greywater', 'Thornbury', 'Oakhaven', 'Stillwater', 'Brackenfield', 'Highcliff', 'Marrow Fen',
];

export function merchantName(rng: Rng): string {
  const first = rng.next() < 0.7 ? rng.pick(MALE_NAMES) : rng.pick(FEMALE_NAMES);
  return `${first} of ${rng.pick(PLACES)}`;
}

/** Base price for unlocking a crop / orchard / livestock type. */
export const UNLOCK_PRICES = {
  crop: { wheat: 150, corn: 200, potato: 180, beans: 170 } as Record<CropType, number>,
  orchard: { apple: 260, pear: 290, cherry: 360 } as Record<OrchardType, number>,
  livestock: { chicken: 200, sheep: 300, cattle: 450 } as Record<LivestockType, number>,
};

/** Typical stock range per resource for a merchant (units). */
function stockRange(r: ResourceType): [number, number] {
  switch (r) {
    case 'tool': return [10, 35];
    case 'leatherCoat':
    case 'woolCoat': return [8, 25];
    case 'leather':
    case 'wool': return [20, 60];
    case 'herbs': return [30, 80];
    case 'ale': return [25, 80];
    case 'iron': return [30, 100];
    case 'stone':
    case 'log': return [60, 160];
    case 'firewood': return [80, 220];
    default: return RESOURCES[r]?.category === 'food' ? [60, 220] : [20, 60];
  }
}

function priceFor(rng: Rng, r: ResourceType): number {
  const value = RESOURCES[r]?.value ?? 1;
  const markup = rng.range(1.15, 1.6);
  return Math.max(1, Math.round(value * markup * 2) / 2);
}

function resourceOffer(rng: Rng, r: ResourceType): MerchantOffer {
  const [lo, hi] = stockRange(r);
  const amount = Math.max(5, Math.round(rng.range(lo, hi) / 5) * 5);
  return { kind: 'resource', id: r, amount, price: priceFor(rng, r) };
}

function pickDistinct<T>(rng: Rng, pool: readonly T[], n: number): T[] {
  const copy = rng.shuffle([...pool]);
  return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
}

export function lockedCrops(s: GameState): CropType[] {
  return (Object.keys(CROPS) as CropType[]).filter((c) => !s.unlocked.crops.includes(c));
}
export function lockedOrchards(s: GameState): OrchardType[] {
  return (Object.keys(ORCHARDS) as OrchardType[]).filter((c) => !s.unlocked.orchards.includes(c));
}
export function lockedLivestock(s: GameState): LivestockType[] {
  return (Object.keys(LIVESTOCK) as LivestockType[]).filter((c) => !s.unlocked.livestock.includes(c));
}

function unlockOffer(rng: Rng, kind: 'crop' | 'orchard' | 'livestock', id: CropType | OrchardType | LivestockType): MerchantOffer {
  const base = (UNLOCK_PRICES[kind] as Record<string, number>)[id] ?? 250;
  return { kind, id, amount: 1, price: Math.round((base * rng.range(0.9, 1.15)) / 5) * 5 };
}

/** Pick a merchant kind at random, skipping seed/livestock traders when there's nothing left to unlock. */
export function randomMerchantKind(rng: Rng, s: GameState): MerchantKind {
  const weights: [MerchantKind, number][] = [
    ['general', 3],
    ['food', 2.5],
    ['goods', 2.5],
    ['seeds', lockedCrops(s).length + lockedOrchards(s).length > 0 ? 1.2 : 0],
    ['livestock', lockedLivestock(s).length > 0 ? 1 : 0],
  ];
  let total = 0;
  for (const [, w] of weights) total += w;
  let x = rng.next() * total;
  for (const [k, w] of weights) {
    x -= w;
    if (x < 0) return k;
  }
  return 'general';
}

const GOODS: ResourceType[] = ['tool', 'leatherCoat', 'woolCoat', 'leather', 'wool', 'herbs', 'ale', 'iron', 'stone', 'log', 'firewood'];
const LIVESTOCK_GOODS: ResourceType[] = ['mutton', 'beef', 'chicken', 'eggs', 'leather', 'wool'];
const SEED_GOODS: ResourceType[] = ['wheat', 'corn', 'potato', 'beans', 'apple', 'pear', 'cherry'];

/** Generate the offers a merchant of the given kind brings. */
export function generateOffers(rng: Rng, s: GameState, kind: MerchantKind): MerchantOffer[] {
  const offers: MerchantOffer[] = [];
  switch (kind) {
    case 'food':
      for (const r of pickDistinct(rng, FOOD_TYPES, rng.int(4, 6))) offers.push(resourceOffer(rng, r));
      break;
    case 'goods':
      for (const r of pickDistinct(rng, GOODS, rng.int(4, 6))) offers.push(resourceOffer(rng, r));
      break;
    case 'livestock':
      for (const l of lockedLivestock(s)) offers.push(unlockOffer(rng, 'livestock', l));
      for (const r of pickDistinct(rng, LIVESTOCK_GOODS, rng.int(2, 3))) offers.push(resourceOffer(rng, r));
      break;
    case 'seeds': {
      const crops = lockedCrops(s);
      const orchards = lockedOrchards(s);
      for (const c of pickDistinct(rng, crops, 3)) offers.push(unlockOffer(rng, 'crop', c));
      for (const o of pickDistinct(rng, orchards, 2)) offers.push(unlockOffer(rng, 'orchard', o));
      for (const r of pickDistinct(rng, SEED_GOODS, rng.int(2, 3))) offers.push(resourceOffer(rng, r));
      break;
    }
    case 'general':
    default: {
      const pool = [...GOODS, ...FOOD_TYPES];
      for (const r of pickDistinct(rng, pool, rng.int(5, 7))) offers.push(resourceOffer(rng, r));
      if (rng.next() < 0.35) {
        const unlocks: MerchantOffer[] = [
          ...lockedCrops(s).map((c) => unlockOffer(rng, 'crop', c)),
          ...lockedOrchards(s).map((o) => unlockOffer(rng, 'orchard', o)),
          ...lockedLivestock(s).map((l) => unlockOffer(rng, 'livestock', l)),
        ];
        if (unlocks.length > 0) offers.unshift(rng.pick(unlocks));
      }
      break;
    }
  }
  return offers;
}

/** Display name for an offer: "Corn seeds", "Apple saplings", "Sheep", "Tools". */
export function offerLabel(offer: Pick<MerchantOffer, 'kind' | 'id'>): string {
  switch (offer.kind) {
    case 'crop': return `${CROPS[offer.id as CropType]?.name ?? offer.id} seeds`;
    case 'orchard': return `${ORCHARDS[offer.id as OrchardType]?.name ?? offer.id} saplings`;
    case 'livestock': return LIVESTOCK[offer.id as LivestockType]?.name ?? String(offer.id);
    default: return RESOURCES[offer.id as ResourceType]?.name ?? String(offer.id);
  }
}

/** Whether an unlock offer is already owned (resource offers: always false). */
export function isOwnedUnlock(s: GameState, offer: Pick<MerchantOffer, 'kind' | 'id'>): boolean {
  switch (offer.kind) {
    case 'crop': return s.unlocked.crops.includes(offer.id as CropType);
    case 'orchard': return s.unlocked.orchards.includes(offer.id as OrchardType);
    case 'livestock': return s.unlocked.livestock.includes(offer.id as LivestockType);
    default: return false;
  }
}
