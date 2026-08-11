/**
 * Save/load round-trip.
 *
 * The design's central storage claim is that only `{ seed, brushes }` needs to be
 * written, because the base terrain is reproducible. These tests check that a
 * loaded world really is identical to the one that was saved — the property that
 * would otherwise fail silently and only show up as terrain that shifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAKE_THRESHOLD, CHUNK, FIELD } from '../src/core/config.ts';
import { World } from '../src/terrain/world.ts';
import { SyncMeshPool } from '../src/terrain/workerPool.ts';
import { makeBrush } from '../src/terrain/brush.ts';
import { applySave, serialiseWorld, saveToString, SDF_CLAMP } from '../src/terrain/persist.ts';
import { surfaceHeight, Mat } from '../src/terrain/geology.ts';
import { allocChunkField, fillChunkField } from '../src/terrain/density.ts';
import { applyBrushToField } from '../src/terrain/chunk.ts';

const SEED = 1337;

async function drain(world: World, center: [number, number, number]): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    world.pump(center);
    await Promise.resolve();
    await Promise.resolve();
    const s = world.stats();
    if (s.pendingGenerate === 0 && s.ready === s.chunks) return;
  }
  throw new Error('world did not finish generating');
}

async function makeWorld(center: [number, number, number]): Promise<World> {
  const world = new World(SEED, new SyncMeshPool(), { radiusXZ: 1, minCy: 0, maxCy: 2 });
  world.updateStreaming(center);
  await drain(world, center);
  return world;
}

test('an unedited world saves as nothing at all', async () => {
  const world = await makeWorld([8, 20, 8]);
  const save = serialiseWorld(world);
  assert.equal(save.diff.length, 0, 'no edits means no chunks to store');
  assert.equal(save.baked.length, 0);
  assert.equal(save.seed, SEED);
  // The entire world is a seed. That is the whole point.
  assert.ok(saveToString(world).length < 100, 'an untouched world should be tiny');
  world.dispose();
});

test('edits round-trip through save and load, field for field', async () => {
  const center: [number, number, number] = [8, 20, 8];
  const original = await makeWorld(center);
  const surf = surfaceHeight(8, 8, SEED);
  const brushes = [
    makeBrush.dig([8, surf - 2, 8], 4),
    makeBrush.fill([10, surf - 4, 9], 2.5, Mat.FILL),
    makeBrush.bore([2, surf - 10, 8], [14, surf - 10, 8], 2.5),
    makeBrush.roofFall([8, surf - 13, 8], 5, 2.2),
  ];
  for (const b of brushes) original.applyBrush(b);
  await drain(original, center);

  const save = serialiseWorld(original);
  assert.ok(save.diff.length > 0, 'edits must be recorded');

  // Load into a fresh world and generate it from the seed plus the diff.
  const loaded = new World(SEED, new SyncMeshPool(), { radiusXZ: 1, minCy: 0, maxCy: 2 });
  const result = applySave(loaded, save, (ch) => loaded.injectChunk(ch));
  assert.equal(result.seed, SEED);
  loaded.updateStreaming(center);
  await drain(loaded, center);

  // Compare every resident chunk's field and material, sample by sample.
  let compared = 0;
  for (const a of original.residentChunks()) {
    if (!a.field || !a.material) continue;
    const b = loaded.getChunk(a.cx, a.cy, a.cz);
    assert.ok(b?.field && b.material, `chunk ${a.key} missing after load`);
    assert.deepEqual(Array.from(b.field), Array.from(a.field), `field mismatch in chunk ${a.key}`);
    assert.deepEqual(Array.from(b.material), Array.from(a.material), `material mismatch in ${a.key}`);
    compared++;
  }
  assert.ok(compared > 5, `expected to compare several chunks, compared ${compared}`);
  original.dispose();
  loaded.dispose();
});

test('loading a save onto the wrong seed is refused', async () => {
  const world = await makeWorld([8, 20, 8]);
  world.applyBrush(makeBrush.dig([8, surfaceHeight(8, 8, SEED) - 2, 8], 3));
  const save = serialiseWorld(world);
  const other = new World(SEED + 1, new SyncMeshPool(), { radiusXZ: 1, minCy: 0, maxCy: 2 });
  assert.throws(
    () => applySave(other, save, (ch) => other.injectChunk(ch)),
    /seed/,
    'a diff applied to different base terrain would land in the wrong place',
  );
  world.dispose();
  other.dispose();
});

test('an unknown save version is refused rather than misread', async () => {
  const world = await makeWorld([8, 20, 8]);
  const save = serialiseWorld(world);
  assert.throws(
    () => applySave(world, { ...save, version: 999 }, () => {}),
    /version/,
  );
  world.dispose();
});

test('a chunk past the bake threshold stores voxels and reloads identically', async () => {
  const center: [number, number, number] = [8, 20, 8];
  const original = await makeWorld(center);
  const surf = surfaceHeight(8, 8, SEED);

  // Enough small digs in one chunk to trip the bake threshold.
  for (let i = 0; i < BAKE_THRESHOLD + 6; i++) {
    const t = i / (BAKE_THRESHOLD + 6);
    original.applyBrush(makeBrush.dig([6 + t * 4, surf - 3 - t * 4, 6 + t * 3], 1.2));
  }
  await drain(original, center);

  const save = serialiseWorld(original);
  assert.ok(save.baked.length > 0, 'the heavily edited chunk should have baked');
  assert.ok(original.stats().bakedChunks > 0);

  const loaded = new World(SEED, new SyncMeshPool(), { radiusXZ: 1, minCy: 0, maxCy: 2 });
  applySave(loaded, save, (ch) => loaded.injectChunk(ch));
  loaded.updateStreaming(center);
  await drain(loaded, center);

  for (const a of original.residentChunks()) {
    if (!a.baked || !a.field) continue;
    const b = loaded.getChunk(a.cx, a.cy, a.cz);
    assert.ok(b?.field, `baked chunk ${a.key} missing after load`);
    assert.equal(b.baked, true, 'a baked chunk must load as baked');
    // Quantisation is lossy by design in two ways, and both must be harmless:
    //  - values are clamped to +/- SDF_CLAMP, which only affects samples far
    //    from any surface, where the exact magnitude is not used;
    //  - values are stored as int16, giving a 0.24 mm step.
    // So: near the isosurface the field must be essentially exact, and the sign
    // must be preserved everywhere, because the sign is what defines solidity.
    let maxNearErr = 0;
    let signFlips = 0;
    for (let i = 0; i < a.field.length; i++) {
      const orig = a.field[i]!;
      const back = b.field[i]!;
      if (orig < 0 !== back < 0) signFlips++;
      if (Math.abs(orig) < SDF_CLAMP - 0.01) {
        maxNearErr = Math.max(maxNearErr, Math.abs(orig - back));
      }
    }
    assert.equal(signFlips, 0, `${signFlips} samples changed solidity across a save`);
    assert.ok(maxNearErr < 0.001,
      `field error near the surface was ${maxNearErr} m, expected sub-millimetre`);
  }
  original.dispose();
  loaded.dispose();
});

test('baking does not change the field it folds', () => {
  // Bake is bookkeeping only: the voxels already contain every brush, so the
  // field must be untouched by the act of discarding the brush list.
  const data = allocChunkField();
  fillChunkField(data, 0, 1, 0, SEED, CHUNK);
  const brushes = [];
  for (let i = 0; i < BAKE_THRESHOLD + 4; i++) {
    brushes.push(makeBrush.dig([5 + (i % 7), 18 + (i % 5), 6 + (i % 6)], 1.4));
  }
  for (const b of brushes) applyBrushToField(data, 0, 1, 0, b);
  const snapshot = Float32Array.from(data.field);
  // Replaying from a fresh base must reproduce it, which is what makes it safe
  // to keep only the voxels and throw the list away.
  const again = allocChunkField();
  fillChunkField(again, 0, 1, 0, SEED, CHUNK);
  for (const b of brushes) applyBrushToField(again, 0, 1, 0, b);
  assert.deepEqual(Array.from(again.field), Array.from(snapshot));
  assert.equal(snapshot.length, FIELD * FIELD * FIELD);
});
