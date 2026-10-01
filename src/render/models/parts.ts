/**
 * Reusable composite parts (walls, roofs, doors, windows, chimneys, clutter…) authored in model space.
 * All take a ModelBuilder and emit into it. "face" parts are authored facing +Z and rotated with FACE_RY.
 */
import * as THREE from 'three';
import type { ModelBuilder, PartOpts } from './builder';
import { C } from './palette';

export type Face = 'pz' | 'nz' | 'px' | 'nx';
export const FACE_RY: Record<Face, number> = { pz: 0, px: Math.PI / 2, nz: Math.PI, nx: -Math.PI / 2 };

const PI = Math.PI;

// ---- foundations --------------------------------------------------------------------------------

/** Foundation skirt: a slab from deep below ground up to `h`, so sloped ground never shows gaps. */
export function plinth(b: ModelBuilder, sx: number, sz: number, h = 0.12, x = 0, z = 0, color: number = C.foundation): void {
  b.box(sx, h + 1.6, sz, x, -1.6, z, color, { noBottom: true, jitter: 0.02 });
}

// ---- walls & bodies -------------------------------------------------------------------------------

export interface GableHouseOpts {
  x?: number;
  z?: number;
  /** Length along the ridge axis. */
  len: number;
  /** Depth across the ridge. */
  depth: number;
  /** Bottom of walls (usually plinth top). */
  y0?: number;
  wallTop: number;
  ridge: number;
  /** 'x': ridge runs along X (gables at ±X). 'z': ridge along Z (gables at ±Z). */
  axis?: 'x' | 'z';
  wall: number;
  roof: number;
  gable?: number;
  over?: number;
  endOver?: number;
  thick?: number;
  ridgeCap?: number | null;
  /** Corner posts colour (timber framing) or null. */
  corners?: number | null;
}

/** Walls + attic gable fill + two roof slabs + ridge cap. Returns the roof pitch angle. */
export function gableHouse(b: ModelBuilder, o: GableHouseOpts): number {
  const x = o.x ?? 0;
  const z = o.z ?? 0;
  const y0 = o.y0 ?? 0;
  const axis = o.axis ?? 'x';
  const sx = axis === 'x' ? o.len : o.depth;
  const sz = axis === 'x' ? o.depth : o.len;
  b.box(sx, o.wallTop - y0, sz, x, y0, z, o.wall);
  if (o.corners) {
    const t = 0.1;
    for (const cx of [-1, 1]) {
      for (const cz of [-1, 1]) {
        b.box(t, o.wallTop - y0 - 0.02, t, x + cx * (sx / 2 - t / 2 + 0.02), y0, z + cz * (sz / 2 - t / 2 + 0.02), o.corners);
      }
    }
  }
  return gableRoof(b, {
    x, z, len: o.len, depth: o.depth, wallTop: o.wallTop, ridge: o.ridge, axis, color: o.roof,
    gable: o.gable ?? o.wall, over: o.over, endOver: o.endOver, thick: o.thick, ridgeCap: o.ridgeCap,
  });
}

export interface GableRoofOpts {
  x?: number;
  z?: number;
  len: number;
  depth: number;
  wallTop: number;
  ridge: number;
  axis?: 'x' | 'z';
  color: number;
  /** Colour of the attic gable fill (null: none). */
  gable?: number | null;
  over?: number;
  endOver?: number;
  thick?: number;
  ridgeCap?: number | null;
}

