/**
 * GeoBuilder — merges three.js primitives into one flat-shaded, non-indexed BufferGeometry with the vertex attributes
 * the entity shaders expect:
 *   position, normal (face normals), color (linear RGB), aPart (float), aCenter (vec3)
 *
 * aPart conventions (see natureMaterial.ts):
 *   0 = bark / solid baked colour, 1 = foliage (colour computed in the shader, vertex colour r = brightness,
 *   g = per-face random), 3 = rock, 4 = marker.
 * aCenter: object-space pivot the foliage shrinks toward when leaves fall.
 */
import * as THREE from 'three';
import { hash2 } from '../../core/rng';

export const PART_BARK = 0;
export const PART_FOLIAGE = 1;
export const PART_ROCK = 3;
export const PART_MARKER = 4;

export interface PartOptions {
  /** sRGB hex colour of the part (default white). Ignored when `faceColor` returns a value. */
  color?: number;
  /** Per-face brightness variation amplitude (0 = none). */
  colorVar?: number;
  /** Brightness multiplier (foliage encoding / baked colour), default 1. */
  brightness?: number;
  /** aPart value (default PART_BARK). */
  part?: number;
  /** aCenter value; 'auto' = centre of the transformed part's bounding box (default [0,0,0]). */
  center?: [number, number, number] | 'auto';
  /** Deterministic vertex jitter amplitude (world units). Shared vertices move together. */
  jitter?: number;
  /** Seed for jitter / colour variation. */
  seed?: number;
  /**
   * Foliage encoding: vertex colour r = brightness (1 ± colorVar), g = per-face random [0,1), b = 0.
   * The foliage shader computes the actual leaf colour.
   */
  foliage?: boolean;
  /** Optional per-vertex brightness multiplier (e.g. darker base, lighter tips); receives transformed coords. */
  shade?: (x: number, y: number, z: number) => number;
  /** Optional per-face colour override: return an sRGB hex or null to use `color`. */
  faceColor?: (face: number, cx: number, cy: number, cz: number, rnd: number) => number | null;
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();

export class GeoBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private part: number[] = [];
  private center: number[] = [];

  /** Append a primitive (consumed: it is disposed afterwards). */
  add(src: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, opts: PartOptions = {}): this {
    const geo = src.index ? src.toNonIndexed() : src;
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = p.count;
    const seed = opts.seed ?? 1;
    const jitter = opts.jitter ?? 0;
    const tmp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      _v.set(p.getX(i), p.getY(i), p.getZ(i));
      if (matrix) _v.applyMatrix4(matrix);
      tmp[i * 3] = _v.x;
      tmp[i * 3 + 1] = _v.y;
      tmp[i * 3 + 2] = _v.z;
    }
    let ctr: [number, number, number] = [0, 0, 0];
    if (opts.center === 'auto') {
      _box.makeEmpty();
      for (let i = 0; i < n; i++) _box.expandByPoint(_v.set(tmp[i * 3], tmp[i * 3 + 1], tmp[i * 3 + 2]));
      _box.getCenter(_v);
      ctr = [_v.x, _v.y, _v.z];
    } else if (opts.center) {
      ctr = opts.center;
    }
    if (jitter > 0) {
      for (let i = 0; i < n; i++) {
        const kx = Math.round(tmp[i * 3] * 1000);
        const ky = Math.round(tmp[i * 3 + 1] * 1000);
        const kz = Math.round(tmp[i * 3 + 2] * 1000);
        const k = kx * 7919 + kz * 104729;
        tmp[i * 3] += (hash2(k, ky, seed) - 0.5) * 2 * jitter;
        tmp[i * 3 + 1] += (hash2(k, ky, seed + 17) - 0.5) * 2 * jitter;
        tmp[i * 3 + 2] += (hash2(k, ky, seed + 31) - 0.5) * 2 * jitter;
      }
    }
    const baseHex = opts.color ?? 0xffffff;
    const cv = opts.colorVar ?? 0;
    const partVal = opts.part ?? PART_BARK;
    const bright = opts.brightness ?? 1;
    for (let f = 0; f < n / 3; f++) {
      const i0 = f * 3;
      const cx = (tmp[i0 * 3] + tmp[i0 * 3 + 3] + tmp[i0 * 3 + 6]) / 3;
      const cy = (tmp[i0 * 3 + 1] + tmp[i0 * 3 + 4] + tmp[i0 * 3 + 7]) / 3;
      const cz = (tmp[i0 * 3 + 2] + tmp[i0 * 3 + 5] + tmp[i0 * 3 + 8]) / 3;
      const rnd = hash2(f, this.pos.length, seed + 101);
      const rnd2 = hash2(f, this.pos.length, seed + 203);
      let r: number;
      let g: number;
      let b: number;
      if (opts.foliage) {
        r = bright * (1 + (rnd - 0.5) * 2 * cv);
        g = rnd2;
        b = 0;
      } else {
        const hex = opts.faceColor?.(f, cx, cy, cz, rnd) ?? baseHex;
        _c.setHex(hex);
        const k = bright * (1 + (rnd - 0.5) * 2 * cv);
        r = _c.r * k;
        g = _c.g * k;
        b = _c.b * k;
      }
      for (let j = 0; j < 3; j++) {
        const vi = i0 + j;
        const vx = tmp[vi * 3];
        const vy = tmp[vi * 3 + 1];
        const vz = tmp[vi * 3 + 2];
        this.pos.push(vx, vy, vz);
        if (opts.shade && !opts.foliage) {
          const k = opts.shade(vx, vy, vz);
          this.col.push(r * k, g * k, b * k);
        } else {
          this.col.push(r, g, b);
        }
        this.part.push(partVal);
        this.center.push(ctr[0], ctr[1], ctr[2]);
      }
    }
    if (geo !== src) geo.dispose();
    src.dispose();
    return this;
  }

  /** Number of vertices added so far. */
  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aCenter', new THREE.Float32BufferAttribute(this.center, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---- matrix helpers for authoring -----------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Compose a TRS matrix (Euler XYZ in radians). Returns a new Matrix4 (authoring-time only). */
export function trs(
  px: number, py: number, pz: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz));
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

/**
 * Matrix placing a Y-aligned primitive of unit length (centred at origin) as a limb from `a` to `b`.
 * Use with CylinderGeometry(rTop, rBottom, 1, ...) — the bottom radius ends at `a`.
 */
export function limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number): THREE.Matrix4 {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length();
  _dir.normalize();
  _q.setFromUnitVectors(_up, _dir);
  return _m.clone().compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, len, 1));
}
