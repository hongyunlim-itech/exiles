/**
 * Behaviour & economy tuning knobs of the simulation core (kept here rather than in core/constants.ts because they
 * are private to sim-core). OWNER: sim-core.
 */
import { MONTH_SECONDS } from '../../core/constants';

// ---- timings (game seconds, before dividing by work efficiency) -------------------------------
export const EAT_TIME = 2.5;
export const BUILD_SLICE = 25;
export const DEMOLISH_SLICE = 25;
export const GATHER_TIME = 8;
export const HUNT_TRACK_TIME = 9;
export const HUNT_TIME = 4;
export const FISH_TIME = 12;
export const PLANT_TREE_TIME = 3;
export const FIELD_PLANT_TIME = 2.4;
export const FIELD_HARVEST_TIME = 2.4;
export const HERD_TIME = 4;
export const EXTRACT_TIME = 20;
export const WARM_MAX_TIME = 30;

// ---- yields ------------------------------------------------------------------------------------
export const GATHER_YIELD = 10;
export const HERB_YIELD = 3;
export const VENISON_YIELD = 20;
export const LEATHER_YIELD = 2;
export const FISH_YIELD = 11;
export const QUARRY_STONE = 4;
export const QUARRY_IRON_CHANCE = 0.1;
export const MINE_IRON = 3;
export const MINE_STONE = 1;
export const MINE_ACCIDENT_CHANCE = 0.0025;
export const CHOP_ACCIDENT_CHANCE = 0.0003;
export const CATTLE_SLAUGHTER_LEATHER = 2;

// ---- needs ------------------------------------------------------------------------------------
/** A food group counts as "eaten recently" for this long. */
export const DIET_MEMORY = 3 * MONTH_SECONDS;
/** Go home to warm up below this warmth (in cold weather). */
export const WARM_THRESHOLD = 42;
/** Interrupt the current task to eat / warm below these levels. */
export const URGENT_FOOD = 15;
/**
 * Below this satiation a worker far from food interrupts non-urgent work as soon as the walk to the nearest food would
 * take (with a margin) about as long as the food they have left - so long hauls never end in starvation.
 */
export const HUNGRY_EARLY = 42;
/** Margin (game seconds) kept when judging whether the food left lasts the walk to a meal. */
export const HUNGER_TRAVEL_MARGIN = 12;
export const URGENT_WARMTH = 20;
/** While food is rationed (town food below about a month) people only eat below this satiation. */
export const RATION_HUNGER_THRESHOLD = 25;
/** Rest at home when disease severity exceeds this. */
export const SICK_REST = 0.35;
export const HOUSE_HERBS_TARGET = 5;
/** Units a household member brings home in one trip. */
export const HOUSEHOLD_CARRY = 45;
export const VENDOR_CARRY = 20;

// ---- behaviour engine ---------------------------------------------------------------------------
/** A* searches allowed per game second (spread over steps), plus a per-step minimum. */
export const PATHS_PER_SECOND = 45;
export const PLANS_PER_SECOND = 80;
/** No task may run longer than this (watchdog). */
export const MAX_TASK_AGE = 100;
/** A single walk may take at most this long. */
export const MAX_WALK_TIME = 80;
/** Blacklist unreachable targets for this long. */
export const BLACKLIST_TIME = 45;
export const IDLE_MIN = 2.5;
export const IDLE_MAX = 5.5;
/** Laborers haul workplace buffers once this much output is waiting. */
export const HAUL_MIN = 10;
/** Max builders on one construction site (plus one per 20 footprint tiles). */
export const SITE_BUILDERS = 4;
/** Firefighters: max per fire and search radius. */
export const MAX_FIREFIGHTERS = 12;
export const FIREFIGHT_RADIUS = 25;
/** Market stock targets. */
export const MARKET_FOOD_TARGET = 500;
export const MARKET_TARGETS: Partial<Record<string, number>> = {
  firewood: 160, tool: 16, leatherCoat: 10, woolCoat: 10, herbs: 30, ale: 40,
};
export const HOSPITAL_HERBS_TARGET = 25;
export const TAVERN_ALE_TARGET = 40;
