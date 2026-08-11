/**
 * Rock that is no longer held up.
 *
 * Two failure modes, found in one pass over a chunk's density field:
 *
 *   detached — a body of rock with no connection to anything. Digging with CSG
 *              can sever rock as easily as it can hollow it, and nothing in the
 *              renderer or the sim cares, so islands used to hang in mid-air
 *              indefinitely.
 *   overhang — rock still attached, but cantilevered further than it can carry.
 *              Judged with the *same* rockmass.unsupportedSpan used for tunnel
 *              roofs, halved because a cantilever carries about half what a
 *              span supported at both ends does.
 *
 * Runs in the mesh worker, on the field it is about to re-extract anyway, and
 * only for edits: the procedural terrain was measured to contain no detached
 * bodies at all (48 chunks scanned, zero found), so fresh chunks need no check.
 * Measured at 0.60 ms per chunk against 1.6 ms for the re-extraction itself.
 *
 * Deliberately no three.js and no World here, so the worker bundle stays small.
 */
import { CHUNK, FIELD, FIELD2, PAD, VOXEL } from '../core/config.ts';
import { Mat, materialProps } from '../terrain/geology.ts';
import { makeBrush, type Brush } from '../terrain/brush.ts';
import { unsupportedSpan } from './rockmass.ts';

/** A body of rock that should fall, in world coordinates. */
export interface FallingCluster {
  /** Centroid, world metres. */
  x: number;
  y: number;
  z: number;
  /** Voxel count. */
  voxels: number;
  /** Volume, m^3. */
  volume: number;
  /** Radius of a sphere of the same volume, m. */
  radius: number;
  /** Half-extents of the body's bounding box, m. */
  ex: number;
  ey: number;
  ez: number;
  /** Most common material in the body. */
  mat: number;
  reason: 'detached' | 'overhang';
}

/** Voxel volume, m^3. */
const VOXEL_VOLUME = VOXEL * VOXEL * VOXEL;

/**
 * A cantilever carries roughly half the span of an opening supported at both
 * ends, so the allowable projection is half the unsupported span.
 */
const CANTILEVER_RATIO = 0.5;

/** Ignore specks: below this a "failure" is meshing noise, not a rock fall. */
const MIN_CLUSTER_VOXELS = 8;

/** Material ids are small and dense; wide enough for the whole table. */
const MAT_SLOTS = 16;

const FIELD_VOXELS = FIELD * FIELD2;

// Scratch, reused across calls. One worker handles one chunk at a time.
const label = new Int32Array(FIELD_VOXELS);
const stack = new Int32Array(FIELD_VOXELS);
/** Accumulated overburden stress above each voxel, kPa. */
const columnStress = new Float32Array(FIELD_VOXELS);
/** True where a voxel has an unbroken solid column beneath it to the box floor. */
const propped = new Uint8Array(FIELD_VOXELS);
/** Horizontal distance in voxels to the nearest propped voxel on the same level. */
const reach = new Int32Array(FIELD_VOXELS);
const levelQueue = new Int32Array(FIELD * FIELD);
const failing = new Uint8Array(FIELD_VOXELS);
/** Connected-component id per voxel, retained across the passes. */
const compLabel = new Int32Array(FIELD_VOXELS);

const idx = (x: number, y: number, z: number): number => x + y * FIELD + z * FIELD2;

/**
 * Find bodies of rock that are unsupported.
 *
 * (cx, cy, cz) are the chunk's integer coordinates, used to return world
 * positions so the caller does not have to know the field's layout.
 */
