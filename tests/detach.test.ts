/**
 * Rock that has lost its support.
 *
 * Regression tests for the report that floating terrain simply stayed floating.
 * The safety property matters as much as the detection: the sweep must never
 * condemn ground that is actually held up, including ground held up by rock in a
 * neighbouring chunk that the worker cannot see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK, FIELD, FIELD2, VOXEL } from '../src/core/config.ts';
import { allocChunkField, fillChunkField } from '../src/terrain/density.ts';
import { Mat, materialProps, surfaceHeight } from '../src/terrain/geology.ts';
import { applyFalling, findFalling, type FallingCluster } from '../src/sim/detach.ts';
import { World } from '../src/terrain/world.ts';
import { SyncMeshPool } from '../src/terrain/workerPool.ts';
import { makeBrush } from '../src/terrain/brush.ts';

const SEED = 1337;

/** An all-air field, so a test can place exactly the rock it means to. */
function emptyField(): { field: Float32Array; material: Uint8Array } {
  const n = FIELD * FIELD2;
  return { field: new Float32Array(n).fill(3), material: new Uint8Array(n) };
}

function put(
  d: { field: Float32Array; material: Uint8Array },
  x: number, y: number, z: number,
  mat: number = Mat.SANDSTONE,
): void {
  const i = x + y * FIELD + z * FIELD2;
  d.field[i] = -1;
  d.material[i] = mat;
}

function box(
  d: { field: Float32Array; material: Uint8Array },
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  mat: number = Mat.SANDSTONE,
): void {
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) put(d, x, y, z, mat);
}

// -------------------------------------------------------------- detection ----

test('a body of rock severed from everything else is detected once', () => {
  const d = emptyField();
  box(d, 14, 18, 14, 18, 14, 18);
  const found = findFalling(d.field, d.material, 0, 1, 0);
  assert.equal(found.length, 1, `expected one cluster, got ${found.map((c) => c.reason).join(', ')}`);
  assert.equal(found[0]!.reason, 'detached');
  assert.equal(found[0]!.voxels, 64);
  assert.ok(Math.abs(found[0]!.volume - 64 * VOXEL ** 3) < 1e-9);
});

test('a body reaching the edge of the field is assumed supported', () => {
  // It may continue into the neighbouring chunk, which the worker cannot see.
  // Assuming support is the safe direction to be wrong in: the cost is missing a
  // detached body bigger than a chunk, not deleting terrain that was fine.
  const d = emptyField();
  box(d, 0, 4, 14, 18, 14, 18);
  assert.deepEqual(findFalling(d.field, d.material, 0, 1, 0), []);
});

test('a grounded pillar is left alone', () => {
  const d = emptyField();
  box(d, 14, 20, 0, 20, 14, 20);
  assert.deepEqual(findFalling(d.field, d.material, 0, 1, 0), []);
});

test('specks are ignored rather than reported as rock falls', () => {
  const d = emptyField();
  put(d, 16, 16, 16);
  put(d, 17, 16, 16);
  assert.deepEqual(findFalling(d.field, d.material, 0, 1, 0), []);
});

test('a cantilever fails once it projects further than the rock carries', () => {
  const build = (projectionVoxels: number, mat: number) => {
    const d = emptyField();
    // A full-height pillar to hang from...
    box(d, 1, 4, 0, 24, 10, 22, mat);
    // ...and a slab cantilevered out of it.
    box(d, 4, 4 + projectionVoxels, 20, 22, 10, 22, mat);
    return findFalling(d.field, d.material, 0, 1, 0).filter((c) => c.reason === 'overhang');
  };
  assert.equal(build(2, Mat.SANDSTONE).length, 0, 'a 1 m stub of sandstone must hold');
  assert.ok(build(16, Mat.SANDSTONE).length > 0, 'an 8 m sandstone cantilever must fail');
});

test('weaker rock fails at a shorter projection than stronger rock', () => {
  const firstFailure = (mat: number): number => {
    for (let L = 1; L <= 24; L++) {
      const d = emptyField();
      box(d, 1, 4, 0, 24, 10, 22, mat);
      box(d, 4, 4 + L, 20, 22, 10, 22, mat);
      if (findFalling(d.field, d.material, 0, 1, 0).some((c) => c.reason === 'overhang')) {
        return L * VOXEL;
      }
    }
    return Infinity;
  };
  const soil = firstFailure(Mat.TOPSOIL);
  const rock = firstFailure(Mat.SANDSTONE);
  assert.ok(soil < rock, `topsoil should fail sooner than sandstone; ${soil} m vs ${rock} m`);
  assert.ok(Number.isFinite(rock), 'even sandstone must fail eventually');
});

