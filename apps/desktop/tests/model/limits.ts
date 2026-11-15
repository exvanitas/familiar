/* The guarded fetch's idle and size limits, for a plain fetch: past either, the body's stream errors
   with a TypeError whose `cause.kind` is the exe's word, as the guarded fetch's does. */
export function limited(inner: typeof fetch, l: { idleMs?: number; maxBytes?: number }): typeof fetch {
  return async (input, init) => {
    const r = await inner(input, init);
    if (!r.body || (l.idleMs === undefined && l.maxBytes === undefined)) return r;
    const reader = r.body.getReader();
    let total = 0;
    const fail = (kind: string) => new TypeError(`Familiar's fetch failed: ${kind}`, { cause: { kind } });
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = l.idleMs === undefined ? undefined : new Promise<'idle'>(done => { timer = setTimeout(() => done('idle'), l.idleMs); });
        const next = await (idle ? Promise.race([reader.read(), idle]) : reader.read());
        clearTimeout(timer);
        if (next === 'idle') { void reader.cancel().catch(() => {}); c.error(fail('timeout')); return; }
        if (next.done) { c.close(); return; }
        total += next.value.length;
        if (l.maxBytes !== undefined && total > l.maxBytes) { void reader.cancel().catch(() => {}); c.error(fail('too-large')); return; }
        c.enqueue(next.value);
      },
      cancel: reason => reader.cancel(reason)
    }, { highWaterMark: 0 });
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}
