// The journal on real Chromium IndexedDB, headless: pi-durable's storage conformance suite against the
// strict store, and every kill scenario with the page closed at its kill point and opened again.
//
// Chromium comes from FAMILIAR_CHROME (CI points it at the runner's Chrome). Without it the suite is
// skipped, unless FAMILIAR_REQUIRE_BROWSER=1, as in CI, where a missing browser fails.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from './checks.ts';

const chrome = process.env.FAMILIAR_CHROME;
const required = process.env.FAMILIAR_REQUIRE_BROWSER === '1';

describe.runIf(chrome || required)('the journal in headless Chromium (real IndexedDB, the page closed at the kill point)', () => {
  let browser: Browser;
  let server: Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    if (!chrome) throw new Error('FAMILIAR_REQUIRE_BROWSER=1, but FAMILIAR_CHROME names no browser.');
    dir = mkdtempSync(join(tmpdir(), 'familiar-page-'));
    await build({
      entryPoints: [join(import.meta.dirname, 'page.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outfile: join(dir, 'page.js'),
      logLevel: 'warning'
    });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>journal</title><script type="module" src="/page.js"></script>');
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const file = path === '/' ? 'index.html' : path === '/page.js' ? 'page.js' : undefined;
      if (!file) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(readFileSync(join(dir, file)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    browser = await chromium.launch({ executablePath: chrome, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const result = async (page: Page, key: 'ready' | 'done', timeout = 30_000) => {
    await page.waitForFunction((k) => (window as any).__familiar?.[k] === true || (window as any).__familiar?.failed, key, { timeout, polling: 20 });
    const value = await page.evaluate(() => (window as any).__familiar);
    if (value.failed) throw new Error(`the page failed: ${value.failed}`);
    return value;
  };

  it('pi-durable storage conformance suite passes against the strict IndexedDB store, every transaction strict', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}?mode=conformance&run=conf-${Date.now()}`);
    const { summary } = await result(page, 'done', 120_000);
    await context.close();
    expect(summary.conformance.failed).toEqual([]);
    expect(summary.conformance.total).toBe(32);
    expect(summary.conformance.passed).toBe(32);
    expect(summary.transactions).toBeGreaterThan(0);
    expect(summary.durabilities).toEqual(['strict']);
  }, 150_000);

  for (const [name, check] of Object.entries(CHECKS)) {
    it(`${name}: ${check.title}`, async () => {
      const context = await browser.newContext();
      const url = `${base}?scenario=${name}&run=${name}-${Date.now()}`;
      const first = await context.newPage();
      await first.goto(url);
      expect((await result(first, 'ready')).life).toBe(1);
      // The kill: the page goes, with whatever it had in flight. No shutdown path runs.
      await first.close();
      const second = await context.newPage();
      await second.goto(url);
      const { life, summary } = await result(second, 'done');
      await context.close();
      expect(life).toBe(2);
      expect(summary.durabilities).toEqual(['strict']);
      check.verify(summary);
    }, 60_000);
  }
});
