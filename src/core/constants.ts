/**
 * Global tuning constants. Sim agents may TUNE values here (keep names). Add new constants at the bottom
 * of the section you own, with a comment.
 */
import type { MapSize } from './types';

export const SAVE_VERSION = 1;

// ---- map -------------------------------------------------------------------------------------
export const MAP_SIZES: Record<MapSize, number> = { small: 128, medium: 160, large: 208 };
/** Height (world units) of the water surface. Tiles whose average corner height is below are water. */
export const WATER_LEVEL = 0;
/** Max corner height difference within a footprint for it to be buildable. */
export const MAX_BUILD_SLOPE = 0.9;

// ---- time ------------------------------------------------------------------------------------
/** Game seconds per month (12 months per year). */
export const MONTH_SECONDS = 60;
export const YEAR_SECONDS = MONTH_SECONDS * 12;
/** Game seconds per day/night cycle (visual only). */
export const DAY_SECONDS = 24;
/** Largest simulation sub-step (game seconds). Game.update splits bigger frames. */
export const MAX_SIM_STEP = 0.25;
export const GAME_SPEEDS = [0, 1, 2, 5, 10] as const;

// ---- citizens --------------------------------------------------------------------------------
/** Tiles per game second on open grass. */
export const WALK_SPEED = 1.6;
/** Path cost multipliers (lower is faster). */
export const COST_GRASS = 1.0;
export const COST_FOREST = 1.35;
export const COST_DIRT_ROAD = 0.6;
export const COST_STONE_ROAD = 0.45;
export const COST_BRIDGE = 0.6;
/** Units a citizen can carry per trip. */
export const CARRY_CAPACITY = 15;
export const ADULT_AGE = 10;
/** With a school, students study from ADULT_AGE until this age. */
export const STUDENT_GRADUATE_AGE = 14;
export const ELDERLY_AGE = 60;
export const LIFESPAN_MIN = 58;
export const LIFESPAN_MAX = 84;
export const MAX_CHILDREN_PER_HOUSE = 5;
/** Food units that restore satiation from 0 to 100 (a meal eats only what is needed to fill up). */
export const MEAL_SIZE = 12;
/** Satiation lost per game second (100 -> 0 in three months; ~48 food per adult per year). */
export const HUNGER_RATE = 100 / (MONTH_SECONDS * 3);
/** Eat when food drops below this. */
export const HUNGER_THRESHOLD = 45;
/** Seconds at food 0 before death by starvation (health also drops, so the weak die sooner). */
export const STARVE_DEATH_SECONDS = MONTH_SECONDS * 4;
export const FREEZE_DEATH_SECONDS = MONTH_SECONDS * 1.2;
/**
 * Tool durability in game seconds of work (incl. walking & hauling for the job): a tool lasts a worker about three
 * years, so the starting stock runs out after 3-5 years and a blacksmith is needed.
 */
export const TOOL_LIFETIME = 30 * MONTH_SECONDS;
/** Coat durability in game seconds (~2 years). */
export const COAT_LIFETIME = 24 * MONTH_SECONDS;
/** Firewood a house burns per game second when temperature is below COLD_TEMP. */
export const FIREWOOD_BURN_RATE = 1 / 16;
/** Temperature (C) below which people get cold outside and houses burn firewood. */
export const COLD_TEMP = 8;

// ---- storage ---------------------------------------------------------------------------------
/** Stockpile capacity per footprint tile. */
export const STOCKPILE_CAPACITY_PER_TILE = 25;
/** Household supply targets: residents keep this much food/firewood at home. */
export const HOUSE_FOOD_TARGET = 60;
export const HOUSE_FIREWOOD_TARGET = 30;
export const HOUSE_CAPACITY = 120;

// ---- nature ----------------------------------------------------------------------------------
/** Logs yielded by a fully grown tree. */
export const LOGS_PER_TREE = 6;
/** Growth per game second for saplings (full growth in ~2 years). */
export const TREE_GROWTH_RATE = 1 / (24 * MONTH_SECONDS);
export const WORK_TIME_CHOP = 6;
export const WORK_TIME_MINE_ROCK = 5;

// ---- render hints ----------------------------------------------------------------------------
/** Visual height of a standing citizen (world units). */
export const CITIZEN_HEIGHT = 0.55;
