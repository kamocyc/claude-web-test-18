/**
 * Editing tools: what a click actually does.
 *
 * Every tool ends up producing brushes, so adding a tool never touches the
 * chunk, mesh or save code.
 */
import { makeBrush, type Brush, type Vec3 } from '../terrain/brush.ts';
import { Mat } from '../terrain/geology.ts';
import type { World } from '../terrain/world.ts';
import type { TunnelSim } from '../sim/tunnel.ts';

export const Tool = {
  DIG: 'dig',
  FILL: 'fill',
  ROAD: 'road',
  TUNNEL: 'tunnel',
  SUPPORT: 'support',
  INSPECT: 'inspect',
} as const;

export type ToolValue = (typeof Tool)[keyof typeof Tool];

export const TOOL_LABELS: Record<ToolValue, string> = {
  [Tool.DIG]: '掘削',
  [Tool.FILL]: '盛土',
  [Tool.ROAD]: '道路',
  [Tool.TUNNEL]: 'トンネル掘進',
  [Tool.SUPPORT]: '支保工設置',
  [Tool.INSPECT]: '地質調査',
};

export interface ToolSettings {
  radius: number;
  /** Tunnel bore span (full width), metres. */
  tunnelSpan: number;
  /** Road half-width, metres. */
  roadHalfWidth: number;
}

export const defaultToolSettings: ToolSettings = {
  radius: 3,
  tunnelSpan: 6,
  roadHalfWidth: 4,
};

export interface ToolContext {
  world: World;
  tunnels: TunnelSim;
  settings: ToolSettings;
  /** Applies brushes and returns the number of chunks touched. */
  apply: (brushes: Brush[]) => number;
  log: (msg: string) => void;
}

/** State carried between clicks for the two-point tools (road, tunnel). */
export interface PendingSegment {
  tool: ToolValue;
  start: Vec3;
}

/**
 * Free-form excavation.
 *
 * The only difference from driveTunnel is the shape (a ball rather than a swept
 * capsule) and the fact that a drive is a chain of sections you can support as a
 * unit. The *physics* is identical: if the dig leaves rock overhead it becomes an
 * opening judged by unsupported span and stand-up time, exactly like a heading.
 * Before this, digging had no stability consequences at all, so you could hollow
 * out an arbitrarily large chamber underground and nothing would ever happen.
 */
export function digAt(ctx: ToolContext, p: Vec3): void {
  const r = ctx.settings.radius;
  ctx.apply([makeBrush.dig(p, r)]);
  const opening = ctx.tunnels.addOpening(ctx.world, [p[0], p[1], p[2]], r * 2);
  if (!opening) {
    ctx.log(`掘削 r=${r.toFixed(1)} m — 地表の土工（切土）。天端が無いので崩落の対象外`);
    return;
  }
  const clock = opening.standUpTime === Infinity ? '自立' : `自立時間 ${opening.standUpTime.toFixed(0)} s`;
  ctx.log(
    `掘削 r=${r.toFixed(1)} m → 地下空洞 #${opening.id} として登録 — ` +
      `RMR ${opening.rmr.toFixed(0)}, 土被り ${opening.cover.toFixed(1)} m, ` +
      `無支保スパン ${opening.allowedSpan.toFixed(1)} m vs 空洞 ${opening.span.toFixed(1)} m, ${clock}`,
  );
}

export function fillAt(ctx: ToolContext, p: Vec3): void {
  ctx.apply([makeBrush.fill(p, ctx.settings.radius, Mat.FILL)]);
  // Filling over an opening gives it a roof, so re-assessment happens on the next
  // sim tick; nothing to register here.
}

/**
 * Build a road between two points: cut everything above the grade line, then
 * place fill below it. Both are one brush, so a road is two entries in the diff
 * regardless of how much earth it moves.
 */
