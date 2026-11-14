import { readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp } from '../src/http.ts';
import { OUTSIDE_CONTENT, SECRET_ENV, SERVER_NAME, fakeTools } from '../src/server.ts';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Stdio {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
}

async function startStdio(args: string[] = [], env: Record<string, string> = {}): Promise<Stdio> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, ...args], env, stderr: 'pipe' });
  let err = '';
  transport.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const client = new Client({ name: 'familiar-test', version: '0.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, transport, stderr: () => err };
}

function textOf(result: unknown): string {
  return (result as CallToolResult).content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

describe('the fake MCP server over stdio', () => {
  it('lists its tools as written, marking which only read', async () => {
    const { client } = await startStdio();
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint ?? false])).toEqual([
      ['echo', true],
      ['add_note', false],
      ['slow', true],
      ['fail', true],
      ['crash', false],
      ['print_secret', true],
      ['list_env', true],
      ['spawn_tree', false],
      ['read_page', true]
    ]);
    expect(tools).toEqual(fakeTools('a'));
  });

  it('spawn_tree starts a child and a grandchild that live on, and says their ids', async () => {
    const { client } = await startStdio();
    const ids = JSON.parse(textOf(await client.callTool({ name: 'spawn_tree', arguments: { token: 'tok12345' } }))) as Record<string, number>;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (const k of ['server', 'child', 'grandchild']) expect(alive(ids[k]), k).toBe(true);
      expect(new Set([ids.server, ids.child, ids.grandchild]).size).toBe(3);
      // The token rides on each command line: the grandchild got it as its last argument.
      if (process.platform === 'linux') {
        const argv = readFileSync(`/proc/${ids.grandchild}/cmdline`, 'utf8').split('\0').filter(Boolean);
        expect(argv.at(-1)).toBe('tok12345');
      }
      expect(textOf(await client.callTool({ name: 'spawn_tree', arguments: { token: 'BAD token' } }))).toMatch(/token must be/);
    } finally {
      for (const k of ['grandchild', 'child']) { try { process.kill(ids[k]); } catch { /* gone */ } }
    }
  });

  it('echoes, and variant b changes the description and the answer', async () => {
    const a = await startStdio();
    expect(textOf(await a.client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('hi');
    const b = await startStdio(['--variant', 'b']);
    const echoB = (await b.client.listTools()).tools.find((t) => t.name === 'echo');
    expect(echoB?.description).not.toBe(fakeTools('a')[0]!.description);
    expect(textOf(await b.client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('HI');
  });

  it('saves notes with ids in order', async () => {
    const { client } = await startStdio();
    expect(textOf(await client.callTool({ name: 'add_note', arguments: { text: 'one' } }))).toBe('Saved note n1.');
    expect(textOf(await client.callTool({ name: 'add_note', arguments: { text: 'two' } }))).toBe('Saved note n2.');
  });

  it('answers a bad argument and the fail tool with tool errors, and an unknown tool with a protocol error', async () => {
    const { client } = await startStdio();
    const bad = (await client.callTool({ name: 'echo', arguments: { text: 5 } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    const failed = (await client.callTool({ name: 'fail', arguments: {} })) as CallToolResult;
    expect(failed.isError).toBe(true);
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool/);
  });

  it('prints its secret in its answer and its log', async () => {
    const { client, stderr } = await startStdio([], { [SECRET_ENV]: 'swordfish-123' });
    expect(textOf(await client.callTool({ name: 'print_secret', arguments: {} }))).toContain('swordfish-123');
    await expect.poll(stderr).toContain('the secret is swordfish-123');
  });

  it('lists the names of its settings, never their values', async () => {
    const { client } = await startStdio([], { [SECRET_ENV]: 'swordfish-123' });
    const names = textOf(await client.callTool({ name: 'list_env', arguments: {} }));
    expect(names.split('\n')).toContain(SECRET_ENV);
    expect(names).not.toContain('swordfish-123');
  });

  it('returns outside content with an instruction planted in it', async () => {
    const { client } = await startStdio();
    expect(textOf(await client.callTool({ name: 'read_page', arguments: {} }))).toBe(OUTSIDE_CONTENT);
  });

  it('stops a slow call when cancelled, and keeps serving', async () => {
    const { client } = await startStdio();
    const controller = new AbortController();
    const call = client.callTool({ name: 'slow', arguments: { ms: 30_000 } }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(call).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'still here' } }))).toBe('still here');
    expect(textOf(await client.callTool({ name: 'slow', arguments: { ms: 10 } }))).toBe('Done after 10 ms.');
  });

  it('exits in the middle of a crash call, so the call fails and the connection closes', async () => {
    const { client } = await startStdio();
    const closed = new Promise<void>((resolve) => (client.onclose = resolve));
    await expect(client.callTool({ name: 'crash', arguments: {} })).rejects.toThrow();
    await closed;
  });
});

describe('the fake MCP server over HTTP', () => {
  it('serves the same tools in-process', async () => {
    const handle = await startHttp({ env: { [SECRET_ENV]: 'swordfish-123' } });
    cleanups.push(() => handle.close());
    const client = new Client({ name: 'familiar-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    cleanups.unshift(() => client.close());
    expect((await client.listTools()).tools).toEqual(fakeTools('a'));
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'over http' } }))).toBe('over http');
    expect(textOf(await client.callTool({ name: 'add_note', arguments: { text: 'a' } }))).toBe('Saved note n1.');
    expect(textOf(await client.callTool({ name: 'add_note', arguments: { text: 'b' } }))).toBe('Saved note n2.');
  });

  it('runs as a program with --http and says where it listens', async () => {
    const child = spawn(process.execPath, [MAIN, '--http', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => killed(child));
    const url = await readyUrl(child);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: 'familiar-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(fakeTools().length);
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
