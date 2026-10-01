/**
 * Tuning constants for the sim-ext modules (wellbeing, disease, disasters, trade, nomads, stats).
 * OWNER: sim-ext. All times are game seconds unless stated otherwise.
 */
import {
  FREEZE_DEATH_SECONDS, HUNGER_RATE, MEAL_SIZE, MONTH_SECONDS, STARVE_DEATH_SECONDS, YEAR_SECONDS,
} from '../../core/constants';

// ---- wellbeing -------------------------------------------------------------------------------

/** Every citizen's slow factors (service coverage etc.) are re-evaluated once per this many seconds, in batches. */
export const EVAL_PERIOD = 1.0;
/** Service coverage index refresh period. */
export const SERVICE_REFRESH = 2.0;

export const HEALTH_BASE = 70;
export const HAPPINESS_BASE = 50;
/** Time constants (seconds) of the exponential drift toward the target. */
export const HEALTH_TAU_UP = 100;
export const HEALTH_TAU_DOWN = 60;
export const HAPPINESS_TAU = 45;
/** Hard caps on drift speed (points / second). */
export const HEALTH_MAX_RATE = 1.2;
export const HAPPINESS_MAX_RATE = 2.0;

/** Diet variety -> health points, by number of food groups eaten recently (index 0..4). */
export const DIET_HEALTH = [-25, -25, 0, 10, 20];
/** Diet variety -> happiness points. */
export const DIET_HAPPINESS = [0, 0, 3, 7, 10];

export const HERBS_HOME_HEALTH = 8;
export const WELL_HEALTH = 5;
export const HOSPITAL_HEALTH = 4;
export const ELDERLY_HEALTH = -10;

export const CHAPEL_HAPPINESS = 15;
export const TAVERN_HAPPINESS = 15;
export const COAT_HAPPINESS = 5;
export const STONE_HOUSE_HAPPINESS = 5;
export const BOARDING_HOUSE_HAPPINESS = -10;
export const HOMELESS_HAPPINESS = -25;
export const GRIEF_HAPPINESS_FACTOR = 0.3;
export const UNBURIED_HAPPINESS = -10;
export const WELL_HAPPINESS = 3;
export const CHILD_HAPPINESS = 5;
export const HUNGRY_HAPPINESS = -10;
export const COLD_HAPPINESS = -10;
export const SICK_HAPPINESS = -10;
export const UNWELL_HAPPINESS = -8;

/** Grief decays from 100 to 0 in about this long. */
export const GRIEF_DURATION = 8 * MONTH_SECONDS;

/**
 * Acute health drains (points / second) while starving (food 0) / freezing (warmth 0). sim-core also kills after
 * STARVE_DEATH_SECONDS / FREEZE_DEATH_SECONDS at 0; these drains are gentler so a healthy citizen usually lasts
 * about that long, while already-weak citizens succumb sooner.
 */
export const STARVE_DRAIN = 100 / (1.5 * STARVE_DEATH_SECONDS);
export const FREEZE_DRAIN = 100 / (1.5 * FREEZE_DEATH_SECONDS);
/** Untreated disease drain at severity 1 (points / second): ~2 months from full health. */
export const DISEASE_DRAIN = 100 / (2 * MONTH_SECONDS);
/** Hospital treatment reduces the disease drain to this fraction. */
export const TREATED_DRAIN_FACTOR = 0.25;

/**
 * Education gained per second of `studying`. Students only study during school hours (roughly 45% of the day),
 * so ~4 years of schooling gives a full education (1.0).
 */
export const EDUCATION_RATE = 1 / (4 * YEAR_SECONDS * 0.45);

/** A household with residents uses up one herb about this often. */
export const HOUSE_HERB_INTERVAL = 2 * MONTH_SECONDS;
/** Ale a tavern pours per covered citizen per month. */
export const ALE_PER_CITIZEN_MONTH = 0.1;
/** Seconds between moving one unburied body into a free grave. */
export const BURIAL_INTERVAL = 4;

// ---- disease ---------------------------------------------------------------------------------

/**
 * Untreated disease progression (severity / second). Against it work the natural recovery (proportional to health)
 * and the illness running its course (recovery growing with the time spent sick): untreated, an illness lasts 3-6
 * months (resting, not working) and kills roughly one in five of the otherwise healthy — more of the weak (poor diet,
 * old age, cold, hunger); herbs at home cut it to 1-2 months, a hospital to a couple of weeks, and hardly anyone dies.
 */
export const DISEASE_PROGRESS = 0.3 / MONTH_SECONDS;
/** Natural recovery at 100 health (severity / second). */
export const DISEASE_NATURAL_RECOVERY = 0.35 / MONTH_SECONDS;
/** Extra recovery per month already spent sick (severity / second, per month): every illness ends eventually. */
export const DISEASE_COURSE_RECOVERY = 0.1 / MONTH_SECONDS;
/** Extra recovery when the household has herbs (severity / second). */
export const DISEASE_HERB_RECOVERY = 0.25 / MONTH_SECONDS;
/** Recovery while treated by a staffed hospital with herbs (severity / second). */
export const DISEASE_HOSPITAL_RECOVERY = 1.2 / MONTH_SECONDS;
/** Herbs used per treated patient per month (hospital) / per sick person per month (home remedy). */
export const HOSPITAL_HERBS_PER_MONTH = 2;
export const HOME_HERBS_PER_MONTH = 1;
/** Per-second infection chance for each household member at severity 1. */
export const HOUSEHOLD_INFECTION = 0.01;
/** Per-second infection chance for each nearby citizen (within CONTACT_RADIUS) at severity 1. */
export const CONTACT_INFECTION = 0.006;
export const CONTACT_RADIUS = 1.6;
/** After recovering, a citizen is immune for this long. */
export const IMMUNITY_SECONDS = YEAR_SECONDS;
/** Herbs at home multiply infection chance by this. */
export const HERBS_INFECTION_FACTOR = 0.4;

