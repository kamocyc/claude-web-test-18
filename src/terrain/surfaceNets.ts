/**
 * Naive Surface Nets (dual contouring on a uniform grid, vertex at the centroid
 * of the cell's edge crossings).
 *
 * Chosen over Marching Cubes because it produces one vertex per cell instead of
 * up to 15, gives much better-shaped triangles, and needs no case tables.
 *
 * Seamlessness without cross-chunk communication:
 *   Each chunk owns cells [CELL_LO, CELL_HI]. A quad for the edge leaving a
 *   cell in the +x direction is built from that cell and its three neighbours in
 *   -y/-z, so a chunk needs one ring of cells below CELL_LO as corners but none
 *   above CELL_HI: the +x/+y/+z neighbour emits the quads crossing the shared
 *   face. Because both chunks sample the identical world positions from the
 *   identical deterministic density function, the shared vertices agree to
 *   within float32 rounding of the chunk-local coordinates (under a micrometre
 *   at these magnitudes) and the surface closes.
 *
 *   Positions are chunk-local rather than world-absolute precisely so that
 *   float32 keeps its precision near the origin of each chunk; the cost is that
 *   a vertex shared by two chunks is not *bit*-identical between them, only
 *   equal to ~1e-6 m. Verified watertight in tests/surfaceNets.test.ts by
 *   welding at 0.1 mm.
 */
import { CELL_HI, CELL_LO, FIELD, FIELD2, PAD, VOXEL } from '../core/config.ts';

/** The 8 corners of a cell, in the canonical (x + 2y + 4z) bit order. */
const CORNER_X = new Int32Array([0, 1, 0, 1, 0, 1, 0, 1]);
const CORNER_Y = new Int32Array([0, 0, 1, 1, 0, 0, 1, 1]);
const CORNER_Z = new Int32Array([0, 0, 0, 0, 1, 1, 1, 1]);
/** The 12 edges of a cell as corner-index pairs. */
const EDGES = new Int32Array([
  0, 1, 2, 3, 4, 5, 6, 7, // along x
  0, 2, 1, 3, 4, 6, 5, 7, // along y
  0, 4, 1, 5, 2, 6, 3, 7, // along z
]);

