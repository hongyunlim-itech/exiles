/**
 * Static game content definitions (resources, buildings, crops, livestock, professions).
 * Sim agents may TUNE numbers here; do not rename keys or remove fields.
 */
import type {
  BuildCategory, BuildingType, Climate, CropType, FoodGroup, Inventory, LivestockType, OrchardType,
  Profession, ResourceCategory, ResourceType, StorageKind,
} from './types';

// ---------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------

export interface ResourceDef {
  id: ResourceType;
  name: string;
  category: ResourceCategory;
  foodGroup?: FoodGroup;
  storage: StorageKind;
  /** Trade value per unit. */
  value: number;
  /** Hex colour used for piles / carried goods / UI swatches. */
  color: number;
  icon: string;
}

export const RESOURCES: Record<ResourceType, ResourceDef> = {
  log: { id: 'log', name: 'Logs', category: 'material', storage: 'stockpile', value: 1, color: 0x8a5a2b, icon: '🪵' },
  stone: { id: 'stone', name: 'Stone', category: 'material', storage: 'stockpile', value: 1, color: 0x9a9a96, icon: '🪨' },
  iron: { id: 'iron', name: 'Iron', category: 'material', storage: 'stockpile', value: 2, color: 0x6b5a55, icon: '⛓️' },
  firewood: { id: 'firewood', name: 'Firewood', category: 'fuel', storage: 'stockpile', value: 1, color: 0xb07a3c, icon: '🔥' },
  tool: { id: 'tool', name: 'Tools', category: 'tool', storage: 'barn', value: 8, color: 0x7d8a96, icon: '⚒️' },
  leather: { id: 'leather', name: 'Leather', category: 'textile', storage: 'barn', value: 3, color: 0x8b5e3c, icon: '🟫' },
  wool: { id: 'wool', name: 'Wool', category: 'textile', storage: 'barn', value: 3, color: 0xeee8d8, icon: '🧶' },
  leatherCoat: { id: 'leatherCoat', name: 'Leather Coats', category: 'clothing', storage: 'barn', value: 10, color: 0x7a4a26, icon: '🧥' },
  woolCoat: { id: 'woolCoat', name: 'Wool Coats', category: 'clothing', storage: 'barn', value: 10, color: 0xd9d2bf, icon: '🧣' },
  herbs: { id: 'herbs', name: 'Herbs', category: 'health', storage: 'barn', value: 2, color: 0x5d9b4a, icon: '🌿' },
  ale: { id: 'ale', name: 'Ale', category: 'luxury', storage: 'barn', value: 4, color: 0xc9912e, icon: '🍺' },
  berries: { id: 'berries', name: 'Berries', category: 'food', foodGroup: 'fruit', storage: 'barn', value: 1, color: 0x8e2a4a, icon: '🫐' },
  mushrooms: { id: 'mushrooms', name: 'Mushrooms', category: 'food', foodGroup: 'vegetable', storage: 'barn', value: 1, color: 0xc8b89a, icon: '🍄' },
  roots: { id: 'roots', name: 'Roots', category: 'food', foodGroup: 'vegetable', storage: 'barn', value: 1, color: 0x9c6b3e, icon: '🥕' },
  venison: { id: 'venison', name: 'Venison', category: 'food', foodGroup: 'protein', storage: 'barn', value: 2, color: 0x9b3b32, icon: '🍖' },
  fish: { id: 'fish', name: 'Fish', category: 'food', foodGroup: 'protein', storage: 'barn', value: 1, color: 0x6f95b0, icon: '🐟' },
  wheat: { id: 'wheat', name: 'Wheat', category: 'food', foodGroup: 'grain', storage: 'barn', value: 1, color: 0xd9b95a, icon: '🌾' },
  corn: { id: 'corn', name: 'Corn', category: 'food', foodGroup: 'grain', storage: 'barn', value: 1, color: 0xe8c547, icon: '🌽' },
  potato: { id: 'potato', name: 'Potatoes', category: 'food', foodGroup: 'vegetable', storage: 'barn', value: 1, color: 0xb89260, icon: '🥔' },
  beans: { id: 'beans', name: 'Beans', category: 'food', foodGroup: 'vegetable', storage: 'barn', value: 1, color: 0x6e8f3a, icon: '🫘' },
  apple: { id: 'apple', name: 'Apples', category: 'food', foodGroup: 'fruit', storage: 'barn', value: 1, color: 0xc0392b, icon: '🍎' },
  pear: { id: 'pear', name: 'Pears', category: 'food', foodGroup: 'fruit', storage: 'barn', value: 1, color: 0xb5c24a, icon: '🍐' },
  cherry: { id: 'cherry', name: 'Cherries', category: 'food', foodGroup: 'fruit', storage: 'barn', value: 2, color: 0x9e1b2f, icon: '🍒' },
  mutton: { id: 'mutton', name: 'Mutton', category: 'food', foodGroup: 'protein', storage: 'barn', value: 2, color: 0xa8584a, icon: '🥩' },
  beef: { id: 'beef', name: 'Beef', category: 'food', foodGroup: 'protein', storage: 'barn', value: 2, color: 0x8f2f2a, icon: '🥩' },
  eggs: { id: 'eggs', name: 'Eggs', category: 'food', foodGroup: 'protein', storage: 'barn', value: 1, color: 0xf2ead3, icon: '🥚' },
  chicken: { id: 'chicken', name: 'Chicken', category: 'food', foodGroup: 'protein', storage: 'barn', value: 2, color: 0xe0a878, icon: '🍗' },
};

