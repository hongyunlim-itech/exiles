/**
 * Per-citizen appearance (skin, hair, clothes, hats) derived deterministically from the citizen id, plus colour
 * lookups for professions and carried resources. Colours are stored in linear working space (ready for instance
 * colour buffers).
 */
import * as THREE from 'three';
import { ADULT_AGE, STUDENT_GRADUATE_AGE } from '../../core/constants';
import { PROFESSIONS, RESOURCES } from '../../core/defs';
import type { Citizen, Profession, ResourceType } from '../../core/types';
import { CARRY_CRATE, CARRY_LOG, CARRY_SACK, CARRY_STONE, HAT_CAP, HAT_NONE, HAT_STRAW } from './citizenModel';
import { hashId } from './math';

export type LinearRGB = [number, number, number];

const SKIN = [0xe8bf98, 0xdcae88, 0xc99470, 0xf0cfae, 0xb88158, 0xd9a47c];
const HAIR = [0x3b2a1e, 0x5a3a22, 0x241d18, 0xc9a45a, 0x8e4a26, 0x6b4c2f, 0x4a3524];
const TROUSERS = [0x4a3b2c, 0x3d3a36, 0x5a4a38, 0x4b4a3a, 0x3f3226];
const CAPS = [0x6b4a33, 0x4a5a3a, 0x7a2e24, 0x5a5a60, 0x3a4a6a];
const KERCHIEF = [0xe8e0cc, 0xd8cfb8, 0xc9b9a0, 0xb56a5a];

function lin(hex: number): LinearRGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export interface CitizenLook {
  skin: LinearRGB;
  hair: LinearRGB;
  grey: LinearRGB;
  trousers: LinearRGB;
  /** 0 = short, 1 = long, 2 = kerchief (long-hair mesh in kerchief colour). */
  hairStyle: number;
  kerchief: LinearRGB;
  hat: number;
  hatColor: LinearRGB;
  /** Adult height multiplier. */
  height: number;
  seed: number;
}

export function makeLook(c: Citizen): CitizenLook {
  const id = c.id;
  const female = c.gender === 'F';
  const hairStyle = female ? (hashId(id, 7) < 0.35 ? 2 : 1) : 0;
  const workHat = c.profession === 'farmer' || c.profession === 'herder' || c.profession === 'gatherer';
  let hat = HAT_NONE;
  if (!female) {
    const r = hashId(id, 8);
    if (workHat ? r < 0.75 : r < 0.25) hat = workHat ? HAT_STRAW : HAT_CAP;
  } else if (workHat && hashId(id, 8) < 0.4) {
    hat = HAT_STRAW;
  }
  return {
    skin: lin(SKIN[Math.floor(hashId(id, 1) * SKIN.length)]),
    hair: lin(HAIR[Math.floor(hashId(id, 2) * HAIR.length)]),
    grey: lin(hashId(id, 3) < 0.5 ? 0xbdbab2 : 0xdedbd2),
    trousers: lin(TROUSERS[Math.floor(hashId(id, 4) * TROUSERS.length)]),
    hairStyle,
    kerchief: lin(KERCHIEF[Math.floor(hashId(id, 5) * KERCHIEF.length)]),
    hat,
    hatColor: lin(CAPS[Math.floor(hashId(id, 6) * CAPS.length)]),
    height: (female ? 0.94 : 0.98) + hashId(id, 9) * 0.08,
    seed: hashId(id, 10),
  };
}

/** Overall model scale by age: children ≈ 0.6–0.73, students grow toward adult size. */
export function citizenScale(c: Citizen, look: CitizenLook): number {
  if (c.age < ADULT_AGE) return 0.6 + 0.013 * Math.max(0, c.age);
  if (c.age < STUDENT_GRADUATE_AGE) return Math.min(look.height, 0.8 + 0.045 * (c.age - ADULT_AGE));
  return look.height;
}

const professionColors = new Map<Profession, LinearRGB>();
for (const p of Object.keys(PROFESSIONS) as Profession[]) professionColors.set(p, lin(PROFESSIONS[p].color));
const FALLBACK: LinearRGB = lin(0x8c7a5b);

export function professionColor(p: Profession): LinearRGB {
  return professionColors.get(p) ?? FALLBACK;
}

const resourceColors = new Map<ResourceType, LinearRGB>();
for (const r of Object.keys(RESOURCES) as ResourceType[]) resourceColors.set(r, lin(RESOURCES[r].color));

export function resourceColor(r: ResourceType): LinearRGB {
  return resourceColors.get(r) ?? FALLBACK;
}

/** Which carried-goods mesh represents a resource. */
export function carryKindOf(r: ResourceType): number {
  switch (r) {
    case 'log':
    case 'firewood':
      return CARRY_LOG;
    case 'stone':
    case 'iron':
      return CARRY_STONE;
    case 'tool':
    case 'leatherCoat':
    case 'woolCoat':
    case 'ale':
      return CARRY_CRATE;
    default:
      return CARRY_SACK;
  }
}
