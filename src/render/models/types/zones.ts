/**
 * Zone models (resizable, walkable): stockpile, crop field, orchard, pasture, cemetery.
 * Geometry is laid out per tile so the BuildingRenderer can conform it to the terrain vertex by vertex.
 * Crops, orchard trees, livestock and piles are drawn elsewhere; graves by BuildingRenderer (graves count).
 */
import * as THREE from 'three';
import type { ModelBuilder } from '../builder';
import { C } from '../palette';
import { bush, fence, profileRoof, smallTree, stoneWall } from '../parts';
import { body, type ModelFn } from '../spec';

const PI = Math.PI;

/** Gate gap along the +Z edge: [x0, x1] in model space (2 tiles wide for even widths so every rotation fits). */
export function gateSpan(w: number): [number, number] {
  return w % 2 === 0 ? [-1, 1] : [-0.5, 0.5];
}

/** Perimeter walk: calls fn for each edge segment of 1 tile (or less), skipping the gate span on the +Z edge. */
function perimeterSegments(w: number, h: number, inset: number, gate: [number, number] | null, fn: (x0: number, z0: number, x1: number, z1: number) => void): void {
  const hx = w / 2 - inset;
  const hz = h / 2 - inset;
  // back edge (-Z) and side edges: per tile
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len));
    for (let i = 0; i < n; i++) {
      fn(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, ax + ((bx - ax) * (i + 1)) / n, az + ((bz - az) * (i + 1)) / n);
    }
  };
  edge(-hx, -hz, hx, -hz);
  edge(hx, -hz, hx, hz);
  edge(-hx, hz, -hx, -hz);
  if (gate) {
    edge(hx, hz, gate[1], hz);
    edge(gate[0], hz, -hx, hz);
  } else {
    edge(hx, hz, -hx, hz);
  }
}

export const stockpile: ModelFn = (b, { w, h }) => {
  // low log edging per tile + corner stakes
  const inset = 0.06;
  perimeterSegments(w, h, inset, null, (x0, z0, x1, z1) => {
    b.beam(x0, 0.04, z0, x1, 0.04, z1, 0.07, C.log, { jitter: 0.08 });
  });
  const hx = w / 2 - inset;
  const hz = h / 2 - inset;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(0.09, 0.34, 0.09, sx * hx, 0, sz * hz, C.timber);
      b.box(0.12, 0.05, 0.12, sx * hx, 0.34, sz * hz, C.timberDark);
    }
  }
  return { chimneys: [], body: body(-w / 2, w / 2, -h / 2, h / 2, 0.3) };
};

export const cropField: ModelFn = (b, { w, h }) => {
  // edge posts with twine; crops drawn by CropRenderer
  const inset = 0.04;
  const hx = w / 2 - inset;
  const hz = h / 2 - inset;
  const posts: [number, number][] = [];
  const addEdge = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 2));
    for (let i = 0; i < n; i++) posts.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  };
  addEdge(-hx, -hz, hx, -hz);
  addEdge(hx, -hz, hx, hz);
  addEdge(hx, hz, -hx, hz);
  addEdge(-hx, hz, -hx, -hz);
  for (const [x, z] of posts) b.box(0.06, 0.34, 0.06, x, 0, z, C.timber, { ry: b.range(-0.3, 0.3) });
  perimeterSegments(w, h, inset, null, (x0, z0, x1, z1) => {
    b.beam(x0, 0.26, z0, x1, 0.26, z1, 0.014, C.rope, { snow: false });
  });
  // a scarecrow-ish marker post with a straw bundle at the back-left corner
  b.box(0.05, 0.75, 0.05, -hx + 0.14, 0, -hz + 0.14, C.timber);
  b.blob(0.1, 0.14, 0.1, -hx + 0.14, 0.72, -hz + 0.14, C.hay);
  return { chimneys: [], body: body(-w / 2, w / 2, -h / 2, h / 2, 0.3) };
};

