// Familiar's own MCP client, legacy era (docs/mcp-design.md 3.2 to 3.11): framing, the parser, the
// exchange machine and its barrier, and the link over a scripted remote and a scripted local server.

import { describe, expect, it } from 'vitest';
import { busy, emptySlot, step, type Input, type Slot } from '../../src/mcp/wire/exchange.ts';
import { allowed, frame, frameCall, FramingRefused } from '../../src/mcp/wire/framing.ts';
import { ServerLink, type Target } from '../../src/mcp/wire/link.ts';
import { callResult, EventStream, initializeResult, Invalid, listResult as checkList, parseMessage } from '../../src/mcp/wire/parse.ts';
import { fakeNet, fakeProcess, initResult, json, listResult, realClock, sse, textResult } from './wire-fakes.ts';

const enc = new TextEncoder();
const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [['X-Team', 'blue'], ['Mcp-Session-Id', 'forged']] };
const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ended = { ended: () => {} };

/* ---------- 3.2: framing ---------- */

describe('3.2: framing', () => {
  it('builds the five administrative kinds; a modern run builds only list (and call, and the local cancel)', () => {
    expect(JSON.parse(frame({ kind: 'initialize', id: 1 }, 'legacy', 'remote'))).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'familiar', version: '0.1.0' } } });
    expect(JSON.parse(frame({ kind: 'initialized' }, 'legacy', 'local'))).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(JSON.parse(frame({ kind: 'list', id: 2, cursor: 'c' }, 'legacy', 'remote')).params).toEqual({ cursor: 'c' });
    expect(JSON.parse(frame({ kind: 'pong', id: 'p7' }, 'legacy', 'remote'))).toEqual({ jsonrpc: '2.0', id: 'p7', result: {} });
    expect(JSON.parse(frame({ kind: 'cancelled', requestId: 4 }, 'legacy', 'local')).params.requestId).toBe(4);
    expect(() => frame({ kind: 'cancelled', requestId: 4 }, 'legacy', 'remote')).toThrow(FramingRefused);
    for (const kind of ['initialize', 'initialized', 'pong'] as const) expect(allowed(kind, 'modern', 'remote')).toBe(false);
    expect(JSON.parse(frame({ kind: 'list', id: 3 }, 'modern', 'remote')).params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
  });

  it('a call carries the canonical arguments byte for byte', () => {
    const text = frameCall(5, 'look', '{"a":1,"b":[2]}', 'legacy', 'remote');
    expect(text).toBe('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"look","arguments":{"a":1,"b":[2]}}}');
    expect(JSON.parse(frameCall(5, 'look', '{}', 'modern', 'local')).params._meta).toBeDefined();
  });
});

/* ---------- 3.10: parsing ---------- */

