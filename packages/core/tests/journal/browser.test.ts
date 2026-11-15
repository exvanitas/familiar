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
import { writeWindowPath, writeWindowProblems } from './scenarios.ts';

const chrome = process.env.FAMILIAR_CHROME;
/**
 * What Chromium reports for the schema's upgrade (versionchange) transaction. No hint reaches it, so it
 * is the one transaction that isn't strict: it creates the schema and holds no data. See turn-design.md.
 */
const CHROMIUM_UPGRADE = 'default';
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
    // Every data transaction strict. The schema's upgrade, once per new database, is recorded apart.
    expect(summary.upgrades).toBeGreaterThanOrEqual(32);
    expect(summary.durabilities).toEqual({ data: ['strict'], schemaUpgrade: [CHROMIUM_UPGRADE] });
  }, 150_000);

  it('one owner: a second page waits for the Web Lock, and a reload of the first releases it', async () => {
    const context = await browser.newContext();
    const url = `${base}?mode=owner&run=owner-${Date.now()}`;
    const first = await context.newPage();
    await first.goto(url);
    await first.waitForFunction(() => (window as any).__familiar?.owned === true, undefined, { timeout: 10_000 });
    const second = await context.newPage();
    await second.goto(url);
    await second.waitForTimeout(500);
    expect(await second.evaluate(() => (window as any).__familiar?.owned ?? false)).toBe(false);
    // A reload is a kill of the page: its lock goes with it, and the waiting page gets it.
    await first.reload();
    await second.waitForFunction(() => (window as any).__familiar?.owned === true, undefined, { timeout: 10_000 });
    await first.waitForTimeout(300);
    expect(await first.evaluate(() => (window as any).__familiar?.owned ?? false)).toBe(false);
    await context.close();
  }, 30_000);

  /** One write-window run: life 1 killed as `killAfter` says, or closed `delayMs` after the tool starts. */
  const writeWindow = async (opts: { killAfter: number } | { delayMs: number }) => {
    const context = await browser.newContext();
    const tag = 'killAfter' in opts ? `k${opts.killAfter}` : `d${opts.delayMs}`;
    const url = `${base}?scenario=write-window&run=ww-${tag}-${Date.now()}&killAfter=${'killAfter' in opts ? opts.killAfter : 0}`;
    const first = await context.newPage();
    await first.goto(url);
    await result(first, 'ready');
    if ('delayMs' in opts) await first.waitForTimeout(opts.delayMs);
    await first.close();
    const second = await context.newPage();
    await second.goto(url);
    const { summary } = await result(second, 'done');
    await context.close();
    return summary;
  };

  it('a built-in write killed at every point through its write commits exactly one row, matching its receipt', async () => {
    const problems: string[] = [];
    const paths = new Set<string>();
    // The connection dropped inside the page right after each transaction from the tool's start, then the page closed.
    for (let k = 1; k <= 14; k++) {
      const s = await writeWindow({ killAfter: k });
      problems.push(...writeWindowProblems(s).map((p) => `kill after transaction ${k}: ${p}`));
      paths.add(writeWindowPath(s));
    }
    // The page closed at seeded delays after the tool starts, across the write's whole window.
    for (let seed = 1, x = 7; seed <= 16; seed++) {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      const s = await writeWindow({ delayMs: x % 40 });
      problems.push(...writeWindowProblems(s).map((p) => `page closed ${x % 40} ms in: ${p}`));
      paths.add(writeWindowPath(s));
    }
    expect(problems).toEqual([]);
    expect(paths).toContain('receipt');
    expect(paths).toContain('made-again');
  }, 120_000);

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
      expect(summary.durabilities.data).toEqual(['strict']);
      // Life 2 opens a database that already exists: no upgrade runs.
      expect(summary.durabilities.schemaUpgrade).toEqual([]);
      check.verify(summary);
    }, 60_000);
  }
});
