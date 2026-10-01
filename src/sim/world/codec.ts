/**
 * Binary codecs for compact save games. OWNER: sim-world agent. Pure functions, no DOM / Node APIs.
 *
 * - `packBits` / `unpackBits`: byte-level run-length encoding (PackBits variant).
 *     control byte c < 128  → c + 1 literal bytes follow (1..128)
 *     control byte c >= 128 → the next byte repeats (c - 128 + 3) times (3..130)
 * - `shuffleBytes` / `unshuffleBytes`: split an array of fixed-size elements into byte planes (all byte 0s, then all
 *   byte 1s, ...). Makes typed float/int arrays with repetitive high bytes very RLE friendly.
 * - `encodeZigzagVarints` / `decodeZigzagVarints`: signed LEB128 (zigzag) integer streams.
 * - `toBase64` / `fromBase64`: standard base64 (RFC 4648, with padding), table driven, works in browser & Node.
 */

const MAX_LITERAL = 128;
const MIN_RUN = 3;
const MAX_RUN = 130;

export function packBits(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / MAX_LITERAL) + 16);
  let o = 0;
  let i = 0;
  let litStart = 0;
  let litLen = 0;

  while (i < n) {
    const b = src[i];
    let r = 1;
    while (i + r < n && r < MAX_RUN && src[i + r] === b) r++;
    if (r >= MIN_RUN) {
      if (litLen > 0) {
        out[o++] = litLen - 1;
        out.set(src.subarray(litStart, litStart + litLen), o);
        o += litLen;
        litLen = 0;
      }
      out[o++] = 128 + (r - MIN_RUN);
      out[o++] = b;
      i += r;
    } else {
      if (litLen === 0) litStart = i;
      litLen++;
      i++;
      if (litLen === MAX_LITERAL) {
        out[o++] = litLen - 1;
        out.set(src.subarray(litStart, litStart + litLen), o);
        o += litLen;
        litLen = 0;
      }
    }
  }
  if (litLen > 0) {
    out[o++] = litLen - 1;
    out.set(src.subarray(litStart, litStart + litLen), o);
    o += litLen;
  }
  return out.slice(0, o);
}

export function unpackBits(src: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let o = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i++];
    if (c < 128) {
      const k = c + 1;
      if (i + k > n) throw new Error('RLE data truncated (literal block)');
      if (o + k > expectedLength) throw new Error('RLE data longer than expected');
      out.set(src.subarray(i, i + k), o);
      o += k;
      i += k;
    } else {
      const k = c - 128 + MIN_RUN;
      if (i >= n) throw new Error('RLE data truncated (run block)');
      if (o + k > expectedLength) throw new Error('RLE data longer than expected');
      out.fill(src[i++], o, o + k);
      o += k;
    }
  }
  if (o !== expectedLength) throw new Error(`RLE data length mismatch (got ${o}, expected ${expectedLength})`);
  return out;
}

/** Split `bytes` (elements of `stride` bytes) into byte planes. */
export function shuffleBytes(bytes: Uint8Array, stride: number): Uint8Array {
  const count = Math.floor(bytes.length / stride);
  const out = new Uint8Array(count * stride);
  for (let p = 0; p < stride; p++) {
    const base = p * count;
    for (let e = 0; e < count; e++) out[base + e] = bytes[e * stride + p];
  }
  return out;
}

export function unshuffleBytes(planes: Uint8Array, stride: number): Uint8Array {
  const count = Math.floor(planes.length / stride);
  const out = new Uint8Array(count * stride);
  for (let p = 0; p < stride; p++) {
    const base = p * count;
    for (let e = 0; e < count; e++) out[e * stride + p] = planes[base + e];
  }
  return out;
}

export function encodeZigzagVarints(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 5 + 8);
  let o = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] | 0;
    let z = ((v << 1) ^ (v >> 31)) >>> 0;
    while (z >= 0x80) {
      out[o++] = (z & 0x7f) | 0x80;
      z >>>= 7;
    }
    out[o++] = z;
  }
  return out.slice(0, o);
}

