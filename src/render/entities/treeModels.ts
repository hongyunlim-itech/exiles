/**
 * Low-poly procedural geometries for trees (conifer / deciduous / birch, two LODs each), rocks, iron deposits and the
 * removal marker. All geometries are authored at "mature" scale with the base at y = 0.
 */
import * as THREE from 'three';
import { GeoBuilder, limb, PART_BARK, PART_FOLIAGE, PART_MARKER, PART_ROCK, trs } from './geoBuilder';

export const SPECIES_CONIFER = 0;
export const SPECIES_DECIDUOUS = 1;
export const SPECIES_BIRCH = 2;

/** Approximate top height (world units) of each species' mature model at scale 1. */
export const SPECIES_TOP = [3.0, 2.85, 2.75];
/** Approximate top height of the rock/iron model at scale 1. */
export const ROCK_TOP = 0.52;

const BARK_CONIFER = 0x5a3f2a;
const BARK_DECIDUOUS = 0x5e4630;
const BIRCH_WHITE = 0xe4e0d4;
const BIRCH_DARK = 0x3b3833;

type Blob = [number, number, number, number];

function addBranches(b: GeoBuilder, list: number[][], r0: number, r1: number, color: number, seg: number): void {
  for (const l of list) {
    b.add(new THREE.CylinderGeometry(r1, r0, 1, seg, 1, true), limb(l[0], l[1], l[2], l[3], l[4], l[5]), {
      color, colorVar: 0.06, part: PART_BARK,
    });
  }
}

function addBlobs(b: GeoBuilder, blobs: Blob[], seed: number, stretchY = 1, detail = 0): void {
  blobs.forEach(([x, y, z, r], k) => {
    b.add(new THREE.IcosahedronGeometry(r, detail), trs(x, y, z, k * 0.7, k * 1.3, k * 0.4, 1, stretchY, 1), {
      part: PART_FOLIAGE, foliage: true, colorVar: 0.1, brightness: 0.92 + 0.05 * (k % 3),
      jitter: r * 0.12, center: [x, y, z], seed: seed + k,
    });
  });
}

export function buildConifer(lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.05, 0.09, 0.9, lod === 0 ? 6 : 4, 1, true), trs(0, 0.45, 0), {
    color: BARK_CONIFER, colorVar: 0.08, part: PART_BARK,
  });
  const tiers: number[][] = lod === 0
    ? [[0.82, 1.3, 0.4], [0.66, 1.15, 1.0], [0.48, 1.0, 1.56], [0.29, 0.82, 2.16]]
    : [[0.8, 1.75, 0.4], [0.47, 1.4, 1.5]];
  tiers.forEach(([r, h, base], k) => {
    b.add(new THREE.ConeGeometry(r, h, lod === 0 ? 7 : 5, 1, false), trs(0, base + h / 2, 0, 0, k * 0.9, 0), {
      part: PART_FOLIAGE, foliage: true, colorVar: 0.09, brightness: 0.86 + k * 0.07,
      jitter: lod === 0 ? 0.035 : 0.02, center: [0, base + h * 0.3, 0], seed: 10 + k,
    });
  });
  return b.build();
}

