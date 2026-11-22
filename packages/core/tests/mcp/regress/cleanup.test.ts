// Cleanup the exe didn't confirm (3.4): a rejected net_cancel, or a rejected server_stop, never frees the
// slot as if the request or the process had ended.
import { describe, expect, it } from 'vitest';
import { LINK_LIMITS, ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import { mutations } from '../../../src/mutations.ts';
import { fakeNet, fakeProcess, initResult, json, listResult, realClock, textResult } from '../wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };
const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('cleanup the exe refused', () => {
  it('a rejected net_cancel keeps its request counted: no next exchange is admitted', async () => {
    let refuse = false;
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return json(initResult(b.id));
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') return json(listResult(b.id, ['look']));
      return json(textResult(b.id, 'ok'));
    });
    const cancel = net.port.cancel.bind(net.port);
    net.port.cancel = async (id) => {
      if (refuse) throw Object.assign(new Error('nope'), { kind: 'failed' });
      return cancel(id);
    };
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    await link.start(remote, 'L');
    refuse = true;
    expect((await link.handoff('look', '{}', new AbortController().signal, 5000))?.kind).toBe('result');
    await sleep(20);
    expect(link.busy).toBe(true);
    expect(link.handoff('look', '{}', new AbortController().signal, 5000)).toBeUndefined();
  });

  for (const mutation of [undefined, 'cancel-throw-escapes'] as const)
  it(`a net_cancel that throws synchronously is a refused one: tried again, and the start answered (r35b #6)${mutation ? ` (control: ${mutation} leaves the start hanging)` : ''}`, async () => {
    mutations.set(mutation ? [mutation] : []);
    try {
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return json(initResult(b.id));
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') return json(listResult(b.id, ['look']));
      return json(textResult(b.id, 'ok'));
    });
    const cancel = net.port.cancel.bind(net.port);
    let tries = 0;
    net.port.cancel = ((id: string) => {
      if (++tries === 1) throw Object.assign(new Error('nope'), { kind: 'failed' });
      return cancel(id);
    }) as typeof net.port.cancel;
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    const r = await Promise.race([link.start(remote, 'L').catch(() => ({ ok: 'threw' })), sleep(mutation ? 1500 : 4000).then(() => ({ ok: 'hung' }))]);
    if (mutation) {
      expect(r).not.toMatchObject({ ok: true });
      return;
    }
    expect(r).toMatchObject({ ok: true });
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(link.busy).toBe(false);
    } finally {
      mutations.clear();
    }
  });

  it("the test-only list() settles when cancellation is refused for good: no wait is left registered (r35b #16)", async () => {
    let refuse = false;
    let listed = 0;
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return json(initResult(b.id));
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') return json(listResult(b.id, [`look${++listed}`]));
      return json(textResult(b.id, 'ok'));
    });
    const cancel = net.port.cancel.bind(net.port);
    net.port.cancel = async (id) => {
      if (refuse) throw Object.assign(new Error('nope'), { kind: 'failed' });
      return cancel(id);
    };
    // Retries come at once, so cancellation is refused for good within the test.
    const quick = { now: () => Date.now(), setTimer: (cb: () => void) => { const t = setTimeout(cb, 0); return () => clearTimeout(t); } };
    const link = new ServerLink('s', { net: net.port }, quick, { ended: () => {} });
    await link.start(remote, 'L');
    refuse = true;
    const r = await Promise.race([link.list(), sleep(3000).then(() => 'hung' as const)]);
    expect(r).not.toBe('hung');
    const l = link as unknown as { idle: unknown[]; watchers: Set<unknown> };
    expect(l.idle.length).toBe(0);
    expect(l.watchers.size).toBe(0);
  });

  it("the test-only list() settles when a two-page refresh is held before it publishes (r36 #7)", async () => {
    let refuse = false;
    let lists = 0;
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return json(initResult(b.id));
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') {
        // The start's list is one page; the refresh's first page points to a second it never reaches.
        if (++lists === 1) return json(listResult(b.id, ['look']));
        return json({ jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'look', description: 'look', inputSchema: { type: 'object', properties: {} } }], nextCursor: 'c2' } });
      }
      return json(textResult(b.id, 'ok'));
    });
    const cancel = net.port.cancel.bind(net.port);
    net.port.cancel = async (id) => {
      if (refuse) throw Object.assign(new Error('nope'), { kind: 'failed' });
      return cancel(id);
    };
    // Only the cancel's retries (1, 2, 4 s) come at once; no deadline ever fires, so nothing else drains.
    const quick = { now: () => Date.now(), setTimer: (cb: () => void, ms: number) => { if (ms > 4000) return () => {}; const t = setTimeout(cb, 0); return () => clearTimeout(t); } };
    const link = new ServerLink('s', { net: net.port }, quick, { ended: () => {} });
    await link.start(remote, 'L');
    refuse = true;
    const r = await Promise.race([link.list(), sleep(3000).then(() => 'hung' as const)]);
    expect(r).not.toBe('hung');
    const l = link as unknown as { idle: unknown[]; watchers: Set<unknown> };
    expect(l.idle.length).toBe(0);
    expect(l.watchers.size).toBe(0);
  });

  it('a rejected server_stop keeps the run\'s writes open until an exit is seen', async () => {
    const proc = fakeProcess((m) => (m.method === 'tools/call' ? 'hold' : m.method === 'initialize' ? [JSON.stringify(initResult(m.id))] : m.method === 'tools/list' ? [JSON.stringify(listResult(m.id, ['look']))] : []));
    let stopsTried = 0;
    proc.port.stop = async () => {
      stopsTried++;
      throw Object.assign(new Error('nope'), { kind: 'failed' });
    };
    // The write bound ends the run and asks the exe to stop the process, which it refuses.
    const link = new ServerLink('s', { processes: proc.port }, realClock, { ended: () => {} }, { ...LINK_LIMITS, writeMs: 50 });
    await link.start(local, 'L');
    void link.handoff('look', '{}', new AbortController().signal, 60_000);
    await sleep(150);
    // The stop was asked, and refused, before any exit: and the slot is still held.
    expect(stopsTried).toBeGreaterThan(0);
    expect(link.busy).toBe(true);
    proc.exit(0);
    await sleep(10);
    expect(link.busy).toBe(false);
  });
});
