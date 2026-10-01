/**
 * Auxiliary geometries used by the BuildingRenderer: construction scaffolding, clearing stakes, ruin debris,
 * merchant boat, grave sets, and unit pile shapes for instanced storage piles. All vertex-coloured with the
 * `fx` attribute so they render with the shared building material.
 */
import type * as THREE from 'three';
import { ModelBuilder } from './builder';
import { markSharedGeometry } from './index';
import { C } from './palette';
import { barrel as barrelPart, crate as cratePart } from './parts';
import type { BodyBox } from './spec';
import { emitGraves } from './types/zones';

const PI = Math.PI;
const cache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = make();
    g.name = key;
    markSharedGeometry(g);
    cache.set(key, g);
  }
  return g;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

// ---- scaffolding --------------------------------------------------------------------------------

/** Scaffolding around a body box (poles, ledgers, walkway planks, braces). Cached per body. */
export function scaffoldGeometry(body: BodyBox): THREE.BufferGeometry {
  const key = `scaffold:${r2(body.minX)},${r2(body.maxX)},${r2(body.minZ)},${r2(body.maxZ)},${r2(body.top)}`;
  return cached(key, () => {
    const b = new ModelBuilder(4242);
    const pad = 0.16;
    const x0 = body.minX - pad;
    const x1 = body.maxX + pad;
    const z0 = body.minZ - pad;
    const z1 = body.maxZ + pad;
    const top = Math.max(0.9, body.top + 0.35);
    const levels: number[] = [];
    for (let y = 0.7; y < top - 0.15; y += 0.75) levels.push(y);
    const edges: [number, number, number, number][] = [
      [x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0],
    ];
    for (const [ax, az, bx, bz] of edges) {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 1.05));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        b.box(0.05, top, 0.05, ax + (bx - ax) * t, 0, az + (bz - az) * t, C.timberLight, { jitter: 0.08 });
      }
      for (const y of levels) b.beam(ax, y, az, bx, y, bz, 0.035, C.timberLight);
      b.beam(ax, top - 0.05, az, bx, top - 0.05, bz, 0.035, C.timberLight);
      // walkway planks just inside the poles
      const nx = -(bz - az) / len;
      const nz = (bx - ax) / len;
      const ry = Math.atan2(-(bz - az), bx - ax);
      for (const y of levels) {
        b.box(len, 0.03, 0.2, (ax + bx) / 2 + nx * 0.09, y + 0.02, (az + bz) / 2 + nz * 0.09, C.plank, { ry, jitter: 0.06 });
      }
      // one diagonal brace per edge
      b.beam(ax, 0.05, az, ax + (bx - ax) * Math.min(1, 1.1 / len), Math.min(top - 0.1, levels[0] ?? top - 0.1), az + (bz - az) * Math.min(1, 1.1 / len), 0.03, C.timber);
    }
    return b.build();
  });
}

// ---- clearing stakes ----------------------------------------------------------------------------

/** Survey stakes with string outlining a footprint (w × h, model space). Built fresh (zones get conformed). */
export function stakesGeometry(w: number, h: number, seed = 1): THREE.BufferGeometry {
  const b = new ModelBuilder(seed + 99);
  const inset = 0.12;
  const hx = w / 2 - inset;
  const hz = h / 2 - inset;
  const pts: [number, number][] = [];
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 1.5));
    for (let i = 0; i < n; i++) pts.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  };
  edge(-hx, -hz, hx, -hz);
  edge(hx, -hz, hx, hz);
  edge(hx, hz, -hx, hz);
  edge(-hx, hz, -hx, -hz);
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const corner = Math.abs(Math.abs(x) - hx) < 1e-3 && Math.abs(Math.abs(z) - hz) < 1e-3;
    b.box(0.05, corner ? 0.45 : 0.36, 0.05, x, 0, z, C.stake, { ry: b.range(-0.3, 0.3) });
    if (corner) b.box(0.13, 0.08, 0.012, x + 0.07, 0.34, z, C.flagRed, { snow: false });
    const [nx, nz] = pts[(i + 1) % pts.length];
    b.beam(x, 0.28, z, nx, 0.28, nz, 0.014, C.string, { snow: false });
  }
  return b.build();
}

