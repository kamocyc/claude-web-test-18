/**
 * Rock-mass behaviour: how wide an unsupported opening a given rock will hold,
 * for how long, and how much a thin roof weakens it.
 *
 * Lives on its own because more than one thing needs it. A tunnel heading, an
 * underground chamber dug free-form, and a cantilevered overhang left by an
 * excavation are the same physical question — unsupported rock spanning a void —
 * and they must not answer it differently depending on which part of the code is
 * asking. Keeping the formulas here is what makes that structural rather than a
 * convention.
 */
import { VOXEL } from '../core/config.ts';

/**
 * Least thickness of rock overhead that counts as a roof, metres.
 *
 * Deliberately tiny — two voxels. This is not a "shallow tunnel" threshold, it is
 * the distinction between having a roof and not having one. How *strong* a roof is
 * varies continuously with its thickness; see shallowCoverFactor.
 */
export const MIN_ROOF_COVER = VOXEL * 2;

/**
 * Factor applied to the supportable span for a shallow opening.
 *
 * A thin roof cannot span, however good the rock is: a metre of sandstone over a
 * six-metre opening is a slab, not an arch, because there is no room above it for
 * a pressure arch to develop. Ramps in over one span of cover (the C/D ratio that
 * tunnelling practice calls "very shallow"), so cover affects stability smoothly
 * rather than at a cliff edge.
 */
export function shallowCoverFactor(cover: number, span: number): number {
  if (span <= 0) return 1;
  const t = Math.min(1, Math.max(0, cover / span));
  return 0.3 + 0.7 * (t * t * (3 - 2 * t));
}

/**
 * Maximum unsupported span for a given rock mass rating, metres.
 *
 * Follows the shape of Bieniawski's span/stand-up-time chart: very poor rock
 * holds barely a metre, good rock holds tens of metres. Deep cover squeezes the
 * opening, so high vertical stress reduces the span.
 */
export function unsupportedSpan(rmr: number, sigmaV: number): number {
  // Calibrated against the shape of Bieniawski's chart: ~0.7 m at RMR 0,
  // ~1.5 m at 20, ~5 m at 45, ~12.5 m at 75.
  const base = 0.7 + 0.0021 * rmr * rmr;
  // Reduce for high in-situ stress; 1.0 at shallow depth, ~0.6 at 3 MPa.
  const stressFactor = 1 / (1 + sigmaV / 4500);
  return base * stressFactor;
}

/**
 * Stand-up time in seconds for an opening of `span` in rock of the given RMR.
 *
 * Infinite while the span is within the unsupported limit; falls off sharply as
 * the opening gets wider than the rock allows. Compressed relative to reality
 * (hours become tens of seconds) so that a player can watch it happen.
 */
export function standUpTime(rmr: number, span: number, allowed: number): number {
  if (span <= allowed) return Infinity;
  const over = span / allowed;
  // Good rock still gives you a while; bad rock gives you seconds.
  const base = 6 + rmr * 1.1;
  // over^1.5 rather than over^2: squaring made every soil heading bottom out on
  // the floor value, which removed the distinction between bad and very bad rock.
  return Math.max(4, base / (over * Math.sqrt(over)));
}

