/**
 * Citizen animation poses (pure logic, no three.js): joint angles for walking and every activity.
 *
 * Angle conventions (model faces +X, Y up, right side = +Z):
 *  - leg/arm swing: rotation about Z, positive = forward (+X);
 *  - armIn: rotation bringing the hand toward the body midline (positive = inward);
 *  - lean: spine tilt forward (radians);  headPitch: positive = look down;  headYaw: positive = turn left (+Y rot).
 */
import type { Activity, Profession } from '../../core/types';
import {
  CARRY_LOG, CARRY_NONE, TOOL_AXE, TOOL_BASKET, TOOL_BOW, TOOL_BUCKET, TOOL_HAMMER, TOOL_HOE, TOOL_NONE, TOOL_PICK,
  TOOL_ROD,
} from './citizenModel';
import { clamp01, easeIn, easeInOut, fract, lerp } from './math';

export interface PoseInput {
  activity: Activity;
  moving: boolean;
  /** Walk cycle phase (radians), advanced by distance travelled. */
  walkPhase: number;
  /** Animation clock in seconds (per citizen). */
  t: number;
  /** Per-citizen random 0..1. */
  seed: number;
  elderly: boolean;
  child: boolean;
  /** CARRY_* kind of the carried good (CARRY_NONE when empty-handed). */
  carry: number;
  profession: Profession;
  /** Disease severity 0..1. */
  sick: number;
}

export interface Pose {
  legL: number;
  legR: number;
  lean: number;
  twist: number;
  headPitch: number;
  headYaw: number;
  armL: number;
  armR: number;
  armInL: number;
  armInR: number;
  /** Extra vertical offset of the hips (jumps). */
  bob: number;
  /** Additional yaw applied to the whole body (e.g. children spinning while playing). */
  yawOffset: number;
  tool: number;
  /** 0 = right hand, 1 = left hand. */
  toolHand: number;
  /** Extra wrist rotation of the tool about Z. */
  toolAngle: number;
  /** Tool held with both hands (compensate the inward arm rotation). */
  twoHanded: boolean;
  /** Carried good shown (CARRY_*). */
  carry: number;
}

export function createPose(): Pose {
  return {
    legL: 0, legR: 0, lean: 0, twist: 0, headPitch: 0, headYaw: 0, armL: 0, armR: 0, armInL: 0, armInR: 0,
    bob: 0, yawOffset: 0, tool: TOOL_NONE, toolHand: 0, toolAngle: 0, twoHanded: false, carry: CARRY_NONE,
  };
}

function reset(p: Pose): void {
  p.legL = p.legR = p.lean = p.twist = p.headPitch = p.headYaw = 0;
  p.armL = p.armR = 0.06;
  p.armInL = p.armInR = 0;
  p.bob = p.yawOffset = 0;
  p.tool = TOOL_NONE;
  p.toolHand = 0;
  p.toolAngle = 0;
  p.twoHanded = false;
  p.carry = CARRY_NONE;
}

/** Overhead two-handed strike (axe / pick). Returns the arm angle; sets lean contribution in `out`. */
function strike(u: number, raise: number, hit: number): number {
  if (u < 0.55) return lerp(hit + 0.1, raise, easeInOut(u / 0.55));
  if (u < 0.72) return lerp(raise, hit, easeIn((u - 0.55) / 0.17));
  return lerp(hit, hit + 0.1, (u - 0.72) / 0.28);
}

function strikeLean(u: number): number {
  if (u < 0.55) return -0.05 * (u / 0.55);
  if (u < 0.72) return lerp(-0.05, 0.28, (u - 0.55) / 0.17);
  return lerp(0.28, 0, (u - 0.72) / 0.28);
}

function chop(p: Pose, t: number, period: number, tool: number, raise: number, hit: number, leanBase: number): void {
  const u = fract(t / period);
  const a = strike(u, raise, hit);
  p.armL = p.armR = a;
  p.armInL = p.armInR = 0.42;
  p.twoHanded = true;
  p.tool = tool;
  p.toolAngle = 0.2;
  p.lean = leanBase + strikeLean(u);
  p.legL = 0.22;
  p.legR = -0.18;
  p.headPitch = 0.15;
}

function hammer(p: Pose, t: number, leanBase: number): void {
  const u = fract(t / 0.55);
  p.armR = u < 0.45 ? lerp(0.9, 2.3, easeInOut(u / 0.45)) : u < 0.62 ? lerp(2.3, 0.75, easeIn((u - 0.45) / 0.17)) : 0.75 + 0.15 * ((u - 0.62) / 0.38);
  p.armInR = 0.25;
  p.armL = 0.95;
  p.armInL = 0.35;
  p.tool = TOOL_HAMMER;
  p.toolHand = 0;
  p.toolAngle = 0.35;
  p.lean = leanBase + (u > 0.45 && u < 0.62 ? 0.08 : 0);
  p.headPitch = 0.35;
  p.legL = 0.15;
  p.legR = -0.12;
}

