/**
 * Stratified geology model plus the material property table.
 *
 * Layers are horizontal bands whose *bedrock* datum is warped by low-frequency
 * noise and displaced by a fault, and which are locally overridden by granite
 * intrusion blobs. Nothing is stored; everything is evaluated from (x, y, z).
 *
 * Two design points worth knowing:
 *
 *  - The warp is depth-attenuated. An unattenuated warp of +/-20 m completely
 *    swamps the thin near-surface layers (topsoil is 1.2 m thick), which makes
 *    the material you actually see when you dig essentially random. Here the
 *    warp ramps in below WARP_FADE_START so the soil mantle stays a mantle
 *    while the bedrock beneath it undulates.
 *  - The undulation is a function of (x, z) only, not (x, y, z). Strata *are*
 *    surfaces, so this is both more faithful and dramatically cheaper: the
 *    whole term hoists out of the vertical loop. See columnGeology().
 *
 * Determinism: only helpers from core/hash.ts and exactly-specified Math
 * functions. See the note at the top of core/hash.ts.
 */
import { fbm3s, ridge3, valueNoise3 } from '../core/hash.ts';

/** Material ids. A plain const object rather than an enum, so that Node's
 *  type-stripping loader can run this file directly in tests. */
export const Mat = {
  AIR: 0,
  TOPSOIL: 1,
  SAND: 2,
  CLAY: 3,
  GRAVEL: 4,
  SANDSTONE: 5,
  LIMESTONE: 6,
  GRANITE: 7,
  /** Fault gouge: weak, crushed rock in the fault damage zone. */
  FAULT_GOUGE: 8,
  /** Player-placed fill (embankment). */
  FILL: 9,
  /** Player-placed concrete (tunnel lining, road bed). */
  CONCRETE: 10,
  /**
   * Collapsed rock. Kept distinct from FILL: it is what a roof fall leaves
   * behind, it carries almost no bearing capacity, and you cannot drive a new
   * heading through it without support.
   */
  RUBBLE: 11,
} as const;

export type MaterialId = (typeof Mat)[keyof typeof Mat];

export interface MaterialProps {
  name: string;
  /** Bulk unit weight, kN/m^3 (used directly as gamma for stress). */
  gamma: number;
  /** Effective cohesion c', kPa. */
  cohesion: number;
  /** Effective friction angle phi', degrees. */
  friction: number;
  /** Unconfined compressive strength, MPa. 0 for soils. */
  ucs: number;
  /** Rock Mass Rating equivalent, 0..100. Soils sit near the bottom. */
  rmr: number;
  /** Hydraulic conductivity, m/s. Carried but unused in this slice. */
  permeability: number;
  /**
   * Bulking factor: the volume broken rock occupies relative to the intact rock
   * it came from. Always > 1, which is the whole reason a collapse arrests —
   * the debris takes up more room than the void it fell out of, so a chimney
   * eventually chokes on its own rubble. Blocky rock bulks most (angular
   * fragments lock together); soil bulks least, so it chimneys much further,
   * which is exactly why sinkholes form over shallow workings in soft ground.
   */
  bulking: number;
  /** Base colour, sRGB triples in 0..1. */
  color: readonly [number, number, number];
}

