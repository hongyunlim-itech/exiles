/**
 * SHARED DATA CONTRACT — owned by the architect. Do NOT change existing fields/semantics.
 * Additive changes only (new optional fields) and only when unavoidable; document them in your report.
 *
 * Conventions
 * - Map is W x H tiles. Tile (x, z): integers, 0 <= x < W, 0 <= z < H. Tile index i = z * W + x.
 * - World space: 1 tile = 1 world unit. Tile (x,z) spans [x, x+1] x [z, z+1]; its center is (x+0.5, z+0.5).
 *   Y is up. Terrain height is stored at tile CORNERS: heights[(z)*(W+1) + x] for corner (x,z), 0<=x<=W, 0<=z<=H.
 * - Continuous entity positions (citizens, animals) are in world units (== tile units).
 * - All GameState data is plain JSON-serializable data (plus typed arrays in `tiles`, handled by sim/save.ts).
 *   Runtime-only indexes live on the Game object, not in GameState.
 * - Time unit in the simulation is the "game second". At speed 1x, 1 game second == 1 real second.
 */

// ---------------------------------------------------------------------------------------------
// Enums stored in typed arrays (numeric)
// ---------------------------------------------------------------------------------------------

export enum Terrain {
  Grass = 0,
  Sand = 1,
  /** Shallow water (rivers, lake edges). Not walkable, but roads placed on it become bridges. */
  Water = 2,
  /** Deep water (lake centers). Not walkable, not bridgeable. */
  DeepWater = 3,
  /** Mountain / cliff. Not walkable, not buildable. Mines must be placed adjacent to it. */
  Mountain = 4,
}

export enum Feature {
  None = 0,
  /** featureAmount = growth 0..1 (saplings < 1). */
  Tree = 1,
  /** featureAmount = remaining stone units. */
  Rock = 2,
  /** featureAmount = remaining iron units. */
  Iron = 3,
}

export enum Road {
  None = 0,
  Dirt = 1,
  Stone = 2,
  /** Road placed over shallow Water tile. Walkable. */
  Bridge = 3,
}

/** Per-tile data, structure-of-arrays. Length W*H unless noted. */
export interface TileData {
  /** Corner heights, length (W+1)*(H+1). World units. */
  height: Float32Array;
  terrain: Uint8Array; // Terrain
  feature: Uint8Array; // Feature
  /** Tree: growth 0..1. Rock/Iron: remaining units. */
  featureAmount: Float32Array;
  /** Visual variant for features (tree species: 0 = conifer, 1 = deciduous, 2 = birch; rocks: shape seed). */
  variant: Uint8Array;
  road: Uint8Array; // Road
  /** Building id occupying the tile, or -1. */
  building: Int32Array;
  /** 1 = feature on this tile is marked for removal by the player (or by building placement). */
  marked: Uint8Array;
  /** Connected-component label for walkability (terrain-based + bridges). 0 = not walkable. */
  region: Int32Array;
}

// ---------------------------------------------------------------------------------------------
// String-keyed game content
// ---------------------------------------------------------------------------------------------

export type ResourceType =
  // raw materials (stockpile)
  | 'log' | 'stone' | 'iron' | 'firewood'
  // goods (storage barn)
  | 'tool' | 'leather' | 'wool' | 'leatherCoat' | 'woolCoat' | 'herbs' | 'ale'
  // food (storage barn)
  | 'berries' | 'mushrooms' | 'roots' | 'venison' | 'fish'
  | 'wheat' | 'corn' | 'potato' | 'beans'
  | 'apple' | 'pear' | 'cherry'
  | 'mutton' | 'beef' | 'eggs' | 'chicken';

export type ResourceCategory = 'material' | 'fuel' | 'tool' | 'textile' | 'clothing' | 'health' | 'luxury' | 'food';
export type FoodGroup = 'protein' | 'grain' | 'vegetable' | 'fruit';
/** Which kind of storage holds a resource. */
export type StorageKind = 'stockpile' | 'barn';

export type Inventory = Partial<Record<ResourceType, number>>;

export type BuildingType =
  // roads are not buildings (see Road) — these are placeable structures & zones
  | 'woodenHouse' | 'stoneHouse' | 'boardingHouse'
  | 'stockpile' | 'storageBarn'
  | 'gathererHut' | 'hunterCabin' | 'fishingDock' | 'cropField' | 'orchard' | 'pasture'
  | 'foresterLodge' | 'woodcutter' | 'quarry' | 'mine' | 'blacksmith' | 'tailor' | 'herbalist' | 'brewery'
  | 'well' | 'school' | 'hospital' | 'chapel' | 'tavern' | 'market' | 'tradingPost' | 'townHall' | 'cemetery';

