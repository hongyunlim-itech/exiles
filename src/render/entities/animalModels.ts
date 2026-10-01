/**
 * Low-poly animals for instancing: wild deer and pasture livestock (sheep, cattle, chickens).
 * Model faces +X, feet at y = 0, authored at a common "unit" scale (deer-sized); livestock are scaled by
 * LIVESTOCK[type].scale. Coat faces use aPart 0 (tinted per instance), fixed-colour faces use aPart 2.
 *
 * Parts: body (static relative to root), head (pivot at the neck base, pitched down to graze),
 * leg (pivot at hip/shoulder, hanging down), optional extra (antlers; same transform as the head).
 */
import * as THREE from 'three';
import { GeoBuilder, limb, trs } from './geoBuilder';

const COAT = 0; // tinted
const FIXED = 2; // baked colour

export interface AnimalSpeciesModel {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  extra: THREE.BufferGeometry | null;
  /** Leg pivots [x, y, z] (front-left, front-right, back-left, back-right, or two legs for birds). */
  legPivots: [number, number, number][];
  headPivot: [number, number, number];
  /** Neck pitch (radians) when the head is down grazing/pecking. */
  grazePitch: number;
  /** Distance per walk cycle at unit scale. */
  stride: number;
  legSwing: number;
}

function leg(len: number, w: number, hoof: number, coatLen = 0.75): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.BoxGeometry(w, len * coatLen, w), trs(0, -len * coatLen * 0.5, 0), { color: 0xffffff, part: COAT });
  b.add(new THREE.BoxGeometry(w * 0.85, len * (1 - coatLen), w * 0.85), trs(0, -len * coatLen - len * (1 - coatLen) * 0.5, 0), { color: hoof, part: FIXED });
  return b.build();
}

export function buildDeer(): AnimalSpeciesModel {
  const body = new GeoBuilder();
  body.add(new THREE.BoxGeometry(0.34, 0.15, 0.14), trs(0, 0.375, 0), { color: 0xffffff, part: COAT, colorVar: 0.04 });
  body.add(new THREE.BoxGeometry(0.13, 0.17, 0.135), trs(0.14, 0.39, 0, 0, 0, 0.1), { color: 0xffffff, part: COAT, colorVar: 0.04 });
  body.add(new THREE.BoxGeometry(0.11, 0.16, 0.14), trs(-0.15, 0.385, 0, 0, 0, -0.08), { color: 0xffffff, part: COAT, colorVar: 0.04 });
  body.add(new THREE.BoxGeometry(0.3, 0.03, 0.11), trs(0, 0.3, 0), { color: 0xd8c4a0, part: FIXED });
  body.add(new THREE.BoxGeometry(0.04, 0.07, 0.05), trs(-0.215, 0.43, 0, 0, 0, 0.6), { color: 0xf0ece0, part: FIXED });
  const head = new GeoBuilder();
  head.add(new THREE.BoxGeometry(0.06, 1, 0.055), limb(0, -0.03, 0, 0.08, 0.2, 0), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.12, 0.065, 0.06), trs(0.12, 0.23, 0, 0, 0, -0.25), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.04, 0.045, 0.045), trs(0.185, 0.208, 0, 0, 0, -0.25), { color: 0x3a2a20, part: FIXED });
  head.add(new THREE.BoxGeometry(0.05, 0.02, 0.035), trs(0.085, 0.275, 0.04, 0.5, 0, 0.3), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.05, 0.02, 0.035), trs(0.085, 0.275, -0.04, -0.5, 0, 0.3), { color: 0xffffff, part: COAT });
  const ant = new GeoBuilder();
  const a = 0xd8c8a8;
  for (const s of [1, -1]) {
    ant.add(new THREE.CylinderGeometry(0.006, 0.01, 1, 4, 1, true), limb(0.1, 0.26, 0.02 * s, 0.06, 0.39, 0.07 * s), { color: a, part: FIXED });
    ant.add(new THREE.CylinderGeometry(0.004, 0.007, 1, 4, 1, true), limb(0.075, 0.34, 0.055 * s, 0.13, 0.41, 0.06 * s), { color: a, part: FIXED });
    ant.add(new THREE.CylinderGeometry(0.004, 0.007, 1, 4, 1, true), limb(0.06, 0.39, 0.07 * s, 0.03, 0.46, 0.1 * s), { color: a, part: FIXED });
  }
  return {
    body: body.build(), head: head.build(), leg: leg(0.32, 0.034, 0x2a2420, 0.82), extra: ant.build(),
    legPivots: [[0.15, 0.33, 0.045], [0.15, 0.33, -0.045], [-0.15, 0.33, 0.045], [-0.15, 0.33, -0.045]],
    headPivot: [0.17, 0.43, 0], grazePitch: 1.75, stride: 0.55, legSwing: 0.5,
  };
}