describe('3.10: validating untrusted answers', () => {
  it('classifies each message kind and refuses bad shapes', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ t: 'response', id: 1, result: {} });
    expect(parseMessage('{"jsonrpc":"2.0","id":"x","method":"ping"}')).toEqual({ t: 'request', id: 'x', method: 'ping' });
    expect(parseMessage('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}')).toMatchObject({ t: 'notification' });
    const bad = [
      'not json',
      '[]',
      '{"jsonrpc":"1.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":1}',
      '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"x"}}',
      '{"jsonrpc":"2.0","id":1,"error":{"code":1.5,"message":"x"}}',
      '{"jsonrpc":"2.0","id":1.5,"result":{}}',
      '{"jsonrpc":"2.0","id":1,"method":"x","params":[]}',
      `{"jsonrpc":"2.0","method":"${'m'.repeat(129)}"}`,
      `{"jsonrpc":"2.0","id":1,"result":${'['.repeat(70)}${']'.repeat(70)}}`
    ];
    for (const b of bad) expect(() => parseMessage(b), b).toThrow(Invalid);
    expect((parseMessage(`{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"${'x'.repeat(5000)}"}}`) as any).error.message).toHaveLength(1024);
  });

  it('assembles events across reads, joins data lines, and skips comments and empty (priming) events', () => {
    const s = new EventStream();
    const out: string[] = [];
    for (const part of ['data: \nid: 0\nretry: 3000\n\n: a comment\n', 'data: {"a"', ':1}\ndata: {"b":2}\n', '\n', 'data: tail']) out.push(...s.push(enc.encode(part)));
    out.push(...s.end());
    expect(out).toEqual(['{"a":1}\n{"b":2}', 'tail']);
    const big = new EventStream(10, 100);
    expect(() => big.push(enc.encode('data: 0123456789ABC\n'))).toThrow(Invalid);
    const total = new EventStream(1000, 20);
    expect(() => total.push(enc.encode('data: x\n\n'.repeat(5)))).toThrow(Invalid);
  });

  it('checks initialize, list and call results', () => {
    expect(initializeResult({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's' } }).protocolVersion).toBe('2025-06-18');
    expect(() => initializeResult({ protocolVersion: '2026-01-01', capabilities: { tools: {} }, serverInfo: { name: 's' } })).toThrow(/doesn't speak/);
    expect(() => initializeResult({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } })).toThrow(/tools/);
    expect(() => checkList({ tools: [1] })).toThrow(Invalid);
    expect(() => checkList({ tools: [], nextCursor: 'x'.repeat(1025) })).toThrow(Invalid);
    expect(callResult({ content: [{ type: 'text', text: 'a' }, { type: 'mystery' }], isError: true })).toMatchObject({ isError: true, content: [{ type: 'text' }, { type: 'unsupported' }] });
    expect(() => callResult({ content: [{ type: 'image', data: '!!', mimeType: 'image/png' }] })).toThrow(Invalid);
    expect(() => callResult({ content: 'x' })).toThrow(Invalid);
  });
});

/* ---------- 3.4: the exchange machine ---------- */

function run(slot: Slot, ...inputs: Input[]) {
  const effects: any[] = [];
  for (const i of inputs) {
    const s = step(slot, i);
    slot = s.slot;
    effects.push(...s.effects);
  }
  return { slot, effects };
}

