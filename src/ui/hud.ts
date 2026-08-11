/**
 * HUD: tool palette, numeric readouts, and the event log.
 *
 * The design principle here is deliberate number exposure. Players of this genre
 * would rather see "allowable 200 kN/m^2, applied 340 kN/m^2" than a vague
 * warning icon, and showing the actual figures is also the difference between a
 * collapse that reads as a rule and one that reads as a bug.
 */
import { materialProps } from '../terrain/geology.ts';
import { bearingCapacityOfMaterial, utilisation } from '../sim/bearing.ts';
import { HeadingState, stateLabel, supportLabel, type Heading } from '../sim/tunnel.ts';
import { TOOL_LABELS, Tool, type ToolSettings, type ToolValue } from './tools.ts';
import type { WorldStats } from '../terrain/world.ts';

export interface HudCallbacks {
  onTool: (t: ToolValue) => void;
  onSetting: (key: keyof ToolSettings, value: number) => void;
  onToggleSection: (on: boolean) => void;
  onSectionZ: (z: number) => void;
  onToggleHeatmap: (on: boolean) => void;
  onSave: () => void;
  onLoad: () => void;
  onReset: () => void;
}

export interface ProbeInfo {
  hit: boolean;
  x: number;
  y: number;
  z: number;
  material: number;
  rmr: number;
  cover: number;
  sigmaV: number;
}

export class Hud {
  readonly root: HTMLDivElement;
  private toolButtons = new Map<ToolValue, HTMLButtonElement>();
  private statsEl: HTMLPreElement;
  private probeEl: HTMLDivElement;
  private headingsEl: HTMLDivElement;
  private logEl: HTMLDivElement;
  private logLines: string[] = [];

  constructor(cb: HudCallbacks, settings: ToolSettings) {
    this.root = document.createElement('div');
    this.root.className = 'hud';

    const panel = (title: string): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = 'panel';
      const h = document.createElement('h3');
      h.textContent = title;
      d.appendChild(h);
      this.root.appendChild(d);
      return d;
    };

    // --- tools ---
    const tools = panel('ツール');
    const grid = document.createElement('div');
    grid.className = 'tool-grid';
    for (const t of Object.values(Tool)) {
      const b = document.createElement('button');
      b.textContent = TOOL_LABELS[t];
      b.onclick = () => cb.onTool(t);
      grid.appendChild(b);
      this.toolButtons.set(t, b);
    }
    tools.appendChild(grid);

    const slider = (
      parent: HTMLElement,
      label: string,
      key: keyof ToolSettings,
      min: number,
      max: number,
      step: number,
      value: number,
      unit: string,
    ): void => {
      const row = document.createElement('label');
      row.className = 'slider';
      const span = document.createElement('span');
      span.textContent = `${label} ${value}${unit}`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.oninput = () => {
        const v = Number(input.value);
        span.textContent = `${label} ${v}${unit}`;
        cb.onSetting(key, v);
      };
      row.appendChild(span);
      row.appendChild(input);
      parent.appendChild(row);
    };
    slider(tools, '掘削半径', 'radius', 1, 10, 0.5, settings.radius, ' m');
    slider(tools, 'トンネル径', 'tunnelSpan', 2, 14, 0.5, settings.tunnelSpan, ' m');
    slider(tools, '道路幅', 'roadHalfWidth', 2, 10, 0.5, settings.roadHalfWidth, ' m');

    // --- views ---
    const views = panel('可視化');
    const check = (parent: HTMLElement, label: string, onChange: (v: boolean) => void): void => {
      const row = document.createElement('label');
      row.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.onchange = () => onChange(input.checked);
      row.appendChild(input);
      row.appendChild(document.createTextNode(label));
      parent.appendChild(row);
    };
    check(views, '断面ビュー', cb.onToggleSection);
    const zrow = document.createElement('label');
    zrow.className = 'slider';
    const zspan = document.createElement('span');
    zspan.textContent = '断面位置 Z 0 m';
    const zinput = document.createElement('input');
    zinput.type = 'range';
    zinput.min = '-200';
    zinput.max = '200';
    zinput.step = '1';
    zinput.value = '0';
    zinput.oninput = () => {
      zspan.textContent = `断面位置 Z ${zinput.value} m`;
      cb.onSectionZ(Number(zinput.value));
    };
    zrow.appendChild(zspan);
    zrow.appendChild(zinput);
    views.appendChild(zrow);
    check(views, '支持力ヒートマップ', cb.onToggleHeatmap);

    // --- persistence ---
    const save = panel('保存');
    const btnRow = document.createElement('div');
    btnRow.className = 'tool-grid';
    for (const [label, fn] of [
      ['セーブ', cb.onSave],
      ['ロード', cb.onLoad],
      ['リセット', cb.onReset],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      btnRow.appendChild(b);
    }
    save.appendChild(btnRow);

    // --- readouts ---
    const probe = panel('地点情報');
    this.probeEl = document.createElement('div');
    this.probeEl.className = 'readout';
    probe.appendChild(this.probeEl);

    const heads = panel('トンネル断面');
    this.headingsEl = document.createElement('div');
    this.headingsEl.className = 'readout';
    heads.appendChild(this.headingsEl);

    const stats = panel('統計');
    this.statsEl = document.createElement('pre');
    this.statsEl.className = 'stats';
    stats.appendChild(this.statsEl);

    const log = panel('ログ');
    this.logEl = document.createElement('div');
    this.logEl.className = 'log';
    log.appendChild(this.logEl);

    document.body.appendChild(this.root);
  }

