/* The guarded fetch, as a `fetch` a model SDK can take. Every request goes to familiar.exe's
   `net_fetch`, which reaches only the saved address given here, puts the stored key in place of
   the placeholder, and redacts the key from everything that comes back. The body arrives by
   pulling `net_read`. A signal ends it at any moment with an `AbortError`, as the browser's own
   fetch does. See "5c. The guarded fetch" in docs/shell-design.md. */
import { createShell, reason, type Shell, type ShellError } from './shell.ts';

/* What a key-holding endpoint gets as its `apiKey`: the exe swaps it for the stored key, only in
   the authorization, x-api-key, api-key and x-goog-api-key headers. */
export const PLACEHOLDER = 'familiar-stored-key';

const abort = () => new DOMException('Aborted', 'AbortError');
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

/* A network failure as fetch reports one, with the exe's kind in `cause`. */
function failure(e: unknown): TypeError {
  const kind = typeof e === 'object' && e !== null && 'kind' in e ? (e as ShellError).kind : 'network';
  return new TypeError(`Familiar's fetch failed: ${reason(e)}`, { cause: { kind } });
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export interface GuardedOptions { maxBytes?: number; headersMs?: number; idleMs?: number }

export function guardedFetch(address: string, opts: GuardedOptions = {}, shell: Shell = createShell()): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    // A signal already aborted never reaches the exe.
    if (signal?.aborted) throw abort();
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const headers: [string, string][] = [...new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).entries()];
    const body = await bodyBytes(init.body ?? null);
    const id = randomId();
    let done = false;
    const cancel = () => { if (!done) void shell.netCancel(id).catch(() => {}); };

    const head = await new Promise<Awaited<ReturnType<Shell['netFetch']>>>((resolve, reject) => {
      const onAbort = () => { cancel(); reject(abort()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      shell.netFetch({ id, address, url, method, headers, ...opts }, body).then(
        h => { signal?.removeEventListener('abort', onAbort); resolve(h); },
        e => { signal?.removeEventListener('abort', onAbort); reject(signal?.aborted ? abort() : failure(e)); }
      );
    });

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const onAbort = () => { cancel(); controller?.error(abort()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      async pull(c) {
        try {
          const chunk = await shell.netRead(id);
          if (signal?.aborted) return;
          if (chunk.length === 0) {
            done = true;
            signal?.removeEventListener('abort', onAbort);
            c.close();
          } else c.enqueue(chunk);
        } catch (e) {
          done = true;
          signal?.removeEventListener('abort', onAbort);
          c.error(signal?.aborted ? abort() : failure(e));
        }
      },
      cancel() { cancel(); done = true; }
    }, { highWaterMark: 0 });
    // A status with no body can't carry a stream.
    const empty = head.status === 204 || head.status === 205 || head.status === 304 || method.toUpperCase() === 'HEAD';
    if (empty) { void stream.cancel(); }
    const response = new Response(empty ? null : stream, { status: head.status, statusText: head.statusText, headers: head.headers });
    Object.defineProperty(response, 'url', { value: head.url });
    Object.defineProperty(response, 'redirected', { value: head.redirected });
    return response;
  };
}
