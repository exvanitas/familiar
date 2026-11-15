import { describe, expect, it } from 'vitest';
import { costOf, createCaps, estimateInputTokens, localDay, memoryUsageStore } from '../src/index.ts';
import type { ModelRequest, Price } from '../src/index.ts';

const request: ModelRequest = { model: 'm', system: 'You are kind.', messages: [{ role: 'user', content: 'Hello there' }], tools: [] };
const price: Price = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
const at = (iso: string) => ({ now: () => new Date(iso).getTime() });
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('cost', () => {
  it('prices plain input, cache reads, cache writes and output each at their own rate', () => {
    const c = costOf({ inputTokens: 1_300_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 100_000 }, price);
    // 200k plain at $3, 1M read at $0.30, 100k written at $3.75, 100k out at $15
    expect(c.usd).toBeCloseTo(0.6 + 0.3 + 0.375 + 1.5, 10);
  });
  it('is unknown, never $0, when the model has no price', () => {
    expect(costOf({ inputTokens: 10, outputTokens: 10 }, undefined)).toEqual({ usd: 'unknown' });
  });
  it('is unknown when cache tokens were used and the cache price is missing', () => {
    expect(costOf({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 }, { inputPerMTok: 1, outputPerMTok: 1 })).toEqual({ usd: 'unknown' });
  });
  it('a free local model is priced at $0, which is known', () => {
    expect(costOf({ inputTokens: 10, outputTokens: 10 }, { inputPerMTok: 0, outputPerMTok: 0 })).toEqual({ usd: 0 });
  });
});

describe('caps', () => {
  it('caps each reply at maxReplyTokens, and keeps a smaller request', async () => {
    const caps = createCaps({ maxReplyTokens: 500 }, memoryUsageStore(), at('2026-11-15T10:00:00Z'));
    expect(await caps.before({ request, persona: 'p', turnTokens: 0, price })).toEqual({ go: true, maxOutputTokens: 500 });
    const small = await caps.before({ request: { ...request, maxOutputTokens: 80 }, persona: 'p', turnTokens: 0, price });
    expect(small).toEqual({ go: true, maxOutputTokens: 80 });
  });

  it('pauses a turn when one more reply could pass its token cap', async () => {
    const caps = createCaps({ maxReplyTokens: 100, maxTurnTokens: 1000 }, memoryUsageStore(), at('2026-11-15T10:00:00Z'));
    const input = estimateInputTokens(request);
    expect((await caps.before({ request, persona: 'p', turnTokens: 1000 - 100 - input, price })).go).toBe(true);
    const r = await caps.before({ request, persona: 'p', turnTokens: 1000 - 100 - input + 1, price });
    expect(r).toMatchObject({ go: false, pause: 'turn-tokens' });
  });

  it('counts tokens per day across personas, priced or not, and a new day starts again', async () => {
    const store = memoryUsageStore();
    let now = new Date('2026-11-15T10:00:00Z').getTime();
    const caps = createCaps({ maxReplyTokens: 100, maxDayTokens: 5000 }, store, { now: () => now }, day);
    await caps.after({ persona: 'a', model: 'm', usage: { inputTokens: 3000, outputTokens: 500 }, price });
    await caps.after({ persona: 'b', model: 'local', usage: { inputTokens: 1300, outputTokens: 100 }, price: undefined });
    const r = await caps.before({ request, persona: 'a', turnTokens: 0, price });
    expect(r).toMatchObject({ go: false, pause: 'day-tokens' });
    now = new Date('2026-11-16T10:00:00Z').getTime();
    expect((await caps.before({ request, persona: 'a', turnTokens: 0, price })).go).toBe(true);
  });

  it("checks a persona's daily cap against today's spend plus the reply's longest cost, and pauses", async () => {
    const store = memoryUsageStore();
    const caps = createCaps({ maxReplyTokens: 1000, personaDayUsd: { a: 0.05 } }, store, at('2026-11-15T10:00:00Z'), day);
    // The longest reply here costs about 1000 * $15 / 1M = $0.015, plus a little input.
    expect((await caps.before({ request, persona: 'a', turnTokens: 0, price })).go).toBe(true);
    await caps.after({ persona: 'a', model: 'm', usage: { inputTokens: 1000, outputTokens: 2500 }, price }); // $0.0405
    const r = await caps.before({ request, persona: 'a', turnTokens: 0, price });
    expect(r).toMatchObject({ go: false, pause: 'persona-day-usd' });
    expect(r.go === false && r.message).toContain('$0.0405');
    // Another persona's spend is its own.
    expect((await caps.before({ request, persona: 'b', turnTokens: 0, price })).go).toBe(true);
  });

  it("pauses a capped persona when the model's price isn't known, rather than count it as free", async () => {
    const caps = createCaps({ maxReplyTokens: 100, personaDayUsd: { a: 1 } }, memoryUsageStore(), at('2026-11-15T10:00:00Z'));
    const r = await caps.before({ request, persona: 'a', turnTokens: 0, price: undefined });
    expect(r).toMatchObject({ go: false, pause: 'persona-unpriced' });
    expect((await caps.before({ request, persona: 'uncapped', turnTokens: 0, price: undefined })).go).toBe(true);
  });

  it('records each call with its day, tokens and cost', async () => {
    const store = memoryUsageStore();
    const caps = createCaps({ maxReplyTokens: 100 }, store, at('2026-11-15T23:30:00Z'), day);
    const cost = await caps.after({ persona: 'a', model: 'm', usage: { inputTokens: 10, outputTokens: 5 }, price: undefined });
    expect(cost).toEqual({ usd: 'unknown' });
    expect(store.records).toEqual([{ at: new Date('2026-11-15T23:30:00Z').getTime(), day: '2026-11-15', persona: 'a', model: 'm', tokens: 15, cost }]);
  });

  it('localDay is the local calendar date', () => {
    const d = new Date(2026, 0, 2, 0, 30);
    expect(localDay(d.getTime())).toBe('2026-01-02');
  });
});
