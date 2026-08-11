/**
 * Mesh extraction correctness, above all the property the chunking scheme is
 * designed around: neighbouring chunks must agree on their shared boundary
 * without exchanging any data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELL_HI, CELL_LO, CHUNK, CHUNK_M, FIELD, PAD, VOXEL } from '../src/core/config.ts';
import { allocChunkField, fillChunkField } from '../src/terrain/density.ts';
import { surfaceNets } from '../src/terrain/surfaceNets.ts';

const SEED = 1337;

/** Weld a set of chunk meshes into one indexed mesh, quantising positions. */
function weld(chunks: [number, number, number][], quantum: number) {
  const buf = allocChunkField();
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: [number, number, number][] = [];
  const vid = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
    let i = map.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      map.set(k, i);
      verts.push(x, y, z);
    }
    return i;
  };
  for (const [cx, cy, cz] of chunks) {
    fillChunkField(buf, cx, cy, cz, SEED, CHUNK);
    const m = surfaceNets(buf.field, buf.material);
    const ox = cx * CHUNK_M;
    const oy = cy * CHUNK_M;
    const oz = cz * CHUNK_M;
    for (let i = 0; i < m.indices.length; i += 3) {
      const g = (j: number): [number, number, number] => {
        const v = m.indices[i + j]!;
        return [m.positions[v * 3]! + ox, m.positions[v * 3 + 1]! + oy, m.positions[v * 3 + 2]! + oz];
      };
      tris.push([vid(...g(0)), vid(...g(1)), vid(...g(2))]);
    }
  }
  return { verts, tris };
}

function edgeCounts(tris: [number, number, number][]): Map<string, number> {
  const ec = new Map<string, number>();
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      ec.set(k, (ec.get(k) ?? 0) + 1);
    }
  }
  return ec;
}

test('a chunk owns exactly CHUNK cells per axis', () => {
  assert.equal(CELL_HI - CELL_LO + 1, CHUNK);
  // The field must have a cell below the owned range (for quad corners) and the
  // last owned cell must have both of its samples in range.
  assert.equal(CELL_LO, PAD);
  assert.equal(CELL_HI + 1, FIELD - 1);
});

test('a single chunk produces a non-trivial mesh', () => {
  const buf = allocChunkField();
  fillChunkField(buf, 0, 1, 0, SEED, CHUNK);
  const m = surfaceNets(buf.field, buf.material);
  assert.ok(m.triangleCount > 100, `expected a real surface, got ${m.triangleCount} triangles`);
  assert.equal(m.indices.length, m.triangleCount * 3);
  assert.equal(m.positions.length, m.vertexCount * 3);
  assert.equal(m.normals.length, m.vertexCount * 3);
  assert.equal(m.materials.length, m.vertexCount);
  for (const i of m.indices) assert.ok(i < m.vertexCount, 'index out of range');
});

test('vertices stay inside the chunk plus its padding ring', () => {
  const buf = allocChunkField();
  fillChunkField(buf, 2, 1, -1, SEED, CHUNK);
  const m = surfaceNets(buf.field, buf.material);
  const lo = -PAD * VOXEL - 1e-5;
  const hi = CHUNK_M + PAD * VOXEL + 1e-5;
  for (let i = 0; i < m.vertexCount * 3; i++) {
    assert.ok(m.positions[i]! >= lo && m.positions[i]! <= hi, `vertex out of bounds: ${m.positions[i]}`);
  }
});

test('normals are unit length', () => {
  const buf = allocChunkField();
  fillChunkField(buf, 1, 1, 1, SEED, CHUNK);
  const m = surfaceNets(buf.field, buf.material);
  for (let v = 0; v < m.vertexCount; v++) {
    const x = m.normals[v * 3]!;
    const y = m.normals[v * 3 + 1]!;
    const z = m.normals[v * 3 + 2]!;
    assert.ok(Math.abs(Math.sqrt(x * x + y * y + z * z) - 1) < 1e-4, 'normal not normalised');
  }
});