describe('3.4: one exchange per server, behind a cleanup barrier', () => {
  const admit = (kind: any, where: any = 'remote', requestId: number | undefined = 1): Input => ({ t: 'admit', kind, where, era: 'legacy', ...(requestId !== undefined ? { requestId } : {}) });

  it('refuses a second admission at once while Live or Draining, and frees only when every native request has ended', () => {
    let r = run(emptySlot, admit('call'));
    expect(r.effects).toEqual([{ t: 'send', handle: '1:req', message: 'request', requestId: 1 }]);
    expect(run(r.slot, admit('list')).effects).toEqual([{ t: 'busy' }]);
    r = run(r.slot, { t: 'ping', n: 1, id: 'p' }, { t: 'completed', n: 1 });
    expect(r.effects.map((e) => e.t)).toEqual(['send', 'cancel', 'ended']);
    expect(busy(r.slot)).toBe(true);
    expect(run(r.slot, admit('list')).effects).toEqual([{ t: 'busy' }]);
    // The request's cancel returns; the pong is still before its head: still draining.
    r = run(r.slot, { t: 'released', handle: '1:req' });
    expect(busy(r.slot)).toBe(true);
    r = run(r.slot, { t: 'pong-head', handle: '1:pong:1' }, { t: 'released', handle: '1:pong:1' });
    expect(r.effects).toEqual([{ t: 'cancel', handle: '1:pong:1' }, { t: 'idle', n: 1 }]);
    expect(busy(r.slot)).toBe(false);
    expect(r.slot.next).toBe(2);
  });

  it('answers each ping id once, ends the exchange at a third concurrent or a 33rd ping (departure 1)', () => {
    let r = run(emptySlot, admit('call'), { t: 'ping', n: 1, id: 'a' }, { t: 'ping', n: 1, id: 'a' }, { t: 'ping', n: 1, id: 'b' });
    expect(r.effects.filter((e) => e.message === 'pong')).toHaveLength(2);
    r = run(r.slot, { t: 'ping', n: 1, id: 'c' });
    expect(r.effects).toContainEqual({ t: 'departure', n: 1, id: 'c', departure: 1 });
    expect(r.effects).toContainEqual({ t: 'ended', n: 1, kind: 'call', end: { t: 'flood' } });
    // Sequential pings: 32 answered, the 33rd floods.
    let s = run(emptySlot, admit('call')).slot;
    let pongs = 0;
    for (let i = 1; i <= 33; i++) {
      const x = run(s, { t: 'ping', n: 1, id: i });
      pongs += x.effects.filter((e) => e.message === 'pong').length;
      s = run(x.slot, { t: 'pong-head', handle: `1:pong:${i}` }, { t: 'released', handle: `1:pong:${i}` }).slot;
      if (i === 33) expect(x.effects).toContainEqual({ t: 'ended', n: 1, kind: 'call', end: { t: 'flood' } });
    }
    expect(pongs).toBe(32);
  });

  it('a local call ended by Stop or its time limit sends its cancel as the last send, then seals', () => {
    for (const end of [{ t: 'stopped' }, { t: 'timeout' }] as const) {
      let r = run(emptySlot, admit('call', 'local', 7), { t: 'released', handle: '1:req' }, { t: 'terminal', n: 1, end });
      expect(r.effects.slice(1)).toEqual([{ t: 'send', handle: '1:cancel', message: 'cancel', requestId: 7 }, { t: 'ended', n: 1, kind: 'call', end }]);
      // Sealed: a ping now gets nothing (departure 2), and the cancel's write is still owned.
      expect(run(r.slot, { t: 'ping', n: 1, id: 'z' }).effects).toEqual([{ t: 'departure', n: 1, id: 'z', departure: 2 }]);
      r = run(r.slot, { t: 'released', handle: '1:cancel' });
      expect(r.effects).toEqual([{ t: 'idle', n: 1 }]);
    }
    // A response ends it with no cancel.
    expect(run(emptySlot, admit('call', 'local', 7), { t: 'completed', n: 1 }).effects.some((e) => e.message === 'cancel')).toBe(false);
  });

  it('a write-only local exchange completes when its write does: a local idle ping never leaves the server busy', () => {
    const r = run(emptySlot, admit('pong', 'local', undefined), { t: 'released', handle: '1:req' });
    expect(r.effects.map((e) => e.t)).toEqual(['send', 'ended', 'idle']);
    expect(busy(r.slot)).toBe(false);
    const n = run(emptySlot, admit('initialized', 'local', undefined), { t: 'released', handle: '1:req' });
    expect(n.effects.at(-1)).toEqual({ t: 'idle', n: 1 });
  });

  it('a modern exchange takes no ping', () => {
    const r = run(emptySlot, { t: 'admit', kind: 'call', where: 'remote', era: 'modern', requestId: 1 }, { t: 'ping', n: 1, id: 'p' });
    expect(r.effects.filter((e) => e.message === 'pong')).toEqual([]);
  });
});

/* ---------- the link: remote ---------- */

function remoteServer(extra: (body: any, headers: Record<string, string>, n: number) => any = () => undefined) {
  return fakeNet((body, headers, n) => {
    const x = extra(body, headers, n);
    if (x) return x;
    if (body.method === 'initialize') return { ...json(initResult(body.id)), headers: [['content-type', 'application/json'], ['mcp-session-id', 'S1']] };
    if (body.method === 'notifications/initialized') return { status: 202, headers: [], chunks: [] };
    if (body.method === 'tools/list') return json(listResult(body.id, ['look']));
    if (body.method === 'tools/call') return json(textResult(body.id, `ran ${body.params.name}`));
    if (!body.method) return { status: 202, headers: [], chunks: [] };
    return { status: 500, chunks: [] };
  });
}

