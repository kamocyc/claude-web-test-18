/**
 * Entry point: scene setup, camera control, input, and the frame loop.
 *
 * Frame budget shape (measured, see README):
 *   - editing a chunk's field   ~0.02 ms   (main thread, immediate)
 *   - re-extracting its surface ~1.2 ms    (worker, budgeted per frame)
 *   - generating a new chunk    ~14 ms     (worker, nearest-first)
 *   - geotech + tunnel tick     sub-ms     (main thread, every 0.5 s)
 * Nothing in the simulation runs per frame except debris integration.
 */
import * as THREE from 'three';
import { CHUNK_M, SIM_TICK_SECONDS, STREAM_RADIUS_XZ } from './core/config.ts';
import { World } from './terrain/world.ts';
import { MeshWorkerPool } from './terrain/workerPool.ts';
import { ChunkViewManager } from './render/chunkView.ts';
import { CrossSectionView } from './render/crossSection.ts';
import { BearingOverlay } from './render/overlay.ts';
import { DebrisSystem } from './sim/debris.ts';
import { TunnelSim, HeadingState } from './sim/tunnel.ts';
import { overburdenAt } from './sim/stress.ts';
import { rmrAt } from './terrain/geology.ts';
import { surfaceHeight } from './terrain/geology.ts';
import {
  Tool,
  TOOL_LABELS,
  buildRoad,
  defaultToolSettings,
  digAt,
  driveTunnel,
  fillAt,
  installSupport,
  type PendingSegment,
  type ToolContext,
  type ToolValue,
} from './ui/tools.ts';
import { Hud } from './ui/hud.ts';
import {
  clearLocalStorage,
  loadFromLocalStorage,
  saveToLocalStorage,
} from './terrain/persist.ts';
import type { Brush } from './terrain/brush.ts';

const SEED = 1337;
/** Reference footing used by the probe readout and the heatmap. */
const REF_FOOTING_WIDTH = 3;
const REF_APPLIED_KPA = 300;

// ---------------------------------------------------------------- renderer ----

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setClearColor(0x9fb6cc);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.2, 2000);

// Lambert debris needs real lights; the terrain shader does its own lighting.
scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x4a4238, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(60, 110, 45);
scene.add(sun);

const chunkView = new ChunkViewManager();
scene.add(chunkView.group);
const crossSection = new CrossSectionView();
scene.add(crossSection.mesh);
const debris = new DebrisSystem();
scene.add(debris.mesh);
const overlay = new BearingOverlay();

// Brush preview ring, so a click's effect is visible before committing.
const preview = new THREE.Mesh(
  new THREE.SphereGeometry(1, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0x6ecbff, wireframe: true, transparent: true, opacity: 0.55 }),
);
preview.visible = false;
scene.add(preview);

// Marker for the first click of a two-point tool.
const startMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.8, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd166 }),
);
startMarker.visible = false;
scene.add(startMarker);

// ------------------------------------------------------------------- world ----

const world = new World(SEED, new MeshWorkerPool());
world.setMeshListener((m) => chunkView.upsert(m));
const tunnels = new TunnelSim();

// -------------------------------------------------------------- orbit camera ---

const target = new THREE.Vector3(0, surfaceHeight(0, 0, SEED), 0);
let yaw = 0.7;
let pitch = 0.62;
let dist = 90;

function updateCamera(): void {
  const cp = Math.cos(pitch);
  camera.position.set(
    target.x + Math.sin(yaw) * cp * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * cp * dist,
  );
  camera.lookAt(target);
}

let dragButton = -1;
let lastX = 0;
let lastY = 0;
let dragged = false;

canvas.addEventListener('pointerdown', (e) => {
  dragButton = e.button;
  lastX = e.clientX;
  lastY = e.clientY;
  dragged = false;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

  if (dragButton < 0) return;
  if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;

  if (dragButton === 0) {
    yaw -= dx * 0.005;
    pitch = Math.max(-1.45, Math.min(1.45, pitch + dy * 0.005));
  } else {
    // Pan in the camera's horizontal plane.
    const scale = dist * 0.0016;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    target.addScaledVector(right, -dx * scale);
    target.addScaledVector(fwd, -dy * scale);
  }
  updateCamera();
});

