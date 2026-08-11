/**
 * End-to-end through the real pipeline: World + SyncMeshPool + TunnelSim.
 *
 * This is the test that actually exercises the design's central claim — that a
 * tunnel bored wider than the rock supports will fall in, that supporting it
 * prevents that, and that the collapse arrives as ordinary CSG brushes on the
 * same path as player edits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TICK_SECONDS } from '../src/core/config.ts';
import { World } from '../src/terrain/world.ts';
import { SyncMeshPool } from '../src/terrain/workerPool.ts';
import { HeadingState, SupportKind, TunnelSim, unsupportedSpan, standUpTime } from '../src/sim/tunnel.ts';
import { overburdenAt, rockQualityAround } from '../src/sim/stress.ts';
import { bearingCapacity, bearingCapacityOfMaterial, settlementRate, utilisation } from '../src/sim/bearing.ts';
import { makeBrush } from '../src/terrain/brush.ts';
import { surfaceHeight, Mat } from '../src/terrain/geology.ts';

const SEED = 1337;

/**
 * Build a world and generate every chunk in a small region, synchronously.
 *
 * The streaming extent is deliberately tiny: the production default keeps a few
 * thousand chunks resident, and generating those at ~14 ms each would take the
 * best part of a minute. A radius of 2 is enough to exercise the pipeline.
 */
async function makeWorld(center: [number, number, number], radiusXZ = 2): Promise<World> {
  // The vertical range must straddle the terrain surface with room to spare:
  // overburdenAt walks upward and stops at the edge of the resident volume, so a
  // column that leaves the loaded chunks reports a truncated (too small) cover.
  const world = new World(SEED, new SyncMeshPool(), { radiusXZ, minCy: -2, maxCy: 3 });
  world.updateStreaming(center);
  // SyncMeshPool resolves immediately, so pumping in a loop drains generation.
  for (let i = 0; i < 2000; i++) {
    world.pump(center);
    // Two microtask drains: one for the generate promise, one for its .then.
    await Promise.resolve();
    await Promise.resolve();
    const s = world.stats();
    if (s.pendingGenerate === 0 && s.ready === s.chunks) break;
  }
  return world;
}

test('a freshly streamed world generates chunks and meshes them', async () => {
  const world = await makeWorld([0, 24, 0]);
  const s = world.stats();
  assert.ok(s.chunks >= 30, `expected a populated streaming volume, got ${s.chunks}`);
  assert.equal(s.ready, s.chunks, 'every streamed chunk should be ready');
  assert.ok(s.triangles > 3000, `expected real geometry, got ${s.triangles} triangles`);
  world.dispose();
});

test('raycast finds the ground and agrees with the surface height', async () => {
  const world = await makeWorld([0, 24, 0]);
  for (const [x, z] of [[0, 0], [8, -12], [-14, 10], [12, 12]] as const) {
    const hit = world.raycast(x, 220, z, 0, -1, 0, 400);
    assert.ok(hit, `expected a ground hit at ${x},${z}`);
    // The 3D carve term perturbs the surface by up to its amplitude, so the
    // agreement is approximate by construction.
    assert.ok(Math.abs(hit.y - surfaceHeight(x, z, SEED)) < 8,
      `hit at y=${hit.y} but surfaceHeight says ${surfaceHeight(x, z, SEED)}`);
    assert.notEqual(hit.material, Mat.AIR, 'a ground hit must report a solid material');
  }
  world.dispose();
});

test('digging changes the world and the ground surface drops', async () => {
  const world = await makeWorld([0, 24, 0]);
  const before = world.raycast(0, 220, 0, 0, -1, 0, 400);
  assert.ok(before);
  const touched = world.applyBrush(makeBrush.dig([0, before.y - 1, 0], 5));
  assert.ok(touched.length > 0, 'a dig at the surface must touch at least one chunk');
  const after = world.raycast(0, 220, 0, 0, -1, 0, 400);
  assert.ok(after);
  assert.ok(after.y < before.y - 2, `expected the surface to drop; ${before.y} -> ${after.y}`);
  world.dispose();
});

test('overburden increases with depth and drops when a void is bored above', async () => {
  const world = await makeWorld([0, 24, 0]);
  const surf = surfaceHeight(0, 0, SEED);
  const shallow = overburdenAt(world, 0, surf - 6, 0);
  const deep = overburdenAt(world, 0, surf - 26, 0);
  assert.equal(shallow.truncated, false, 'shallow column should be fully resident');
  assert.equal(deep.truncated, false, 'deep column should be fully resident');
  assert.ok(deep.cover > shallow.cover, 'deeper points must carry more cover');
  assert.ok(deep.sigmaV > shallow.sigmaV, 'deeper points must carry more stress');

  // Bore a large void directly above the deep point and re-measure.
  world.applyBrush(makeBrush.bore([-10, surf - 14, 0], [10, surf - 14, 0], 5));
  const after = overburdenAt(world, 0, surf - 26, 0);
  assert.ok(after.cover < deep.cover - 4,
    `excavating above a point must reduce its cover; ${deep.cover} -> ${after.cover}`);
  world.dispose();
});

