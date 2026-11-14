// Probes pi-ai itself, below the adapter, for the facts RESULT.md cites:
// how fast its own stream ends after a stop, what its error text keeps of the HTTP status, how many requests a 401 costs,
// and what a signed Anthropic thinking block looks like before the port flattens it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantMessageEvent, Model, Api, Context } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { startFakeServer, type FakeServer } from '../src/fake-server.ts';
import { loaders } from '../src/loaders.ts';
import type { PiAiApi } from '../src/pi-ai-model-port.ts';

let server: FakeServer;
const facts: Record<string, unknown> = {};
beforeAll(async () => {
  server = await startFakeServer();
});
afterAll(async () => {
  await server.close();
  console.log(`SPIKE_RAW ${JSON.stringify(facts)}`);
});

const wires: [string, PiAiApi, string, boolean][] = [
  ['openai', 'openai-completions', 'openai', true],
  ['anthropic', 'anthropic-messages', 'anthropic', true],
  ['gemini', 'google-generative-ai', 'gemini', false],
  ['gemini-openai', 'openai-completions', 'gemini-openai', true]
];

const context: Context = {
  systemPrompt: 'You are a test persona.',
  messages: [{ role: 'user', content: 'Hi', timestamp: 0 }]
};

function model(api: PiAiApi, baseUrl: string): Model<Api> {
  return {
    id: 'contract-model',
    name: 'contract-model',
    api,
    provider: 'spike',
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 4096
  };
}

async function raw(api: PiAiApi, wire: string, scenario: string, inject: boolean, signal?: AbortSignal) {
  const mod = await loaders[api]();
  return mod.stream(model(api, `${server.url}/${wire}/${scenario}`), normalizeContext(context), {
    apiKey: 'sk-fake',
    signal,
    ...(inject ? { fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, init) } : {})
  });
}

describe('raw pi-ai', () => {
  for (const [name, api, wire, inject] of wires) {
    it(`${name}: its own stream ends promptly after a stop, with reason aborted`, async () => {
      const controller = new AbortController();
      let stoppedAt = 0;
      let last: AssistantMessageEvent | undefined;
      for await (const e of await raw(api, wire, 'slow', inject, controller.signal)) {
        last = e;
        if (e.type === 'text_delta' && !stoppedAt) {
          stoppedAt = performance.now();
          controller.abort();
        }
      }
      const ms = Math.round(performance.now() - stoppedAt);
      facts[`${name}.abortToTerminalMs`] = ms;
      facts[`${name}.abortTerminal`] = last?.type === 'error' ? `error/${last.reason}` : last?.type;
      expect(last?.type).toBe('error');
      expect(ms).toBeLessThan(2000);
    });

    it(`${name}: a refused key costs one request, and the error text is all that is left of the status`, async () => {
      const before = server.requests.length;
      let last: AssistantMessageEvent | undefined;
      for await (const e of await raw(api, wire, 'auth-error', inject)) last = e;
      facts[`${name}.authRequests`] = server.requests.length - before;
      facts[`${name}.authErrorMessage`] = last?.type === 'error' ? last.error.errorMessage : undefined;
      expect(last?.type).toBe('error');
    });
  }

  it('anthropic: a signed thinking block, cache reads and the raw stop reason come through on the final message', async () => {
    const types: string[] = [];
    let final: AssistantMessageEvent | undefined;
    for await (const e of await raw('anthropic-messages', 'anthropic', 'thinking', true)) {
      types.push(e.type);
      final = e;
    }
    expect(final?.type).toBe('done');
    if (final?.type !== 'done') return;
    facts['anthropic.thinking.eventTypes'] = [...new Set(types)];
    facts['anthropic.thinking.content'] = final.message.content;
    facts['anthropic.thinking.usage'] = final.message.usage;
    facts['anthropic.thinking.stop'] = { reason: final.reason, raw: final.message.rawStopReason };
    const thinking = final.message.content.find((c) => c.type === 'thinking');
    expect(thinking && 'thinkingSignature' in thinking && thinking.thinkingSignature).toBe('EqQBCgIYAhIM-recorded-signature');
  });

  it('openai and anthropic: a null request header removes an SDK default header (the x-stainless-* set)', async () => {
    const stainless = ['x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-lang', 'x-stainless-package-version'];
    const headers = Object.fromEntries(stainless.map((h) => [h, null]));
    for (const [api, wire] of [['openai-completions', 'openai'], ['anthropic-messages', 'anthropic']] as const) {
      const before = server.requests.length;
      const mod = await loaders[api]();
      for await (const _ of mod.stream(model(api, `${server.url}/${wire}/text`), normalizeContext(context), {
        apiKey: 'sk-fake',
        headers,
        fetch: (i, init) => fetch(i, init)
      }));
      const sent = Object.keys(server.requests[before]!.headers).filter((h) => h.startsWith('x-stainless'));
      facts[`${wire}.stainlessHeadersLeftAfterNull`] = sent;
      expect(sent.filter((h) => stainless.includes(h))).toEqual([]);
    }
  });

  it('gemini native: a function call gets an id pi-ai made up, since Gemini sends none', async () => {
    let final: AssistantMessageEvent | undefined;
    for await (const e of await raw('google-generative-ai', 'gemini', 'tool-call', false)) final = e;
    if (final?.type !== 'done') throw new Error(JSON.stringify(final));
    const call = final.message.content.find((c) => c.type === 'toolCall');
    facts['gemini.toolCallId'] = call && 'id' in call ? call.id : undefined;
    facts['gemini.toolStop'] = final.reason;
    expect(final.reason).toBe('toolUse');
  });
});