/** Two thick roof slabs meeting at a ridge (+ gable attic fill, + ridge cap). Returns pitch angle. */
export function gableRoof(b: ModelBuilder, o: GableRoofOpts): number {
  const over = o.over ?? 0.22;
  const endOver = o.endOver ?? 0.16;
  const thick = o.thick ?? 0.1;
  const halfD = o.depth / 2 + over;
  const slope = (o.ridge - o.wallTop) / (o.depth / 2);
  // the slab top surface passes LIFT above the wall-top edge (avoids z-fighting along the eave line)
  const LIFT = 0.035;
  const ridgeY = o.ridge + LIFT;
  const eaveY = ridgeY - slope * halfD;
  const rise = ridgeY - eaveY;
  const a = Math.atan2(rise, halfD);
  const L = Math.hypot(rise, halfD) + 0.015;
  const lenT = o.len + endOver * 2;
  const ry = (o.axis ?? 'x') === 'x' ? 0 : PI / 2;
  const vOff = thick / Math.cos(a);
  b.at(o.x ?? 0, 0, o.z ?? 0, ry, () => {
    if (o.gable !== null && o.gable !== undefined) {
      const hd = o.depth / 2;
      // attic fill: base just under the wall top (so construction reveals don't show a low lid), apex just under
      // the slab undersides; its sloped faces stay hidden inside/below the roof slabs
      b.prism([[-hd, o.wallTop - 0.015], [hd, o.wallTop - 0.015], [0, o.ridge + LIFT - vOff - 0.012]], o.len - 0.02, 0, 0, 0, o.gable);
    }
    for (const side of [1, -1]) {
      const cz = side * (halfD / 2) - side * Math.sin(a) * (thick / 2);
      const cy = (ridgeY + eaveY) / 2 - Math.cos(a) * (thick / 2);
      b.boxc(lenT, thick, L, 0, cy, cz, o.color, { rx: side * a });
    }
    if (o.ridgeCap !== null) {
      b.boxc(lenT + 0.02, 0.07, 0.14, 0, ridgeY + 0.005, 0, o.ridgeCap ?? o.color, { rx: PI / 4, jitter: 0.02 });
    }
  });
  return a;
}

/**
 * Roof slabs along an arbitrary cross-section top line `pts` ([across, y] pairs from one eave to the other),
 * extruded along the ridge axis. Used for gambrel (barn) roofs and lean-tos.
 */
export function profileRoof(b: ModelBuilder, pts: ReadonlyArray<readonly [number, number]>, len: number, o: { x?: number; z?: number; axis?: 'x' | 'z'; thick?: number; color: number; endOver?: number }): void {
  const thick = o.thick ?? 0.1;
  const lenT = len + 2 * (o.endOver ?? 0.14);
  const ry = (o.axis ?? 'x') === 'x' ? 0 : PI / 2;
  b.at(o.x ?? 0, 0, o.z ?? 0, ry, () => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [z0, y0] = pts[i];
      const [z1, y1] = pts[i + 1];
      const dz = z1 - z0;
      const dy = y1 - y0;
      const L = Math.hypot(dz, dy);
      const nz = -dy / L;
      const ny = dz / L;
      b.boxc(lenT, thick, L + 0.012, 0, (y0 + y1) / 2 - (ny * thick) / 2, (z0 + z1) / 2 - (nz * thick) / 2, o.color, { rx: Math.atan2(-dy, dz) });
    }
  });
}

/** Y of the roof top surface at a distance `d` from the ridge line (for placing chimneys/dormers). */
export function roofYAt(wallTop: number, ridge: number, depth: number, d: number): number {
  const slope = (ridge - wallTop) / (depth / 2);
  return ridge - slope * Math.abs(d);
}

/** Half-timber decoration on a rectangular wall face (posts, mid rail, braces). */
export function timberFace(b: ModelBuilder, cx: number, cz: number, face: Face, width: number, y0: number, y1: number, color: number = C.timberDark, posts = 3): void {
  b.at(cx, 0, cz, FACE_RY[face], () => {
    const t = 0.06;
    const d = 0.03;
    b.box(width, t, d, 0, y1 - t - 0.03, d / 2, color, { snow: false });
    b.box(width, t, d, 0, y0 + (y1 - y0) * 0.5, d / 2, color, { snow: false });
    for (let i = 0; i < posts; i++) {
      const px = -width / 2 + t / 2 + (i / (posts - 1)) * (width - t);
      b.box(t, y1 - y0 - 0.03, d, px, y0, d / 2, color, { snow: false });
    }
    // braces in first/last bays (lower half)
    const bay = (width - t) / (posts - 1);
    const ym = y0 + (y1 - y0) * 0.5;
    b.beam(-width / 2 + t, y0 + 0.02, d / 2, -width / 2 + bay - t / 2, ym, d / 2, 0.05, color, { snow: false, t2: d });
    b.beam(width / 2 - t, y0 + 0.02, d / 2, width / 2 - bay + t / 2, ym, d / 2, 0.05, color, { snow: false, t2: d });
  });
}