export interface MeshArrays {
  /** Vertex positions, chunk-local metres (origin at the chunk's min corner). */
  positions: Float32Array;
  normals: Float32Array;
  /** Per-vertex material id, as a float attribute for the shader. */
  materials: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/** Reusable scratch, sized for the theoretical worst case (a vertex per cell). */
const MAX_CELLS = (FIELD - 1) * (FIELD - 1) * (FIELD - 1);
const scratchPos = new Float32Array(MAX_CELLS * 3);
const scratchNrm = new Float32Array(MAX_CELLS * 3);
const scratchMat = new Float32Array(MAX_CELLS);
// Each cell can emit up to 3 quads = 6 triangles = 18 indices. Sizing this at
// 6 would silently drop triangles once a chunk got busy enough, because
// out-of-range typed-array writes are no-ops rather than errors.
const scratchIdx = new Uint32Array(MAX_CELLS * 18);
/** Cell index -> emitted vertex index, or -1. */
const cellVertex = new Int32Array(MAX_CELLS);
const d = new Float64Array(8);

/**
 * Extract the zero-isosurface of `field` (negative = solid).
 *
 * Positions are chunk-local: sample index i along an axis maps to
 * (i - PAD) * VOXEL metres, so the chunk's own volume starts at 0.
 */
export function surfaceNets(field: Float32Array, material: Uint8Array): MeshArrays {
  const cellsPerAxis = FIELD - 1;
  cellVertex.fill(-1);
  let nv = 0;
  let ni = 0;

  for (let z = 0; z < cellsPerAxis; z++) {
    for (let y = 0; y < cellsPerAxis; y++) {
      for (let x = 0; x < cellsPerAxis; x++) {
        const base = x + y * FIELD + z * FIELD2;
        d[0] = field[base]!;
        d[1] = field[base + 1]!;
        d[2] = field[base + FIELD]!;
        d[3] = field[base + FIELD + 1]!;
        d[4] = field[base + FIELD2]!;
        d[5] = field[base + FIELD2 + 1]!;
        d[6] = field[base + FIELD2 + FIELD]!;
        d[7] = field[base + FIELD2 + FIELD + 1]!;

        let mask = 0;
        for (let c = 0; c < 8; c++) if (d[c]! < 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue; // wholly air or wholly solid

        // --- vertex: centroid of this cell's edge crossings ---
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let crossings = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e * 2]!;
          const b = EDGES[e * 2 + 1]!;
          const da = d[a]!;
          const db = d[b]!;
          if (da < 0 === db < 0) continue;
          const t = da / (da - db);
          cx += CORNER_X[a]! + t * (CORNER_X[b]! - CORNER_X[a]!);
          cy += CORNER_Y[a]! + t * (CORNER_Y[b]! - CORNER_Y[a]!);
          cz += CORNER_Z[a]! + t * (CORNER_Z[b]! - CORNER_Z[a]!);
          crossings++;
        }
        cx /= crossings;
        cy /= crossings;
        cz /= crossings;

        const cellIdx = x + y * cellsPerAxis + z * cellsPerAxis * cellsPerAxis;
        cellVertex[cellIdx] = nv;
        scratchPos[nv * 3] = (x + cx - PAD) * VOXEL;
        scratchPos[nv * 3 + 1] = (y + cy - PAD) * VOXEL;
        scratchPos[nv * 3 + 2] = (z + cz - PAD) * VOXEL;

        // --- normal: central difference of the field at the cell centre ---
        // Clamped to the array bounds; the padding ring means the clamp only
        // ever bites on cells outside the owned range, which emit no quads.
        const sx = Math.min(FIELD - 2, Math.max(1, x));
        const sy = Math.min(FIELD - 2, Math.max(1, y));
        const sz = Math.min(FIELD - 2, Math.max(1, z));
        const c0 = sx + sy * FIELD + sz * FIELD2;
        let gx = field[c0 + 1]! - field[c0 - 1]!;
        let gy = field[c0 + FIELD]! - field[c0 - FIELD]!;
        let gz = field[c0 + FIELD2]! - field[c0 - FIELD2]!;
        const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (len > 1e-12) {
          gx /= len;
          gy /= len;
          gz /= len;
        } else {
          gx = 0;
          gy = 1;
          gz = 0;
        }
        scratchNrm[nv * 3] = gx;
        scratchNrm[nv * 3 + 1] = gy;
        scratchNrm[nv * 3 + 2] = gz;

        // --- material: the most deeply solid corner wins ---
        let bestCorner = -1;
        let bestDepth = Infinity;
        for (let c = 0; c < 8; c++) {
          if (d[c]! < 0 && d[c]! < bestDepth) {
            bestDepth = d[c]!;
            bestCorner = c;
          }
        }
        if (bestCorner >= 0) {
          const off =
            base + CORNER_X[bestCorner]! + CORNER_Y[bestCorner]! * FIELD + CORNER_Z[bestCorner]! * FIELD2;
          scratchMat[nv] = material[off]!;
        }
        nv++;

        // --- quads: only for cells this chunk owns ---
        if (x < CELL_LO || y < CELL_LO || z < CELL_LO) continue;
        if (x > CELL_HI || y > CELL_HI || z > CELL_HI) continue;

        const self = nv - 1;
        const strideY = cellsPerAxis;
        const strideZ = cellsPerAxis * cellsPerAxis;

        // Edge along +x is shared by the cells offset in -y and -z.
        if (d[0]! < 0 !== d[1]! < 0) {
          const a = cellVertex[cellIdx - strideY]!;
          const b = cellVertex[cellIdx - strideZ]!;
          const c = cellVertex[cellIdx - strideY - strideZ]!;
          if (a >= 0 && b >= 0 && c >= 0) {
            ni = emitQuad(scratchIdx, ni, self, a, c, b, d[0]! < 0);
          }
        }
        // Edge along +y is shared by the cells offset in -x and -z.
        if (d[0]! < 0 !== d[2]! < 0) {
          const a = cellVertex[cellIdx - 1]!;
          const b = cellVertex[cellIdx - strideZ]!;
          const c = cellVertex[cellIdx - 1 - strideZ]!;
          if (a >= 0 && b >= 0 && c >= 0) {
            ni = emitQuad(scratchIdx, ni, self, b, c, a, d[0]! < 0);
          }
        }
        // Edge along +z is shared by the cells offset in -x and -y.
        if (d[0]! < 0 !== d[4]! < 0) {
          const a = cellVertex[cellIdx - 1]!;
          const b = cellVertex[cellIdx - strideY]!;
          const c = cellVertex[cellIdx - 1 - strideY]!;
          if (a >= 0 && b >= 0 && c >= 0) {
            ni = emitQuad(scratchIdx, ni, self, a, c, b, d[0]! < 0);
          }
        }
      }
    }
  }

  return {
    positions: scratchPos.slice(0, nv * 3),
    normals: scratchNrm.slice(0, nv * 3),
    materials: scratchMat.slice(0, nv),
    indices: scratchIdx.slice(0, ni),
    vertexCount: nv,
    triangleCount: ni / 3,
  };
}

/**
 * Write two triangles for the quad (v0, v1, v2, v3), flipping the winding so
 * the face points from solid to air.
 */
function emitQuad(
  out: Uint32Array,
  ni: number,
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  flip: boolean,
): number {
  if (flip) {
    out[ni++] = v0;
    out[ni++] = v1;
    out[ni++] = v2;
    out[ni++] = v0;
    out[ni++] = v2;
    out[ni++] = v3;
  } else {
    out[ni++] = v0;
    out[ni++] = v2;
    out[ni++] = v1;
    out[ni++] = v0;
    out[ni++] = v3;
    out[ni++] = v2;
  }
  return ni;
}