test('the sweep condemns nothing in the procedural terrain', () => {
  // The scoping result the design rests on: natural terrain contains no detached
  // bodies, so only edited chunks need scanning — and the sweep must not start
  // eating the landscape the moment it is switched on.
  const buf = allocChunkField();
  let clusters = 0;
  let scanned = 0;
  for (let cx = 0; cx < 4; cx++) {
    for (let cz = 0; cz < 4; cz++) {
      for (let cy = 0; cy < 3; cy++) {
        fillChunkField(buf, cx, cy, cz, SEED, CHUNK);
        clusters += findFalling(buf.field, buf.material, cx, cy, cz).length;
        scanned++;
      }
    }
  }
  assert.equal(scanned, 48);
  assert.equal(clusters, 0, 'the natural landscape must not be condemned');
});

test('a cluster reports the dominant material, which drives its bulking', () => {
  const d = emptyField();
  box(d, 14, 18, 14, 18, 14, 18, Mat.GRANITE);
  put(d, 14, 14, 14, Mat.CLAY);
  const [c] = findFalling(d.field, d.material, 0, 1, 0);
  assert.ok(c);
  assert.equal(c.mat, Mat.GRANITE);
  assert.ok(materialProps(c.mat).bulking > 1);
});

// ------------------------------------------------------------ application ----

/** Minimal World-shaped stub that records the brushes it is handed. */
function recorder() {
  const brushes: unknown[] = [];
  return {
    brushes,
    applyBrush(b: unknown) {
      brushes.push(b);
      return [{}];
    },
    raycast() {
      return { x: 0, y: 0, z: 0 };
    },
  };
}

test('applying a fall removes the rock and deposits bulked rubble', () => {
  const cluster: FallingCluster = {
    x: 4, y: 20, z: 4, voxels: 200, volume: 25,
    radius: 1.8, ex: 1, ey: 1, ez: 1, mat: Mat.SANDSTONE, reason: 'detached',
  };
  const rec = recorder();
  const out = applyFalling(rec, [cluster], null, []);
  assert.equal(out.clustersApplied, 1);
  assert.equal(out.clustersSkipped, 0);
  assert.ok(out.brushes >= 2, 'expected at least a removal and a rubble pile');
  const ops = rec.brushes as { op: string; mat: number }[];
  assert.ok(ops.some((b) => b.op === 'sub'), 'the rock must be removed');
  const pile = ops.find((b) => b.op === 'add');
  assert.ok(pile, 'the debris must land somewhere');
  assert.equal(pile.mat, Mat.RUBBLE, 'what lands is rubble, not intact rock');
});

test('supported openings are exempt, so lining a tunnel actually protects it', () => {
  // Otherwise the overhang sweep condemns the roof of a heading the player just
  // supported, which is indistinguishable from the support not working.
  const cluster: FallingCluster = {
    x: 0, y: 20, z: 0, voxels: 200, volume: 25,
    radius: 1.8, ex: 1, ey: 1, ez: 1, mat: Mat.SANDSTONE, reason: 'overhang',
  };
  const rec = recorder();
  const out = applyFalling(rec, [cluster], null, [{ center: [0, 20, 0], span: 6, cover: 8 }]);
  assert.equal(out.clustersApplied, 0);
  assert.equal(out.clustersSkipped, 1);
  assert.equal(rec.brushes.length, 0, 'a protected opening must not be touched');
});

test('a tracked opening owns its own roof, whatever its state', () => {
  // The sweep and the tunnel sim must not both judge the same rock. The sweep has
  // no timer, so if it were allowed near a heading it would demolish the roof of a
  // fresh wide heading in soil within one remesh — before the stand-up clock could
  // run, and with none of the cracking/convergence warnings that make a collapse
  // legible. Every non-collapsed opening is therefore off limits, not just the
  // supported ones.
  const cluster: FallingCluster = {
    x: 0, y: 20, z: 0, voxels: 400, volume: 50,
    radius: 2.3, ex: 4.5, ey: 1, ez: 4.5, mat: Mat.TOPSOIL, reason: 'overhang',
  };
  for (const span of [6, 9]) {
    const rec = recorder();
    const out = applyFalling(rec, [cluster], null, [{ center: [0, 20, 0], span, cover: 8 }]);
    assert.equal(out.clustersApplied, 0, `a ${span} m opening's roof must be left to the tunnel sim`);
    assert.equal(rec.brushes.length, 0);
  }
  // ...but rock well away from any opening is still fair game.
  const far = recorder();
  const out = applyFalling(far, [{ ...cluster, x: 60 }], null, [{ center: [0, 20, 0], span: 9, cover: 8 }]);
  assert.equal(out.clustersApplied, 1, 'rock no mechanic owns must still fall');
});

