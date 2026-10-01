/**
 * Terrain BufferGeometry: one quad per tile with 4 unique vertices (so each tile owns its overlay pattern), heights
 * shared through the corner array. Supports diff-based partial updates with GPU update ranges. OWNER: render-scene.
 *
 * Vertex order per tile i: v0 (x,z), v1 (x+1,z), v2 (x,z+1), v3 (x+1,z+1) at indices 4i..4i+3 — the terrain shader
 * derives the tile coordinate from gl_VertexID / 4, so this layout is part of the shader contract.
 *
 * Culling chunks (performance pass): the INDEX buffer is ordered chunk-major (square chunks, see terrainChunkSize),
 * and `chunks[]` exposes one lightweight geometry per chunk that borrows every attribute + the index and draws only its
 * index range, with tight bounds. The renderer draws one mesh per chunk so off-screen chunks are skipped in both the
 * main and the shadow pass. Vertex order (and gl_VertexID) is unchanged.
 */
import * as THREE from 'three';

interface Range {
  min: number;
  max: number;
}

function touch(r: Range, lo: number, hi: number): void {
  if (lo < r.min) r.min = lo;
  if (hi > r.max) r.max = hi;
}

function flush(attr: THREE.BufferAttribute, r: Range, itemsPerUnit: number): void {
  if (r.max < r.min) return;
  const start = r.min * itemsPerUnit;
  const count = (r.max - r.min + 1) * itemsPerUnit;
  attr.addUpdateRange(start, count);
  attr.needsUpdate = true;
  r.min = Infinity;
  r.max = -Infinity;
}

/** Chunk edge (tiles) for culling: ~5×5 chunks per map, multiple of 8. */
export function terrainChunkSize(W: number, H: number): number {
  return Math.max(16, Math.ceil(Math.max(W, H) / 5 / 8) * 8);
}

export interface TerrainChunk {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** First quad slot and quad count of the chunk in the index buffer. */
  start: number;
  count: number;
  geometry: THREE.BufferGeometry;
  boundsDirty: boolean;
  /** Steepest height change between neighbouring corners (units per tile) — flat chunks cannot cast shadows. */
  maxSlope: number;
  /** Height range (max − min corner) of the chunk. */
  relief: number;
}

export class TerrainGeometry {
  readonly geometry: THREE.BufferGeometry;
  /** Per-chunk views of the geometry (shared buffers, own draw range & bounds). */
  readonly chunks: TerrainChunk[] = [];
  /** Quad slot (position in the index buffer, in quads) of each tile. */
  private readonly slot: Int32Array;
  private readonly chunkOf: Int32Array;
  private readonly heightsRef: { h: Float32Array };
  readonly W: number;
  readonly H: number;
  private readonly pos: THREE.BufferAttribute;
  private readonly nrm: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private readonly mat: THREE.BufferAttribute;
  private readonly idx: THREE.BufferAttribute;
  /** Heights the geometry was last built from (to diff). */
  private readonly lastHeights: Float32Array;
  private readonly posRange: Range = { min: Infinity, max: -Infinity };
  private readonly nrmRange: Range = { min: Infinity, max: -Infinity };
  private readonly colRange: Range = { min: Infinity, max: -Infinity };
  private readonly matRange: Range = { min: Infinity, max: -Infinity };
  private readonly idxRange: Range = { min: Infinity, max: -Infinity };
  private readonly dirtyTiles: Uint8Array;

  constructor(W: number, H: number, heights: Float32Array) {
    this.W = W;
    this.H = H;
    const n = W * H;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Int8Array(n * 4 * 3), 3, true);
    this.col = new THREE.BufferAttribute(new Uint8Array(n * 4 * 4), 4, true);
    this.mat = new THREE.BufferAttribute(new Uint8Array(n * 4 * 4), 4, true);
    this.idx = new THREE.BufferAttribute(new Uint32Array(n * 6), 1);
    for (const a of [this.pos, this.nrm, this.col, this.mat, this.idx]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('normal', this.nrm);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aMat', this.mat);
    g.setIndex(this.idx);
    this.geometry = g;
    this.lastHeights = new Float32Array(heights.length);
    this.dirtyTiles = new Uint8Array(n);
    this.heightsRef = { h: heights };
    // chunk-major quad order
    this.slot = new Int32Array(n);
    this.chunkOf = new Int32Array(n);
    const cs = terrainChunkSize(W, H);
    let next = 0;
    for (let cz = 0; cz < H; cz += cs) {
      for (let cx = 0; cx < W; cx += cs) {
        const x1 = Math.min(W, cx + cs);
        const z1 = Math.min(H, cz + cs);
        const start = next;
        for (let z = cz; z < z1; z++) {
          for (let x = cx; x < x1; x++) {
            this.slot[z * W + x] = next++;
            this.chunkOf[z * W + x] = this.chunks.length;
          }
        }
        const cg = new THREE.BufferGeometry();
        for (const name of Object.keys(g.attributes)) cg.setAttribute(name, g.attributes[name]);
        cg.setIndex(this.idx);
        cg.setDrawRange(start * 6, (next - start) * 6);
        this.chunks.push({ x0: cx, z0: cz, x1, z1, start, count: next - start, geometry: cg, boundsDirty: true, maxSlope: 0, relief: 0 });
      }
    }
    for (let i = 0; i < n; i++) this.writeTileShape(i, heights);
    this.lastHeights.set(heights);
    this.updateBounds(heights);
    // full upload on first render — drop the ranges accumulated by the initial fill
    this.posRange.min = this.idxRange.min = Infinity;
    this.posRange.max = this.idxRange.max = -Infinity;
  }