export function buildRoad(ctx: ToolContext, a: Vec3, b: Vec3): void {
  const hw = ctx.settings.roadHalfWidth;
  // The running surface follows a straight grade between the two picked points.
  const cutCentre: Vec3 = [a[0], a[1] + 6, a[2]];
  const cutCentreB: Vec3 = [b[0], b[1] + 6, b[2]];
  const brushes: Brush[] = [
    // Cut: a tall box centred 6 m above grade removes the hillside.
    makeBrush.roadCut(cutCentre, cutCentreB, hw, 6),
    // Fill: a box centred 2 m below grade builds the embankment.
    makeBrush.roadFill([a[0], a[1] - 2, a[2]], [b[0], b[1] - 2, b[2]], hw, 2),
  ];
  const n = ctx.apply(brushes);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  ctx.log(`道路 ${len.toFixed(1)} m を建設 (切土+盛土, ${n} チャンク更新)`);
}

/**
 * Drive a tunnel between two points.
 *
 * The bore is a single capsule brush, and each section along it becomes a
 * heading whose stability is tracked independently — which is the point, because
 * the geology changes along the drive and so does the support you need.
 */
export function driveTunnel(ctx: ToolContext, a: Vec3, b: Vec3): void {
  const span = ctx.settings.tunnelSpan;
  const r = span * 0.5;
  ctx.apply([makeBrush.bore(a, b, r)]);

  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  // One heading roughly every span-length, so a long drive samples the geology
  // it actually passes through rather than assuming the portal's rock.
  const sections = Math.max(1, Math.round(len / Math.max(2, span)));
  const created: number[] = [];
  for (let i = 0; i < sections; i++) {
    const t = sections === 1 ? 0.5 : (i + 0.5) / sections;
    const c: [number, number, number] = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    created.push(ctx.tunnels.addHeading(ctx.world, c, span).id);
  }

  const worst = ctx.tunnels
    .all()
    .filter((h) => created.includes(h.id) && h.hasRoof)
    .reduce<null | { rmr: number; allowed: number; t: number }>((acc, h) => {
      if (!acc || h.allowedSpan < acc.allowed) {
        return { rmr: h.rmr, allowed: h.allowedSpan, t: h.standUpTime };
      }
      return acc;
    }, null);

  if (worst) {
    const heads = ctx.tunnels.all().filter((h) => created.includes(h.id));
    const cuts = heads.filter((h) => !h.hasRoof).length;
    if (cuts === heads.length) {
      ctx.log(
        `掘進 ${len.toFixed(1)} m — 全 ${sections} 断面に天端が無く開削（切土）になりました。` +
          `トンネルにするには土被りのある場所を指定してください`,
      );
      return;
    }
    const clock = worst.t === Infinity ? '自立' : `自立時間 ${worst.t.toFixed(0)} s`;
    ctx.log(
      `トンネル ${len.toFixed(1)} m 掘進 (${sections} 断面${cuts > 0 ? `、うち ${cuts} は開削` : ''}) — ` +
        `最弱部 RMR ${worst.rmr.toFixed(0)}, 無支保スパン ${worst.allowed.toFixed(1)} m vs 掘削 ${span.toFixed(1)} m, ${clock}`,
    );
  }
}

/**
 * Install support at the heading nearest a point. Picks the cheapest support
 * that actually holds, and places a concrete lining brush so the tunnel visibly
 * gains a shell.
 */
export function installSupport(ctx: ToolContext, p: Vec3): void {
  const h = ctx.tunnels.nearest(p[0], p[1], p[2], 14);
  if (!h) {
    ctx.log('支保工を設置する断面が近くにありません');
    return;
  }
  const needed = ctx.tunnels.requiredSupport(h);
  if (needed === null) {
    ctx.log(
      `RMR ${h.rmr.toFixed(0)} では ${h.span.toFixed(1)} m スパンを支保できません — ` +
        `断面を小さくするか、シールド工法が必要`,
    );
    return;
  }
  ctx.tunnels.installSupport(ctx.world, h.id, needed);
  const r = h.span * 0.5;
  // A thin concrete shell just outside the bore.
  ctx.apply([
    makeBrush.lining(
      [h.center[0], h.center[1], h.center[2] - r * 0.5],
      [h.center[0], h.center[1], h.center[2] + r * 0.5],
      r * 1.12,
    ),
    // Re-open the bore through the shell we just added.
    makeBrush.bore(
      [h.center[0], h.center[1], h.center[2] - r * 0.7],
      [h.center[0], h.center[1], h.center[2] + r * 0.7],
      r,
    ),
  ]);
  ctx.log(`支保工を設置: ${needed} (断面 #${h.id})`);
}
