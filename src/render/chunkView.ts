/**
 * Three.js mesh lifecycle for terrain chunks.
 *
 * One Mesh per chunk with a shared material. Material ids arrive as a per-vertex
 * float attribute and are turned into colours in the shader by indexing a small
 * palette, so the strata are visible without a texture and without splitting the
 * mesh per material.
 */
import * as THREE from 'three';
import { CHUNK_M } from '../core/config.ts';
import { MATERIALS } from '../terrain/geology.ts';
import type { ChunkMesh } from '../terrain/world.ts';

/** Highest material id plus one; sizes the shader palette. */
const PALETTE_SIZE = 16;

function buildPalette(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const p = MATERIALS[i];
    const c = p ? p.color : ([1, 0, 1] as const);
    out.push(new THREE.Vector3(c[0], c[1], c[2]));
  }
  return out;
}

export interface ChunkViewOptions {
  /** Show the cut plane; fragments on the far side are discarded. */
  clipEnabled: boolean;
  clipNormal: THREE.Vector3;
  clipPoint: THREE.Vector3;
}

export class ChunkViewManager {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.Mesh>();
  private material: THREE.ShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;

  constructor() {
    this.group.name = 'terrain';
    this.uniforms = {
      uPalette: { value: buildPalette() },
      uLightDir: { value: new THREE.Vector3(0.42, 0.82, 0.38).normalize() },
      uClipEnabled: { value: 0 },
      uClipNormal: { value: new THREE.Vector3(1, 0, 0) },
      uClipPoint: { value: new THREE.Vector3() },
      uOverlayEnabled: { value: 0 },
      uOverlayTex: { value: null },
      /** World-space XZ rect the overlay texture covers: (minX, minZ, sizeX, sizeZ). */
      uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFogColor: { value: new THREE.Color(0x9fb6cc) },
      uFogNear: { value: 90 },
      uFogFar: { value: 340 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aMaterial;
        varying vec3 vNormalW;
        varying vec3 vWorld;
        varying float vMaterial;
        void main() {
          vMaterial = aMaterial;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uPalette[${PALETTE_SIZE}];
        uniform vec3 uLightDir;
        uniform float uClipEnabled;
        uniform vec3 uClipNormal;
        uniform vec3 uClipPoint;
        uniform float uOverlayEnabled;
        uniform sampler2D uOverlayTex;
        uniform vec4 uOverlayRect;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vNormalW;
        varying vec3 vWorld;
        varying float vMaterial;

        vec3 paletteLookup(int idx) {
          // WebGL2 allows dynamic indexing, but a loop keeps this safe on any
          // driver and the palette is tiny.
          for (int i = 0; i < ${PALETTE_SIZE}; i++) {
            if (i == idx) return uPalette[i];
          }
          return vec3(1.0, 0.0, 1.0);
        }

        void main() {
          if (uClipEnabled > 0.5 && dot(vWorld - uClipPoint, uClipNormal) > 0.0) discard;

          vec3 base = paletteLookup(int(vMaterial + 0.5));

          if (uOverlayEnabled > 0.5) {
            vec2 uv = (vWorld.xz - uOverlayRect.xy) / uOverlayRect.zw;
            if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
              vec4 ov = texture2D(uOverlayTex, uv);
              // Only tint near-horizontal surfaces: the heatmap is about what you
              // could found on, and a vertical face is not that.
              float up = max(0.0, vNormalW.y);
              base = mix(base, ov.rgb, ov.a * 0.75 * up);
            }
          }

          vec3 n = normalize(vNormalW);
          float diff = max(0.0, dot(n, uLightDir));
          // Cheap hemispheric ambient so cave interiors are not pure black.
          float amb = 0.34 + 0.16 * (0.5 + 0.5 * n.y);
          vec3 col = base * (amb + 0.72 * diff);

          float d = length(vWorld - cameraPosition);
          float f = clamp((d - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
          col = mix(col, uFogColor, f * 0.85);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  }

  /** Install or replace the mesh for a chunk. */
  upsert(m: ChunkMesh): void {
    let mesh = this.meshes.get(m.key);
    if (m.triangleCount === 0) {
      if (mesh) this.remove(m.key);
      return;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    geom.setAttribute('aMaterial', new THREE.BufferAttribute(m.materials, 1));
    geom.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geom.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK_M * 0.5, CHUNK_M * 0.5, CHUNK_M * 0.5),
      CHUNK_M * 0.95,
    );

    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geom;
    } else {
      mesh = new THREE.Mesh(geom, this.material);
      mesh.position.set(m.cx * CHUNK_M, m.cy * CHUNK_M, m.cz * CHUNK_M);
      mesh.frustumCulled = true;
      mesh.name = `chunk ${m.key}`;
      this.meshes.set(m.key, mesh);
      this.group.add(mesh);
    }
  }

  remove(key: string): void {
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(key);
  }

  get meshCount(): number {
    return this.meshes.size;
  }

  setClip(enabled: boolean, point?: THREE.Vector3, normal?: THREE.Vector3): void {
    this.uniforms.uClipEnabled!.value = enabled ? 1 : 0;
    if (point) (this.uniforms.uClipPoint!.value as THREE.Vector3).copy(point);
    if (normal) (this.uniforms.uClipNormal!.value as THREE.Vector3).copy(normal).normalize();
  }

  setOverlay(tex: THREE.Texture | null, minX: number, minZ: number, sizeX: number, sizeZ: number): void {
    this.uniforms.uOverlayEnabled!.value = tex ? 1 : 0;
    this.uniforms.uOverlayTex!.value = tex;
    (this.uniforms.uOverlayRect!.value as THREE.Vector4).set(minX, minZ, sizeX, sizeZ);
  }

  dispose(): void {
    for (const key of [...this.meshes.keys()]) this.remove(key);
    this.material.dispose();
  }
}