/** Horizontal log lines on a wall face (log-cabin look). */
export function logLines(b: ModelBuilder, cx: number, cz: number, face: Face, width: number, y0: number, y1: number, color: number = C.timberDark, step = 0.18): void {
  b.at(cx, 0, cz, FACE_RY[face], () => {
    for (let y = y0 + step; y < y1 - 0.1; y += step) {
      b.box(width, 0.025, 0.02, 0, y, 0.01, color, { snow: false, jitter: 0.01 });
    }
  });
}

// ---- openings -----------------------------------------------------------------------------------

export interface WindowOpts {
  w?: number;
  h?: number;
  frame?: number;
  shutters?: number | null;
  glass?: number;
  glow?: number;
}

/** Window on a wall. (x, y, z) = point on the wall surface at the window's bottom centre. */
export function windowAt(b: ModelBuilder, x: number, y: number, z: number, face: Face, o?: WindowOpts): void {
  const w = o?.w ?? 0.26;
  const h = o?.h ?? 0.3;
  const frame = o?.frame ?? C.windowFrame;
  b.at(x, y, z, FACE_RY[face], () => {
    b.box(w + 0.08, h + 0.08, 0.04, 0, -0.04, 0.01, frame, { snow: false });
    b.box(w, h, 0.05, 0, 0, 0.015, o?.glass ?? C.window, { glow: o?.glow ?? 1, snow: false, jitter: 0.01 });
    b.box(0.025, h, 0.06, 0, 0, 0.02, frame, { snow: false });
    b.box(w, 0.025, 0.06, 0, h / 2 - 0.012, 0.02, frame, { snow: false });
    b.box(w + 0.14, 0.035, 0.1, 0, -0.07, 0.045, frame);
    if (o?.shutters) {
      b.box(w * 0.5, h + 0.04, 0.03, -(w * 0.75 + 0.05), -0.02, 0.02, o.shutters, { snow: false });
      b.box(w * 0.5, h + 0.04, 0.03, w * 0.75 + 0.05, -0.02, 0.02, o.shutters, { snow: false });
    }
  });
}

/** Door on a wall. (x, y, z) = point on the wall surface at the door's bottom centre. */
export function doorAt(b: ModelBuilder, x: number, y: number, z: number, face: Face, o?: { w?: number; h?: number; color?: number; frame?: number; step?: number | null; arch?: boolean }): void {
  const w = o?.w ?? 0.42;
  const h = o?.h ?? 0.72;
  const frame = o?.frame ?? C.timberDark;
  b.at(x, y, z, FACE_RY[face], () => {
    b.box(w + 0.1, h + 0.06, 0.05, 0, 0, 0.01, frame, { snow: false });
    b.box(w, h, 0.06, 0, 0, 0.02, o?.color ?? C.door, { snow: false });
    b.box(0.03, 0.03, 0.03, w * 0.3, h * 0.45, 0.06, C.iron, { snow: false });
    if (o?.arch) {
      b.cyl(w / 2 + 0.05, 0.05, 0, h, 0.01, frame, { rx: PI / 2, seg: 8, snow: false });
      b.cyl(w / 2, 0.06, 0, h, 0.02, o?.color ?? C.door, { rx: PI / 2, seg: 8, snow: false });
    }
    if (o?.step !== null && y > 0.02) b.box(w + 0.2, y, 0.24, 0, -y, 0.13, o?.step ?? C.stoneDark);
  });
}

// ---- chimneys -----------------------------------------------------------------------------------

/** Square chimney from y0 to y1 with a cap. Returns the smoke emission point (model space). */
export function chimney(b: ModelBuilder, x: number, z: number, y0: number, y1: number, s = 0.3, color: number = C.stone): THREE.Vector3 {
  b.box(s, y1 - y0, s, x, y0, z, color);
  b.box(s + 0.08, 0.07, s + 0.08, x, y1, z, C.stoneDark);
  b.box(s - 0.1, 0.02, s - 0.1, x, y1 + 0.07, z, C.coal, { snow: false });
  return b.point(x, y1 + 0.12, z);
}

// ---- props --------------------------------------------------------------------------------------

