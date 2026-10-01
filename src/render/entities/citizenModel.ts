/**
 * Low-poly townsfolk parts for instanced rendering. The model faces +X, feet at y = 0, adult height ≈ 0.55.
 *
 * Every part is authored relative to its joint pivot:
 *  - legs: hip pivot, hanging down (-Y);  arms / hands: shoulder pivot, hanging down;
 *  - torso / tunic flare: hip pivot, extending up;  skirt: hip pivot, extending down;
 *  - head / hair / hats: neck pivot;  tools: hand (grip) pivot, extending along -Y (continuing the arm);
 *  - carried goods: their own centre.
 * White vertex colours are tinted by per-instance colours (tunic, skin, hair…); tools use baked colours.
 */
import * as THREE from 'three';
import { GeoBuilder, limb, trs } from './geoBuilder';

export const BODY = {
  /** Hip pivot height (leg length). */
  hipY: 0.2,
  legLen: 0.2,
  /** Lateral (z) offset of each leg. */
  legZ: 0.04,
  /** Shoulder pivot height above the hips (spine space). */
  shoulderY: 0.185,
  shoulderZ: 0.094,
  /** Neck pivot height above the hips. */
  neckY: 0.205,
  armLen: 0.165,
  /** Head centre above the neck pivot. */
  headY: 0.064,
} as const;

export const TOOL_NONE = 0;
export const TOOL_AXE = 1;
export const TOOL_PICK = 2;
export const TOOL_HAMMER = 3;
export const TOOL_HOE = 4;
export const TOOL_ROD = 5;
export const TOOL_BOW = 6;
export const TOOL_BUCKET = 7;
export const TOOL_BASKET = 8;
export const TOOL_COUNT = 9;

export const CARRY_NONE = 0;
export const CARRY_CRATE = 1;
export const CARRY_SACK = 2;
export const CARRY_LOG = 3;
export const CARRY_STONE = 4;
export const CARRY_COUNT = 5;

export const HAT_NONE = 0;
export const HAT_STRAW = 1;
export const HAT_CAP = 2;

const WOOD = 0x7a5534;
const WOOD_DARK = 0x5a3d24;
const METAL = 0x9aa0a6;
const METAL_DARK = 0x5d6166;

export function buildLeg(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.BoxGeometry(0.056, 0.17, 0.062), trs(0, -0.085, 0), { color: 0xffffff });
  // boot
  b.add(new THREE.BoxGeometry(0.082, 0.04, 0.066), trs(0.012, -0.18, 0), { color: 0x4a4a4a });
  return b.build();
}

export function buildTorso(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  // tapered tunic body (square frustum rotated 45°)
  b.add(new THREE.CylinderGeometry(0.085, 0.1, 0.19, 4, 1, false), trs(0, 0.1, 0, 0, Math.PI / 4, 0, 0.72, 1, 1.05), { color: 0xffffff, colorVar: 0.04 });
  // tunic flare over the hips
  b.add(new THREE.CylinderGeometry(0.085, 0.1, 0.06, 6, 1, false), trs(0, 0.0, 0, 0, 0, 0, 0.9, 1, 1.1), { color: 0xf0f0f0, colorVar: 0.04 });
  // belt
  b.add(new THREE.CylinderGeometry(0.083, 0.085, 0.022, 6, 1, true), trs(0, 0.045, 0, 0, 0, 0, 0.9, 1, 1.1), { color: 0x3a2a1c });
  // shoulders
  b.add(new THREE.BoxGeometry(0.1, 0.035, 0.2), trs(0, 0.178, 0), { color: 0xffffff });
  return b.build();
}

export function buildSkirt(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.085, 0.13, 0.19, 8, 1, false), trs(0, -0.085, 0, 0, 0, 0, 0.95, 1, 1.05), { color: 0xffffff, colorVar: 0.05 });
  // apron hint at the front
  b.add(new THREE.BoxGeometry(0.01, 0.13, 0.1), trs(0.095, -0.075, 0, 0, 0, -0.18), { color: 0xe8e2d0 });
  return b.build();
}

export function buildHead(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const hy = BODY.headY;
  b.add(new THREE.CylinderGeometry(0.024, 0.028, 0.04, 6, 1, true), trs(0, 0.015, 0), { color: 0xf2f2f2 });
  b.add(new THREE.IcosahedronGeometry(0.058, 1), trs(0, hy, 0, 0, 0, 0, 1, 1.08, 0.95), { color: 0xffffff });
  // nose
  b.add(new THREE.BoxGeometry(0.018, 0.02, 0.014), trs(0.057, hy - 0.006, 0), { color: 0xf0dcd4 });
  // eyes
  b.add(new THREE.BoxGeometry(0.008, 0.01, 0.009), trs(0.052, hy + 0.01, 0.02), { color: 0x2a1d15 });
  b.add(new THREE.BoxGeometry(0.008, 0.01, 0.009), trs(0.052, hy + 0.01, -0.02), { color: 0x2a1d15 });
  return b.build();
}

