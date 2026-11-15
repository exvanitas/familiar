/* The model list and the Test button, over recorded list bodies and recorded replies. The list bodies
   follow each endpoint's documented shape: OpenRouter's /api/v1/models (openrouter.ai/docs/api-reference/
   list-available-models), OpenAI's /v1/models, Anthropic's /v1/models, Google's OpenAI-compatible
   /models (ids as models/<id>), and Ollama's and LM Studio's OpenAI-compatible /v1/models. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelEvent, ModelPort } from '@familiar/core';
import { createFakeModel, type FakeReply } from '@familiar/core/testing';
import { PLACEHOLDER } from '../../src/net.ts';
import { listModels, NO_TOOLS_NOTE } from '../../src/model/models.ts';
import { CATALOG_PRICES } from '../../src/model/catalog-prices.ts';
import { CATALOG_LABEL } from '../../src/model/presets.ts';
import { testEndpoint } from '../../src/model/endpoint-test.ts';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions, preset, type PresetId } from '../../src/model/presets.ts';
import { startModelServer, type ModelServer } from './server.ts';

const LISTS: Record<string, unknown> = {
  '/or/models': {
    data: [
      {
        id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4', context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375', request: '0' },
        supported_parameters: ['max_tokens', 'temperature', 'tools', 'tool_choice', 'reasoning']
      },
      { id: 'some/story-model', name: 'Story Model', context_length: 8192, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['max_tokens', 'temperature'] },
      { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' }, supported_parameters: ['tools'] }
    ]
  },
  '/oa/models': { object: 'list', data: [{ id: 'gpt-4.1-mini', object: 'model', created: 1744318173, owned_by: 'system' }] },
  '/an/v1/models': { data: [{ type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' }], has_more: false },
  '/gm/models': { object: 'list', data: [{ id: 'models/gemini-2.5-flash', object: 'model', owned_by: 'google' }] },
  '/ol/models': { object: 'list', data: [{ id: 'llama3.2:latest', object: 'model', created: 1730000000, owned_by: 'library' }] }
};

let server: ModelServer;
beforeAll(async () => {
  server = await startModelServer(path => {
    if (path === '/refused/models') return { status: 401, body: '{"error":{"message":"bad key {{key}}"}}' };
    const list = LISTS[path];
    return list ? { status: 200, body: JSON.stringify(list) } : undefined;
  });
});
afterAll(() => server.close());

const setup = (id: PresetId, base: string, hasKey = true) => ({ preset: id, baseUrl: `${server.url}${base}`, hasKey, fetch: ((i, n) => fetch(i, n)) as typeof fetch, userAgent: 'Familiar/test' });

describe('model list', () => {
  it("shows OpenRouter's prices and tool calling, and says why a model chats with tools off", async () => {
    const r = await listModels(setup('openrouter', '/or'));
    expect(r.ok).toBe(true);
    const [sonnet, auto, story] = r.ok ? r.models : [];
    expect(sonnet).toEqual({
      id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4', tools: 'yes', contextLength: 200000,
      price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, source: 'endpoint' }
    });
    expect(story).toMatchObject({ tools: 'no', note: NO_TOOLS_NOTE, price: { inputPerMTok: 0, outputPerMTok: 0 } });
    // A price that varies is unknown, not free.
    expect(auto!.price).toBeUndefined();
  });

  it('elsewhere price and tools are unknown; a local server is free', async () => {
    const oa = await listModels(setup('openai', '/oa'));
    // OpenAI publishes no prices: a model the catalog knows gets its listed price, labelled.
    expect(oa.ok && oa.models).toEqual([{ id: 'gpt-4.1-mini', name: 'gpt-4.1-mini', tools: 'unknown', price: { ...CATALOG_PRICES.openai['gpt-4.1-mini'], source: 'catalog' }, priceNote: CATALOG_LABEL }]);
    const ol = await listModels(setup('ollama', '/ol', false));
    expect(ol.ok && ol.models[0]).toMatchObject({ id: 'llama3.2:latest', tools: 'unknown', price: { inputPerMTok: 0, outputPerMTok: 0 } });
  });

  it("names Anthropic's models by their display name, and drops Google's models/ prefix", async () => {
    const an = await listModels(setup('anthropic', '/an'));
    expect(an.ok && an.models[0]).toMatchObject({ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' });
    const gm = await listModels(setup('gemini', '/gm'));
    expect(gm.ok && gm.models[0]!.id).toBe('gemini-2.5-flash');
  });

  it('sends the key only as the placeholder, in the header each API reads', async () => {
    await listModels(setup('anthropic', '/an'));
    const an = server.seen.at(-1)!;
    expect(an.path).toBe('/an/v1/models?limit=1000');
    expect(an.headers['x-api-key']).toBe(PLACEHOLDER);
    expect(an.headers['anthropic-version']).toBe('2023-06-01');
    await listModels(setup('openai', '/oa'));
    expect(server.seen.at(-1)!.headers.authorization).toBe(`Bearer ${PLACEHOLDER}`);
    await listModels(setup('ollama', '/ol', false));
    expect(server.seen.at(-1)!.headers.authorization).toBeUndefined();
  });

  it('says plainly what went wrong, without the endpoint\'s words', async () => {
    expect(await listModels(setup('openai', '/oa', false))).toEqual({ ok: false, problem: 'no-key', message: 'No key is saved for this endpoint.' });
    const refused = await listModels(setup('custom', '/refused'));
    expect(refused).toEqual({ ok: false, problem: 'key-refused', message: 'The endpoint refused the key (HTTP 401).' });
    expect(await listModels({ ...setup('ollama', '', false), baseUrl: 'http://127.0.0.1:1/v1' })).toMatchObject({ ok: false, problem: 'unreachable' });
  });
});

describe('Test', () => {
  const real = (id: PresetId, scenario: string) =>
    createPiAiPort(adapterOptions({ ...setup(id, `/${id === 'anthropic' ? 'anthropic' : id === 'gemini' ? 'gemini' : 'openai'}/${scenario}`) }));
  const fake = (replies: FakeReply[]): ModelPort => createFakeModel(replies);

  it('a working endpoint says so', async () => {
    const port = fake([{ toolCalls: [{ id: 'c1', name: 'familiar_test', arguments: {} }] }]);
    expect(await testEndpoint({ preset: preset('openai'), model: 'm', hasKey: true, port })).toEqual({ ok: true, tools: 'yes', message: 'OpenAI answered, and m called the test tool, so it can call tools.' });
  });

  it('a plain answer, or a call to another tool, leaves tool use unproven, never passed', async () => {
    expect(await testEndpoint({ preset: preset('openai'), model: 'm', hasKey: true, port: real('openai', 'text') })).toEqual({ ok: true, tools: 'unproven', message: 'm answered without calling the tool, so tool use is unproven.' });
    const other = fake([{ toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] }]);
    expect(await testEndpoint({ preset: preset('openai'), model: 'm', hasKey: true, port: other })).toMatchObject({ tools: 'unproven' });
    // Over the real adapter: a call to a tool the test didn't offer is refused, and proves nothing.
    expect(await testEndpoint({ preset: preset('openai'), model: 'm', hasKey: true, port: real('openai', 'tool-call') })).toMatchObject({ ok: true, tools: 'unproven' });
  });

  it('no key saved, before any call', async () => {
    let called = false;
    const port: ModelPort = { stream: () => { called = true; return (async function* (): AsyncGenerator<ModelEvent> {})(); } };
    const r = await testEndpoint({ preset: preset('anthropic'), model: 'm', hasKey: false, port });
    expect(r).toMatchObject({ ok: false, problem: 'no-key' });
    expect(called).toBe(false);
  });

  it('key refused, rate limited, endpoint failed, over the recorded replies of each API', async () => {
    for (const id of ['openai', 'anthropic', 'gemini'] as const) {
      expect(await testEndpoint({ preset: preset(id), model: 'm', hasKey: true, port: real(id, 'auth-error') }), id).toMatchObject({ ok: false, problem: 'key-refused' });
      expect(await testEndpoint({ preset: preset(id), model: 'm', hasKey: true, port: real(id, 'rate-limit') }), id).toMatchObject({ ok: false, problem: 'rate-limited' });
      expect(await testEndpoint({ preset: preset(id), model: 'm', hasKey: true, port: real(id, 'server-error') }), id).toMatchObject({ ok: false, problem: 'endpoint-failed' });
    }
  });

  it('address unreachable, and the hint for a local server', async () => {
    const port = createPiAiPort(adapterOptions({ ...setup('ollama', '', false), baseUrl: 'http://127.0.0.1:1/v1' }));
    const r = await testEndpoint({ preset: preset('ollama'), model: 'llama3.2', hasKey: false, port });
    expect(r).toMatchObject({ ok: false, problem: 'unreachable' });
    expect(r.message).toContain('Is it running?');
  });

  it('a model the endpoint lacks: a 404, or a refusal and a list without it', async () => {
    const notFound = fake([{ error: { kind: 'not-found', message: 'x' } }, { error: { kind: 'not-found', message: 'x' } }]);
    expect(await testEndpoint({ preset: preset('openai'), model: 'gpt-9', hasKey: true, port: notFound })).toMatchObject({ ok: false, problem: 'model-not-found', message: 'OpenAI has no model called gpt-9. Pick one from its list.' });
    const refused = fake([{ error: { kind: 'bad-request', message: 'x' } }, { error: { kind: 'bad-request', message: 'x' } }]);
    const list = async () => ({ ok: true as const, models: [{ id: 'other', name: 'other', tools: 'unknown' as const }] });
    expect(await testEndpoint({ preset: preset('openrouter'), model: 'nope', hasKey: true, port: refused, list })).toMatchObject({ problem: 'model-not-found' });
  });

  it("a model that can't call tools still chats, and the result says so", async () => {
    const port = createFakeModel((req) => (req.tools.length ? { error: { kind: 'bad-request', message: 'x' } } : { text: 'ok' }));
    const r = await testEndpoint({ preset: preset('ollama'), model: 'tiny', hasKey: false, port });
    expect(r).toEqual({ ok: true, tools: 'no', message: "tiny answered, but it can't call tools, so it chats with tools off." });
    // OpenRouter answers 404 when no provider of the model takes tools.
    const or = createFakeModel((req) => (req.tools.length ? { error: { kind: 'not-found', message: 'x' } } : { text: 'ok' }));
    expect(await testEndpoint({ preset: preset('openrouter'), model: 'some/model', hasKey: true, port: or })).toMatchObject({ ok: true, tools: 'no' });
  });

  it('never repeats a key or an endpoint\'s own words', async () => {
    for (const s of ['auth-error', 'rate-limit', 'overloaded', 'server-error', 'filtered']) {
      const r = await testEndpoint({ preset: preset('openai'), model: 'm', hasKey: true, port: real('openai', s) });
      expect(JSON.stringify(r), s).not.toMatch(/endpoint-words|familiar-stored-key/);
    }
  });
});