// ---- ruins --------------------------------------------------------------------------------------

/** Charred debris (fallen beams, ash, rubble) scattered over a body box. Cached per body. */
export function ruinDebrisGeometry(body: BodyBox): THREE.BufferGeometry {
  const key = `ruin:${r2(body.minX)},${r2(body.maxX)},${r2(body.minZ)},${r2(body.maxZ)}`;
  return cached(key, () => {
    const b = new ModelBuilder(777);
    const sx = body.maxX - body.minX;
    const sz = body.maxZ - body.minZ;
    const cx = (body.minX + body.maxX) / 2;
    const cz = (body.minZ + body.maxZ) / 2;
    const n = Math.max(3, Math.round((sx * sz) / 1.2));
    for (let i = 0; i < n; i++) {
      const x = cx + b.range(-0.4, 0.4) * sx;
      const z = cz + b.range(-0.4, 0.4) * sz;
      const len = b.range(0.6, 1.4);
      const a = b.rand() * PI;
      const lift = b.range(0.05, 0.45);
      b.beam(x - Math.cos(a) * len / 2, 0.06, z - Math.sin(a) * len / 2, x + Math.cos(a) * len / 2, lift, z + Math.sin(a) * len / 2, 0.09, i % 3 === 0 ? C.coal : C.char);
    }
    for (let i = 0; i < Math.max(2, n / 2); i++) {
      b.blob(b.range(0.25, 0.45), b.range(0.08, 0.16), b.range(0.25, 0.45), cx + b.range(-0.35, 0.35) * sx, 0, cz + b.range(-0.35, 0.35) * sz, C.ash, { jitter: 0.1 });
    }
    for (let i = 0; i < n; i++) {
      b.box(0.2, 0.12, 0.16, cx + b.range(-0.5, 0.5) * sx, 0, cz + b.range(-0.5, 0.5) * sz, C.stoneDark, { ry: b.rand() * PI, jitter: 0.1 });
    }
    return b.build();
  });
}

// ---- merchant boat ------------------------------------------------------------------------------

