/**
 * Cross-engine deterministic math for the simulation step (lockstep co-op determinism fix).
 *
 * ECMAScript leaves Math.hypot / sin / cos / atan2 / exp / pow "implementation-approximated": V8, SpiderMonkey and
 * JavaScriptCore use different algorithms and can disagree in the last bit, which would slowly pull apart peers that
 * play the same town in different browsers. These replacements use only +, -, *, / and Math.sqrt / floor / round /
 * abs (exactly specified or correctly rounded everywhere; JS never fuses multiply-adds), so identical inputs give
 * identical bits in every engine. Accuracy is within ~1e-15 of the true value — visually and behaviourally the same.
 *
 * World generation (run once, on the host only) may keep using Math.*: guests receive the generated world in the
 * snapshot. Everything reachable from Game.step should use these.
 */

const PI = Math.PI;
const HALF_PI = PI / 2;
const TWO_PI = 2 * PI;

/** sqrt(x² + y²) — Math.hypot without the engine-specific scaling algorithm. */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** x² (instead of `x ** 2`, whose Math.pow semantics are implementation-approximated). */
export function sq(x: number): number {
  return x * x;
}

/** Reduce to [-π, π]. */
function reducePi(x: number): number {
  if (x >= -PI && x <= PI) return x;
  return x - Math.round(x / TWO_PI) * TWO_PI;
}

// Taylor coefficients 1/n! (exact enough in double; deterministic constants)
const S3 = -1 / 6;
const S5 = 1 / 120;
const S7 = -1 / 5040;
const S9 = 1 / 362880;
const S11 = -1 / 39916800;
const S13 = 1 / 6227020800;
const S15 = -1 / 1307674368000;
const S17 = 1 / 355687428096000;
const S19 = -1 / 121645100408832000;
const S21 = 1 / 51090942171709440000;

const C2 = -1 / 2;
const C4 = 1 / 24;
const C6 = -1 / 720;
const C8 = 1 / 40320;
const C10 = -1 / 3628800;
const C12 = 1 / 479001600;
const C14 = -1 / 87178291200;
const C16 = 1 / 20922789888000;
const C18 = -1 / 6402373705728000;
const C20 = 1 / 2432902008176640000;
const C22 = -1 / 1124000727777607680000;

/** sin on [-π/2, π/2]. */
function sinCore(r: number): number {
  const r2 = r * r;
  return r * (1 + r2 * (S3 + r2 * (S5 + r2 * (S7 + r2 * (S9 + r2 * (S11 + r2 * (S13 + r2 * (S15 + r2 * (S17 + r2 * (S19 + r2 * S21))))))))));
}

/** cos on [-π/2, π/2]. */
function cosCore(r: number): number {
  const r2 = r * r;
  return 1 + r2 * (C2 + r2 * (C4 + r2 * (C6 + r2 * (C8 + r2 * (C10 + r2 * (C12 + r2 * (C14 + r2 * (C16 + r2 * (C18 + r2 * (C20 + r2 * C22))))))))));
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  let r = reducePi(x);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  return sinCore(r);
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const r = Math.abs(reducePi(x));
  return r > HALF_PI ? -cosCore(PI - r) : cosCore(r);
}

/** atan on [-1, 1] via two argument halvings (|t| ≤ tan(π/16)) and an odd Taylor series. */
function atanUnit(t: number): number {
  let u = t / (1 + Math.sqrt(1 + t * t));
  u = u / (1 + Math.sqrt(1 + u * u));
  const u2 = u * u;
  let s = 0;
  for (let k = 23; k >= 3; k -= 2) s = u2 * ((k % 4 === 1 ? 1 : -1) / k + s);
  // s = -u²/3 + u⁴/5 - ... ; atan(u) = u (1 + s)
  return 4 * (u * (1 + s));
}

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax === 0 && ay === 0) return x < 0 || Object.is(x, -0) ? (Object.is(y, -0) || y < 0 ? -PI : PI) : y;
  let a: number;
  if (ax === Infinity || ay === Infinity) {
    a = ax === Infinity && ay === Infinity ? PI / 4 : ax === Infinity ? 0 : HALF_PI;
  } else {
    a = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  }
  if (x < 0 || Object.is(x, -0)) a = PI - a;
  return y < 0 || Object.is(y, -0) ? -a : a;
}

const LN2_HI = 0.6931471803691238; // high bits of ln 2 (exact product with small integers)
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;
const E1 = 1;
const E2 = 1 / 2;
const E3 = 1 / 6;
const E4 = 1 / 24;
const E5 = 1 / 120;
const E6 = 1 / 720;
const E7 = 1 / 5040;
const E8 = 1 / 40320;
const E9 = 1 / 362880;
const E10 = 1 / 3628800;
const E11 = 1 / 39916800;
const E12 = 1 / 479001600;
const E13 = 1 / 6227020800;

const pow2Buf = new Float64Array(1);
const pow2Bits = new Uint32Array(pow2Buf.buffer);
/** Little-endian index of the high word (all browsers today are little-endian; check anyway). */
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;

/** Exactly 2^k for integer k in the normal range [-1022, 1023]. */
function pow2(k: number): number {
  pow2Bits[HI] = (k + 1023) << 20;
  pow2Bits[1 - HI] = 0;
  return pow2Buf[0];
}

export function exp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 709.78) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;
  const p = 1 + r * (E1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * (E6 + r * (E7 + r * (E8 + r * (E9 + r * (E10 + r * (E11 + r * (E12 + r * E13))))))))))));
  // scale in two exact steps so k near the ends of the range stays representable
  const k1 = k >> 1;
  return p * pow2(k1) * pow2(k - k1);
}