/** Short hair cap (men). */
export function buildHairShort(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.SphereGeometry(0.063, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), trs(-0.006, BODY.headY + 0.004, 0, 0, 0, 0.42, 1, 1.05, 1), { color: 0xffffff, colorVar: 0.06 });
  return b.build();
}

/** Longer hair falling to the shoulders (women). Also used as a kerchief with a cream colour. */
export function buildHairLong(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.SphereGeometry(0.065, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), trs(-0.004, BODY.headY + 0.005, 0, 0, 0, 0.36, 1, 1.05, 1), { color: 0xffffff, colorVar: 0.06 });
  b.add(new THREE.BoxGeometry(0.045, 0.095, 0.1), trs(-0.045, BODY.headY - 0.04, 0, 0, 0, 0.12), { color: 0xffffff, colorVar: 0.06 });
  b.add(new THREE.IcosahedronGeometry(0.027, 0), trs(-0.064, BODY.headY + 0.028, 0), { color: 0xf2f2f2 });
  return b.build();
}

export function buildHatStraw(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.115, 0.12, 0.012, 10, 1, false), trs(0, BODY.headY + 0.04, 0), { color: 0xd8bf72, colorVar: 0.06 });
  b.add(new THREE.CylinderGeometry(0.045, 0.062, 0.05, 8, 1, false), trs(0, BODY.headY + 0.07, 0), { color: 0xcfb466, colorVar: 0.06 });
  b.add(new THREE.CylinderGeometry(0.063, 0.063, 0.012, 8, 1, true), trs(0, BODY.headY + 0.052, 0), { color: 0x8a4a2a });
  return b.build();
}

export function buildHatCap(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.045, 0.067, 0.05, 8, 1, false), trs(-0.008, BODY.headY + 0.052, 0, 0, 0, 0.35), { color: 0xffffff, colorVar: 0.05 });
  b.add(new THREE.ConeGeometry(0.032, 0.05, 6), trs(-0.045, BODY.headY + 0.076, 0, 0, 0, 1.3), { color: 0xe6e6e6 });
  return b.build();
}

export function buildArm(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.BoxGeometry(0.046, 0.15, 0.048), trs(0, -0.068, 0), { color: 0xffffff, colorVar: 0.03 });
  return b.build();
}

export function buildHand(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.BoxGeometry(0.036, 0.036, 0.04), trs(0, -BODY.armLen + 0.012, 0), { color: 0xffffff });
  return b.build();
}

// ---- carried goods ---------------------------------------------------------------------------------------

export function buildCarry(kind: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  switch (kind) {
    case CARRY_CRATE:
      b.add(new THREE.BoxGeometry(0.12, 0.1, 0.13), null, { color: 0xffffff, colorVar: 0.06 });
      b.add(new THREE.BoxGeometry(0.124, 0.02, 0.134), trs(0, 0.03, 0), { color: 0xb0a090 });
      break;
    case CARRY_SACK:
      b.add(new THREE.IcosahedronGeometry(0.07, 0), trs(0, 0, 0, 0, 0.3, 0, 1, 1.15, 0.95), { color: 0xffffff, colorVar: 0.08, jitter: 0.008 });
      b.add(new THREE.CylinderGeometry(0.018, 0.028, 0.035, 5), trs(0, 0.085, 0), { color: 0xd8c8a0 });
      break;
    case CARRY_LOG:
      b.add(new THREE.CylinderGeometry(0.045, 0.048, 0.44, 6, 1, true), trs(0, 0, 0, 0, 0, Math.PI / 2), { color: 0xffffff, colorVar: 0.08 });
      b.add(new THREE.CircleGeometry(0.045, 6), trs(0.22, 0, 0, 0, Math.PI / 2, 0), { color: 0xe8cf9a });
      b.add(new THREE.CircleGeometry(0.048, 6), trs(-0.22, 0, 0, 0, -Math.PI / 2, 0), { color: 0xe8cf9a });
      break;
    case CARRY_STONE:
    default:
      b.add(new THREE.DodecahedronGeometry(0.068, 0), trs(0, 0, 0, 0.3, 0.2, 0.1, 1, 0.8, 1), { color: 0xffffff, colorVar: 0.1, jitter: 0.01 });
      break;
  }
  return b.build();
}

// ---- tools (grip at origin, extending along -Y; the working edge faces +X) -----------------------------------