export function buildSheep(): AnimalSpeciesModel {
  const body = new GeoBuilder();
  body.add(new THREE.IcosahedronGeometry(0.17, 1), trs(0, 0.33, 0, 0, 0, 0, 1.3, 0.95, 1.0), { color: 0xffffff, part: COAT, colorVar: 0.08, jitter: 0.018 });
  body.add(new THREE.IcosahedronGeometry(0.09, 0), trs(0.16, 0.37, 0), { color: 0xf4f4f4, part: COAT, jitter: 0.01 });
  body.add(new THREE.IcosahedronGeometry(0.05, 0), trs(-0.22, 0.34, 0), { color: 0xf0f0f0, part: COAT });
  const head = new GeoBuilder();
  head.add(new THREE.BoxGeometry(0.1, 0.075, 0.07), trs(0.075, 0.01, 0, 0, 0, -0.35), { color: 0x2c2622, part: FIXED });
  head.add(new THREE.IcosahedronGeometry(0.045, 0), trs(0.04, 0.05, 0), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.03, 0.018, 0.05), trs(0.045, 0.035, 0.055, 0.4, 0, 0), { color: 0x2c2622, part: FIXED });
  head.add(new THREE.BoxGeometry(0.03, 0.018, 0.05), trs(0.045, 0.035, -0.055, -0.4, 0, 0), { color: 0x2c2622, part: FIXED });
  return {
    body: body.build(), head: head.build(), leg: leg(0.24, 0.032, 0x221c18, 0.35), extra: null,
    legPivots: [[0.12, 0.24, 0.065], [0.12, 0.24, -0.065], [-0.12, 0.24, 0.065], [-0.12, 0.24, -0.065]],
    headPivot: [0.2, 0.36, 0], grazePitch: 1.3, stride: 0.4, legSwing: 0.45,
  };
}