export function barrel(b: ModelBuilder, x: number, y: number, z: number, r = 0.13, h = 0.32, color: number = C.timber, axis: 'y' | 'x' | 'z' = 'y'): void {
  const rot: PartOpts = axis === 'y' ? {} : axis === 'z' ? { rx: PI / 2 } : { rz: -PI / 2 };
  b.cyl(r, h, x, y, z, color, { seg: 8, ...rot });
  for (const t of [0.18, 0.78]) {
    const d = h * t;
    const px = axis === 'x' ? x + d : x;
    const py = axis === 'y' ? y + d : y;
    const pz = axis === 'z' ? z + d : z;
    b.cyl(r * 1.06, 0.03, px, py, pz, C.ironDark, { seg: 8, noBottom: true, snow: false, ...rot });
  }
}

export function crate(b: ModelBuilder, x: number, y: number, z: number, s = 0.28, color: number = C.plank, ry = 0): void {
  b.box(s, s, s, x, y, z, color, { ry });
  b.box(s + 0.012, 0.04, s + 0.012, x, y + s * 0.45, z, C.timberDark, { ry, snow: false });
}

export function sack(b: ModelBuilder, x: number, y: number, z: number, color = 0xb49c72, s = 1): void {
  b.blob(0.14 * s, 0.16 * s, 0.12 * s, x, y + 0.14 * s, z, color, { ry: b.rand() * PI });
  b.cyl(0.04 * s, 0.06 * s, x, y + 0.27 * s, z, C.rope, { seg: 5 });
}

/** Stack of logs lying along local X (pyramid stacking). */
export function logPile(b: ModelBuilder, x: number, y: number, z: number, len = 1, rows = 3, r = 0.08, ry = 0): void {
  b.at(x, y, z, ry, () => {
    for (let row = 0; row < rows; row++) {
      const n = rows - row + 1;
      for (let i = 0; i < n; i++) {
        const zz = (i - (n - 1) / 2) * r * 2.05;
        const yy = r + row * r * 1.75;
        b.cyl(r, len, -len / 2 + b.range(-0.04, 0.04), yy, zz, C.log, { rz: -PI / 2, seg: 6, a0: 0.3 });
        b.cyl(r * 0.8, 0.012, len / 2 - 0.004, yy, zz, C.logEnd, { rz: -PI / 2, seg: 6, noBottom: true });
      }
    }
  });
}

/** Stacked firewood (round log ends facing local +Z, staggered rows) with an optional plank roof. */
export function woodStack(b: ModelBuilder, x: number, y: number, z: number, w = 0.8, h = 0.45, d = 0.3, ry = 0, roof = true): void {
  b.at(x, y, z, ry, () => {
    b.box(w - 0.04, h - 0.03, d - 0.05, 0, 0, 0, C.bark, { jitter: 0.02 });
    const r = 0.048;
    const rows = Math.max(2, Math.floor((h - 0.01) / (r * 1.75)));
    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? r : 0;
      const cols = Math.floor((w - off - 0.01) / (r * 2.02));
      for (let c = 0; c < cols; c++) {
        const cx = -w / 2 + r + off + c * r * 2.02 + 0.005;
        const cy = r + row * r * 1.75;
        b.cyl(r, 0.035, cx, cy, d / 2 - 0.045 + b.range(-0.012, 0.012), b.rand() < 0.25 ? C.log : C.logEnd, { rx: PI / 2, seg: 5, a0: b.rand() * 1.2, snow: false, noBottom: true, jitter: 0.1 });
      }
    }
    if (roof) b.boxc(w + 0.12, 0.04, d + 0.14, 0, h + 0.04, 0, C.plankGrey, { rx: -0.12 });
  });
}

export function stump(b: ModelBuilder, x: number, y: number, z: number, r = 0.14, h = 0.22, axe = false): void {
  b.cyl(r, h, x, y, z, C.log, { seg: 7 });
  b.cyl(r * 0.85, 0.01, x, y + h, z, C.logEnd, { seg: 7, noBottom: true });
  if (axe) {
    b.beam(x, y + h, z, x + 0.12, y + h + 0.3, z + 0.05, 0.03, C.timberLight);
    b.boxc(0.1, 0.06, 0.02, x + 0.02, y + h + 0.03, z, C.iron, { rz: 0.6 });
  }
}

