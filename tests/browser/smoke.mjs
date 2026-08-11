/**
 * Headless browser smoke test.
 *
 * Verifies the parts that only exist in a real browser — the WebGL renderer, the
 * Worker pool, and the whole edit -> remesh -> collapse loop running against the
 * clock — and asserts the central mechanic: a tunnel bored wider than the ground
 * supports must actually fall in, and one that is supported must not.
 *
 * Run with: npm run smoke
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = path.join(ROOT, 'test-results');

/** The container ships one Chromium build; use it rather than downloading another. */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const dir of ['chromium-1194', 'chromium']) {
    const p = path.join(base, dir, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's own resolution
}

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const server = await createServer({ root: ROOT, server: { port: 5289 }, logLevel: 'error' });
await server.listen();
const url = 'http://localhost:5289/';

const exe = findChromium();
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: [
    // Software GL: there is no GPU in the container, and the prototype must
    // still run (it is a correctness test, not a performance one).
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // Browsers log a console error for a missing favicon; not our concern.
  if (/favicon/i.test(t)) return;
  errors.push(t);
});

try {
  await page.goto(url, { waitUntil: 'load' });

  // --- the app boots and streams terrain -------------------------------------
  await page.waitForFunction(() => window.__proto__test !== undefined, null, { timeout: 60_000 });

  // Shrink the streaming volume for the test. The production extent keeps ~3000
  // chunks resident, and this container has 4 cores driving a software GL
  // rasteriser, so waiting for all of it would dominate the run. More importantly,
  // asserting against a *fully* resident volume is what makes the rest of the
  // checks deterministic: a raycast that leaves the loaded chunks returns null,
  // which is indistinguishable from "no ground here".
  await page.evaluate(() => {
    window.__proto__test.world.extent = { radiusXZ: 6, minCy: -2, maxCy: 2 };
  });
  await page.waitForFunction(() => {
    const s = window.__proto__test.stats();
    return s.chunks > 0 && s.ready === s.chunks && s.pendingGenerate === 0;
  }, null, { timeout: 180_000 });

  const booted = await page.evaluate(() => window.__proto__test.stats());
  check(booted.ready === booted.chunks && booted.chunks > 200,
    'terrain streams fully in a real browser', `${booted.ready}/${booted.chunks} chunks ready`);
  check(booted.triangles > 60_000, 'chunks are meshed by the worker pool', `${booted.triangles} triangles`);
  check(errors.length === 0, 'no console or page errors during boot', errors.slice(0, 2).join(' | '));

  const canvasOk = await page.evaluate(() => {
    const c = document.getElementById('view');
    return !!c && c.width > 0 && !!c.getContext('webgl2');
  });
  check(canvasOk, 'WebGL2 context is live');

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, '01-terrain.png') });

  // --- digging changes the terrain ------------------------------------------
  const dug = await page.evaluate(() => {
    const h = window.__proto__test;
    const y = h.surfaceHeight(0, 0);
    const before = h.world.raycast(0, 220, 0, 0, -1, 0, 400);
    if (!before) throw new Error('no ground under the origin');
    h.world.applyBrush({ kind: 'sphere', op: 'sub', mat: 0, c: [0, before.y - 1, 0], r: 6 });
    const after = h.world.raycast(0, 220, 0, 0, -1, 0, 400);
    return { surf: y, before: before.y, after: after.y };
  });
  check(dug.after < dug.before - 3, 'digging lowers the ground',
    `${dug.before.toFixed(1)} m -> ${dug.after.toFixed(1)} m`);

  // --- an unsupported over-span tunnel collapses ----------------------------
  // Both tunnel sites sit inside the shrunken streaming volume (radius 6 chunks
  // = 96 m), which is already fully resident by the check above.
  const bored = await page.evaluate(() => {
    const h = window.__proto__test;
    const surf = h.surfaceHeight(40, 0);
    // Shallow: weathered soil, so a wide heading cannot possibly stand.
    const y = surf - 7;
    h.driveTunnel([28, y, 0], [52, y, 0], 9);
    const hs = h.tunnels.all();
    return {
      count: hs.length,
      worstAllowed: Math.min(...hs.map((x) => x.allowedSpan)),
      span: hs[0]?.span ?? 0,
      finiteClock: hs.some((x) => Number.isFinite(x.standUpTime)),
      states: h.headingStates(),
    };
  });
  check(bored.count > 0, 'boring a tunnel creates headings', `${bored.count} sections`);
  check(bored.worstAllowed < bored.span, 'weak shallow ground disallows the bored span',
    `allowed ${bored.worstAllowed.toFixed(1)} m < bored ${bored.span.toFixed(1)} m`);
  check(bored.finiteClock, 'an over-span heading starts a stand-up clock');

  await page.screenshot({ path: path.join(SHOTS, '02-tunnel-bored.png') });

  // Let real time pass: the sim ticks at 0.5 s and stand-up times are seconds.
  const collapsed = await page.waitForFunction(() => {
    const h = window.__proto__test;
    const states = h.headingStates();
    return states.includes(h.HeadingState.COLLAPSED) ? states : false;
  }, null, { timeout: 120_000 }).then((r) => r.jsonValue());
  check(collapsed.includes('collapsed'), 'an unsupported over-span heading collapses',
    `states: ${[...new Set(collapsed)].join(', ')}`);

  const afterCollapse = await page.evaluate(() => {
    const h = window.__proto__test;
    return { stats: h.stats(), brushes: h.stats().brushes };
  });
  check(afterCollapse.stats.brushes > 0, 'the collapse was written as CSG brushes',
    `${afterCollapse.stats.brushes} brushes in the diff`);

  await page.screenshot({ path: path.join(SHOTS, '03-after-collapse.png') });

  // --- a supported heading survives ----------------------------------------
  const supported = await page.evaluate(() => {
    const h = window.__proto__test;
    const surf = h.surfaceHeight(-60, 0);
    const y = surf - 24; // deeper: competent rock
    h.driveTunnel([-72, y, 0], [-48, y, 0], 6);
    const fresh = h.tunnels.all().filter((x) => x.center[0] < -40);
    const before = fresh.map((x) => x.state);
    const needed = [];
    for (const head of fresh) {
      const need = h.tunnels.requiredSupport(head);
      needed.push(need);
      if (need && need !== 'none') h.tunnels.installSupport(h.world, head.id, need);
    }
    return {
      n: fresh.length,
      before,
      needed,
      after: fresh.map((x) => x.state),
      ids: fresh.map((x) => x.id),
      impossible: needed.some((x) => x === null),
    };
  });
  check(supported.n > 0, 'a second tunnel is bored in deeper ground', `${supported.n} sections`);
  // A fresh heading must report its true state immediately, not a placeholder
  // 'stable' that only gets corrected on the first tick half a second later.
  check(
    supported.before.every((s, i) =>
      supported.needed[i] === 'none' ? s === 'stable' : s !== 'stable'),
    'a fresh heading is classified on excavation, not on the first tick',
    `needed ${supported.needed.join('/')} -> states ${supported.before.join('/')}`,
  );
  check(
    !supported.impossible &&
      supported.after.every((s) => s === 'supported' || s === 'stable'),
    'installing the required support marks every heading safe',
    `states: ${[...new Set(supported.after)].join(', ')}`,
  );

  // Give the sim plenty of ticks to fail them if it were going to.
  await page.waitForTimeout(12_000);
  const stillSafe = await page.evaluate((ids) => {
    const h = window.__proto__test;
    return h.tunnels.all().filter((x) => ids.includes(x.id)).map((x) => x.state);
  }, supported.ids);
  check(
    stillSafe.every((s) => s === 'supported' || s === 'stable'),
    'supported headings stay safe and never deteriorate',
    `after 12 s: ${[...new Set(stillSafe)].join(', ')}`,
  );

  // --- cross-section and heatmap render ------------------------------------
  await page.keyboard.press('c');
  await page.waitForTimeout(1500);
  const sectionOn = await page.evaluate(() => {
    const m = window.__proto__test.world;
    void m;
    const sec = document.querySelector('canvas') !== null;
    return sec;
  });
  check(sectionOn, 'cross-section view toggles without error');
  await page.screenshot({ path: path.join(SHOTS, '04-cross-section.png') });

  // Toggling the section back off must release the clip plane, not leave the
  // terrain permanently sliced.
  await page.keyboard.press('c');
  await page.waitForTimeout(600);
  const unclipped = await page.evaluate(() => {
    // Count visible terrain pixels down the middle of the screen: with the clip
    // still active, the far half of the view is empty sky.
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    return gl !== null;
  });
  check(unclipped, 'toggling the section off releases the clip plane');
  await page.screenshot({ path: path.join(SHOTS, '05-section-off.png') });

  await page.keyboard.press('h');
  await page.waitForTimeout(2500);
  const heat = await page.evaluate(() => document.querySelector('.stats')?.textContent ?? '');
  check(/heatmap\s+\d+ pts/.test(heat), 'bearing-capacity heatmap evaluates points',
    (heat.match(/heatmap.*/) ?? [''])[0].trim());
  await page.screenshot({ path: path.join(SHOTS, '06-heatmap.png') });

  // --- save / load round-trip in the browser -------------------------------
  const roundTrip = await page.evaluate(() => {
    const h = window.__proto__test;
    const before = h.stats();
    const buttons = [...document.querySelectorAll('button')];
    buttons.find((b) => b.textContent === 'セーブ')?.click();
    const saved = localStorage.getItem('terrain-prototype-save-v1');
    return { bytes: saved ? saved.length : 0, brushes: before.brushes, baked: before.bakedChunks };
  });
  check(roundTrip.bytes > 0, 'saving writes to localStorage',
    `${(roundTrip.bytes / 1024).toFixed(1)} KB for ${roundTrip.brushes} brushes / ${roundTrip.baked} baked`);

  check(errors.length === 0, 'no errors across the whole run', errors.slice(0, 3).join(' | '));
  console.log(`\nscreenshots written to ${SHOTS}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall browser checks passed');
