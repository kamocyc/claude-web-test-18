/**
 * Tunnel support: unsupported span, stand-up time, and roof collapse.
 *
 * This is the mechanic the whole geology system exists to serve. Real tunnelling
 * practice gives us two numbers straight out of rock-mass classification, and
 * both are directly playable:
 *
 *   unsupported span  — how wide an opening this rock will hold with no support
 *   stand-up time     — how long it will hold it before failing
 *
 * Bore a heading wider than the span the rock allows and a clock starts. Install
 * support (shotcrete / rock bolts / a concrete lining) before it runs out and the
 * heading is permanently safe. Miss it and the roof falls in — and if the cover
 * is thin, the failure propagates to the surface as a sinkhole that takes the
 * road above with it.
 *
 * Because collapse is expressed as CSG brushes, it reuses the entire editing and
 * save path; there is no separate "destroyed terrain" representation.
 */
import { SIM_TICK_SECONDS } from '../core/config.ts';
import { makeBrush, type Brush } from '../terrain/brush.ts';
import { overburdenAt, rockQualityAround } from './stress.ts';
import type { World } from '../terrain/world.ts';

/** Progressive states a heading moves through, so failure is never a surprise. */
export const HeadingState = {
  /** Span is within what the rock supports unaided. */
  STABLE: 'stable',
  /** Over span; deterioration clock running. Hairline cracking shown. */
  CRACKING: 'cracking',
  /** Past ~60% of stand-up time. Visible convergence, audible warning. */
  CONVERGING: 'converging',
  /** Past ~85%. Final warning. */
  CRITICAL: 'critical',
  /** Roof has fallen. */
  COLLAPSED: 'collapsed',
  /** Support installed; permanently safe. */
  SUPPORTED: 'supported',
} as const;

export type HeadingStateValue = (typeof HeadingState)[keyof typeof HeadingState];

export const SupportKind = {
  NONE: 'none',
  SHOTCRETE: 'shotcrete',
  ROCKBOLTS: 'rockbolts',
  LINING: 'lining',
} as const;

export type SupportKindValue = (typeof SupportKind)[keyof typeof SupportKind];

/** How much extra span each support type buys, as a multiplier. */
const SUPPORT_SPAN_FACTOR: Record<string, number> = {
  [SupportKind.NONE]: 1,
  [SupportKind.SHOTCRETE]: 1.6,
  [SupportKind.ROCKBOLTS]: 2.3,
  [SupportKind.LINING]: 6,
};

/** One excavated cross-section along a tunnel drive. */
export interface Heading {
  id: number;
  /** Centre of the excavated section, world metres. */
  center: [number, number, number];
  /** Excavated span (full width), metres. */
  span: number;
  /** Support installed here. */
  support: SupportKindValue;
  state: HeadingStateValue;
  /** Seconds of deterioration accumulated. */
  elapsed: number;
  /** Cached ground assessment, refreshed on the sim tick. */
  rmr: number;
  cover: number;
  sigmaV: number;
  /** Span this ground supports unaided, metres. */
  allowedSpan: number;
  /** Stand-up time for the current span, seconds. Infinity when stable. */
  standUpTime: number;
  weakestMat: number;
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

export interface TunnelEvent {
  kind: 'state' | 'collapse' | 'sinkhole';
  heading: Heading;
  message: string;
}

export class TunnelSim {
  private headings = new Map<number, Heading>();
  private nextId = 1;
  private accumulator = 0;
  /** Emitted brushes waiting to be applied by the caller. */
  private pendingBrushes: Brush[] = [];
  private events: TunnelEvent[] = [];

  /**
   * Register a newly excavated heading. Call this right after applying the bore
   * brush, so the assessment sees the opening that was just made.
   */
  addHeading(world: World, center: [number, number, number], span: number): Heading {
    const h: Heading = {
      id: this.nextId++,
      center,
      span,
      support: SupportKind.NONE,
      state: HeadingState.STABLE,
      elapsed: 0,
      rmr: 0,
      cover: 0,
      sigmaV: 0,
      allowedSpan: 0,
      standUpTime: Infinity,
      weakestMat: 0,
    };
    this.assess(world, h);
    // Classify straight away. Leaving a fresh heading as STABLE until the first
    // tick made a doomed excavation read as safe for up to half a second, which
    // is exactly the kind of "the UI said it was fine" gap that makes a collapse
    // look like a bug.
    this.classify(h);
    this.headings.set(h.id, h);
    return h;
  }