test('every vertex carries a real material, never air', () => {
  const buf = allocChunkField();
  fillChunkField(buf, 0, 1, 3, SEED, CHUNK);
  const m = surfaceNets(buf.field, buf.material);
  let air = 0;
  for (let v = 0; v < m.vertexCount; v++) if (m.materials[v] === 0) air++;
  assert.equal(air, 0, `${air} vertices were assigned the air material`);
});

test('adjacent chunks mesh watertight across their shared faces', () => {
  // A 2x2x2 block; open edges are allowed on the outside of the block but not
  // in its interior, where every seam must close.
  const chunks: [number, number, number][] = [];
  for (let cx = 0; cx < 2; cx++)
    for (let cy = 1; cy < 3; cy++)
      for (let cz = 0; cz < 2; cz++) chunks.push([cx, cy, cz]);

  const { verts, tris } = weld(chunks, 1e-4);
  const ec = edgeCounts(tris);

  // Interior test region, one voxel inside the block's outer boundary.
  const m = VOXEL * 1.5;
  const inside = (i: number): boolean =>
    verts[i * 3]! > m && verts[i * 3]! < 2 * CHUNK_M - m &&
    verts[i * 3 + 1]! > CHUNK_M + m && verts[i * 3 + 1]! < 3 * CHUNK_M - m &&
    verts[i * 3 + 2]! > m && verts[i * 3 + 2]! < 2 * CHUNK_M - m;

  let open = 0;
  let nonManifold = 0;
  for (const [k, n] of ec) {
    if (n === 2) continue;
    const [u, v] = k.split('_').map(Number) as [number, number];
    if (!(inside(u) && inside(v))) continue;
    if (n === 1) open++;
    else nonManifold++;
  }
  assert.equal(open, 0, `${open} interior edges belong to only one triangle (holes at chunk seams)`);
  assert.equal(nonManifold, 0, `${nonManifold} interior edges belong to more than two triangles`);
  assert.ok(tris.length > 5000, 'expected a substantial surface across 8 chunks');
});

test('no global grid edge is meshed twice or dropped', () => {
  // The seam scheme claims every sign-changing grid edge is emitted by exactly
  // one chunk. Verify it directly rather than inferring it from manifoldness.
  const buf = allocChunkField();
  const emitted = new Map<string, number>();
  for (let cx = 0; cx < 2; cx++) {
    for (let cz = 0; cz < 2; cz++) {
      fillChunkField(buf, cx, 1, cz, SEED, CHUNK);
      const f = buf.field;
      for (let z = CELL_LO; z <= CELL_HI; z++) {
        for (let y = CELL_LO; y <= CELL_HI; y++) {
          for (let x = CELL_LO; x <= CELL_HI; x++) {
            const b = x + y * FIELD + z * FIELD * FIELD;
            const d0 = f[b]!;
            const corners = [
              d0, f[b + 1]!, f[b + FIELD]!, f[b + FIELD + 1]!,
              f[b + FIELD * FIELD]!, f[b + FIELD * FIELD + 1]!,
              f[b + FIELD * FIELD + FIELD]!, f[b + FIELD * FIELD + FIELD + 1]!,
            ];
            let mask = 0;
            for (let c = 0; c < 8; c++) if (corners[c]! < 0) mask |= 1 << c;
            if (mask === 0 || mask === 255) continue;
            const gx = cx * CHUNK + x - PAD;
            const gy = 1 * CHUNK + y - PAD;
            const gz = cz * CHUNK + z - PAD;
            const bump = (ax: string): void => {
              const k = `${ax},${gx},${gy},${gz}`;
              emitted.set(k, (emitted.get(k) ?? 0) + 1);
            };
            if (d0 < 0 !== corners[1]! < 0) bump('x');
            if (d0 < 0 !== corners[2]! < 0) bump('y');
            if (d0 < 0 !== corners[4]! < 0) bump('z');
          }
        }
      }
    }
  }
  assert.ok(emitted.size > 1000, 'expected many crossing edges');
  for (const [k, n] of emitted) {
    assert.equal(n, 1, `grid edge ${k} was claimed by ${n} chunks`);
  }
});