  private updateBounds(heights: Float32Array): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const g = this.geometry;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, lo, 0), new THREE.Vector3(this.W, hi, this.H));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.heightsRef.h = heights;
    for (const c of this.chunks) if (c.boundsDirty) this.updateChunkBounds(c);
  }

  private updateChunkBounds(c: TerrainChunk): void {
    c.boundsDirty = false;
    const h = this.heightsRef.h;
    const W1 = this.W + 1;
    let lo = Infinity;
    let hi = -Infinity;
    let slope = 0;
    for (let z = c.z0; z <= c.z1; z++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const v = h[z * W1 + x];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (x < c.x1) slope = Math.max(slope, Math.abs(h[z * W1 + x + 1] - v));
        if (z < c.z1) slope = Math.max(slope, Math.abs(h[(z + 1) * W1 + x] - v));
      }
    }
    c.maxSlope = slope;
    c.relief = hi - lo;
    const g = c.geometry;
    // small vertical pad: the shader bends nothing, but keep bounds conservative
    g.boundingBox = new THREE.Box3(new THREE.Vector3(c.x0, lo - 0.1, c.z0), new THREE.Vector3(c.x1, hi + 0.1, c.z1));
    g.boundingSphere = g.boundingBox.getBoundingSphere(g.boundingSphere ?? new THREE.Sphere());
  }

  private writeTileShape(i: number, heights: Float32Array): void {
    const W = this.W;
    const x = i % W;
    const z = (i / W) | 0;
    const W1 = W + 1;
    const h00 = heights[z * W1 + x];
    const h10 = heights[z * W1 + x + 1];
    const h01 = heights[(z + 1) * W1 + x];
    const h11 = heights[(z + 1) * W1 + x + 1];
    const p = this.pos.array as Float32Array;
    const o = i * 12;
    p[o] = x; p[o + 1] = h00; p[o + 2] = z;
    p[o + 3] = x + 1; p[o + 4] = h10; p[o + 5] = z;
    p[o + 6] = x; p[o + 7] = h01; p[o + 8] = z + 1;
    p[o + 9] = x + 1; p[o + 10] = h11; p[o + 11] = z + 1;
    // smooth per-corner normals (central differences). The shader blends them with the flat facet normal
    // (meadows mostly smooth, rock faceted); they also drive the shadow normal bias.
    const nn = this.nrm.array as Int8Array;
    const H = this.H;
    const hc = (cx: number, cz: number): number =>
      heights[(cz < 0 ? 0 : cz > H ? H : cz) * W1 + (cx < 0 ? 0 : cx > W ? W : cx)];
    for (let v = 0; v < 4; v++) {
      const cx = x + (v & 1);
      const cz = z + (v >> 1);
      const nx = hc(cx - 1, cz) - hc(cx + 1, cz);
      const nz = hc(cx, cz - 1) - hc(cx, cz + 1);
      const l = Math.hypot(nx, 2, nz);
      nn[o + v * 3] = Math.round((nx / l) * 127);
      nn[o + v * 3 + 1] = Math.round((2 / l) * 127);
      nn[o + v * 3 + 2] = Math.round((nz / l) * 127);
    }
    // split along the diagonal with the smaller height difference (better shape for ridges/valleys)
    const ix = this.idx.array as Uint32Array;
    const b = i * 4;
    const k = this.slot[i] * 6;
    if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
      ix[k] = b; ix[k + 1] = b + 2; ix[k + 2] = b + 3;
      ix[k + 3] = b; ix[k + 4] = b + 3; ix[k + 5] = b + 1;
    } else {
      ix[k] = b; ix[k + 1] = b + 2; ix[k + 2] = b + 1;
      ix[k + 3] = b + 1; ix[k + 4] = b + 2; ix[k + 5] = b + 3;
    }
    touch(this.posRange, i, i);
    touch(this.idxRange, this.slot[i], this.slot[i]);
    this.chunks[this.chunkOf[i]].boundsDirty = true;
  }

  /**
   * Diff heights against the last build and rewrite changed tiles (incl. neighbours whose smooth normals moved).
   * Returns the number of rewritten tiles; their indices go to `out` up to its capacity.
   */
  syncHeights(heights: Float32Array, out?: Int32Array): number {
    const W = this.W;
    const H = this.H;
    const W1 = W + 1;
    const last = this.lastHeights;
    const dirty = this.dirtyTiles;
    let any = false;
    for (let c = 0; c < heights.length; c++) {
      if (heights[c] === last[c]) continue;
      any = true;
      last[c] = heights[c];
      const cx = c % W1;
      const cz = (c / W1) | 0;
      // tiles touching this corner or a neighbouring corner (whose smooth normal uses this height)
      for (let dz = -2; dz <= 1; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= H) continue;
        for (let dx = -2; dx <= 1; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= W) continue;
          dirty[z * W + x] = 1;
        }
      }
    }
    if (!any) return 0;
    const cap = out ? out.length : 0;
    let count = 0;
    for (let i = 0; i < dirty.length; i++) {
      if (dirty[i]) {
        dirty[i] = 0;
        this.writeTileShape(i, heights);
        if (count < cap) out![count] = i;
        count++;
      }
    }
    this.updateBounds(heights);
    return count;
  }

  /**
   * Write per-vertex natural colour & material from corner arrays ((W+1)*(H+1)*4 bytes each: r,g,b,_ and
   * grass,snow,rock,sand). Vertex layout: aColor = (r, g, b, sand), aMat.xyz = (grass, snow, rock); aMat.w is the
   * overlay byte (see syncOverlay). Only bytes that differ are counted as dirty. Returns true if anything changed.
   */
  syncNatural(cornerRgb: Uint8Array, cornerMat: Uint8Array): boolean {
    let any = false;
    for (let z = 0; z < this.H; z++) {
      for (let x = 0; x < this.W; x++) {
        if (this.writeNaturalTile(x, z, cornerRgb, cornerMat)) any = true;
      }
    }
    return any;
  }

  /**
   * Incremental variant: rewrite only the tiles that share a corner with one of the listed (changed) tiles,
   * i.e. the 3x3 neighbourhood of each. Returns true if anything changed.
   */
  syncNaturalTiles(cornerRgb: Uint8Array, cornerMat: Uint8Array, tiles: Int32Array, count: number): boolean {
    const W = this.W;
    const H = this.H;
    let any = false;
    for (let k = 0; k < count; k++) {
      const i = tiles[k];
      const tx = i % W;
      const tz = (i / W) | 0;
      for (let z = Math.max(0, tz - 1); z <= Math.min(H - 1, tz + 1); z++) {
        for (let x = Math.max(0, tx - 1); x <= Math.min(W - 1, tx + 1); x++) {
          if (this.writeNaturalTile(x, z, cornerRgb, cornerMat)) any = true;
        }
      }
    }
    return any;
  }

  private writeNaturalTile(x: number, z: number, cornerRgb: Uint8Array, cornerMat: Uint8Array): boolean {
    const W1 = this.W + 1;
    const col = this.col.array as Uint8Array;
    const mat = this.mat.array as Uint8Array;
    const i = z * this.W + x;
    let tileDirty = false;
    for (let v = 0; v < 4; v++) {
      const cx = x + (v & 1);
      const cz = z + (v >> 1);
      const s = (cz * W1 + cx) * 4;
      const d = (i * 4 + v) * 4;
      if (col[d] !== cornerRgb[s] || col[d + 1] !== cornerRgb[s + 1] || col[d + 2] !== cornerRgb[s + 2]
        || col[d + 3] !== cornerMat[s + 3]
        || mat[d] !== cornerMat[s] || mat[d + 1] !== cornerMat[s + 1] || mat[d + 2] !== cornerMat[s + 2]) {
        col[d] = cornerRgb[s]; col[d + 1] = cornerRgb[s + 1]; col[d + 2] = cornerRgb[s + 2]; col[d + 3] = cornerMat[s + 3];
        mat[d] = cornerMat[s]; mat[d + 1] = cornerMat[s + 1]; mat[d + 2] = cornerMat[s + 2];
        tileDirty = true;
      }
    }
    if (tileDirty) {
      touch(this.colRange, i, i);
      touch(this.matRange, i, i);
    }
    return tileDirty;
  }

  /** Write per-tile overlay bytes (aMat.w on all 4 vertices). Returns true if anything changed. */
  syncOverlay(overlay: Uint8Array): boolean {
    const mat = this.mat.array as Uint8Array;
    let any = false;
    for (let i = 0; i < overlay.length; i++) {
      const o = overlay[i];
      const d = i * 16 + 3;
      if (mat[d] === o) continue;
      mat[d] = o; mat[d + 4] = o; mat[d + 8] = o; mat[d + 12] = o;
      touch(this.matRange, i, i);
      any = true;
    }
    return any;
  }

  /** Push accumulated dirty ranges to the GPU (call once per frame after syncs). */
  flush(): void {
    if (this.posRange.max >= this.posRange.min) {
      this.nrmRange.min = this.posRange.min;
      this.nrmRange.max = this.posRange.max;
      flush(this.pos, this.posRange, 12);
      flush(this.nrm, this.nrmRange, 12);
    }
    flush(this.idx, this.idxRange, 6);
    flush(this.col, this.colRange, 16);
    flush(this.mat, this.matRange, 16);
  }

  dispose(): void {
    // All views are disposed together: whichever the renderer has seen frees the shared GL buffers (removal is
    // idempotent) and every view releases its own vertex-array state.
    for (const c of this.chunks) c.geometry.dispose();
    this.geometry.dispose();
  }
}