export const orchard: ModelFn = (b, { w, h }) => {
  const inset = 0.06;
  const gate = gateSpan(w);
  perimeterSegments(w, h, inset, gate, (x0, z0, x1, z1) => {
    fence(b, x0, z0, x1, z1, { h: 0.3, rails: 1, spacing: 1, color: C.timber, rail: C.timberLight, skipFirst: false });
  });
  const hz = h / 2 - inset;
  for (const gx of gate) b.box(0.09, 0.46, 0.09, gx, 0, hz, C.timberDark);
  // ladder & baskets near the gate
  b.box(0.3, 0.02, 0.1, gate[1] + 0.35, 0.02, hz - 0.3, C.timberLight, { ry: 0.3 });
  b.cyl(0.11, 0.14, gate[0] - 0.35, 0, hz - 0.28, C.plank, { seg: 7, rTop: 0.13 });
  return { chimneys: [], body: body(-w / 2, w / 2, -h / 2, h / 2, 0.3) };
};

export const pasture: ModelFn = (b, { w, h }) => {
  const inset = 0.06;
  const gate = gateSpan(w);
  perimeterSegments(w, h, inset, gate, (x0, z0, x1, z1) => {
    fence(b, x0, z0, x1, z1, { h: 0.5, rails: 2, spacing: 1, color: C.timberDark, rail: C.timber });
  });
  const hx = w / 2 - inset;
  const hz = h / 2 - inset;
  for (const gx of gate) b.box(0.1, 0.62, 0.1, gx, 0, hz, C.timberDark);
  // open gate leaf swung inward
  const gl = (gate[1] - gate[0]) / 2 - 0.05;
  b.at(gate[0] + 0.05, 0, hz, 1.2, () => {
    b.box(0.05, 0.5, 0.05, gl, 0, 0, C.timber);
    b.beam(0, 0.15, 0, gl, 0.15, 0, 0.035, C.timberLight);
    b.beam(0, 0.4, 0, gl, 0.4, 0, 0.035, C.timberLight);
    b.beam(0, 0.15, 0, gl, 0.4, 0, 0.03, C.timberLight);
  });
  // lean-to shelter with hay in the back-left corner
  b.at(-hx + 0.75, 0, -hz + 0.6, 0, () => {
    for (const sx of [-1, 1]) {
      b.box(0.07, 0.95, 0.07, sx * 0.6, 0, -0.4, C.timberDark);
      b.box(0.07, 0.65, 0.07, sx * 0.6, 0, 0.35, C.timberDark);
    }
    profileRoof(b, [[0.52, 0.66], [-0.5, 0.98]], 1.25, { color: C.thatch, thick: 0.08, endOver: 0.04 });
    b.box(1.1, 0.05, 0.06, 0, 0.9, -0.42, C.plank);
    b.blob(0.42, 0.22, 0.25, 0, 0.14, -0.15, C.hay, { jitter: 0.06 });
  });
  // water trough on the right side
  b.at(hx - 0.35, 0, 0, PI / 2, () => {
    b.box(0.8, 0.22, 0.26, 0, 0, 0, C.plank);
    b.box(0.72, 0.01, 0.18, 0, 0.2, 0, C.water, { snow: false });
  });
  return { chimneys: [], body: body(-w / 2, w / 2, -h / 2, h / 2, 0.6) };
};

