/**
 * Per-chunk state: the cached density field, the CSG diff, and mesh bookkeeping.
 *
 * The field is authoritative and lives on the main thread. Edits are applied to
 * it directly (measured at ~0.02 ms for a 2.5 m sphere), and meshing is farmed
 * out to workers on a *copy*, so an edit is never blocked waiting for a worker.
 */
import { CHUNK, CHUNK_M, FIELD, FIELD2, PAD, VOXEL } from '../core/config.ts';
import { allocChunkField, fillChunkField, type ChunkFieldData } from './density.ts';
import { brushAabb, brushSdf, type Brush } from './brush.ts';
import { Mat } from './geology.ts';

export type ChunkKey = string;

export function chunkKey(cx: number, cy: number, cz: number): ChunkKey {
  return `${cx},${cy},${cz}`;
}

export function parseChunkKey(k: ChunkKey): [number, number, number] {
  const p = k.split(',');
  return [Number(p[0]), Number(p[1]), Number(p[2])];
}

/** World-space chunk origin (its minimum corner), metres. */
export function chunkOrigin(cx: number, cy: number, cz: number): [number, number, number] {
  return [cx * CHUNK_M, cy * CHUNK_M, cz * CHUNK_M];
}

export const ChunkState = {
  /** Queued for generation, no field yet. */
  PENDING: 0,
  /** Field present and meshed. */
  READY: 1,
} as const;

export interface Chunk {
  cx: number;
  cy: number;
  cz: number;
  key: ChunkKey;
  state: number;
  field: Float32Array | null;
  material: Uint8Array | null;
  /**
   * The CSG diff for this chunk, in application order. This is what gets saved.
   * Cleared when the chunk is baked (see `baked`).
   */
  brushes: Brush[];
  /**
   * True once the brush list has been folded into the field and discarded.
   * A baked chunk must persist its voxels, because its brush history is gone.
   */
  baked: boolean;
  /** Bumped every time the field changes, so stale mesh results can be dropped. */
  version: number;
  /** Version the currently displayed mesh was built from. */
  meshedVersion: number;
  /** True when a remesh has been requested but not yet applied. */
  remeshQueued: boolean;
}

export function createChunk(cx: number, cy: number, cz: number): Chunk {
  return {
    cx,
    cy,
    cz,
    key: chunkKey(cx, cy, cz),
    state: ChunkState.PENDING,
    field: null,
    material: null,
    brushes: [],
    baked: false,
    version: 0,
    meshedVersion: -1,
    remeshQueued: false,
  };
}

/** Generate a chunk's base field and replay its diff. Used off the main thread. */
export function buildChunkField(
  cx: number,
  cy: number,
  cz: number,
  seed: number,
  brushes: readonly Brush[],
  out?: ChunkFieldData,
): ChunkFieldData {
  const data = out ?? allocChunkField();
  fillChunkField(data, cx, cy, cz, seed, CHUNK);
  for (const b of brushes) applyBrushToField(data, cx, cy, cz, b);
  return data;
}

/**
 * Apply one brush to a chunk's field, touching only the voxels inside the
 * brush's AABB.
 *
 * Subtraction is `max(field, -sdf)` and addition is `min(field, sdf)`, the
 * standard SDF CSG operators. Because both operands are (approximately) signed
 * distances, the result stays usable for raymarching and for the next brush.
 */