function hoe(p: Pose, t: number): void {
  const u = fract(t / 1.5);
  p.armL = p.armR = u < 0.5 ? lerp(0.5, 1.9, easeInOut(u / 0.5)) : u < 0.65 ? lerp(1.9, 0.35, easeIn((u - 0.5) / 0.15)) : lerp(0.35, 0.5, (u - 0.65) / 0.35);
  p.armInL = p.armInR = 0.4;
  p.twoHanded = true;
  p.tool = TOOL_HOE;
  p.toolAngle = 0.35;
  p.lean = 0.3 + (u > 0.5 && u < 0.65 ? 0.12 : 0);
  p.legL = 0.3;
  p.legR = -0.2;
  p.headPitch = 0.3;
}

/** Fill `out` with the pose for this frame. Allocation-free. */
export function computePose(inp: PoseInput, out: Pose): Pose {
  reset(out);
  const t = inp.t;
  const seed = inp.seed;
  const act = inp.activity;

  if (inp.moving) {
    const running = act === 'firefighting';
    const ph = inp.walkPhase;
    const s = Math.sin(ph);
    let legA = inp.child ? 0.62 : 0.55;
    let armA = 0.45;
    if (running) {
      legA = 0.75;
      armA = 0.8;
      out.lean = 0.22;
    }
    if (inp.elderly) {
      legA *= 0.65;
      armA *= 0.5;
    }
    if (inp.sick > 0.2) {
      legA *= 0.7;
      armA *= 0.4;
      out.lean += 0.25;
      out.headPitch = 0.25;
    }
    out.legL = legA * s;
    out.legR = -legA * s;
    out.armL = -armA * s + 0.05;
    out.armR = armA * s + 0.05;
    out.armInL = out.armInR = -0.04;
    out.twist = 0.06 * s;
    if (act === 'playing') {
      out.bob = Math.abs(Math.sin(ph)) * 0.035;
      out.armL = 0.6 - 0.5 * s;
      out.armR = 0.6 + 0.5 * s;
    }
    if (running) {
      out.tool = TOOL_BUCKET;
      out.toolHand = 0;
      out.armR = 0.9 + 0.25 * s;
      out.toolAngle = -0.9;
    }
  } else {
    switch (act) {
      case 'chopping':
        chop(out, t, 1.15, TOOL_AXE, 2.85, 0.55, 0.08);
        break;
      case 'mining':
        chop(out, t, 1.35, TOOL_PICK, 2.95, 0.35, 0.22);
        break;
      case 'building':
        hammer(out, t, 0.3);
        break;
      case 'farming':
        hoe(out, t);
        break;
      case 'gathering': {
        out.lean = 0.85;
        out.headPitch = 0.25;
        out.armR = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.6 + seed * 6));
        out.armInR = 0.25;
        out.armL = 0.3;
        out.tool = TOOL_BASKET;
        out.toolHand = 1;
        out.toolAngle = -0.3;
        out.legL = 0.25;
        out.legR = -0.25;
        break;
      }
      case 'fishing': {
        const jerk = fract(t / 7 + seed) > 0.93 ? 0.35 * Math.sin(fract(t / 7 + seed) * 50) : 0;
        out.armL = out.armR = 0.95 + jerk * 0.5;
        out.armInL = out.armInR = 0.4;
        out.twoHanded = true;
        out.tool = TOOL_ROD;
        out.toolAngle = 1.25 + 0.05 * Math.sin(t * 1.3 + seed * 5) + jerk;
        out.legL = 0.1;
        out.legR = -0.1;
        out.headPitch = 0.12;
        break;
      }
      case 'hunting': {
        const u = fract(t / 3.2 + seed);
        out.armL = 1.5;
        out.armInL = 0.05;
        out.armR = u > 0.85 ? 1.2 : 1.45;
        out.armInR = u > 0.85 ? 0.15 : 0.6;
        out.tool = TOOL_BOW;
        out.toolHand = 1;
        out.toolAngle = 0;
        out.twist = -0.25;
        out.legL = 0.3;
        out.legR = -0.25;
        break;
      }
      case 'working':
        workByProfession(out, inp);
        break;
      case 'eating': {
        const u = fract(t / 2.4 + seed);
        out.armR = u < 0.3 ? lerp(0.25, 2.35, easeInOut(u / 0.3)) : u < 0.6 ? 2.35 : lerp(2.35, 0.25, easeInOut((u - 0.6) / 0.4));
        out.armInR = 0.65;
        out.armL = 0.7;
        out.armInL = 0.4;
        out.headPitch = -0.05;
        break;
      }
      case 'warming':
        out.armL = out.armR = 1.05 + 0.12 * Math.sin(t * 9);
        out.armInL = out.armInR = 0.6;
        out.twist = 0.03 * Math.sin(t * 31);
        out.lean = 0.12;
        out.headPitch = 0.15;
        break;
      case 'studying':
        out.armL = out.armR = 0.75;
        out.armInL = out.armInR = 0.5;
        out.headPitch = 0.4;
        out.headYaw = 0.1 * Math.sin(t * 0.8);
        break;
      case 'healing':
        out.lean = 0.5;
        out.armL = 0.9 + 0.15 * Math.sin(t * 3);
        out.armR = 0.9 - 0.15 * Math.sin(t * 3);
        out.armInL = out.armInR = 0.3;
        out.headPitch = 0.3;
        break;
      case 'praying':
        out.armL = out.armR = 1.3;
        out.armInL = out.armInR = 0.62;
        out.headPitch = 0.38;
        out.lean = 0.08;
        break;
      case 'firefighting': {
        const u = fract(t / 1.2 + seed);
        out.armL = out.armR = u < 0.35 ? lerp(0.3, 0.1, u / 0.35) : u < 0.5 ? lerp(0.1, 2.1, easeIn((u - 0.35) / 0.15)) : lerp(2.1, 0.3, (u - 0.5) / 0.5);
        out.armInL = out.armInR = 0.4;
        out.twoHanded = true;
        out.tool = TOOL_BUCKET;
        out.toolAngle = 0;
        out.lean = u > 0.35 && u < 0.55 ? 0.25 : 0.05;
        out.legL = 0.3;
        out.legR = -0.2;
        break;
      }
      case 'playing': {
        if (seed < 0.5) {
          out.bob = Math.abs(Math.sin(t * 7)) * 0.05;
          out.armL = 2.6 + 0.35 * Math.sin(t * 7);
          out.armR = 2.6 - 0.35 * Math.sin(t * 7);
          out.armInL = out.armInR = -0.3;
          out.legL = 0.2 * Math.sin(t * 7);
          out.legR = -out.legL;
        } else {
          out.yawOffset = t * 3;
          out.armL = out.armR = 1.5;
          out.armInL = out.armInR = -0.9;
          out.headPitch = -0.2;
        }
        break;
      }
      case 'sick':
        out.lean = 0.35;
        out.headPitch = 0.35;
        out.twist = 0.05 * Math.sin(t * 1.2);
        out.armL = out.armR = 0.15;
        out.armInL = out.armInR = 0.3;
        break;
      case 'hauling':
      case 'idle':
      case 'walking':
      default:
        idle(out, t, seed);
        break;
    }
  }

  // Carried goods override the arms (held in front / log on the shoulder).
  if (inp.carry !== CARRY_NONE && out.tool === TOOL_NONE) {
    out.carry = inp.carry;
    if (inp.carry === CARRY_LOG) {
      out.armR = 2.55;
      out.armInR = 0.05;
    } else {
      out.armL = out.armR = 1.15;
      out.armInL = out.armInR = 0.38;
    }
  }

  if (inp.elderly) {
    out.lean += 0.3;
    out.headPitch -= 0.2;
  }
  if (inp.sick > 0.2 && act !== 'sick') out.lean += 0.1 * clamp01(inp.sick);
  return out;
}