test('unsupported span rises with RMR and falls with stress', () => {
  let prev = 0;
  for (const rmr of [5, 20, 35, 50, 65, 80, 95]) {
    const s = unsupportedSpan(rmr, 200);
    assert.ok(s > prev, `span must increase with RMR (${rmr})`);
    prev = s;
  }
  assert.ok(unsupportedSpan(60, 6000) < unsupportedSpan(60, 100),
    'high in-situ stress must squeeze the opening');
});

test('stand-up time is infinite within the allowed span and finite beyond it', () => {
  const allowed = unsupportedSpan(50, 300);
  assert.equal(standUpTime(50, allowed * 0.9, allowed), Infinity);
  const t = standUpTime(50, allowed * 1.8, allowed);
  assert.ok(Number.isFinite(t) && t > 0, 'over-span openings need a finite clock');
  assert.ok(standUpTime(50, allowed * 3, allowed) < t, 'wider openings fail sooner');
});

test('an over-span heading in weak ground collapses, and emits CSG brushes', async () => {
  const world = await makeWorld([0, 24, 0]);
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  // Shallow, in the soil mantle: RMR is low, so even a modest span is too wide.
  const y = surf - 7;
  const span = 9;
  world.applyBrush(makeBrush.bore([-8, y, 0], [8, y, 0], span / 2));
  const h = tunnels.addHeading(world, [0, y, 0], span);

  assert.ok(h.allowedSpan < span,
    `expected weak shallow ground to disallow a ${span} m span, got ${h.allowedSpan}`);
  assert.ok(Number.isFinite(h.standUpTime), 'an over-span heading must have a clock');

  // Run the sim past the stand-up time.
  const ticks = Math.ceil(h.standUpTime / SIM_TICK_SECONDS) + 4;
  const seen = new Set<string>();
  for (let i = 0; i < ticks; i++) {
    tunnels.update(world, SIM_TICK_SECONDS);
    seen.add(h.state);
  }

  assert.equal(h.state, HeadingState.COLLAPSED, 'the heading should have collapsed');
  // The point of the staged states: the player gets warnings, not a surprise.
  assert.ok(seen.has(HeadingState.CRACKING), 'should have passed through cracking');
  assert.ok(seen.has(HeadingState.CRITICAL), 'should have passed through critical');

  const brushes = tunnels.drainBrushes();
  assert.ok(brushes.length >= 2, 'a collapse must produce removal and rubble brushes');
  assert.ok(brushes.some((b) => b.op === 'sub'), 'the roof must be removed');
  assert.ok(brushes.some((b) => b.op === 'add'), 'rubble must be deposited');

  // And those brushes go through the ordinary edit path.
  let touched = 0;
  for (const b of brushes) touched += world.applyBrush(b).length;
  assert.ok(touched > 0, 'collapse brushes must modify the world like any other edit');

  const events = tunnels.drainEvents();
  assert.ok(events.some((e) => e.kind === 'collapse' || e.kind === 'sinkhole'),
    'a collapse must be reported to the player');
  world.dispose();
});

test('a deep heading is rated by the rock around it, not the topsoil above it', async () => {
  // Regression: assess() used to take the weakest material anywhere in the
  // overburden column. Every column on this map is capped by topsoil (RMR 5), so
  // that rated every heading at every depth at RMR ~7, whereupon no support of
  // any kind was ever sufficient and the mechanic was unplayable.
  const world = await makeWorld([0, 20, 0], 3);
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const deepY = surf - 30;
  const span = 6;
  world.applyBrush(makeBrush.bore([-8, deepY, 0], [8, deepY, 0], span / 2));

  const rq = rockQualityAround(world, 0, deepY, 0, span);
  assert.ok(rq.samples > 0, 'the ring around the opening should be solid ground');
  assert.ok(rq.minRmr > 20,
    `deep rock should rate well above topsoil, got minRmr ${rq.minRmr} (${rq.weakestMat})`);

  const deep = tunnels.addHeading(world, [0, deepY, 0], span);
  assert.ok(deep.rmr > 20, `deep heading RMR should reflect rock, got ${deep.rmr}`);
  assert.ok(deep.cover > 20, `deep heading should carry real cover, got ${deep.cover} m`);
  assert.notEqual(tunnels.requiredSupport(deep), null,
    'a 6 m heading in competent rock must be supportable');

  // And the shallow case must still be the hard one.
  const shallowY = surf - 5;
  world.applyBrush(makeBrush.bore([-8, shallowY, 40], [8, shallowY, 40], span / 2));
  const shallow = tunnels.addHeading(world, [0, shallowY, 40], span);
  assert.ok(shallow.rmr < deep.rmr,
    `shallow soil must rate worse than deep rock; ${shallow.rmr} vs ${deep.rmr}`);
  assert.ok(shallow.allowedSpan < deep.allowedSpan, 'soil must support a smaller span than rock');
  world.dispose();
});

