/**
 * Cross-section view: the single most important readability feature.
 *
 * A collapse the player cannot explain is indistinguishable from a bug, so being
 * able to look at the strata, the cover and the support from the side is not a
 * nice-to-have.
 *
 * Implementation note — why a CPU-sampled DataTexture rather than a clip plane
 * with a capped surface: the geology function would otherwise have to be
 * reimplemented in GLSL and kept in sync with the TypeScript one forever. Here
 * the cut face is one quad textured from the *same* TypeScript functions the
 * simulation uses, so there is exactly one definition of the geology. A
 * 256x192 slice is ~49k samples, which is a few milliseconds, and it is only
 * regenerated when the plane moves.
 */
import * as THREE from 'three';
import { materialProps, columnGeology, materialAtColumn, Mat } from '../terrain/geology.ts';
import { densityFromSurface } from '../terrain/density.ts';
import type { World } from '../terrain/world.ts';

const TEX_W = 256;
const TEX_H = 192;

export interface SliceParams {
  /** Cut runs along +X at this Z, showing the X-Y plane. */
  z: number;
  /** World X range shown. */
  x0: number;
  x1: number;
  /** World Y range shown. */
  y0: number;
  y1: number;
}

export class CrossSectionView {
  readonly mesh: THREE.Mesh;
  private texture: THREE.DataTexture;
  private data: Uint8Array;
  private material: THREE.MeshBasicMaterial;
  private params: SliceParams = { z: 0, x0: 0, x1: 64, y0: -16, y1: 48 };

  constructor() {
    this.data = new Uint8Array(TEX_W * TEX_H * 4);
    this.texture = new THREE.DataTexture(this.data, TEX_W, TEX_H, THREE.RGBAFormat);
    this.texture.needsUpdate = true;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.name = 'cross-section';
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  get slice(): SliceParams {
    return this.params;
  }

  /**
   * Re-sample the cut face.
   *
   * Reads the *edited* world where it is resident (so tunnels, cuts and fills
   * appear) and falls back to the procedural base outside the loaded volume, so
   * the section is continuous even at the edge of streaming.
   */
  update(world: World, params: SliceParams, seed: number): void {
    this.params = params;
    const { x0, x1, y0, y1, z } = params;
    const dx = (x1 - x0) / TEX_W;
    const dy = (y1 - y0) / TEX_H;

    for (let px = 0; px < TEX_W; px++) {
      const wx = x0 + (px + 0.5) * dx;
      const col = columnGeology(wx, z, seed);
      for (let py = 0; py < TEX_H; py++) {
        // Texture row 0 is the bottom of the plane geometry.
        const wy = y0 + (py + 0.5) * dy;
        const o = (py * TEX_W + px) * 4;

        let solid: boolean;
        let mat: number;
        const d = world.sampleDensity(wx, wy, z);
        if (d === null) {
          solid = densityFromSurface(wx, wy, z, col.surf, seed) < 0;
          mat = solid ? materialAtColumn(col, wx, wy, z, seed) : Mat.AIR;
        } else {
          solid = d < 0;
          mat = solid ? (world.sampleMaterial(wx, wy, z) ?? Mat.AIR) : Mat.AIR;
        }

        if (!solid) {
          // Air: dark, and lighter above ground than in a void, so an
          // excavated cavity reads differently from open sky.
          const underground = wy < col.surf;
          this.data[o] = underground ? 22 : 150;
          this.data[o + 1] = underground ? 24 : 178;
          this.data[o + 2] = underground ? 30 : 205;
          this.data[o + 3] = 255;
          continue;
        }

        const c = materialProps(mat).color;
        // Faint horizontal banding so individual strata are countable.
        const band = 0.9 + 0.1 * (Math.floor(wy * 2) % 2);
        this.data[o] = Math.min(255, c[0] * 255 * band);
        this.data[o + 1] = Math.min(255, c[1] * 255 * band);
        this.data[o + 2] = Math.min(255, c[2] * 255 * band);
        this.data[o + 3] = 255;
      }
    }

    this.texture.needsUpdate = true;
    // Place the quad in the world so it sits exactly on the cut.
    this.mesh.scale.set(x1 - x0, y1 - y0, 1);
    this.mesh.position.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, z);
    this.mesh.rotation.set(0, 0, 0);
  }

  /** Mark a heading on the section, in texture space, for the HUD to draw over. */
  worldToTexUv(x: number, y: number): [number, number] {
    const { x0, x1, y0, y1 } = this.params;
    return [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)];
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
