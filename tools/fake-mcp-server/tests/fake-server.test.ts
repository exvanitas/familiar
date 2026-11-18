// The fake server, spoken to as raw JSON-RPC lines and POSTs: no MCP SDK on either side.
import { readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp } from '../src/http.ts';
import { MODERN_VERSION, OUTSIDE_CONTENT, SECRET_ENV, SERVER_NAME, fakeTools } from '../src/server.ts';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Stdio {
  request(method: string, params?: object): Promise<any>;
  notify(method: string, params?: object): void;
  lines: any[];
  stderr: () => string;
  exited: Promise<number | null>;
  lastId: () => number;
}

async function startStdio(args: string[] = [], env: Record<string, string> = {}): Promise<Stdio> {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  cleanups.push(() => killed(child));
  let err = '';
  child.stderr!.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const lines: any[] = [];
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on('line', (l) => {
    const m = JSON.parse(l);
    lines.push(m);
    if (m.id !== undefined && waiting.has(m.id)) waiting.get(m.id)!(m);
  });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  let n = 0;
  const s: Stdio = {
    lines,
    stderr: () => err,
    exited,
    lastId: () => n,
    request(method, params) {
      const id = ++n;
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
      return new Promise((r) => waiting.set(id, r));
    },
    notify(method, params) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
    }
  };
  const init = await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  expect(init.result.serverInfo.name).toBe(SERVER_NAME);
  s.notify('notifications/initialized');
  return s;
}

const textOf = (m: any) => m.result.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('');
const call = (s: Stdio, name: string, args: object = {}) => s.request('tools/call', { name, arguments: args });

