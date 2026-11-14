// Runs Familiar's model port contract against PiAiModelPort for each wire format, over the local fake server.
// Also records every socket the process opens and every global fetch call, to show which fetch each SDK used
// and that nothing but the fake endpoint is reached.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_REQUEST, modelPortContract, type ContractScenario, type ModelPortHarness } from '@familiar/core/testing';
import type { ModelEvent } from '@familiar/core';
import { startFakeServer, type FakeServer } from '../src/fake-server.ts';
import type { PiAiApi } from '../src/pi-ai-model-port.ts';

// ---- tripwires, set before pi-ai is imported ----
const sockets: string[] = [];
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // net.connect() passes its normalized [options, callback] pair as one array argument.
  const [first, second] = (Array.isArray(args[0]) ? args[0] : args) as [unknown, unknown];
  const where =
    typeof first === 'object' && first !== null
      ? `${(first as net.TcpNetConnectOpts).host ?? 'localhost'}:${(first as net.TcpNetConnectOpts).port ?? (first as net.IpcNetConnectOpts).path}`
      : `${String(second ?? 'localhost')}:${String(first)}`;
  sockets.push(where);
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const realFetch = globalThis.fetch;
const globalFetchCalls: string[] = [];
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  globalFetchCalls.push(String(input instanceof Request ? input.url : input));
  return realFetch(input, init);
}) as typeof fetch;

/** Stands in for Tauri's HTTP plugin fetch: a separate function, not globalThis.fetch. */
const injectedCalls: string[] = [];
const injectedFetch: typeof fetch = (input, init) => {
  injectedCalls.push(String(input instanceof Request ? input.url : input));
  return realFetch(input, init);
};

/**
 * Shaped like @tauri-apps/plugin-http 2.9.0's fetch (dist-js/index.js): the body is a fresh pull-based ReadableStream
 * wrapped in a new Response, and a stop errors the body and rejects with a plain Error('Request cancelled'),
 * not a DOMException AbortError. Checks the SDKs cope with that shape.
 */
const tauriShapedFetch: typeof fetch = async (input, init) => {
  injectedCalls.push(String(input instanceof Request ? input.url : input));
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw new Error('Request cancelled');
  const inner = new AbortController();
  signal?.addEventListener('abort', () => inner.abort());
  let real: Response;
  try {
    real = await realFetch(input, { ...init, signal: inner.signal });
  } catch {
    throw new Error('Request cancelled');
  }
  const reader = real.body?.getReader();
  const body = reader
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error('Request cancelled');
            void reader.cancel().catch(() => {});
          });
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (e) {
            controller.error(e);
          }
        },
        cancel: () => reader.cancel()
      })
    : null;
  const res = new Response(body, { status: real.status, statusText: real.statusText, headers: real.headers });
  Object.defineProperty(res, 'url', { value: real.url });
  return res;
};

interface Target {
  readonly name: string;
  readonly api: PiAiApi;
  readonly wire: string;
  readonly inject: boolean;
  readonly fetch?: typeof fetch;
}

const targets: Target[] = [
  { name: 'OpenAI-compatible chat completions', api: 'openai-completions', wire: 'openai', inject: true },
  { name: 'Anthropic messages', api: 'anthropic-messages', wire: 'anthropic', inject: true },
  { name: 'Gemini native (google-generative-ai)', api: 'google-generative-ai', wire: 'gemini', inject: false },
  { name: 'Gemini through its OpenAI-compatible endpoint', api: 'openai-completions', wire: 'gemini-openai', inject: true }
];
const tauriShapedTargets: Target[] = [
  { name: 'OpenAI-compatible, Tauri-shaped fetch', api: 'openai-completions', wire: 'openai', inject: true, fetch: tauriShapedFetch },
  { name: 'Anthropic, Tauri-shaped fetch', api: 'anthropic-messages', wire: 'anthropic', inject: true, fetch: tauriShapedFetch },
  { name: 'Gemini OpenAI-compatible, Tauri-shaped fetch', api: 'openai-completions', wire: 'gemini-openai', inject: true, fetch: tauriShapedFetch }
];

