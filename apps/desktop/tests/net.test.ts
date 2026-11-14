/* guardedFetch over a fake exe: what a model SDK sees. */
import { describe, expect, it } from 'vitest';
import { guardedFetch } from '../src/net.ts';
import type { NetHead, NetSpec, Shell } from '../src/shell.ts';

function fakeShell(o: { head?: NetHead; chunks?: Uint8Array[]; fetchError?: unknown; readError?: unknown; slowHead?: boolean }) {
  const calls: string[] = [];
  let spec: NetSpec | undefined;
  let body: Uint8Array | undefined;
  const chunks = [...(o.chunks ?? [])];
  let release: () => void = () => {};
  const shell = {
    netFetch: async (s: NetSpec, b: Uint8Array) => {
      calls.push('fetch');
      spec = s; body = b;
      if (o.slowHead) await new Promise<void>(r => { release = r; });
      if (o.fetchError) throw o.fetchError;
      return o.head ?? { status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], url: s.url, redirected: false };
    },
    netRead: async () => {
      calls.push('read');
      if (o.readError) throw o.readError;
      return chunks.shift() ?? new Uint8Array(0);
    },
    netCancel: async () => { calls.push('cancel'); }
  } as unknown as Shell;
  return { shell, calls, spec: () => spec, body: () => body, release: () => release() };
}
const text = (s: string) => new TextEncoder().encode(s);

describe('guardedFetch', () => {
  it('sends the spec and the body, and streams the reply until an empty read', async () => {
    const f = fakeShell({ chunks: [text('hel'), text('lo')] });
    const r = await guardedFetch('addr1', { idleMs: 5000 }, f.shell)('https://api.example/v1/x', { method: 'POST', body: '{"a":1}', headers: { authorization: 'Bearer familiar-stored-key' } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello');
    const s = f.spec()!;
    expect(s).toMatchObject({ address: 'addr1', url: 'https://api.example/v1/x', method: 'POST', idleMs: 5000 });
    expect(s.id).toMatch(/^[0-9a-f]{32}$/);
    expect(s.headers).toContainEqual(['authorization', 'Bearer familiar-stored-key']);
    expect(new TextDecoder().decode(f.body())).toBe('{"a":1}');
  });

  it('an aborted signal never reaches the exe', async () => {
    const f = fakeShell({});
    const c = new AbortController();
    c.abort();
    await expect(guardedFetch('a', {}, f.shell)('https://x.example', { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toEqual([]);
  });

  it('an abort before the head rejects with AbortError and cancels in the exe', async () => {
    const f = fakeShell({ slowHead: true });
    const c = new AbortController();
    const p = guardedFetch('a', {}, f.shell)('https://x.example', { signal: c.signal });
    await new Promise(r => setTimeout(r, 10));
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toContain('cancel');
    f.release();
  });

  it('an abort mid-stream errors the stream with AbortError and cancels', async () => {
    const f = fakeShell({ chunks: [text('a'), text('b'), text('c')] });
    const c = new AbortController();
    const r = await guardedFetch('a', {}, f.shell)('https://x.example', { signal: c.signal });
    const reader = r.body!.getReader();
    expect((await reader.read()).value).toEqual(text('a'));
    c.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toContain('cancel');
  });

  it('an abort while the body is being prepared never reaches the exe', async () => {
    const f = fakeShell({});
    const c = new AbortController();
    const p = guardedFetch('a', {}, f.shell)('https://x.example', { method: 'POST', body: new Blob(['a body to read first']), signal: c.signal });
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toEqual([]);
  });

  it('an abort while an upload stream is still unfinished rejects at once, and never reaches the exe', async () => {
    const f = fakeShell({});
    const c = new AbortController();
    // A body that sends one chunk and then never ends.
    const body = new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(new Uint8Array([1, 2, 3])); } });
    const p = guardedFetch('a', {}, f.shell)('https://x.example', { method: 'POST', body, signal: c.signal, duplex: 'half' } as RequestInit);
    setTimeout(() => c.abort(), 50);
    const result = await Promise.race([p.then(() => 'answered', e => e.name), new Promise(res => setTimeout(() => res('hung'), 1000))]);
    expect(result).toBe('AbortError');
    expect(f.calls).toEqual([]);
  });

  it('a read after an abort errors with AbortError, and never hangs', async () => {
    const f = fakeShell({ chunks: [text('a'), text('b')] });
    const c = new AbortController();
    const r = await guardedFetch('a', {}, f.shell)('https://x.example', { signal: c.signal });
    c.abort();
    const reader = r.body!.getReader();
    const result = await Promise.race([reader.read().then(() => 'read', e => e.name), new Promise(res => setTimeout(() => res('hung'), 500))]);
    expect(result).toBe('AbortError');
    expect(f.calls).toContain('cancel');
  });

  it('the exe refusing is a TypeError with its kind, as a network failure is', async () => {
    const f = fakeShell({ fetchError: { kind: 'not-saved', message: 'the request ended: not-saved' } });
    const e = await guardedFetch('a', {}, f.shell)('https://x.example').catch(x => x);
    expect(e).toBeInstanceOf(TypeError);
    expect(e.cause).toEqual({ kind: 'not-saved' });
    const g = fakeShell({ readError: { kind: 'too-large', message: 'x' } });
    const r = await guardedFetch('a', {}, g.shell)('https://x.example');
    const e2 = await r.text().catch(x => x);
    expect(e2.cause).toEqual({ kind: 'too-large' });
  });
});