export type BuildCategory = 'housing' | 'storage' | 'food' | 'resources' | 'town';

export type Profession =
  | 'child' | 'student'
  | 'laborer' | 'builder'
  | 'farmer' | 'herder' | 'gatherer' | 'hunter' | 'fisherman'
  | 'forester' | 'woodcutter' | 'stonecutter' | 'miner' | 'blacksmith' | 'tailor' | 'herbalist' | 'brewer'
  | 'vendor' | 'teacher' | 'healer' | 'priest' | 'tavernkeeper' | 'trader';

export type CropType = 'wheat' | 'corn' | 'potato' | 'beans';
export type OrchardType = 'apple' | 'pear' | 'cherry';
export type LivestockType = 'sheep' | 'cattle' | 'chicken';

export type Difficulty = 'easy' | 'medium' | 'hard';
export type Climate = 'mild' | 'fair' | 'harsh';
export type TerrainStyle = 'valleys' | 'mountains' | 'lakes';
export type MapSize = 'small' | 'medium' | 'large';

export interface NewGameSettings {
  seed: number;
  townName: string;
  mapSize: MapSize;
  terrain: TerrainStyle;
  climate: Climate;
  difficulty: Difficulty;
  /** Disasters (fire, tornado, disease) enabled. */
  disasters: boolean;
}

// ---------------------------------------------------------------------------------------------
// Time & weather
// ---------------------------------------------------------------------------------------------

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface TimeState {
  /** Total elapsed game seconds since start. */
  elapsed: number;
  /** 1-based year number. */
  year: number;
  /** 0..11. 0-2 spring (Early/Mid/Late), 3-5 summer, 6-8 autumn, 9-11 winter. */
  month: number;
  /** 0..1 progress within the current month. */
  monthProgress: number;
  /** 0..1 time of day (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset). */
  dayTime: number;
}

export interface WeatherState {
  /** Degrees Celsius. */
  temperature: number;
  /** Ground snow cover 0..1 (render: snow tint on terrain/roofs). */
  snow: number;
  precipitation: 'none' | 'rain' | 'snow';
  /** 0..1 intensity of precipitation (render: particle density). */
  precipIntensity: number;
  /** Wind direction (radians) & strength 0..1 (render: smoke/snow drift). */
  windDir: number;
  windStrength: number;
  /** Sim-internal: intensity the current rain/snow spell is heading for (optional; absent in older saves). */
  precipTarget?: number;
}

// ---------------------------------------------------------------------------------------------
// Citizens
// ---------------------------------------------------------------------------------------------

export type Gender = 'M' | 'F';
export type AgeClass = 'child' | 'student' | 'adult' | 'elderly';

/** What the citizen is doing right now — drives render animation & UI. Owned by sim/behavior.ts. */
export type Activity =
  | 'idle' | 'walking' | 'working' | 'building' | 'hauling' | 'gathering' | 'chopping' | 'mining'
  | 'farming' | 'fishing' | 'hunting' | 'eating' | 'warming' | 'studying' | 'healing' | 'praying'
  | 'firefighting' | 'playing' | 'sick';

export type CauseOfDeath = 'oldAge' | 'starvation' | 'freezing' | 'disease' | 'accident' | 'fire' | 'tornado' | 'childbirth';

export interface Carried {
  type: ResourceType;
  amount: number;
}

export interface Citizen {
  id: number;
  name: string;
  gender: Gender;
  /** Fractional years. */
  age: number;
  /** Age at which this citizen dies of old age (hidden). */
  lifespan: number;
  spouseId: number; // -1 none
  motherId: number; // -1 unknown
  fatherId: number; // -1 unknown
  childIds: number[];
  homeId: number; // -1 homeless
  /** Workplace building id, -1 if none (laborers, builders, children, students have -1). */
  workplaceId: number;
  profession: Profession;

