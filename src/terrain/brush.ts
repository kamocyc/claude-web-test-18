/**
 * CSG brushes: the one and only representation of player- and simulation-caused
 * change to the terrain.
 *
 * Everything that modifies the world — digging, embankments, road corridors,
 * tunnel bores, roof collapses, settlement bowls — is a brush. That keeps the
 * save format to `{ seed, brushes }` and means the collapse code shares its
 * entire write path with the editing code.
 *
 * Brushes are plain data so they serialise with JSON.stringify and can be sent
 * to a worker with structuredClone.
 */
import { VOXEL } from '../core/config.ts';
import { Mat } from './geology.ts';

export type Vec3 = readonly [number, number, number];

/** Subtract removes material (digging); Add places it (fill). */
export type BrushOp = 'sub' | 'add';

interface BrushBase {
  op: BrushOp;
  /** Material written where the brush adds solid. Ignored by 'sub'. */
  mat: number;
}

/** A ball. The workhorse for free-form digging and filling. */
export interface SphereBrush extends BrushBase {
  kind: 'sphere';
  c: Vec3;
  r: number;
}

/** A capsule (swept sphere). Used for tunnel bores and pipe-like cuts. */
export interface CapsuleBrush extends BrushBase {
  kind: 'capsule';
  a: Vec3;
  b: Vec3;
  r: number;
}

/**
 * A road corridor: an axis-aligned-in-Y box swept along a horizontal segment,
 * with a flat running surface at `y`. Subtracting it cuts, adding it fills, so
 * a road is normally one of each: cut everything above the grade line, then add
 * fill below it.
 */
export interface CorridorBrush extends BrushBase {
  kind: 'corridor';
  a: Vec3;
  b: Vec3;
  /** Half-width of the carriageway, metres. */
  halfWidth: number;
  /** Half-height of the box about its centreline, metres. */
  halfHeight: number;
}

/**
 * A downward cone, used for a tunnel roof fall or a surface sinkhole: it removes
 * a cone of rock above `apex` and (optionally) piles the debris on the floor.
 */
export interface ConeBrush extends BrushBase {
  kind: 'cone';
  apex: Vec3;
  /** Height of the cone above the apex, metres. */
  height: number;
  /** Radius at the top of the cone, metres. */
  radius: number;
}

/**
 * A smooth settlement bowl (a raised-cosine-like dish, built without cos so it
 * stays in the deterministic subset). Subtracting it lowers the ground.
 */
export interface BowlBrush extends BrushBase {
  kind: 'bowl';
  c: Vec3;
  radius: number;
  depth: number;
}

export type Brush =
  | SphereBrush
  | CapsuleBrush
  | CorridorBrush
  | ConeBrush
  | BowlBrush;

/** Axis-aligned bounding box in world metres. */
export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

/** World-space extent a brush can possibly affect. */
export function brushAabb(b: Brush): Aabb {
  switch (b.kind) {
    case 'sphere':
      return expand(b.c, b.c, b.r);
    case 'capsule':
      return expand(b.a, b.b, b.r);
    case 'corridor': {
      const pad = Math.max(b.halfWidth, b.halfHeight);
      return expand(b.a, b.b, pad);
    }
    case 'cone': {
      const top: Vec3 = [b.apex[0], b.apex[1] + b.height, b.apex[2]];
      return expand(b.apex, top, b.radius);
    }
    case 'bowl': {
      const bottom: Vec3 = [b.c[0], b.c[1] - b.depth, b.c[2]];
      return expand(b.c, bottom, b.radius);
    }
  }
}

function expand(p: Vec3, q: Vec3, r: number): Aabb {
  // One extra voxel of slack so that the sampled field is consistent right up
  // to the brush's surface.
  const pad = r + VOXEL;
  return {
    min: [Math.min(p[0], q[0]) - pad, Math.min(p[1], q[1]) - pad, Math.min(p[2], q[2]) - pad],
    max: [Math.max(p[0], q[0]) + pad, Math.max(p[1], q[1]) + pad, Math.max(p[2], q[2]) + pad],
  };
}

/**
 * Signed distance from a world point to the brush surface (negative inside).
 *
 * These are true or near-true SDFs, which is what lets the CSG combine cleanly:
 * union is min, and subtraction is max(field, -brush).
 */
