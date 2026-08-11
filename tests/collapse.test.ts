/**
 * Collapse behaviour: mass conservation, self-choking, and the distinction
 * between a tunnel and an open cut.
 *
 * These are regression tests for four things that were reported from play:
 * collapses left enormous open caverns because the debris vanished; an open cut
 * bored along the ground surface was told its (non-existent) roof would fall;
 * digging had no stability consequences at all; and floating rock never fell
 * (that last one is in detach.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_TICK_SECONDS } from '../src/core/config.ts';
import { World } from '../src/terrain/world.ts';
import { SyncMeshPool } from '../src/terrain/workerPool.ts';
import { makeBrush } from '../src/terrain/brush.ts';
import { Mat, chokeHeight, materialProps, surfaceHeight } from '../src/terrain/geology.ts';
import {
  HeadingState,
  MIN_ROOF_COVER,
  SupportKind,
  TunnelSim,
  shallowCoverFactor,
} from '../src/sim/tunnel.ts';

const SEED = 1337;

async function makeWorld(radiusXZ = 4): Promise<World> {
  const world = new World(SEED, new SyncMeshPool(), { radiusXZ, minCy: -3, maxCy: 3 });
  const centre: [number, number, number] = [0, 20, 0];
  world.updateStreaming(centre);
  for (let i = 0; i < 9000; i++) {
    world.pump(centre);
    await Promise.resolve();
    await Promise.resolve();
    const s = world.stats();
    if (s.pendingGenerate === 0 && s.ready === s.chunks) return world;
  }
  throw new Error('world did not finish generating');
}

/** Bore an opening and register it, returning the heading. */
function bore(world: World, tunnels: TunnelSim, x: number, y: number, z: number, span: number) {
  world.applyBrush(makeBrush.bore([x - 8, y, z], [x + 8, y, z], span / 2));
  return tunnels.addHeading(world, [x, y, z], span);
}

// ---------------------------------------------------------------- bulking ----

test('every material bulks when broken, and rubble does not bulk again', () => {
  for (const m of [Mat.TOPSOIL, Mat.SAND, Mat.CLAY, Mat.GRAVEL, Mat.SANDSTONE, Mat.LIMESTONE, Mat.GRANITE]) {
    assert.ok(materialProps(m).bulking > 1, `${materialProps(m).name} must bulk when broken`);
  }
  // Already-broken rock does not bulk a second time, so it can never choke a
  // chimney on its own.
  assert.equal(materialProps(Mat.RUBBLE).bulking, 1);
  assert.equal(chokeHeight(Mat.RUBBLE, 6), Infinity);
});

test('blocky rock chokes a chimney sooner than soil does', () => {
  // Soil barely bulks, so it chimneys much further — which is why sinkholes form
  // over shallow workings in soft ground rather than in granite.
  const soil = chokeHeight(Mat.SAND, 6);
  const rock = chokeHeight(Mat.GRANITE, 6);
  assert.ok(rock < soil, `granite should choke sooner than sand; ${rock} vs ${soil}`);
  assert.ok(Number.isFinite(soil) && soil > 0);
  // A taller opening takes more debris to fill, so it chimneys further.
  assert.ok(chokeHeight(Mat.SANDSTONE, 12) > chokeHeight(Mat.SANDSTONE, 6));
});

test('rubble is the weakest thing to found on', async () => {
  const { bearingCapacityOfMaterial } = await import('../src/sim/bearing.ts');
  const rubble = bearingCapacityOfMaterial(Mat.RUBBLE, 3, 1.5).allowable;
  for (const m of [Mat.FILL, Mat.TOPSOIL, Mat.CLAY, Mat.SAND, Mat.GRAVEL, Mat.SANDSTONE]) {
    assert.ok(
      rubble < bearingCapacityOfMaterial(m, 3, 1.5).allowable,
      `rubble must be weaker than ${materialProps(m).name}`,
    );
  }
});

// ------------------------------------------------------- mass conservation ----

test('a collapse buries the opening instead of leaving a cavern', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 26;
  const h = bore(world, tunnels, 0, y, 0, 9);
  assert.ok(h.span > h.allowedSpan, 'the test heading must be over-span');

  assert.ok(world.sampleDensity(0, y, 0)! > 0, 'the bore should have left air');

  h.elapsed = 1e9;
  tunnels.update(world, SIM_TICK_SECONDS);
  assert.equal(h.state, HeadingState.COLLAPSED);
  for (const b of tunnels.drainBrushes()) world.applyBrush(b);

  // The tunnel must now be full of rubble. This is the reported bug: the old
  // implementation removed the roof and put almost nothing back.
  assert.ok(world.sampleDensity(0, y, 0)! < 0, 'the opening should be buried after a collapse');
  assert.equal(world.sampleMaterial(0, y, 0), Mat.RUBBLE, 'it should be buried in rubble');
  world.dispose();
});