test('a fresh heading is classified on excavation, not on the first tick', async () => {
  const world = await makeWorld([0, 20, 0], 3);
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  // Shallow and wide: cannot possibly stand, so it must not read as stable.
  const y = surf - 5;
  world.applyBrush(makeBrush.bore([-8, y, 0], [8, y, 0], 5));
  const h = tunnels.addHeading(world, [0, y, 0], 10);
  assert.ok(h.span > h.allowedSpan, 'the test heading must be over-span');
  assert.notEqual(h.state, HeadingState.STABLE,
    'a doomed heading must not report as stable before the first sim tick');
  world.dispose();
});

test('reducing the span makes a heading supportable', async () => {
  // The player's lever: a narrower heading both demands less and relies on
  // better ground, because it reaches less far into the weathered zone.
  const world = await makeWorld([0, 20, 0], 3);
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 12;
  world.applyBrush(makeBrush.bore([-8, y, 0], [8, y, 0], 4));
  const wide = tunnels.addHeading(world, [0, y, 0], 8);
  world.applyBrush(makeBrush.bore([-8, y, 60], [8, y, 60], 1.25));
  const narrow = tunnels.addHeading(world, [0, y, 60], 2.5);
  assert.ok(narrow.allowedSpan >= wide.allowedSpan,
    'a narrower heading must not be rated worse than a wider one in the same stratum');
  assert.ok(narrow.span <= narrow.allowedSpan || tunnels.requiredSupport(narrow) !== null,
    'a narrow heading should be stable or at least supportable');
  world.dispose();
});

test('installing adequate support prevents collapse indefinitely', async () => {
  const world = await makeWorld([0, 24, 0]);
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 30;
  const span = 6;
  world.applyBrush(makeBrush.bore([-8, y, 0], [8, y, 0], span / 2));
  const h = tunnels.addHeading(world, [0, y, 0], span);

  const needed = tunnels.requiredSupport(h);
  if (needed === null) {
    // Ground too weak for any support: that is a legitimate outcome, but then
    // there is nothing to assert about a supported heading.
    world.dispose();
    return;
  }
  assert.ok(tunnels.installSupport(world, h.id, needed));
  assert.equal(h.state, HeadingState.SUPPORTED);

  for (let i = 0; i < 200; i++) tunnels.update(world, SIM_TICK_SECONDS);
  assert.equal(h.state, HeadingState.SUPPORTED, 'a supported heading must never fail');
  assert.equal(tunnels.drainBrushes().length, 0, 'no collapse brushes should be emitted');
  world.dispose();
});

test('a lining supports a span that bare rock cannot', async () => {
  const world = await makeWorld([0, 24, 0]);
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 20;
  const span = 7;
  world.applyBrush(makeBrush.bore([-6, y, 0], [6, y, 0], span / 2));
  const h = tunnels.addHeading(world, [0, y, 0], span);
  const bareSpan = h.allowedSpan;
  tunnels.installSupport(world, h.id, SupportKind.LINING);
  assert.ok(h.allowedSpan > bareSpan * 3,
    `a lining should multiply the supportable span; ${bareSpan} -> ${h.allowedSpan}`);
  world.dispose();
});

test('bearing capacity ranks materials the way soil mechanics does', () => {
  const rock = bearingCapacityOfMaterial(Mat.GRANITE, 3, 1.5);
  const sandstone = bearingCapacityOfMaterial(Mat.SANDSTONE, 3, 1.5);
  const sand = bearingCapacityOfMaterial(Mat.SAND, 3, 1.5);
  const fill = bearingCapacityOfMaterial(Mat.FILL, 3, 1.5);
  assert.ok(rock.allowable > sandstone.allowable);
  assert.ok(sandstone.allowable > sand.allowable);
  assert.ok(sand.allowable > fill.allowable * 0.5, 'sand and loose fill should be comparable');
  assert.ok(fill.allowable > 0);
  // Safety factor must actually divide.
  assert.ok(Math.abs(rock.ultimate / 3 - rock.allowable) < 1e-9);
});

test('a wider footing carries more total load, and overload drives settlement', () => {
  const narrow = bearingCapacity(0, 33, 18, 1, 1.5);
  const wide = bearingCapacity(0, 33, 18, 4, 1.5);
  assert.ok(wide.allowable > narrow.allowable, 'friction soils gain capacity with width');

  assert.equal(settlementRate(0.8, 3), 0, 'a footing within capacity must not settle');
  assert.equal(settlementRate(1, 3), 0, 'exactly at capacity must not settle');
  const mild = settlementRate(1.2, 3);
  const severe = settlementRate(2.5, 3);
  assert.ok(mild > 0 && severe > mild, 'worse overload must settle faster');
  assert.ok(severe < 0.3, 'settlement must stay slow enough to read as a warning');

  const cap = bearingCapacityOfMaterial(Mat.CLAY, 3, 1.5);
  assert.ok(utilisation(cap.allowable * 2, cap) > 1.9);
});