export const RESOURCE_TYPES = Object.keys(RESOURCES) as ResourceType[];
export const FOOD_TYPES = RESOURCE_TYPES.filter((r) => RESOURCES[r].category === 'food');
export const CLOTHING_TYPES: ResourceType[] = ['woolCoat', 'leatherCoat'];
export const FOOD_GROUP_BIT: Record<FoodGroup, number> = { protein: 1, grain: 2, vegetable: 4, fruit: 8 };
export const FOOD_GROUP_INDEX: Record<FoodGroup, number> = { protein: 0, grain: 1, vegetable: 2, fruit: 3 };

export function isFood(r: ResourceType): boolean {
  return RESOURCES[r].category === 'food';
}

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

export interface RecipeDef {
  label: string;
  inputs: Inventory;
  outputs: Inventory;
  /** Worker-seconds per batch. */
  seconds: number;
}

export interface BuildingDef {
  type: BuildingType;
  name: string;
  category: BuildCategory;
  description: string;
  icon: string;
  /** Default footprint at rotation 0: w along X, h along Z. Rotations 1/3 swap them. */
  size: [number, number];
  /** Zones: player drags a rectangle; each side within [min, max]. Rotation ignored. */
  resizable?: { min: number; max: number };
  /** Construction materials. If costPerTile, multiply by footprint tile count (ceil). */
  cost: Inventory;
  costPerTile?: boolean;
  /** Builder-seconds of construction work (perTile when costPerTile). 0 = completes as soon as cleared. */
  buildWork: number;
  maxWorkers: number;
  defaultWorkers: number;
  profession?: Profession;
  /** Work area radius in tiles, measured from the footprint center. */
  workRadius?: number;
  /** Storage buildings: what they store and capacity (perTile => per footprint tile). */
  storage?: { kinds: StorageKind[]; capacity: number; perTile?: boolean };
  /** Houses: max residents. */
  housing?: number;
  /** Houses: firewood consumption multiplier (lower = better insulated). */
  heatEfficiency?: number;
  /** Houses: whether couples can have children here (boarding houses: no). */
  familyHome?: boolean;
  placement?: 'any' | 'shore' | 'mountain';
  /** Footprint tiles are walkable (zones). */
  walkable?: boolean;
  recipes?: RecipeDef[];
  /** Resources the workers keep stocked inside the building (market, hospital herbs, tavern ale). */
  stocks?: ResourceType[] | 'food+goods';
  /** Capacity of a workplace's inventory buffer (outputs waiting for pickup). */
  bufferCapacity?: number;
  /** Unused (letter hotkeys conflict with camera keys). */
  hotkey?: string;
  /** Graves available per tile (cemetery). */
  gravesPerTile?: number;
}