export const MATERIALS: Record<number, MaterialProps> = {
  [Mat.AIR]: { name: 'Air', gamma: 0, cohesion: 0, friction: 0, ucs: 0, rmr: 0, permeability: 0, bulking: 1, color: [0, 0, 0] },
  [Mat.TOPSOIL]: { name: '表土', gamma: 16, cohesion: 5, friction: 27, ucs: 0, rmr: 5, permeability: 1e-5, bulking: 1.15, color: [0.30, 0.40, 0.17] },
  [Mat.SAND]: { name: '砂', gamma: 18, cohesion: 0, friction: 33, ucs: 0, rmr: 8, permeability: 1e-4, bulking: 1.15, color: [0.80, 0.70, 0.45] },
  [Mat.CLAY]: { name: '粘土', gamma: 17, cohesion: 40, friction: 20, ucs: 0, rmr: 12, permeability: 1e-9, bulking: 1.25, color: [0.46, 0.34, 0.28] },
  [Mat.GRAVEL]: { name: '礫', gamma: 20, cohesion: 0, friction: 38, ucs: 0, rmr: 15, permeability: 1e-2, bulking: 1.2, color: [0.56, 0.53, 0.48] },
  [Mat.SANDSTONE]: { name: '砂岩', gamma: 23, cohesion: 300, friction: 40, ucs: 55, rmr: 55, permeability: 1e-7, bulking: 1.4, color: [0.68, 0.57, 0.41] },
  [Mat.LIMESTONE]: { name: '石灰岩', gamma: 24, cohesion: 500, friction: 38, ucs: 85, rmr: 65, permeability: 1e-6, bulking: 1.42, color: [0.74, 0.74, 0.67] },
  [Mat.GRANITE]: { name: '花崗岩', gamma: 26, cohesion: 1500, friction: 50, ucs: 160, rmr: 82, permeability: 1e-10, bulking: 1.5, color: [0.58, 0.53, 0.57] },
  [Mat.FAULT_GOUGE]: { name: '断層粘土', gamma: 19, cohesion: 15, friction: 18, ucs: 2, rmr: 18, permeability: 1e-6, bulking: 1.2, color: [0.26, 0.22, 0.26] },
  [Mat.FILL]: { name: '盛土', gamma: 19, cohesion: 8, friction: 30, ucs: 0, rmr: 6, permeability: 1e-5, bulking: 1.1, color: [0.52, 0.41, 0.28] },
  [Mat.CONCRETE]: { name: 'コンクリート', gamma: 24, cohesion: 4000, friction: 45, ucs: 35, rmr: 95, permeability: 1e-11, bulking: 1.45, color: [0.82, 0.82, 0.84] },
  // Loose, uncompacted, poorly graded collapse debris: the weakest thing on the
  // map. In reality its governing problem is enormous settlement rather than
  // shear failure, which this model has no term for, so the compressibility is
  // approximated by a low friction angle — enough to make the point that you
  // cannot found on a collapse. bulking is 1: already-broken rock does not bulk
  // again if it falls a second time.
  [Mat.RUBBLE]: { name: '崩落土', gamma: 16, cohesion: 0, friction: 24, ucs: 0, rmr: 4, permeability: 1e-3, bulking: 1.0, color: [0.34, 0.30, 0.27] },
};

export function materialProps(id: number): MaterialProps {
  return MATERIALS[id] ?? MATERIALS[Mat.SAND]!;
}

/**
 * Height a chimney can rise before its own bulked debris chokes it, given the
 * height of the opening it started from.
 *
 *   removed = A*h,  debris = B*A*h,  space = A*(Ht + h)
 *   choke when B*A*h = A*(Ht + h)  =>  h = Ht / (B - 1)
 *
 * Infinite for material that does not bulk (already-broken rubble): such a
 * collapse never chokes itself and is arrested only by arching or by daylight.
 */
export function chokeHeight(mat: number, openingHeight: number): number {
  const b = materialProps(mat).bulking;
  if (b <= 1.0001) return Infinity;
  return openingHeight / (b - 1);
}

/** One stratum: everything from `depth` metres downward until the next. */
interface Stratum {
  /** Depth below the (warped) datum at which this stratum starts, m. */
  depth: number;
  mat: number;
}

/** Ordered shallow-to-deep. The last entry extends to infinity. */
const COLUMN: readonly Stratum[] = [
  { depth: 0, mat: Mat.TOPSOIL },
  { depth: 1.2, mat: Mat.SAND },
  { depth: 5, mat: Mat.CLAY },
  { depth: 11, mat: Mat.GRAVEL },
  { depth: 15, mat: Mat.SANDSTONE },
  { depth: 30, mat: Mat.LIMESTONE },
  { depth: 52, mat: Mat.GRANITE },
];

