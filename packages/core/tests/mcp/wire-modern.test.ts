// The modern (2026-07-28) era (docs/mcp-design.md 3.3, 3.5, 3.6, 3.8b, 3.9, 3.10) and a step's deadline
// against a server that won't let the slot go. The refusals replayed here are the ones B2 recorded.

import { describe, expect, it } from 'vitest';
import { encodeValue, HEADER_WORDS, paramHeaders, scanDeclarations, wellFormed } from '../../src/mcp/wire/headers.ts';
import { ServerLink, type Target } from '../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../src/mcp/process.ts';
import { fakeNet, initResult, json, realClock, sse, textResult } from './wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };
const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quiet = { ended: () => {} };
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

const refusal = (id: number, supported: unknown = ['2026-07-28']) => ({ jsonrpc: '2.0', id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported, requested: '2025-11-25' } } });
const modernList = (id: number, tools: unknown[]) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools } });
const tool = (name: string, properties: Record<string, unknown> = {}) => ({ name, inputSchema: { type: 'object', properties } });

/* ---------- 3.5 and 3.6: the scan and the codec ---------- */

describe('3.5: the x-mcp-header scan', () => {
  it('takes declarations reached through properties, of string, integer or boolean type', () => {
    const r = scanDeclarations({ type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, opts: { type: 'object', properties: { n: { type: 'integer', 'x-mcp-header': 'N' }, b: { type: 'boolean', 'x-mcp-header': 'Flag' } } } } });
    expect(r).toEqual({ ok: true, declarations: [{ path: ['region'], name: 'Region', type: 'string' }, { path: ['opts', 'n'], name: 'N', type: 'integer' }, { path: ['opts', 'b'], name: 'Flag', type: 'boolean' }] });
  });

  it('makes the tool invalid for a declaration anywhere else, a number, a bad or duplicate name', () => {
    const bad: unknown[] = [
      { type: 'object', 'x-mcp-header': 'Root', properties: {} },
      { type: 'object', properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } },
      { type: 'object', properties: { x: { oneOf: [{ type: 'string', 'x-mcp-header': 'X' }] } } },
      { type: 'object', $defs: { d: { type: 'string', 'x-mcp-header': 'D' } }, properties: {} },
      { type: 'object', additionalProperties: { type: 'string', 'x-mcp-header': 'A' } },
      { type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } },
      { type: 'object', properties: { n: { 'x-mcp-header': 'N' } } },
      { type: 'object', properties: { n: { type: 'string', 'x-mcp-header': 'has space' } } },
      { type: 'object', properties: { n: { type: 'string', 'x-mcp-header': '' } } },
      { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Same' }, b: { type: 'string', 'x-mcp-header': 'same' } } }
    ];
    for (const s of bad) expect(scanDeclarations(s).ok, JSON.stringify(s)).toBe(false);
    expect(scanDeclarations({ type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } })).toMatchObject({ ok: false, reason: expect.stringMatching(/string, integer or boolean property, not number/) });
  });
});

describe('3.6: the header codec', () => {
  it('writes plain visible ASCII as it is, and everything else as the base64 sentinel over its UTF-8', () => {
    expect(encodeValue('eu-west 1')).toBe('eu-west 1');
    expect(encodeValue('a\tb')).toBe('a\tb');
    for (const v of ['', ' lead', 'trail ', '\tx', 'café', '=?base64?eA==?=', 'line\nbreak']) expect(encodeValue(v)).toBe(`=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`);
  });

  it('converts by type and refuses before the handoff what it can\'t send faithfully', () => {
    const d = [{ path: ['s'], name: 'S', type: 'string' as const }, { path: ['n'], name: 'N', type: 'integer' as const }, { path: ['b'], name: 'B', type: 'boolean' as const }];
    expect(paramHeaders(d, { s: 'x', n: 42, b: false }, 4)).toEqual({ ok: true, headers: [['Mcp-Param-S', 'x'], ['Mcp-Param-N', '42'], ['Mcp-Param-B', 'false']] });
    expect(paramHeaders(d, { s: null }, 4)).toEqual({ ok: true, headers: [] });
    for (const args of [{ s: 1 }, { n: 1.5 }, { n: 2 ** 60 }, { b: 'true' }, { s: 'lone \ud800' }, { s: 'x'.repeat(9000) }]) expect(paramHeaders(d, args, 4).ok, JSON.stringify(args).slice(0, 40)).toBe(false);
    expect(paramHeaders(d, { s: 'x', n: 1 }, 63).ok).toBe(false);
    expect(wellFormed('😀')).toBe(true);
    expect(wellFormed('\udc00')).toBe(false);
  });
});

