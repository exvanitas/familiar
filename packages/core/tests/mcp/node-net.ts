// A NetPort over Node's fetch, for the client tests against the fake server over HTTP: net_fetch's id,
// head and pulled body, and net_cancel that resolves once the request has ended. It has no saved
// addresses or key swap (the exe's job); `cancels` counts what was ended.

import type { NetHead, NetPort, NetSpec } from '../../src/index.ts';

export function nodeNetPort(): NetPort & { readonly cancels: string[]; readonly specs: NetSpec[] } {
  const open = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> }>();
  const cancels: string[] = [];
  const specs: NetSpec[] = [];
  return {
    cancels,
    specs,
    async fetch(spec: NetSpec, body: Uint8Array): Promise<NetHead> {
      specs.push(spec);
      const controller = new AbortController();
      open.set(spec.id, { controller });
      let r: Response;
      try {
        r = await fetch(spec.url, { method: spec.method, headers: spec.headers.map(([k, v]) => [k, v] as [string, string]), body: body as unknown as BodyInit, signal: controller.signal, redirect: 'manual' });
      } catch (e) {
        open.delete(spec.id);
        throw Object.assign(new Error('network'), { kind: controller.signal.aborted ? 'cancelled' : 'network', cause: e });
      }
      const entry = open.get(spec.id);
      if (entry && r.body) entry.reader = r.body.getReader();
      const headers: [string, string][] = [];
      r.headers.forEach((v, k) => headers.push([k, v]));
      return { status: r.status, statusText: r.statusText, headers, url: r.url, redirected: r.redirected };
    },
    async read(id: string): Promise<Uint8Array> {
      const entry = open.get(id);
      if (!entry?.reader) return new Uint8Array(0);
      try {
        const { done, value } = await entry.reader.read();
        return done ? new Uint8Array(0) : value;
      } catch {
        throw Object.assign(new Error('cancelled'), { kind: 'cancelled' });
      }
    },
    async cancel(id: string): Promise<void> {
      const entry = open.get(id);
      open.delete(id);
      cancels.push(id);
      if (!entry) return;
      entry.controller.abort();
      await entry.reader?.cancel().catch(() => {});
    }
  };
}
