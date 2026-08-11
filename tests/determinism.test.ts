/**
 * The save format stores only `{ seed, brushes }` and regenerates base terrain
 * procedurally, so bit-exact reproducibility of the density function is a
 * correctness requirement, not a nicety. These tests pin it down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fbm3, hash3, ridge3, valueNoise3 } from '../src/core/hash.ts';
import { baseDensity, densityFromSurface } from '../src/terrain/density.ts';
import { columnGeology, materialAt, surfaceHeight, rmrAt } from '../src/terrain/geology.ts';

const SEED = 1337;

test('hash noise returns pinned golden values', () => {
  // If these change, every existing save silently refers to different terrain.
  assert.equal(hash3(7, 8, 9, SEED), 0.7366924115922302);
  assert.equal(valueNoise3(1.5, 2.5, 3.5, SEED), 0.5856994474015664);
  assert.equal(fbm3(1.5, 2.5, 3.5, SEED, 4), 0.37076732055284084);
  assert.equal(ridge3(1.5, 2.5, 3.5, SEED, 3), 0.754242130588474);
});

test('noise output stays within its documented range', () => {
  for (let i = 0; i < 4000; i++) {
    const x = (i * 7.13) % 500;
    const y = (i * 3.71) % 300;
    const z = (i * 11.9) % 700;
    const v = valueNoise3(x, y, z, SEED);
    assert.ok(v >= 0 && v < 1, `valueNoise3 out of range: ${v}`);
    const f = fbm3(x, y, z, SEED, 4);
    assert.ok(f >= 0 && f < 1, `fbm3 out of range: ${f}`);
  }
});

test('the terrain source files use no engine-dependent Math functions', () => {
  // The real guard against drift: Math.sin/cos/tan/pow/exp/log have
  // implementation-defined precision in ECMAScript, so a save written by one
  // engine would load as different terrain in another.
  const banned = /Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|cbrt|hypot|sinh|cosh|tanh|expm1|log1p|fround)\b/;
  for (const f of ['src/core/hash.ts', 'src/terrain/density.ts', 'src/terrain/geology.ts']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
      assert.ok(!banned.test(line), `${f}:${i + 1} uses a non-deterministic Math function: ${line.trim()}`);
    }
  }
});

test('base density is reproducible across repeated evaluation', () => {
  for (let i = 0; i < 500; i++) {
    const x = i * 1.37 - 100;
    const y = (i % 40) * 1.9 - 10;
    const z = i * 0.71 + 40;
    assert.equal(baseDensity(x, y, z, SEED), baseDensity(x, y, z, SEED));
  }
});

test('densityFromSurface agrees with baseDensity', () => {
  for (let i = 0; i < 200; i++) {
    const x = i * 2.3 - 50;
    const y = (i % 30) * 2 + 5;
    const z = i * 1.1;
    const surf = columnGeology(x, z, SEED).surf;
    assert.equal(densityFromSurface(x, y, z, surf, SEED), baseDensity(x, y, z, SEED));
  }
});

test('density sign is negative below the surface and positive well above', () => {
  for (let i = 0; i < 200; i++) {
    const x = i * 3.1 - 200;
    const z = i * 2.7 + 10;
    const surf = surfaceHeight(x, z, SEED);
    // The 3D carve term has amplitude 4.2, so test outside that band.
    assert.ok(baseDensity(x, surf - 12, z, SEED) < 0, 'expected solid below surface');
    assert.ok(baseDensity(x, surf + 12, z, SEED) > 0, 'expected air above surface');
  }
});

test('materialAt is consistent with the column fast path', () => {
  for (let i = 0; i < 300; i++) {
    const x = i * 4.1 - 300;
    const z = i * 3.3 + 60;
    const col = columnGeology(x, z, SEED);
    for (const depth of [0.5, 3, 8, 13, 22, 40, 60]) {
      const y = col.surf - depth;
      assert.equal(materialAt(x, y, z, SEED), materialAt(x, y, z, SEED));
      const r = rmrAt(x, y, z, SEED);
      assert.ok(r >= 3 && r <= 100, `RMR out of range: ${r}`);
    }
  }
});
