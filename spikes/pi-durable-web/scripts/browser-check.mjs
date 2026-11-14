// Builds the spike page with Vite (browser target, no Node polyfills), serves it, and drives headless Chromium
// through each scenario: start a turn, reload the page mid-turn, resume, and read what happened.

import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const here = join(import.meta.dirname, '..');
const out = join(here, 'dist', 'page');
const chrome = process.env.SPIKE_CHROME ?? join(process.env.SPIKE_REAL_HOME ?? homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

const buildWarnings = [];
await build({
  root: here,
  configFile: false,
  logLevel: 'warn',
  customLogger: undefined,
  build: { outDir: out, emptyOutDir: true, target: 'es2022', minify: false, reportCompressedSize: false },
  onwarn: undefined,
  plugins: [
    {
      name: 'record-warnings',
      configResolved(config) {
        const warn = config.logger.warn;
        config.logger.warn = (msg, opts) => {
          buildWarnings.push(String(msg));
          warn(msg, opts);
        };
      }
    }
  ]
});

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = join(out, path === '/' ? 'index.html' : path);
  if (!file.startsWith(out) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = {};
const pageErrors = [];

async function waitFor(page, fn, arg, timeout = 20000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 50 });
}
const counter = (page, run, name) => page.evaluate(([r, n]) => Number(localStorage.getItem(`${r}:${n}`) ?? '0'), [run, name]);

async function scenario(name, store, drive) {
  const run = `${name}-${store}-${Date.now()}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (e) => pageErrors.push(`${name}/${store}: ${e.message}`));
  const url = `${base}?scenario=${name}&store=${store}&run=${run}`;
  const t0 = Date.now();
  try {
    await page.goto(url);
    await drive(page, run, url);
    await waitFor(page, () => window.__spike?.done === true, undefined, 120000);
    const spike = await page.evaluate(() => window.__spike);
    results[`${name}/${store}`] = { ms: Date.now() - t0, ...(spike.failed ? { failed: spike.failed } : {}), ...spike.result };
  } catch (error) {
    results[`${name}/${store}`] = { failed: String(error), console: consoleLines.slice(-30) };
  } finally {
    await context.close();
  }
}

// A tool in flight at the reload.
const reloadWhenToolStarts = async (page, run) => {
  await waitFor(page, (r) => Number(localStorage.getItem(`${r}:tool-starts`) ?? '0') >= 1, run);
  await page.reload();
};

for (const store of ['idb', 'sqljs']) {
  await scenario('conformance', store, async () => {});
  await scenario('inflight-unsafe', store, reloadWhenToolStarts);
  await scenario('inflight-safe', store, reloadWhenToolStarts);
}

// Consent asked, never answered, then a reload.
await scenario('consent', 'idb', async (page, run) => {
  await waitFor(page, (r) => Number(localStorage.getItem(`${r}:consent-asks`) ?? '0') >= 1, run);
  await page.reload();
});
await scenario('consent-deny', 'idb', async () => {});

// The model stalls mid-answer; reload after the partial has had time to be stored (persistWithinMs is 1 s).
await scenario('midstream', 'idb', async (page, run) => {
  await waitFor(page, (r) => Number(localStorage.getItem(`${r}:model-requests`) ?? '0') >= 1, run);
  await page.waitForTimeout(1500);
  await page.reload();
});

// A parked reminder survives a reload before it is due.
await scenario('reminder', 'idb', async (page) => {
  await waitFor(page, () => window.__spike?.parked === true);
  await page.reload();
});
// The app is closed when the reminder is due; it fires on the next open.
await scenario('reminder-missed', 'idb', async (page, _run, url) => {
  await waitFor(page, () => window.__spike?.parked === true);
  await page.goto('about:blank');
  await new Promise((r) => setTimeout(r, 2500));
  await page.goto(url);
});

await scenario('turn-cap', 'idb', async () => {});

await browser.close();
server.close();

const summary = { chromium: chrome.split('/').slice(-3).join('/'), buildWarnings, pageErrors, results };
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'browser.json'), JSON.stringify(summary, null, 2));
for (const [k, v] of Object.entries(results)) {
  if (v.conformance) {
    console.log(`${k}: ${v.conformance.passed}/${v.conformance.total} storage conformance cases passed${v.conformance.failed.length ? '; failed: ' + v.conformance.failed.map((f) => f.name + ' (' + f.error + ')').join('; ') : ''}`);
    continue;
  }
  console.log(`${k}: ${v.failed ? 'FAILED ' + v.failed.split('\n')[0] : `settled=${v.settled?.status ?? '-'} reason=${v.settled?.reason ?? '-'} tool-starts=${v.counters?.toolStarts} consent=${v.counters?.consentAsks} model-requests=${v.counters?.modelRequests} reminders=${v.counters?.remindersFired} states=${v.states?.join('>')}`}`);
}
if (pageErrors.length) console.log('page errors:', pageErrors);