  /** Apply classifyState to a heading, leaving terminal states alone. */
  private classify(h: Heading): void {
    if (h.state === HeadingState.COLLAPSED || h.state === HeadingState.SUPPORTED) return;
    const next = classifyState(h);
    if (next === HeadingState.STABLE) h.elapsed = 0;
    h.state = next;
  }

  /** Install support at a heading, making it permanently safe if strong enough. */
  installSupport(world: World, id: number, kind: SupportKindValue): boolean {
    const h = this.headings.get(id);
    if (!h || h.state === HeadingState.COLLAPSED) return false;
    h.support = kind;
    this.assess(world, h);
    if (h.span <= h.allowedSpan) {
      h.state = HeadingState.SUPPORTED;
      h.elapsed = 0;
      h.standUpTime = Infinity;
    } else {
      // Support that is not enough for the span buys time but does not make the
      // heading safe: keep the accumulated deterioration and re-classify.
      this.classify(h);
    }
    return true;
  }

  /** Support strong enough for a heading, or null if even a lining will not do. */
  requiredSupport(h: Heading): SupportKindValue | null {
    const bare = h.allowedSpan / SUPPORT_SPAN_FACTOR[h.support]!;
    for (const k of [SupportKind.NONE, SupportKind.SHOTCRETE, SupportKind.ROCKBOLTS, SupportKind.LINING]) {
      if (h.span <= bare * SUPPORT_SPAN_FACTOR[k]!) return k;
    }
    return null;
  }

  /**
   * Re-read the ground at a heading and recompute its span and clock.
   *
   * Two separate readings, because they answer different questions:
   *   - the overburden column gives cover and sigma_v (how hard the ground is
   *     squeezing), integrated all the way to daylight;
   *   - the local ring around the opening gives RMR (how good the rock that has
   *     to arch over the hole is).
   * Mixing them up — rating the tunnel by the weakest material anywhere in the
   * column — makes every heading on a soil-capped map unsupportable.
   */
  private assess(world: World, h: Heading): void {
    const crown = h.center[1] + h.span * 0.5;
    const ob = overburdenAt(world, h.center[0], crown, h.center[2]);
    const rq = rockQualityAround(world, h.center[0], h.center[1], h.center[2], h.span);

    // Weight the weakest sample against the mean: a metre of fault gouge in the
    // crown matters more than the average, but should not count for everything.
    h.rmr = rq.samples > 0 ? Math.min(rq.meanRmr, rq.minRmr * 1.4) : 0;
    h.cover = ob.cover;
    h.sigmaV = ob.sigmaV;
    h.weakestMat = rq.weakestMat >= 0 ? rq.weakestMat : ob.weakestMat;
    h.allowedSpan = unsupportedSpan(h.rmr, ob.sigmaV) * SUPPORT_SPAN_FACTOR[h.support]!;
    h.standUpTime = standUpTime(h.rmr, h.span, h.allowedSpan);
  }

  /**
   * Advance the simulation. Only does real work every SIM_TICK_SECONDS: the
   * design explicitly avoids running this per frame, and the number of evaluated
   * points is bounded by the number of headings the player has actually dug.
   */
  update(world: World, dt: number): void {
    this.accumulator += dt;
    if (this.accumulator < SIM_TICK_SECONDS) return;
    const step = this.accumulator;
    this.accumulator = 0;

    for (const h of this.headings.values()) {
      if (h.state === HeadingState.COLLAPSED || h.state === HeadingState.SUPPORTED) continue;
      this.assess(world, h);

      if (h.span <= h.allowedSpan) {
        if (h.state !== HeadingState.STABLE) {
          h.state = HeadingState.STABLE;
          h.elapsed = 0;
          this.events.push({ kind: 'state', heading: h, message: '安定' });
        }
        continue;
      }

      h.elapsed += step;
      const next = classifyState(h);
      if (next !== h.state) {
        h.state = next;
        if (next !== HeadingState.COLLAPSED) {
          this.events.push({
            kind: 'state',
            heading: h,
            message: `${stateLabel(next)} — 残り ${Math.max(0, h.standUpTime - h.elapsed).toFixed(0)} s`,
          });
        }
      }

      if (h.state === HeadingState.COLLAPSED) this.collapse(h);
    }
  }