// ---- disasters -------------------------------------------------------------------------------

/** Base fire ignitions per building per year. */
export const FIRE_BASE_RATE = 0.004;
export const FIRE_WORKSHOP_FACTOR = 3;
export const FIRE_SUMMER_FACTOR = 2;
export const FIRE_WELL_FACTOR = 0.3;
export const FIRE_STONE_FACTOR = 0.5;
/** Fire growth per second (0 -> 1 in ~60 s). */
export const FIRE_GROWTH = 1 / 60;
/** Initial intensity of a new fire. */
export const FIRE_START = 0.05;
/** Fire reduction per firefighter per second (only with a well in range). */
export const FIRE_FIGHT_RATE = 0.01;
/** Rain dampens fires by this much per second. */
export const FIRE_RAIN_DAMP = 0.006;
/** Seconds at full intensity before the building is lost. */
export const FIRE_BURNOUT_SECONDS = 20;
/** Burning buildings above this intensity may ignite neighbours within FIRE_SPREAD_RANGE tiles. */
export const FIRE_SPREAD_THRESHOLD = 0.5;
export const FIRE_SPREAD_RANGE = 3;
/**
 * Per-second chance to ignite a touching neighbour at full intensity (falls off linearly with the gap between
 * footprints, reaching 1/4 at FIRE_SPREAD_RANGE). Tuned so a fire with no well typically costs 1–3 buildings in a
 * tightly packed town rather than cascading through it.
 */
export const FIRE_SPREAD_CHANCE = 0.004;
/** Chance a citizen standing inside a collapsing burning building dies. */
export const FIRE_DEATH_CHANCE = 0.35;
/** No random disasters (fire excepted) before this much time has passed. */
export const DISASTER_GRACE = YEAR_SECONDS;
/** Fires don't start by themselves during the first months. */
export const FIRE_GRACE = 4 * MONTH_SECONDS;

/** Tornadoes per summer (chance). */
export const TORNADO_CHANCE_PER_SUMMER = 0.1;
export const TORNADO_SPEED = 2.6;
export const TORNADO_RADIUS = 1.9;
/** Chance a citizen caught by the funnel dies. */
export const TORNADO_DEATH_CHANCE = 0.3;

/** Base disease outbreaks per year (when population >= OUTBREAK_MIN_POP). */
export const OUTBREAK_BASE_RATE = 0.22;
export const OUTBREAK_MIN_POP = 10;
/** Extra yearly outbreak rate added by a merchant visit / accepted nomads; decays over OUTBREAK_RISK_DECAY. */
export const OUTBREAK_RISK_MERCHANT = 0.6;
export const OUTBREAK_RISK_NOMADS = 1.0;
export const OUTBREAK_RISK_DECAY = 3 * MONTH_SECONDS;

// ---- trade & nomads --------------------------------------------------------------------------

export const MERCHANT_STAY = 2 * MONTH_SECONDS;
export const MERCHANT_INTERVAL_MIN = 4 * MONTH_SECONDS;
export const MERCHANT_INTERVAL_MAX = 8 * MONTH_SECONDS;
/** While there is no staffed trading post the first visit is never closer than this. */
export const MERCHANT_FIRST_DELAY = 1.5 * MONTH_SECONDS;
/** Seconds of the boat arrival / departure animation. */
export const MERCHANT_SAIL_SECONDS = 8;
/** Chance a merchant's crew carries sickness ashore (disasters on). */
export const MERCHANT_DISEASE_CHANCE = 0.06;

export const NOMAD_INTERVAL_MIN = 0.75 * YEAR_SECONDS;
export const NOMAD_INTERVAL_MAX = 1.5 * YEAR_SECONDS;
export const NOMAD_FIRST_DELAY = 3 * MONTH_SECONDS;
export const NOMAD_WAIT = MONTH_SECONDS;
export const NOMAD_MIN = 3;
export const NOMAD_MAX = 12;

// ---- stats -----------------------------------------------------------------------------------

export const HISTORY_CAP = 600;
export const ADVISOR_INTERVAL = 5;
export const ADVISOR_COOLDOWN = 2 * MONTH_SECONDS;
/** Estimated food eaten per citizen per month (derived from sim-core constants): MEAL_SIZE units refill satiation
 *  0 -> 100 and satiation drops HUNGER_RATE per second, so an adult eats MEAL_SIZE * HUNGER_RATE * MONTH / 100. */
export const FOOD_PER_CITIZEN_MONTH = (MEAL_SIZE * HUNGER_RATE * MONTH_SECONDS) / 100;
