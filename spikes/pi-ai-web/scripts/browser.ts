// Builds the browser contract entry with Vite, serves it from the fake server's origin, and runs it in headless
// Chromium (the existing Playwright Chromium, no download). Every request the page makes is logged, to show
// nothing leaves for any other host.

import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { startFakeServer } from '../src/fake-server.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist', 'browser');
// HOME is a scratch directory during spike runs, so the browser path comes from the real user's profile.
const chrome =
  process.env.SPIKE_CHROMIUM ??
  join(process.env.SPIKE_REAL_HOME ?? homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

await build({
  root,
  base: './',
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: true,
    target: 'chrome120',
    rolldownOptions: {
      input: { contract: join(root, 'src/entries/browser-contract.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' }
    }
  }
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>spike</title><script type="module" src="./contract.js"></script>');

const server = await startFakeServer({ staticDir: join(root, 'dist') });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
let failed = false;
try {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  const statuses: string[] = [];
  page.on('response', (r) => statuses.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
  await page.goto(`${server.url}/page/browser/index.html`);
  await page.waitForFunction(() => '__familiarSpike' in globalThis);
  const targets = [
    { name: 'OpenAI-compatible', api: 'openai-completions', wire: 'openai', inject: true },
    { name: 'Anthropic', api: 'anthropic-messages', wire: 'anthropic', inject: true },
    { name: 'Gemini native', api: 'google-generative-ai', wire: 'gemini', inject: false },
    { name: 'Gemini OpenAI-compatible', api: 'openai-completions', wire: 'gemini-openai', inject: true }
  ];
  const result = await page.evaluate(
    async ([origin, t]) =>
      (globalThis as unknown as { __familiarSpike: { runAll(o: string, t: unknown): Promise<unknown> } }).__familiarSpike.runAll(origin, t),
    [server.url, targets] as const
  );
  const r = result as {
    results: { target: string; case: string; ok: boolean; error?: string }[];
    textEvents: Record<string, unknown[]>;
    counts: { injected: number; global: number };
  };
  console.log(`browser: ${await browser.version()}, user agent in page: ${await page.evaluate(() => navigator.userAgent)}`);
  for (const t of targets) {
    const rows = r.results.filter((x) => x.target === t.name);
    console.log(`\n${t.name}: ${rows.filter((x) => x.ok).length}/${rows.length} contract cases pass in the page`);
    for (const x of rows) console.log(`  ${x.ok ? 'pass' : 'FAIL'} ${x.case}${x.error ? ` (${x.error})` : ''}`);
    console.log(`  text scenario events: ${JSON.stringify(r.textEvents[t.name])}`);
  }
  console.log(`\nfetch calls in the page: injected ${r.counts.injected}, globalThis.fetch ${r.counts.global}`);
  const origin = new URL(server.url).origin;
  const elsewhere = requests.filter((u) => !u.split(' ')[1]!.startsWith(origin));
  const endpoints = requests.filter((u) => u.startsWith('POST '));
  console.log(`requests from the page: ${requests.length} total, ${endpoints.length} POSTs to fake endpoints, ${requests.length - endpoints.length} GETs for the page and its chunks, ${elsewhere.length} to any other host`);
  for (const u of elsewhere) console.log(`  other host: ${u}`);
  if (process.env.SPIKE_VERBOSE) for (const s of statuses) console.log(`  ${s}`);
  for (const l of consoleLines) console.log(`  console ${l}`);
  failed = r.results.some((x) => !x.ok) || elsewhere.length > 0;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