test('debris volume equals removed volume times bulking, and the void shrinks', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const h = bore(world, tunnels, 0, surf - 26, 0, 9);
  h.elapsed = 1e9;
  tunnels.update(world, SIM_TICK_SECONDS);

  const r = tunnels.lastCollapse;
  assert.ok(r, 'a collapse must report its volumes');
  const bulking = materialProps(h.weakestMat).bulking;
  assert.ok(
    Math.abs(r.debrisVolume - r.removedVolume * bulking) < 1e-6,
    `debris ${r.debrisVolume} should be removed ${r.removedVolume} x bulking ${bulking}`,
  );
  assert.ok(r.debrisVolume > r.removedVolume, 'broken rock must occupy more than it did intact');
  // The residual void has to be a fraction of what fell, not several times it.
  assert.ok(
    r.residualVoid < r.removedVolume,
    `residual void ${r.residualVoid} m3 should be smaller than the ${r.removedVolume} m3 removed`,
  );
  assert.ok(r.fillHeight > 0, 'debris must be deposited');
  world.dispose();
});

test('a collapse is arrested by arching, choking or daylight, and says which', async () => {
  const world = await makeWorld(5);
  const tunnels = new TunnelSim();
  const seen = new Set<string>();
  let x = -60;
  for (const depth of [10, 18, 26, 34]) {
    const surf = surfaceHeight(x, 0, SEED);
    const h = bore(world, tunnels, x, surf - depth, 0, 9);
    if (h.span <= h.allowedSpan || !h.hasRoof) {
      x += 26;
      continue;
    }
    h.elapsed = 1e9;
    tunnels.update(world, SIM_TICK_SECONDS);
    for (const b of tunnels.drainBrushes()) world.applyBrush(b);
    const r = tunnels.lastCollapse;
    assert.ok(r);
    seen.add(r.arrestedBy);
    assert.ok(r.height > 0, 'a collapse must propagate somewhere');
    if (r.arrestedBy === 'daylight') {
      assert.ok(r.craterDepth > 0, 'reaching daylight must leave a surface crater');
    } else {
      assert.equal(r.craterDepth, 0, 'a contained collapse must not touch the surface');
    }
    x += 26;
  }
  assert.ok(seen.size > 0, 'expected at least one collapse across the depth range');
  for (const s of seen) assert.ok(['arching', 'choking', 'daylight'].includes(s));
  world.dispose();
});

// ------------------------------------------------------------- open cut ------

test('an opening bored along the ground surface is a cut, not a tunnel', async () => {
  // The reported bug: picking points on the surface put the crown several metres
  // in the air with 0 m of cover, and the sim started a stand-up clock anyway.
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const hit = world.raycast(0, 220, 0, 0, -1, 0, 400);
  assert.ok(hit);
  world.applyBrush(makeBrush.bore([hit.x - 12, hit.y, hit.z], [hit.x + 12, hit.y, hit.z], 3));
  const h = tunnels.addHeading(world, [hit.x, hit.y, hit.z], 6);

  assert.ok(h.cover < MIN_ROOF_COVER, `expected no roof, got ${h.cover} m of cover`);
  assert.equal(h.hasRoof, false);
  assert.equal(h.state, HeadingState.OPEN_CUT);
  assert.equal(h.standUpTime, Infinity, 'a cut has no roof to fall, so no clock');

  for (let i = 0; i < 200; i++) tunnels.update(world, SIM_TICK_SECONDS);
  assert.equal(h.state, HeadingState.OPEN_CUT, 'an open cut must never collapse');
  assert.equal(tunnels.drainBrushes().length, 0, 'an open cut must emit no collapse brushes');
  world.dispose();
});

test('installing support on a roofless cut does not pretend it is safe', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const hit = world.raycast(0, 220, 0, 0, -1, 0, 400)!;
  world.applyBrush(makeBrush.bore([hit.x - 12, hit.y, hit.z], [hit.x + 12, hit.y, hit.z], 3));
  const h = tunnels.addHeading(world, [hit.x, hit.y, hit.z], 6);
  tunnels.installSupport(world, h.id, SupportKind.LINING);
  assert.equal(h.state, HeadingState.OPEN_CUT, 'lining a trench does not make it a tunnel');
  world.dispose();
});