export function findFalling(
  field: Float32Array,
  material: Uint8Array,
  cx: number,
  cy: number,
  cz: number,
): FallingCluster[] {
  const out: FallingCluster[] = [];
  const baseX = cx * CHUNK - PAD;
  const baseY = cy * CHUNK - PAD;
  const baseZ = cz * CHUNK - PAD;

  // ---- pass 1: connected components, and which of them are anchored ----------
  //
  // A component touching any face of the field box may continue into the
  // neighbouring chunk, and the worker cannot see that far, so it is assumed
  // supported. That is the safe direction to be wrong in: the cost is missing a
  // detached body larger than a chunk, rather than deleting terrain that was
  // fine. (Upgrade path: gather a 3x3x3 neighbourhood before sweeping.)
  compLabel.fill(0);
  let nLabels = 0;
  const anchored: boolean[] = [false];

  for (let seed = 0; seed < field.length; seed++) {
    if (field[seed]! >= 0 || compLabel[seed] !== 0) continue;
    nLabels++;
    let touchesFace = false;
    let sp = 0;
    stack[sp++] = seed;
    compLabel[seed] = nLabels;
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % FIELD;
      const y = ((p / FIELD) | 0) % FIELD;
      const z = (p / FIELD2) | 0;
      if (x === 0 || y === 0 || z === 0 || x === FIELD - 1 || y === FIELD - 1 || z === FIELD - 1) {
        touchesFace = true;
      }
      if (x > 0 && field[p - 1]! < 0 && compLabel[p - 1] === 0) { compLabel[p - 1] = nLabels; stack[sp++] = p - 1; }
      if (x < FIELD - 1 && field[p + 1]! < 0 && compLabel[p + 1] === 0) { compLabel[p + 1] = nLabels; stack[sp++] = p + 1; }
      if (y > 0 && field[p - FIELD]! < 0 && compLabel[p - FIELD] === 0) { compLabel[p - FIELD] = nLabels; stack[sp++] = p - FIELD; }
      if (y < FIELD - 1 && field[p + FIELD]! < 0 && compLabel[p + FIELD] === 0) { compLabel[p + FIELD] = nLabels; stack[sp++] = p + FIELD; }
      if (z > 0 && field[p - FIELD2]! < 0 && compLabel[p - FIELD2] === 0) { compLabel[p - FIELD2] = nLabels; stack[sp++] = p - FIELD2; }
      if (z < FIELD - 1 && field[p + FIELD2]! < 0 && compLabel[p + FIELD2] === 0) { compLabel[p + FIELD2] = nLabels; stack[sp++] = p + FIELD2; }
    }
    anchored[nLabels] = touchesFace;
  }

  // Detached components fall whole.
  collectClusters(
    field, material, compLabel, nLabels,
    (l) => !anchored[l], baseX, baseY, baseZ, 'detached', out,
  );

  // ---- pass 2: overburden stress per voxel, top down ------------------------
  //
  // Needed because unsupportedSpan takes sigma_v, and the sweep has no access to
  // the World. Accumulating gamma * dh down each column is the same quantity
  // stress.overburdenAt computes, restricted to this chunk.
  for (let z = 0; z < FIELD; z++) {
    for (let x = 0; x < FIELD; x++) {
      let acc = 0;
      for (let y = FIELD - 1; y >= 0; y--) {
        const i = idx(x, y, z);
        columnStress[i] = acc;
        if (field[i]! < 0) acc += materialProps(material[i]!).gamma * VOXEL;
      }
    }
  }

  // ---- pass 3: which voxels stand on an unbroken column --------------------
  const hasProp = new Uint8Array(nLabels + 1);
  propped.fill(0);
  for (let z = 0; z < FIELD; z++) {
    for (let x = 0; x < FIELD; x++) {
      let standing = true;
      for (let y = 0; y < FIELD; y++) {
        const i = idx(x, y, z);
        const solid = field[i]! < 0;
        if (!solid) standing = false;
        if (solid && standing) {
          propped[i] = 1;
          hasProp[compLabel[i]!] = 1;
        } else {
          propped[i] = 0;
        }
      }
    }
  }

  // ---- pass 4: horizontal reach to the nearest propped voxel, per level ----
  // Multi-source BFS on each y slice, sources being the propped voxels.
  reach.fill(-1);
  for (let y = 0; y < FIELD; y++) {
    let head = 0;
    let tail = 0;
    for (let z = 0; z < FIELD; z++) {
      for (let x = 0; x < FIELD; x++) {
        const i = idx(x, y, z);
        if (field[i]! < 0 && propped[i]) {
          reach[i] = 0;
          levelQueue[tail++] = i;
        }
      }
    }
    while (head < tail) {
      const p = levelQueue[head++]!;
      const d = reach[p]! + 1;
      const x = p % FIELD;
      const z = (p / FIELD2) | 0;
      if (x > 0 && claim(p - 1, d, field)) levelQueue[tail++] = p - 1;
      if (x < FIELD - 1 && claim(p + 1, d, field)) levelQueue[tail++] = p + 1;
      if (z > 0 && claim(p - FIELD2, d, field)) levelQueue[tail++] = p - FIELD2;
      if (z < FIELD - 1 && claim(p + FIELD2, d, field)) levelQueue[tail++] = p + FIELD2;
    }
  }

  // ---- pass 5: fail voxels cantilevered beyond what the rock carries -------
  failing.fill(0);
  for (let i = 0; i < field.length; i++) {
    if (field[i]! >= 0 || propped[i]) continue;
    // Only judge bodies whose support is actually visible in this field. A body
    // with no propped voxel here is either already reported as detached, or it
    // continues into a neighbouring chunk and is held up by rock the worker
    // cannot see — condemning it would delete legitimate terrain.
    if (!hasProp[compLabel[i]!]) continue;
    // Rubble is the product of a failure, not a structural member: it is loose
    // material resting at its angle of repose, so asking how far it can cantilever
    // is meaningless. Without this the sweep hauled the debris column back out of a
    // chimney it had just filled. Detached rubble still falls — that is pass 1.
    if (material[i] === Mat.RUBBLE) continue;
    const r = reach[i]!;
    // r === -1 means no pillar anywhere on this level: the voxel is hanging from
    // above rather than cantilevered from the side, so treat the projection as
    // unbounded and let the strength check decide.
    const projection = r < 0 ? Infinity : r * VOXEL;
    if (projection <= 0) continue;
    const props = materialProps(material[i]!);
    const allowed = CANTILEVER_RATIO * unsupportedSpan(props.rmr, columnStress[i]!);
    if (projection > allowed) failing[i] = 1;
  }

  // Group the failing voxels so one rock fall is one cluster, not 400 specks.
  label.fill(0);
  let fLabels = 0;
  for (let seed = 0; seed < failing.length; seed++) {
    if (!failing[seed] || label[seed] !== 0) continue;
    fLabels++;
    let sp = 0;
    stack[sp++] = seed;
    label[seed] = fLabels;
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % FIELD;
      const y = ((p / FIELD) | 0) % FIELD;
      const z = (p / FIELD2) | 0;
      if (x > 0 && failing[p - 1] && label[p - 1] === 0) { label[p - 1] = fLabels; stack[sp++] = p - 1; }
      if (x < FIELD - 1 && failing[p + 1] && label[p + 1] === 0) { label[p + 1] = fLabels; stack[sp++] = p + 1; }
      if (y > 0 && failing[p - FIELD] && label[p - FIELD] === 0) { label[p - FIELD] = fLabels; stack[sp++] = p - FIELD; }
      if (y < FIELD - 1 && failing[p + FIELD] && label[p + FIELD] === 0) { label[p + FIELD] = fLabels; stack[sp++] = p + FIELD; }
      if (z > 0 && failing[p - FIELD2] && label[p - FIELD2] === 0) { label[p - FIELD2] = fLabels; stack[sp++] = p - FIELD2; }
      if (z < FIELD - 1 && failing[p + FIELD2] && label[p + FIELD2] === 0) { label[p + FIELD2] = fLabels; stack[sp++] = p + FIELD2; }
    }
  }
  collectClusters(field, material, label, fLabels, () => true, baseX, baseY, baseZ, 'overhang', out);

  return out;
}