/** Depth below which the strata warp starts to ramp in, and where it saturates. */
const WARP_FADE_START = 5;
const WARP_FADE_END = 16;

/**
 * Amplitude of the 3D term that lets the terrain be more than a heightfield.
 * Lives here rather than in density.ts because the stratigraphy needs it too:
 * see `trueSurf` in ColumnGeology.
 */
export const CARVE_AMP = 4.2;

/**
 * The 3D perturbation applied to the base density.
 *
 * This is what makes overhangs and natural caves possible; a pure
 * `y - surfaceHeight` field would be a heightfield and could never have them,
 * which is the whole reason this project is voxel-based.
 */
export function carveAt(x: number, y: number, z: number, seed: number): number {
  return fbm3s(x * 0.028, y * 0.035, z * 0.028, seed + 631, 3) * CARVE_AMP;
}

/** Terrain surface height in metres at (x, z). Drives the base density. */
export function surfaceHeight(x: number, z: number, seed: number): number {
  const hills = fbm3s(x * 0.0045, 0, z * 0.0045, seed, 4) * 34;
  const ridges = (ridge3(x * 0.017, 0, z * 0.017, seed + 101, 3) - 0.5) * 13;
  const detail = fbm3s(x * 0.06, 0, z * 0.06, seed + 202, 2) * 1.6;
  return 26 + hills + ridges + detail;
}

/** Signed distance to the fault plane, metres (positive on the up-thrown side). */
export function faultDistance(x: number, z: number, seed: number): number {
  // A gently wavy near-vertical fault striking roughly NE.
  const wobble = fbm3s(x * 0.004, 0, z * 0.004, seed + 421, 2) * 26;
  return 0.6 * x + 0.8 * z - 40 + wobble;
}

/** Vertical throw across the fault, metres, smoothed over a damage zone. */
export function faultThrow(x: number, z: number, seed: number): number {
  const d = faultDistance(x, z, seed);
  const t = Math.max(-1, Math.min(1, d / 14));
  const a = Math.abs(t);
  return (a * a * (3 - 2 * a)) * (t < 0 ? -1 : 1) * 11;
}

/** Half-width of the crushed-rock fault damage zone, metres. */
const GOUGE_HALF_WIDTH = 3.2;

/** True inside the crushed rock of the fault damage zone. */
export function inFaultGouge(x: number, z: number, seed: number): boolean {
  return Math.abs(faultDistance(x, z, seed)) < GOUGE_HALF_WIDTH;
}

/** True inside a granite intrusion blob. */
export function inGraniteIntrusion(x: number, y: number, z: number, seed: number): boolean {
  const n = valueNoise3(x * 0.011, y * 0.014, z * 0.011, seed + 977);
  // Bias the threshold with depth so intrusions widen downward.
  const bias = 0.62 - Math.max(0, -y) * 0.0035;
  return n > bias;
}

/**
 * Everything about the geology at (x, z) that does not depend on y.
 *
 * Computing this once per column and reusing it down the column is the single
 * biggest win in chunk generation: it removes ~4 noise evaluations per solid
 * voxel (there are tens of thousands per chunk).
 */
export interface ColumnGeology {
  /** Noise datum for the surface, m. The density field is measured from this. */
  surf: number;
  /**
   * Height of the actual ground surface, m — i.e. where the density field crosses
   * zero, which the carve term moves up to CARVE_AMP away from `surf`.
   *
   * Stratigraphic depth must be measured from *this*, not from `surf`. Using
   * `surf` meant that wherever the carve term pushed the real surface more than
   * 1.2 m down, the 1.2 m-thick topsoil layer had already been cut through and
   * the exposed material was sand — which showed up as sand speckled all over
   * the hillsides in a dashed, obviously-wrong pattern.
   *
   * One fixed-point iteration is plenty: the carve term varies slowly enough over
   * a few metres that a second pass moves the answer by centimetres.
   */
  trueSurf: number;
  /** Vertical warp applied to the bedrock strata datum, m. */
  datum: number;
  /** Inside the fault damage zone. */
  gouge: boolean;
}