const B = (d: BuildingDef) => d;

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  // ---- housing ----
  woodenHouse: B({
    type: 'woodenHouse', name: 'Wooden House', category: 'housing', icon: '🏠', size: [3, 3],
    description: 'A simple home for one family. Burns plenty of firewood in winter.',
    cost: { log: 16, stone: 8 }, buildWork: 80, maxWorkers: 0, defaultWorkers: 0,
    housing: 5, heatEfficiency: 1, familyHome: true,
  }),
  stoneHouse: B({
    type: 'stoneHouse', name: 'Stone House', category: 'housing', icon: '🏡', size: [3, 3],
    description: 'A warm stone home for one family. Uses far less firewood.',
    cost: { log: 8, stone: 50, iron: 16 }, buildWork: 180, maxWorkers: 0, defaultWorkers: 0,
    housing: 5, heatEfficiency: 0.45, familyHome: true,
  }),
  boardingHouse: B({
    type: 'boardingHouse', name: 'Boarding House', category: 'housing', icon: '🏘️', size: [4, 5],
    description: 'Crowded housing for up to 20 single adults. No children are born here.',
    cost: { log: 34, stone: 24 }, buildWork: 160, maxWorkers: 0, defaultWorkers: 0,
    housing: 20, heatEfficiency: 1.8, familyHome: false,
  }),

  // ---- storage ----
  stockpile: B({
    type: 'stockpile', name: 'Stockpile', category: 'storage', icon: '📦', size: [4, 4],
    description: 'An open area for storing logs, stone, iron and firewood.',
    resizable: { min: 2, max: 12 }, cost: {}, buildWork: 0, maxWorkers: 0, defaultWorkers: 0,
    storage: { kinds: ['stockpile'], capacity: 25, perTile: true }, walkable: true,
  }),
  storageBarn: B({
    type: 'storageBarn', name: 'Storage Barn', category: 'storage', icon: '🛖', size: [4, 5],
    description: 'Keeps food, tools, clothing and goods safe from the weather.',
    cost: { log: 60, stone: 20, iron: 10 }, buildWork: 150, maxWorkers: 0, defaultWorkers: 0,
    storage: { kinds: ['barn'], capacity: 4000 },
  }),

  // ---- food ----
  gathererHut: B({
    type: 'gathererHut', name: "Gatherer's Hut", category: 'food', icon: '🧺', size: [3, 3],
    description: 'Gatherers collect berries, mushrooms and roots from nearby forest. Needs trees in range; nothing grows in winter.',
    cost: { log: 30, stone: 12 }, buildWork: 90, maxWorkers: 4, defaultWorkers: 4, profession: 'gatherer',
    workRadius: 14, bufferCapacity: 60,
  }),
  hunterCabin: B({
    type: 'hunterCabin', name: 'Hunting Cabin', category: 'food', icon: '🏹', size: [3, 3],
    description: 'Hunters track deer in the surrounding forest for venison and leather.',
    cost: { log: 34, stone: 12 }, buildWork: 90, maxWorkers: 3, defaultWorkers: 3, profession: 'hunter',
    workRadius: 26, bufferCapacity: 60,
  }),
  fishingDock: B({
    type: 'fishingDock', name: 'Fishing Dock', category: 'food', icon: '🎣', size: [3, 4],
    description: 'Fishermen catch fish all year round. Must be built on the water\'s edge.',
    cost: { log: 32, stone: 24 }, buildWork: 100, maxWorkers: 4, defaultWorkers: 4, profession: 'fisherman',
    workRadius: 10, placement: 'shore', bufferCapacity: 60,
  }),
  cropField: B({
    type: 'cropField', name: 'Crop Field', category: 'food', icon: '🌾', size: [8, 8],
    description: 'Farmers plant in spring and harvest in autumn. Unharvested crops are lost to frost.',
    resizable: { min: 4, max: 15 }, cost: {}, buildWork: 0, maxWorkers: 6, defaultWorkers: 3, profession: 'farmer',
    walkable: true, bufferCapacity: 400,
  }),
  orchard: B({
    type: 'orchard', name: 'Orchard', category: 'food', icon: '🍎', size: [8, 8],
    description: 'Fruit trees take a couple of years to mature, then yield every autumn.',
    resizable: { min: 4, max: 12 }, cost: {}, buildWork: 0, maxWorkers: 6, defaultWorkers: 3, profession: 'farmer',
    walkable: true, bufferCapacity: 400,
  }),
  pasture: B({
    type: 'pasture', name: 'Pasture', category: 'food', icon: '🐑', size: [10, 10],
    description: 'Herders raise livestock for meat and wool, leather or eggs. Requires livestock bought from a merchant.',
    resizable: { min: 6, max: 16 }, cost: { log: 30 }, buildWork: 60, maxWorkers: 2, defaultWorkers: 1, profession: 'herder',
    walkable: true, bufferCapacity: 200,
  }),

  // ---- resources ----
  foresterLodge: B({
    type: 'foresterLodge', name: "Forester's Lodge", category: 'resources', icon: '🌲', size: [3, 3],
    description: 'Foresters plant saplings and cut down mature trees for logs.',
    cost: { log: 32, stone: 12 }, buildWork: 90, maxWorkers: 4, defaultWorkers: 4, profession: 'forester',
    workRadius: 12, bufferCapacity: 80,
  }),
  woodcutter: B({
    type: 'woodcutter', name: 'Woodcutter', category: 'resources', icon: '🪓', size: [3, 3],
    description: 'Splits logs into firewood to keep homes warm.',
    cost: { log: 30, stone: 12 }, buildWork: 80, maxWorkers: 2, defaultWorkers: 1, profession: 'woodcutter',
    recipes: [{ label: 'Firewood', inputs: { log: 1 }, outputs: { firewood: 3 }, seconds: 5 }], bufferCapacity: 60,
  }),
  quarry: B({
    type: 'quarry', name: 'Quarry', category: 'resources', icon: '⛏️', size: [8, 8],
    description: 'Stonecutters cut stone (and the odd bit of iron) from the ground.',
    cost: { log: 40 }, buildWork: 150, maxWorkers: 8, defaultWorkers: 4, profession: 'stonecutter',
    bufferCapacity: 100,
  }),
  mine: B({
    type: 'mine', name: 'Mine', category: 'resources', icon: '⚒️', size: [5, 5],
    description: 'Miners dig iron from the mountain. Must be placed against a mountain. Accidents happen.',
    cost: { log: 60, stone: 40 }, buildWork: 180, maxWorkers: 6, defaultWorkers: 4, profession: 'miner',
    placement: 'mountain', bufferCapacity: 100,
  }),
  blacksmith: B({
    type: 'blacksmith', name: 'Blacksmith', category: 'resources', icon: '🔨', size: [4, 4],
    description: 'Forges tools from iron and logs. Workers without tools work slowly.',
    cost: { log: 50, stone: 24, iron: 16 }, buildWork: 160, maxWorkers: 2, defaultWorkers: 1, profession: 'blacksmith',
    recipes: [{ label: 'Iron Tools', inputs: { iron: 1, log: 1 }, outputs: { tool: 1 }, seconds: 28 }], bufferCapacity: 40,
  }),
  tailor: B({
    type: 'tailor', name: 'Tailor', category: 'resources', icon: '🧵', size: [4, 3],
    description: 'Sews warm coats from leather or wool.',
    cost: { log: 45, stone: 20, iron: 20 }, buildWork: 140, maxWorkers: 2, defaultWorkers: 1, profession: 'tailor',
    recipes: [
      { label: 'Leather Coat', inputs: { leather: 2 }, outputs: { leatherCoat: 1 }, seconds: 24 },
      { label: 'Wool Coat', inputs: { wool: 2 }, outputs: { woolCoat: 1 }, seconds: 24 },
    ], bufferCapacity: 40,
  }),
  herbalist: B({
    type: 'herbalist', name: 'Herbalist', category: 'resources', icon: '🌿', size: [3, 3],
    description: 'Collects medicinal herbs from the forest. Herbs keep people healthy.',
    cost: { log: 30, stone: 12 }, buildWork: 90, maxWorkers: 2, defaultWorkers: 2, profession: 'herbalist',
    workRadius: 12, bufferCapacity: 60,
  }),
  brewery: B({
    type: 'brewery', name: 'Brewery', category: 'resources', icon: '🍺', size: [4, 4],
    description: 'Brews ale from grain or fruit. Taverns serve it to lift spirits.',
    cost: { log: 40, stone: 30, iron: 10 }, buildWork: 140, maxWorkers: 2, defaultWorkers: 1, profession: 'brewer',
    recipes: [
      { label: 'Wheat Ale', inputs: { wheat: 4 }, outputs: { ale: 3 }, seconds: 20 },
      { label: 'Corn Ale', inputs: { corn: 4 }, outputs: { ale: 3 }, seconds: 20 },
      { label: 'Cider', inputs: { apple: 4 }, outputs: { ale: 3 }, seconds: 20 },
      { label: 'Perry', inputs: { pear: 4 }, outputs: { ale: 3 }, seconds: 20 },
      { label: 'Cherry Wine', inputs: { cherry: 4 }, outputs: { ale: 3 }, seconds: 20 },
    ], bufferCapacity: 40,
  }),

  // ---- town ----
  well: B({
    type: 'well', name: 'Well', category: 'town', icon: '🪣', size: [2, 2],
    description: 'Provides water for fighting fires nearby and slightly improves health.',
    cost: { log: 4, stone: 30 }, buildWork: 60, maxWorkers: 0, defaultWorkers: 0, workRadius: 14,
  }),
  school: B({
    type: 'school', name: 'School', category: 'town', icon: '🏫', size: [4, 5],
    description: 'Children nearby study until 14. Educated adults work faster.',
    cost: { log: 48, stone: 32, iron: 16 }, buildWork: 180, maxWorkers: 2, defaultWorkers: 1, profession: 'teacher',
    workRadius: 26,
  }),
  hospital: B({
    type: 'hospital', name: 'Hospital', category: 'town', icon: '⚕️', size: [5, 5],
    description: 'Healers use herbs to cure disease among nearby residents.',
    cost: { log: 64, stone: 40, iron: 20 }, buildWork: 200, maxWorkers: 2, defaultWorkers: 1, profession: 'healer',
    workRadius: 30, stocks: ['herbs'], bufferCapacity: 100,
  }),
  chapel: B({
    type: 'chapel', name: 'Chapel', category: 'town', icon: '⛪', size: [5, 6],
    description: 'A priest raises the happiness of everyone living nearby.',
    cost: { log: 56, stone: 88, iron: 24 }, buildWork: 260, maxWorkers: 1, defaultWorkers: 1, profession: 'priest',
    workRadius: 26,
  }),
  tavern: B({
    type: 'tavern', name: 'Tavern', category: 'town', icon: '🍻', size: [4, 5],
    description: 'Serves ale to nearby residents, greatly improving happiness.',
    cost: { log: 60, stone: 40, iron: 12 }, buildWork: 180, maxWorkers: 2, defaultWorkers: 1, profession: 'tavernkeeper',
    workRadius: 26, stocks: ['ale'], bufferCapacity: 200,
  }),
  market: B({
    type: 'market', name: 'Market', category: 'town', icon: '🏪', size: [7, 7],
    description: 'Vendors stock food and goods here so nearby families don\'t walk to distant barns.',
    cost: { log: 58, stone: 40, iron: 12 }, buildWork: 200, maxWorkers: 4, defaultWorkers: 3, profession: 'vendor',
    workRadius: 26, storage: { kinds: ['barn', 'stockpile'], capacity: 3000 }, stocks: 'food+goods',
  }),
  tradingPost: B({
    type: 'tradingPost', name: 'Trading Post', category: 'town', icon: '⛵', size: [5, 6],
    description: 'Merchants dock here to trade goods, seeds and livestock. Must be built on the water\'s edge.',
    cost: { log: 90, stone: 60, iron: 30 }, buildWork: 260, maxWorkers: 2, defaultWorkers: 1, profession: 'trader',
    placement: 'shore', storage: { kinds: ['barn', 'stockpile'], capacity: 3000 },
  }),
  townHall: B({
    type: 'townHall', name: 'Town Hall', category: 'town', icon: '🏛️', size: [5, 6],
    description: 'Keeps the town records. Nomads seeking a home may arrive here.',
    cost: { log: 60, stone: 60, iron: 30 }, buildWork: 240, maxWorkers: 0, defaultWorkers: 0,
  }),
  cemetery: B({
    type: 'cemetery', name: 'Cemetery', category: 'town', icon: '🪦', size: [6, 6],
    description: 'A resting place for the departed. Without graves, people grieve.',
    resizable: { min: 3, max: 10 }, cost: { stone: 1 }, costPerTile: true, buildWork: 2, maxWorkers: 0, defaultWorkers: 0,
    walkable: true, gravesPerTile: 0.5,
  }),
};