export function buildDeciduous(lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const seg = lod === 0 ? 6 : 4;
  b.add(new THREE.CylinderGeometry(0.055, 0.1, 1.25, seg, 1, true), trs(0, 0.625, 0), {
    color: BARK_DECIDUOUS, colorVar: 0.08, part: PART_BARK,
  });
  if (lod === 0) {
    b.add(new THREE.CylinderGeometry(0.1, 0.16, 0.14, seg, 1, true), trs(0, 0.07, 0), { color: BARK_DECIDUOUS, colorVar: 0.08 });
    addBranches(b, [
      [0, 1.02, 0, 0.4, 1.6, 0.17],
      [0, 1.12, 0, -0.34, 1.66, -0.21],
      [0, 1.15, 0, 0.04, 2.2, -0.04],
      [0, 1.06, 0, -0.1, 1.55, 0.38],
    ], 0.042, 0.02, BARK_DECIDUOUS, 4);
    addBranches(b, [
      [0.4, 1.6, 0.17, 0.66, 1.86, 0.3],
      [-0.34, 1.66, -0.21, -0.58, 1.96, -0.31],
      [0.04, 2.2, -0.04, 0.2, 2.52, 0.1],
      [0.04, 2.2, -0.04, -0.16, 2.46, -0.16],
      [-0.1, 1.55, 0.38, -0.2, 1.82, 0.62],
      [0.4, 1.6, 0.17, 0.52, 1.64, -0.1],
      [0.2, 1.3, 0.09, 0.36, 1.42, 0.34],
      [-0.17, 1.39, -0.1, -0.44, 1.5, 0.05],
      [0.02, 1.7, -0.02, 0.26, 1.98, -0.22],
      [0.02, 1.7, -0.02, -0.2, 1.96, 0.18],
      [-0.58, 1.96, -0.31, -0.7, 2.12, -0.2],
      [0.66, 1.86, 0.3, 0.74, 2.02, 0.44],
      [-0.2, 1.82, 0.62, -0.08, 1.98, 0.7],
      [-0.16, 2.46, -0.16, -0.3, 2.58, -0.05],
    ], 0.02, 0.007, BARK_DECIDUOUS, 3);
    addBlobs(b, [
      [0, 1.92, 0, 0.72],
      [0.44, 1.64, 0.19, 0.5],
      [-0.38, 1.7, -0.23, 0.52],
      [0.06, 2.34, -0.05, 0.5],
      [-0.13, 1.57, 0.42, 0.45],
    ], 40, 0.92);
  } else {
    addBranches(b, [
      [0, 1.05, 0, 0.3, 1.7, 0.1],
      [0, 1.1, 0, -0.25, 1.9, -0.1],
    ], 0.04, 0.02, BARK_DECIDUOUS, 3);
    addBlobs(b, [
      [0, 1.88, 0, 0.82],
      [0.08, 2.3, 0.04, 0.56],
    ], 60, 0.92);
  }
  return b.build();
}

export function buildBirch(lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.03, 0.065, 2.3, lod === 0 ? 5 : 4, lod === 0 ? 6 : 3, true), trs(0, 1.15, 0), {
    part: PART_BARK, colorVar: 0.05,
    faceColor: (_f, _x, _y, _z, rnd) => (rnd < 0.24 ? BIRCH_DARK : BIRCH_WHITE),
  });
  if (lod === 0) {
    addBranches(b, [
      [0, 1.35, 0, 0.26, 1.85, 0.12],
      [0, 1.5, 0, -0.24, 1.98, -0.13],
      [0, 1.25, 0, 0.06, 1.62, -0.22],
      [0.26, 1.85, 0.12, 0.34, 2.15, 0.2],
      [-0.24, 1.98, -0.13, -0.3, 2.25, -0.2],
    ], 0.022, 0.009, 0xcfc9bb, 3);
    addBlobs(b, [
      [0, 2.3, 0, 0.42],
      [0.24, 1.88, 0.11, 0.34],
      [-0.22, 1.98, -0.13, 0.34],
      [0.06, 1.62, -0.2, 0.28],
    ], 80, 1.35);
  } else {
    addBlobs(b, [
      [0, 2.2, 0, 0.5],
      [0.05, 1.75, -0.05, 0.42],
    ], 90, 1.3);
  }
  return b.build();
}

/**
 * Far LOD (≈16–26 triangles): open cones / bipyramids with the same attribute layout, parts and foliage encoding
 * as the detailed models, so the same materials (seasons, snow, sway, leaf fall) apply. Deciduous & birch carry a
 * small bark-coloured "twig mass" inside the crown so bare winter trees don't vanish at distance.
 */