export function applyBrushToField(
  data: ChunkFieldData,
  cx: number,
  cy: number,
  cz: number,
  b: Brush,
): boolean {
  const { field, material } = data;
  const aabb = brushAabb(b);
  // Field sample (i,j,k) sits at world (cx*CHUNK - PAD + i) * VOXEL.
  const baseX = cx * CHUNK - PAD;
  const baseY = cy * CHUNK - PAD;
  const baseZ = cz * CHUNK - PAD;

  const i0 = Math.max(0, Math.floor(aabb.min[0] / VOXEL) - baseX);
  const i1 = Math.min(FIELD - 1, Math.ceil(aabb.max[0] / VOXEL) - baseX);
  const j0 = Math.max(0, Math.floor(aabb.min[1] / VOXEL) - baseY);
  const j1 = Math.min(FIELD - 1, Math.ceil(aabb.max[1] / VOXEL) - baseY);
  const k0 = Math.max(0, Math.floor(aabb.min[2] / VOXEL) - baseZ);
  const k1 = Math.min(FIELD - 1, Math.ceil(aabb.max[2] / VOXEL) - baseZ);
  if (i0 > i1 || j0 > j1 || k0 > k1) return false;

  const add = b.op === 'add';
  let changed = false;
  for (let k = k0; k <= k1; k++) {
    const wz = (baseZ + k) * VOXEL;
    for (let j = j0; j <= j1; j++) {
      const wy = (baseY + j) * VOXEL;
      let idx = i0 + j * FIELD + k * FIELD2;
      for (let i = i0; i <= i1; i++, idx++) {
        const wx = (baseX + i) * VOXEL;
        const sd = brushSdf(b, wx, wy, wz);
        const prev = field[idx]!;
        if (add) {
          if (sd < prev) {
            field[idx] = sd;
            if (sd < 0) material[idx] = b.mat;
            changed = true;
          }
        } else {
          const next = -sd;
          if (next > prev) {
            field[idx] = next;
            if (next >= 0) material[idx] = Mat.AIR;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

/** Does a world-space AABB touch this chunk's own volume (its padding aside)? */
export function chunkTouchedByAabb(
  cx: number,
  cy: number,
  cz: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  // Include the padding ring: a brush just outside the chunk still changes the
  // padding samples, which changes the boundary quads this chunk emits.
  const pad = PAD * VOXEL;
  const ox = cx * CHUNK_M - pad;
  const oy = cy * CHUNK_M - pad;
  const oz = cz * CHUNK_M - pad;
  const ex = ox + CHUNK_M + 2 * pad;
  const ey = oy + CHUNK_M + 2 * pad;
  const ez = oz + CHUNK_M + 2 * pad;
  return min[0] <= ex && max[0] >= ox && min[1] <= ey && max[1] >= oy && min[2] <= ez && max[2] >= oz;
}

/** Range of chunk coordinates whose fields a world-space AABB can affect. */
export function chunkRangeForAabb(min: readonly [number, number, number], max: readonly [number, number, number]) {
  const pad = PAD * VOXEL;
  return {
    x0: Math.floor((min[0] - pad) / CHUNK_M),
    x1: Math.floor((max[0] + pad) / CHUNK_M),
    y0: Math.floor((min[1] - pad) / CHUNK_M),
    y1: Math.floor((max[1] + pad) / CHUNK_M),
    z0: Math.floor((min[2] - pad) / CHUNK_M),
    z1: Math.floor((max[2] + pad) / CHUNK_M),
  };
}

/** Sample a chunk's field at a world point by trilinear interpolation. */
export function sampleChunkField(ch: Chunk, x: number, y: number, z: number): number | null {
  const f = ch.field;
  if (!f) return null;
  const fx = x / VOXEL - (ch.cx * CHUNK - PAD);
  const fy = y / VOXEL - (ch.cy * CHUNK - PAD);
  const fz = z / VOXEL - (ch.cz * CHUNK - PAD);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const k = Math.floor(fz);
  if (i < 0 || j < 0 || k < 0 || i >= FIELD - 1 || j >= FIELD - 1 || k >= FIELD - 1) return null;
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const b = i + j * FIELD + k * FIELD2;
  const c000 = f[b]!;
  const c100 = f[b + 1]!;
  const c010 = f[b + FIELD]!;
  const c110 = f[b + FIELD + 1]!;
  const c001 = f[b + FIELD2]!;
  const c101 = f[b + FIELD2 + 1]!;
  const c011 = f[b + FIELD2 + FIELD]!;
  const c111 = f[b + FIELD2 + FIELD + 1]!;
  const x00 = c000 + (c100 - c000) * tx;
  const x10 = c010 + (c110 - c010) * tx;
  const x01 = c001 + (c101 - c001) * tx;
  const x11 = c011 + (c111 - c011) * tx;
  const y0 = x00 + (x10 - x00) * ty;
  const y1 = x01 + (x11 - x01) * ty;
  return y0 + (y1 - y0) * tz;
}

/** Material id at a world point from a chunk's cached array (nearest sample). */
export function sampleChunkMaterial(ch: Chunk, x: number, y: number, z: number): number | null {
  const m = ch.material;
  if (!m) return null;
  const i = Math.round(x / VOXEL - (ch.cx * CHUNK - PAD));
  const j = Math.round(y / VOXEL - (ch.cy * CHUNK - PAD));
  const k = Math.round(z / VOXEL - (ch.cz * CHUNK - PAD));
  if (i < 0 || j < 0 || k < 0 || i >= FIELD || j >= FIELD || k >= FIELD) return null;
  return m[i + j * FIELD + k * FIELD2]!;
}
