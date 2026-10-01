/** Storage barn (gambrel roof, big double doors). The stockpile zone lives in zones.ts. */
import { C } from '../palette';
import { barrel, crate, plinth, profileRoof, sack, windowAt } from '../parts';
import { bodyC, type ModelFn } from '../spec';

const PI = Math.PI;

export const storageBarn: ModelFn = (b, { variant }) => {
  const ph = 0.1;
  const bz = -0.15;
  const sx = 3.1;
  const lenZ = 4.0;
  const wallTop = 1.45;
  const front = bz + lenZ / 2;
  const back = bz - lenZ / 2;
  plinth(b, sx + 0.1, lenZ + 0.1, ph, 0, bz, C.stoneDark);
  const wall = [C.barnRed, C.plank, C.barnRed][variant];
  const roofC = [C.shingle, C.thatch, C.shingleGrey][variant];
  b.box(sx, wallTop - ph, lenZ, 0, ph, bz, wall);
  // board battens on the long sides and corner posts
  for (let z = back + 0.22; z < front - 0.1; z += 0.32) {
    b.box(0.03, wallTop - ph - 0.04, 0.05, sx / 2 + 0.012, ph, z, C.timberDark, { snow: false });
    b.box(0.03, wallTop - ph - 0.04, 0.05, -sx / 2 - 0.012, ph, z, C.timberDark, { snow: false });
  }
  for (const ex of [-1, 1]) {
    for (const ez of [-1, 1]) b.box(0.12, wallTop - ph, 0.12, ex * (sx / 2 - 0.04), ph, bz + ez * (lenZ / 2 - 0.04), C.timberDark);
  }
  b.box(sx + 0.04, 0.08, lenZ + 0.04, 0, wallTop - 0.1, bz, C.timberDark, { snow: false });

  // gambrel roof (ridge along Z)
  const hw = sx / 2;
  const o = 0.2;
  const k = 0.62;
  const pts: [number, number][] = [
    [-hw - o, wallTop - 0.25], [-hw * k, wallTop + 0.72], [0, wallTop + 1.3], [hw * k, wallTop + 0.72], [hw + o, wallTop - 0.25],
  ];
  // attic gable fill (inset below the slab undersides)
  b.at(0, 0, bz, PI / 2, () => {
    b.prism([[-hw, wallTop - 0.01], [-hw * k, wallTop + 0.72 - 0.2], [0, wallTop + 1.3 - 0.15], [hw * k, wallTop + 0.72 - 0.2], [hw, wallTop - 0.01]], lenZ - 0.02, 0, 0, 0, wall);
  });
  profileRoof(b, pts, lenZ, { z: bz, axis: 'z', thick: 0.12, color: roofC, endOver: 0.16 });
  b.boxc(0.16, 0.08, lenZ + 0.34, 0, wallTop + 1.31, bz, C.shingleDark, { jitter: 0.02 });

  // big double doors on the front gable
  b.at(0, ph, front, 0, () => {
    b.box(1.5, 1.28, 0.05, 0, 0, 0.01, C.timberDark, { snow: false });
    for (const s of [-1, 1]) {
      const cx = s * 0.34;
      b.box(0.64, 1.18, 0.06, cx, 0, 0.03, C.plank, { snow: false });
      b.beam(cx - 0.28, 0.05, 0.07, cx + 0.28, 1.12, 0.07, 0.05, C.timberDark, { snow: false, t2: 0.02 });
      b.beam(cx + 0.28, 0.05, 0.07, cx - 0.28, 1.12, 0.07, 0.05, C.timberDark, { snow: false, t2: 0.02 });
      b.box(0.62, 0.05, 0.02, cx, 0.02, 0.07, C.timberDark, { snow: false });
      b.box(0.62, 0.05, 0.02, cx, 1.1, 0.07, C.timberDark, { snow: false });
    }
    // hay-loft door + hoist beam
    b.box(0.55, 0.5, 0.05, 0, 1.52, 0.01, C.timberDark, { snow: false });
    b.box(0.46, 0.42, 0.06, 0, 1.56, 0.02, C.plank, { snow: false });
    b.box(0.08, 0.08, 0.55, 0, 2.28, 0.2, C.timberDark);
    b.cyl(0.012, 0.5, 0, 1.8, 0.44, C.rope, { seg: 4 });
    b.box(0.08, 0.1, 0.06, 0, 1.72, 0.44, C.ironDark);
    // lantern
    b.box(0.08, 0.12, 0.08, 0.9, 1.05, 0.06, C.window, { glow: 1, snow: false });
  });
  // vents on the sides
  windowAt(b, sx / 2, 0.85, bz - 0.8, 'px', { w: 0.3, h: 0.18 });
  windowAt(b, -sx / 2, 0.85, bz + 0.6, 'nx', { w: 0.3, h: 0.18 });

  // goods outside
  crate(b, 1.2, 0, front + 0.26, 0.26, C.plank, 0.2);
  crate(b, 1.25, 0.26, front + 0.24, 0.2, C.plankGrey, 0.5);
  barrel(b, -1.25, 0, front + 0.26, 0.13, 0.32);
  sack(b, -0.95, 0, front + 0.3);
  if (variant !== 1) sack(b, 0.95, 0, front + 0.34, 0xc9b27a, 0.9);
  return { chimneys: [], body: bodyC(0, bz, sx, lenZ, wallTop) };
};
