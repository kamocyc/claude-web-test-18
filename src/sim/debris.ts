/**
 * Lightweight debris for collapses.
 *
 * No rigid-body engine: each fragment is a point mass with a spin, and it
 * collides against the density field by *sampling* it. Having an SDF already
 * makes this nearly free — the field value at a point is the penetration depth
 * and its gradient is the contact normal, so a full collision query is a handful
 * of samples and needs no colliders, no BVH and no rebuild when the terrain
 * changes. That last property matters: trimesh colliders would have to be
 * rebuilt every time a chunk is remeshed.
 *
 * Rapier or Jolt is the upgrade path if debris ever needs to stack or interact.
 */
import * as THREE from 'three';
import { GRAVITY, VOXEL } from '../core/config.ts';
import { materialProps } from '../terrain/geology.ts';
import type { World } from '../terrain/world.ts';

const MAX_DEBRIS = 700;

interface Fragment {
  alive: boolean;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  /** Half-extent, metres. */
  size: number;
  mat: number;
  /** Seconds remaining before it is removed. */
  life: number;
  /** Angular state, purely cosmetic. */
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  resting: boolean;
}

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  private frags: Fragment[] = [];
  private dummy = new THREE.Object3D();
  private colorAttr: THREE.InstancedBufferAttribute;

  constructor() {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_DEBRIS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'debris';
    const colors = new Float32Array(MAX_DEBRIS * 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor = this.colorAttr;

    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.frags.push({
        alive: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        size: 0.3, mat: 0, life: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, resting: false,
      });
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const f of this.frags) if (f.alive) n++;
    return n;
  }

  /**
   * Spawn a burst of fragments. `rand` is injected so the caller controls the
   * randomness (the collapse itself is deterministic; only the cosmetic debris
   * is not, and keeping the generator outside makes that explicit).
   */
  spawnBurst(
    center: readonly [number, number, number],
    radius: number,
    count: number,
    mat: number,
    rand: () => number = Math.random,
  ): void {
    let spawned = 0;
    for (const f of this.frags) {
      if (spawned >= count) break;
      if (f.alive) continue;
      const a = rand() * Math.PI * 2;
      const r = radius * Math.sqrt(rand());
      f.alive = true;
      f.px = center[0] + Math.cos(a) * r;
      f.py = center[1] + (rand() - 0.2) * radius;
      f.pz = center[2] + Math.sin(a) * r;
      f.vx = (rand() - 0.5) * 3.5;
      f.vy = (rand() - 0.5) * 2.2;
      f.vz = (rand() - 0.5) * 3.5;
      f.size = VOXEL * (0.5 + rand() * 1.1);
      f.mat = mat;
      f.life = 14 + rand() * 8;
      f.rx = rand() * 6.283;
      f.ry = rand() * 6.283;
      f.rz = rand() * 6.283;
      f.wx = (rand() - 0.5) * 7;
      f.wy = (rand() - 0.5) * 7;
      f.wz = (rand() - 0.5) * 7;
      f.resting = false;
      spawned++;
    }
  }

  /** Integrate and resolve against the density field. */
  update(world: World, dt: number): void {
    const step = Math.min(dt, 1 / 30);
    for (const f of this.frags) {
      if (!f.alive) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.alive = false;
        continue;
      }
      if (f.resting) continue;

      f.vy -= GRAVITY * step;
      f.px += f.vx * step;
      f.py += f.vy * step;
      f.pz += f.vz * step;
      f.rx += f.wx * step;
      f.ry += f.wy * step;
      f.rz += f.wz * step;

      const d = world.sampleDensity(f.px, f.py, f.pz);
      if (d === null) {
        // Fell out of the loaded world; retire it rather than tracking it.
        if (f.py < -400) f.alive = false;
        continue;
      }
      if (d < f.size * 0.5) {
        // Contact. The field gradient is the surface normal.
        const e = VOXEL * 0.5;
        const gx = (world.sampleDensity(f.px + e, f.py, f.pz) ?? d) - (world.sampleDensity(f.px - e, f.py, f.pz) ?? d);
        const gy = (world.sampleDensity(f.px, f.py + e, f.pz) ?? d) - (world.sampleDensity(f.px, f.py - e, f.pz) ?? d);
        const gz = (world.sampleDensity(f.px, f.py, f.pz + e) ?? d) - (world.sampleDensity(f.px, f.py, f.pz - e) ?? d);
        const len = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
        const nx = gx / len;
        const ny = gy / len;
        const nz = gz / len;

        // Push out to the surface.
        const pen = f.size * 0.5 - d;
        f.px += nx * pen;
        f.py += ny * pen;
        f.pz += nz * pen;

        // Reflect with damping, then apply friction to the tangential part.
        const vn = f.vx * nx + f.vy * ny + f.vz * nz;
        if (vn < 0) {
          const restitution = 0.18;
          f.vx -= (1 + restitution) * vn * nx;
          f.vy -= (1 + restitution) * vn * ny;
          f.vz -= (1 + restitution) * vn * nz;
          const friction = 0.62;
          f.vx *= friction;
          f.vy *= friction;
          f.vz *= friction;
          f.wx *= 0.5;
          f.wy *= 0.5;
          f.wz *= 0.5;
        }
        const speed2 = f.vx * f.vx + f.vy * f.vy + f.vz * f.vz;
        if (speed2 < 0.05 && ny > 0.4) {
          // Settled: stop integrating it entirely so a big collapse does not
          // keep hundreds of fragments awake forever.
          f.resting = true;
          f.vx = f.vy = f.vz = 0;
        }
      }
    }
    this.syncInstances();
  }

  private syncInstances(): void {
    let n = 0;
    for (const f of this.frags) {
      if (!f.alive) continue;
      this.dummy.position.set(f.px, f.py, f.pz);
      this.dummy.rotation.set(f.rx, f.ry, f.rz);
      this.dummy.scale.setScalar(f.size);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n, this.dummy.matrix);
      const c = materialProps(f.mat).color;
      // Slight darkening so debris reads as loose material, not terrain.
      this.colorAttr.setXYZ(n, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  clear(): void {
    for (const f of this.frags) f.alive = false;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
