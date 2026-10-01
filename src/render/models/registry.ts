/** BuildingType → model function. Record<> guarantees every building type has a model. */
import type { BuildingType } from '../../core/types';
import type { ModelFn } from './spec';
import { boardingHouse, stoneHouse, woodenHouse } from './types/housing';
import { storageBarn } from './types/storage';
import { fishingDock, gathererHut, hunterCabin } from './types/food';
import { blacksmith, brewery, foresterLodge, herbalist, mine, quarry, tailor, woodcutter } from './types/industry';
import { chapel, hospital, market, school, tavern, townHall, tradingPost, well } from './types/town';
import { cemetery, cropField, orchard, pasture, stockpile } from './types/zones';

export const MODEL_FNS: Record<BuildingType, ModelFn> = {
  woodenHouse,
  stoneHouse,
  boardingHouse,
  stockpile,
  storageBarn,
  gathererHut,
  hunterCabin,
  fishingDock,
  cropField,
  orchard,
  pasture,
  foresterLodge,
  woodcutter,
  quarry,
  mine,
  blacksmith,
  tailor,
  herbalist,
  brewery,
  well,
  school,
  hospital,
  chapel,
  tavern,
  market,
  tradingPost,
  townHall,
  cemetery,
};
