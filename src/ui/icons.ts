/** UI icon glyphs & label tables (emoji — resource/building icons come from defs). */
import type {
  Activity, BuildingState, CauseOfDeath, Climate, Difficulty, FoodGroup, MapSize, MerchantKind, MessageSeverity,
  Season, TerrainStyle,
} from '../core/types';

export const SEASON_ICONS: Record<Season, string> = { spring: '🌱', summer: '☀️', autumn: '🍂', winter: '❄️' };
export const SEASON_NAMES: Record<Season, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };

export const FOOD_GROUPS: FoodGroup[] = ['protein', 'grain', 'vegetable', 'fruit'];
export const FOOD_GROUP_ICONS: Record<FoodGroup, string> = { protein: '🍖', grain: '🌾', vegetable: '🥕', fruit: '🍎' };
export const FOOD_GROUP_NAMES: Record<FoodGroup, string> = { protein: 'Protein', grain: 'Grain', vegetable: 'Vegetables', fruit: 'Fruit' };

export const ICON = {
  food: '🍞',
  coat: '🧥',
  people: '👤',
  student: '🎓',
  child: '🧒',
  elderly: '🧓',
  homeless: '⛺',
  sick: '🤒',
  house: '🏠',
  pause: '⏸',
  play: '▶',
  menu: '☰',
  close: '✕',
  focus: '🎯',
  follow: '👁',
  fire: '🔥',
  merchant: '⛵',
  nomads: '🏕️',
  warning: '⚠️',
  temp: '🌡️',
  rain: '🌧️',
  snow: '🌨️',
  heart: '❤️',
  smile: '😊',
  book: '📖',
  tool: '⚒️',
  road: '🛤️',
  clear: '🪓',
  unclear: '↩️',
  demolish: '💥',
  removeRoad: '🚧',
  grave: '🪦',
  priority: '⭐',
  male: '♂',
  female: '♀',
  dice: '🎲',
  save: '💾',
  trash: '🗑️',
  goTo: '➜',
  professions: '👷',
  overview: '📋',
  citizens: '👪',
  log: '📜',
  stats: '📈',
  help: '❔',
  trade: '⚖️',
} as const;

export const STATE_LABELS: Record<BuildingState, string> = {
  clearing: 'Clearing site',
  construction: 'Under construction',
  active: 'Active',
  demolishing: 'Being demolished',
  ruin: 'Burnt ruins',
};

export const ACTIVITY_LABELS: Record<Activity, string> = {
  idle: 'Idle',
  walking: 'Walking',
  working: 'Working',
  building: 'Building',
  hauling: 'Hauling',
  gathering: 'Gathering',
  chopping: 'Chopping',
  mining: 'Mining',
  farming: 'Farming',
  fishing: 'Fishing',
  hunting: 'Hunting',
  eating: 'Eating',
  warming: 'Warming up',
  studying: 'Studying',
  healing: 'Healing',
  praying: 'Praying',
  firefighting: 'Fighting a fire',
  playing: 'Playing',
  sick: 'Sick in bed',
};

export const DEATH_CAUSE_LABELS: Record<CauseOfDeath, string> = {
  oldAge: 'Old age',
  starvation: 'Starvation',
  freezing: 'Freezing',
  disease: 'Disease',
  accident: 'Accidents',
  fire: 'Fire',
  tornado: 'Tornado',
  childbirth: 'Childbirth',
};

export const SEVERITY_ICONS: Record<MessageSeverity, string> = { info: 'ℹ️', good: '✔️', warning: '⚠️', danger: '❗' };
export const SEVERITY_LABELS: Record<MessageSeverity, string> = { info: 'Info', good: 'Good news', warning: 'Warnings', danger: 'Danger' };

export const MERCHANT_KINDS: { id: MerchantKind; name: string; icon: string; desc: string }[] = [
  { id: 'food', name: 'Food', icon: '🍎', desc: 'Brings provisions of many kinds.' },
  { id: 'goods', name: 'Goods', icon: '⚒️', desc: 'Brings tools, coats, materials and luxuries.' },
  { id: 'livestock', name: 'Livestock', icon: '🐑', desc: 'May sell new kinds of livestock for pastures.' },
  { id: 'seeds', name: 'Seeds', icon: '🌱', desc: 'May sell new crop seeds and orchard saplings.' },
  { id: 'general', name: 'General', icon: '⛵', desc: 'A little of everything.' },
];

export const MAP_SIZE_INFO: Record<MapSize, { name: string; desc: string }> = {
  small: { name: 'Small', desc: '128 × 128 tiles' },
  medium: { name: 'Medium', desc: '160 × 160 tiles' },
  large: { name: 'Large', desc: '208 × 208 tiles' },
};

export const TERRAIN_INFO: Record<TerrainStyle, { name: string; icon: string; desc: string }> = {
  valleys: { name: 'Valleys', icon: '🏞️', desc: 'Rolling hills cut by a winding river, ringed by mountains.' },
  mountains: { name: 'Mountains', icon: '🏔️', desc: 'High peaks and narrow valleys. Little room to build.' },
  lakes: { name: 'Lakes', icon: '🌊', desc: 'Open country scattered with lakes. Few mountains.' },
};

export const CLIMATE_INFO: Record<Climate, { name: string; icon: string; desc: string }> = {
  mild: { name: 'Mild', icon: '🌤️', desc: 'Warm summers and short, gentle winters.' },
  fair: { name: 'Fair', icon: '⛅', desc: 'Balanced seasons with a cold winter.' },
  harsh: { name: 'Harsh', icon: '🌨️', desc: 'Short summers and long, bitter winters.' },
};

export const DIFFICULTY_INFO: Record<Difficulty, { name: string; desc: string }> = {
  easy: { name: 'Easy', desc: '7 families, 4 houses, a stockpile and barn, plentiful supplies and many seeds.' },
  medium: { name: 'Medium', desc: '5 families, a stockpile and barn, modest supplies.' },
  hard: { name: 'Hard', desc: '3 families, scarce supplies and only wheat seeds. Survival is not assured.' },
};
