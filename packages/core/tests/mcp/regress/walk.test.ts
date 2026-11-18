// The tool list's walk (3.5): a catalog known to be stale is never published, a burst of list_changed is
// one more walk, and an oversized list fails the start instead of throwing out of it.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import { toolFingerprint } from '../../../src/mcp/catalog.ts';
import { mutations } from '../../../src/mutations.ts';
import { fakeNet, fakeProcess, initResult, json, listResult, realClock, sse } from '../wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };
const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const changed = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };

function server(onList: (n: number, id: number, cursor?: string) => ReturnType<typeof json>, onCall?: (id: number) => ReturnType<typeof json>) {
  let lists = 0;
  const net = fakeNet((b) => {
    if (b.method === 'initialize') return json(initResult(b.id));
    if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
    if (b.method === 'tools/list') return onList(++lists, b.id, b.params?.cursor);
    if (b.method === 'tools/call') return onCall ? onCall(b.id) : json({ jsonrpc: '2.0', id: b.id, result: { content: [] } });
    return json({});
  });
  return { net, lists: () => lists };
}

describe('list_changed during a walk', () => {
  it('on the initial walk\'s only page: walks again before Ready', async () => {
    const s = server((n, id) => (n === 1 ? sse(changed, listResult(id, ['old'])) : json(listResult(id, ['new']))));
    const link = new ServerLink('s', { net: s.net.port }, realClock, { ended: () => {} });
    const r = await link.start(remote, 'L');
    expect(r.ok).toBe(true);
    expect(s.lists()).toBe(2);
    expect(link.current?.tools.map((t) => t.name)).toEqual(['new']);
    expect(link.current?.stale).toBe(false);
  });

  it('between pages: walks again from the first page', async () => {
    const s = server((n, id, cursor) => (n === 1 ? json(listResult(id, ['a'], 'c2')) : n === 2 ? sse(changed, listResult(id, ['b'])) : cursor ? json(listResult(id, ['b2'])) : json(listResult(id, ['a2'], 'c2'))));
    const link = new ServerLink('s', { net: s.net.port }, realClock, { ended: () => {} });
    expect((await link.start(remote, 'L')).ok).toBe(true);
    expect(s.lists()).toBe(4);
    expect(link.current?.tools.map((t) => t.name)).toEqual(['a2', 'b2']);
  });

  it('during a Ready refresh: the refresh walks again, and no call meets the old catalog', async () => {
    const s = server((n, id) => (n === 2 ? sse(changed, listResult(id, ['old'])) : json(listResult(id, [n >= 3 ? 'new' : 'look']))));
    const link = new ServerLink('s', { net: s.net.port }, realClock, { ended: () => {} });
    await link.start(remote, 'L');
    const r = await link.list();
    expect(Array.isArray(r) && r.map((t) => t.name)).toEqual(['new']);
    expect(link.current?.stale).toBe(false);
  });

  it('a burst of three on one call is one more walk', async () => {
    const s = server((_n, id) => json(listResult(id, ['look'])), (id) => sse(changed, changed, changed, { jsonrpc: '2.0', id, result: { content: [] } }));
    const link = new ServerLink('s', { net: s.net.port }, realClock, { ended: () => {} });
    await link.start(remote, 'L');
    await link.handoff('look', '{}', new AbortController().signal, 5000);
    await sleep(100);
    expect(s.lists()).toBe(2);
  });
});

describe('an oversized tool list', () => {
  it('fails the start in words, stops the local process, and throws nothing', async () => {
    let stopped = 0;
    const proc = fakeProcess((m) => {
      if (m.method === 'initialize') return [JSON.stringify(initResult(m.id))];
      if (m.method === 'notifications/initialized') return [];
      if (m.method === 'tools/list') return [JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: Array.from({ length: 200_000 }, () => ({})) } })];
      return [];
    });
    const stop = proc.port.stop.bind(proc.port);
    proc.port.stop = async (run) => {
      stopped++;
      return stop(run);
    };
    const link = new ServerLink('s', { processes: proc.port }, realClock, { ended: () => {} });
    const r = await link.start(local, 'L');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.failure.words).toMatch(/tools/i);
    expect(stopped).toBe(1);
    expect(link.busy).toBe(false);
  });

  it('across pages: the running total is bounded too', async () => {
    const page = (id: number, n: number, next?: string) => json({ jsonrpc: '2.0', id, result: { tools: Array.from({ length: 100 }, (_, i) => ({ name: `t${n}-${i}`, inputSchema: { type: 'object', properties: {} } })), ...(next ? { nextCursor: next } : {}) } });
    const s = server((n, id) => page(id, n, n < 3 ? `c${n}` : undefined));
    const link = new ServerLink('s', { net: s.net.port }, realClock, { ended: () => {} });
    const r = await link.start(remote, 'L');
    expect(r.ok).toBe(false);
    // Bounded before anything more is asked: the second page's 200 tools already pass 128, so no third.
    expect(s.lists()).toBe(2);
  });
});