describe('the fake MCP server over stdio', () => {
  it('lists its tools as written, marking which only read', async () => {
    const s = await startStdio();
    const { result } = await s.request('tools/list');
    expect(result.tools.map((t: any) => [t.name, t.annotations?.readOnlyHint ?? false])).toEqual([
      ['echo', true],
      ['add_note', false],
      ['slow', true],
      ['fail', true],
      ['crash', false],
      ['print_secret', true],
      ['list_env', true],
      ['spawn_tree', false],
      ['set_variant', false],
      ['read_page', true]
    ]);
    expect(result.tools).toEqual(fakeTools('a'));
  });

  it('spawn_tree starts a child and a grandchild that live on, and says their ids', async () => {
    const s = await startStdio();
    const ids = JSON.parse(textOf(await call(s, 'spawn_tree', { token: 'tok12345' }))) as Record<string, number>;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (const k of ['server', 'child', 'grandchild']) expect(alive(ids[k]!), k).toBe(true);
      expect(new Set([ids.server, ids.child, ids.grandchild]).size).toBe(3);
      if (process.platform === 'linux') {
        const argv = readFileSync(`/proc/${ids.grandchild}/cmdline`, 'utf8').split('\0').filter(Boolean);
        expect(argv.at(-1)).toBe('tok12345');
      }
      expect(textOf(await call(s, 'spawn_tree', { token: 'BAD token' }))).toMatch(/token must be/);
    } finally {
      for (const k of ['grandchild', 'child']) { try { process.kill(ids[k]!); } catch { /* gone */ } }
    }
  });

  it('echoes, and variant b changes the description and the answer', async () => {
    const a = await startStdio();
    expect(textOf(await call(a, 'echo', { text: 'hi' }))).toBe('hi');
    const b = await startStdio(['--variant', 'b']);
    const echoB = (await b.request('tools/list')).result.tools.find((t: any) => t.name === 'echo');
    expect(echoB?.description).not.toBe(fakeTools('a')[0]!.description);
    expect(textOf(await call(b, 'echo', { text: 'hi' }))).toBe('HI');
  });

  it('saves notes with ids in order', async () => {
    const s = await startStdio();
    expect(textOf(await call(s, 'add_note', { text: 'one' }))).toBe('Saved note n1.');
    expect(textOf(await call(s, 'add_note', { text: 'two' }))).toBe('Saved note n2.');
  });

  it('answers a bad argument and the fail tool with tool errors, an unknown tool with a protocol error, and a ping', async () => {
    const s = await startStdio();
    expect((await call(s, 'echo', { text: 5 })).result.isError).toBe(true);
    expect((await call(s, 'fail')).result.isError).toBe(true);
    expect((await call(s, 'nope')).error.message).toMatch(/Unknown tool/);
    expect(await s.request('ping')).toMatchObject({ result: {} });
  });

  it('prints its secret in its answer and its log', async () => {
    const s = await startStdio([], { [SECRET_ENV]: 'swordfish-123' });
    expect(textOf(await call(s, 'print_secret'))).toContain('swordfish-123');
    await expect.poll(s.stderr).toContain('the secret is swordfish-123');
  });

  it('lists the names of its settings, never their values', async () => {
    const s = await startStdio([], { [SECRET_ENV]: 'swordfish-123' });
    const names = textOf(await call(s, 'list_env'));
    expect(names.split('\n')).toContain(SECRET_ENV);
    expect(names).not.toContain('swordfish-123');
  });

  it('returns outside content with an instruction planted in it', async () => {
    const s = await startStdio();
    expect(textOf(await call(s, 'read_page'))).toBe(OUTSIDE_CONTENT);
  });

  it('stops a slow call when cancelled, and keeps serving', async () => {
    const s = await startStdio();
    void call(s, 'slow', { ms: 30_000 });
    const id = s.lastId();
    await new Promise((r) => setTimeout(r, 50));
    s.notify('notifications/cancelled', { requestId: id });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.lines.some((m) => m.id === id)).toBe(false);
    expect(textOf(await call(s, 'echo', { text: 'still here' }))).toBe('still here');
    expect(textOf(await call(s, 'slow', { ms: 10 }))).toBe('Done after 10 ms.');
  });

  it('set_variant says its tools changed before it answers', async () => {
    const s = await startStdio();
    await call(s, 'set_variant', { variant: 'b' });
    const at = s.lines.findIndex((m) => m.method === 'notifications/tools/list_changed');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(s.lines.length - 1);
  });

  it('exits in the middle of a crash call', async () => {
    const s = await startStdio();
    void call(s, 'crash');
    expect(await s.exited).toBe(3);
  });

  it('modern-only: refuses initialize with -32022 naming 2026-07-28, and serves enveloped requests', async () => {
    const child = spawn(process.execPath, [MAIN, '--era', 'modern'], { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanups.push(() => killed(child));
    const out: any[] = [];
    createInterface({ input: child.stdout! }).on('line', (l) => out.push(JSON.parse(l)));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } })}\n`);
    await expect.poll(() => out.length).toBe(2);
    expect(out[0]).toMatchObject({ id: 1, error: { code: -32022, data: { supported: [MODERN_VERSION] } } });
    expect(out[1]).toMatchObject({ id: 2, result: { resultType: 'complete' } });
  });
});

describe('the fake MCP server over HTTP', () => {
  const post = (url: string, body: object) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

  it('serves the same tools in-process; a notification gets 202, a GET 405', async () => {
    const handle = await startHttp({ env: { [SECRET_ENV]: 'swordfish-123' } });
    cleanups.push(() => handle.close());
    expect((await (await post(handle.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools).toEqual(fakeTools('a'));
    expect(textOf(await (await post(handle.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'over http' } } })).json())).toBe('over http');
    expect(textOf(await (await post(handle.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_note', arguments: { text: 'a' } } })).json())).toBe('Saved note n1.');
    expect((await post(handle.url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await fetch(handle.url)).status).toBe(405);
  });

  it('runs as a program with --http and says where it listens', async () => {
    const child = spawn(process.execPath, [MAIN, '--http', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => killed(child));
    const url = await readyUrl(child);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await (await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools).toHaveLength(fakeTools().length);
  });
});

function readyUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      if (line.startsWith('READY ')) resolve(line.slice('READY '.length));
    });
    child.once('exit', (code) => reject(new Error(`exited with ${code} before it was ready`)));
  });
}

function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}
