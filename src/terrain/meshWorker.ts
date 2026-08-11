/**
 * Mesh worker: generates chunk fields and extracts their isosurfaces.
 *
 * Two job types:
 *   'generate' — build the base field procedurally, replay the chunk's brush
 *                diff, mesh it, and hand the field back so the main thread can
 *                cache it for cheap subsequent edits.
 *   'remesh'   — mesh a field the main thread already owns and has just edited.
 *
 * All large payloads move by ArrayBuffer transfer rather than being copied.
 * Deliberately no SharedArrayBuffer: it would require the page to be
 * cross-origin isolated (COOP/COEP headers), which complicates deployment for
 * no measurable gain at these sizes.
 */
import { surfaceNets } from './surfaceNets.ts';
import { buildChunkField } from './chunk.ts';
import { allocChunkField } from './density.ts';
import type { Brush } from './brush.ts';
import { findFalling, type FallingCluster } from '../sim/detach.ts';

export interface GenerateJob {
  id: number;
  type: 'generate';
  cx: number;
  cy: number;
  cz: number;
  seed: number;
  brushes: Brush[];
}

export interface RemeshJob {
  id: number;
  type: 'remesh';
  cx: number;
  cy: number;
  cz: number;
  field: Float32Array;
  material: Uint8Array;
}

export type MeshJob = GenerateJob | RemeshJob;

export interface MeshResult {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  materials: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** Present only for 'generate' jobs. */
  field?: Float32Array;
  material?: Uint8Array;
  /**
   * Rock that is no longer held up. Only produced for 'remesh' jobs, i.e. after
   * an edit: the procedural terrain was measured to contain no detached bodies,
   * so scanning freshly generated chunks would be pure cost.
   */
  falling?: FallingCluster[];
}

// One reusable field buffer per worker, for 'generate' jobs.
const scratch = allocChunkField();

self.onmessage = (ev: MessageEvent<MeshJob>) => {
  const job = ev.data;
  let field: Float32Array;
  let material: Uint8Array;
  let handBack = false;

  if (job.type === 'generate') {
    buildChunkField(job.cx, job.cy, job.cz, job.seed, job.brushes, scratch);
    // Copy out of the scratch buffer so the scratch stays usable for the next
    // job after this one's arrays are transferred away.
    field = scratch.field.slice();
    material = scratch.material.slice();
    handBack = true;
  } else {
    field = job.field;
    material = job.material;
  }

  const mesh = surfaceNets(field, material);
  // Detachment/overhang sweep rides along on the remesh: the field is already
  // here and hot in cache, and the scan costs 0.66 ms against 1.6 ms to extract.
  const falling = job.type === 'remesh' ? findFalling(field, material, job.cx, job.cy, job.cz) : undefined;
  const result: MeshResult = {
    id: job.id,
    positions: mesh.positions,
    normals: mesh.normals,
    materials: mesh.materials,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
  };
  if (falling && falling.length > 0) result.falling = falling;
  const transfer: Transferable[] = [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.materials.buffer,
    mesh.indices.buffer,
  ];
  if (handBack) {
    result.field = field;
    result.material = material;
    transfer.push(field.buffer, material.buffer);
  }
  (self as unknown as Worker).postMessage(result, transfer);
};