canvas.addEventListener('pointerup', (e) => {
  const wasDrag = dragged;
  const button = dragButton;
  dragButton = -1;
  canvas.releasePointerCapture(e.pointerId);
  if (button === 0 && !wasDrag) onClick();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  dist = Math.max(6, Math.min(600, dist * (1 + Math.sign(e.deltaY) * 0.1)));
  updateCamera();
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ----------------------------------------------------------------- picking ----

const pointer = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();

interface Pick {
  x: number;
  y: number;
  z: number;
  material: number;
}

function pickGround(): Pick | null {
  raycaster.setFromCamera(pointer, camera);
  const o = raycaster.ray.origin;
  const d = raycaster.ray.direction;
  const hit = world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 700);
  if (!hit) return null;
  return { x: hit.x, y: hit.y, z: hit.z, material: hit.material };
}

// ------------------------------------------------------------------- tools ----

let activeTool: ToolValue = Tool.DIG;
const settings = { ...defaultToolSettings };
let pendingSegment: PendingSegment | null = null;

function applyBrushes(brushes: Brush[]): number {
  const touched = new Set<string>();
  for (const b of brushes) {
    for (const ch of world.applyBrush(b)) touched.add(ch.key);
  }
  return touched.size;
}

const toolCtx: ToolContext = {
  world,
  tunnels,
  settings,
  apply: applyBrushes,
  log: (m) => hud.log(m),
};

function onClick(): void {
  const p = pickGround();
  if (!p) {
    hud.log('地面がありません（空をクリック）');
    return;
  }
  const point: [number, number, number] = [p.x, p.y, p.z];

  switch (activeTool) {
    case Tool.DIG:
      digAt(toolCtx, point);
      break;
    case Tool.FILL:
      fillAt(toolCtx, point);
      break;
    case Tool.SUPPORT:
      installSupport(toolCtx, point);
      break;
    case Tool.INSPECT: {
      const ob = overburdenAt(world, p.x, p.y, p.z);
      hud.log(
        `調査: ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} — ` +
          `RMR ${rmrAt(p.x, p.y, p.z, SEED).toFixed(0)}, 土被り ${ob.cover.toFixed(1)} m, σv ${ob.sigmaV.toFixed(0)} kPa`,
      );
      break;
    }
    case Tool.ROAD:
    case Tool.TUNNEL: {
      if (!pendingSegment || pendingSegment.tool !== activeTool) {
        pendingSegment = { tool: activeTool, start: point };
        startMarker.position.set(p.x, p.y, p.z);
        startMarker.visible = true;
        hud.log(`${TOOL_LABELS[activeTool]}: 始点を設定。終点をクリック`);
        return;
      }
      const a = pendingSegment.start;
      pendingSegment = null;
      startMarker.visible = false;
      if (activeTool === Tool.ROAD) buildRoad(toolCtx, a, point);
      else driveTunnel(toolCtx, a, point);
      break;
    }
  }
}

function setTool(t: ToolValue): void {
  activeTool = t;
  pendingSegment = null;
  startMarker.visible = false;
  hud.setActiveTool(t);
}

// --------------------------------------------------------------------- HUD ----

let sectionOn = false;
let sectionZ = 0;
let heatmapOn = false;

const hud = new Hud(
  {
    onTool: setTool,
    onSetting: (k, v) => {
      settings[k] = v;
    },
    onToggleSection: (on) => setSection(on),
    onSectionZ: (z) => {
      sectionZ = z;
      if (sectionOn) refreshSection();
    },
    onToggleHeatmap: (on) => {
      heatmapOn = on;
      if (on) refreshHeatmap();
      else chunkView.setOverlay(null, 0, 0, 1, 1);
    },
    onSave: () => {
      const bytes = saveToLocalStorage(world);
      hud.log(`セーブ完了 (${(bytes / 1024).toFixed(1)} KB)`);
    },
    onLoad: () => {
      try {
        world.reset();
        for (const key of [...chunkKeys()]) chunkView.remove(key);
        tunnels.clear();
        debris.clear();
        const r = loadFromLocalStorage(world, (ch) => world.injectChunk(ch));
        if (!r) {
          hud.log('セーブデータがありません');
          return;
        }
        hud.log(`ロード完了: 差分 ${r.diffChunks} チャンク / ベイク ${r.bakedChunks} / ブラシ ${r.brushes}`);
      } catch (e) {
        hud.log(`ロード失敗: ${(e as Error).message}`);
      }
    },
    onReset: () => {
      clearLocalStorage();
      world.reset();
      for (const key of [...chunkKeys()]) chunkView.remove(key);
      tunnels.clear();
      debris.clear();
      hud.log('リセットしました');
    },
  },
  settings,
);
hud.setActiveTool(activeTool);
hud.log('プロトタイプ起動。掘削ツールで地形を掘ってみてください。');

/** Keys of the chunk meshes currently installed, for wholesale removal. */
function chunkKeys(): string[] {
  const out: string[] = [];
  for (const ch of world.residentChunks()) out.push(ch.key);
  return out;
}

window.addEventListener('keydown', (e) => {
  const map: Record<string, ToolValue> = {
    '1': Tool.DIG, '2': Tool.FILL, '3': Tool.ROAD,
    '4': Tool.TUNNEL, '5': Tool.SUPPORT, '6': Tool.INSPECT,
  };
  const t = map[e.key];
  if (t) setTool(t);
  if (e.key === 'c' || e.key === 'C') setSection(!sectionOn);
  if (e.key === 'h' || e.key === 'H') {
    heatmapOn = !heatmapOn;
    if (heatmapOn) refreshHeatmap();
    else chunkView.setOverlay(null, 0, 0, 1, 1);
  }
});

/**
 * Turn the cross-section on or off.
 *
 * Both the checkbox and the keyboard shortcut route through here: when this was
 * duplicated, the "off" path forgot to release the clip plane, so switching the
 * section off left the terrain permanently sliced away.
 */
function setSection(on: boolean): void {
  sectionOn = on;
  crossSection.visible = on;
  if (on) refreshSection();
  else chunkView.setClip(false);
}

function refreshSection(): void {
  crossSection.update(
    world,
    { z: sectionZ, x0: target.x - 64, x1: target.x + 64, y0: -20, y1: 76 },
    SEED,
  );
  // Hide terrain in front of the cut so the section is actually visible.
  chunkView.setClip(true, new THREE.Vector3(0, 0, sectionZ), new THREE.Vector3(0, 0, 1));
}

function refreshHeatmap(): void {
  const size = 256;
  overlay.update(world, {
    minX: target.x - size / 2,
    minZ: target.z - size / 2,
    size,
    footingWidth: REF_FOOTING_WIDTH,
    footingDepth: 1.5,
    appliedKpa: REF_APPLIED_KPA,
  });
  chunkView.setOverlay(overlay.texture, target.x - size / 2, target.z - size / 2, size, size);
}

// ---------------------------------------------------------------- frame loop --

let last = performance.now();
let simAccum = 0;
let hudAccum = 0;
let frames = 0;
let fps = 0;
let fpsAccum = 0;

function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  world.updateStreaming([target.x, target.y, target.z]);
  world.pump([camera.position.x, camera.position.y, camera.position.z]);

  // Tunnel stability, on its own slow tick rather than per frame.
  tunnels.update(world, dt);
  const collapseBrushes = tunnels.drainBrushes();
  if (collapseBrushes.length > 0) applyBrushes(collapseBrushes);
  for (const ev of tunnels.drainEvents()) {
    hud.log(`[断面 #${ev.heading.id}] ${ev.message}`);
    if (ev.kind === 'collapse' || ev.kind === 'sinkhole') {
      debris.spawnBurst(
        ev.heading.center,
        ev.heading.span * 0.6,
        ev.kind === 'sinkhole' ? 150 : 90,
        ev.heading.weakestMat,
      );
    }
  }

  debris.update(world, dt);

  // Brush preview at the cursor.
  const p = pickGround();
  if (p && (activeTool === Tool.DIG || activeTool === Tool.FILL)) {
    preview.visible = true;
    preview.position.set(p.x, p.y, p.z);
    preview.scale.setScalar(settings.radius);
  } else {
    preview.visible = false;
  }

  // HUD readouts at 6 Hz; they involve column integration and are not free.
  hudAccum += dt;
  if (hudAccum > 1 / 6) {
    hudAccum = 0;
    if (p) {
      const ob = overburdenAt(world, p.x, p.y, p.z);
      hud.updateProbe(
        {
          hit: true, x: p.x, y: p.y, z: p.z, material: p.material,
          rmr: rmrAt(p.x, p.y, p.z, SEED), cover: ob.cover, sigmaV: ob.sigmaV,
        },
        REF_FOOTING_WIDTH,
        REF_APPLIED_KPA,
      );
    } else {
      hud.updateProbe({ hit: false, x: 0, y: 0, z: 0, material: 0, rmr: 0, cover: 0, sigmaV: 0 }, 3, 300);
    }
    hud.updateHeadings(tunnels.all());
    hud.updateStats(world.stats(), {
      fps: fps.toFixed(0),
      meshes: chunkView.meshCount,
      debris: debris.activeCount,
      heatmap: heatmapOn ? `${overlay.lastSamples} pts / ${overlay.lastMs.toFixed(1)} ms` : 'off',
      radius: `${STREAM_RADIUS_XZ} chunks (${(STREAM_RADIUS_XZ * CHUNK_M).toFixed(0)} m)`,
      tick: `${SIM_TICK_SECONDS}s`,
    });
  }

  // Refresh the section when it is showing, but not every frame.
  simAccum += dt;
  if (sectionOn && simAccum > 0.5) {
    simAccum = 0;
    refreshSection();
  }

  fpsAccum += dt;
  frames++;
  if (fpsAccum > 0.5) {
    fps = frames / fpsAccum;
    frames = 0;
    fpsAccum = 0;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);
resize();
updateCamera();
requestAnimationFrame(frame);

// Expose a small surface for the headless smoke test to drive the prototype.
interface ProtoHandle {
  world: World;
  tunnels: TunnelSim;
  driveTunnel: (a: [number, number, number], b: [number, number, number], span: number) => void;
  stats: () => ReturnType<World['stats']>;
  headingStates: () => string[];
  HeadingState: typeof HeadingState;
  surfaceHeight: (x: number, z: number) => number;
  ready: () => boolean;
}

const handle: ProtoHandle = {
  world,
  tunnels,
  driveTunnel: (a, b, span) => {
    settings.tunnelSpan = span;
    driveTunnel(toolCtx, a, b);
  },
  stats: () => world.stats(),
  headingStates: () => tunnels.all().map((h) => h.state),
  HeadingState,
  surfaceHeight: (x, z) => surfaceHeight(x, z, SEED),
  ready: () => world.stats().ready > 0,
};
(window as unknown as { __proto__test: ProtoHandle }).__proto__test = handle;