  /**
   * Turn a failed heading into terrain change.
   *
   * The roof falls as a cone above the opening, and the debris is piled back on
   * the floor as a smaller sphere of loose fill — mass is not conserved exactly,
   * but the visual reads correctly: you lose the opening and gain a rubble pile.
   * If the cone reaches daylight, a surface sinkhole is added too.
   */
  private collapse(h: Heading): void {
    const radius = h.span * 0.62;
    // A weaker rock mass collapses further up before it arches over.
    const height = Math.min(h.cover + 2, h.span * (1.4 + (60 - Math.min(60, h.rmr)) * 0.045));
    const apex: [number, number, number] = [h.center[0], h.center[1] - h.span * 0.35, h.center[2]];
    this.pendingBrushes.push(makeBrush.roofFall(apex, height, radius));
    // Rubble on the invert.
    this.pendingBrushes.push(
      makeBrush.fill([h.center[0], h.center[1] - h.span * 0.42, h.center[2]], h.span * 0.42),
    );

    const brokeSurface = height >= h.cover;
    this.events.push({
      kind: brokeSurface ? 'sinkhole' : 'collapse',
      heading: h,
      message: brokeSurface
        ? `天端崩落が地表に到達 — 陥没 (土被り ${h.cover.toFixed(1)} m)`
        : `天端崩落 (RMR ${h.rmr.toFixed(0)}, 支保なしスパン ${h.allowedSpan.toFixed(1)} m < 掘削 ${h.span.toFixed(1)} m)`,
    });

    if (brokeSurface) {
      // Break through to daylight: a bowl at the surface, centred over the hole.
      const surfaceY = h.center[1] + h.cover;
      this.pendingBrushes.push(
        makeBrush.settle([h.center[0], surfaceY, h.center[2]], radius * 2.1, Math.min(6, h.cover * 0.5)),
      );
    }
  }

  /** Take the brushes produced by collapses since the last call. */
  drainBrushes(): Brush[] {
    const out = this.pendingBrushes;
    this.pendingBrushes = [];
    return out;
  }

  /** Take the events produced since the last call. */
  drainEvents(): TunnelEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  all(): Heading[] {
    return [...this.headings.values()];
  }

  get(id: number): Heading | undefined {
    return this.headings.get(id);
  }

  /** The heading nearest a world point within `maxDist`, or null. */
  nearest(x: number, y: number, z: number, maxDist = 12): Heading | null {
    let best: Heading | null = null;
    let bestD2 = maxDist * maxDist;
    for (const h of this.headings.values()) {
      const dx = h.center[0] - x;
      const dy = h.center[1] - y;
      const dz = h.center[2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = h;
      }
    }
    return best;
  }

  clear(): void {
    this.headings.clear();
    this.pendingBrushes = [];
    this.events = [];
  }
}

/**
 * The state a heading should be in, from its span, allowed span and how much
 * deterioration it has accumulated. Pure, so it is the single definition of the
 * progression used by excavation, support installation and the timed tick alike.
 */
export function classifyState(h: Heading): HeadingStateValue {
  if (h.span <= h.allowedSpan) return HeadingState.STABLE;
  const frac = h.standUpTime === Infinity ? 0 : h.elapsed / h.standUpTime;
  if (frac >= 1) return HeadingState.COLLAPSED;
  if (frac >= 0.85) return HeadingState.CRITICAL;
  if (frac >= 0.6) return HeadingState.CONVERGING;
  return HeadingState.CRACKING;
}

export function stateLabel(s: HeadingStateValue): string {
  switch (s) {
    case HeadingState.STABLE: return '安定';
    case HeadingState.CRACKING: return 'ひび割れ';
    case HeadingState.CONVERGING: return '内空変位';
    case HeadingState.CRITICAL: return '崩落間近';
    case HeadingState.COLLAPSED: return '崩落';
    case HeadingState.SUPPORTED: return '支保済';
  }
}

export function supportLabel(s: SupportKindValue): string {
  switch (s) {
    case SupportKind.NONE: return '無支保';
    case SupportKind.SHOTCRETE: return '吹付けコンクリート';
    case SupportKind.ROCKBOLTS: return 'ロックボルト';
    case SupportKind.LINING: return '覆工';
  }
}
