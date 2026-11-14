import { describe, expect, it } from 'vitest';
import { createFakeModel } from '../src/testing/index.ts';
import type { ModelEvent, ModelRequest } from '../src/index.ts';

const request = (content: string): ModelRequest => ({
  model: 'fake',
  system: 'sys',
  messages: [{ role: 'user', content }],
  tools: []
});

async function all(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('fake model', () => {
  it('uses a list of replies in order and records each request as it was', async () => {
    const model = createFakeModel([{ text: 'one' }, { text: 'two' }]);
    const req = request('first');
    const first = await all(model.stream(req));
    (req.messages as unknown as { content: string }[])[0]!.content = 'changed later';
    const second = await all(model.stream(request('second')));
    expect(first.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('one');
    expect(second.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('two');
    expect(model.requests.map((r) => r.messages[0]!.content)).toEqual(['first', 'second']);
  });

  it('says plainly when the script runs out, as an error event', async () => {
    const model = createFakeModel([{ text: 'only one' }]);
    await all(model.stream(request('a')));
    const events = await all(model.stream(request('b')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'unknown' } });
    expect((events[0] as { error: { message: string } }).error.message).toContain('1 replies');
  });

  it('passes the request and its index to a script function', async () => {
    const model = createFakeModel((req, i) => ({ text: `${i}:${req.messages[0]!.content}` }));
    const events = await all(model.stream(request('hi')));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('0:hi');
  });

  it('streams thinking, then text, then tool calls, then done', async () => {
    const model = createFakeModel([
      { thinking: 'hmm', text: 'ok', toolCalls: [{ id: 'c1', name: 'note', arguments: { text: 'x' } }], chunkSize: 10 }
    ]);
    const types = (await all(model.stream(request('go')))).map((e) => e.type);
    expect(types).toEqual(['thinking', 'text', 'tool-call', 'done']);
  });

  it('can end with an error after some text', async () => {
    const model = createFakeModel([{ text: 'partial', chunkSize: 100, error: { kind: 'server', message: 'It failed.' } }]);
    const events = await all(model.stream(request('go')));
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
  });

  it('holds mid-reply until the test lets it go', async () => {
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const model = createFakeModel([{ text: 'abcd', chunkSize: 1, pause: { afterEvents: 2, until } }]);
    const iterator = model.stream(request('go'))[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) seen.push(((await iterator.next()).value as { delta: string }).delta);
    const third = iterator.next();
    const raced = await Promise.race([third, new Promise((r) => setTimeout(() => r('held'), 20))]);
    expect(raced).toBe('held');
    release();
    seen.push(((await third).value as { delta: string }).delta);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('stops during a hold when the signal fires', async () => {
    const controller = new AbortController();
    const model = createFakeModel([{ text: 'abcd', chunkSize: 1, pause: { afterEvents: 1, until: new Promise(() => {}) } }]);
    const events: ModelEvent[] = [];
    for await (const e of model.stream(request('go'), controller.signal)) {
      events.push(e);
      if (events.length === 1) setTimeout(() => controller.abort(), 5);
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
    expect(events[1]).toMatchObject({ error: { kind: 'aborted' } });
  });
});
