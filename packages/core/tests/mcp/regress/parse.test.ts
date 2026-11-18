// Reading a server's answers (3.10): text decoded whole across reads, line ends split across reads, a
// status read on every media type, and shapes that can't throw out of a call.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import { EventStream } from '../../../src/mcp/wire/parse.ts';
import { fakeNet, initResult, json, listResult, realClock, sse, textResult } from '../wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };
const enc = new TextEncoder();

/** A remote server whose call answer is the given bytes, split at `cuts`. */
function splitCall(body: (id: number) => Uint8Array, type: string, cuts: number[]) {
  const net = fakeNet((b) => {
    if (b.method === 'initialize') return json(initResult(b.id));
    if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
    if (b.method === 'tools/list') return json(listResult(b.id, ['look']));
    return json({});
  });
  const fetch = net.port.fetch.bind(net.port);
  const read = net.port.read.bind(net.port);
  let callId: string | undefined;
  let parts: Uint8Array[] = [];
  net.port.fetch = async (spec, raw) => {
    const m = JSON.parse(new TextDecoder().decode(raw));
    if (m.method !== 'tools/call') return fetch(spec, raw);
    callId = spec.id;
    const bytes = body(m.id);
    const at = [0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length];
    parts = at.slice(1).map((end, i) => bytes.slice(at[i], end));
    return { status: 200, statusText: '', headers: [['content-type', type]], url: '', redirected: false };
  };
  net.port.read = async (id) => (id === callId ? (parts.shift() ?? new Uint8Array(0)) : read(id));
  return net;
}

describe('a result split across reads', () => {
  it('decodes a multibyte character split at any byte, JSON or event stream', async () => {
    const body = (type: string) => (id: number) => {
      const whole = JSON.stringify(textResult(id, 'café ✓ 𝄞'));
      return enc.encode(type === 'application/json' ? whole : `data: ${whole}\r\n\r\n`);
    };
    for (const type of ['application/json', 'text/event-stream']) {
      const n = body(type)(3).length;
      for (let cut = 1; cut < n; cut++) {
        const net = splitCall(body(type), type, [cut]);
        const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
        await link.start(remote, 'L');
        const out = await link.handoff('look', '{}', new AbortController().signal, 5000);
        expect((out as { text?: string }).text, `${type}, cut at ${cut}`).toBe('café ✓ 𝄞');
      }
    }
  }, 60_000);
});

describe('line ends split across reads', () => {
  it('a CR at a chunk\'s end waits for the next byte: CR, LF and CRLF events, split anywhere, give one message', () => {
    for (const nl of ['\r', '\n', '\r\n']) {
      const text = `data: {"jsonrpc":"2.0",${nl}data: "id":1,"result":{}}${nl}${nl}`;
      const bytes = enc.encode(text);
      for (let cut = 1; cut < bytes.length; cut++) {
        const s = new EventStream();
        const got = [...s.push(bytes.slice(0, cut)), ...s.push(bytes.slice(cut)), ...s.end()];
        expect(got, `${JSON.stringify(nl)} cut at ${cut}`).toEqual(['{"jsonrpc":"2.0",\n"id":1,"result":{}}']);
      }
    }
  });
});

describe('a status other than 2xx', () => {
  it('fails an initialize with a success body in an event stream, in both media types', async () => {
    for (const r of [{ ...sse(initResult(1)), status: 401 }, { ...json(initResult(1)), status: 401 }]) {
      const net = fakeNet((b) => {
        if (b.method === 'initialize') return { ...r, chunks: r.chunks!.map((c) => c.replace('"id":1', `"id":${b.id}`)) };
        if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
        return json(listResult(b.id, ['look']));
      });
      const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
      expect((await link.start(remote, 'L')).ok).toBe(false);
    }
  });

  it('a media type neither JSON nor an event stream is refused', async () => {
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return { ...json(initResult(b.id)), headers: [['content-type', 'text/html']] };
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      return json(listResult(b.id, ['look']));
    });
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    expect((await link.start(remote, 'L')).ok).toBe(false);
    // Refused at initialize itself: the HTML-labelled answer was never read, so nothing followed it.
    expect(net.log.map((x) => x.body?.method)).toEqual(['initialize']);
  });

  for (const type of ['application/jsonp', 'application/json-seq', 'text/event-streaming', 'text/event-stream-anything', `text/x-${'a'.repeat(7000)}`])
    it(`a lookalike type is another type, and its words carry none of it: ${type.slice(0, 30)}`, async () => {
      const net = fakeNet((b) => {
        if (b.method === 'initialize') return { ...json(initResult(b.id)), headers: [['content-type', type]] };
        if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
        return json(listResult(b.id, ['look']));
      });
      const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
      const r = await link.start(remote, 'L');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.failure.words).not.toContain(type.split('/')[1]!.slice(0, 12));
      expect(r.failure.words.length).toBeLessThan(160);
    });

  it('a parameter after the exact type is still the type', async () => {
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return { ...json(initResult(b.id)), headers: [['content-type', 'Application/JSON ; charset=utf-8']] };
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      return json(listResult(b.id, ['look']));
    });
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    expect((await link.start(remote, 'L')).ok).toBe(true);
  });
});

