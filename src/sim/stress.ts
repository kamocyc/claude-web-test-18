/**
 * Ground stress, evaluated analytically at points rather than solved on a grid.
 *
 * The design decision that makes this affordable: the ground is never treated as
 * a continuum to be solved (no FEM, no DEM). Vertical stress is the weight of
 * the column above a point, load spread from a footing uses the 2:1 method, and
 * horizontal stress is K0 times vertical. Every one of those is a handful of
 * multiplies at the point you actually care about, so there is no stress *field*
 * to store or update — only queries.
 */
import { CHUNK_M, GRAVITY, VOXEL } from '../core/config.ts';
import { materialProps, surfaceHeight } from '../terrain/geology.ts';
import type { World } from '../terrain/world.ts';

export interface OverburdenResult {
  /** Total vertical stress at the point, kPa. */
  sigmaV: number;
  /** Thickness of solid ground directly above the point, metres. */
  cover: number;
  /** Depth-weighted mean RMR of that cover, 0..100. */
  meanRmr: number;
  /** Weakest material found in the column above the point. */
  weakestMat: number;
  /**
   * True if the upward walk ran out of resident chunks before reaching daylight.
   * The reported cover is then a lower bound, not the real cover — callers that
   * make decisions from it (the tunnel sim does) must not treat a truncated
   * reading as "no ground above".
   */
  truncated: boolean;
}

/**
 * Extra height above the procedural surface that the walk still checks, to allow
 * for player-placed fill and for the 3D carve term lifting solid above the datum.
 */
const DAYLIGHT_MARGIN = 24;

/**
 * Integrate the solid column above a point.
 *
 * Walks upward one voxel at a time through the resident chunks, accumulating
 * gamma * dh for every solid sample. Because it reads the *edited* field rather
 * than the procedural base, a tunnel bored above the point correctly reduces the
 * cover, which is what makes excavation change the stress state.
 *
 * The walk stops at daylight, bounded by the local surface height rather than by
 * a run of air samples: a bored tunnel is metres of air that must *not* be
 * mistaken for the sky.
 */
export function overburdenAt(world: World, x: number, y: number, z: number, maxRise = 220): OverburdenResult {
  let sigmaV = 0;
  let cover = 0;
  let rmrSum = 0;
  let weakest = -1;
  let weakestRmr = Infinity;
  let truncated = false;
  const step = VOXEL;

  const ceiling = Math.min(
    maxRise,
    surfaceHeight(x, z, world.seed) + DAYLIGHT_MARGIN - y,
  );

  for (let h = step * 0.5; h < ceiling; h += step) {
    const yy = y + h;
    const d = world.sampleDensity(x, yy, z);
    if (d === null) {
      // Ran out of resident chunks with ground still potentially above us.
      truncated = true;
      break;
    }
    if (d >= 0) {
      // Air. Keep going: there may be rock above a bored tunnel.
      continue;
    }
    const mat = world.sampleMaterial(x, yy, z) ?? 0;
    const p = materialProps(mat);
    // gamma is a unit weight in kN/m^3, so gamma * dh is already kPa.
    sigmaV += p.gamma * step;
    cover += step;
    rmrSum += p.rmr * step;
    if (p.rmr < weakestRmr) {
      weakestRmr = p.rmr;
      weakest = mat;
    }
  }

  return {
    sigmaV,
    cover,
    meanRmr: cover > 0 ? rmrSum / cover : 0,
    weakestMat: weakest,
    truncated,
  };
}

export interface RockQuality {
  /** Lowest RMR found in the sampled ring, 0..100. */
  minRmr: number;
  /** Thickness-weighted mean RMR of the sampled ring. */
  meanRmr: number;
  /** Material corresponding to minRmr. */
  weakestMat: number;
  /** Number of solid samples taken; 0 means the opening is in open air. */
  samples: number;
}

/**
 * Rock quality of the ground immediately around an opening.
 *
 * Deliberately *local*. A tunnel's stability is governed by the rock forming its
 * crown and ring, not by whatever the weakest material in the whole overburden
 * happens to be — and since every column on this map is capped by topsoil (RMR 5),
 * using the full column made every heading at every depth report RMR ~7, so no
 * support of any kind was ever sufficient. The overburden still matters, but
 * through sigma_v and cover, not through its weakest band.
 *
 * Samples a short vertical run from just below the invert up to `reach` metres
 * above the crown, plus the springline either side.
 */
export function rockQualityAround(
  world: World,
  x: number,
  y: number,
  z: number,
  span: number,
  reach = 0,
): RockQuality {
  const r = span * 0.5;
  // Look one radius above the crown by default: that is the ground that has to
  // arch over the opening.
  const up = reach > 0 ? reach : Math.max(1.5, r);
  let minRmr = Infinity;
  let weakest = -1;
  let sum = 0;
  let n = 0;

  const probe = (px: number, py: number, pz: number): void => {
    const d = world.sampleDensity(px, py, pz);
    if (d === null || d >= 0) return; // not solid ground: nothing to rate
    const mat = world.sampleMaterial(px, py, pz);
    if (mat === null || mat === 0) return;
    const p = materialProps(mat);
    sum += p.rmr;
    n++;
    if (p.rmr < minRmr) {
      minRmr = p.rmr;
      weakest = mat;
    }
  };

  // Crown and above.
  for (let h = 0; h <= up; h += VOXEL) probe(x, y + r + h, z);
  // Springline, both sides, and the invert.
  probe(x + r + VOXEL, y, z);
  probe(x - r - VOXEL, y, z);
  probe(x, y - r - VOXEL, z);

  if (n === 0) return { minRmr: 0, meanRmr: 0, weakestMat: -1, samples: 0 };
  return { minRmr, meanRmr: sum / n, weakestMat: weakest, samples: n };
}

/**
 * Vertical stress increase at depth `z` below the centre of a rectangular
 * footing, by the 2:1 (approximate) dispersion method: the load is assumed to
 * spread uniformly over a rectangle that widens by z/2 on each side.
 *
 * Cheap and standard for preliminary design; swap in Boussinesq if the extra
 * fidelity ever matters.
 */
export function dispersion2to1(load: number, width: number, length: number, depth: number): number {
  const w = width + depth;
  const l = length + depth;
  return load / (w * l);
}

/** At-rest earth pressure coefficient, Jaky's approximation. */
export function k0FromFriction(frictionDeg: number): number {
  return Math.max(0.2, 1 - Math.sin((frictionDeg * Math.PI) / 180));
}

/** Horizontal stress at rest, kPa. */
export function sigmaHAt(sigmaV: number, frictionDeg: number): number {
  return sigmaV * k0FromFriction(frictionDeg);
}

/** Mass of a solid voxel of the given material, kg. Used for debris. */
export function voxelMass(mat: number): number {
  // gamma [kN/m^3] / g [m/s^2] * 1000 => kg/m^3
  const density = (materialProps(mat).gamma * 1000) / GRAVITY;
  return density * VOXEL * VOXEL * VOXEL;
}

/** Chunk-aligned world position helper, kept here so callers avoid CHUNK_M. */
export function chunkCoordOf(v: number): number {
  return Math.floor(v / CHUNK_M);
}