export function buildCattle(): AnimalSpeciesModel {
  const body = new GeoBuilder();
  body.add(new THREE.BoxGeometry(0.4, 0.19, 0.18), trs(0, 0.34, 0), { color: 0xffffff, part: COAT, colorVar: 0.04 });
  body.add(new THREE.BoxGeometry(0.12, 0.2, 0.17), trs(0.15, 0.36, 0, 0, 0, 0.12), { color: 0xffffff, part: COAT, colorVar: 0.04 });
  body.add(new THREE.BoxGeometry(0.06, 0.04, 0.07), trs(-0.08, 0.235, 0), { color: 0xe0a8a0, part: FIXED });
  body.add(new THREE.BoxGeometry(0.015, 0.2, 0.015), trs(-0.205, 0.3, 0, 0, 0, -0.15), { color: 0xffffff, part: COAT });
  body.add(new THREE.BoxGeometry(0.03, 0.05, 0.03), trs(-0.215, 0.2, 0), { color: 0x2a2420, part: FIXED });
  const head = new GeoBuilder();
  head.add(new THREE.BoxGeometry(0.09, 0.1, 0.1), trs(0.03, 0.01, 0, 0, 0, -0.3), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.12, 0.09, 0.09), trs(0.1, -0.02, 0, 0, 0, -0.45), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.05, 0.06, 0.085), trs(0.16, -0.06, 0, 0, 0, -0.45), { color: 0xd8b8a0, part: FIXED });
  head.add(new THREE.ConeGeometry(0.012, 0.07, 4), trs(0.07, 0.05, 0.065, 1.2, 0, 0), { color: 0xe8e0c8, part: FIXED });
  head.add(new THREE.ConeGeometry(0.012, 0.07, 4), trs(0.07, 0.05, -0.065, -1.2, 0, 0), { color: 0xe8e0c8, part: FIXED });
  head.add(new THREE.BoxGeometry(0.03, 0.02, 0.05), trs(0.05, 0.02, 0.07, 0.3, 0, 0), { color: 0xffffff, part: COAT });
  head.add(new THREE.BoxGeometry(0.03, 0.02, 0.05), trs(0.05, 0.02, -0.07, -0.3, 0, 0), { color: 0xffffff, part: COAT });
  return {
    body: body.build(), head: head.build(), leg: leg(0.25, 0.048, 0x2a2420, 0.8), extra: null,
    legPivots: [[0.15, 0.25, 0.06], [0.15, 0.25, -0.06], [-0.15, 0.25, 0.06], [-0.15, 0.25, -0.06]],
    headPivot: [0.21, 0.38, 0], grazePitch: 1.2, stride: 0.5, legSwing: 0.4,
  };
}

export function buildChicken(): AnimalSpeciesModel {
  const body = new GeoBuilder();
  body.add(new THREE.IcosahedronGeometry(0.14, 0), trs(0, 0.32, 0, 0, 0, 0.15, 1.25, 1.0, 0.95), { color: 0xffffff, part: COAT, colorVar: 0.06 });
  body.add(new THREE.ConeGeometry(0.07, 0.16, 5), trs(-0.15, 0.42, 0, 0, 0, 0.7), { color: 0xffffff, part: COAT, colorVar: 0.06 });
  body.add(new THREE.BoxGeometry(0.14, 0.06, 0.02), trs(-0.01, 0.33, 0.12, 0, 0, 0.2), { color: 0xe8e8e8, part: COAT });
  body.add(new THREE.BoxGeometry(0.14, 0.06, 0.02), trs(-0.01, 0.33, -0.12, 0, 0, 0.2), { color: 0xe8e8e8, part: COAT });
  const head = new GeoBuilder();
  head.add(new THREE.IcosahedronGeometry(0.065, 0), trs(0.03, 0.08, 0), { color: 0xffffff, part: COAT });
  head.add(new THREE.ConeGeometry(0.022, 0.06, 4), trs(0.11, 0.075, 0, 0, 0, -Math.PI / 2), { color: 0xe0a030, part: FIXED });
  head.add(new THREE.BoxGeometry(0.07, 0.045, 0.014), trs(0.03, 0.155, 0), { color: 0xd02a20, part: FIXED });
  head.add(new THREE.BoxGeometry(0.02, 0.04, 0.012), trs(0.085, 0.035, 0), { color: 0xd02a20, part: FIXED });
  const l = new GeoBuilder();
  l.add(new THREE.BoxGeometry(0.018, 0.2, 0.018), trs(0, -0.1, 0), { color: 0xe0a030, part: FIXED });
  l.add(new THREE.BoxGeometry(0.06, 0.012, 0.04), trs(0.02, -0.195, 0), { color: 0xe0a030, part: FIXED });
  return {
    body: body.build(), head: head.build(), leg: l.build(), extra: null,
    legPivots: [[0.0, 0.2, 0.045], [0.0, 0.2, -0.045]],
    headPivot: [0.1, 0.36, 0], grazePitch: 1.25, stride: 0.22, legSwing: 0.6,
  };
}
