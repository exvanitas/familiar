// The run lifecycle's own regressions (docs/mcp-design.md 5.4, the machine in wire/lifecycle.ts): each a
// sequence the old lifecycle code got wrong, run against the real driver.
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { memorySettingsStore } from '../../../src/settings/store.ts';
import { testPaths, REPO } from '../fake.ts';
import { initResult, listResult, realClock, textResult } from '../wire-fakes.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const setup = { kind: 'local' as const, id: 'l1', label: 'L', program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] };
const open = (processes: ProcessPort) => McpClient.open({ store: memorySettingsStore(), processes, net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });

/** A local server that answers its handshake and list at once; `over` replaces any of its port's calls. */
function server(over: Partial<ProcessPort> = {}) {
  let emit!: (e: ProcessEvent) => void;
  let stops = 0;
  let starts = 0;
  const port: ProcessPort = {
    async start(_s, on) {
      emit = on;
      return { run: `p${++starts}` };
    },
    async write(_r, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      queueMicrotask(() => {
        if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
        if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) });
        if (m.method === 'tools/call') emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'ok')) });
      });
    },
    async stop() {
      stops++;
      queueMicrotask(() => emit({ t: 'exit', code: 0 }));
    },
    async forget() {},
    ...over
  };
  return { port, emit: (e: ProcessEvent) => emit(e), stops: () => stops, starts: () => starts, refuseStops: () => (port.stop = async () => { stops++; throw Object.assign(new Error('refused'), { kind: 'failed' }); }) };
}

describe('Ready on a fresh catalog only', () => {
  it('a tools-changed notice during the final drain: Start walks again before Ready, and a call right after goes out', async () => {
    let emit!: (e: ProcessEvent) => void;
    let lists = 0;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        if (m.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(initResult(m.id)) }));
        if (m.method === 'tools/list') {
          lists++;
          queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) }));
          // The first list's write is acknowledged only after a notice arrives.
          if (lists === 1) {
            await sleep(10);
            emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) });
            await sleep(10);
          }
        }
        if (m.method === 'tools/call') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'ok')) }));
      },
      async stop() {
        queueMicrotask(() => emit({ t: 'exit', code: 0 }));
      },
      async forget() {}
    };
    const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} });
    expect((await link.start(local, 'L')).ok).toBe(true);
    expect(lists).toBe(2);
    expect(link.current).toMatchObject({ ready: true, stale: false });
    const call = link.handoff('look', '{}', new AbortController().signal, 1000);
    expect(call).toBeDefined();
    expect(await call).toMatchObject({ kind: 'result', text: 'ok' });
    await link.stop();
  });
});

describe('a relaunch only after a list nobody answered', () => {
  it('a modern list answered {result: null} (a line the parser rejects), then an exit: no relaunch', async () => {
    let emit!: (e: ProcessEvent) => void;
    let starts = 0;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: `p${++starts}` };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        if (m.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }) }));
        if (m.method === 'tools/list') {
          queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: null }) }));
          setTimeout(() => emit({ t: 'exit', code: 0 }), 20);
        }
      },
      async stop() {},
      async forget() {}
    };
    const r = await new ServerLink('m', { processes: port }, realClock, { ended: () => {} }).start(local, 'L');
    expect(r.ok).toBe(false);
    // No relaunch, asked for (the old shape) or made (a second native start).
    expect(r).not.toHaveProperty('relaunch');
    expect(starts).toBe(1);
  });
});

describe('a Stop the exe refuses', () => {
  it('a second Stop says the server may still be running too, and asks no second native stop', async () => {
    const s = server();
    s.refuseStops();
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    expect((await client.start('l1')).kind).toBe('ready');
    const a = await client.stop('l1');
    const b = await client.stop('l1');
    expect(a).toMatchObject({ kind: 'failed', failure: { words: expect.stringMatching(/may still be running/) } });
    expect(b).toMatchObject({ kind: 'failed', failure: { words: expect.stringMatching(/may still be running/) } });
    expect(s.stops()).toBe(1);
    // Its exit lifts the fence: then Stop says stopped, and Start runs again.
    s.emit({ t: 'exit', code: 0 });
    await sleep(5);
    expect(await client.stop('l1')).toEqual({ kind: 'stopped' });
  });

  it('during a pending native start: Stop answers, and the owner is free once the start has answered', async () => {
    let release!: () => void;
    const s = server({
      async start(_s, on) {
        void on;
        await new Promise<void>((r) => (release = r));
        return { run: 'p1' };
      }
    });
    s.refuseStops();
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    await client.add({ setup: { ...setup, id: 'l2', label: 'M' }, problems: [] });
    const starting = client.start('l1');
    await sleep(5);
    const stopping = client.stop('l1');
    await sleep(5);
    release();
    const stop = await Promise.race([stopping, sleep(1_000).then(() => 'hung' as const)]);
    expect(stop).toMatchObject({ kind: 'failed', failure: { words: expect.stringMatching(/may still be running/) } });
    expect(await Promise.race([starting, sleep(500).then(() => 'hung' as const)])).not.toBe('hung');
    expect(client.owner.busy).toBe(false);
    // Settings and other servers are usable again.
    await expect(client.setEnabled('l2', true)).resolves.toBeUndefined();
  });

  it("Test whose own stop is refused answers failed, in words that say so, and a later Stop doesn't say stopped", async () => {
    const s = server();
    s.refuseStops();
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    const report = await client.test('l1');
    expect(report).toMatchObject({ ok: false, failure: { words: expect.stringMatching(/may still be running/) } });
    expect(await client.stop('l1')).toMatchObject({ kind: 'failed' });
  });
});

describe('a refused Test changes nothing', () => {
  it("a Test refused while the owner is busy leaves the earlier start's failure where it was", async () => {
    const s = server({
      async start() {
        throw Object.assign(new Error('declined'), { kind: 'declined' });
      }
    });
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    await client.start('l1');
    expect(client.get('l1')).toMatchObject({ phase: 'failed', failure: { kind: 'declined' } });
    const busy = client.owner.admit('other');
    const report = await client.test('l1');
    if ('release' in busy) busy.release();
    expect(report.ok).toBe(false);
    expect(client.get('l1')).toMatchObject({ phase: 'failed', failure: { kind: 'declined' } });
  });
});