export function columnGeology(x: number, z: number, seed: number): ColumnGeology {
  const undulation = fbm3s(x * 0.0075, 0, z * 0.0075, seed + 313, 3) * 9;
  const fd = faultDistance(x, z, seed);
  const t = Math.max(-1, Math.min(1, fd / 14));
  const a = Math.abs(t);
  const thr = (a * a * (3 - 2 * a)) * (t < 0 ? -1 : 1) * 11;
  const surf = surfaceHeight(x, z, seed);
  return {
    surf,
    trueSurf: surf - carveAt(x, surf, z, seed),
    datum: undulation + thr,
    gouge: Math.abs(fd) < GOUGE_HALF_WIDTH,
  };
}

/** Effective stratigraphic depth, i.e. depth with the warp ramped in. */
export function effectiveDepth(col: ColumnGeology, y: number): number {
  const depth = col.trueSurf - y;
  if (depth <= WARP_FADE_START) return depth;
  const t = Math.min(1, (depth - WARP_FADE_START) / (WARP_FADE_END - WARP_FADE_START));
  return depth + col.datum * t * t * (3 - 2 * t);
}

/**
 * Material at a point, given the column data.
 *
 * Answers "what material *would* be here", never AIR: whether a point is solid
 * is the density field's business, not the stratigraphy's. The two disagree by
 * design — the 3D carve term in density.ts puts solid rock slightly above the
 * stratigraphic datum and cuts caves below it — so a point above the datum is
 * reported as the top of the column rather than as air. Returning AIR here left
 * genuinely solid voxels with no material, which showed up as untextured
 * vertices along ridge lines.
 */
export function materialAtColumn(
  col: ColumnGeology,
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const depth = Math.max(0, col.trueSurf - y);
  // Shallow soil mantle: unwarped, and cheap (no blob/fault lookups).
  if (depth < COLUMN[1]!.depth) return Mat.TOPSOIL;
  if (depth < COLUMN[2]!.depth) return Mat.SAND;

  const de = effectiveDepth(col, y);
  if (de > 6 && inGraniteIntrusion(x, y, z, seed)) return Mat.GRANITE;
  if (col.gouge) return Mat.FAULT_GOUGE;

  let mat = COLUMN[0]!.mat;
  for (let i = 0; i < COLUMN.length; i++) {
    if (de >= COLUMN[i]!.depth) mat = COLUMN[i]!.mat;
    else break;
  }
  return mat;
}

/** Material at a world point. Convenience wrapper around materialAtColumn. */
export function materialAt(x: number, y: number, z: number, seed: number): number {
  return materialAtColumn(columnGeology(x, z, seed), x, y, z, seed);
}

/** RMR at a point, given the column data. Softened near surface by weathering. */
export function rmrAtColumn(
  col: ColumnGeology,
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const base = materialProps(materialAtColumn(col, x, y, z, seed)).rmr;
  const depth = Math.max(0, col.trueSurf - y);
  // Weathering knocks the rating down within the top ~12 m.
  const weather = depth < 12 ? 0.45 + 0.55 * (depth / 12) : 1;
  const jointing = 0.9 + 0.2 * valueNoise3(x * 0.03, y * 0.03, z * 0.03, seed + 555);
  return Math.max(3, Math.min(100, base * weather * jointing));
}

/** RMR at a world point. */
export function rmrAt(x: number, y: number, z: number, seed: number): number {
  return rmrAtColumn(columnGeology(x, z, seed), x, y, z, seed);
}