/** Claim an unvisited solid voxel for the BFS frontier. */
function claim(i: number, d: number, field: Float32Array): boolean {
  if (field[i]! >= 0 || reach[i] !== -1) return false;
  reach[i] = d;
  return true;
}

/**
 * Accumulate per-label statistics in a single pass and emit clusters.
 *
 * Written this way because the obvious alternative — scanning the field once per
 * label — is O(labels x voxels), and a large undercut produces dozens of clusters
 * in one round, so that scan dominated the sweep. One pass regardless of count.
 *
 * A cluster is dropped if it is smaller than MIN_CLUSTER_VOXELS or if its centroid
 * falls outside this chunk's own volume: the latter is how the same body seen
 * through two chunks' padding rings gets reported once, by whichever chunk owns it.
 */
function collectClusters(
  field: Float32Array,
  material: Uint8Array,
  labels: Int32Array,
  nLabels: number,
  keep: (label: number) => boolean,
  baseX: number,
  baseY: number,
  baseZ: number,
  reason: 'detached' | 'overhang',
  out: FallingCluster[],
): void {
  if (nLabels === 0) return;
  const count = new Int32Array(nLabels + 1);
  const sumX = new Float64Array(nLabels + 1);
  const sumY = new Float64Array(nLabels + 1);
  const sumZ = new Float64Array(nLabels + 1);
  const minX = new Int32Array(nLabels + 1).fill(FIELD);
  const minY = new Int32Array(nLabels + 1).fill(FIELD);
  const minZ = new Int32Array(nLabels + 1).fill(FIELD);
  const maxX = new Int32Array(nLabels + 1).fill(-1);
  const maxY = new Int32Array(nLabels + 1).fill(-1);
  const maxZ = new Int32Array(nLabels + 1).fill(-1);
  // Material histogram, flattened: one row of MAT_SLOTS per label.
  const matHist = new Int32Array((nLabels + 1) * MAT_SLOTS);

  for (let i = 0; i < field.length; i++) {
    const l = labels[i]!;
    if (l === 0 || !keep(l)) continue;
    const x = i % FIELD;
    const y = ((i / FIELD) | 0) % FIELD;
    const z = (i / FIELD2) | 0;
    count[l]++;
    sumX[l] += x;
    sumY[l] += y;
    sumZ[l] += z;
    if (x < minX[l]!) minX[l] = x;
    if (y < minY[l]!) minY[l] = y;
    if (z < minZ[l]!) minZ[l] = z;
    if (x > maxX[l]!) maxX[l] = x;
    if (y > maxY[l]!) maxY[l] = y;
    if (z > maxZ[l]!) maxZ[l] = z;
    const m = material[i]!;
    if (m < MAT_SLOTS) matHist[l * MAT_SLOTS + m]++;
  }

  for (let l = 1; l <= nLabels; l++) {
    const n = count[l]!;
    if (n < MIN_CLUSTER_VOXELS) continue;
    const gx = sumX[l]! / n;
    const gy = sumY[l]! / n;
    const gz = sumZ[l]! / n;
    if (gx < PAD || gx >= PAD + CHUNK) continue;
    if (gy < PAD || gy >= PAD + CHUNK) continue;
    if (gz < PAD || gz >= PAD + CHUNK) continue;

    let mat = 0;
    let best = -1;
    for (let m = 0; m < MAT_SLOTS; m++) {
      const c = matHist[l * MAT_SLOTS + m]!;
      if (c > best) {
        best = c;
        mat = m;
      }
    }

    const volume = n * VOXEL_VOLUME;
    out.push({
      x: (baseX + gx) * VOXEL,
      y: (baseY + gy) * VOXEL,
      z: (baseZ + gz) * VOXEL,
      voxels: n,
      volume,
      radius: Math.cbrt((3 * volume) / (4 * Math.PI)),
      ex: ((maxX[l]! - minX[l]! + 1) * VOXEL) / 2,
      ey: ((maxY[l]! - minY[l]! + 1) * VOXEL) / 2,
      ez: ((maxZ[l]! - minZ[l]! + 1) * VOXEL) / 2,
      mat,
      reason,
    });
  }
}

