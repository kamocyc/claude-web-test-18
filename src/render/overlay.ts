/**
 * Bearing-capacity utilisation heatmap.
 *
 * Colours the ground by how much of its allowable bearing pressure a reference
 * footing would use, so the player can see where it is safe to found *before*
 * placing anything. Cheap enough to be free: a bearing capacity evaluation is
 * about 0.2 microseconds, so a 96x96 grid is well under a millisecond.
 */
import * as THREE from 'three';
import { bearingCapacityOfMaterial, utilisation, utilisationColor } from '../sim/bearing.ts';
import type { World } from '../terrain/world.ts';

const GRID = 96;

export interface OverlayParams {
  minX: number;
  minZ: number;
  size: number;
  /** Reference footing width, metres. */
  footingWidth: number;
  /** Reference footing depth below ground, metres. */
  footingDepth: number;
  /** Applied pressure to test against, kPa. */
  appliedKpa: number;
}

export class BearingOverlay {
  readonly texture: THREE.DataTexture;
  private data: Uint8Array;
  private params: OverlayParams = {
    minX: 0, minZ: 0, size: 256, footingWidth: 3, footingDepth: 1.5, appliedKpa: 300,
  };
  /** Sample count of the last update, for the HUD. */
  lastSamples = 0;
  lastMs = 0;

  constructor() {
    this.data = new Uint8Array(GRID * GRID * 4);
    this.texture = new THREE.DataTexture(this.data, GRID, GRID, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  get current(): OverlayParams {
    return this.params;
  }

  /**
   * Rebuild the heatmap over an XZ rect. For each cell it finds the ground
   * surface by raycasting straight down, reads the material at *founding level*,
   * and compares the reference footing pressure with the allowable capacity.
   *
   * Reading the material at the surface instead of at founding level made the
   * whole map one flat colour: the exposed surface is topsoil essentially
   * everywhere, so every cell returned the same capacity. A footing at 1.5 m
   * bears on whatever is 1.5 m down, which is what actually varies.
   */
  update(world: World, params: OverlayParams): void {
    this.params = params;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const step = params.size / GRID;
    let samples = 0;

    for (let j = 0; j < GRID; j++) {
      const wz = params.minZ + (j + 0.5) * step;
      for (let i = 0; i < GRID; i++) {
        const wx = params.minX + (i + 0.5) * step;
        const o = (j * GRID + i) * 4;

        const hit = world.raycast(wx, 240, wz, 0, -1, 0, 400);
        if (!hit) {
          this.data[o + 3] = 0;
          continue;
        }
        samples++;
        // Bear on the material at founding level, not the topsoil above it.
        const foundingMat =
          world.sampleMaterial(wx, hit.y - params.footingDepth, wz) ?? hit.material;
        const cap = bearingCapacityOfMaterial(foundingMat, params.footingWidth, params.footingDepth);
        const util = utilisation(params.appliedKpa, cap);
        const c = utilisationColor(util);
        this.data[o] = c[0] * 255;
        this.data[o + 1] = c[1] * 255;
        this.data[o + 2] = c[2] * 255;
        this.data[o + 3] = 255;
      }
    }

    this.lastSamples = samples;
    this.lastMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
