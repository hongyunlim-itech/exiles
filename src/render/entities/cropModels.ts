/**
 * Per-tile crop geometries (one instance per field tile) and orchard trees. Plants are authored with unit height
 * (scaled by crop height × growth per instance) over a 1×1 tile centred at the origin; colours are white/grey so the
 * per-instance colour (young → ripe) tints them. Rows run along X.
 */
import * as THREE from 'three';
import { hash2 } from '../../core/rng';
import { GeoBuilder, limb, PART_BARK, PART_FOLIAGE, trs } from './geoBuilder';

const ROWS3 = [-0.31, 0, 0.31];

/** A single thin blade triangle (double-sided material) from (0,0,0) up to height h, leaning by (lx, lz). */
function blade(w: number, h: number, lx: number, lz: number, rot: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const c = Math.cos(rot) * w * 0.5;
  const s = Math.sin(rot) * w * 0.5;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-c, 0, -s, c, 0, s, lx, h, lz], 3));
  return g;
}

export function buildFurrows(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (const z of ROWS3) {
    b.add(new THREE.CylinderGeometry(0.1, 0.1, 0.96, 3, 2, false), trs(0, -0.012, z, 0, 0, Math.PI / 2, 1, 1, 0.42), {
      color: 0x5e442b, colorVar: 0.07, jitter: 0.012, seed: 5,
    });
  }
  return b.build();
}

/** Dense wheat: 5×5 sheaves per tile, each a slim cone darker at the base and lighter at the ears. */
export function buildWheat(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of [-0.38, -0.19, 0, 0.19, 0.38]) {
    for (const x of [-0.4, -0.2, 0, 0.2, 0.4]) {
      const jx = x + (hash2(k, 1, 3) - 0.5) * 0.09;
      const jz = z + (hash2(k, 2, 3) - 0.5) * 0.07;
      const h = 0.82 + hash2(k, 3, 3) * 0.26;
      const r = 0.075 + hash2(k, 4, 3) * 0.03;
      const lx = (hash2(k, 5, 3) - 0.5) * 0.3;
      const lz = (hash2(k, 6, 3) - 0.5) * 0.3;
      b.add(new THREE.ConeGeometry(r, h, 4, 1, true), trs(jx, h / 2, jz, lx, hash2(k, 7, 3) * 3, lz), {
        color: 0xffffff, colorVar: 0.1, seed: k, shade: (_x, y) => 0.62 + 0.55 * Math.min(1, Math.max(0, y)),
      });
      k++;
    }
  }
  return b.build();
}

export function buildCorn(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of [-0.26, 0.26]) {
    for (const x of [-0.3, 0, 0.3]) {
      const jx = x + (hash2(k, 1, 9) - 0.5) * 0.08;
      const jz = z + (hash2(k, 2, 9) - 0.5) * 0.08;
      b.add(new THREE.BoxGeometry(0.045, 1, 0.045), trs(jx, 0.5, jz), { color: 0xe6e6e0, colorVar: 0.05, shade: (_x, y) => 0.75 + 0.3 * y });
      for (let j = 0; j < 4; j++) {
        const a = j * 1.9 + hash2(k, j, 10) * 0.9;
        const y0 = 0.2 + j * 0.17;
        const L = 0.34 - j * 0.04;
        b.add(blade(0.11, L * 0.55, Math.cos(a) * L, Math.sin(a) * L, a + Math.PI / 2), trs(jx, y0, jz), { color: 0xffffff, colorVar: 0.12, seed: k * 11 + j });
      }
      b.add(new THREE.ConeGeometry(0.035, 0.16, 4), trs(jx, 1.06, jz), { color: 0xf0e0b0 });
      k++;
    }
  }
  return b.build();
}

export function buildCornCobs(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of [-0.26, 0.26]) {
    for (const x of [-0.3, 0, 0.3]) {
      const jx = x + (hash2(k, 1, 9) - 0.5) * 0.08;
      const jz = z + (hash2(k, 2, 9) - 0.5) * 0.08;
      const a = hash2(k, 3, 9) * Math.PI * 2;
      b.add(new THREE.OctahedronGeometry(0.035, 0), trs(jx + Math.cos(a) * 0.04, 0.55, jz + Math.sin(a) * 0.04, 0, -a, 0.35, 1, 2.4, 1), { color: 0xffffff, colorVar: 0.08 });
      k++;
    }
  }
  return b.build();
}

export function buildPotato(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of [-0.24, 0.24]) {
    for (const x of [-0.3, 0, 0.3]) {
      b.add(new THREE.IcosahedronGeometry(0.19, 0), trs(x + (hash2(k, 1, 12) - 0.5) * 0.06, 0.45, z, k, k * 2, 0, 1, 2.6, 1), {
        color: 0xffffff, colorVar: 0.12, jitter: 0.02, seed: k,
      });
      k++;
    }
  }
  return b.build();
}

