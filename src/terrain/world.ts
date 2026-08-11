/**
 * The chunk world: streaming, edit routing, baking and the remesh budget.
 *
 * Layer model (the hybrid from the design):
 *   1. base   — procedural, never stored, regenerated on demand
 *   2. diff   — a list of CSG brushes per chunk, the only thing that is saved
 *   3. bake   — once a chunk's diff grows past BAKE_THRESHOLD it is folded into
 *               the voxels and the list is dropped, so reload cost stays bounded
 */
import {
  BAKE_THRESHOLD,
  CHUNK_M,
  REMESH_BUDGET_PER_FRAME,
  STREAM_MAX_CY,
  STREAM_MIN_CY,
  STREAM_RADIUS_XZ,
  VOXEL,
} from '../core/config.ts';
import { brushAabb, type Brush } from './brush.ts';
import {
  ChunkState,
  chunkKey,
  chunkRangeForAabb,
  createChunk,
  applyBrushToField,
  sampleChunkField,
  sampleChunkMaterial,
  type Chunk,
  type ChunkKey,
} from './chunk.ts';
import { MeshWorkerPool, type MeshPool } from './workerPool.ts';
import type { MeshResult } from './meshWorker.ts';
import type { FallingCluster } from '../sim/detach.ts';

/** A finished mesh handed to the renderer. */
export interface ChunkMesh {
  key: ChunkKey;
  cx: number;
  cy: number;
  cz: number;
  positions: Float32Array;
  normals: Float32Array;
  materials: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
}

export interface WorldStats {
  chunks: number;
  ready: number;
  pendingGenerate: number;
  queuedRemesh: number;
  workerQueue: number;
  triangles: number;
  brushes: number;
  bakedChunks: number;
}

/** How much of the world is kept resident around the camera. */
export interface StreamingExtent {
  /** Horizontal radius, in chunks. */
  radiusXZ: number;
  /** Inclusive vertical chunk range. */
  minCy: number;
  maxCy: number;
}

export const DEFAULT_EXTENT: StreamingExtent = {
  radiusXZ: STREAM_RADIUS_XZ,
  minCy: STREAM_MIN_CY,
  maxCy: STREAM_MAX_CY,
};

export class World {
  readonly seed: number;
  /** Streaming extent; tests shrink this so a world can be built synchronously. */
  extent: StreamingExtent;
  private chunks = new Map<ChunkKey, Chunk>();
  private pool: MeshPool;
  /** Chunks whose field changed and which still need a new mesh. */
  private remeshQueue: ChunkKey[] = [];
  /** Meshes finished this frame, drained by the renderer. */
  private completed: ChunkMesh[] = [];
  private generating = new Set<ChunkKey>();
  private triangleCount = new Map<ChunkKey, number>();
  private onMeshReady: ((m: ChunkMesh) => void) | null = null;
  private onFalling: ((c: FallingCluster[]) => void) | null = null;

  /**
   * @param pool  Mesh backend. Defaults to a Worker pool; tests and headless
   *              runs pass a SyncMeshPool instead.
   */
  constructor(seed: number, pool?: MeshPool, extent?: Partial<StreamingExtent>) {
    this.seed = seed;
    this.pool = pool ?? new MeshWorkerPool();
    this.extent = { ...DEFAULT_EXTENT, ...extent };
  }

  setMeshListener(cb: (m: ChunkMesh) => void): void {
    this.onMeshReady = cb;
  }

  /**
   * Called with rock the mesh worker found to be unsupported. The world does not
   * act on it itself: turning a finding into terrain change means spawning debris
   * and consulting the tunnel sim, which are the caller's concerns.
   */
  setFallingListener(cb: (c: FallingCluster[]) => void): void {
    this.onFalling = cb;
  }

  getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy, cz));
  }

  /**
   * Insert a chunk wholesale, replacing any existing one at that key.
   * Used by the loader; a chunk arriving this way already has its diff (or its
   * baked voxels) and must not be regenerated from the bare seed.
   */
  injectChunk(ch: Chunk): void {
    this.chunks.set(ch.key, ch);
    this.generating.delete(ch.key);
    if (ch.state === ChunkState.READY && ch.field) {
      // Baked chunk loaded straight from voxels: it still needs a mesh.
      this.queueRemesh(ch);
    }
  }

  /** Forget every chunk and its edits. Used when loading a save. */
  reset(): void {
    this.chunks.clear();
    this.triangleCount.clear();
    this.generating.clear();
    this.remeshQueue.length = 0;
    this.completed.length = 0;
  }

  /** All chunks that currently hold a field. */
  residentChunks(): Iterable<Chunk> {
    return this.chunks.values();
  }

  /**
   * Ensure every chunk within the streaming volume around `center` exists and is
   * queued for generation. Chunks outside the volume are dropped.
   */
  updateStreaming(center: readonly [number, number, number]): void {
    const ccx = Math.floor(center[0] / CHUNK_M);
    const ccz = Math.floor(center[2] / CHUNK_M);
    const { radiusXZ: r, minCy, maxCy } = this.extent;
    const wanted = new Set<ChunkKey>();

    for (let cz = ccz - r; cz <= ccz + r; cz++) {
      for (let cx = ccx - r; cx <= ccx + r; cx++) {
        const dx = cx - ccx;
        const dz = cz - ccz;
        if (dx * dx + dz * dz > r * r) continue; // circular, not square
        for (let cy = minCy; cy <= maxCy; cy++) {
          const k = chunkKey(cx, cy, cz);
          wanted.add(k);
          if (!this.chunks.has(k)) {
            this.chunks.set(k, createChunk(cx, cy, cz));
          }
        }
      }
    }

    // Evict chunks that left the volume, but never one carrying unsaved edits:
    // its field is the only copy of a baked diff.
    for (const [k, ch] of this.chunks) {
      if (wanted.has(k)) continue;
      if (ch.baked || ch.brushes.length > 0) continue;
      this.chunks.delete(k);
      this.triangleCount.delete(k);
      this.generating.delete(k);
    }
  }

  /**
   * Kick off generation for pending chunks, nearest first, and push queued
   * remeshes to the workers. Call once per frame.
   */
  pump(center: readonly [number, number, number]): void {
    // Remeshes first: they are edits the player is watching happen.
    let budget = REMESH_BUDGET_PER_FRAME;
    while (budget > 0 && this.remeshQueue.length > 0) {
      const k = this.remeshQueue.shift()!;
      const ch = this.chunks.get(k);
      if (!ch || !ch.field || !ch.material) continue;
      ch.remeshQueued = false;
      this.submitRemesh(ch);
      budget--;
    }

    // Then generation, closest chunk first so the view fills in from the centre.
    //
    // Keep a deep-ish backlog per worker rather than just one or two jobs. pump()
    // runs once per frame, so a shallow backlog ties chunk throughput to the frame
    // rate: at 10 fps with 3 workers and 14 ms jobs, the queue drains in ~40 ms and
    // then every worker sits idle for the remaining 60 ms of the frame. Measured at
    // 17 chunks/s with a 2x backlog versus 3 workers' theoretical ~200/s. A deeper
    // queue costs only the ordering precision of "nearest first", which is
    // re-evaluated every frame anyway.
    const inFlightTarget = this.pool.size * 8;
    const free = inFlightTarget - this.pool.busy - this.pool.queueLength;
    if (free <= 0) return;
    const candidates: { ch: Chunk; d2: number }[] = [];
    for (const ch of this.chunks.values()) {
      if (ch.state !== ChunkState.PENDING || this.generating.has(ch.key)) continue;
      const cxm = (ch.cx + 0.5) * CHUNK_M - center[0];
      const cym = (ch.cy + 0.5) * CHUNK_M - center[1];
      const czm = (ch.cz + 0.5) * CHUNK_M - center[2];
      candidates.push({ ch, d2: cxm * cxm + cym * cym + czm * czm });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < Math.min(free, candidates.length); i++) {
      this.submitGenerate(candidates[i]!.ch);
    }
  }

  private submitGenerate(ch: Chunk): void {
    this.generating.add(ch.key);
    const version = ch.version;
    this.pool
      .generate(ch.cx, ch.cy, ch.cz, this.seed, ch.brushes.slice())
      .then((r) => {
        this.generating.delete(ch.key);
        // The chunk may have been evicted or edited while the worker ran.
        if (!this.chunks.has(ch.key)) return;
        ch.field = r.field ?? null;
        ch.material = r.material ?? null;
        ch.state = ChunkState.READY;
        if (ch.version !== version) {
          // Edits landed while generating; the field we just got already has
          // the brushes that were known at submit time, and any newer brush was
          // applied to a null field and therefore lost — so redo it.
          this.queueRemesh(ch);
          return;
        }
        this.deliver(ch, r);
      })
      .catch((e) => {
        this.generating.delete(ch.key);
        console.error('chunk generate failed', ch.key, e);
      });
  }

  private submitRemesh(ch: Chunk): void {
    const version = ch.version;
    // Copy: the buffers are transferred to the worker, and the main thread must
    // keep its authoritative field so the next edit does not have to wait.
    this.pool
      .remesh(ch.cx, ch.cy, ch.cz, ch.field!.slice(), ch.material!.slice())
      .then((r) => {
        if (!this.chunks.has(ch.key)) return;
        if (ch.version !== version) return; // stale, a newer remesh is queued
        this.deliver(ch, r);
        if (r.falling && r.falling.length > 0 && this.onFalling) this.onFalling(r.falling);
      })
      .catch((e) => console.error('chunk remesh failed', ch.key, e));
  }

  private deliver(ch: Chunk, r: MeshResult): void {
    ch.meshedVersion = ch.version;
    this.triangleCount.set(ch.key, r.triangleCount);
    const mesh: ChunkMesh = {
      key: ch.key,
      cx: ch.cx,
      cy: ch.cy,
      cz: ch.cz,
      positions: r.positions,
      normals: r.normals,
      materials: r.materials,
      indices: r.indices,
      triangleCount: r.triangleCount,
    };
    if (this.onMeshReady) this.onMeshReady(mesh);
    else this.completed.push(mesh);
  }

  /** Drain meshes finished since the last call (when no listener is set). */
  drainCompleted(): ChunkMesh[] {
    const out = this.completed;
    this.completed = [];
    return out;
  }

  private queueRemesh(ch: Chunk): void {
    ch.version++;
    if (!ch.remeshQueued) {
      ch.remeshQueued = true;
      this.remeshQueue.push(ch.key);
    }
  }

  /**
   * Apply a brush to the world.
   *
   * Returns the chunks that changed. Chunks that are not yet resident record the
   * brush in their diff and pick it up when they generate; resident chunks get
   * the brush applied straight to their cached field, which is the fast path.
   */
  applyBrush(b: Brush): Chunk[] {
    const aabb = brushAabb(b);
    const range = chunkRangeForAabb(aabb.min, aabb.max);
    const touched: Chunk[] = [];

    for (let cz = range.z0; cz <= range.z1; cz++) {
      for (let cy = range.y0; cy <= range.y1; cy++) {
        for (let cx = range.x0; cx <= range.x1; cx++) {
          const k = chunkKey(cx, cy, cz);
          let ch = this.chunks.get(k);
          if (!ch) {
            // Outside the streaming volume: still record the edit, so that
            // walking back to it later shows the change.
            ch = createChunk(cx, cy, cz);
            this.chunks.set(k, ch);
          }
          if (!ch.baked) ch.brushes.push(b);
          if (ch.field && ch.material) {
            const changed = applyBrushToField(
              { field: ch.field, material: ch.material },
              cx,
              cy,
              cz,
              b,
            );
            if (!changed && ch.brushes.length > 0 && !ch.baked) {
              // The brush's AABB reached this chunk but nothing actually moved;
              // do not keep it in the diff or force a remesh.
              ch.brushes.pop();
              continue;
            }
            this.queueRemesh(ch);
            this.maybeBake(ch);
            touched.push(ch);
          } else {
            touched.push(ch);
          }
        }
      }
    }
    return touched;
  }

  /**
   * Fold a long diff into the voxels and drop the brush list.
   *
   * The field already has every brush applied, so baking is purely bookkeeping:
   * it bounds the cost of regenerating this chunk later. The price is that the
   * chunk must now persist its voxels rather than a compact brush list.
   */
  private maybeBake(ch: Chunk): void {
    if (ch.baked || ch.brushes.length < BAKE_THRESHOLD) return;
    ch.brushes.length = 0;
    ch.baked = true;
  }

  /** Density at a world point, from resident chunks. null if not loaded. */
  sampleDensity(x: number, y: number, z: number): number | null {
    const cx = Math.floor(x / CHUNK_M);
    const cy = Math.floor(y / CHUNK_M);
    const cz = Math.floor(z / CHUNK_M);
    const ch = this.getChunk(cx, cy, cz);
    if (!ch) return null;
    return sampleChunkField(ch, x, y, z);
  }

  /** Material id at a world point, from resident chunks. null if not loaded. */
  sampleMaterial(x: number, y: number, z: number): number | null {
    const cx = Math.floor(x / CHUNK_M);
    const cy = Math.floor(y / CHUNK_M);
    const cz = Math.floor(z / CHUNK_M);
    const ch = this.getChunk(cx, cy, cz);
    if (!ch) return null;
    return sampleChunkMaterial(ch, x, y, z);
  }

  /**
   * Raymarch the density field. Returns the first point where the field turns
   * negative, or null if the ray leaves the loaded volume first.
   *
   * Uses the SDF directly rather than a BVH over the meshes: the field *is* a
   * distance estimate, so this is a handful of samples per hit and needs no
   * acceleration structure to maintain as the terrain deforms.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist = 400,
  ): { x: number; y: number; z: number; dist: number; material: number } | null {
    let t = 0;
    let misses = 0;
    while (t < maxDist) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      const d = this.sampleDensity(x, y, z);
      if (d === null) {
        // Not loaded here; step by a chunk and keep going, but give up if the
        // ray spends too long outside the resident set.
        t += CHUNK_M * 0.5;
        if (++misses > 200) return null;
        continue;
      }
      if (d < 0) {
        // Bisect back to the surface for a clean hit point.
        let lo = Math.max(0, t - VOXEL * 2);
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          const dm = this.sampleDensity(ox + dx * mid, oy + dy * mid, oz + dz * mid);
          if (dm === null) break;
          if (dm < 0) hi = mid;
          else lo = mid;
        }
        const hx = ox + dx * hi;
        const hy = oy + dy * hi;
        const hz = oz + dz * hi;
        // Read the material a little way *inside* the surface. Sampling exactly
        // on the isosurface rounds to whichever grid sample is nearest, which is
        // as likely to be the air side as the solid side, and would report AIR
        // for a perfectly good ground hit.
        const inset = VOXEL * 0.75;
        return {
          x: hx,
          y: hy,
          z: hz,
          dist: hi,
          material:
            this.sampleMaterial(hx + dx * inset, hy + dy * inset, hz + dz * inset) ??
            this.sampleMaterial(hx, hy, hz) ??
            0,
        };
      }
      // Advance by the distance estimate, floored so we never stall.
      t += Math.max(VOXEL * 0.5, d * 0.8);
    }
    return null;
  }

  stats(): WorldStats {
    let ready = 0;
    let brushes = 0;
    let baked = 0;
    let tris = 0;
    for (const ch of this.chunks.values()) {
      if (ch.state === ChunkState.READY) ready++;
      brushes += ch.brushes.length;
      if (ch.baked) baked++;
    }
    for (const t of this.triangleCount.values()) tris += t;
    return {
      chunks: this.chunks.size,
      ready,
      pendingGenerate: this.generating.size,
      queuedRemesh: this.remeshQueue.length,
      workerQueue: this.pool.queueLength,
      triangles: tris,
      brushes,
      bakedChunks: baked,
    };
  }

  dispose(): void {
    this.pool.dispose();
    this.chunks.clear();
  }
}
