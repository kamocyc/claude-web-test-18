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
import { chokeHeight, Mat, materialProps } from '../terrain/geology.ts';
import { MIN_ROOF_COVER, shallowCoverFactor, standUpTime, unsupportedSpan } from './rockmass.ts';

// Re-exported so existing callers and tests keep one import site for the tunnel
// mechanic even though the formulas now live in rockmass.ts.
export { MIN_ROOF_COVER, shallowCoverFactor, standUpTime, unsupportedSpan };
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
  /**
   * There is no rock overhead — this is a cutting, not a tunnel.
   *
   * Without this, boring along the ground surface produced a "tunnel" whose crown
   * was several metres in the air with 0.00 m of cover, and the sim dutifully
   * started a four-second stand-up clock and dropped a roof that did not exist.
   * An open cut is governed by the stability of its cut faces (slope failure),
   * which this prototype does not model, so the trench simply stays open.
   */
  OPEN_CUT: 'open_cut',
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
  /** True when there is real rock overhead; false makes this an open cut. */
  hasRoof: boolean;
  /** Span this ground supports unaided, metres. */
  allowedSpan: number;
  /** Stand-up time for the current span, seconds. Infinity when stable. */
  standUpTime: number;
  weakestMat: number;
}

/** What one roof fall did, in volumes. */
export interface CollapseReport {
  id: number;
  /** Intact rock removed from the chimney, m^3. */
  removedVolume: number;
  /** Volume that rock occupies once broken, m^3 (removedVolume * bulking). */
  debrisVolume: number;
  /** Height the debris reaches above the invert, m. */
  fillHeight: number;
  /** Void left over after the debris has settled, m^3. */
  residualVoid: number;
  /** How far the fall propagated above the crown, m. */
  height: number;
  /** Depth of the surface crater, m. Zero unless the fall reached daylight. */
  craterDepth: number;
  arrestedBy: 'arching' | 'choking' | 'daylight';
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
   * Volume accounting for the most recent collapse, so tests and the bench can
   * assert that mass is conserved rather than inferring it from the geometry.
   */
  lastCollapse: CollapseReport | null = null;

  /**
   * Register a newly excavated heading. Call this right after applying the bore
   * brush, so the assessment sees the opening that was just made.
   */
  addHeading(world: World, center: [number, number, number], span: number): Heading {
    const h = this.makeHeading(world, center, span);
    this.headings.set(h.id, h);
    return h;
  }

  /**
   * Register an excavation as an opening only if it actually left rock overhead.
   *
   * This is what makes the free-form dig tool obey the same physics as the tunnel
   * tool: any excavation with a roof is an opening and is judged by unsupported
   * span and stand-up time, whichever button produced it. Surface earthworks (a
   * cut or an embankment) have no roof and are not registered, so they neither
   * collapse nor clutter the HUD.
   *
   * Repeated digging in one place updates the existing opening rather than piling
   * up near-duplicates.
   */
  addOpening(world: World, center: [number, number, number], span: number): Heading | null {
    const probe = this.makeHeading(world, center, span, /* consumeId */ false);
    if (!probe.hasRoof) return null;

    const existing = this.nearest(center[0], center[1], center[2], Math.max(2, span * 0.6));
    if (existing && existing.state !== HeadingState.COLLAPSED) {
      // Widen, never narrow: the opening is the union of what has been dug.
      existing.span = Math.max(existing.span, span);
      existing.center = center;
      this.assess(world, existing);
      this.classify(existing);
      return existing;
    }

    const h = this.makeHeading(world, center, span);
    this.headings.set(h.id, h);
    return h;
  }

