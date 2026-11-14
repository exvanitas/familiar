// Browser entry for the headless Chromium check: the code-split adapter plus Familiar's contract, run in the page.
// `injectedFetch` stands in for Tauri's HTTP plugin fetch: a separate function, with globalThis.fetch left alone
// except for a counter, so the run shows which one each SDK called.
import { CONTRACT_REQUEST, modelPortContract, type ContractScenario } from '@familiar/core/testing';
import type { ModelEvent } from '@familiar/core';
import { loaders } from '../loaders.ts';
import { createPiAiModelPort, type PiAiApi } from '../pi-ai-model-port.ts';

const pageFetch = globalThis.fetch.bind(globalThis);
const counts = { injected: 0, global: 0 };
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  counts.global++;
  return pageFetch(input, init);
}) as typeof fetch;
const injectedFetch: typeof fetch = (input, init) => {
  counts.injected++;
  return pageFetch(input, init);
};

interface Target {
  name: string;
  api: PiAiApi;
  wire: string;
  inject: boolean;
}

async function runAll(origin: string, targets: Target[]) {
  const results: { target: string; case: string; ok: boolean; error?: string }[] = [];
  const textEvents: Record<string, ModelEvent[]> = {};
  for (const t of targets) {
    const harness = {
      forScenario: (s: ContractScenario) =>
        createPiAiModelPort({
          api: t.api,
          baseUrl: `${origin}/${t.wire}/${s}`,
          apiKey: 'fake-key',
          load: loaders[t.api],
          userAgent: 'Familiar/0.0.0',
          ...(t.inject ? { fetch: injectedFetch } : {})
        })
    };
    const events: ModelEvent[] = [];
    for await (const e of harness.forScenario('text').stream(CONTRACT_REQUEST)) events.push(e);
    textEvents[t.name] = events;
    for (const c of modelPortContract) {
      try {
        await c.run(harness);
        results.push({ target: t.name, case: c.name, ok: true });
      } catch (error) {
        results.push({ target: t.name, case: c.name, ok: false, error: String(error) });
      }
    }
  }
  return { results, textEvents, counts: { ...counts } };
}

(globalThis as Record<string, unknown>).__familiarSpike = { runAll };
