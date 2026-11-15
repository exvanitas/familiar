/* Prices from pi-ai's pinned catalog, for endpoints that publish none, and what a cap does with them. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCaps, memoryUsageStore } from '@familiar/core';
import { catalogPrices, render } from '../../scripts/catalog-prices.ts';
import { CATALOG_PRICES } from '../../src/model/catalog-prices.ts';
import { CATALOG_LABEL, preset, priceFor } from '../../src/model/presets.ts';

describe('catalog prices', () => {
  it('the table is what the installed pi-ai lists, so it cannot drift', () => {
    // A Windows checkout may give the file CRLF line ends.
    expect(readFileSync(new URL('../../src/model/catalog-prices.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(render(catalogPrices()));
    expect(Object.keys(CATALOG_PRICES.openai).length).toBeGreaterThan(10);
    expect(Object.keys(CATALOG_PRICES.anthropic).length).toBeGreaterThan(5);
    expect(Object.keys(CATALOG_PRICES.gemini).length).toBeGreaterThan(5);
  });

  it('a known model on OpenAI, Anthropic or Gemini gets its catalog price, labelled as such; an unknown one none', () => {
    const id = Object.keys(CATALOG_PRICES.anthropic)[0]!;
    expect(priceFor(preset('anthropic'), undefined, id)).toEqual({ ...CATALOG_PRICES.anthropic[id], source: 'catalog' });
    expect(priceFor(preset('anthropic'), undefined, 'claude-not-a-model')).toBeUndefined();
    expect(priceFor(preset('anthropic'), undefined, 'toString')).toBeUndefined();
    expect(CATALOG_LABEL).toBe("listed price in Familiar's model catalog");
  });

  it("the endpoint's own price wins over the catalog, a typed one over both, and Custom has no catalog", () => {
    const id = Object.keys(CATALOG_PRICES.openai)[0]!;
    const own = { inputPerMTok: 9, outputPerMTok: 9 };
    expect(priceFor(preset('openai'), own, id)).toEqual({ ...own, source: 'endpoint' });
    expect(priceFor(preset('openai'), own, id, { inputPerMTok: 1, outputPerMTok: 2 })).toEqual({ inputPerMTok: 1, outputPerMTok: 2, source: 'typed' });
    expect(priceFor(preset('custom'), undefined, id)).toBeUndefined();
  });

  it('with a catalog price a dollar cap works; an unknown model pauses saying it needs a price; a token cap always works', async () => {
    const request = { model: 'x', system: '', messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };
    const caps = createCaps({ maxReplyTokens: 100, maxDayTokens: 1_000_000, personaDayUsd: { a: 5 } }, memoryUsageStore(), { now: () => 0 });
    const known = Object.entries(CATALOG_PRICES.openai).find(([, p]) => p.cacheReadPerMTok !== undefined && p.cacheWritePerMTok !== undefined)![0];
    expect((await caps.before({ request, persona: 'a', turn: 't', price: priceFor(preset('openai'), undefined, known), caching: true })).go).toBe(true);
    const unknown = await caps.before({ request, persona: 'a', turn: 't', price: priceFor(preset('openai'), undefined, 'gpt-unknown') });
    expect(unknown).toMatchObject({ go: false, pause: 'persona-unpriced' });
    expect(unknown.go === false && unknown.message).toContain("Add the model's price");
    expect((await caps.before({ request, persona: 'tokens-only', turn: 't', price: undefined })).go).toBe(true);
  });
});
