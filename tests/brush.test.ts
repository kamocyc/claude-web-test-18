/**
 * CSG brush behaviour, and the bake step that folds a long diff into voxels.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK, FIELD, PAD, VOXEL } from '../src/core/config.ts';
import { allocChunkField, fillChunkField } from '../src/terrain/density.ts';
import { applyBrushToField } from '../src/terrain/chunk.ts';
import { brushAabb, brushSdf, makeBrush } from '../src/terrain/brush.ts';
import { surfaceHeight, Mat } from '../src/terrain/geology.ts';

const SEED = 1337;

/** Read a field sample at a world point (nearest sample) for chunk (cx,cy,cz). */
function sampleAt(
  field: Float32Array,
  cx: number, cy: number, cz: number,
  x: number, y: number, z: number,
): number {
  const i = Math.round(x / VOXEL - (cx * CHUNK - PAD));
  const j = Math.round(y / VOXEL - (cy * CHUNK - PAD));
  const k = Math.round(z / VOXEL - (cz * CHUNK - PAD));
  return field[i + j * FIELD + k * FIELD * FIELD]!;
}

test('sphere SDF is zero on its surface and signed correctly', () => {
  const b = makeBrush.dig([10, 20, 30], 4);
  assert.ok(Math.abs(brushSdf(b, 14, 20, 30)) < 1e-9, 'surface should be zero');
  assert.ok(brushSdf(b, 10, 20, 30) < 0, 'centre should be inside');
  assert.ok(brushSdf(b, 20, 20, 30) > 0, 'far point should be outside');
  assert.ok(Math.abs(brushSdf(b, 16, 20, 30) - 2) < 1e-9, 'SDF should measure metres');
});

test('capsule SDF equals the sphere SDF at the segment ends', () => {
  const cap = makeBrush.bore([0, 0, 0], [10, 0, 0], 3);
  assert.ok(Math.abs(brushSdf(cap, -4, 0, 0) - 1) < 1e-9);
  assert.ok(Math.abs(brushSdf(cap, 14, 0, 0) - 1) < 1e-9);
  // Anywhere along the axis the distance is measured from the axis.
  assert.ok(Math.abs(brushSdf(cap, 5, 5, 0) - 2) < 1e-9);
});

test('brush AABBs contain their own surface', () => {
  const brushes = [
    makeBrush.dig([3, 4, 5], 2.5),
    makeBrush.bore([0, 10, 0], [12, 6, 3], 3),
    makeBrush.roadCut([0, 20, 0], [30, 18, 5], 4, 6),
    makeBrush.roofFall([5, 5, 5], 8, 3),
    makeBrush.settle([0, 30, 0], 10, 4),
  ];
  for (const b of brushes) {
    const box = brushAabb(b);
    // Sample the box; any point where the SDF is negative must be inside it.
    for (let i = 0; i < 3000; i++) {
      const x = box.min[0] + ((i * 7.3) % 1) * (box.max[0] - box.min[0]);
      const y = box.min[1] + ((i * 3.1) % 1) * (box.max[1] - box.min[1]);
      const z = box.min[2] + ((i * 11.7) % 1) * (box.max[2] - box.min[2]);
      if (brushSdf(b, x, y, z) < 0) {
        assert.ok(x >= box.min[0] && x <= box.max[0], `${b.kind}: x outside AABB`);
        assert.ok(y >= box.min[1] && y <= box.max[1], `${b.kind}: y outside AABB`);
        assert.ok(z >= box.min[2] && z <= box.max[2], `${b.kind}: z outside AABB`);
      }
    }
  }
});

test('digging makes a solid point air, and filling makes an air point solid', () => {
  const data = allocChunkField();
  fillChunkField(data, 0, 1, 0, SEED, CHUNK);
  // Pick a point safely underground inside chunk (0,1,0): world 8,y,8.
  const surf = surfaceHeight(8, 8, SEED);
  const y = Math.min(surf - 4, 1 * CHUNK * VOXEL + 8);
  assert.ok(sampleAt(data.field, 0, 1, 0, 8, y, 8) < 0, 'test point should start solid');

  applyBrushToField(data, 0, 1, 0, makeBrush.dig([8, y, 8], 3));
  assert.ok(sampleAt(data.field, 0, 1, 0, 8, y, 8) > 0, 'digging should leave air');

  applyBrushToField(data, 0, 1, 0, makeBrush.fill([8, y, 8], 2, Mat.CONCRETE));
  assert.ok(sampleAt(data.field, 0, 1, 0, 8, y, 8) < 0, 'filling should restore solid');
  const i = Math.round(8 / VOXEL - (0 * CHUNK - PAD));
  const j = Math.round(y / VOXEL - (1 * CHUNK - PAD));
  const k = Math.round(8 / VOXEL - (0 * CHUNK - PAD));
  assert.equal(data.material[i + j * FIELD + k * FIELD * FIELD], Mat.CONCRETE,
    'fill should write its own material');
});

test('applyBrushToField reports whether it changed anything', () => {
  const data = allocChunkField();
  fillChunkField(data, 0, 1, 0, SEED, CHUNK);
  // A brush far outside the chunk must be a no-op.
  const far = makeBrush.dig([1000, 1000, 1000], 3);
  assert.equal(applyBrushToField(data, 0, 1, 0, far), false);
  // Digging air that is already air is also a no-op.
  const high = makeBrush.dig([8, surfaceHeight(8, 8, SEED) + 200, 8], 2);
  assert.equal(applyBrushToField(data, 0, 1, 0, high), false);
});

test('replaying a diff reproduces an incrementally edited field exactly', () => {
  // This is what bake and reload depend on: applying brushes to a freshly
  // generated base must equal having applied them as they arrived.
  const brushes = [
    makeBrush.dig([6, 20, 6], 3),
    makeBrush.fill([9, 18, 7], 2),
    makeBrush.bore([2, 16, 8], [14, 16, 8], 2.5),
    makeBrush.roofFall([8, 14, 8], 6, 2.5),
    makeBrush.settle([8, 26, 8], 7, 3),
  ];

  const incremental = allocChunkField();
  fillChunkField(incremental, 0, 1, 0, SEED, CHUNK);
  for (const b of brushes) applyBrushToField(incremental, 0, 1, 0, b);

  const replayed = allocChunkField();
  fillChunkField(replayed, 0, 1, 0, SEED, CHUNK);
  for (const b of brushes) applyBrushToField(replayed, 0, 1, 0, b);

  assert.deepEqual(Array.from(replayed.field), Array.from(incremental.field));
  assert.deepEqual(Array.from(replayed.material), Array.from(incremental.material));
});

test('brush order matters and is preserved', () => {
  const p: [number, number, number] = [8, 20, 8];
  const dig = makeBrush.dig(p, 3);
  const fill = makeBrush.fill(p, 3);

  const digThenFill = allocChunkField();
  fillChunkField(digThenFill, 0, 1, 0, SEED, CHUNK);
  applyBrushToField(digThenFill, 0, 1, 0, dig);
  applyBrushToField(digThenFill, 0, 1, 0, fill);

  const fillThenDig = allocChunkField();
  fillChunkField(fillThenDig, 0, 1, 0, SEED, CHUNK);
  applyBrushToField(fillThenDig, 0, 1, 0, fill);
  applyBrushToField(fillThenDig, 0, 1, 0, dig);

  assert.ok(sampleAt(digThenFill.field, 0, 1, 0, ...p) < 0, 'dig then fill leaves solid');
  assert.ok(sampleAt(fillThenDig.field, 0, 1, 0, ...p) > 0, 'fill then dig leaves air');
});
