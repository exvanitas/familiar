/* What each preset puts on the wire: the key only as the placeholder and only in its one header, its
   own compatibility options, and nothing that names the PC. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_REQUEST } from '@familiar/core/testing';
import { PLACEHOLDER } from '../../src/net.ts';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions, NO_KEY, preset, PRESETS, priceFor, type PresetId } from '../../src/model/presets.ts';
import { startModelServer, type ModelServer, type Seen } from './server.ts';

let server: ModelServer;
beforeAll(async () => { server = await startModelServer(); });
afterAll(() => server.close());

const wire = (id: PresetId) => (id === 'anthropic' ? 'anthropic' : id === 'gemini' ? 'gemini' : 'openai');

async function sent(id: PresetId, opts: { hasKey?: boolean; thinking?: 'low' } = {}): Promise<Seen & { json: Record<string, unknown> }> {
  const before = server.seen.length;
  const port = createPiAiPort(adapterOptions({ preset: id, baseUrl: `${server.url}/${wire(id)}/text/`, hasKey: opts.hasKey ?? true, fetch: (i, n) => fetch(i, n), userAgent: 'Familiar/test' }));
  for await (const _ of port.stream({ ...CONTRACT_REQUEST, ...(opts.thinking ? { thinking: opts.thinking, maxOutputTokens: 8000 } : {}) })) void _;
  const s = server.seen.slice(before);
  expect(s).toHaveLength(1);
  return { ...s[0]!, json: JSON.parse(s[0]!.body) as Record<string, unknown> };
}

describe('presets', () => {
  it('every preset has a base URL but Custom, and the local ones need no key', () => {
    for (const p of PRESETS) expect(!!p.baseUrl, p.id).toBe(p.id !== 'custom');
    expect(PRESETS.filter(p => p.key === 'none').map(p => p.id)).toEqual(['ollama', 'lmstudio']);
    expect(preset('ollama').baseUrl).toBe('http://localhost:11434/v1');
    expect(preset('lmstudio').baseUrl).toBe('http://localhost:1234/v1');
    expect(preset('gemini').baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  for (const p of PRESETS) {
    it(`${p.label}: the key goes only as the placeholder, in one header, and nothing names the PC`, async () => {
      const s = await sent(p.id);
      const holding = Object.entries(s.headers).filter(([, v]) => v.includes(PLACEHOLDER)).map(([k]) => k);
      if (p.key === 'none') {
        expect(holding).toEqual([]);
        expect(s.key).toBe(NO_KEY);
      } else {
        expect(holding).toEqual(p.api === 'anthropic-messages' ? ['x-api-key'] : ['authorization']);
      }
      expect(s.path + s.body).not.toContain(PLACEHOLDER);
      expect(Object.keys(s.headers).filter(h => /^x-stainless-(os|arch|runtime|lang|package)/.test(h))).toEqual([]);
      expect(s.headers['user-agent']).toBe('Familiar/test');
    });
  }

  it('Custom sends the placeholder only when a key is saved', async () => {
    expect((await sent('custom', { hasKey: true })).key).toBe(PLACEHOLDER);
    expect((await sent('custom', { hasKey: false })).key).toBe(NO_KEY);
  });

  it('OpenAI gets store: false; the other OpenAI-compatible servers get no store field and the older max_tokens', async () => {
    expect((await sent('openai')).json.store).toBe(false);
    for (const id of ['gemini', 'ollama', 'lmstudio', 'custom', 'openrouter'] as const) {
      const j = (await sent(id)).json;
      expect('store' in j, id).toBe(false);
    }
    const local = (await sent('ollama')).json;
    expect(JSON.stringify(local.messages)).not.toContain('"developer"');
  });

  it('Anthropic marks the prompt for caching', async () => {
    expect((await sent('anthropic')).body).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('thinking is asked for only when the request asks', async () => {
    expect((await sent('anthropic')).json.thinking).toBeUndefined();
    expect((await sent('anthropic', { thinking: 'low' })).json.thinking).toBeDefined();
    expect((await sent('openai', { thinking: 'low' })).json.reasoning_effort).toBe('low');
  });

  it("a local server's price is a known $0; elsewhere it's what the list said, or unknown", () => {
    expect(priceFor(preset('ollama'), undefined)).toEqual({ inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, source: 'local' });
    expect(priceFor(preset('openai'), undefined)).toBeUndefined();
  });
});
