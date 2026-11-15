/* The adapter never throws, whatever pi-ai, the SDK or the request does, and passes on only
   well-formed tool calls. */
import { describe, expect, it } from 'vitest';
import type { ModelEvent } from '@familiar/core';
import { CONTRACT_REQUEST } from '@familiar/core/testing';
import { checkCall, createPiAiPort, type PiAiModule } from '../../src/model/pi-ai.ts';
import { adapterOptions } from '../../src/model/presets.ts';

const base = (load: () => Promise<PiAiModule>) =>
  createPiAiPort({ ...adapterOptions({ preset: 'openai', baseUrl: 'http://127.0.0.1:1/v1', hasKey: true, fetch: () => Promise.reject(new Error('unused')), userAgent: 'Familiar/test' }), load });

async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const partial = { usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

describe('the adapter never throws', () => {
  it('a module that fails to load, a stream that throws at once, or part way, each end in one plain error', async () => {
    const cases: (() => Promise<PiAiModule>)[] = [
      () => Promise.reject(new Error('chunk failed to load: secret-looking text')),
      async () => ({ stream: () => { throw new Error('boom'); } }),
      async () => ({
        stream: async function* () {
          yield { type: 'text_delta', contentIndex: 0, delta: 'Hi', partial } as never;
          throw new Error('the SDK broke');
        }
      }),
      async () => ({ stream: async function* () { yield { type: 'text_delta', contentIndex: 0, delta: 'Hi', partial } as never; } })
    ];
    for (const load of cases) {
      const events = await drain(base(load).stream(CONTRACT_REQUEST));
      const last = events.at(-1)!;
      expect(events.filter(e => e.type === 'done' || e.type === 'error')).toHaveLength(1);
      expect(last.type).toBe('error');
      expect(JSON.stringify(last)).not.toMatch(/boom|broke|secret-looking/);
    }
  });

  it('a failure before anything was sent is a bad request, not processed; after, it carries the usage so far', async () => {
    const before = await drain(base(async () => ({ stream: () => { throw new Error('x'); } })).stream(CONTRACT_REQUEST));
    expect(before).toEqual([{ type: 'error', error: { kind: 'bad-request', message: "Familiar couldn't build the request.", notProcessed: true } }]);
    const after = await drain(base(async () => ({
      stream: async function* () {
        yield { type: 'text_delta', contentIndex: 0, delta: 'Hi', partial } as never;
        throw new Error('x');
      }
    })).stream(CONTRACT_REQUEST));
    expect(after.at(-1)).toMatchObject({ type: 'error', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(after.at(-1)).not.toHaveProperty('usageFinal');
  });

  it('a request that cannot be converted ends in one error', async () => {
    const bad = { ...CONTRACT_REQUEST, messages: [{ role: 'tool', toolCallId: null, toolName: null, content: { not: 'text' } }] } as never;
    const events = await drain(createPiAiPort(adapterOptions({ preset: 'openai', baseUrl: 'http://127.0.0.1:1/v1', hasKey: true, fetch: () => Promise.reject(new TypeError('no')), userAgent: 'x' })).stream(bad));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
  });
});

describe('tool calls', () => {
  const tools = new Set(['get_time']);
  it('passes on a well-formed call as a plain copy', () => {
    const args = { zone: 'UTC', nested: [{ a: 1 }] };
    const r = checkCall({ id: 'c1', name: 'get_time', arguments: args }, tools);
    expect(r).toEqual({ call: { id: 'c1', name: 'get_time', arguments: args } });
    expect('call' in r && r.call.arguments).not.toBe(args);
  });
  it.each([
    ['a malformed name', { id: 'c1', name: 'get time<script>', arguments: {} }],
    ['a name that is not text', { id: 'c1', name: { toString: (): string => 'get_time' }, arguments: {} }],
    ['a tool the request did not offer', { id: 'c1', name: 'delete_all', arguments: {} }],
    ['no id', { name: 'get_time', arguments: {} }],
    ['toString as an argument', { id: 'c1', name: 'get_time', arguments: JSON.parse('{"toString": null}') }],
    ['__proto__ as a nested argument', { id: 'c1', name: 'get_time', arguments: JSON.parse('{"a": {"__proto__": {"x": 1}}}') }],
    ['constructor as an argument', { id: 'c1', name: 'get_time', arguments: { constructor: 1 } }],
    ['an array', { id: 'c1', name: 'get_time', arguments: [1] }],
    ['parse errors', { id: 'c1', name: 'get_time', arguments: {}, argumentsError: 'bad' }]
  ])('refuses %s', (_, tc) => {
    const r = checkCall(tc as never, tools);
    expect(r).toMatchObject({ error: { kind: 'invalid-tool-call' } });
  });
});