  // ---- needs / wellbeing, all 0..100 ----
  /** Satiation. 100 = just ate, 0 = starving. Written by sim-core. */
  food: number;
  /** Body warmth. 100 = warm. Drops outside in cold weather. Written by sim-core. */
  warmth: number;
  /** Written ONLY by sim/wellbeing.ts. */
  health: number;
  /** Written ONLY by sim/wellbeing.ts. */
  happiness: number;
  /** 0..1, written ONLY by sim/wellbeing.ts (students studying at a school). */
  education: number;
  /** Disease severity 0 = healthy, >0 = sick (0..1). Written ONLY by sim/wellbeing.ts / disasters.ts. */
  sick: number;
  /** Bit flags of FoodGroups eaten recently (1 protein, 2 grain, 4 vegetable, 8 fruit), decays. Written by sim-core. */
  dietMask: number;
  /** Seconds remaining per recent food group (index 0 protein, 1 grain, 2 vegetable, 3 fruit). */
  dietTimers: [number, number, number, number];
  /** Remaining tool durability in game seconds; 0 = no tool. */
  toolWear: number;
  /** Remaining coat durability in game seconds; 0 = no coat. */
  coatWear: number;

  // ---- spatial / behaviour (owned by sim/behavior.ts) ----
  x: number;
  z: number;
  /** Facing angle in radians around Y (0 = +X, PI/2 = +Z). Render uses it. */
  heading: number;
  /** True while moving along a path. */
  moving: boolean;
  activity: Activity;
  /** Human readable current task for UI, e.g. "Hauling 8 Logs to Stockpile". */
  taskLabel: string;
  carrying: Carried | null;
  /** Opaque behaviour state owned by sim/behavior.ts; must be JSON-serializable. Render/UI must not read it. */
  task: unknown;
  /** Opaque path state owned by sim/behavior.ts (tile indices etc.). */
  path: number[] | null;
  pathIndex: number;
  /** Seconds this citizen has spent at food 0 (starving) / warmth 0 (freezing). */
  starveTime: number;
  freezeTime: number;
  /** Game time (elapsed seconds) of birth, for stats. */
  bornAt: number;
  /** 0..100 grief after a family member died. Set to 100 by Game.killCitizen for spouse/parents/children;
   *  decayed and applied to happiness by sim/wellbeing.ts. */
  grief: number;
}

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

export type BuildingState =
  /** Placed; waiting for the tiles to be cleared of trees/rocks. */
  | 'clearing'
  /** Under construction (materials being delivered & builders working). */
  | 'construction'
  | 'active'
  /** Being demolished by laborers (returns part of the materials). */
  | 'demolishing'
  /** Burnt-out ruin; laborers clear it. */
  | 'ruin';

export type Rotation = 0 | 1 | 2 | 3;

/** Per-tile state of a crop field / orchard. */
export interface FieldTile {
  /** 0 = bare, 1 = plowed, 2 = planted/growing, 3 = ripe, 4 = harvested (stubble). */
  stage: number;
  /** Growth 0..1 while stage 2 (ripe when reaching 1). */
  growth: number;
}

export interface LivestockState {
  type: LivestockType;
  /** Animals currently in the pasture. */
  count: number;
  /** 0..1 accumulated breeding progress. */
  breed: number;
  /** 0..1 accumulated secondary-product (wool/leather/eggs) progress. */
  product: number;
}

export interface OrchardState {
  type: OrchardType;
  /** 0..1 tree maturity (orchard trees take ~2-3 years to mature). */
  maturity: number;
  /** 0..1 fruit on the trees this season. */
  fruit: number;
}

export interface Building {
  id: number;
  type: BuildingType;
  /** Min-corner tile of the footprint. Footprint covers [x, x+w) x [z, z+h). */
  x: number;
  z: number;
  /** Footprint size AFTER rotation (for resizable zones: user-chosen size). */
  w: number;
  h: number;
  /** 0: door faces +Z (south/bottom edge), 1: door faces -X (west), 2: door faces -Z (north), 3: door faces +X (east). */
  rotation: Rotation;
  /** Entrance tile (walkable tile just outside the footprint; for walkable zones it may be inside). */
  doorX: number;
  doorZ: number;
  state: BuildingState;
  /** 0..1 construction (or demolition) progress. */
  progress: number;
  /** Materials required for construction (copied from def at placement, scaled for zones). */
  cost: Inventory;
  /** Materials delivered to the site so far. */
  delivered: Inventory;
  /** Materials currently being carried to the site (reserved; not yet delivered). */
  incoming: Inventory;
  /** Remaining builder-seconds of work. */
  workRemaining: number;
  /** Construction priority (builders prefer). */
  priority: boolean;
  /** Player-paused (construction halted or production halted). */
  paused: boolean;

  /** Player-set desired number of workers (0..def.maxWorkers). */
  workersDesired: number;
  workerIds: number[];
  /** Houses: resident citizen ids. */
  residentIds: number[];

  /** Stored goods: storage contents for stockpiles/barns/markets; household supply for houses;
   *  input/output buffer for workplaces. */
  inventory: Inventory;
  /** Amounts in `inventory` already promised to someone who is on the way to pick them up. */
  reservedOut: Inventory;
  /** Capacity promised to deliveries on the way (storage buildings). */
  reservedIn: number;

