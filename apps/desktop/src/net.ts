/* The guarded fetch, as a `fetch` a model SDK can take. Every request goes to familiar.exe's
   `net_fetch`, which reaches only the saved address given here, puts the stored key in place of
   the placeholder, and redacts the key from everything that comes back. The body arrives by
   pulling `net_read`. A signal ends it at any moment with an `AbortError`, as the browser's own
   fetch does. See "5c. The guarded fetch" in docs/shell-design.md. */
import { createShell, reason, type NetHead, type Shell, type ShellError } from './shell.ts';

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
    const id = randomId();
    // Whether the exe has been asked yet, and whether it's all over: a cancel is sent only between.
    let sent = false, done = false;
    let rejectHead: ((e: unknown) => void) | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = () => { done = true; signal?.removeEventListener('abort', onAbort); };
    // Watched from here to the end, through the body's preparation, the request and the stream.
    function onAbort() {
      if (sent && !done) void shell.netCancel(id).catch(() => {});
      rejectHead?.(abort());
      if (controller && !done) controller.error(abort());
      done = true;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const headers: [string, string][] = [...new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).entries()];
    let head: NetHead;
    try {
      const body = await bodyBytes(init.body ?? null);
      // Checked again right before the exe is asked: an abort during the body's preparation stops
      // it here.
      if (signal?.aborted) throw abort();
      sent = true;
      head = await new Promise<NetHead>((resolve, reject) => {
        rejectHead = reject;
        shell.netFetch({ id, address, url, method, headers, ...opts }, body).then(resolve, e => reject(signal?.aborted ? abort() : failure(e)));
      });
      rejectHead = undefined;
      if (signal?.aborted) throw abort();
    } catch (e) {
      finish();
      throw e;
    }

    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      async pull(c) {
        if (signal?.aborted) { c.error(abort()); return; }
        try {
          const chunk = await shell.netRead(id);
          if (signal?.aborted) { c.error(abort()); return; }
          if (chunk.length === 0) { finish(); c.close(); }
          else c.enqueue(chunk);
        } catch (e) {
          const aborted = signal?.aborted;
          finish();
          c.error(aborted ? abort() : failure(e));
        }
      },
      cancel() {
        if (!done) void shell.netCancel(id).catch(() => {});
        finish();
      }
    }, { highWaterMark: 0 });
    // A status with no body can't carry a stream.
    const empty = head.status === 204 || head.status === 205 || head.status === 304 || method.toUpperCase() === 'HEAD';
    if (empty) void stream.cancel();
    const response = new Response(empty ? null : stream, { status: head.status, statusText: head.statusText, headers: head.headers });
    Object.defineProperty(response, 'url', { value: head.url });
    Object.defineProperty(response, 'redirected', { value: head.redirected });
    return response;
  };
}