describe('a modern resultType that isn\'t a string', () => {
  it('is a tool error, never a rejection', async () => {
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return { ...json({ jsonrpc: '2.0', id: b.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }), status: 400 };
      if (b.method === 'tools/list') return json({ jsonrpc: '2.0', id: b.id, result: { resultType: 'complete', tools: [{ name: 'look', inputSchema: { type: 'object', properties: {} } }] } });
      return json({ jsonrpc: '2.0', id: b.id, result: { resultType: { toString: 'x' }, content: [] } });
    });
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    await link.start(remote, 'L');
    const out = await link.handoff('look', '{}', new AbortController().signal, 5000)!.catch((e: unknown) => ({ rejected: String(e) }));
    expect(out).toMatchObject({ kind: 'result', isError: true });
  });
});

describe('untrusted input limits', () => {
  it('base64 is checked for its length and padding; a local initialize answer has the handshake\'s bound; words are cut at characters', async () => {
    const { callResult, cutText } = await import('../../../src/mcp/wire/parse.ts');
    for (const data of ['A', '=', 'AB=', 'A===']) expect(() => callResult({ content: [{ type: 'image', data, mimeType: 'image/png' }] }), data).toThrow();
    expect(() => callResult({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] })).not.toThrow();
    expect(cutText(`ab${'𝄞'}`, 3)).toBe('ab');
    const { fakeProcess } = await import('../wire-fakes.ts');
    const proc = fakeProcess((m) => (m.method === 'initialize' ? [JSON.stringify({ ...initResult(m.id), pad: 'x'.repeat(70 * 1024) })] : [JSON.stringify(listResult(m.id, ['look']))]));
    const link = new ServerLink('s', { processes: proc.port }, realClock, { ended: () => {} });
    const r = await link.start({ where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } }, 'L');
    expect(r.ok).toBe(false);
  });
});

describe('the declaration scan and the mirrored values', () => {
  it('refuses a declaration a $ref points at, and reads only own properties', async () => {
    const { scanDeclarations, paramHeaders } = await import('../../../src/mcp/wire/headers.ts');
    const schema = { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'X' }, y: { $ref: '#/properties/x' } } };
    expect(scanDeclarations(schema).ok).toBe(false);
    const whole = { type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'X' } } }, b: { $ref: '#/properties/a' } } };
    expect(scanDeclarations(whole).ok).toBe(false);
    const ctor = scanDeclarations({ type: 'object', properties: { constructor: { type: 'string', 'x-mcp-header': 'C' } } });
    if (!ctor.ok) throw new Error(ctor.reason);
    expect(paramHeaders(ctor.declarations, {}, 0)).toEqual({ ok: true, headers: [] });
  });
});

describe('cuts by character, and bounds by byte', () => {
  it("an error message cut at its bound never ends in half a character", async () => {
    const { parseMessage } = await import('../../../src/mcp/wire/parse.ts');
    const { wellFormed } = await import('../../../src/mcp/wire/headers.ts');
    const m = parseMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: `${'a'.repeat(1023)}😀 and more` } }));
    if (m.t !== 'response' || !m.error) throw new Error('not an error response');
    expect(wellFormed(m.error.message)).toBe(true);
    expect(m.error.message.length).toBeLessThanOrEqual(1024);
  });

  it("the server's last output is bounded in bytes: eight long lines of CJK text keep at most 16 KiB", async () => {
    const { LastOutput, LAST_BYTES } = await import('../../../src/mcp/last-output.ts');
    const last = new LastOutput();
    for (let i = 0; i < 8; i++) last.push('字'.repeat(2000));
    expect(new TextEncoder().encode(last.text()!).length).toBeLessThanOrEqual(LAST_BYTES);
  });
});