  /** Fire intensity 0 = not burning, 0..1 burning (1 = fully engulfed). */
  fire: number;
  /** Number of citizens currently fighting this fire (written by behavior each step). */
  fireFighters: number;
  /** Houses: currently heated (has firewood & it's cold) — render chimney smoke. Workshops: producing. */
  smoking: boolean;

  /** Field crop choice / per-tile states (cropField). Row-major over w*h. */
  crop?: CropType;
  fieldTiles?: FieldTile[];
  orchard?: OrchardState;
  livestock?: LivestockState;
  /** Selected recipe index for workshops with multiple recipes (blacksmith, tailor, brewery). */
  recipe?: number;
  /** Production counters: amount produced this year / last year, by resource. */
  producedThisYear: Inventory;
  producedLastYear: Inventory;
  /** Cemetery: number of graves used. */
  graves?: number;
  /** Game time when construction finished (for aging/fire risk). */
  builtAt: number;
}

// ---------------------------------------------------------------------------------------------
// Animals (wild deer herds). Pasture livestock is NOT here (see Building.livestock).
// ---------------------------------------------------------------------------------------------

export interface Animal {
  id: number;
  kind: 'deer';
  x: number;
  z: number;
  heading: number;
  moving: boolean;
  /** Herd identifier (animals of a herd wander together). */
  herd: number;
  /** Citizen id of the hunter targeting this animal, -1 none. Reserved animals stand still. */
  huntedBy: number;
  /** Opaque wander state owned by sim/nature.ts. */
  wander: unknown;
}

// ---------------------------------------------------------------------------------------------
// Trade & nomads
// ---------------------------------------------------------------------------------------------

export type MerchantKind = 'food' | 'goods' | 'livestock' | 'seeds' | 'general';

export interface MerchantOffer {
  /** A resource offered for sale, or a seed/livestock unlock. */
  kind: 'resource' | 'crop' | 'orchard' | 'livestock';
  id: ResourceType | CropType | OrchardType | LivestockType;
  /** Units available (1 for unlocks). */
  amount: number;
  /** Trade value per unit. */
  price: number;
}

export interface Merchant {
  id: number;
  kind: MerchantKind;
  name: string;
  /** Trading post building id where the boat is docked. */
  postId: number;
  offers: MerchantOffer[];
  /** Game seconds until the merchant leaves. */
  leavesIn: number;
  /** 0..1 boat arrival animation (render). */
  arrive: number;
}

export interface TradeState {
  merchant: Merchant | null;
  /** Game seconds until next merchant may arrive. */
  nextArrival: number;
  /** Player-requested merchant kind for the next visit (optional). */
  requested: MerchantKind | null;
}

export interface NomadGroup {
  count: number;
  /** Game seconds left to respond before they leave. */
  expiresIn: number;
  /** Chance (0..1) they carry disease. */
  diseaseRisk: number;
}

// ---------------------------------------------------------------------------------------------
// Messages, stats
// ---------------------------------------------------------------------------------------------

export type MessageSeverity = 'info' | 'good' | 'warning' | 'danger';

export interface GameMessage {
  id: number;
  /** Game elapsed seconds when created. */
  time: number;
  year: number;
  month: number;
  text: string;
  severity: MessageSeverity;
  /** Optional focus target for the UI "go to" button. */
  target?: { kind: 'building' | 'citizen' | 'tile'; id: number };
}

/** Monthly statistics sample (for graphs). */
export interface StatsSample {
  year: number;
  month: number;
  population: number;
  adults: number;
  children: number;
  students: number;
  elderly: number;
  births: number;
  deaths: number;
  food: number;
  firewood: number;
  logs: number;
  stone: number;
  iron: number;
  tools: number;
  clothing: number;
  herbs: number;
  ale: number;
  avgHealth: number;
  avgHappiness: number;
  avgEducation: number;
}

export interface Tally {
  births: number;
  deaths: Partial<Record<CauseOfDeath, number>>;
  /** Births/deaths accumulated since the last monthly StatsSample. */
  monthBirths: number;
  monthDeaths: number;
}

/** Revision counters: bump when the corresponding data changes so renderers can resync lazily. */
export interface Revisions {
  /** Terrain heights or terrain types changed. */
  terrain: number;
  /** Any tile feature (tree/rock/iron) added, removed, grew, or marked/unmarked. */
  features: number;
  /** Roads/bridges changed. */
  roads: number;
  /** Building added/removed/state change (NOT bumped for inventory changes). */
  buildings: number;
  /** Field tile stages/growth changed. */
  fields: number;
}