export const BUILDING_TYPES = Object.keys(BUILDINGS) as BuildingType[];

export const BUILD_CATEGORIES: { id: BuildCategory; name: string; icon: string }[] = [
  { id: 'housing', name: 'Housing', icon: '🏠' },
  { id: 'storage', name: 'Storage', icon: '📦' },
  { id: 'food', name: 'Food Production', icon: '🌾' },
  { id: 'resources', name: 'Resources & Industry', icon: '⚒️' },
  { id: 'town', name: 'Town Services', icon: '🏛️' },
];

export const ROAD_DEFS = {
  dirt: { name: 'Dirt Road', cost: {} as Inventory, work: 1, description: 'Speeds up travel.' },
  stone: { name: 'Stone Road', cost: { stone: 1 } as Inventory, work: 3, description: 'Speeds up travel even more. Costs stone.' },
  /** Bridge cost per water tile. */
  bridge: { name: 'Bridge', cost: { log: 4, stone: 4 } as Inventory, work: 20, description: 'Crosses shallow water.' },
} as const;

// ---------------------------------------------------------------------------------------------
// Farming
// ---------------------------------------------------------------------------------------------

export interface CropDef {
  id: CropType;
  name: string;
  resource: ResourceType;
  /** Months from planting to ripe at full farmer attention. */
  growMonths: number;
  /** Food units harvested per field tile. */
  yieldPerTile: number;
  /** Render colours: young plant, ripe plant. */
  colorYoung: number;
  colorRipe: number;
  /** Visual height of a ripe plant (world units). */
  height: number;
}