export function bush(b: ModelBuilder, x: number, y: number, z: number, r = 0.2, color: number = C.leaf): void {
  b.blob(r, r * 0.8, r, x, y + r * 0.6, z, color, { ry: b.rand() * PI, jitter: 0.08 });
}

/** Small conifer (cone tiers) or round deciduous tree. */
export function smallTree(b: ModelBuilder, x: number, y: number, z: number, h = 1.2, kind: 'conifer' | 'round' = 'conifer', color?: number): void {
  b.cyl(0.05 * h, h * 0.35, x, y, z, C.bark, { seg: 5 });
  if (kind === 'conifer') {
    const c = color ?? C.conifer;
    b.cone(h * 0.3, h * 0.5, x, y + h * 0.25, z, c, { seg: 6 });
    b.cone(h * 0.22, h * 0.45, x, y + h * 0.5, z, c, { seg: 6, a0: 0.5 });
  } else {
    const c = color ?? C.leaf;
    b.blob(h * 0.3, h * 0.28, h * 0.3, x, y + h * 0.62, z, c, { ry: b.rand() * PI });
  }
}

/** Fence along a straight line: posts every ~spacing, `rails` horizontal rails. */
export function fence(b: ModelBuilder, x0: number, z0: number, x1: number, z1: number, o?: { h?: number; post?: number; spacing?: number; rails?: number; color?: number; rail?: number; skipFirst?: boolean }): void {
  const h = o?.h ?? 0.42;
  const post = o?.post ?? 0.06;
  const spacing = o?.spacing ?? 1;
  const rails = o?.rails ?? 2;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / spacing));
  const color = o?.color ?? C.timber;
  const railC = o?.rail ?? C.timberLight;
  for (let i = o?.skipFirst ? 1 : 0; i <= n; i++) {
    const t = i / n;
    b.box(post, h, post, x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t, color, { ry: b.range(-0.2, 0.2) });
  }
  for (let r = 0; r < rails; r++) {
    const y = h * (rails === 1 ? 0.7 : 0.35 + (0.55 * r) / (rails - 1));
    for (let i = 0; i < n; i++) {
      const ta = i / n;
      const tb = (i + 1) / n;
      b.beam(x0 + (x1 - x0) * ta, y, z0 + (z1 - z0) * ta, x0 + (x1 - x0) * tb, y + b.range(-0.015, 0.015), z0 + (z1 - z0) * tb, 0.035, railC);
    }
  }
}

/** Low dry-stone wall segment. */
export function stoneWall(b: ModelBuilder, x0: number, z0: number, x1: number, z1: number, h = 0.32, t = 0.2, color: number = C.stoneDark): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = Math.atan2(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 0.5));
  for (let i = 0; i < n; i++) {
    const ta = (i + 0.5) / n;
    const hh = h * b.range(0.9, 1.08);
    b.box(t, hh, len / n + 0.01, x0 + (x1 - x0) * ta, 0, z0 + (z1 - z0) * ta, color, { ry, jitter: 0.07 });
  }
  b.box(t + 0.05, 0.05, len + t, (x0 + x1) / 2, h, (z0 + z1) / 2, C.stone, { ry, jitter: 0.03 });
}

export function bench(b: ModelBuilder, x: number, y: number, z: number, ry = 0, len = 0.7): void {
  b.at(x, y, z, ry, () => {
    b.box(len, 0.04, 0.18, 0, 0.2, 0, C.plank);
    b.box(0.05, 0.2, 0.14, -len / 2 + 0.08, 0, 0, C.timberDark);
    b.box(0.05, 0.2, 0.14, len / 2 - 0.08, 0, 0, C.timberDark);
  });
}

export function table(b: ModelBuilder, x: number, y: number, z: number, w = 0.6, d = 0.4, h = 0.34, ry = 0, color: number = C.plank): void {
  b.at(x, y, z, ry, () => {
    b.box(w, 0.04, d, 0, h, 0, color);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.04, h, 0.04, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), C.timberDark);
  });
}