let server: FakeServer;
let socketsAfterImport = 0;
let adapter: typeof import('../src/pi-ai-model-port.ts');
let loaders: typeof import('../src/loaders.ts').loaders;

beforeAll(async () => {
  server = await startFakeServer();
  const before = sockets.length;
  adapter = await import('../src/pi-ai-model-port.ts');
  loaders = (await import('../src/loaders.ts')).loaders;
  // Load every API module (and with it each SDK) before any call.
  await Promise.all(Object.values(loaders).map((load) => load()));
  socketsAfterImport = sockets.length - before;
});

afterAll(async () => {
  await server.close();
  const firsts = new Map<string, (typeof server.requests)[number]>();
  for (const r of server.requests) {
    const wire = r.path.split('/')[1]!;
    if (!firsts.has(wire)) firsts.set(wire, r);
  }
  const report = {
    socketsOpenedOnImport: socketsAfterImport,
    socketDestinations: [...new Set(sockets)],
    globalFetchCalls: globalFetchCalls.map((u) => u.replace(server.url, '<fake>')),
    injectedFetchCalls: injectedCalls.length,
    requestsSeenByFakeServer: server.requests.length,
    firstRequestPerWire: Object.fromEntries([...firsts].map(([w, r]) => [w, { method: r.method, path: r.path, headers: r.headers, body: r.body }]))
  };
  console.log(`SPIKE_REPORT ${JSON.stringify(report)}`);
});

function harness(target: Target): ModelPortHarness {
  return {
    forScenario(scenario: ContractScenario) {
      return adapter.createPiAiModelPort({
        api: target.api,
        baseUrl: `${server.url}/${target.wire}/${scenario}`,
        apiKey: 'fake-key',
        load: loaders[target.api],
        userAgent: 'Familiar/0.0.0',
        ...(target.inject ? { fetch: target.fetch ?? injectedFetch } : {})
      });
    }
  };
}

for (const target of [...targets, ...tauriShapedTargets]) {
  describe(target.name, () => {
    for (const c of modelPortContract) {
      it(c.name, () => c.run(harness(target)));
    }
  });
}

describe('fetch injection', () => {
  it('the OpenAI and Anthropic paths call only the injected fetch, never globalThis.fetch', async () => {
    const before = { injected: injectedCalls.length, global: globalFetchCalls.length };
    for (const t of targets.filter((t) => t.inject)) {
      await drain(harness(t).forScenario('text').stream(CONTRACT_REQUEST));
    }
    expect(injectedCalls.length - before.injected).toBe(3);
    expect(globalFetchCalls.length - before.global).toBe(0);
  });

  it('the Gemini native path ignores injection: it uses globalThis.fetch', async () => {
    const before = globalFetchCalls.length;
    await drain(harness(targets[2]!).forScenario('text').stream(CONTRACT_REQUEST));
    expect(globalFetchCalls.length - before).toBe(1);
  });

  it('the Gemini native path refuses an injected fetch outright', async () => {
    const port = adapter.createPiAiModelPort({
      api: 'google-generative-ai',
      baseUrl: `${server.url}/gemini/text`,
      apiKey: 'fake',
      load: loaders['google-generative-ai'],
      fetch: injectedFetch
    });
    const events = await drain(port.stream(CONTRACT_REQUEST));
    expect(events).toEqual([{ type: 'error', error: { kind: 'unknown', message: 'The model call failed.' } }]);
  });
});

describe('no traffic but the endpoint', () => {
  it('importing pi-ai and loading all three API modules opens no socket', () => {
    expect(socketsAfterImport).toBe(0);
  });
  it('every socket opened went to the fake server', () => {
    const host = new URL(server.url).host;
    expect([...new Set(sockets)]).toEqual([host]);
  });
});

async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