describe('3.3 to 3.8: the link, remote', () => {
  it('a legacy start: initialize, then initialized, then the list; the session id and version go on every later request, never the setup\'s', async () => {
    const net = remoteServer();
    const link = new ServerLink('srv', { net: net.port }, realClock, ended);
    const r = await link.start(remote, 'L1');
    expect(r).toMatchObject({ ok: true, tools: [{ name: 'look' }] });
    expect(net.log.map((x) => x.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(net.log[0]!.headers['mcp-session-id']).toBeUndefined();
    expect(net.log[0]!.headers['x-team']).toBe('blue');
    expect(net.log[1]!.headers).toMatchObject({ 'mcp-session-id': 'S1', 'mcp-protocol-version': '2025-11-25', accept: 'application/json, text/event-stream' });
    expect(net.log.every((x) => x.cancelled)).toBe(true);
    await link.drained();
    const out = await link.handoff('look', '{"q":1}', new AbortController().signal, 5000);
    expect(out).toEqual({ kind: 'result', text: 'ran look', isError: false });
    expect(net.log.at(-1)!.body).toEqual({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'look', arguments: { q: 1 } } });
  });

  it('a ping in the same chunk ahead of the final reply is answered before the exchange ends (S2), and the pong reaches its head', async () => {
    const net = remoteServer((body) => (body.method === 'tools/call' ? { status: 200, headers: [['content-type', 'text/event-stream']], chunks: [`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' })}\n\ndata: ${JSON.stringify(textResult(body.id, 'ok'))}\n\n`] } : undefined));
    const link = new ServerLink('srv', { net: net.port }, realClock, ended);
    await link.start(remote, 'L1');
    await link.drained();
    const out = await link.handoff('look', '{}', new AbortController().signal, 5000);
    expect(out).toMatchObject({ kind: 'result', text: 'ok' });
    await link.drained();
    const pong = net.log.find((x) => x.body.id === 'ping-1' && 'result' in x.body);
    expect(pong?.body).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} });
    expect(net.log.indexOf(pong!)).toBeGreaterThan(net.log.findIndex((x) => x.body.method === 'tools/call'));
  });

  it('a call while another exchange holds the slot is refused at once, with nothing sent', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const net = remoteServer();
    const slow = { ...net.port, read: async (id: string) => { await held; return net.port.read(id); } };
    const link = new ServerLink('srv', { net: net.port }, realClock, ended);
    await link.start(remote, 'L1');
    await link.drained();
    (link as any).ports = { net: slow };
    const first = link.handoff('look', '{}', new AbortController().signal, 5000);
    const sent = net.log.length;
    expect(link.handoff('look', '{}', new AbortController().signal, 5000)).toBeUndefined();
    expect(net.log.length).toBe(sent);
    release();
    await first;
  });

  it('Stop ends the call alone ("stopped"), and the run stays', async () => {
    const net = remoteServer((body) => (body.method === 'tools/call' ? { status: 200, headers: [['content-type', 'text/event-stream']], chunks: [] } : undefined));
    const never = { ...net.port, read: async (id: string) => (net.log.find((x) => x.id === id)?.body.method === 'tools/call' ? new Promise<Uint8Array>(() => {}) : net.port.read(id)) };
    const link = new ServerLink('srv', { net: never }, realClock, ended);
    await link.start(remote, 'L1');
    await link.drained();
    const stop = new AbortController();
    const out = link.handoff('look', '{}', stop.signal, 5000)!;
    await sleep(10);
    stop.abort();
    expect(await out).toEqual({ kind: 'stopped' });
    await link.drained();
    expect(link.current?.ready).toBe(true);
    expect(net.log.at(-1)!.cancelled).toBe(true);
  });

  it('a 404 on a request with the session id: the call fails and is never resent; one re-handshake, with no session id, then the new one (S3)', async () => {
    let session = 'S1';
    let drops = 0;
    const net = fakeNet((body, headers) => {
      if (body.method === 'initialize') return { ...json(initResult(body.id)), headers: [['content-type', 'application/json'], ['mcp-session-id', session]] };
      if (headers['mcp-session-id'] !== session) return { status: 404, headers: [], chunks: [] };
      if (body.method === 'notifications/initialized') return { status: 202, headers: [], chunks: [] };
      if (body.method === 'tools/list') return json(listResult(body.id, ['look']));
      if (body.method === 'tools/call' && drops === 0) {
        drops++;
        session = 'S2';
        return { status: 404, headers: [], chunks: [] };
      }
      return json(textResult(body.id, 'ok'));
    });
    const link = new ServerLink('srv', { net: net.port }, realClock, ended);
    await link.start(remote, 'L1');
    await link.drained();
    const out = await link.handoff('look', '{"x":1}', new AbortController().signal, 5000);
    expect(out).toMatchObject({ kind: 'error', words: expect.stringMatching(/ended its session/) });
    for (let i = 0; i < 100 && !link.current?.ready; i++) await sleep(5);
    const after = net.log.slice(net.log.findIndex((x) => x.body.method === 'tools/call') + 1).map((x) => [x.body.method, x.headers['mcp-session-id'] ?? null]);
    expect(after).toEqual([['initialize', null], ['notifications/initialized', 'S2'], ['tools/list', 'S2']]);
    expect(net.log.filter((x) => x.body.method === 'tools/call')).toHaveLength(1);
    await link.drained();
    expect(await link.handoff('look', '{"x":1}', new AbortController().signal, 5000)).toMatchObject({ kind: 'result' });
  });

  it('a second 404 straight after the re-handshake ends the run', async () => {
    let n = 0;
    const endedRuns: string[] = [];
    const net = fakeNet((body, headers) => {
      if (body.method === 'initialize') return { ...json(initResult(body.id)), headers: [['content-type', 'application/json'], ['mcp-session-id', `S${++n}`]] };
      if (body.method === 'notifications/initialized') return { status: 202, headers: [], chunks: [] };
      if (body.method === 'tools/list' && n === 1) return json(listResult(body.id, ['look']));
      void headers;
      return { status: 404, headers: [], chunks: [] };
    });
    const link = new ServerLink('srv', { net: net.port }, realClock, { ended: (_r, f) => endedRuns.push(f.words) });
    await link.start(remote, 'L1');
    await link.drained();
    await link.handoff('look', '{}', new AbortController().signal, 5000);
    for (let i = 0; i < 100 && endedRuns.length === 0; i++) await sleep(5);
    expect(endedRuns).toEqual(['The server ended its session.']);
    expect(net.log.filter((x) => x.body.method === 'initialize')).toHaveLength(2);
  });

  it('a redirect, a stream that ends before its reply, and an invalid answer each end the exchange in words', async () => {
    const cases: [any, RegExp | string][] = [
      [{ status: 307, headers: [], chunks: [] }, /redirected/],
      [{ status: 200, headers: [['content-type', 'application/json']], chunks: [], redirected: true }, /redirected/],
      [{ status: 200, headers: [['content-type', 'text/event-stream']], chunks: ['data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'] }, 'interrupted'],
      [{ status: 200, headers: [['content-type', 'application/json']], chunks: ['{"jsonrpc":"2.0","id":4,"result":7}'] }, /couldn't read/]
    ];
    for (const [answer, words] of cases) {
      const net = remoteServer((body) => (body.method === 'tools/call' ? answer : undefined));
      const link = new ServerLink('srv', { net: net.port }, realClock, ended);
      await link.start(remote, 'L1');
      await link.drained();
      const out = await link.handoff('look', '{}', new AbortController().signal, 5000);
      if (words === 'interrupted') expect(out).toEqual({ kind: 'interrupted' });
      else expect((out as any).words).toMatch(words as RegExp);
    }
  });

  it('a refused initialize names the server\'s versions; a page cursor walk stops at 16 pages', async () => {
    const refusing = fakeNet((body) => json({ jsonrpc: '2.0', id: body.id, error: { code: -32022, message: 'no', data: { supported: ['2030-01-01'] } } }));
    const r = await new ServerLink('srv', { net: refusing.port }, realClock, ended).start(remote, 'L1');
    expect(r).toMatchObject({ ok: false, failure: { words: 'This server speaks MCP 2030-01-01 only; Familiar speaks 2024-10-07 to 2026-07-28.' } });
    const paging = remoteServer((body) => (body.method === 'tools/list' ? json(listResult(body.id, [`t${body.id}`], `c${body.id}`)) : undefined));
    const p = await new ServerLink('srv', { net: paging.port }, realClock, ended).start(remote, 'L1');
    expect(p).toMatchObject({ ok: false, failure: { words: expect.stringMatching(/16 pages/) } });
    expect(paging.log.filter((x) => x.body.method === 'tools/list')).toHaveLength(16);
  });
});