  private makeHeading(
    world: World,
    center: [number, number, number],
    span: number,
    consumeId = true,
  ): Heading {
    const h: Heading = {
      id: consumeId ? this.nextId++ : -1,
      center,
      span,
      support: SupportKind.NONE,
      state: HeadingState.STABLE,
      elapsed: 0,
      rmr: 0,
      cover: 0,
      sigmaV: 0,
      hasRoof: false,
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
    if (!h.hasRoof) {
      // Nothing to support: there is no roof. Leave it as a cut.
      this.classify(h);
      return true;
    }
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
    h.hasRoof = ob.cover >= MIN_ROOF_COVER;
    h.weakestMat = rq.weakestMat >= 0 ? rq.weakestMat : ob.weakestMat;
    h.allowedSpan =
      unsupportedSpan(h.rmr, ob.sigmaV) *
      shallowCoverFactor(ob.cover, h.span) *
      SUPPORT_SPAN_FACTOR[h.support]!;
    h.standUpTime = h.hasRoof ? standUpTime(h.rmr, h.span, h.allowedSpan) : Infinity;
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

      // An opening can become a cut (the roof was dug away) or stop being one
      // (the player filled over it), so this is re-decided every tick.
      if (!h.hasRoof) {
        if (h.state !== HeadingState.OPEN_CUT) {
          h.state = HeadingState.OPEN_CUT;
          h.elapsed = 0;
          this.events.push({ kind: 'state', heading: h, message: '開削（切土）— 天端崩落なし' });
        }
        continue;
      }

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
   * Height a roof fall rises before the rock mass arches over it, metres.
   *
   * Weak, heavily jointed ground barely arches and chimneys a long way; competent
   * rock forms a stable arch within one or two spans.
   */
  private archHeight(h: Heading): number {
    return h.span * (1.4 + (60 - Math.min(60, h.rmr)) * 0.045);
  }

  /**
   * Turn a failed heading into terrain change, conserving mass.
   *
   * Modelled as a vertical chimney of constant cross-section, which is both the
   * realistic shape of a roof fall and the one that makes the volume arithmetic
   * exact. Three things can arrest it, and whichever comes first wins:
   *
   *   arching  — the rock mass bridges over the hole (archHeight)
   *   choking  — the fall buries itself in its own bulked debris (chokeHeight)
   *   daylight — it reaches the surface, and the result is a sinkhole
   *
   * The debris volume is the removed volume times the material's bulking factor,
   * and it is put back as RUBBLE filling the void from the invert upward. Without
   * this the old implementation removed ~880 m3 and returned ~135 m3 of effective
   * rubble for a 9 m heading — 85% of the rock simply vanished, which is why
   * collapses left enormous open caverns instead of burying the tunnel.
   */
  private collapse(h: Heading): void {
    // Chimney cross-section: the opening's own footprint.
    const radius = h.span * 0.5;
    const area = Math.PI * radius * radius;
    const openingHeight = h.span;
    const invert = h.center[1] - openingHeight * 0.5;
    const crown = h.center[1] + openingHeight * 0.5;

    const mat = h.weakestMat >= 0 ? h.weakestMat : Mat.CLAY;
    const bulking = materialProps(mat).bulking;
    const hArch = this.archHeight(h);
    const hChoke = chokeHeight(mat, openingHeight);
    // Daylight: the roof can only fall as far as there is rock above it.
    const hDaylight = Math.max(0, h.cover);
    const height = Math.min(hArch, hChoke, hDaylight);
    const brokeSurface = height >= hDaylight - 1e-6 && hDaylight > 0;

    const removed = area * height;
    // Space the debris can occupy: the opening plus the chimney just excavated.
    const voidVolume = area * openingHeight + removed;

    // When the fall reaches daylight the surface has to subside, and that
    // subsided material is itself rock that breaks and bulks. Sizing the crater
    // from the volume deficit and then feeding it back into the debris budget is
    // what keeps the accounting closed; simply carving a bowl at the surface
    // would lose mass all over again, which is the bug this rewrite exists to fix.
    const bowlRadius = Math.max(radius * 1.6, h.span);
    // A smoothstep dish of radius r and depth d has volume ~= 0.5 * pi r^2 d.
    const bowlUnitVolume = 0.5 * Math.PI * bowlRadius * bowlRadius;
    let bowlDepth = 0;
    if (brokeSurface) {
      const deficit = Math.max(0, voidVolume - removed * bulking);
      bowlDepth = Math.min(h.cover * 0.6, deficit / bowlUnitVolume);
    }
    const bowlVolume = bowlDepth * bowlUnitVolume;

    const debris = (removed + bowlVolume) * bulking;
    const totalVoid = voidVolume + bowlVolume;
    const fillVolume = Math.min(debris, totalVoid);
    const fillHeight = fillVolume / area;

    // Brush order matters: both removals first, then the fill, because a later
    // 'sub' would cut straight back through rubble placed by an earlier 'add'.
    if (height > 0.05) {
      // A vertical capsule is a cylinder with rounded ends, close enough to a
      // chimney and needing no new brush kind.
      this.pendingBrushes.push(
        makeBrush.bore(
          [h.center[0], crown, h.center[2]],
          [h.center[0], crown + height, h.center[2]],
          radius,
        ),
      );
    }
    if (bowlDepth > 0.05) {
      // cover is measured upward from the crown (see assess()), so the ground
      // surface is crown + cover. Measuring it from the heading centre instead
      // put the crater half a span underground, where it quietly ate rock.
      const surfaceY = crown + h.cover;
      this.pendingBrushes.push(makeBrush.settle([h.center[0], surfaceY, h.center[2]], bowlRadius, bowlDepth));
    }
    if (fillHeight > 0.05) {
      this.pendingBrushes.push({
        kind: 'capsule',
        op: 'add',
        mat: Mat.RUBBLE,
        a: [h.center[0], invert, h.center[2]],
        b: [h.center[0], invert + fillHeight, h.center[2]],
        r: radius,
      });
    }

    this.lastCollapse = {
      id: h.id,
      removedVolume: removed + bowlVolume,
      debrisVolume: debris,
      fillHeight,
      residualVoid: Math.max(0, totalVoid - debris),
      height,
      craterDepth: bowlDepth,
      arrestedBy: brokeSurface ? 'daylight' : hArch <= hChoke ? 'arching' : 'choking',
    };

    const arrest =
      brokeSurface ? '地表に到達'
      : hArch <= hChoke ? `アーチ形成 (${hArch.toFixed(1)} m)`
      : `瓦礫で閉塞 (${hChoke.toFixed(1)} m)`;

    this.events.push({
      kind: brokeSurface ? 'sinkhole' : 'collapse',
      heading: h,
      message: brokeSurface
        ? `天端崩落が地表に到達 — 陥没 深さ ${bowlDepth.toFixed(1)} m ` +
          `(土被り ${h.cover.toFixed(1)} m、${materialProps(mat).name} 膨れ ${bulking.toFixed(2)})`
        : `天端崩落 ${height.toFixed(1)} m — ${arrest}、瓦礫 ${debris.toFixed(0)} m³ が坑道を埋没 ` +
          `(RMR ${h.rmr.toFixed(0)}, 無支保 ${h.allowedSpan.toFixed(1)} m < 掘削 ${h.span.toFixed(1)} m)`,
    });
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
  // No roof, nothing to fall. Checked before the span comparison because an open
  // cut is always "over span" by the tunnel criterion and would otherwise start a
  // deterioration clock for a roof that is not there.
  if (!h.hasRoof) return HeadingState.OPEN_CUT;
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
    case HeadingState.OPEN_CUT: return '開削（切土）';
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