/** A single-masted trading cog, bow toward +Z, waterline at y = 0. */
export function merchantBoatGeometry(): THREE.BufferGeometry {
  return cached('merchantBoat', () => {
    const b = new ModelBuilder(31337);
    const beam = 1.25;
    const mid = 2.2;
    const hTop = 0.34;
    const hBot = -0.36;
    const hull = 0x6e4a2c;
    // midsection (prism along Z)
    b.at(0, 0, 0, PI / 2, () => {
      b.prism([[-beam / 2, hTop], [beam / 2, hTop], [beam / 3, hBot], [-beam / 3, hBot]], mid, 0, 0, 0, hull);
    });
    // bow (+Z) and stern (-Z)
    b.convex(
      [[-beam / 2, hTop, 0], [beam / 2, hTop, 0], [beam / 3, hBot, 0], [-beam / 3, hBot, 0], [0, hTop + 0.18, 1.0], [0, hBot + 0.12, 0.7]],
      [[0, 1, 2, 3], [0, 1, 4], [3, 2, 5], [0, 3, 5, 4], [1, 2, 5, 4]],
      0, 0, mid / 2, hull,
    );
    b.convex(
      [[-beam / 2, hTop, 0], [beam / 2, hTop, 0], [beam / 3, hBot, 0], [-beam / 3, hBot, 0], [-beam * 0.42, hTop + 0.1, -0.45], [beam * 0.42, hTop + 0.1, -0.45], [beam * 0.25, hBot + 0.2, -0.4], [-beam * 0.25, hBot + 0.2, -0.4]],
      [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]],
      0, 0, -mid / 2, hull,
    );
    // stripe & gunwale
    b.box(beam + 0.02, 0.06, mid, 0, hTop - 0.14, 0, C.clothRed, { snow: false });
    b.box(beam - 0.1, 0.02, mid + 0.6, 0, hTop - 0.02, 0.1, C.plank);
    for (const s of [-1, 1]) b.box(0.06, 0.1, mid + 0.4, s * (beam / 2 - 0.03), hTop, 0.05, C.timberDark);
    // stern castle
    b.box(beam - 0.2, 0.42, 0.75, 0, hTop, -mid / 2 + 0.15, C.plank);
    b.box(beam - 0.06, 0.06, 0.85, 0, hTop + 0.42, -mid / 2 + 0.15, C.timberDark);
    b.box(0.2, 0.18, 0.02, 0, hTop + 0.12, -mid / 2 + 0.53, C.window, { glow: 1, snow: false });
    // mast, yard, sail
    const mz = 0.25;
    b.cyl(0.06, 3.1, 0, hTop, mz, C.timberDark, { seg: 6 });
    b.box(0.2, 0.12, 0.2, 0, hTop + 2.55, mz, C.timberDark);
    b.beam(-1.0, hTop + 2.65, mz, 1.0, hTop + 2.65, mz, 0.06, C.timber);
    b.beam(-0.9, hTop + 1.05, mz + 0.05, 0.9, hTop + 1.05, mz + 0.05, 0.05, C.timber);
    for (let i = 0; i < 4; i++) {
      const y0 = hTop + 1.08 + i * 0.39;
      const bulge = Math.sin(((i + 0.5) / 4) * PI) * 0.12;
      b.box(1.8, 0.39, 0.03, 0, y0, mz + 0.06 + bulge, i % 2 === 0 ? C.cloth : 0xd8c9a8, { snow: false, jitter: 0.02 });
    }
    b.box(0.3, 0.9, 0.035, 0, hTop + 1.4, mz + 0.2, C.clothRed, { snow: false });
    b.box(0.3, 0.14, 0.02, 0.16, hTop + 3.0, mz, C.clothRed, { snow: false });
    // rigging
    b.beam(0, hTop + 2.9, mz, 0, hTop + 0.1, mid / 2 + 0.9, 0.015, C.rope, { snow: false });
    b.beam(0, hTop + 2.9, mz, 0, hTop + 0.4, -mid / 2 + 0.1, 0.015, C.rope, { snow: false });
    for (const s of [-1, 1]) b.beam(0, hTop + 2.6, mz, s * (beam / 2 - 0.05), hTop + 0.05, mz - 0.1, 0.012, C.rope, { snow: false });
    // cargo
    cratePart(b, 0.25, hTop, 0.85, 0.28, C.plank, 0.2);
    cratePart(b, -0.2, hTop, 0.95, 0.24, C.plankGrey, 0.6);
    barrelPart(b, 0.3, hTop, -0.35, 0.13, 0.32);
    barrelPart(b, -0.28, hTop, -0.25, 0.13, 0.32);
    return b.build();
  });
}

// ---- graves -------------------------------------------------------------------------------------

/** Grave mounds + headstones for `count` slots (model space). Built fresh (terrain-conformed by the caller). */
export function gravesGeometry(slots: THREE.Vector3[], count: number, seed: number): THREE.BufferGeometry {
  const b = new ModelBuilder(seed + 555);
  emitGraves(b, slots, count);
  return b.build();
}

// ---- pile unit shapes (instanced) ---------------------------------------------------------------

export type PileShape = 'logs' | 'stones' | 'ore' | 'firewood' | 'crate' | 'basket' | 'barrel' | 'content' | 'sack';