export const cemetery: ModelFn = (b, { w, h }) => {
  const inset = 0.12;
  const gate = gateSpan(w);
  const narrowGate: [number, number] = [gate[0] + (w % 2 === 0 ? 0.45 : 0.05), gate[1] - (w % 2 === 0 ? 0.45 : 0.05)];
  perimeterSegments(w, h, inset, narrowGate, (x0, z0, x1, z1) => {
    stoneWall(b, x0, z0, x1, z1, 0.3, 0.18, C.stoneDark);
  });
  const hx = w / 2 - inset;
  const hz = h / 2 - inset;
  for (const gx of narrowGate) {
    b.box(0.24, 0.55, 0.24, gx, 0, hz, C.stone);
    b.pyramid(0.14, 0.14, 0.14, gx, 0.55, hz, C.stoneLight);
  }
  // wrought iron arch over the gate
  b.beam(narrowGate[0], 0.55, hz, (narrowGate[0] + narrowGate[1]) / 2, 0.78, hz, 0.025, C.ironDark);
  b.beam((narrowGate[0] + narrowGate[1]) / 2, 0.78, hz, narrowGate[1], 0.55, hz, 0.025, C.ironDark);
  if (w >= 5 && h >= 5) {
    smallTree(b, -hx + 0.32, 0, -hz + 0.32, 1.5, 'conifer', C.leafDark);
    bush(b, hx - 0.3, 0, -hz + 0.3, 0.2, C.leafDark);
  }
  return { chimneys: [], body: body(-w / 2, w / 2, -h / 2, h / 2, 0.35) };
};

/** Grave slot positions (model space, head toward -Z) for a cemetery of size w × h, at least `capacity` if possible. */
export function cemeterySlots(w: number, h: number, capacity: number): THREE.Vector3[] {
  const x0 = -w / 2 + 0.5;
  const x1 = w / 2 - 0.5;
  const z0 = -h / 2 + 0.5;
  const z1 = h / 2 - 0.85;
  const iw = Math.max(0, x1 - x0);
  const id = Math.max(0, z1 - z0);
  let sx = 0.8;
  let sz = 1.15;
  let cols = 1;
  let rows = 1;
  for (let it = 0; it < 20; it++) {
    cols = Math.floor(iw / sx + 1e-6) + 1;
    rows = Math.floor(id / sz + 1e-6) + 1;
    if (cols * rows >= capacity) break;
    if (sx > 0.52) sx *= 0.94;
    if (sz > 0.78) sz *= 0.94;
  }
  const out: THREE.Vector3[] = [];
  const offX = (iw - (cols - 1) * sx) / 2;
  const offZ = (id - (rows - 1) * sz) / 2;
  const skipTreeCorners = w >= 5 && h >= 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + offX + c * sx;
      const z = z0 + offZ + r * sz;
      if (skipTreeCorners && r === 0 && (c === 0 || c === cols - 1) && cols * rows - 2 >= capacity) continue;
      out.push(new THREE.Vector3(x, 0, z));
    }
  }
  return out;
}

/** Emit grave mounds + headstones for the first `count` slots (model space). */
export function emitGraves(b: ModelBuilder, slots: THREE.Vector3[], count: number): void {
  const n = Math.min(count, slots.length);
  for (let i = 0; i < n; i++) {
    const s = slots[i];
    const kind = Math.floor(b.rand() * 4);
    b.box(0.28, 0.07, 0.5, s.x, 0, s.z + 0.08, C.soilDark, { jitter: 0.06 });
    const hz = s.z - 0.2;
    const stone = b.pick([C.stone, C.stoneLight, C.stoneDark]);
    const tilt = b.range(-0.08, 0.08);
    if (kind === 0) {
      b.at(s.x, 0, hz, 0, () => b.box(0.06, 0.4, 0.05, 0, 0, 0, stone, { rz: tilt }));
      b.box(0.24, 0.06, 0.05, s.x, 0.25, hz, stone, { rz: tilt });
    } else {
      b.box(0.24, 0.26, 0.06, s.x, 0, hz, stone, { rz: tilt });
      if (kind !== 3) b.cyl(0.12, 0.06, s.x, 0.26, hz - 0.03, stone, { rx: PI / 2, seg: 8 });
    }
    if (b.rand() < 0.3) b.blob(0.04, 0.03, 0.04, s.x + 0.08, 0.07, s.z + 0.1, b.pick([C.flowerWhite, C.flowerYellow, C.red]));
  }
}