export function decodeZigzagVarints(bytes: Uint8Array, count: number): Int32Array {
  const out = new Int32Array(count);
  let i = 0;
  for (let k = 0; k < count; k++) {
    let z = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('varint data truncated');
      const b = bytes[i++];
      z |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error('varint too long');
    }
    z >>>= 0;
    out[k] = (z >>> 1) ^ -(z & 1);
  }
  if (i !== bytes.length) throw new Error('varint data has trailing bytes');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  const n = bytes.length;
  const parts: string[] = [];
  const CHUNK = 3 * 4096;
  for (let start = 0; start < n; start += CHUNK) {
    const end = Math.min(n, start + CHUNK);
    let s = '';
    let i = start;
    for (; i + 2 < end; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + B64[v & 63];
    }
    const rem = end - i;
    if (rem === 1) {
      const v = bytes[i] << 16;
      s += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + '==';
    } else if (rem === 2) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
      s += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + '=';
    }
    parts.push(s);
  }
  return parts.join('');
}

export function fromBase64(str: string): Uint8Array {
  let len = str.length;
  if (len % 4 !== 0) throw new Error('invalid base64 length');
  let pad = 0;
  if (len > 0 && str.charCodeAt(len - 1) === 61) pad++;
  if (len > 1 && str.charCodeAt(len - 2) === 61) pad++;
  const outLen = (len / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  len -= pad;
  const val = (k: number): number => {
    const c = str.charCodeAt(k);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) throw new Error(`invalid base64 character at ${k}`);
    return v;
  };
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const v = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3);
    out[o++] = (v >>> 16) & 255;
    out[o++] = (v >>> 8) & 255;
    out[o++] = v & 255;
  }
  const rem = len - i;
  if (rem === 2) {
    const v = (val(i) << 18) | (val(i + 1) << 12);
    out[o++] = (v >>> 16) & 255;
  } else if (rem === 3) {
    const v = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6);
    out[o++] = (v >>> 16) & 255;
    out[o++] = (v >>> 8) & 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Float array codecs built on the primitives above
// ---------------------------------------------------------------------------------------------

/** Growable byte writer. */
class ByteWriter {
  buf = new Uint8Array(1024);
  n = 0;

  private ensure(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.n++] = b;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }

  /** Unsigned LEB128 (values up to 2^32 - 1). */
  uvar(v: number): void {
    this.ensure(5);
    let z = v >>> 0;
    while (z >= 0x80) {
      this.buf[this.n++] = (z & 0x7f) | 0x80;
      z >>>= 7;
    }
    this.buf[this.n++] = z;
  }

  svar(v: number): void {
    this.uvar(((v << 1) ^ (v >> 31)) >>> 0);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

class ByteReader {
  i = 0;
  constructor(readonly buf: Uint8Array) {}

  byte(): number {
    if (this.i >= this.buf.length) throw new Error('data truncated');
    return this.buf[this.i++];
  }

  bytes(k: number): Uint8Array {
    if (this.i + k > this.buf.length) throw new Error('data truncated');
    const out = this.buf.slice(this.i, this.i + k);
    this.i += k;
    return out;
  }

  uvar(): number {
    let z = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      z |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error('varint too long');
    }
    return z >>> 0;
  }

  svar(): number {
    const z = this.uvar();
    return (z >>> 1) ^ -(z & 1);
  }

  end(): void {
    if (this.i !== this.buf.length) throw new Error('trailing bytes');
  }
}

function isNegZero(v: number): boolean {
  return v === 0 && 1 / v < 0;
}

/** Quantise every value to integer multiples of 1/scale, or null if any value is not exactly representable. */
function quantizeExact(a: ArrayLike<number>, scale: number): Int32Array | null {
  const q = new Int32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    const k = Math.round(v * scale);
    if (!(Math.abs(k) < 1 << 28) || Math.fround(k / scale) !== v || isNegZero(v)) return null;
    q[i] = k;
  }
  return q;
}

/**
 * Lossless grid codec for smooth w×h float fields (terrain heights): values must be exact multiples of 1/scale for
 * one of `scales`; residuals of the 2D gradient predictor (left + up − up-left) are zigzag varints, then RLE.
 * Returns null when no scale fits (caller falls back to a generic codec).
 */