/** Hand cart with two wheels, oriented along local Z (handles toward +Z). */
export function cart(b: ModelBuilder, x: number, y: number, z: number, ry = 0, load: number | null = null): void {
  b.at(x, y, z, ry, () => {
    b.box(0.5, 0.2, 0.7, 0, 0.2, 0, C.plank);
    b.box(0.44, 0.02, 0.64, 0, 0.4, 0, C.timberDark);
    for (const sx of [-1, 1]) {
      b.cyl(0.17, 0.05, sx * 0.3, 0.17, 0, C.timberDark, { rz: PI / 2, seg: 8 });
      b.cyl(0.05, 0.06, sx * 0.3, 0.17, 0, C.iron, { rz: PI / 2, seg: 6 });
      b.beam(sx * 0.2, 0.3, 0.35, sx * 0.22, 0.22, 0.8, 0.035, C.timber);
    }
    if (load !== null) b.blob(0.22, 0.12, 0.3, 0, 0.4, 0, load, { jitter: 0.1 });
  });
}

/** Open rowing boat along local Z. y = waterline. */
export function rowboat(b: ModelBuilder, x: number, y: number, z: number, ry = 0, len = 1.3, color: number = C.plank): void {
  const w = len * 0.36;
  const h = 0.2;
  b.at(x, y - 0.08, z, ry, () => {
    const hl = len * 0.35;
    b.prism([[-w / 2, h], [w / 2, h], [w / 3, 0], [-w / 3, 0]], hl * 2, 0, 0, 0, color, { ry: PI / 2 });
    for (const s of [1, -1]) {
      b.convex(
        [[-w / 2, h, 0], [w / 2, h, 0], [w / 3, 0, 0], [-w / 3, 0, 0], [0, h + 0.05, s * len * 0.16], [0, 0.03, s * len * 0.1]],
        [[0, 1, 2, 3], [0, 1, 4], [3, 2, 5], [0, 3, 5, 4], [1, 2, 5, 4]],
        0, 0, s * hl, color,
      );
    }
    b.box(w - 0.08, 0.02, hl * 2 - 0.05, 0, h - 0.03, 0, C.timberDark, { snow: false });
    b.box(w - 0.04, 0.03, 0.1, 0, h - 0.02, hl * 0.3, C.plank);
    b.beam(-w / 2 + 0.04, h + 0.02, hl * 0.2, -w / 2 - 0.25, h - 0.05, hl * 0.6, 0.025, C.timberLight);
  });
}

export function ladder(b: ModelBuilder, x: number, y: number, z: number, h: number, ry = 0, lean = 0.2): void {
  b.at(x, y, z, ry, () => {
    for (const s of [-1, 1]) b.beam(s * 0.12, 0, 0, s * 0.12, h, -lean, 0.035, C.timberLight);
    const n = Math.floor(h / 0.2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      b.beam(-0.12, t * h, -lean * t, 0.12, t * h, -lean * t, 0.025, C.timberLight);
    }
  });
}

/** Hanging sign on a bracket sticking out of a wall (authored facing +Z). */
export function hangingSign(b: ModelBuilder, x: number, y: number, z: number, face: Face, board: number = C.plank, icon: number | null = null): void {
  b.at(x, y, z, FACE_RY[face], () => {
    b.box(0.04, 0.04, 0.45, 0, 0, 0.22, C.ironDark);
    b.beam(0, -0.15, 0.02, 0, 0, 0.2, 0.025, C.ironDark);
    b.box(0.03, 0.26, 0.3, 0, -0.3, 0.3, board, { snow: false });
    if (icon !== null) b.box(0.05, 0.13, 0.13, 0, -0.24, 0.3, icon, { snow: false });
  });
}

/** Flag pole with a rectangular flag (authored so the flag extends toward local +X). */
export function flagPole(b: ModelBuilder, x: number, y: number, z: number, h: number, color: number = C.flagRed, ry = 0, emblem: number | null = null): void {
  b.at(x, y, z, ry, () => {
    b.cyl(0.035, h, 0, 0, 0, C.timberLight, { seg: 6 });
    b.blob(0.05, 0.05, 0.05, 0, h + 0.03, 0, C.gold);
    b.box(0.6, 0.38, 0.02, 0.32, h - 0.45, 0, color, { snow: false, rz: -0.04 });
    if (emblem !== null) {
      b.box(0.08, 0.26, 0.03, 0.32, h - 0.39, 0, emblem, { snow: false });
      b.box(0.26, 0.08, 0.03, 0.32, h - 0.3, 0, emblem, { snow: false });
    }
  });
}