test('the whole cover column above an opening is off limits, not just the roof', () => {
  // The failure this guards against: with a ball-shaped protection region the rock
  // immediately above a heading was spared but the rock above *that* was not, so
  // the sweep ate the cover from the top down over successive rounds until the
  // heading had no roof left. It then read as an open cut and never collapsed —
  // silently replacing the tunnel mechanic with nothing.
  const opening = { center: [0, 20, 0] as [number, number, number], span: 6, cover: 12 };
  // Slabs at increasing heights, all within the cover above the opening.
  for (const height of [4, 8, 12, 16]) {
    const rec = recorder();
    const cluster: FallingCluster = {
      x: 0, y: 20 + height, z: 0, voxels: 300, volume: 37.5,
      radius: 2.1, ex: 3, ey: 0.75, ez: 3, mat: Mat.SAND, reason: 'overhang',
    };
    const out = applyFalling(rec, [cluster], null, [opening]);
    assert.equal(out.clustersApplied, 0, `rock ${height} m above the opening must be left alone`);
  }
  // Above daylight, or well to the side, the sweep is free again.
  const outside = recorder();
  const far = applyFalling(
    outside,
    [{
      x: 40, y: 24, z: 0, voxels: 300, volume: 37.5,
      radius: 2.1, ex: 3, ey: 0.75, ez: 3, mat: Mat.SAND, reason: 'overhang',
    }],
    null,
    [opening],
  );
  assert.equal(far.clustersApplied, 1, 'rock outside the column is still the sweep\'s business');
});

test('debris is spawned for a fall when a sink is provided', () => {
  const cluster: FallingCluster = {
    x: 4, y: 20, z: 4, voxels: 200, volume: 25,
    radius: 1.8, ex: 1, ey: 1, ez: 1, mat: Mat.CLAY, reason: 'detached',
  };
  let bursts = 0;
  applyFalling(recorder(), [cluster], { spawnBurst: () => { bursts++; } }, []);
  assert.equal(bursts, 1);
});

// -------------------------------------------------------------- end to end ---

test('undercutting terrain makes it fall, and the cascade converges', async () => {
  const world = new World(SEED, new SyncMeshPool(), { radiusXZ: 4, minCy: -3, maxCy: 3 });
  const centre: [number, number, number] = [0, 20, 0];
  let pending: FallingCluster[] = [];
  world.setFallingListener((cs) => pending.push(...cs));
  world.updateStreaming(centre);

  const drain = async (): Promise<void> => {
    for (let i = 0; i < 9000; i++) {
      world.pump(centre);
      await Promise.resolve();
      await Promise.resolve();
      const s = world.stats();
      if (s.pendingGenerate === 0 && s.queuedRemesh === 0 && s.ready === s.chunks) return;
    }
    throw new Error('world did not settle');
  };

  await drain();
  assert.equal(pending.length, 0, 'generation alone must not condemn anything');

  // Undercut a 20 x 20 m area four metres below the surface, severing the crust.
  const surf = surfaceHeight(0, 0, SEED);
  for (let dx = -10; dx <= 10; dx += 2) {
    world.applyBrush(makeBrush.bore([dx, surf - 4, -10], [dx, surf - 4, 10], 2.2));
  }
  await drain();
  assert.ok(pending.length > 0, 'undercut rock must be found to be unsupported');

  // Run the fall to completion. It must terminate: an unbounded cascade would
  // eat the map, and the volume falling per round must decay.
  let rounds = 0;
  let total = 0;
  let lastVolume = Infinity;
  let decayed = 0;
  while (pending.length > 0) {
    rounds++;
    assert.ok(rounds < 40, 'the cascade must converge');
    const batch = pending;
    pending = [];
    const out = applyFalling(world, batch, null, []);
    total += out.volume;
    if (out.volume < lastVolume) decayed++;
    lastVolume = out.volume;
    await drain();
  }
  assert.ok(total > 0, 'rock must actually have fallen');
  assert.ok(rounds >= 2, 'a large undercut should crumble over several rounds, not vanish at once');
  assert.ok(decayed >= rounds - 2, 'the volume falling per round should trend downward');
  world.dispose();
});