test('stability depends continuously on cover, with no threshold cliff', () => {
  // A thin roof cannot span however good the rock is, and that must ramp in
  // rather than switch on: a threshold would make identical ground behave
  // completely differently either side of an arbitrary depth.
  let prev = -1;
  for (const cover of [0, 0.5, 1, 2, 3, 4, 5, 6, 9, 20]) {
    const f = shallowCoverFactor(cover, 6);
    assert.ok(f >= prev, `cover factor must be monotonic in cover (${cover} m)`);
    assert.ok(f > 0 && f <= 1, `cover factor out of range at ${cover} m: ${f}`);
    prev = f;
  }
  assert.equal(shallowCoverFactor(12, 6), 1, 'deep cover imposes no penalty');
  assert.ok(shallowCoverFactor(1, 6) < 0.5, 'a metre of roof over a 6 m span is weak');
});

test('a deeper heading tolerates a wider span than a shallow one', async () => {
  const world = await makeWorld(5);
  const tunnels = new TunnelSim();
  let prev = 0;
  let x = -60;
  const spans: number[] = [];
  for (const depth of [3, 6, 12, 22, 40]) {
    const surf = surfaceHeight(x, 0, SEED);
    const h = bore(world, tunnels, x, surf - depth, 0, 6);
    if (h.hasRoof) spans.push(h.allowedSpan);
    x += 26;
  }
  assert.ok(spans.length >= 3, 'expected several roofed headings');
  for (const s of spans) {
    assert.ok(s >= prev - 1e-9, `allowed span should grow with cover: ${spans.join(', ')}`);
    prev = s;
  }
  world.dispose();
});

// --------------------------------------------------- dig / tunnel unified ----

test('digging underground registers an opening and is judged like a tunnel', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 20;
  world.applyBrush(makeBrush.dig([0, y, 0], 4));
  const opening = tunnels.addOpening(world, [0, y, 0], 8);
  assert.ok(opening, 'an excavation with rock overhead must be registered');
  assert.ok(opening.hasRoof);
  assert.ok(opening.span > opening.allowedSpan, 'an 8 m chamber in this ground is over-span');
  assert.notEqual(opening.state, HeadingState.STABLE);

  let collapsed = false;
  for (let i = 0; i < 200; i++) {
    tunnels.update(world, SIM_TICK_SECONDS);
    const bs = tunnels.drainBrushes();
    if (bs.length > 0) {
      for (const b of bs) world.applyBrush(b);
      collapsed = true;
      break;
    }
  }
  assert.ok(collapsed, 'a free-form dig underground must be able to collapse, like a tunnel');
  world.dispose();
});

test('digging at the surface registers nothing', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const hit = world.raycast(0, 220, 0, 0, -1, 0, 400)!;
  world.applyBrush(makeBrush.dig([hit.x, hit.y - 0.5, hit.z], 4));
  const opening = tunnels.addOpening(world, [hit.x, hit.y - 0.5, hit.z], 8);
  assert.equal(opening, null, 'surface earthworks are not an opening and must not be tracked');
  assert.equal(tunnels.all().length, 0);
  world.dispose();
});

test('repeated digging in one place updates one opening rather than piling up', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 20;
  for (let k = 0; k < 6; k++) {
    world.applyBrush(makeBrush.dig([k * 0.4, y, 0], 3));
    tunnels.addOpening(world, [k * 0.4, y, 0], 6);
  }
  assert.equal(tunnels.all().length, 1, 'nearby digs should merge into one opening');
  world.dispose();
});

test('an opening only widens as it is dug out', async () => {
  const world = await makeWorld();
  const tunnels = new TunnelSim();
  const surf = surfaceHeight(0, 0, SEED);
  const y = surf - 20;
  world.applyBrush(makeBrush.dig([0, y, 0], 4));
  const first = tunnels.addOpening(world, [0, y, 0], 8)!;
  const wide = first.span;
  // A smaller dig inside the same cavity must not shrink the recorded span: the
  // opening is the union of everything excavated there.
  tunnels.addOpening(world, [0.5, y, 0], 3);
  assert.equal(first.span, wide, 'a smaller dig must not narrow an existing opening');
  world.dispose();
});