// ---------------------------------------------------------------------------------------------
// Root state
// ---------------------------------------------------------------------------------------------

export interface GameState {
  version: number;
  settings: NewGameSettings;
  W: number;
  H: number;
  tiles: TileData;
  time: TimeState;
  weather: WeatherState;
  citizens: Citizen[];
  buildings: Building[];
  animals: Animal[];
  /** Next entity id (shared id space for citizens, buildings, animals, messages, merchants). */
  nextId: number;
  /** Seeds/livestock the town has access to. */
  unlocked: { crops: CropType[]; orchards: OrchardType[]; livestock: LivestockType[] };
  /** Player-desired number of builders (global profession). */
  buildersDesired: number;
  trade: TradeState;
  nomads: NomadGroup | null;
  /** Game seconds until the next nomad group may appear (requires a Town Hall). */
  nextNomads: number;
  messages: GameMessage[];
  history: StatsSample[];
  tally: Tally;
  /** Seeded RNG state (mulberry32). */
  rngState: number;
  rev: Revisions;
  /** Dead citizens that could not be buried (no free cemetery graves). Incremented by Game.killCitizen;
   *  sim/wellbeing.ts moves them into graves when cemetery space exists and applies a town-wide happiness penalty. */
  unburied: number;
  /** True once the population reached 0. */
  gameOver: boolean;
  /** Active tornado, if any (render draws a funnel). */
  tornado: { x: number; z: number; dirX: number; dirZ: number; life: number } | null;
  /**
   * Sim-internal state of the sim-ext modules that changes behaviour and must survive save/load (advisor cooldowns,
   * disease immunity, fire burn-out timers, tick phases...). Written on save, read on load. Optional (older saves).
   */
  ext?: SimExtState;
}

/** See GameState.ext. Keys of the records are entity ids / advisor keys. Opaque to everyone but sim-ext. */
export interface SimExtState {
  advisorNext?: Record<string, number>;
  immuneUntil?: Record<string, number>;
  sickSince?: Record<string, number>;
  burnFull?: Record<string, number>;
  consumption?: Record<string, number>;
  tornadoRolled?: number[];
  outbreakRisk?: number;
  outbreakActive?: boolean;
  /** Tick accumulators / cursors (so periodic rolls keep their phase across save/load). */
  timers?: Record<string, number>;
  /** Cached wellbeing evaluation per citizen id: [healthTarget, happinessTarget, treated, herbsHome, homeId]. */
  wellbeing?: Record<string, [number, number, number, number, number]>;
}

// ---------------------------------------------------------------------------------------------
// Placement API types
// ---------------------------------------------------------------------------------------------

export interface PlacementCheck {
  ok: boolean;
  /** Human-readable reason when !ok (e.g. "Must be placed next to water"). */
  reason?: string;
  /** Tile indices inside the footprint that are invalid (render red). */
  blocked: number[];
  /** Tile indices inside the footprint whose trees/rocks/iron will need clearing (render yellow). */
  clearing: number[];
  /** Computed door tile. */
  doorX: number;
  doorZ: number;
}

export type RemovalFilter = 'all' | 'trees' | 'stone' | 'iron';

/** Game speed multiplier. 0 = paused. */
export type GameSpeed = 0 | 1 | 2 | 5 | 10;

// ---------------------------------------------------------------------------------------------
// Events emitted by the simulation (Game.events)
// ---------------------------------------------------------------------------------------------

export interface GameEvents {
  message: GameMessage;
  buildingPlaced: { id: number };
  buildingCompleted: { id: number };
  buildingRemoved: { id: number; type: BuildingType; cause: 'demolish' | 'fire' | 'tornado' | 'cancel' };
  citizenBorn: { id: number };
  citizenDied: { id: number; name: string; cause: CauseOfDeath };
  citizenArrived: { ids: number[] };
  fireStarted: { buildingId: number };
  merchantArrived: { merchantId: number };
  merchantLeft: { merchantId: number };
  nomadsArrived: { count: number };
  seasonChanged: { season: Season; year: number };
  yearChanged: { year: number };
  gameOver: Record<string, never>;
  /** Sound cue hint for audio (chop, hammer, dig, splash, etc.) near a world position. */
  sound: { cue: 'chop' | 'hammer' | 'dig' | 'splash' | 'fire' | 'bell' | 'birth' | 'death' | 'build'; x: number; z: number };
}