export function brushSdf(b: Brush, x: number, y: number, z: number): number {
  switch (b.kind) {
    case 'sphere': {
      const dx = x - b.c[0];
      const dy = y - b.c[1];
      const dz = z - b.c[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r;
    }
    case 'capsule':
      return segmentDistance(x, y, z, b.a, b.b) - b.r;
    case 'corridor': {
      // Horizontal distance to the centreline, then a box in (across, up).
      const across = horizontalSegmentDistance(x, z, b.a, b.b);
      const yMid = b.a[1] + (b.b[1] - b.a[1]) * horizontalSegmentT(x, z, b.a, b.b);
      const up = Math.abs(y - yMid);
      const dw = across - b.halfWidth;
      const dh = up - b.halfHeight;
      // Exact SDF of a 2D box.
      const ow = Math.max(dw, 0);
      const oh = Math.max(dh, 0);
      return Math.sqrt(ow * ow + oh * oh) + Math.min(Math.max(dw, dh), 0);
    }
    case 'cone': {
      const dy = y - b.apex[1];
      if (dy < 0) {
        // Below the apex: distance to the apex point.
        const dx = x - b.apex[0];
        const dz = z - b.apex[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      const t = Math.min(1, dy / b.height);
      const rAt = b.radius * t;
      const dx = x - b.apex[0];
      const dz = z - b.apex[2];
      const radial = Math.sqrt(dx * dx + dz * dz) - rAt;
      const above = dy - b.height;
      // Approximate: intersection of a radial slab and a height slab.
      const or = Math.max(radial, 0);
      const oa = Math.max(above, 0);
      return Math.sqrt(or * or + oa * oa) + Math.min(Math.max(radial, above), 0);
    }
    case 'bowl': {
      const dx = x - b.c[0];
      const dz = z - b.c[2];
      const rad = Math.sqrt(dx * dx + dz * dz);
      if (rad > b.radius) {
        // Outside the dish footprint: distance to its rim.
        const dr = rad - b.radius;
        const dy = y - b.c[1];
        return Math.sqrt(dr * dr + Math.max(0, -dy) * Math.max(0, -dy)) + Math.max(0, dy) * 0;
      }
      // Dish profile: full depth at the centre, zero at the rim, smooth in
      // between via a smoothstep on normalised radius (no transcendentals).
      const u = rad / b.radius;
      const fall = 1 - u * u * (3 - 2 * u);
      const floor = b.c[1] - b.depth * fall;
      return y - floor;
    }
  }
}

function segmentDistance(x: number, y: number, z: number, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = x - a[0];
  const apy = y - a[1];
  const apz = z - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function horizontalSegmentT(x: number, z: number, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-12) return 0;
  return Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / len2));
}

function horizontalSegmentDistance(x: number, z: number, a: Vec3, b: Vec3): number {
  const t = horizontalSegmentT(x, z, a, b);
  const dx = x - (a[0] + (b[0] - a[0]) * t);
  const dz = z - (a[2] + (b[2] - a[2]) * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Does the brush's AABB overlap the given world-space box? */
export function aabbOverlaps(a: Aabb, min: Vec3, max: Vec3): boolean {
  return (
    a.min[0] <= max[0] && a.max[0] >= min[0] &&
    a.min[1] <= max[1] && a.max[1] >= min[1] &&
    a.min[2] <= max[2] && a.max[2] >= min[2]
  );
}

/** Convenience constructors, so callers do not repeat the literal shapes. */
export const makeBrush = {
  dig(c: Vec3, r: number): SphereBrush {
    return { kind: 'sphere', op: 'sub', mat: Mat.AIR, c, r };
  },
  fill(c: Vec3, r: number, mat: number = Mat.FILL): SphereBrush {
    return { kind: 'sphere', op: 'add', mat, c, r };
  },
  bore(a: Vec3, b: Vec3, r: number): CapsuleBrush {
    return { kind: 'capsule', op: 'sub', mat: Mat.AIR, a, b, r };
  },
  lining(a: Vec3, b: Vec3, r: number): CapsuleBrush {
    return { kind: 'capsule', op: 'add', mat: Mat.CONCRETE, a, b, r };
  },
  roadCut(a: Vec3, b: Vec3, halfWidth: number, halfHeight: number): CorridorBrush {
    return { kind: 'corridor', op: 'sub', mat: Mat.AIR, a, b, halfWidth, halfHeight };
  },
  roadFill(a: Vec3, b: Vec3, halfWidth: number, halfHeight: number): CorridorBrush {
    return { kind: 'corridor', op: 'add', mat: Mat.FILL, a, b, halfWidth, halfHeight };
  },
  roofFall(apex: Vec3, height: number, radius: number): ConeBrush {
    return { kind: 'cone', op: 'sub', mat: Mat.AIR, apex, height, radius };
  },
  settle(c: Vec3, radius: number, depth: number): BowlBrush {
    return { kind: 'bowl', op: 'sub', mat: Mat.AIR, c, radius, depth };
  },
};