export const CROPS: Record<CropType, CropDef> = {
  wheat: { id: 'wheat', name: 'Wheat', resource: 'wheat', growMonths: 4.5, yieldPerTile: 9, colorYoung: 0x7fae4a, colorRipe: 0xd8b55a, height: 0.35 },
  corn: { id: 'corn', name: 'Corn', resource: 'corn', growMonths: 5, yieldPerTile: 10, colorYoung: 0x5e9a3c, colorRipe: 0xc8b24a, height: 0.55 },
  potato: { id: 'potato', name: 'Potatoes', resource: 'potato', growMonths: 4, yieldPerTile: 9, colorYoung: 0x4f8f3a, colorRipe: 0x6e8a3c, height: 0.2 },
  beans: { id: 'beans', name: 'Beans', resource: 'beans', growMonths: 3.5, yieldPerTile: 8, colorYoung: 0x5a9d3e, colorRipe: 0x4f7d2f, height: 0.3 },
};

export interface OrchardDef {
  id: OrchardType;
  name: string;
  resource: ResourceType;
  /** Years to reach maturity 1. */
  matureYears: number;
  yieldPerTile: number;
  fruitColor: number;
  blossomColor: number;
}

export const ORCHARDS: Record<OrchardType, OrchardDef> = {
  apple: { id: 'apple', name: 'Apple', resource: 'apple', matureYears: 2, yieldPerTile: 8, fruitColor: 0xc0392b, blossomColor: 0xf6dfe6 },
  pear: { id: 'pear', name: 'Pear', resource: 'pear', matureYears: 2.5, yieldPerTile: 8.5, fruitColor: 0xb5c24a, blossomColor: 0xfbf7ee },
  cherry: { id: 'cherry', name: 'Cherry', resource: 'cherry', matureYears: 3, yieldPerTile: 7.5, fruitColor: 0x9e1b2f, blossomColor: 0xf7c4d8 },
};