export function buildBeans(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of [-0.25, 0.25]) {
    for (const x of [-0.3, 0, 0.3]) {
      b.add(new THREE.IcosahedronGeometry(0.13, 0), trs(x, 0.5, z, k, k, 0, 1, 3.6, 1), { color: 0xffffff, colorVar: 0.14, jitter: 0.02, seed: k + 40 });
      b.add(new THREE.OctahedronGeometry(0.035, 0), trs(x + 0.08, 0.7, z + 0.07, 0, 0, 0, 1, 2.5, 1), { color: 0xc8e0a0 });
      k++;
    }
  }
  return b.build();
}

export function buildStubble(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of ROWS3) {
    for (const x of [-0.38, -0.19, 0, 0.19, 0.38]) {
      const h = 0.7 + hash2(k, 1, 20) * 0.6;
      b.add(new THREE.CylinderGeometry(0.012, 0.02, h, 3, 1, true), trs(x + (hash2(k, 2, 20) - 0.5) * 0.08, h / 2, z + (hash2(k, 3, 20) - 0.5) * 0.08, 0, 0, (hash2(k, 4, 20) - 0.5) * 0.6), {
        color: 0xffffff, colorVar: 0.12,
      });
      k++;
    }
  }
  return b.build();
}

export function buildMounds(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const z of [-0.24, 0.24]) {
    for (const x of [-0.3, 0, 0.3]) {
      b.add(new THREE.IcosahedronGeometry(0.13, 0), trs(x, 0.0, z, k, k, 0, 1.1, 0.45, 1), { color: 0xffffff, colorVar: 0.1, jitter: 0.015, seed: k + 70 });
      k++;
    }
  }
  return b.build();
}

// ---- orchards ----------------------------------------------------------------------------------------------

const ORCHARD_BLOBS: [number, number, number, number][] = [
  [0, 1.08, 0, 0.5],
  [0.3, 0.92, 0.13, 0.36],
  [-0.27, 0.96, -0.16, 0.38],
  [0.05, 1.38, -0.03, 0.34],
  [-0.1, 0.9, 0.3, 0.32],
];

export function buildOrchardTree(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const bark = 0x5e4630;
  b.add(new THREE.CylinderGeometry(0.045, 0.075, 0.62, 5, 1, true), trs(0, 0.31, 0), { color: bark, colorVar: 0.08, part: PART_BARK });
  const limbs = [
    [0, 0.55, 0, 0.3, 0.92, 0.13],
    [0, 0.58, 0, -0.27, 0.96, -0.16],
    [0, 0.6, 0, 0.05, 1.3, -0.03],
    [0, 0.56, 0, -0.1, 0.88, 0.3],
    [0.3, 0.92, 0.13, 0.46, 1.12, 0.2],
    [-0.27, 0.96, -0.16, -0.42, 1.16, -0.22],
  ];
  limbs.forEach((l, i) => {
    const r0 = i < 4 ? 0.035 : 0.018;
    const r1 = i < 4 ? 0.018 : 0.008;
    b.add(new THREE.CylinderGeometry(r1, r0, 1, 4, 1, true), limb(l[0], l[1], l[2], l[3], l[4], l[5]), { color: bark, colorVar: 0.06, part: PART_BARK });
  });
  ORCHARD_BLOBS.forEach(([x, y, z, r], k) => {
    b.add(new THREE.IcosahedronGeometry(r, 0), trs(x, y, z, k * 0.7, k * 1.3, 0, 1, 0.9, 1), {
      part: PART_FOLIAGE, foliage: true, colorVar: 0.1, brightness: 0.93 + 0.04 * (k % 3), jitter: r * 0.12, center: [x, y, z], seed: 300 + k,
    });
  });
  return b.build();
}

/** Fruit dots on the outside of the orchard canopy; each dot shrinks toward its own centre (EN_INSTSHRINK). */
export function buildOrchardFruit(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  let k = 0;
  for (const [cx, cy, cz, r] of ORCHARD_BLOBS) {
    const n = r > 0.45 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const a = hash2(k, 1, 31) * Math.PI * 2;
      const el = -0.35 + hash2(k, 2, 31) * 0.9;
      const px = cx + Math.cos(a) * Math.cos(el) * r * 0.92;
      const py = cy + Math.sin(el) * r * 0.85;
      const pz = cz + Math.sin(a) * Math.cos(el) * r * 0.92;
      b.add(new THREE.IcosahedronGeometry(0.045, 0), trs(px, py, pz), { color: 0xffffff, colorVar: 0.1, part: PART_FOLIAGE, center: [px, py, pz] });
      k++;
    }
  }
  return b.build();
}