export function encodeQuantGrid(a: Float32Array, w: number, h: number, scales: number[] = [256, 1024]): { scale: number; bytes: Uint8Array } | null {
  if (a.length !== w * h) return null;
  for (const scale of scales) {
    const q = quantizeExact(a, scale);
    if (!q) continue;
    const bw = new ByteWriter();
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        let pred = 0;
        if (x > 0 && z > 0) pred = q[i - 1] + q[i - w] - q[i - w - 1];
        else if (x > 0) pred = q[i - 1];
        else if (z > 0) pred = q[i - w];
        bw.svar(q[i] - pred);
      }
    }
    return { scale, bytes: packBits(bw.result()) };
  }
  return null;
}

export function decodeQuantGrid(packed: Uint8Array, scale: number, w: number, h: number): Float32Array {
  const raw = unpackBitsAuto(packed);
  const r = new ByteReader(raw);
  const q = new Int32Array(w * h);
  const out = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      let pred = 0;
      if (x > 0 && z > 0) pred = q[i - 1] + q[i - w] - q[i - w - 1];
      else if (x > 0) pred = q[i - 1];
      else if (z > 0) pred = q[i - w];
      q[i] = pred + r.svar();
      out[i] = q[i] / scale;
    }
  }
  r.end();
  return out;
}

/**
 * Lossless sparse codec for mostly-zero float arrays (feature amounts): alternating zero / non-zero run lengths,
 * then the non-zero values — as quantised deltas when exactly representable (scale 64 or 1024), else as
 * byte-shuffled float32. Everything is RLE packed.
 */
export function encodeSparseF32(a: Float32Array): Uint8Array {
  const n = a.length;
  const bw = new ByteWriter();
  const vals: number[] = [];
  let i = 0;
  while (i < n) {
    let z = 0;
    while (i < n && a[i] === 0 && !isNegZero(a[i])) {
      z++;
      i++;
    }
    let nz = 0;
    while (i < n && (a[i] !== 0 || isNegZero(a[i]))) {
      vals.push(a[i]);
      nz++;
      i++;
    }
    bw.uvar(z);
    bw.uvar(nz);
  }
  let written = false;
  for (const scale of [64, 1024]) {
    const q = quantizeExact(vals, scale);
    if (!q) continue;
    bw.byte(scale === 64 ? 1 : 2);
    let prev = 0;
    for (let k = 0; k < q.length; k++) {
      bw.svar(q[k] - prev);
      prev = q[k];
    }
    written = true;
    break;
  }
  if (!written) {
    bw.byte(0);
    bw.bytes(shuffleBytes(new Uint8Array(Float32Array.from(vals).buffer), 4));
  }
  return packBits(bw.result());
}

export function decodeSparseF32(packed: Uint8Array, n: number): Float32Array {
  const r = new ByteReader(unpackBitsAuto(packed));
  const out = new Float32Array(n);
  const nzIdx: number[] = [];
  let i = 0;
  while (i < n) {
    const z = r.uvar();
    const nz = r.uvar();
    if (i + z + nz > n) throw new Error('sparse runs exceed array length');
    i += z;
    for (let k = 0; k < nz; k++) nzIdx.push(i++);
  }
  const mode = r.byte();
  if (mode === 1 || mode === 2) {
    const scale = mode === 1 ? 64 : 1024;
    let prev = 0;
    for (const idx of nzIdx) {
      prev += r.svar();
      out[idx] = prev / scale;
    }
  } else if (mode === 0) {
    const bytes = unshuffleBytes(r.bytes(nzIdx.length * 4), 4);
    const vals = new Float32Array(bytes.buffer, 0, nzIdx.length);
    for (let k = 0; k < nzIdx.length; k++) out[nzIdx[k]] = vals[k];
  } else {
    throw new Error(`unknown sparse value mode ${mode}`);
  }
  r.end();
  return out;
}

/** RLE-decode when the decoded length is not known in advance. */
export function unpackBitsAuto(src: Uint8Array): Uint8Array {
  let total = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i++];
    if (c < 128) {
      total += c + 1;
      i += c + 1;
    } else {
      total += c - 128 + 3;
      i++;
    }
  }
  return unpackBits(src, total);
}