export interface LivestockDef {
  id: LivestockType;
  name: string;
  meat: ResourceType;
  /** Secondary product (wool/leather/eggs). */
  product: ResourceType;
  /** Pasture tiles needed per animal. */
  tilesPerAnimal: number;
  meatPerAnimal: number;
  /** Product units per animal per year. */
  productPerYear: number;
  /** Breeding: fraction of herd added per year when there is room. */
  breedRate: number;
  color: number;
  scale: number;
}

export const LIVESTOCK: Record<LivestockType, LivestockDef> = {
  sheep: { id: 'sheep', name: 'Sheep', meat: 'mutton', product: 'wool', tilesPerAnimal: 6, meatPerAnimal: 30, productPerYear: 6, breedRate: 0.8, color: 0xf0ede4, scale: 0.9 },
  cattle: { id: 'cattle', name: 'Cattle', meat: 'beef', product: 'leather', tilesPerAnimal: 10, meatPerAnimal: 60, productPerYear: 3, breedRate: 0.5, color: 0x6b4a33, scale: 1.3 },
  chicken: { id: 'chicken', name: 'Chickens', meat: 'chicken', product: 'eggs', tilesPerAnimal: 2, meatPerAnimal: 6, productPerYear: 20, breedRate: 1.5, color: 0xf5f0e6, scale: 0.45 },
};