// ---------------------------------------------------------------------------
// Applying the findings. Kept in this file so the rule and its consequence sit
// together, but deliberately typed against minimal interfaces rather than the
// concrete World/DebrisSystem, so importing the detection half into the worker
// does not drag three.js in with it.
// ---------------------------------------------------------------------------

/** The part of World this needs. */
export interface FallTarget {
  applyBrush(b: Brush): unknown[];
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist?: number,
  ): { x: number; y: number; z: number } | null;
}

/** The part of DebrisSystem this needs. */
export interface DebrisSink {
  spawnBurst(
    center: readonly [number, number, number],
    radius: number,
    count: number,
    mat: number,
    rand?: () => number,
  ): void;
}

/** Openings whose ground the tunnel sim owns; see `insideProtectedColumn`. */
export interface ProtectedOpening {
  center: [number, number, number];
  span: number;
  /** Thickness of rock above the crown, m. */
  cover: number;
}

export interface FallOutcome {
  clustersApplied: number;
  clustersSkipped: number;
  volume: number;
  brushes: number;
}

/**
 * Largest number of removal brushes spent on one cluster.
 *
 * A slab is poorly approximated by a single ball, so the removal is tiled. The
 * cap keeps the CSG diff from exploding on a big failure; whatever is left over
 * is simply re-detected on the next remesh, so a large overhang crumbles across
 * a few ticks instead of vanishing in one frame. That reads better anyway.
 */
const MAX_REMOVAL_BRUSHES = 8;

/**
 * Turn findings into terrain change: remove the rock, drop debris, and pile the
 * bulked rubble where it lands.
 *
 * `protect` lists openings that have been supported. Without it the overhang
 * sweep would happily condemn the roof of a tunnel the player has just lined,
 * which from the player's side is indistinguishable from the support not working.
 */
