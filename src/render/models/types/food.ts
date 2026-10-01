/** Food production models: gatherer's hut, hunting cabin, fishing dock. (Fields/orchards/pastures: zones.ts.) */
import type { ModelBuilder } from '../builder';
import { C } from '../palette';
import {
  barrel, chimney, crate, doorAt, gableHouse, logLines, plinth, roofYAt, rowboat, stump, windowAt,
} from '../parts';
import { bodyC, type ModelFn } from '../spec';

const PI = Math.PI;

function basket(b: ModelBuilder, x: number, y: number, z: number, content: number, r = 0.12): void {
  b.cyl(r * 0.8, r * 0.9, x, y, z, C.plank, { seg: 7, rTop: r });
  b.blob(r * 0.85, r * 0.45, r * 0.85, x, y + r * 0.9, z, content, { jitter: 0.08 });
}

export const gathererHut: ModelFn = (b, { variant }) => {
  const ph = 0.08;
  const cz = -0.2;
  const r = 0.95;
  b.cyl(r + 0.08, ph + 1.6, 0, -1.6, cz, C.stoneDark, { seg: 10, noBottom: true });
  b.cyl(r, 0.95 - ph, 0, ph, cz, C.plasterWarm, { seg: 10 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * PI * 2 + PI / 10;
    b.box(0.07, 0.9 - ph, 0.07, Math.cos(a) * (r - 0.01), ph, cz + Math.sin(a) * (r - 0.01), C.timberDark, { ry: -a });
  }
  b.cone(r + 0.38, 1.35, 0, 0.82, cz, variant === 1 ? C.thatchLight : C.thatch, { seg: 10 });
  b.cyl(0.14, 0.18, 0, 2.08, cz, C.thatchDark, { seg: 6, rTop: 0.04 });
  b.cyl(r + 0.4, 0.08, 0, 0.8, cz, C.thatchDark, { seg: 10, rTop: r + 0.38 });
  doorAt(b, 0, ph, cz + r - 0.03, 'pz', { w: 0.4, h: 0.68, step: null });
  windowAt(b, r - 0.03, 0.45, cz, 'px', { w: 0.22, h: 0.22 });
  windowAt(b, -r + 0.03, 0.45, cz, 'nx', { w: 0.22, h: 0.22 });
  // drying rack with hanging bundles
  b.at(1.0, 0, 0.95, -0.4, () => {
    b.box(0.05, 0.62, 0.05, -0.34, 0, 0, C.timber);
    b.box(0.05, 0.62, 0.05, 0.34, 0, 0, C.timber);
    b.beam(-0.38, 0.6, 0, 0.38, 0.6, 0, 0.035, C.timberLight);
    for (let i = 0; i < 4; i++) {
      const x = -0.22 + i * 0.15;
      b.cyl(0.008, 0.1, x, 0.5, 0, C.rope, { seg: 3 });
      b.blob(0.045, 0.07, 0.045, x, 0.45, 0, i % 2 ? C.berry : C.leafDark);
    }
  });
  basket(b, -0.95, 0, 0.9, C.berry);
  basket(b, -0.7, 0, 1.15, C.mushroom, 0.1);
  basket(b, -1.15, 0, 1.2, 0x9c6b3e, 0.1);
  if (variant === 2) basket(b, 0.5, 0, 1.15, C.berry, 0.1);
  return { chimneys: [], body: bodyC(0, cz, r * 2, r * 2, 0.95) };
};

export const hunterCabin: ModelFn = (b, { variant }) => {
  const ph = 0.1;
  const bz = -0.25;
  const len = 2.1;
  const depth = 1.7;
  const wallTop = 1.0;
  const ridge = 1.9;
  const front = bz + depth / 2;
  plinth(b, len + 0.12, depth + 0.12, ph, 0, bz, C.stoneDark);
  gableHouse(b, {
    z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: C.timber, roof: variant === 1 ? C.shingleDark : C.shingle,
    gable: C.bark, corners: C.bark, thick: 0.12, over: 0.22, endOver: 0.16, ridgeCap: C.bark,
  });
  logLines(b, 0, front, 'pz', len - 0.14, ph, wallTop, C.bark, 0.16);
  logLines(b, 0, bz - depth / 2, 'nz', len - 0.14, ph, wallTop, C.bark, 0.16);
  logLines(b, len / 2, bz, 'px', depth - 0.14, ph, wallTop, C.bark, 0.16);
  logLines(b, -len / 2, bz, 'nx', depth - 0.14, ph, wallTop, C.bark, 0.16);
  doorAt(b, -0.35, ph, front, 'pz', { h: 0.66 });
  windowAt(b, 0.45, 0.45, front, 'pz', { w: 0.22, h: 0.24 });
  windowAt(b, -len / 2, 0.45, bz, 'nx', { w: 0.22, h: 0.24 });
  // antlers over the door
  const antler = 0xd8ccb0;
  b.at(len / 2 + 0.02, 1.22, bz, PI / 2, () => {
    b.box(0.12, 0.08, 0.04, 0, 0, 0, C.timber);
    for (const s of [-1, 1]) {
      b.beam(s * 0.04, 0.05, 0.02, s * 0.22, 0.2, 0.04, 0.025, antler, { snow: false });
      b.beam(s * 0.13, 0.12, 0.03, s * 0.12, 0.26, 0.05, 0.02, antler, { snow: false });
      b.beam(s * 0.2, 0.18, 0.04, s * 0.3, 0.28, 0.04, 0.02, antler, { snow: false });
    }
  });
  // hide stretching frame
  b.at(1.02, 0, 1.08, -0.25, () => {
    b.box(0.05, 0.85, 0.05, -0.36, 0, 0, C.timber);
    b.box(0.05, 0.85, 0.05, 0.36, 0, 0, C.timber);
    b.beam(-0.38, 0.8, 0, 0.38, 0.8, 0, 0.04, C.timber);
    b.beam(-0.38, 0.12, 0, 0.38, 0.12, 0, 0.04, C.timber);
    b.box(0.52, 0.52, 0.02, 0, 0.2, 0, C.hide, { snow: false });
  });
  // meat drying rack at the side
  b.at(-1.25, 0, 0.75, PI / 2, () => {
    b.box(0.05, 0.7, 0.05, -0.3, 0, 0, C.timber);
    b.box(0.05, 0.7, 0.05, 0.3, 0, 0, C.timber);
    b.beam(-0.32, 0.68, 0, 0.32, 0.68, 0, 0.035, C.timberLight);
    for (let i = 0; i < 3; i++) b.blob(0.05, 0.1, 0.03, -0.15 + i * 0.15, 0.53, 0, 0x9b3b32);
  });
  stump(b, 0.3, 0, front + 0.4, 0.13, 0.2, true);
  const top = chimney(b, 0.72, bz - 0.4, ph, Math.max(2.05, roofYAt(wallTop, ridge, depth, 0.4) + 0.5), 0.26, C.stoneDark);
  return { chimneys: [top], body: bodyC(0, bz, len, depth, wallTop) };
};

/**
 * Fishing dock: small hut on the land side (+Z), wooden pier reaching over the water toward -Z,
 * rowboat, drying rack for fish.
 */
export const fishingDock: ModelFn = (b, { variant }) => {
  const ph = 0.1;
  // hut
  const hx = -0.55;
  const hz = 1.05;
  const len = 1.5;
  const depth = 1.25;
  plinth(b, len + 0.1, depth + 0.1, ph, hx, hz, C.stoneDark);
  gableHouse(b, {
    x: hx, z: hz, len, depth, y0: ph, wallTop: 0.95, ridge: 1.65, axis: 'x', wall: C.plankGrey,
    roof: variant === 1 ? C.shingleGrey : C.thatch, gable: C.plankGrey, corners: C.timberDark, thick: 0.12, over: 0.18, endOver: 0.14,
    ridgeCap: C.thatchDark,
  });
  doorAt(b, hx + 0.25, ph, hz + depth / 2, 'pz', { h: 0.66, color: C.doorBlue });
  windowAt(b, hx - 0.35, 0.45, hz + depth / 2, 'pz', { w: 0.2, h: 0.22 });
  windowAt(b, hx - len / 2, 0.45, hz, 'nx', { w: 0.2, h: 0.22 });
  // pier deck (toward -Z over the water)
  const px = 0.55;
  const pw = 0.9;
  const z0 = 0.75;
  const z1 = -1.92;
  const deckY = 0.14;
  const planks = Math.round((z0 - z1) / 0.16);
  for (let i = 0; i < planks; i++) {
    const z = z0 - (i + 0.5) * ((z0 - z1) / planks);
    b.boxc(pw + b.range(-0.04, 0.04), 0.05, (z0 - z1) / planks - 0.02, px, deckY - 0.025, z, i % 3 === 0 ? C.plankGrey : C.plank, { jitter: 0.06 });
  }
  for (const sx of [-1, 1]) {
    b.box(0.05, 0.08, z0 - z1, px + sx * (pw / 2 - 0.06), deckY - 0.13, (z0 + z1) / 2, C.timberDark, { snow: false });
    for (let z = z1 + 0.08; z <= z0; z += 0.85) {
      b.cyl(0.06, 2.6, px + sx * (pw / 2 - 0.02), -2.4, z, C.timberDark, { seg: 6 });
    }
  }
  b.cyl(0.07, 0.3, px - pw / 2 + 0.08, deckY, z1 + 0.1, C.timberDark, { seg: 6 });
  b.cyl(0.07, 0.3, px + pw / 2 - 0.08, deckY, z1 + 0.1, C.timberDark, { seg: 6 });
  // rowboat moored beside the pier
  rowboat(b, 1.2, -0.12, -1.05, 0.08, 1.25, variant === 2 ? C.doorBlue : C.plank);
  b.beam(1.2, 0.05, -0.6, px + pw / 2, deckY + 0.05, -0.55, 0.015, C.rope, { snow: false });
  // fish drying rack on land
  b.at(0.85, 0, 1.25, PI / 2, () => {
    for (const s of [-1, 1]) {
      b.beam(s * 0.4, 0, -0.2, s * 0.4, 0.75, 0, 0.04, C.timber);
      b.beam(s * 0.4, 0, 0.2, s * 0.4, 0.75, 0, 0.04, C.timber);
    }
    b.beam(-0.44, 0.74, 0, 0.44, 0.74, 0, 0.035, C.timberLight);
    for (let i = 0; i < 5; i++) b.blob(0.035, 0.1, 0.02, -0.3 + i * 0.15, 0.6, 0, 0x8fa6b8, { snow: false });
  });
  // nets & barrels
  b.box(0.5, 0.03, 0.4, px, deckY, 0.45, 0x5d5a4a, { rx: 0.05, jitter: 0.08 });
  barrel(b, px + 0.25, deckY, -0.4, 0.11, 0.26);
  crate(b, 0.1, 0, 0.25, 0.22, C.plankGrey, 0.3);
  barrel(b, -1.25, 0, 0.25, 0.11, 0.28);
  return { chimneys: [], body: bodyC(hx, hz, len, depth, 0.95) };
};
