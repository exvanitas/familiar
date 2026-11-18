// A legacy remote session dropped with a 404 (3.8): one re-handshake per drop, never a change of era, a
// refresh page's 404 recovered like any other, and the bound rearmed only by an exchange after recovery.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import { fakeNet, initResult, json, listResult, realClock, textResult } from '../wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withSession = (r: ReturnType<typeof json>, id: string) => ({ ...r, headers: [['content-type', 'application/json'], ['mcp-session-id', id]] as [string, string][] });

describe('the re-handshake after a 404', () => {
  it('never turns an established run modern: a modern refusal there ends the run', async () => {
    let inits = 0;
    const net = fakeNet((b, h) => {
      if (b.method === 'initialize') {
        inits++;
        if (inits === 1) return withSession(json(initResult(b.id)), 'S1');
        return { ...json({ jsonrpc: '2.0', id: b.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }), status: 400 };
      }
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') return json(listResult(b.id, ['look']));
      if (b.method === 'tools/call') return h['mcp-session-id'] === 'S1' ? { status: 404, chunks: [] } : json(textResult(b.id, 'ok'));
      return json({});
    });
    const ended: string[] = [];
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: (_r, f) => ended.push(f.words) });
    await link.start(remote, 'L');
    await link.handoff('look', '{}', new AbortController().signal, 5000);
    await sleep(50);
    expect(link.current).toBeUndefined();
    expect(ended.length).toBe(1);
    expect(net.log.some((x) => x.body?.params?._meta)).toBe(false);
  });

  it("a refresh page's first 404 is recovered: one fresh initialize, and the run kept", async () => {
    let lists = 0;
    let inits = 0;
    const net = fakeNet((b) => {
      if (b.method === 'initialize') {
        inits++;
        return withSession(json(initResult(b.id)), `S${inits}`);
      }
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') {
        lists++;
        if (lists === 2) return { status: 404, chunks: [] };
        return json(listResult(b.id, ['look']));
      }
      return json({});
    });
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    await link.start(remote, 'L');
    const run = link.current!.run;
    await link.list();
    await sleep(50);
    expect(inits).toBe(2);
    expect(link.current?.run).toBe(run);
    expect(link.current?.ready).toBe(true);
  });

  it("the bound isn't rearmed by the re-handshake's own walk: a second call's 404 ends the run", async () => {
    let inits = 0;
    const net = fakeNet((b) => {
      if (b.method === 'initialize') {
        inits++;
        return withSession(json(initResult(b.id)), `S${inits}`);
      }
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') return json(listResult(b.id, ['look']));
      if (b.method === 'tools/call') return { status: 404, chunks: [] };
      return json({});
    });
    const ended: string[] = [];
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: (_r, f) => ended.push(f.words) });
    await link.start(remote, 'L');
    await link.handoff('look', '{}', new AbortController().signal, 5000);
    await sleep(50);
    expect(link.current?.ready).toBe(true);
    await link.handoff('look', '{}', new AbortController().signal, 5000);
    await sleep(50);
    expect(link.current).toBeUndefined();
    expect(inits).toBe(2);
  });
});