export function buildFarTree(species: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  if (species === SPECIES_CONIFER) {
    b.add(new THREE.CylinderGeometry(0.06, 0.09, 0.7, 3, 1, true), trs(0, 0.35, 0), { color: BARK_CONIFER, part: PART_BARK });
    b.add(new THREE.ConeGeometry(0.82, 1.85, 5, 1, true), trs(0, 0.4 + 0.925, 0), {
      part: PART_FOLIAGE, foliage: true, colorVar: 0.09, brightness: 0.88, center: [0, 0.95, 0], seed: 10,
    });
    b.add(new THREE.ConeGeometry(0.5, 1.4, 5, 1, true), trs(0, 1.6 + 0.7, 0, 0, 0.6, 0), {
      part: PART_FOLIAGE, foliage: true, colorVar: 0.09, brightness: 0.98, center: [0, 2.0, 0], seed: 11,
    });
    return b.build();
  }
  const birch = species === SPECIES_BIRCH;
  const trunkH = birch ? 2.1 : 1.35;
  b.add(new THREE.CylinderGeometry(birch ? 0.035 : 0.055, birch ? 0.065 : 0.1, trunkH, 3, 1, true), trs(0, trunkH / 2, 0), {
    color: birch ? BIRCH_WHITE : BARK_DECIDUOUS, part: PART_BARK, colorVar: 0.05,
  });
  // twig mass (visible when the leaves are gone)
  const cy = birch ? 2.05 : 1.9;
  b.add(new THREE.OctahedronGeometry(1, 0), trs(0, cy, 0, 0, 0.4, 0, birch ? 0.3 : 0.5, birch ? 0.55 : 0.45, birch ? 0.3 : 0.5), {
    color: birch ? 0xa89c88 : 0x6e5a44, part: PART_BARK, colorVar: 0.08,
  });
  // crown: hexagonal bipyramid (two open cones), jittered so instances read as lumpy blobs
  const r = birch ? 0.5 : 0.84;
  const up = birch ? 0.75 : 0.62;
  const down = birch ? 0.7 : 0.5;
  const seg = birch ? 5 : 6;
  const opts = { part: PART_FOLIAGE, foliage: true, colorVar: 0.1, brightness: 0.95, center: [0, cy, 0] as [number, number, number], jitter: 0.05 };
  b.add(new THREE.ConeGeometry(r, up, seg, 1, true), trs(0, cy + up / 2, 0), { ...opts, seed: birch ? 91 : 61 });
  b.add(new THREE.ConeGeometry(r, down, seg, 1, true), trs(0, cy - down / 2, 0, Math.PI, 0, 0), { ...opts, seed: birch ? 92 : 62 });
  return b.build();
}

export function buildTree(species: number, lod: 0 | 1 | 2): THREE.BufferGeometry {
  if (lod === 2) return buildFarTree(species);
  if (species === SPECIES_CONIFER) return buildConifer(lod);
  if (species === SPECIES_DECIDUOUS) return buildDeciduous(lod);
  return buildBirch(lod);
}

function buildRockShape(seed: number, colorFn: (rnd: number, cy: number) => number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const fc = (_f: number, _x: number, cy: number, _z: number, rnd: number) => colorFn(rnd, cy);
  b.add(new THREE.DodecahedronGeometry(0.45, 0), trs(0, 0.16, 0, 0.3, seed * 0.7, 0.1, 1, 0.75, 0.85), {
    part: PART_ROCK, colorVar: 0.1, jitter: 0.05, seed, faceColor: fc,
  });
  b.add(new THREE.IcosahedronGeometry(0.23, 0), trs(0.34, 0.06, 0.13, 0.2, seed, 0, 1, 0.7, 1), {
    part: PART_ROCK, colorVar: 0.1, jitter: 0.03, seed: seed + 5, faceColor: fc,
  });
  b.add(new THREE.IcosahedronGeometry(0.17, 0), trs(-0.29, 0.04, -0.21, 0.5, seed * 2, 0.3, 1, 0.8, 1), {
    part: PART_ROCK, colorVar: 0.1, jitter: 0.02, seed: seed + 9, faceColor: fc,
  });
  return b.build();
}

export function buildRock(): THREE.BufferGeometry {
  return buildRockShape(3, (rnd, cy) => (cy > 0.3 && rnd > 0.82 ? 0x707a58 : rnd < 0.2 ? 0x77746d : 0x908c84));
}

export function buildIron(): THREE.BufferGeometry {
  return buildRockShape(7, (rnd) => (rnd < 0.16 ? 0xb8662c : rnd < 0.23 ? 0xd08a3a : rnd < 0.42 ? 0x3a302c : rnd < 0.7 ? 0x5e5049 : 0x6e5a50));
}

export function buildMarker(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.OctahedronGeometry(0.1, 0), trs(0, 0, 0, 0, 0, 0, 1, 1.7, 1), { color: 0xf05a28, part: PART_MARKER, colorVar: 0.12 });
  return b.build();
}
