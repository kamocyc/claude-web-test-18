/**
 * The base density (signed-distance-like) field, and the routine that fills a
 * whole chunk's field + material arrays.
 *
 * Convention throughout the project: density < 0 is SOLID, density > 0 is AIR.
 * The value approximates a signed distance in metres near the surface, which is
 * what makes CSG min/max operations and SDF raymarching behave sensibly.
 */
import { FIELD, PAD, VOXEL } from '../core/config.ts';
import { carveAt, columnGeology, materialAtColumn, Mat, type ColumnGeology } from './geology.ts';

/**
 * Base density at a world point. Negative inside the ground.
 *
 * The carve term (see geology.carveAt) is what makes overhangs and natural caves
 * possible; a pure `y - surfaceHeight` field would be a heightfield.
 */
export function baseDensity(x: number, y: number, z: number, seed: number): number {
  return densityFromSurface(x, y, z, columnGeology(x, z, seed).surf, seed);
}

/** Same as baseDensity, but with the per-column surface height supplied. */
export function densityFromSurface(
  x: number,
  y: number,
  z: number,
  surf: number,
  seed: number,
): number {
  return y - surf + carveAt(x, y, z, seed);
}

export interface ChunkFieldData {
  field: Float32Array;
  material: Uint8Array;
}

export function allocChunkField(): ChunkFieldData {
  const n = FIELD * FIELD * FIELD;
  return { field: new Float32Array(n), material: new Uint8Array(n) };
}

/** Scratch buffers for fillChunkField, allocated once. */
const colCache: ColumnGeology[] = [];
const colSurf = new Float32Array(FIELD * FIELD);

/**
 * Fill a chunk's padded field and material arrays from the procedural base.
 *
 * (cx, cy, cz) are integer chunk coordinates. Sample (0,0,0) of the array sits
 * at world voxel (cx*chunkCells - PAD, ...): the padding ring reaches into the
 * neighbouring chunks so boundary cells can be meshed without talking to them.
 *
 * The (x, z)-only geology is computed once per column (FIELD^2 times) and reused
 * down the column (FIELD times each), rather than recomputed per voxel.
 */
export function fillChunkField(
  out: ChunkFieldData,
  cx: number,
  cy: number,
  cz: number,
  seed: number,
  chunkCells: number,
): void {
  const { field, material } = out;
  const ox = cx * chunkCells - PAD;
  const oy = cy * chunkCells - PAD;
  const oz = cz * chunkCells - PAD;

  for (let iz = 0; iz < FIELD; iz++) {
    const wz = (oz + iz) * VOXEL;
    for (let ix = 0; ix < FIELD; ix++) {
      const wx = (ox + ix) * VOXEL;
      const k = ix + iz * FIELD;
      const col = columnGeology(wx, wz, seed);
      colCache[k] = col;
      colSurf[k] = col.surf;
    }
  }

  let i = 0;
  for (let iz = 0; iz < FIELD; iz++) {
    const wz = (oz + iz) * VOXEL;
    for (let iy = 0; iy < FIELD; iy++) {
      const wy = (oy + iy) * VOXEL;
      for (let ix = 0; ix < FIELD; ix++, i++) {
        const k = ix + iz * FIELD;
        const wx = (ox + ix) * VOXEL;
        const d = densityFromSurface(wx, wy, wz, colSurf[k]!, seed);
        field[i] = d;
        material[i] = d < 0 ? materialAtColumn(colCache[k]!, wx, wy, wz, seed) : Mat.AIR;
      }
    }
  }
}