/** Stone well curb + roof + crank (used by the well and the market square). */
export function wellCore(b: ModelBuilder, x: number, z: number, scale = 1): void {
  const s = scale;
  b.cyl(0.5 * s, 0.46 * s, x, 0, z, C.stone, { seg: 10 });
  b.cyl(0.55 * s, 0.08 * s, x, 0.46 * s, z, C.stoneLight, { seg: 10 });
  b.cyl(0.4 * s, 0.012, x, 0.54 * s, z, C.waterDark, { seg: 10, snow: false, jitter: 0 });
  for (const sx of [-1, 1]) b.box(0.08 * s, 1.1 * s, 0.08 * s, x + sx * 0.46 * s, 0.4 * s, z, C.timberDark);
  b.beam(x - 0.5 * s, 1.25 * s, z, x + 0.5 * s, 1.25 * s, z, 0.05 * s, C.timber);
  b.beam(x + 0.5 * s, 1.25 * s, z, x + 0.62 * s, 1.15 * s, z + 0.12 * s, 0.03 * s, C.iron);
  b.cyl(0.02 * s, 0.35 * s, x, 0.9 * s, z, C.rope, { seg: 4 });
  b.cyl(0.08 * s, 0.14 * s, x, 0.78 * s, z, C.timber, { seg: 7, rTop: 0.1 * s });
  gableRoof(b, { x, z, len: 0.95 * s, depth: 0.7 * s, wallTop: 1.42 * s, ridge: 1.72 * s, axis: 'x', color: C.shingle, gable: C.plank, over: 0.14 * s, endOver: 0.12, thick: 0.06, ridgeCap: C.shingleDark });
}

/** Market stall: counter, 4 posts, sloped striped awning. Authored facing +Z (customer side). Returns goods slot points (model space). */
export function marketStall(b: ModelBuilder, x: number, z: number, ry: number, stripeA: number, stripeB: number = C.cloth, w = 1.3): THREE.Vector3[] {
  const slots: THREE.Vector3[] = [];
  b.at(x, 0, z, ry, () => {
    const d = 0.7;
    b.box(w, 0.42, 0.34, 0, 0, d / 2 - 0.17, C.plank);
    b.box(w + 0.06, 0.04, 0.4, 0, 0.42, d / 2 - 0.17, C.timberLight);
    for (const sx of [-1, 1]) {
      b.box(0.06, 1.0, 0.06, sx * (w / 2 - 0.03), 0, d / 2 - 0.03, C.timberDark);
      b.box(0.06, 1.25, 0.06, sx * (w / 2 - 0.03), 0, -d / 2 + 0.03, C.timberDark);
    }
    // striped awning sloping down toward +Z
    const stripes = 6;
    const sw = (w + 0.2) / stripes;
    const rx = Math.atan2(0.3, d + 0.2);
    for (let i = 0; i < stripes; i++) {
      b.boxc(sw + 0.002, 0.03, d + 0.35, -(w + 0.2) / 2 + sw * (i + 0.5), 1.13, 0.02, i % 2 === 0 ? stripeA : stripeB, { rx, jitter: 0.02 });
    }
    // scalloped valance
    for (let i = 0; i < stripes; i++) {
      b.box(sw * 0.9, 0.1, 0.02, -(w + 0.2) / 2 + sw * (i + 0.5), 0.88, d / 2 + 0.2, i % 2 === 0 ? stripeA : stripeB, { snow: false });
    }
    // back crates
    crate(b, -w / 2 + 0.25, 0, -d / 2 + 0.1, 0.22, C.plank, 0.2);
    // goods are displayed on the ground in front of the counter (visible from the usual top-down camera)
    for (let i = 0; i < 3; i++) slots.push(b.point(-w / 2 + (i + 0.5) * (w / 3), 0, d / 2 + 0.3));
  });
  return slots;
}
