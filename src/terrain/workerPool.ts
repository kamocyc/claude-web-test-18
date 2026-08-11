/**
 * A small fixed pool of mesh workers with a FIFO job queue.
 *
 * Jobs are dispatched to whichever worker is idle. Callers get a promise per
 * job; the pool itself has no opinion about chunk lifetime, so a caller that no
 * longer wants a result simply ignores it (see Chunk.version for how stale
 * results are detected).
 */
import type { MeshJob, MeshResult } from './meshWorker.ts';
import type { Brush } from './brush.ts';
import { buildChunkField } from './chunk.ts';
import { surfaceNets } from './surfaceNets.ts';
/**
 * What World needs from a mesh backend. Implemented by MeshWorkerPool in the
 * browser and by SyncMeshPool in Node, so the whole chunk pipeline including
 * tunnel collapse can be tested without a Worker implementation.
 */
export interface MeshPool {
  readonly size: number;
  readonly busy: number;
  readonly queueLength: number;
  generate(cx: number, cy: number, cz: number, seed: number, brushes: Brush[]): Promise<MeshResult>;
  remesh(field: Float32Array, material: Uint8Array): Promise<MeshResult>;
  dispose(): void;
}

interface Pending {
  resolve: (r: MeshResult) => void;
  reject: (e: unknown) => void;
}

export class MeshWorkerPool implements MeshPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: MeshJob; transfer: Transferable[] }[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(size?: number) {
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const n = Math.max(1, Math.min(8, size ?? hw - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<MeshResult>) => this.onDone(w, ev.data);
      w.onerror = (ev) => {
        // Surface worker failures rather than hanging every queued job.
        console.error('mesh worker error', ev.message);
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get busy(): number {
    return this.workers.length - this.idle.length;
  }

  /** Generate a chunk from scratch, replaying its brush diff. */
  generate(cx: number, cy: number, cz: number, seed: number, brushes: Brush[]): Promise<MeshResult> {
    return this.submit({ id: 0, type: 'generate', cx, cy, cz, seed, brushes }, []);
  }

  /**
   * Mesh a field the caller owns. The caller must pass copies: the buffers are
   * transferred to the worker and become unusable on this side.
   */
  remesh(field: Float32Array, material: Uint8Array): Promise<MeshResult> {
    return this.submit({ id: 0, type: 'remesh', field, material }, [field.buffer, material.buffer]);
  }

  private submit(job: MeshJob, transfer: Transferable[]): Promise<MeshResult> {
    job.id = this.nextId++;
    return new Promise<MeshResult>((resolve, reject) => {
      this.pending.set(job.id, { resolve, reject });
      const w = this.idle.pop();
      if (w) this.dispatch(w, job, transfer);
      else this.queue.push({ job, transfer });
    });
  }

  private dispatch(w: Worker, job: MeshJob, transfer: Transferable[]): void {
    w.postMessage(job, transfer);
  }

  private onDone(w: Worker, result: MeshResult): void {
    const p = this.pending.get(result.id);
    this.pending.delete(result.id);
    const next = this.queue.shift();
    if (next) this.dispatch(w, next.job, next.transfer);
    else this.idle.push(w);
    p?.resolve(result);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}


/**
 * In-process, synchronous stand-in for MeshWorkerPool.
 *
 * Meshes on the calling thread and resolves immediately. Used by tests and by
 * any headless run where no Worker implementation exists; never used in the
 * browser, where meshing must stay off the main thread.
 */
export class SyncMeshPool implements MeshPool {
  readonly size = 1;
  readonly busy = 0;
  readonly queueLength = 0;
  private nextId = 1;

  async generate(cx: number, cy: number, cz: number, seed: number, brushes: Brush[]): Promise<MeshResult> {
    const data = buildChunkField(cx, cy, cz, seed, brushes);
    const mesh = surfaceNets(data.field, data.material);
    return {
      id: this.nextId++,
      positions: mesh.positions,
      normals: mesh.normals,
      materials: mesh.materials,
      indices: mesh.indices,
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
      field: data.field,
      material: data.material,
    };
  }

  async remesh(field: Float32Array, material: Uint8Array): Promise<MeshResult> {
    const mesh = surfaceNets(field, material);
    return {
      id: this.nextId++,
      positions: mesh.positions,
      normals: mesh.normals,
      materials: mesh.materials,
      indices: mesh.indices,
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
    };
  }

  dispose(): void {}
}
