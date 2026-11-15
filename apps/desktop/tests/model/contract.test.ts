/* The model port contract over recorded responses, for every preset, in Node: with a plain injected
   fetch, and over the real guardedFetch with a stand-in exe. The global fetch is a tripwire: the
   adapter must never call it. */
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_REQUEST, modelPortContract, type ContractScenario, type ModelPortHarness } from '@familiar/core/testing';
import type { ModelEvent } from '@familiar/core';
import { guardedFetch } from '../../src/net.ts';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions, PRESETS, type PresetId } from '../../src/model/presets.ts';
import type { Wire } from '../../shell-check/model-recordings.ts';
import { exeShell } from './exe-shell.ts';
import { startModelServer, type ModelServer } from './server.ts';

const realFetch = globalThis.fetch;
let globalCalls = 0;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { globalCalls++; return realFetch(...a); }) as typeof fetch;
const injected: typeof fetch = (input, init) => realFetch(input, init);

const WIRE: Record<PresetId, Wire> = {
  openrouter: 'openai', openai: 'openai', custom: 'openai', ollama: 'openai', lmstudio: 'openai', anthropic: 'anthropic', gemini: 'gemini'
};

let server: ModelServer;
beforeAll(async () => { server = await startModelServer(); });
afterAll(async () => { await server.close(); globalThis.fetch = realFetch; });

function harness(id: PresetId, fetchFor: (base: string) => typeof fetch): ModelPortHarness {
  return {
    forScenario(s: ContractScenario) {
      const base = `${server.url}/${WIRE[id]}/${s}`;
      return createPiAiPort(adapterOptions({ preset: id, baseUrl: base, hasKey: true, fetch: fetchFor(base), userAgent: 'Familiar/test' }));
    }
  };
}

for (const p of PRESETS) {
  describe(`${p.label}, recorded ${WIRE[p.id]} wire, injected fetch`, () => {
    for (const c of modelPortContract) it(c.name, () => c.run(harness(p.id, () => injected)));
  });
}

const KEY = 'fk-node-stand-in-key-0123456789';
for (const id of ['openai', 'anthropic', 'gemini'] as const) {
  describe(`${id} over guardedFetch and a stand-in exe`, () => {
    const viaExe = (base: string) => guardedFetch('addr-1', {}, exeShell({ id: 'addr-1', url: base, key: KEY }));
    for (const c of modelPortContract) it(c.name, () => c.run(harness(id, viaExe)));

    it('the endpoint got the stored key, the page sent only the placeholder, and the echo came back blanked', async () => {
      const base = `${server.url}/${WIRE[id]}/auth-error`;
      const shell = exeShell({ id: 'addr-1', url: base, key: KEY });
      const bodies: string[] = [];
      const watching: typeof fetch = async (input, init) => {
        const r = await guardedFetch('addr-1', {}, shell)(input, init);
        bodies.push(await r.clone().text());
        return r;
      };
      const before = server.seen.length;
      const events = await drain(createPiAiPort(adapterOptions({ preset: id, baseUrl: base, hasKey: true, fetch: watching, userAgent: 'Familiar/test' })).stream(CONTRACT_REQUEST));
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'auth' } });
      expect(server.seen.slice(before).map(s => s.key)).toEqual([KEY]);
      expect(JSON.stringify(shell.sent)).not.toContain(KEY);
      expect(bodies.join()).toContain('[key]');
      expect(bodies.join() + JSON.stringify(events)).not.toContain(KEY);
    });
  });
}

describe('the fetch the adapter uses', () => {
  it('is only ever the injected one', async () => {
    globalCalls = 0;
    for (const id of ['openai', 'anthropic', 'gemini'] as const) await drain(harness(id, () => injected).forScenario('text').stream(CONTRACT_REQUEST));
    expect(globalCalls).toBe(0);
  });

  it('without a stored key, the placeholder is refused as no-key and nothing is sent', async () => {
    const base = `${server.url}/openai/text`;
    const before = server.seen.length;
    const f = guardedFetch('addr-1', {}, exeShell({ id: 'addr-1', url: base }));
    const events = await drain(createPiAiPort(adapterOptions({ preset: 'openai', baseUrl: base, hasKey: true, fetch: f, userAgent: 'Familiar/test' })).stream(CONTRACT_REQUEST));
    expect(events).toEqual([{ type: 'error', error: { kind: 'auth', message: 'No key is saved for this endpoint.', transport: 'no-key', notProcessed: true } }]);
    expect(server.seen.length).toBe(before);
  });

  it('an address that refuses connections is a network error, not processed', async () => {
    // A port that was free a moment ago, so nothing listens there.
    const port = await new Promise<number>(done => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => done(p)); }); });
    const events = await drain(createPiAiPort(adapterOptions({ preset: 'ollama', baseUrl: `http://127.0.0.1:${port}/v1`, hasKey: false, fetch: injected, userAgent: 'Familiar/test' })).stream(CONTRACT_REQUEST));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ kind: 'network', transport: 'ECONNREFUSED', notProcessed: true }) }]);
  });
});

async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