// ---------------------------------------------------------------------------------------------
// Professions
// ---------------------------------------------------------------------------------------------

export interface ProfessionDef {
  id: Profession;
  name: string;
  /** Tunic colour for render. */
  color: number;
  icon: string;
  /** Workplace building types (empty for laborer/builder/child/student). */
  workplaces: BuildingType[];
}

export const PROFESSIONS: Record<Profession, ProfessionDef> = {
  child: { id: 'child', name: 'Child', color: 0xd9c9a3, icon: '🧒', workplaces: [] },
  student: { id: 'student', name: 'Student', color: 0x6c8fb3, icon: '📖', workplaces: [] },
  laborer: { id: 'laborer', name: 'Laborer', color: 0x8c7a5b, icon: '🧑‍🔧', workplaces: [] },
  builder: { id: 'builder', name: 'Builder', color: 0xc47a2c, icon: '👷', workplaces: [] },
  farmer: { id: 'farmer', name: 'Farmer', color: 0xa3a04a, icon: '🧑‍🌾', workplaces: ['cropField', 'orchard'] },
  herder: { id: 'herder', name: 'Herder', color: 0x7a9a5a, icon: '🐑', workplaces: ['pasture'] },
  gatherer: { id: 'gatherer', name: 'Gatherer', color: 0x9a4a6a, icon: '🧺', workplaces: ['gathererHut'] },
  hunter: { id: 'hunter', name: 'Hunter', color: 0x5a4a3a, icon: '🏹', workplaces: ['hunterCabin'] },
  fisherman: { id: 'fisherman', name: 'Fisherman', color: 0x4a6a8a, icon: '🎣', workplaces: ['fishingDock'] },
  forester: { id: 'forester', name: 'Forester', color: 0x3f6b3a, icon: '🌲', workplaces: ['foresterLodge'] },
  woodcutter: { id: 'woodcutter', name: 'Woodcutter', color: 0x8a4a2a, icon: '🪓', workplaces: ['woodcutter'] },
  stonecutter: { id: 'stonecutter', name: 'Stonecutter', color: 0x8a8a8a, icon: '⛏️', workplaces: ['quarry'] },
  miner: { id: 'miner', name: 'Miner', color: 0x4a4a52, icon: '⚒️', workplaces: ['mine'] },
  blacksmith: { id: 'blacksmith', name: 'Blacksmith', color: 0x3a3a3a, icon: '🔨', workplaces: ['blacksmith'] },
  tailor: { id: 'tailor', name: 'Tailor', color: 0x8a5aa0, icon: '🧵', workplaces: ['tailor'] },
  herbalist: { id: 'herbalist', name: 'Herbalist', color: 0x5aa05a, icon: '🌿', workplaces: ['herbalist'] },
  brewer: { id: 'brewer', name: 'Brewer', color: 0xb08a3a, icon: '🍺', workplaces: ['brewery'] },
  vendor: { id: 'vendor', name: 'Vendor', color: 0xc05a3a, icon: '🏪', workplaces: ['market'] },
  teacher: { id: 'teacher', name: 'Teacher', color: 0x3a5aa0, icon: '🏫', workplaces: ['school'] },
  healer: { id: 'healer', name: 'Healer', color: 0xe8e8e8, icon: '⚕️', workplaces: ['hospital'] },
  priest: { id: 'priest', name: 'Priest', color: 0x2a2a40, icon: '⛪', workplaces: ['chapel'] },
  tavernkeeper: { id: 'tavernkeeper', name: 'Tavern Keeper', color: 0x9a6a3a, icon: '🍻', workplaces: ['tavern'] },
  trader: { id: 'trader', name: 'Trader', color: 0x2a7a7a, icon: '⛵', workplaces: ['tradingPost'] },
};

