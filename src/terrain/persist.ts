/**
 * Save and load.
 *
 * The save is `{ seed, chunks }` and nothing else. Base terrain is never stored;
 * it is regenerated from the seed, which is exactly why core/hash.ts refuses to
 * use Math.sin and friends. A chunk appears in the save in one of two forms:
 *
 *   diff  — the list of CSG brushes applied to it, which is tiny
 *   baked — quantised voxels, for chunks whose brush list grew past the bake
 *           threshold and was discarded
 *
 * Baked chunks are the honest cost of bounding reload time: ~118 kB of voxels
 * instead of a few hundred bytes of brushes.
 */
import { FIELD } from '../core/config.ts';
import type { Brush } from './brush.ts';
import { ChunkState, createChunk, parseChunkKey, type Chunk } from './chunk.ts';
import type { World } from './world.ts';

export const SAVE_VERSION = 1;

/**
 * SDF values are clamped to +/- this many metres before quantisation.
 *
 * Only values near zero carry information the renderer needs: the isosurface sits
 * at zero, so anything deeper than a few metres inside rock or out in open air is
 * interchangeable. Clamping costs nothing visually and keeps the quantisation
 * step at 8/32767 = 0.24 mm, which is 2000x finer than a voxel. The one visible
 * consequence is that raymarching takes slightly shorter steps far from the
 * surface, since the distance estimate is capped.
 */
export const SDF_CLAMP = 8;
const SDF_SCALE = 32767 / SDF_CLAMP;

interface SavedDiffChunk {
  k: string;
  brushes: Brush[];
}

interface SavedBakedChunk {
  k: string;
  /** base64 of an Int16Array of quantised SDF values. */
  f: string;
  /** base64 of the material Uint8Array. */
  m: string;
}

export interface SaveData {
  version: number;
  seed: number;
  diff: SavedDiffChunk[];
  baked: SavedBakedChunk[];
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function quantiseField(field: Float32Array): Uint8Array {
  const q = new Int16Array(field.length);
  for (let i = 0; i < field.length; i++) {
    const v = Math.max(-SDF_CLAMP, Math.min(SDF_CLAMP, field[i]!));
    q[i] = Math.round(v * SDF_SCALE);
  }
  return new Uint8Array(q.buffer);
}

function dequantiseField(bytes: Uint8Array): Float32Array {
  // Copy rather than aliasing, because `bytes` may not be 2-byte aligned.
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  const q = new Int16Array(aligned.buffer);
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i]! / SDF_SCALE;
  return out;
}

/** Collect everything needed to reconstruct the player's edits. */
export function serialiseWorld(world: World): SaveData {
  const diff: SavedDiffChunk[] = [];
  const baked: SavedBakedChunk[] = [];
  for (const ch of world.residentChunks()) {
    if (ch.baked) {
      if (!ch.field || !ch.material) continue;
      baked.push({
        k: ch.key,
        f: toBase64(quantiseField(ch.field)),
        m: toBase64(ch.material),
      });
    } else if (ch.brushes.length > 0) {
      diff.push({ k: ch.key, brushes: ch.brushes });
    }
  }
  return { version: SAVE_VERSION, seed: world.seed, diff, baked };
}

export function saveToString(world: World): string {
  return JSON.stringify(serialiseWorld(world));
}

export interface LoadResult {
  seed: number;
  diffChunks: number;
  bakedChunks: number;
  brushes: number;
}

/**
 * Apply a save to a world.
 *
 * The world must already have been constructed with the save's seed; this only
 * restores the diff. Chunks are inserted directly rather than going through
 * applyBrush, because the brush list is already grouped per chunk and replaying
 * it through the dispatcher would duplicate every brush into its neighbours.
 */
export function applySave(world: World, data: SaveData, injectChunk: (ch: Chunk) => void): LoadResult {
  if (data.version !== SAVE_VERSION) {
    throw new Error(`unsupported save version ${data.version} (expected ${SAVE_VERSION})`);
  }
  if (data.seed !== world.seed) {
    // Loading a diff onto a different base terrain would put every brush in the
    // wrong place, so refuse rather than silently corrupting the world.
    throw new Error(`save seed ${data.seed} does not match world seed ${world.seed}`);
  }
  let brushes = 0;
  for (const c of data.diff) {
    const [cx, cy, cz] = parseChunkKey(c.k);
    const ch = createChunk(cx, cy, cz);
    ch.brushes = c.brushes;
    brushes += c.brushes.length;
    injectChunk(ch);
  }
  for (const c of data.baked) {
    const [cx, cy, cz] = parseChunkKey(c.k);
    const ch = createChunk(cx, cy, cz);
    const field = dequantiseField(fromBase64(c.f));
    const material = fromBase64(c.m);
    const expected = FIELD * FIELD * FIELD;
    if (field.length !== expected || material.length !== expected) {
      throw new Error(`baked chunk ${c.k} has ${field.length} samples, expected ${expected}`);
    }
    ch.field = field;
    ch.material = material;
    ch.baked = true;
    ch.state = ChunkState.READY;
    injectChunk(ch);
  }
  return { seed: data.seed, diffChunks: data.diff.length, bakedChunks: data.baked.length, brushes };
}

export function loadFromString(world: World, json: string, injectChunk: (ch: Chunk) => void): LoadResult {
  return applySave(world, JSON.parse(json) as SaveData, injectChunk);
}

const STORAGE_KEY = 'terrain-prototype-save-v1';

export function saveToLocalStorage(world: World): number {
  const s = saveToString(world);
  localStorage.setItem(STORAGE_KEY, s);
  return s.length;
}

export function loadFromLocalStorage(world: World, injectChunk: (ch: Chunk) => void): LoadResult | null {
  const s = localStorage.getItem(STORAGE_KEY);
  if (!s) return null;
  return loadFromString(world, s, injectChunk);
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}