  setActiveTool(t: ToolValue): void {
    for (const [k, b] of this.toolButtons) b.classList.toggle('active', k === t);
  }

  log(msg: string): void {
    this.logLines.unshift(msg);
    if (this.logLines.length > 40) this.logLines.length = 40;
    this.logEl.textContent = '';
    for (const l of this.logLines) {
      const d = document.createElement('div');
      d.textContent = l;
      this.logEl.appendChild(d);
    }
  }

  /** Ground readout at the cursor, including bearing capacity numbers. */
  updateProbe(p: ProbeInfo, footingWidth: number, appliedKpa: number): void {
    if (!p.hit) {
      this.probeEl.textContent = 'カーソルを地面に合わせてください';
      return;
    }
    const props = materialProps(p.material);
    const cap = bearingCapacityOfMaterial(p.material, footingWidth, 1.5);
    const util = utilisation(appliedKpa, cap);
    const rows: [string, string][] = [
      ['地質', props.name],
      ['座標', `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} m`],
      ['単位体積重量 γ', `${props.gamma} kN/m³`],
      ['粘着力 c', `${props.cohesion} kPa`],
      ['内部摩擦角 φ', `${props.friction}°`],
      ['一軸圧縮強度', props.ucs > 0 ? `${props.ucs} MPa` : '—'],
      ['RMR', `${p.rmr.toFixed(0)}`],
      ['土被り', `${p.cover.toFixed(1)} m`],
      ['鉛直応力 σv', `${p.sigmaV.toFixed(0)} kPa`],
      ['極限支持力', `${cap.ultimate.toFixed(0)} kN/m²`],
      ['許容支持力', `${cap.allowable.toFixed(0)} kN/m²`],
      ['作用圧力', `${appliedKpa.toFixed(0)} kN/m²`],
      ['余裕度', `${(util * 100).toFixed(0)} %`],
    ];
    this.probeEl.textContent = '';
    for (const [k, v] of rows) {
      const d = document.createElement('div');
      d.className = 'kv';
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('b');
      b.textContent = v;
      if (k === '余裕度') b.className = util > 1 ? 'bad' : util > 0.8 ? 'warn' : 'good';
      d.appendChild(a);
      d.appendChild(b);
      this.probeEl.appendChild(d);
    }
  }

  updateHeadings(headings: Heading[]): void {
    this.headingsEl.textContent = '';
    if (headings.length === 0) {
      this.headingsEl.textContent = 'まだ掘進していません';
      return;
    }
    // Most urgent first, so the one about to fail is always visible.
    const order: Record<string, number> = {
      [HeadingState.CRITICAL]: 0,
      [HeadingState.CONVERGING]: 1,
      [HeadingState.CRACKING]: 2,
      [HeadingState.COLLAPSED]: 3,
      [HeadingState.STABLE]: 4,
      [HeadingState.SUPPORTED]: 5,
      [HeadingState.OPEN_CUT]: 6,
    };
    const sorted = [...headings].sort((a, b) => (order[a.state]! - order[b.state]!) || a.id - b.id);
    for (const h of sorted.slice(0, 8)) {
      const d = document.createElement('div');
      d.className = `heading ${h.state}`;
      const remain = h.standUpTime === Infinity ? null : Math.max(0, h.standUpTime - h.elapsed);
      const bits =
        h.state === HeadingState.OPEN_CUT
          ? [`#${h.id}`, stateLabel(h.state), `掘削 ${h.span.toFixed(1)}m`, '天端崩落なし']
          : [
              `#${h.id}`,
              stateLabel(h.state),
              `RMR ${h.rmr.toFixed(0)}`,
              `無支保 ${h.allowedSpan.toFixed(1)}m / 掘削 ${h.span.toFixed(1)}m`,
              `土被り ${h.cover.toFixed(1)}m`,
              h.support !== 'none' ? supportLabel(h.support) : '',
              remain !== null && h.state !== HeadingState.COLLAPSED ? `残り ${remain.toFixed(0)}s` : '',
            ].filter(Boolean);
      d.textContent = bits.join(' · ');
      this.headingsEl.appendChild(d);
    }
  }

  updateStats(s: WorldStats, extra: Record<string, string | number>): void {
    const lines = [
      `chunks      ${s.ready}/${s.chunks} ready`,
      `generating  ${s.pendingGenerate}  queue ${s.workerQueue}`,
      `remesh q    ${s.queuedRemesh}`,
      `triangles   ${s.triangles.toLocaleString()}`,
      `brushes     ${s.brushes}  baked ${s.bakedChunks}`,
    ];
    for (const [k, v] of Object.entries(extra)) lines.push(`${k.padEnd(11)} ${v}`);
    this.statsEl.textContent = lines.join('\n');
  }
}