describe("a modern remote run's fingerprints", () => {
  it('cover the era and the header declarations: the same tool listed legacy has another fingerprint', async () => {
    const schema = { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } };
    const listed = (modern: boolean) =>
      fakeNet((b) => {
        if (b.method === 'initialize') return modern ? { ...json({ jsonrpc: '2.0', id: b.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }), status: 400 } : json(initResult(b.id));
        if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
        return json({ jsonrpc: '2.0', id: b.id, result: { ...(modern ? { resultType: 'complete' } : {}), tools: [{ name: 'look', inputSchema: schema }] } });
      });
    const prints: string[] = [];
    for (const modern of [false, true]) {
      const link = new ServerLink('s', { net: listed(modern).port }, realClock, { ended: () => {} });
      await link.start(remote, 'L');
      prints.push(link.current!.tools[0]!.fingerprint);
    }
    expect(prints[0]).not.toBe(prints[1]);
  });
});

/** A modern remote server that lists the given tools on one page. */
function modernListing(tools: unknown[]) {
  return fakeNet((b) => {
    if (b.method === 'initialize') return { ...json({ jsonrpc: '2.0', id: b.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }), status: 400 };
    return json({ jsonrpc: '2.0', id: b.id, result: { resultType: 'complete', tools } });
  });
}

describe('every listed tool is bounded before any is scanned', () => {
  const big = () => modernListing([{ name: 'big', description: 'd'.repeat(70 * 1024), inputSchema: { type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } } }, { name: 'fine', inputSchema: { type: 'object' } }]);
  it('a tool whose declaration is faulty still counts against the bounds: past 64 KiB, the start fails', async () => {
    const link = new ServerLink('s', { net: big().port }, realClock, { ended: () => {} });
    const r = await link.start(remote, 'L');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.words).toMatch(/at most 65536 for one tool/);
  });

  it('the control: bounding only the offered tools (the named mutation) lets it reach Ready', async () => {
    mutations.set(['bound-offered-only']);
    try {
      const link = new ServerLink('s', { net: big().port }, realClock, { ended: () => {} });
      expect((await link.start(remote, 'L')).ok).toBe(true);
      expect(mutations.hits('bound-offered-only')).toBeGreaterThan(0);
    } finally {
      mutations.clear();
    }
  });

  it("a tool that isn't offered has its reason cut, never the server's whole text", async () => {
    const net = modernListing([{ name: 'odd', inputSchema: { type: 'object', properties: { ['p'.repeat(3000)]: { type: 'number', 'x-mcp-header': 'N' } } } }, { name: 'fine', inputSchema: { type: 'object' } }]);
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    expect((await link.start(remote, 'L')).ok).toBe(true);
    const reason = link.current!.notOffered[0]!.reason;
    expect([...reason].length).toBeLessThanOrEqual(200);
  });

  it('a list built to make the declaration scan quadratic fails at the bounds, at once', async () => {
    // One tool: 30,000 declarations and 30,000 refs, under the response's own size bound.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 30_000; i++) properties[`p${i}`] = { type: 'string', 'x-mcp-header': `H${i}` };
    const refs = Array.from({ length: 30_000 }, (_, i) => ({ $ref: `#/$defs/d${i}` }));
    const net = modernListing([{ name: 'slow', inputSchema: { type: 'object', properties: { ...properties, r: { anyOf: refs } }, $defs: {} } }]);
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    const t0 = performance.now();
    const r = await link.start(remote, 'L');
    expect(r.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(3000);
  }, 20_000);
});

describe('a fingerprint and the order of a schema', () => {
  const declared = (order: 'ab' | 'ba') => {
    const a = { type: 'string', 'x-mcp-header': 'A' };
    const b = { type: 'string', 'x-mcp-header': 'B' };
    const properties = order === 'ab' ? { a, b } : { b, a };
    const declarations = Object.keys(properties).map((k) => ({ path: [k], name: k.toUpperCase(), type: 'string' as const }));
    return toolFingerprint({ name: 'look', inputSchema: { type: 'object', properties } }, declarations);
  };
  it('the same tool with its properties in another order has one fingerprint', () => {
    expect(declared('ab')).toBe(declared('ba'));
  });
  it('the control: declarations hashed in the order found (the named mutation) differ', () => {
    mutations.set(['declarations-in-order']);
    try {
      expect(declared('ab')).not.toBe(declared('ba'));
    } finally {
      mutations.clear();
    }
  });
});
