// Bounded retries around any model port. A failed call is sent again only when that can't do anything
// twice or show anything twice:
//   - nothing of the reply had been delivered yet (the error was the first event),
//   - the error is a rate limit, a server error or a network error,
//   - the endpoint or the transport said the request wasn't acted on (`notProcessed`),
//   - and it isn't a stop (`aborted` is never retried).
// Three tries in all, with exponential backoff and jitter. A Retry-After is honoured when it is within
// `maxWaitMs`; a longer one ends the call with the error, so the person sees it instead of a long wait.

import type { ModelError, ModelEvent, ModelPort } from './port.ts';

export interface RetryOptions {
  /** Tries in all, the first included. Default 3. */
  readonly tries?: number;
  /** The first backoff. Default 1000 ms, doubling each time. */
  readonly baseMs?: number;
  /** The longest wait, for a Retry-After or a backoff. Default 30 s. */
  readonly maxWaitMs?: number;
  /** Waits, and settles early if the signal fires. Injected, so tests run without a clock. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0 to 1, for jitter. Default Math.random. */
  readonly random?: () => number;
}

const RETRYABLE = new Set<ModelError['kind']>(['rate-limit', 'server', 'network']);

export function retryable(error: ModelError): boolean {
  return RETRYABLE.has(error.kind) && error.notProcessed === true;
}

/** How long to wait before try `next` (2 or more), or undefined when it shouldn't wait that long. */
export function waitBefore(next: number, error: ModelError, opts: RetryOptions): number | undefined {
  const max = opts.maxWaitMs ?? 30_000;
  if (error.retryAfterMs !== undefined) return error.retryAfterMs <= max ? error.retryAfterMs : undefined;
  const base = (opts.baseMs ?? 1000) * 2 ** (next - 2);
  return Math.min(max, Math.round(base * (0.5 + (opts.random ?? Math.random)() / 2)));
}

export function withRetries(port: ModelPort, opts: RetryOptions): ModelPort {
  const tries = Math.max(1, opts.tries ?? 3);
  return {
    async *stream(request, signal) {
      for (let attempt = 1; ; attempt++) {
        let delivered = false;
        let failed: ModelError | undefined;
        for await (const event of port.stream(request, signal)) {
          if (!delivered && event.type === 'error' && attempt < tries && retryable(event.error) && !signal?.aborted) {
            failed = event.error;
            break;
          }
          delivered = true;
          yield event;
        }
        if (!failed) return;
        const wait = waitBefore(attempt + 1, failed, opts);
        if (wait === undefined) {
          yield { type: 'error', error: failed } satisfies ModelEvent;
          return;
        }
        await opts.sleep(wait, signal);
        if (signal?.aborted) {
          yield { type: 'error', error: { kind: 'aborted', message: 'Stopped.' } };
          return;
        }
      }
    }
  };
}
