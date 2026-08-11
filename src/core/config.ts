/**
 * Global tuning constants for the prototype.
 *
 * A chunk is CHUNK^3 *cells*. The density field is stored with a one-voxel
 * border ring on every side (see FIELD below) so that Surface Nets
 * can emit cells that straddle the chunk boundary and neighbouring chunks
 * agree on the shared face without any cross-chunk communication.
 */
export const CHUNK = 32;
/** Metres per voxel. */
export const VOXEL = 0.5;
/** Border ring, in voxels, kept on each side of a chunk's field. */
export const PAD = 1;
/**
 * Samples along one axis of a stored field.
 *
 * A field of N samples spans N-1 cells. Surface Nets puts one vertex per
 * sign-changing cell and builds each quad from the current cell plus its three
 * neighbours in the negative directions, so a chunk that owns CHUNK cells needs
 * one extra ring of cells on the low side as quad corners, and none on the high
 * side (the +x/+y/+z neighbour emits the quads across the shared face).
 * That is CHUNK + 1 cells => CHUNK + 2 samples.
 */
export const FIELD = CHUNK + 2 * PAD; // 34 samples => 33 cells
/** Cell index range this chunk owns: [CELL_LO, CELL_HI] inclusive. */
export const CELL_LO = PAD;              // 1
export const CELL_HI = PAD + CHUNK - 1;  // 32
export const FIELD2 = FIELD * FIELD;
export const FIELD3 = FIELD2 * FIELD;
/** Chunk edge length in metres. */
export const CHUNK_M = CHUNK * VOXEL; // 16 m

/** Brush-list length at which a chunk's diff is baked into its field. */
export const BAKE_THRESHOLD = 32;
/** Upper bound on chunk meshes uploaded to the GPU per frame. */
export const REMESH_BUDGET_PER_FRAME = 4;
/** Horizontal streaming radius, in chunks. */
export const STREAM_RADIUS_XZ = 12; // 12 * 16 m = 192 m
/** Vertical extent of the loaded column, in chunks, measured from y = 0. */
export const STREAM_MIN_CY = -3;
export const STREAM_MAX_CY = 3;
/** Interval of the low-frequency geotechnical / tunnel tick, in seconds. */
export const SIM_TICK_SECONDS = 0.5;

/** Gravity, m/s^2. Used for both overburden stress and debris. */
export const GRAVITY = 9.81;