/* ---------- the opening, remote ---------- */

function modernServer(extra: (body: any, headers: Record<string, string>) => any = () => undefined, opening: (body: any) => any = (b) => ({ ...json(refusal(b.id)), status: 400 })) {
  return fakeNet((body, headers) => {
    const x = extra(body, headers);
    if (x) return x;
    if (body.method === 'initialize') return opening(body);
    if (body.method === 'tools/list') return json(modernList(body.id, [tool('look', { region: { type: 'string', 'x-mcp-header': 'Region' } }), tool('bad', { n: { type: 'number', 'x-mcp-header': 'N' } })]));
    if (body.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', content: [{ type: 'text', text: `ran ${body.params.name}` }] } });
    return { status: 405, chunks: [] };
  });
}

describe('3.3 and 3.8b: a modern-only server over HTTP', () => {
  it("TS's refusal (400, JSON): modern from the same exchange, no initialized, no session id; the list and call carry the envelope and headers", async () => {
    const net = modernServer();
    const link = new ServerLink('m', { net: net.port }, realClock, quiet);
    const r = await link.start(remote, 'L');
    expect(r).toMatchObject({ ok: true, tools: [{ name: 'look' }] });
    expect(link.current).toMatchObject({ era: 'modern', notOffered: [{ name: 'bad', reason: expect.stringMatching(/number/) }] });
    expect(net.log.map((x) => x.body.method)).toEqual(['initialize', 'tools/list']);
    const list = net.log[1]!;
    expect(list.body.params._meta).toMatchObject(META);
    expect(list.headers).toMatchObject({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' });
    expect(list.headers['mcp-session-id']).toBeUndefined();
    await link.drained();
    expect(await link.handoff('look', '{"region":"café"}', new AbortController().signal, 5000)).toEqual({ kind: 'result', text: 'ran look', isError: false });
    const call = net.log.at(-1)!;
    expect(call.headers).toMatchObject({ 'mcp-method': 'tools/call', 'mcp-name': 'look', 'mcp-param-region': `=?base64?${Buffer.from('café').toString('base64')}?=` });
    expect(call.body.params).toMatchObject({ name: 'look', arguments: { region: 'café' }, _meta: META });
    expect(net.log.some((x) => x.body.method === 'notifications/initialized' || x.body.method === 'server/discover')).toBe(false);
  });

  it("rmcp's refusal (200, an event stream with a priming event and a dead session id): modern, and the session id is never adopted", async () => {
    const net = modernServer(undefined, (b) => ({ ...sse('data: \nid: 0\nretry: 3000\n\n', refusal(b.id)), headers: [['content-type', 'text/event-stream'], ['mcp-session-id', 'dead-1']] }));
    const link = new ServerLink('m', { net: net.port }, realClock, quiet);
    expect(await link.start(remote, 'L')).toMatchObject({ ok: true });
    expect(link.current?.era).toBe('modern');
    expect(net.log.slice(1).every((x) => x.headers['mcp-session-id'] === undefined)).toBe(true);
  });

  it('a server that speaks both eras stays legacy; other refusals fail the start with the server\'s versions in words', async () => {
    const both = modernServer(undefined, (b) => json(initResult(b.id)));
    const legacyLink = new ServerLink('m', { net: both.port }, realClock, quiet);
    await legacyLink.start(remote, 'L').catch(() => undefined);
    expect(legacyLink.current?.era ?? 'legacy').toBe('legacy');
    for (const [supported, words] of [[['2030-01-01'], /speaks MCP 2030-01-01 only/], [['2026-07-28', '2025-06-18'], /speaks MCP 2026-07-28, 2025-06-18 only/], ['nope', /refused the handshake/]] as const) {
      const net = modernServer(undefined, (b) => json(refusal(b.id, supported)));
      const r = await new ServerLink('m', { net: net.port }, realClock, quiet).start(remote, 'L');
      expect(r).toMatchObject({ ok: false, failure: { words: expect.stringMatching(words) } });
    }
  });

  it('modern results: input_required and an unknown resultType are tool errors, a missing one a protocol error, -32020 a tool error; nothing is retried', async () => {
    const answers: Record<string, unknown> = {
      ask: { resultType: 'input_required', inputRequests: {} },
      odd: { resultType: 'later', content: [] },
      none: { content: [{ type: 'text', text: 'x' }] }
    };
    const net = modernServer((body) => {
      if (body.method !== 'tools/call') return undefined;
      const name = body.params.name;
      if (name === 'mismatch') return { status: 400, headers: [['content-type', 'application/json']], chunks: [JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'header mismatch' } })] };
      return json({ jsonrpc: '2.0', id: body.id, result: answers[name] });
    });
    const link = new ServerLink('m', { net: net.port }, realClock, quiet);
    await link.start(remote, 'L');
    const call = async (name: string) => {
      await link.drained();
      return link.handoff(name, '{}', new AbortController().signal, 5000);
    };
    expect(await call('ask')).toEqual({ kind: 'result', text: "The server asked for input Familiar can't give.", isError: true });
    expect(await call('odd')).toMatchObject({ kind: 'result', isError: true });
    expect(await call('none')).toMatchObject({ kind: 'error', reason: 'protocol' });
    expect(await call('mismatch')).toMatchObject({ kind: 'result', isError: true, text: expect.stringMatching(/headers didn't match/) });
    expect(net.log.filter((x) => x.body.method === 'tools/call')).toHaveLength(4);
  });

  it("a call whose mirrored value can't be sent is refused before anything goes out", async () => {
    const net = modernServer();
    const link = new ServerLink('m', { net: net.port }, realClock, quiet);
    await link.start(remote, 'L');
    await link.drained();
    const before = net.log.length;
    expect(await link.handoff('look', JSON.stringify({ region: 'lone \ud800' }), new AbortController().signal, 5000)).toEqual({ kind: 'error', reason: 'protocol', words: HEADER_WORDS });
    expect(net.log.length).toBe(before);
    expect(link.busy).toBe(false);
  });

  it('a stray ping or server request on a modern stream gets nothing; a later -32022 ends the run with its versions', async () => {
    const ends: string[] = [];
    let n = 0;
    const net = modernServer((body) => {
      if (body.method !== 'tools/call') return undefined;
      n++;
      if (n === 1) return sse({ jsonrpc: '2.0', id: 'p1', method: 'ping' }, { jsonrpc: '2.0', id: 'r1', method: 'sampling/createMessage', params: {} }, { jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', content: [] } });
      return json(refusal(body.id, ['2031-01-01']));
    });
    const link = new ServerLink('m', { net: net.port }, realClock, { ended: (_r, f) => ends.push(f.words) });
    await link.start(remote, 'L');
    await link.drained();
    expect(await link.handoff('look', '{}', new AbortController().signal, 5000)).toMatchObject({ kind: 'result' });
    await link.drained();
    expect(net.log.some((x) => !x.body.method)).toBe(false);
    await link.handoff('look', '{}', new AbortController().signal, 5000);
    expect(ends).toEqual([expect.stringMatching(/speaks MCP 2031-01-01 only/)]);
  });
});

/* ---------- 3.9: a modern-only stdio server, both paths ---------- */

/** A process port whose every start is a fresh process, scripted by `answer`. */
function processes(answer: (msg: any, start: number) => (string | 'exit')[]) {
  let starts = 0;
  const writes: any[][] = [];
  const port: ProcessPort = {
    async start(_s, onEvent: (e: ProcessEvent) => void) {
      const me = ++starts;
      const mine: any[] = [];
      writes.push(mine);
      let exited = false;
      (port as any)[`emit${me}`] = onEvent;
      (port as any)[`write${me}`] = (msg: any) => {
        mine.push(msg);
        for (const out of answer(msg, me)) {
          if (out === 'exit') {
            if (!exited) {
              exited = true;
              queueMicrotask(() => onEvent({ t: 'exit', code: 1 }));
            }
          } else queueMicrotask(() => onEvent({ t: 'out', line: out }));
        }
      };
      (port as any)[`exited${me}`] = () => exited;
      return { run: `p${me}` };
    },
    async write(run, bytes) {
      const me = Number(run.slice(1));
      if ((port as any)[`exited${me}`]()) throw Object.assign(new Error('gone'), { kind: 'not-running' });
      (port as any)[`write${me}`](JSON.parse(new TextDecoder().decode(bytes)));
    },
    async stop(run) {
      const me = Number(run.slice(1));
      queueMicrotask(() => (port as any)[`emit${me}`]({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
  return { port, writes, starts: () => starts };
}

describe('3.9: a modern-only stdio server', () => {
  it('that keeps its pipe after refusing (TS): the modern list goes on the same pipe, with the envelope', async () => {
    const p = processes((msg) => (msg.method === 'initialize' ? [JSON.stringify(refusal(msg.id))] : msg.method === 'tools/list' ? [JSON.stringify(modernList(msg.id, [tool('look')]))] : []));
    const link = new ServerLink('m', { processes: p.port }, realClock, quiet);
    expect(await link.start(local, 'L')).toMatchObject({ ok: true });
    expect(p.starts()).toBe(1);
    expect(p.writes[0]!.map((m) => m.method)).toEqual(['initialize', 'tools/list']);
    expect(p.writes[0]![1].params._meta).toMatchObject(META);
  });

  it('that ends its process after refusing (rmcp): the start asks for one relaunch with the era fixed, which skips the opening', async () => {
    const p = processes((msg, start) => {
      if (msg.method === 'initialize') return [JSON.stringify(refusal(msg.id)), 'exit'];
      if (msg.method === 'tools/list' && start === 2) return [JSON.stringify(modernList(msg.id, [tool('look')]))];
      return [];
    });
    const link = new ServerLink('m', { processes: p.port }, realClock, quiet);
    const first = await link.start(local, 'L');
    expect(first).toMatchObject({ ok: false, relaunch: 'modern' });
    await link.drained();
    expect(await link.start(local, 'L', { era: 'modern' })).toMatchObject({ ok: true, tools: [{ name: 'look' }] });
    expect(p.writes[1]!.map((m) => m.method)).toEqual(['tools/list']);
  });
});

/* ---------- a step's deadline against a server that won't let the slot go ---------- */

describe("66d803a's wait: idle pings without pause never hold a step past its deadline", () => {
  /** A local server that answers the handshake, then pings without pause, and whose pongs never finish writing. */
  function pinging(options: { listAnswers: boolean; floodAtInitialized?: boolean }) {
    let emit!: (e: ProcessEvent) => void;
    let timer: ReturnType<typeof setInterval> | undefined;
    const held: (() => void)[] = [];
    let pings = 0;
    const port: ProcessPort = {
      async start(_s, onEvent) {
        emit = onEvent;
        return { run: 'p1' };
      },
      async write(_run, bytes) {
        const msg = JSON.parse(new TextDecoder().decode(bytes));
        if (msg.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(initResult(msg.id)) }));
        if (msg.method === 'tools/list' && (options.listAnswers || !timer)) queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [tool('look')] } }) }));
        // The initialized write takes a while, and pings start meanwhile.
        if (msg.method === 'notifications/initialized' && options.floodAtInitialized) {
          // One ping lands on the live initialized exchange; its pong never finishes writing, so the
          // exchange drains forever. The rest of the flood lands on that drain.
          emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: `idle-${++pings}`, method: 'ping' }) });
          await sleep(5);
          flood();
        }
        // A pong never finishes writing: the server stopped reading.
        if ('result' in msg) await new Promise<void>((r) => held.push(r));
      },
      async stop() {
        if (timer) clearInterval(timer);
        held.splice(0).forEach((r) => r());
        queueMicrotask(() => emit({ t: 'exit', code: 0 }));
      },
      async forget() {}
    };
    const flood = () => {
      timer ??= setInterval(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: `idle-${++pings}`, method: 'ping' }) }), 1);
    };
    return {
      port,
      flood,
      stop: () => timer && clearInterval(timer),
      pings: () => pings
    };
  }

  it("a start whose walk finds the slot held by a ping flood waits only until the start's deadline: the run fails, with the reason", async () => {
    // The pings start while the opening's initialized is being written: their pongs never finish, so the
    // slot stays held and the walk's first page waits on it.
    const s = pinging({ listAnswers: true, floodAtInitialized: true });
    let stopped = 0;
    const port: ProcessPort = { ...s.port, stop: async (run) => { stopped++; return s.port.stop(run); } };
    const link = new ServerLink('m', { processes: port }, realClock, quiet, { startMs: 150, listMs: 5000, pongMs: 5000, headersMs: 5000, idleMs: 5000 });
    const t0 = Date.now();
    const r = await link.start(local, 'L');
    const ms = Date.now() - t0;
    s.stop();
    expect(s.pings()).toBeGreaterThan(0);
    expect(r).toMatchObject({ ok: false, failure: { kind: 'timed-out', words: "The server didn't finish starting in time." } });
    expect(ms).toBeLessThan(1000);
    expect(stopped).toBe(1);
    expect(link.current).toBeUndefined();
  });

  it('a list walk is admitted only from Idle: under a flood that holds the slot, Test or a refresh is refused busy at once, and the run stays', async () => {
    const s = pinging({ listAnswers: true });
    const link = new ServerLink('m', { processes: s.port }, realClock, quiet, { startMs: 5000, listMs: 150, pongMs: 5000, headersMs: 5000, idleMs: 5000 });
    expect(await link.start(local, 'L')).toMatchObject({ ok: true });
    s.flood();
    await sleep(10);
    expect(await link.list()).toMatchObject({ kind: 'busy' });
    s.stop();
    expect(link.current?.ready).toBe(true);
  });
});