export const PROFESSION_TYPES = Object.keys(PROFESSIONS) as Profession[];

// ---------------------------------------------------------------------------------------------
// Calendar & climate
// ---------------------------------------------------------------------------------------------

export const MONTH_NAMES = [
  'Early Spring', 'Spring', 'Late Spring',
  'Early Summer', 'Summer', 'Late Summer',
  'Early Autumn', 'Autumn', 'Late Autumn',
  'Early Winter', 'Winter', 'Late Winter',
];

/** Base mean temperature (C) per month for the 'fair' climate. */
export const MONTH_TEMPERATURE = [5, 10, 14, 18, 22, 24, 20, 14, 7, 0, -5, -2];
export const CLIMATE_OFFSET: Record<Climate, number> = { mild: 5, fair: 0, harsh: -6 };

export function seasonOfMonth(month: number): 'spring' | 'summer' | 'autumn' | 'winter' {
  return (['spring', 'summer', 'autumn', 'winter'] as const)[Math.floor(month / 3) % 4];
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const MALE_NAMES = [
  'Aldric', 'Bram', 'Cedric', 'Dunstan', 'Edmund', 'Finn', 'Godric', 'Harold', 'Ivo', 'Jasper', 'Kenric', 'Leofric',
  'Merek', 'Nyle', 'Osric', 'Piers', 'Quentin', 'Randall', 'Symon', 'Tobias', 'Ulric', 'Wystan', 'Alard', 'Bertram',
  'Colin', 'Denys', 'Everard', 'Fulk', 'Gilbert', 'Hamon', 'Jocelin', 'Lambert', 'Miles', 'Norman', 'Oswin', 'Rolf',
  'Seward', 'Thurstan', 'Walter', 'Wat', 'Hugh', 'Roger', 'Robin', 'Geoffrey', 'Anselm', 'Baldwin', 'Conrad', 'Eadric',
];

export const FEMALE_NAMES = [
  'Adela', 'Beatrix', 'Cecily', 'Dionisia', 'Edith', 'Felicia', 'Gunnora', 'Hawise', 'Isolde', 'Joan', 'Katherine',
  'Lettice', 'Mabel', 'Nicola', 'Odelina', 'Petronilla', 'Rosamund', 'Sibyl', 'Tiffany', 'Ursula', 'Wymarc', 'Agnes',
  'Alice', 'Amice', 'Avelina', 'Clarice', 'Elena', 'Emma', 'Galiena', 'Helewise', 'Idonea', 'Juliana', 'Lucia',
  'Margery', 'Matilda', 'Maud', 'Millicent', 'Rohesia', 'Sabina', 'Sarra', 'Ysmay', 'Eleanor', 'Gisela', 'Hilda',
];

export const SURNAMES = [
  'Ashdown', 'Blackwood', 'Carter', 'Dale', 'Fletcher', 'Green', 'Hollis', 'Marsh', 'Miller', 'Oakes', 'Price',
  'Reed', 'Shaw', 'Thatcher', 'Underwood', 'Webb', 'Wright', 'Yarrow', 'Cooper', 'Fisher', 'Mason', 'Tanner',
];