function idle(p: Pose, t: number, seed: number): void {
  p.headYaw = 0.45 * Math.sin(t * 0.33 + seed * 6.28) * (Math.sin(t * 0.13 + seed * 3) > 0 ? 1 : 0.3);
  p.headPitch = 0.05 * Math.sin(t * 0.5 + seed);
  p.armL = 0.06 + 0.02 * Math.sin(t * 1.4 + seed * 2);
  p.armR = 0.06 + 0.02 * Math.sin(t * 1.4 + seed * 2 + 1);
  p.lean = 0.02 + 0.01 * Math.sin(t * 1.4);
  const shift = Math.sin(t * 0.21 + seed * 9) > 0.6 ? 0.12 : 0;
  p.legL = shift;
  p.legR = -shift * 0.5;
}

function workByProfession(p: Pose, inp: PoseInput): void {
  const t = inp.t;
  switch (inp.profession) {
    case 'blacksmith':
    case 'builder':
      hammer(p, t, 0.28);
      return;
    case 'woodcutter':
    case 'forester':
      chop(p, t, 1.2, TOOL_AXE, 2.8, 0.45, 0.12);
      return;
    case 'stonecutter':
    case 'miner':
      chop(p, t, 1.35, TOOL_PICK, 2.95, 0.35, 0.22);
      return;
    case 'farmer':
      hoe(p, t);
      return;
    case 'fisherman':
      p.armL = p.armR = 0.95;
      p.armInL = p.armInR = 0.4;
      p.twoHanded = true;
      p.tool = TOOL_ROD;
      p.toolAngle = 1.25 + 0.05 * Math.sin(t * 1.3);
      return;
    case 'herder':
    case 'gatherer':
    case 'herbalist':
      p.lean = 0.6;
      p.armR = 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2));
      p.armL = 0.3;
      p.tool = TOOL_BASKET;
      p.toolHand = 1;
      p.toolAngle = -0.3;
      return;
    default: {
      // Generic crafting / tending at a workbench.
      p.armL = 0.85 + 0.2 * Math.sin(t * 2.3 + inp.seed * 4);
      p.armR = 0.85 + 0.2 * Math.sin(t * 2.3 + inp.seed * 4 + 2.1);
      p.armInL = p.armInR = 0.45;
      p.lean = 0.18;
      p.headPitch = 0.35;
    }
  }
}
