/**
 * Cost model for the prototype, measured rather than estimated.
 *
 * Run with: npm run bench
 *
 * These are the numbers the feasibility argument rests on, so they are kept as a
 * runnable script rather than a comment: if a change makes chunk generation three
 * times slower, this says so.
 */
import { CHUNK, FIELD, VOXEL } from '../src/core/config.ts';
import { allocChunkField, fillChunkField } from '../src/terrain/density.ts';
import { surfaceNets } from '../src/terrain/surfaceNets.ts';
import { applyBrushToField } from '../src/terrain/chunk.ts';
import { makeBrush } from '../src/terrain/brush.ts';
import { bearingCapacityOfMaterial } from '../src/sim/bearing.ts';
import { surfaceHeight, Mat } from '../src/terrain/geology.ts';

const SEED = 1337;

/** `note` is a thunk so it can report values the benchmark itself produced. */
function time(label, iterations, fn, note = null) {
  // Warm up so the JIT has compiled the hot path before we measure.
  for (let i = 0; i < Math.min(8, iterations); i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
  const per = ms < 0.01 ? `${(ms * 1000).toFixed(1)} us` : `${ms.toFixed(2)} ms`;
  const suffix = typeof note === 'function' ? note() : note;
  console.log(`  ${label.padEnd(34)} ${per.padStart(10)}${suffix ? `   ${suffix}` : ''}`);
  return ms;
}

console.log(`\nchunk = ${CHUNK}^3 cells, voxel = ${VOXEL} m, field = ${FIELD}^3 = ${FIELD ** 3} samples`);
console.log(`chunk covers ${CHUNK * VOXEL} m cubed\n`);

console.log('cold path — a chunk that has never been seen before');
const buf = allocChunkField();
const genMs = time('fillChunkField (procedural base)', 32, (i) => {
  fillChunkField(buf, i % 8, 1, (i / 8) | 0, SEED, CHUNK);
});
let tris = 0;
const meshMs = time('surfaceNets (isosurface)', 32, () => {
  tris = surfaceNets(buf.field, buf.material).triangleCount;
}, () => `${tris} triangles`);
console.log(`  ${'TOTAL per new chunk'.padEnd(34)} ${(genMs + meshMs).toFixed(2).padStart(7)} ms`);
console.log(`  ${'=> per worker'.padEnd(34)} ${(1000 / (genMs + meshMs)).toFixed(0).padStart(7)} chunks/s\n`);

console.log('hot path — editing a chunk that is already resident');
fillChunkField(buf, 0, 1, 0, SEED, CHUNK);
const base = { field: Float32Array.from(buf.field), material: Uint8Array.from(buf.material) };
const y = surfaceHeight(8, 8, SEED) - 4;
const copyMs = time('field copy (for the worker)', 2000, () => {
  buf.field.set(base.field);
  buf.material.set(base.material);
});
const brushMs = time('sphere brush r=2.5 m', 2000, () => {
  applyBrushToField(buf, 0, 1, 0, makeBrush.dig([8, y, 8], 2.5));
});
const remeshMs = time('surfaceNets (remesh)', 200, () => {
  surfaceNets(buf.field, buf.material);
});
const edit = copyMs + brushMs + remeshMs;
console.log(`  ${'TOTAL per edited chunk'.padEnd(34)} ${edit.toFixed(2).padStart(7)} ms`);
console.log(`  ${'a dig spanning 8 chunks'.padEnd(34)} ${(edit * 8).toFixed(2).padStart(7)} ms\n`);

console.log('brush variants (cost is proportional to the AABB, not the world)');
for (const [label, brush] of [
  ['sphere r=2.5', makeBrush.dig([8, y, 8], 2.5)],
  ['sphere r=6', makeBrush.dig([8, y, 8], 6)],
  ['tunnel bore r=3, 16 m', makeBrush.bore([0, y, 8], [16, y, 8], 3)],
  ['road corridor 8 m wide', makeBrush.roadCut([0, y, 8], [16, y, 8], 4, 6)],
  ['collapse cone', makeBrush.roofFall([8, y, 8], 8, 3)],
  ['settlement bowl', makeBrush.settle([8, y, 8], 8, 3)],
]) {
  time(label, 500, () => {
    buf.field.set(base.field);
    applyBrushToField(buf, 0, 1, 0, brush);
  });
}

console.log('\ngeotechnical evaluation (analytic — no field is ever solved)');
time('Terzaghi bearing capacity', 200_000, (i) => {
  bearingCapacityOfMaterial(Mat.SAND, 2 + (i % 100) * 0.01, 1.5);
});
const capMs = (() => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) bearingCapacityOfMaterial(Mat.CLAY, 2 + i * 0.001, 1.5);
  return Number(process.hrtime.bigint() - t0) / 1e6;
})();
console.log(`  ${'1000 footings in one tick'.padEnd(34)} ${capMs.toFixed(3).padStart(7)} ms`);

console.log(`
summary
  A new chunk costs ~${(genMs + meshMs).toFixed(0)} ms and goes to a worker; generation is the
  dominant cost, and it is a one-off per chunk.
  An edit costs ~${edit.toFixed(1)} ms of which the brush itself is ${(brushMs * 1000).toFixed(0)} us — the field is
  cached, so editing does not re-run the procedural base. Re-extraction dominates.
  The geotechnics are free at any scale a player can build to.
`);