/**
 * Unit pile shapes (footprint ~0.8 × 0.8, height ~0.5 at scale 1). Tinted shapes use near-white vertex colours so
 * the instance colour (resource colour) shows through; container shapes carry natural colours (instance = white).
 */
export function pileShapeGeometry(shape: PileShape): THREE.BufferGeometry {
  return cached(`pile:${shape}`, () => {
    const b = new ModelBuilder(shape.length * 131);
    const W = 0xffffff;
    const L = 0xd9d9d9;
    const D = 0xb8b8b8;
    switch (shape) {
      case 'logs': {
        const r = 0.085;
        for (let row = 0; row < 3; row++) {
          const n = 4 - row;
          for (let i = 0; i < n; i++) {
            const z = (i - (n - 1) / 2) * r * 2.05;
            const y = r + row * r * 1.75;
            b.cyl(r, 0.78, -0.39 + b.range(-0.03, 0.03), y, z, L, { rz: -PI / 2, seg: 6, a0: 0.3, jitter: 0.08 });
            b.cyl(r * 0.8, 0.012, 0.39, y, z, 0xfff2dc, { rz: -PI / 2, seg: 6, noBottom: true, jitter: 0.02 });
          }
        }
        break;
      }
      case 'stones': {
        const spots = [[-0.2, -0.18], [0.18, -0.15], [-0.15, 0.2], [0.2, 0.18], [0, 0]];
        spots.forEach(([x, z], i) => {
          const s = b.range(0.24, 0.32);
          b.box(s, s * 0.75, s, x, i === 4 ? 0.2 : 0, z, i % 2 ? L : W, { ry: b.rand() * PI, jitter: 0.1 });
        });
        break;
      }
      case 'ore': {
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * PI * 2;
          const d = i === 6 ? 0 : 0.2;
          b.blob(0.14, 0.12, 0.14, Math.cos(a) * d, i === 6 ? 0.2 : 0.09, Math.sin(a) * d, i % 2 ? L : D, { ry: b.rand() * PI, jitter: 0.1 });
        }
        break;
      }
      case 'firewood': {
        // criss-cross crib of split billets
        for (let layer = 0; layer < 5; layer++) {
          const along = layer % 2 === 0;
          for (let i = 0; i < 5; i++) {
            const o = -0.3 + i * 0.15;
            const y = 0.04 + layer * 0.085;
            if (along) b.cyl(0.042, 0.66, -0.33, y, o, i % 2 ? L : W, { rz: -PI / 2, seg: 5, a0: i * 0.7, jitter: 0.1 });
            else b.cyl(0.042, 0.66, o, y, -0.33, i % 2 ? L : W, { rx: PI / 2, seg: 5, a0: i * 0.7, jitter: 0.1 });
          }
        }
        break;
      }
      case 'crate':
        cratePart(b, 0, 0, 0, 0.36, C.plank, 0);
        break;
      case 'basket':
        b.cyl(0.14, 0.16, 0, 0, 0, C.plank, { seg: 8, rTop: 0.18 });
        b.cyl(0.185, 0.03, 0, 0.15, 0, C.timberDark, { seg: 8, noBottom: true });
        break;
      case 'barrel':
        barrelPart(b, 0, 0, 0, 0.15, 0.38, C.timber);
        b.cyl(0.13, 0.01, 0, 0.38, 0, C.timberDark, { seg: 8, noBottom: true });
        break;
      case 'content':
        b.blob(0.15, 0.08, 0.15, 0, 0, 0, W, { jitter: 0.06 });
        b.blob(0.05, 0.04, 0.05, 0.06, 0.05, 0.03, L);
        b.blob(0.05, 0.04, 0.05, -0.05, 0.05, -0.04, L);
        break;
      case 'sack':
        b.blob(0.15, 0.18, 0.13, 0, 0.16, 0, W, { jitter: 0.04 });
        b.cyl(0.045, 0.07, 0, 0.3, 0, D, { seg: 5 });
        break;
    }
    return b.build();
  });
}
