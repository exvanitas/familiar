/* A stand-in for familiar.exe's guarded fetch, so the model contract can run over the real
   guardedFetch in Node: it reaches only the one saved address, swaps the placeholder for the stored key
   in the key headers only, refuses the placeholder with no key (no-key), and blanks the key in what
   comes back. A simplified copy of 5a and 5c in docs/shell-design.md, for tests; the real one is the
   exe, checked on the Windows runner. */
import { PLACEHOLDER } from '../../src/net.ts';
import type { NetHead, NetSpec, Shell } from '../../src/shell.ts';

const KEY_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']);

export function exeShell(saved: { id: string; url: string; key?: string }): Shell & { readonly sent: { url: string; headers: [string, string][] }[] } {
  const open = new Map<string, { reader: ReadableStreamDefaultReader<Uint8Array>; abort: AbortController; spec: NetSpec; total: number }>();
  const sent: { url: string; headers: [string, string][] }[] = [];
  const blank = (s: string) => (saved.key ? s.replaceAll(saved.key, '[key]') : s);
  const shell = {
    sent,
    async netFetch(spec: NetSpec, body: Uint8Array): Promise<NetHead> {
      if (spec.address !== saved.id || !(spec.url === saved.url || spec.url.startsWith(saved.url + '/'))) throw { kind: 'not-saved', message: 'not under a saved address' };
      const headers = spec.headers.map(([k, v]): [string, string] => {
        if (!KEY_HEADERS.has(k) || !v.includes(PLACEHOLDER)) return [k, v];
        if (!saved.key) throw { kind: 'no-key', message: 'no key stored' };
        return [k, v.replaceAll(PLACEHOLDER, saved.key)];
      });
      sent.push({ url: spec.url, headers: spec.headers });
      const abort = new AbortController();
      let r: Response;
      try {
        r = await fetch(spec.url, { method: spec.method, headers, ...(body.length ? { body: body as Uint8Array<ArrayBuffer> } : {}), signal: abort.signal });
      } catch {
        throw { kind: 'network', message: 'connect failed' };
      }
      open.set(spec.id, { reader: r.body!.getReader(), abort, spec, total: 0 });
      return { status: r.status, statusText: r.statusText, headers: [...r.headers.entries()].map(([k, v]) => [k, blank(v)]), url: r.url, redirected: r.redirected };
    },
    async netRead(id: string): Promise<Uint8Array> {
      const o = open.get(id);
      if (!o) throw { kind: 'cancelled', message: 'no such request' };
      // The exe's own limits: quiet past idleMs is `timeout`, a body past maxBytes is `too-large`.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = o.spec.idleMs === undefined ? undefined : new Promise<'idle'>(done => { timer = setTimeout(() => done('idle'), o.spec.idleMs); });
      const next = await (idle ? Promise.race([o.reader.read(), idle]) : o.reader.read());
      clearTimeout(timer);
      if (next === 'idle') { o.abort.abort(); open.delete(id); throw { kind: 'timeout', message: 'idle' }; }
      if (next.done) { open.delete(id); return new Uint8Array(0); }
      o.total += next.value.length;
      if (o.spec.maxBytes !== undefined && o.total > o.spec.maxBytes) { o.abort.abort(); open.delete(id); throw { kind: 'too-large', message: 'too large' }; }
      return new TextEncoder().encode(blank(new TextDecoder().decode(next.value)));
    },
    async netCancel(id: string): Promise<void> {
      open.get(id)?.abort.abort();
      open.delete(id);
    }
  };
  return shell as unknown as Shell & { sent: typeof sent };
}