export function applyFalling(
  world: FallTarget,
  clusters: readonly FallingCluster[],
  debris: DebrisSink | null,
  protect: readonly ProtectedOpening[] = [],
): FallOutcome {
  const out: FallOutcome = { clustersApplied: 0, clustersSkipped: 0, volume: 0, brushes: 0 };

  for (const c of clusters) {
    // Remove the rock. Radius is the largest ball that fits the body's thinnest
    // dimension, so a slab is cleared through its thickness rather than nibbled.
    const r = Math.max(VOXEL, Math.min(c.ex, c.ey, c.ez) + VOXEL * 0.5);

    if (insideProtectedColumn(c, r, protect)) {
      out.clustersSkipped++;
      continue;
    }

    let placed = 0;
    const steps = (extent: number): number => Math.max(1, Math.ceil(extent / (r * 1.2)));
    const nx = steps(c.ex);
    const ny = steps(c.ey);
    const nz = steps(c.ez);
    for (let i = 0; i < nx && placed < MAX_REMOVAL_BRUSHES; i++) {
      for (let j = 0; j < ny && placed < MAX_REMOVAL_BRUSHES; j++) {
        for (let k = 0; k < nz && placed < MAX_REMOVAL_BRUSHES; k++) {
          const fx = nx === 1 ? 0 : (i / (nx - 1)) * 2 - 1;
          const fy = ny === 1 ? 0 : (j / (ny - 1)) * 2 - 1;
          const fz = nz === 1 ? 0 : (k / (nz - 1)) * 2 - 1;
          world.applyBrush(
            makeBrush.dig(
              [
                c.x + fx * Math.max(0, c.ex - r * 0.5),
                c.y + fy * Math.max(0, c.ey - r * 0.5),
                c.z + fz * Math.max(0, c.ez - r * 0.5),
              ],
              r,
            ),
          );
          placed++;
        }
      }
    }
    out.brushes += placed;

    // Where does it land? Straight down from the centroid, starting just below
    // the body so the ray does not immediately hit what is being removed.
    const landing = world.raycast(c.x, c.y - c.ey - VOXEL, c.z, 0, -1, 0, 300);
    const bulking = materialProps(c.mat).bulking;
    const debrisVolume = c.volume * bulking;
    const pileRadius = Math.cbrt((3 * debrisVolume) / (4 * Math.PI));
    if (landing && pileRadius > VOXEL * 0.5) {
      // Sit the pile on the surface it landed on, sunk slightly so it reads as
      // resting rather than balancing.
      world.applyBrush(
        makeBrush.fill([landing.x, landing.y + pileRadius * 0.55, landing.z], pileRadius, Mat.RUBBLE),
      );
      out.brushes++;
    }

    if (debris) {
      const count = Math.max(6, Math.min(90, Math.round(c.voxels * 0.4)));
      debris.spawnBurst([c.x, c.y, c.z], Math.max(c.ex, c.ey, c.ez), count, c.mat);
    }

    out.clustersApplied++;
    out.volume += c.volume;
  }

  return out;
}

/**
 * True if the cluster lies in ground that a tracked opening is responsible for.
 *
 * The protected region is a vertical column: from below the invert up through the
 * full cover to daylight, and wide enough to include the opening's shoulders.
 * Two details matter, and both were learned by watching it fail:
 *
 *  - It must be a *column*, not a ball around the opening. With a ball, the roof
 *    immediately above was protected but the rock above that was not, so the sweep
 *    ate the cover from the top down, one round at a time, until the heading had no
 *    roof left and quietly became an open cut instead of ever collapsing. The
 *    tunnel sim already models the whole cover — chimney height is capped by it,
 *    and breaking through it produces the sinkhole — so the whole column is its
 *    business.
 *  - It must be tested against the cluster's *extent* plus the removal radius, not
 *    its centroid. A wide slab whose centre sits just outside the region still has
 *    removal brushes reaching well inside it.
 */
function insideProtectedColumn(
  c: FallingCluster,
  removalRadius: number,
  protect: readonly ProtectedOpening[],
): boolean {
  for (const p of protect) {
    const half = p.span * 0.5;
    // Horizontal: opening radius, plus shoulders, plus the cluster's own reach.
    const radial = half * 1.6 + Math.max(c.ex, c.ez) + removalRadius;
    const dx = c.x - p.center[0];
    const dz = c.z - p.center[2];
    if (dx * dx + dz * dz > radial * radial) continue;
    // Vertical: from below the invert up through the cover to daylight.
    const low = p.center[1] - half - c.ey - removalRadius;
    const high = p.center[1] + half + p.cover + c.ey + removalRadius;
    if (c.y >= low && c.y <= high) return true;
  }
  return false;
}