export function buildTool(kind: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  switch (kind) {
    case TOOL_AXE:
      b.add(new THREE.BoxGeometry(0.018, 0.34, 0.018), trs(0, -0.15, 0), { color: WOOD });
      b.add(new THREE.BoxGeometry(0.075, 0.055, 0.014), trs(0.04, -0.29, 0), { color: METAL, colorVar: 0.05 });
      b.add(new THREE.BoxGeometry(0.02, 0.07, 0.016), trs(0.078, -0.29, 0), { color: 0xc8ccd0 });
      break;
    case TOOL_PICK:
      b.add(new THREE.BoxGeometry(0.018, 0.34, 0.018), trs(0, -0.15, 0), { color: WOOD });
      b.add(new THREE.ConeGeometry(0.014, 0.12, 4), trs(0.065, -0.3, 0, 0, 0, -Math.PI / 2 - 0.25), { color: METAL_DARK });
      b.add(new THREE.ConeGeometry(0.014, 0.1, 4), trs(-0.055, -0.3, 0, 0, 0, Math.PI / 2 + 0.25), { color: METAL_DARK });
      b.add(new THREE.BoxGeometry(0.03, 0.03, 0.03), trs(0, -0.3, 0), { color: METAL });
      break;
    case TOOL_HAMMER:
      b.add(new THREE.BoxGeometry(0.016, 0.2, 0.016), trs(0, -0.08, 0), { color: WOOD });
      b.add(new THREE.BoxGeometry(0.075, 0.035, 0.035), trs(0.005, -0.18, 0), { color: METAL_DARK, colorVar: 0.05 });
      break;
    case TOOL_HOE:
      b.add(new THREE.BoxGeometry(0.016, 0.46, 0.016), trs(0, -0.18, 0), { color: WOOD });
      b.add(new THREE.BoxGeometry(0.06, 0.012, 0.055), trs(0.028, -0.4, 0, 0, 0, 0.5), { color: METAL, colorVar: 0.05 });
      break;
    case TOOL_ROD: {
      b.add(new THREE.CylinderGeometry(0.004, 0.011, 0.78, 4, 1, true), trs(0, -0.35, 0), { color: WOOD });
      // line hanging from the tip (authored for the typical fishing pose)
      // Hangs straight down when the rod is held at ~2.2 rad from vertical-down (arm swing + wrist angle).
      const tipY = -0.74;
      const R = 2.2;
      const L = 0.5;
      const ex = -Math.sin(R) * L;
      const ey = -Math.cos(R) * L;
      b.add(new THREE.CylinderGeometry(0.0025, 0.0025, 1, 3, 1, true), limb(0, tipY, 0, ex, tipY + ey, 0), { color: 0xe8e8e0 });
      b.add(new THREE.IcosahedronGeometry(0.014, 0), trs(ex, tipY + ey, 0), { color: 0xd23a2a });
      break;
    }
    case TOOL_BOW: {
      // Vertical bow: grip at the hand, limbs bulging forward (-Y in tool space), tips toward the archer (+Y);
      // tool X is world-up when the arm points forward.
      const R = 0.17;
      const arc = new THREE.TorusGeometry(R, 0.008, 3, 10, Math.PI * 0.8);
      b.add(arc, trs(0, R, 0, 0, 0, -Math.PI * 0.9), { color: WOOD_DARK });
      const tx = R * Math.sin(Math.PI * 0.4);
      const ty = R - R * Math.cos(Math.PI * 0.4);
      b.add(new THREE.CylinderGeometry(0.002, 0.002, 1, 3, 1, true), limb(tx, ty, 0, -tx, ty, 0), { color: 0xe8e0c8 });
      break;
    }
    case TOOL_BUCKET:
      b.add(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 8, 1, false), trs(0, -0.075, 0), { color: 0x8a6a44, colorVar: 0.06 });
      b.add(new THREE.CylinderGeometry(0.051, 0.051, 0.012, 8, 1, true), trs(0, -0.06, 0), { color: METAL_DARK });
      b.add(new THREE.CircleGeometry(0.045, 8), trs(0, -0.042, 0, -Math.PI / 2, 0, 0), { color: 0x4f7f9a });
      break;
    case TOOL_BASKET:
      b.add(new THREE.CylinderGeometry(0.06, 0.045, 0.06, 8, 1, false), trs(0, -0.08, 0), { color: 0xb08a50, colorVar: 0.08 });
      b.add(new THREE.TorusGeometry(0.05, 0.006, 3, 8, Math.PI), trs(0, -0.05, 0, 0, Math.PI / 2, 0), { color: 0x8a6a3a });
      b.add(new THREE.IcosahedronGeometry(0.035, 0), trs(0.01, -0.045, 0.012), { color: 0x8e2a4a });
      break;
    default:
      b.add(new THREE.BoxGeometry(0.001, 0.001, 0.001), null, {});
  }
  return b.build();
}

// ---- selection highlight ---------------------------------------------------------------------------------

export function buildHighlightRing(): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(0.2, 0.27, 28);
  g.rotateX(-Math.PI / 2);
  return g;
}

export function buildHighlightMarker(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(0.07, 0);
  g.scale(1, 1.6, 1);
  return g;
}
