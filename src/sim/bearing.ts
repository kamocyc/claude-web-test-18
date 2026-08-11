/**
 * Bearing capacity and settlement, using the classical Terzaghi form.
 *
 * The gameplay point of this module is not the exact number, it is that the
 * player can be shown "allowable 200 kN/m^2, applied 340 kN/m^2" before anything
 * collapses. A foundation that exceeds capacity does not explode; it *settles*,
 * slowly and by an amount that depends on how badly it is overloaded, which is
 * what turns a ground failure into a legible chain of events.
 *
 * These use tan/exp, which is fine: unlike the terrain density function, nothing
 * here has to be bit-reproducible across engines — the results are transient
 * gameplay state, never a save-file input.
 */
import { materialProps } from '../terrain/geology.ts';

export interface BearingCapacity {
  /** Ultimate bearing capacity q_ult, kPa. */
  ultimate: number;
  /** Allowable capacity with the safety factor applied, kPa. */
  allowable: number;
  /** Terzaghi factors, exposed for the HUD. */
  nc: number;
  nq: number;
  ngamma: number;
}

export const DEFAULT_SAFETY_FACTOR = 3;

/**
 * Terzaghi bearing capacity for a strip/square footing of width B founded at
 * depth D in a material with cohesion c and friction angle phi.
 */
export function bearingCapacity(
  cohesion: number,
  frictionDeg: number,
  gamma: number,
  width: number,
  depth: number,
  safetyFactor = DEFAULT_SAFETY_FACTOR,
): BearingCapacity {
  const phi = (frictionDeg * Math.PI) / 180;
  const tanPhi = Math.tan(phi);
  // Reissner / Prandtl form for Nq, then Nc and N-gamma from it.
  const nq = Math.exp(Math.PI * tanPhi) * Math.pow(Math.tan(Math.PI / 4 + phi / 2), 2);
  const nc = frictionDeg < 0.1 ? 5.14 : (nq - 1) / tanPhi;
  const ngamma = 2 * (nq + 1) * tanPhi;
  const ultimate = cohesion * nc + gamma * depth * nq + 0.5 * gamma * width * ngamma;
  return { ultimate, allowable: ultimate / safetyFactor, nc, nq, ngamma };
}

/** Bearing capacity of a named material, for a footing of the given geometry. */
export function bearingCapacityOfMaterial(
  mat: number,
  width: number,
  depth: number,
  safetyFactor = DEFAULT_SAFETY_FACTOR,
): BearingCapacity {
  const p = materialProps(mat);
  return bearingCapacity(p.cohesion, p.friction, p.gamma, width, depth, safetyFactor);
}

/**
 * Utilisation of a footing: applied pressure over allowable.
 * < 1 is safe, > 1 will settle.
 */
export function utilisation(appliedKpa: number, cap: BearingCapacity): number {
  return cap.allowable > 0 ? appliedKpa / cap.allowable : Infinity;
}

/**
 * Settlement rate for an overloaded footing, metres per second.
 *
 * Deliberately slow and progressive. Consolidation genuinely takes time, so the
 * physically honest choice is also the readable one: the player gets tens of
 * seconds of tilt and warnings before anything falls over.
 */
export function settlementRate(util: number, width: number): number {
  if (util <= 1) return 0;
  const excess = util - 1;
  // Scaled by footing width so big foundations sink slower for the same ratio.
  return Math.min(0.25, 0.006 * excess * excess + 0.004 * excess) / Math.max(0.5, width / 2);
}

/**
 * Colour ramp for the utilisation heatmap: green (safe) to red (overloaded).
 * Returned as an sRGB triple in 0..1.
 */
export function utilisationColor(util: number): [number, number, number] {
  const u = Math.max(0, Math.min(1.5, util)) / 1.5;
  if (u < 0.5) {
    const t = u / 0.5;
    return [0.15 + 0.75 * t, 0.75, 0.2];
  }
  const t = (u - 0.5) / 0.5;
  return [0.9, 0.75 - 0.65 * t, 0.2 - 0.15 * t];
}
