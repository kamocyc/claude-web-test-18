/**
 * Deterministic value noise.
 *
 * IMPORTANT — why this file avoids Math.sin/cos/pow/exp/log entirely:
 *
 * The world is stored as `{ seed, brushes }`; the base terrain is never written
 * to disk and is regenerated procedurally on load. That is only sound if the
 * base density function is bit-for-bit reproducible. ECMAScript leaves the
 * precision of the transcendental Math functions implementation-defined
 * (they are only required to be "an implementation-approximated value"), so
 * their results can differ between JS engines, versions and CPUs. A save made
 * in one browser would then load as subtly different terrain in another, and
 * every brush in the diff would land in the wrong place.
 *
 * Everything here is built from integer arithmetic plus multiply/add and
 * Math.floor, all of which are exactly specified. Math.sqrt is also exactly
 * specified (IEEE-754 correctly rounded) and is therefore safe to use, but is
 * not needed here.
 */

/** 1 / 2^32, as an exact double. */
const INV_U32 = 2.3283064365386963e-10;

/** Integer hash of a 3D lattice point plus a seed, returned in [0, 1). */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 1013904223;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) * INV_U32;
}

/** Integer hash returned in [-1, 1). */
export function hash3s(x: number, y: number, z: number, seed: number): number {
  return hash3(x, y, z, seed) * 2 - 1;
}

/** Trilinearly interpolated value noise with smoothstep fade, in [0, 1). */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  // smoothstep: 3t^2 - 2t^3, written as t*t*(3 - 2t) to avoid Math.pow
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);

  const a = c000 + (c100 - c000) * u;
  const b = c010 + (c110 - c010) * u;
  const c = c001 + (c101 - c001) * u;
  const d = c011 + (c111 - c011) * u;
  const p = a + (b - a) * v;
  const q = c + (d - c) * v;
  return p + (q - p) * w;
}

/** Fractal sum of `octaves` value-noise layers, normalised to [0, 1). */
export function fbm3(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + i * 7919);
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Fractal noise in [-1, 1). */
export function fbm3s(x: number, y: number, z: number, seed: number, octaves: number): number {
  return fbm3(x, y, z, seed, octaves) * 2 - 1;
}

/**
 * Cheap ridged noise, useful for fault traces and rock blobs.
 * Uses Math.abs (exact) rather than any transcendental.
 */
export function ridge3(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise3(x * freq, y * freq, z * freq, seed + i * 6151) * 2 - 1);
    sum += amp * n;
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}
