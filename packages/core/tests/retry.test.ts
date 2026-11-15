import { describe, expect, it } from 'vitest';
import { withRetries } from '../src/index.ts';
import type { ModelError, ModelEvent } from '../src/index.ts';
import { createFakeModel, type FakeReply } from '../src/testing/index.ts';

const request = { model: 'm', system: '', messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };
const busy: ModelError = { kind: 'server', message: 'Busy.', notProcessed: true };

async function all(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function setup(replies: FakeReply[], extra: { maxWaitMs?: number } = {}) {
  const model = createFakeModel(replies);
  const waits: number[] = [];
  const port = withRetries(model, { sleep: async (ms) => { waits.push(ms); }, random: () => 1, baseMs: 1000, ...extra });
  return { model, waits, port };
}

describe('retries', () => {
  it('tries three times in all, backing off 1 s then 2 s, and then gives the error', async () => {
    const { model, waits, port } = setup([{ error: busy }, { error: busy }, { error: busy }, { text: 'never' }]);
    const events = await all(port.stream(request));
    expect(model.requests).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(events).toEqual([{ type: 'error', error: busy }]);
  });

  it('a retry that works gives only its reply', async () => {
    const { waits, port } = setup([{ error: busy }, { text: 'ok' }]);
    const events = await all(port.stream(request));
    expect(waits).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it("honours Retry-After within the bound, and doesn't wait past it", async () => {
    const limited = (ms: number): ModelError => ({ kind: 'rate-limit', message: 'Slow down.', retryAfterMs: ms, notProcessed: true });
    const a = setup([{ error: limited(2000) }, { text: 'ok' }], { maxWaitMs: 5000 });
    await all(a.port.stream(request));
    expect(a.waits).toEqual([2000]);
    const b = setup([{ error: limited(60_000) }, { text: 'never' }], { maxWaitMs: 5000 });
    const events = await all(b.port.stream(request));
    expect(b.model.requests).toHaveLength(1);
    expect(events).toEqual([{ type: 'error', error: limited(60_000) }]);
  });

  it('never retries once any event of the reply was delivered', async () => {
    const { model, port } = setup([{ text: 'half', error: busy }, { text: 'never' }]);
    const events = await all(port.stream(request));
    expect(model.requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'error', error: busy });
  });

  it('never retries a request that might have been half done, or one that failed for another reason', async () => {
    for (const error of [
      { kind: 'server', message: 'Failed.' },
      { kind: 'network', message: 'Lost.' },
      { kind: 'auth', message: 'No.', notProcessed: true },
      { kind: 'bad-request', message: 'No.', notProcessed: true },
      { kind: 'aborted', message: 'Stopped.', notProcessed: true }
    ] as ModelError[]) {
      const { model, port } = setup([{ error }, { text: 'never' }]);
      await all(port.stream(request));
      expect(model.requests, error.kind).toHaveLength(1);
    }
  });

  it('retries a network error when the connection was never made', async () => {
    const { model, port } = setup([{ error: { kind: 'network', message: 'Refused.', notProcessed: true } }, { text: 'ok' }]);
    await all(port.stream(request));
    expect(model.requests).toHaveLength(2);
  });

  it('a stop during the wait ends with aborted and sends nothing more', async () => {
    const model = createFakeModel([{ error: busy }, { text: 'never' }]);
    const c = new AbortController();
    const port = withRetries(model, { sleep: async () => { c.abort(); } });
    const events = await all(port.stream(request, c.signal));
    expect(model.requests).toHaveLength(1);
    expect(events).toEqual([{ type: 'error', error: { kind: 'aborted', message: 'Stopped.' } }]);
  });
});
