/* Hostile and malformed endpoint values, over the real SDK paths: a reply always ends in exactly one
   terminal event, usage counts as final only when whole and over, and a refusal a later hop could
   give is never retried. */
import { describe, expect, it } from 'vitest';
import { cappedPort, createCaps, memoryUsageStore, withRetries, type ModelEvent } from '@familiar/core';
import { CONTRACT_REQUEST } from '@familiar/core/testing';
import { guardedFetch } from '../../src/net.ts';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions } from '../../src/model/presets.ts';
import { exeShell } from './exe-shell.ts';

async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const sse = (chunks: string[]): typeof fetch => async () =>
  new Response(new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const oa = (body: string) => `data: ${body}\n\n`;
const oaText = oa(JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }));
const oaFinish = (finish: string) => oa(`{"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":${finish}}]}`);
const oaUsage = (usage: string) => oa(`{"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":${usage}}`);
const DONE = 'data: [DONE]\n\n';
const an = (name: string, body: string) => `event: ${name}\ndata: ${body}\n\n`;
const anStart = (usage = '{"input_tokens":31,"output_tokens":1}') => an('message_start', `{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":${usage}}}`);
const anText = [
  an('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
  an('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}'),
  an('content_block_stop', '{"type":"content_block_stop","index":0}')
];
const anDelta = (stop: string, usage: string) => an('message_delta', `{"type":"message_delta","delta":{"stop_reason":${stop},"stop_sequence":null},"usage":${usage}}`);
const anStop = an('message_stop', '{"type":"message_stop"}');

const over = (preset: 'openai' | 'anthropic', chunks: string[]) =>
  drain(createPiAiPort(adapterOptions({ preset, baseUrl: preset === 'anthropic' ? 'http://127.0.0.1:1' : 'http://127.0.0.1:1/v1', hasKey: true, fetch: sse(chunks), userAgent: 'x' })).stream(CONTRACT_REQUEST));
const terminals = (events: ModelEvent[]) => events.filter(e => e.type === 'done' || e.type === 'error');

describe('hostile terminal fields', () => {
  it.each([
    ['an OpenAI finish_reason of {"toString": null}', 'openai', [oaText, oaFinish('{"toString":null}'), oaUsage('{"prompt_tokens":5,"completion_tokens":1}'), DONE]],
    ['an OpenAI finish_reason that is a number', 'openai', [oaText, oaFinish('7'), DONE]],
    ['OpenAI usage counters that are objects', 'openai', [oaText, oaFinish('"stop"'), oaUsage('{"prompt_tokens":{"toString":null},"completion_tokens":{"valueOf":null}}'), DONE]],
    ['an Anthropic stop_reason of {"toString": null}', 'anthropic', [anStart(), ...anText, anDelta('{"toString":null}', '{"output_tokens":3}'), anStop]],
    ['an Anthropic usage of {"toString": null}', 'anthropic', [anStart('{"toString":null}'), ...anText, anDelta('"end_turn"', '{"toString":null}'), anStop]]
  ] as const)('%s ends in exactly one terminal event, last', async (_, preset, chunks) => {
    const events = await over(preset, [...chunks]);
    expect(terminals(events)).toHaveLength(1);
    expect(events.at(-1)).toBe(terminals(events)[0]);
    expect(JSON.stringify(events)).not.toContain('toString');
  });
});

describe('usage is final only when whole and over', () => {
  const finish = [oaText, oaFinish('"stop"')];
  it.each([
    ['an empty usage object', [...finish, oaUsage('{}'), DONE]],
    ['no completion_tokens', [...finish, oaUsage('{"prompt_tokens":5}'), DONE]],
    ['counts as strings', [...finish, oaUsage('{"prompt_tokens":"5","completion_tokens":"1"}'), DONE]],
    ['a negative count', [...finish, oaUsage('{"prompt_tokens":5,"completion_tokens":-1}'), DONE]],
    ['no usage chunk at all', [...finish, DONE]]
  ])('OpenAI-compatible, %s: unreported', async (_, chunks) => {
    expect((await over('openai', chunks)).at(-1)).toMatchObject({ type: 'done', unreported: true });
  });

  it('OpenAI-compatible, whole counts and a finish_reason: final', async () => {
    const last = (await over('openai', [...finish, oaUsage('{"prompt_tokens":5,"completion_tokens":1}'), DONE])).at(-1);
    expect(last).toMatchObject({ type: 'done', usage: { inputTokens: 5, outputTokens: 1 } });
    expect(last).not.toHaveProperty('unreported');
  });

  it.each([
    ['an empty message_delta usage', [anStart(), ...anText, anDelta('"end_turn"', '{}'), anStop]],
    ['output_tokens as a string', [anStart(), ...anText, anDelta('"end_turn"', '{"output_tokens":"3"}'), anStop]],
    ['no input_tokens at the start', [anStart('{"output_tokens":1}'), ...anText, anDelta('"end_turn"', '{"output_tokens":3}'), anStop]],
    ['no message_stop', [anStart(), ...anText, anDelta('"end_turn"', '{"output_tokens":3}')]]
  ])('Anthropic, %s: never final', async (_, chunks) => {
    const last = (await over('anthropic', chunks)).at(-1)!;
    if (last.type === 'done') expect(last.unreported).toBe(true);
    else expect(last).not.toHaveProperty('usageFinal');
  });

  it('Anthropic, whole counts, a stop reason and message_stop: final', async () => {
    const last = (await over('anthropic', [anStart(), ...anText, anDelta('"end_turn"', '{"output_tokens":3}'), anStop])).at(-1);
    expect(last).toMatchObject({ type: 'done', usage: { inputTokens: 31, outputTokens: 3 } });
    expect(last).not.toHaveProperty('unreported');
  });
});

describe('refusals a later hop could give', () => {
  const via = (refuse: string) =>
    createPiAiPort(adapterOptions({ preset: 'openai', baseUrl: 'http://127.0.0.1:1/v1', hasKey: true, fetch: guardedFetch('a', {}, exeShell({ id: 'a', url: 'http://127.0.0.1:1/v1', key: 'fk-0123456789', refuse })), userAgent: 'x' }));

  it('blocked-address, network and tls are never marked not processed, never retried, and stay spent', async () => {
    for (const kind of ['blocked-address', 'network', 'tls', 'insecure']) {
      const store = memoryUsageStore();
      const caps = createCaps({ maxReplyTokens: 100 }, store, { now: () => 0 });
      let calls = 0;
      const inner = via(kind);
      const counting = { stream: (r: Parameters<typeof inner.stream>[0], s?: AbortSignal) => { calls++; return inner.stream(r, s); } };
      const events = await drain(withRetries(cappedPort(counting, caps, () => ({ persona: 'p', turn: 't', price: undefined })), { sleep: async () => {} }).stream(CONTRACT_REQUEST));
      expect(events.at(-1), kind).toMatchObject({ type: 'error', error: { transport: kind } });
      expect(events.at(-1), kind).not.toHaveProperty('error.notProcessed');
      expect(calls, kind).toBe(1);
      expect(store.all, kind).toHaveLength(1);
      expect(store.all[0]!.tokens, kind).toBeGreaterThan(0);
    }
  });

  it('no-key, not-saved and busy, refused before any network, are not processed', async () => {
    for (const kind of ['no-key', 'not-saved', 'busy']) {
      expect((await drain(via(kind).stream(CONTRACT_REQUEST))).at(-1), kind).toMatchObject({ type: 'error', error: { transport: kind, notProcessed: true } });
    }
  });
});