/* ---------- the link: local ---------- */

function localServer(extra: (msg: any) => any = () => undefined) {
  return fakeProcess((msg) => {
    const x = extra(msg);
    if (x) return x;
    if (msg.method === 'initialize') return [JSON.stringify(initResult(msg.id))];
    if (msg.method === 'tools/list') return [JSON.stringify(listResult(msg.id, ['look']))];
    if (msg.method === 'tools/call') return [JSON.stringify(textResult(msg.id, 'ran'))];
    return [];
  });
}

describe('3.9: the link, local', () => {
  it('starts, lists and calls over one line per message', async () => {
    const p = localServer();
    const link = new ServerLink('srv', { processes: p.port }, realClock, ended);
    expect(await link.start(local, 'L1')).toMatchObject({ ok: true });
    await link.drained();
    expect(await link.handoff('look', '{}', new AbortController().signal, 5000)).toMatchObject({ kind: 'result', text: 'ran' });
    expect(p.writes.map((w) => w.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  });

  it('a stopped call sends notifications/cancelled for its id, and a late reply to that id is dropped', async () => {
    let callId = 0;
    const p = localServer((msg) => (msg.method === 'tools/call' ? ((callId = msg.id), []) : undefined));
    const link = new ServerLink('srv', { processes: p.port }, realClock, ended);
    await link.start(local, 'L1');
    await link.drained();
    const stop = new AbortController();
    const out = link.handoff('look', '{}', stop.signal, 5000)!;
    await sleep(5);
    stop.abort();
    expect(await out).toEqual({ kind: 'stopped' });
    expect(p.writes.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: callId } });
    p.emit({ t: 'out', line: JSON.stringify(textResult(callId, 'late')) });
    await link.drained();
    expect(link.current?.ready).toBe(true);
  });

  it('an idle ping is answered as an exchange of its own and leaves the server free; a dropped long line fails the live exchange', async () => {
    const p = localServer((msg) => (msg.method === 'tools/call' ? [{ t: 'err', line: 'a stdout line over 4 MiB was dropped' }] : undefined));
    const link = new ServerLink('srv', { processes: p.port }, realClock, ended);
    await link.start(local, 'L1');
    await link.drained();
    p.emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: 'i1', method: 'ping' }) });
    await sleep(5);
    expect(p.writes.at(-1)).toEqual({ jsonrpc: '2.0', id: 'i1', result: {} });
    await link.drained();
    expect(link.busy).toBe(false);
    expect(await link.handoff('look', '{}', new AbortController().signal, 5000)).toMatchObject({ kind: 'error', words: 'The server sent a line too long.' });
  });

  it('a crash mid-call: the call is interrupted, the run ends with its exit', async () => {
    const ends: string[] = [];
    const p = localServer((msg) => (msg.method === 'tools/call' ? [] : undefined));
    const link = new ServerLink('srv', { processes: p.port }, realClock, { ended: (_r, f) => ends.push(f.kind) });
    await link.start(local, 'L1');
    await link.drained();
    const out = link.handoff('look', '{}', new AbortController().signal, 5000)!;
    await sleep(5);
    p.exit(1);
    expect(await out).toEqual({ kind: 'interrupted' });
    expect(ends).toEqual(['exited']);
    await link.drained();
    expect(link.current).toBeUndefined();
  });

  it('a call past its time limit times out alone', async () => {
    const p = localServer((msg) => (msg.method === 'tools/call' ? [] : undefined));
    const link = new ServerLink('srv', { processes: p.port }, realClock, ended);
    await link.start(local, 'L1');
    await link.drained();
    expect(await link.handoff('look', '{}', new AbortController().signal, 20)).toEqual({ kind: 'timed-out' });
    await link.drained();
    expect(link.current?.ready).toBe(true);
  });
});
