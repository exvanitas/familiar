import { describe, expect, it } from 'vitest';
import { cappedPort, costOf, createCaps, inputBound, localDay, memoryUsageStore, wholeUsage, withRetries, worstCost } from '../src/index.ts';
import type { CallInfo, Caps, ModelError, ModelEvent, ModelRequest, Price, Usage } from '../src/index.ts';
import { createFakeModel } from '../src/testing/index.ts';
import { durableUsageStore } from './journal/durable-ledger.ts';

// Every ledger test runs on the memory store and on the journal's store (a Harness on a strict fake
// IndexedDB), whose updates are commits. ledger.test.ts adds restarts.
type MakeStore = (pause?: () => Promise<void>) => ReturnType<typeof memoryUsageStore>;
const STORES: readonly { name: string; make: MakeStore; seeds: number }[] = [
  { name: 'memory store', make: (pause) => memoryUsageStore(pause), seeds: 200 },
  { name: "journal's store", make: (pause) => durableUsageStore(pause), seeds: 200 }
];

const request: ModelRequest = { model: 'm', system: 'You are kind.', messages: [{ role: 'user', content: 'Hello there' }], tools: [] };
const price: Price = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const at = (iso: string) => ({ now: () => new Date(iso).getTime() });
const call = (o: Partial<CallInfo> = {}): CallInfo => ({ request, persona: 'p', turn: 't1', price, ...o });
type Terminal = Extract<ModelEvent, { type: 'done' | 'error' }>;
const done = (usage: Usage, extra: object = {}): Terminal => ({ type: 'done', stopReason: 'end', usage, ...extra });
const failed = (error: ModelError, extra: object = {}): Terminal => ({ type: 'error', error, ...extra });

async function go(caps: Caps, c: CallInfo) {
  const r = await caps.before(c);
  if (!r.go) throw new Error(`paused: ${r.message}`);
  return r;
}

describe('cost', () => {
  it('prices plain input, cache reads, cache writes and output each at their own rate', () => {
    const c = costOf({ inputTokens: 1_300_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 100_000 }, price);
    expect(c.usd).toBeCloseTo(0.6 + 0.3 + 0.375 + 1.5, 10);
  });
  it('uses the tier for a large input', () => {
    const tiered: Price = { inputPerMTok: 2, outputPerMTok: 12, tiers: [{ inputTokensAbove: 200_000, inputPerMTok: 4, outputPerMTok: 18 }] };
    expect(costOf({ inputTokens: 100_000, outputTokens: 0 }, tiered).usd).toBeCloseTo(0.2, 10);
    expect(costOf({ inputTokens: 300_000, outputTokens: 0 }, tiered).usd).toBeCloseTo(1.2, 10);
  });
  it('is unknown, never $0, without a price, or with cache tokens and no cache price', () => {
    expect(costOf({ inputTokens: 10, outputTokens: 10 }, undefined)).toEqual({ usd: 'unknown' });
    expect(costOf({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 }, { inputPerMTok: 1, outputPerMTok: 1 })).toEqual({ usd: 'unknown' });
  });
  it('the worst case takes the highest rate that could apply: a cache write over input, and the top tier', () => {
    expect(worstCost(1_000_000, 0, price, false).usd).toBe(3);
    expect(worstCost(1_000_000, 0, price, true).usd).toBe(3.75);
    const tiered: Price = { inputPerMTok: 2, outputPerMTok: 12, tiers: [{ inputTokensAbove: 200_000, inputPerMTok: 4, outputPerMTok: 18 }] };
    expect(worstCost(1_000_000, 1_000_000, tiered, false).usd).toBe(22);
    // With caching, a cache rate that could apply but isn't known makes it unknown.
    expect(worstCost(10, 10, { inputPerMTok: 1, outputPerMTok: 1 }, true)).toEqual({ usd: 'unknown' });
  });
});

describe('the input bound', () => {
  const tokensAtMost = (s: string) => new TextEncoder().encode(s).length;
  it('holds for CJK and emoji, where a third of the characters falls far short', () => {
    for (const text of ['你好，世界。今天天气很好。'.repeat(50), '🙂🎉👍🏽🧑‍🚀'.repeat(50), 'mixed 混合 🙂 text'.repeat(40)]) {
      const r: ModelRequest = { model: 'm', system: '', messages: [{ role: 'user', content: text }], tools: [] };
      // A byte-level tokenizer gives at most one token per byte.
      expect(inputBound(r)).toBeGreaterThanOrEqual(tokensAtMost(text));
      expect(Math.ceil(text.length / 3)).toBeLessThan(tokensAtMost(text));
    }
  });

  it("is tightened by the last final input count for the same conversation's prefix, plus the bytes added since", async () => {
    const caps = createCaps({ maxReplyTokens: 100 }, memoryUsageStore(), at('2026-11-15T10:00:00Z'), { dayOf: day });
    const big: ModelRequest = { ...request, messages: [{ role: 'user', content: 'x'.repeat(4000) }] };
    const first = await go(caps, call({ request: big, conversation: 'c1' }));
    expect(first.inputBound).toBe(inputBound(big));
    await caps.settle(first.reservation, done({ inputTokens: 1010, outputTokens: 20 }));
    const next: ModelRequest = { ...big, messages: [...big.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }] };
    const second = await go(caps, call({ request: next, conversation: 'c1' }));
    expect(second.inputBound).toBeLessThan(inputBound(next));
    expect(second.inputBound).toBe(1010 + inputBound(next) - inputBound(big));
    // A changed prefix gets no such help.
    const edited: ModelRequest = { ...next, messages: [{ role: 'user', content: 'y'.repeat(4000) }, ...next.messages.slice(1)] };
    expect((await go(caps, call({ request: edited, conversation: 'c1' }))).inputBound).toBe(inputBound(edited));
  });
});

describe.each(STORES)('the ledger, $name', ({ make }) => {
  it('caps each reply at maxReplyTokens, and keeps a smaller request', async () => {
    const caps = createCaps({ maxReplyTokens: 500 }, make(), at('2026-11-15T10:00:00Z'));
    expect((await go(caps, call())).maxOutputTokens).toBe(500);
    expect((await go(caps, call({ request: { ...request, maxOutputTokens: 80 } }))).maxOutputTokens).toBe(80);
  });

  it('two calls that overlap cannot both spend the same remainder', async () => {
    const cap = inputBound(request) + 100;
    const caps = createCaps({ maxReplyTokens: 100, maxDayTokens: cap + 50 }, make(() => new Promise((r) => setTimeout(r, 1))), at('2026-11-15T10:00:00Z'));
    const [a, b] = await Promise.all([caps.before(call()), caps.before(call())]);
    expect([a.go, b.go].sort()).toEqual([false, true]);
  });

  it('a turn that runs past midnight keeps its cap; only the daily caps start again', async () => {
    let now = new Date('2026-11-15T23:59:00Z').getTime();
    const worst = inputBound(request) + 100;
    const caps = createCaps({ maxReplyTokens: 100, maxTurnTokens: worst * 2, maxDayTokens: worst * 2 }, make(), { now: () => now }, { dayOf: day });
    const first = await go(caps, call());
    await caps.settle(first.reservation, done({ inputTokens: worst - 100, outputTokens: 100 }));
    await go(caps, call());
    now = new Date('2026-11-16T00:01:00Z').getTime();
    expect(await caps.before(call())).toMatchObject({ go: false, pause: 'turn-tokens' });
    expect((await caps.before(call({ turn: 'next' }))).go).toBe(true);
  });

  it('a remembered input count holds only for the same endpoint and model, thinking and prompt', async () => {
    const caps = createCaps({ maxReplyTokens: 100 }, make(), at('2026-11-15T10:00:00Z'));
    const big: ModelRequest = { ...request, messages: [{ role: 'user', content: 'x'.repeat(4000) }] };
    const first = await go(caps, call({ request: big, conversation: 'c', endpoint: 'openai' }));
    await caps.settle(first.reservation, done({ inputTokens: 1010, outputTokens: 20 }));
    expect((await go(caps, call({ request: big, conversation: 'c', endpoint: 'openai' }))).inputBound).toBe(1010);
    for (const [what, c] of [
      ['another model', call({ request: { ...big, model: 'other' }, conversation: 'c', endpoint: 'openai' })],
      ['another endpoint', call({ request: big, conversation: 'c', endpoint: 'anthropic' })],
      ['thinking on', call({ request: { ...big, thinking: 'low' }, conversation: 'c', endpoint: 'openai' })],
      ['another system prompt', call({ request: { ...big, system: 'Be brief.' }, conversation: 'c', endpoint: 'openai' })]
    ] as const) {
      expect((await go(caps, c)).inputBound, what).toBe(inputBound(c.request));
    }
  });

  it('a turn and a day count open reservations, and a new day starts again', async () => {
    let now = new Date('2026-11-15T10:00:00Z').getTime();
    const worst = inputBound(request) + 100;
    const caps = createCaps({ maxReplyTokens: 100, maxTurnTokens: worst * 2, maxDayTokens: worst * 3 }, make(), { now: () => now }, { dayOf: day });
    await go(caps, call());
    await go(caps, call());
    expect(await caps.before(call())).toMatchObject({ go: false, pause: 'turn-tokens' });
    await go(caps, call({ turn: 't2' }));
    expect(await caps.before(call({ turn: 't3' }))).toMatchObject({ go: false, pause: 'day-tokens' });
    now = new Date('2026-11-16T10:00:00Z').getTime();
    expect((await caps.before(call({ turn: 't4' }))).go).toBe(true);
  });

  it("a persona's dollar cap counts today's spend plus open reservations plus the call's worst cost", async () => {
    const caps = createCaps({ maxReplyTokens: 1000, personaDayUsd: { a: 0.04 } }, make(), at('2026-11-15T10:00:00Z'));
    const first = await go(caps, call({ persona: 'a' }));
    expect(first.reserved.usd).toBeCloseTo(worstCost(first.inputBound, 1000, price, false).usd as number, 12);
    await go(caps, call({ persona: 'a' }));
    const r = await caps.before(call({ persona: 'a' }));
    expect(r).toMatchObject({ go: false, pause: 'persona-day-usd' });
    expect((await caps.before(call({ persona: 'b' }))).go).toBe(true);
  });

  it('pauses a capped persona when any rate that could apply is unknown, and a token cap still works', async () => {
    const caps = createCaps({ maxReplyTokens: 100, maxDayTokens: 100_000, personaDayUsd: { a: 1 } }, make(), at('2026-11-15T10:00:00Z'));
    expect(await caps.before(call({ persona: 'a', price: undefined }))).toMatchObject({ go: false, pause: 'persona-unpriced' });
    expect(await caps.before(call({ persona: 'a', price: { inputPerMTok: 1, outputPerMTok: 1 }, caching: true }))).toMatchObject({ go: false, pause: 'persona-unpriced' });
    expect((await caps.before(call({ persona: 'uncapped', price: undefined }))).go).toBe(true);
  });

  describe('settling', () => {
    const fresh = () => {
      const store = make();
      return { store, caps: createCaps({ maxReplyTokens: 100 }, store, at('2026-11-15T10:00:00Z')) };
    };
    it('drops to the actual usage when the endpoint reported its final count', async () => {
      const { store, caps } = fresh();
      const r = await go(caps, call());
      await caps.settle(r.reservation, done({ inputTokens: 10, outputTokens: 5 }));
      expect(store.all.map((x) => x.tokens)).toEqual([15]);
      expect(store.reservations).toEqual([]);
    });
    it('usage the endpoint never reported is unknown, never zero: the reservation stays spent', async () => {
      const { store, caps } = fresh();
      const r = await go(caps, call());
      await caps.settle(r.reservation, done({ inputTokens: 0, outputTokens: 0 }, { unreported: true }));
      expect(store.all.map((x) => x.tokens)).toEqual([r.reserved.tokens]);
    });
    it('a stop, an error after sending, or a stream that ended early stays spent as reserved', async () => {
      for (const last of [failed({ kind: 'aborted', message: 'Stopped.' }), failed({ kind: 'server', message: 'x' }), failed({ kind: 'network', message: 'x' }, { usage: { inputTokens: 1, outputTokens: 1 } }), undefined]) {
        const { store, caps } = fresh();
        const r = await go(caps, call());
        await caps.settle(r.reservation, last);
        expect(store.all[0]!.tokens).toBe(r.reserved.tokens);
        expect(store.all[0]!.cost.usd).toBe(r.reserved.usd);
      }
    });
    it('partial usage never settles below what was reported', async () => {
      const { store, caps } = fresh();
      const r = await go(caps, call());
      const huge = { inputTokens: r.reserved.tokens * 2, outputTokens: 0 };
      await caps.settle(r.reservation, failed({ kind: 'network', message: 'x' }, { usage: huge }));
      expect(store.all[0]!.tokens).toBe(huge.inputTokens);
    });
    it('an empty, partial or malformed usage object is no count: the reservation stays spent', async () => {
      for (const usage of [{}, { inputTokens: 10 }, { inputTokens: '10', outputTokens: '2' }, { inputTokens: 10, outputTokens: -1 }, { inputTokens: NaN, outputTokens: 1 }]) {
        const { store, caps } = fresh();
        const r = await go(caps, call());
        await caps.settle(r.reservation, done(usage as unknown as Usage));
        expect(store.all.map((x) => x.tokens), JSON.stringify(usage)).toEqual([r.reserved.tokens]);
      }
      const { store, caps } = fresh();
      const r = await go(caps, call());
      await caps.settle(r.reservation, failed({ kind: 'filtered', message: 'x' }, { usage: {}, usageFinal: true }));
      expect(store.all.map((x) => x.tokens)).toEqual([r.reserved.tokens]);
    });
    it('releases only when the endpoint said it did not take the request', async () => {
      const { store, caps } = fresh();
      const r = await go(caps, call());
      expect(await caps.settle(r.reservation, failed({ kind: 'rate-limit', message: 'x', notProcessed: true }))).toEqual({ usd: 0 });
      expect(store.all).toEqual([]);
      expect(store.reservations).toEqual([]);
    });
    it('final usage on an error (a filter, a bad tool call) settles to it', async () => {
      const { store, caps } = fresh();
      const r = await go(caps, call());
      await caps.settle(r.reservation, failed({ kind: 'filtered', message: 'x' }, { usage: { inputTokens: 30, outputTokens: 2 }, usageFinal: true }));
      expect(store.all[0]!.tokens).toBe(32);
    });
    it('a reservation not settled within its deadline stays spent, and a late settle changes nothing', async () => {
      let now = 0;
      const store = make();
      const caps = createCaps({ maxReplyTokens: 100 }, store, { now: () => now }, { reservationMs: 1000, dayOf: () => 'd' });
      const r = await go(caps, call());
      now = 2000;
      await go(caps, call());
      expect(store.all.map((x) => x.tokens)).toEqual([r.reserved.tokens]);
      expect(await caps.settle(r.reservation, done({ inputTokens: 1, outputTokens: 1 }))).toBeUndefined();
      expect(store.all.map((x) => x.tokens)).toEqual([r.reserved.tokens]);
    });
  });

  it('every retry takes its own reservation, and a not-processed try is released', async () => {
    const store = make();
    const caps = createCaps({ maxReplyTokens: 100 }, store, at('2026-11-15T10:00:00Z'));
    const busy: ModelError = { kind: 'rate-limit', message: 'x', notProcessed: true };
    const model = createFakeModel([{ error: busy }, { error: busy }, { text: 'ok', usage: { inputTokens: 9, outputTokens: 1 } }]);
    const reserved: string[] = [];
    const counting: Caps = { before: async (c) => { const r = await caps.before(c); if (r.go) reserved.push(r.reservation); return r; }, settle: caps.settle };
    const port = withRetries(cappedPort(model, counting, () => ({ persona: 'p', turn: 't', price })), { sleep: async () => {} });
    for await (const _ of port.stream(request)) void _;
    expect(new Set(reserved).size).toBe(3);
    expect(store.all.map((x) => x.tokens)).toEqual([10]);
  });

  it('a capped port pauses over a cap and sends nothing; a reader that stops early leaves it spent', async () => {
    const store = make();
    const caps = createCaps({ maxReplyTokens: 100, maxDayTokens: 10 }, store, at('2026-11-15T10:00:00Z'));
    const model = createFakeModel([{ text: 'never' }]);
    const events: ModelEvent[] = [];
    for await (const e of cappedPort(model, caps, () => ({ persona: 'p', turn: 't', price })).stream(request)) events.push(e);
    expect(events).toMatchObject([{ type: 'error', error: { kind: 'paused', pause: 'day-tokens' } }]);
    expect(model.requests).toHaveLength(0);

    const roomy = createCaps({ maxReplyTokens: 100 }, store, at('2026-11-15T10:00:00Z'));
    const long = createFakeModel([{ text: 'a long reply', chunkSize: 1 }]);
    for await (const e of cappedPort(long, roomy, () => ({ persona: 'p', turn: 't', price })).stream(request)) { void e; break; }
    expect(store.all).toHaveLength(1);
    expect(store.reservations).toEqual([]);
  });

  it('localDay is the local calendar date', () => {
    expect(localDay(new Date(2026, 0, 2, 0, 30).getTime())).toBe('2026-01-02');
  });
});

/* ---------- the property: seeded random interleavings ---------- */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

async function interleave(seed: number, make: MakeStore): Promise<string[]> {
  const rand = rng(seed);
  const tick = () => new Promise<void>((r) => (rand() < 0.9 ? queueMicrotask(r) : setTimeout(r, 0)));
  const store = make(tick);
  const worst = inputBound(request) + 100;
  const config = { maxReplyTokens: 100, maxDayTokens: worst * 7, maxTurnTokens: worst * 4, personaDayUsd: { a: worstCost(inputBound(request), 100, price, false).usd as number * 3.5 } };
  const caps = createCaps(config, store, { now: () => 0 }, { dayOf: () => 'd' });
  const problems: string[] = [];
  const check = () => {
    const tokens = [...store.all, ...store.reservations].reduce((t, x) => t + x.tokens, 0);
    if (tokens > config.maxDayTokens) problems.push(`seed ${seed}: ${tokens} tokens past the day cap`);
    for (const turn of ['t0', 't1', 't2']) {
      const used = [...store.all, ...store.reservations].filter((x) => x.turn === turn).reduce((t, x) => t + x.tokens, 0);
      if (used > config.maxTurnTokens) problems.push(`seed ${seed}: turn ${turn} at ${used}`);
    }
    const usd = [...store.all.filter((r) => r.persona === 'a').map((r) => r.cost.usd), ...store.reservations.filter((r) => r.persona === 'a').map((r) => r.usd)].reduce<number>((t, x) => t + (x as number), 0);
    if (usd > config.personaDayUsd.a + 1e-12) problems.push(`seed ${seed}: persona a at $${usd}`);
  };
  await Promise.all(
    Array.from({ length: 24 }, async () => {
      for (let n = Math.floor(rand() * 3); n > 0; n--) await tick();
      // One conversation, switching between a model that counts a quarter of the bytes and one that
      // counts every byte, so a count remembered for one and used for the other would show.
      const model = rand() < 0.5 ? 'small' : 'big';
      const c = call({ persona: rand() < 0.5 ? 'a' : 'b', turn: `t${Math.floor(rand() * 3)}`, conversation: 'c', request: { ...request, model } });
      const r = await caps.before(c);
      check();
      if (!r.go) return;
      for (let n = Math.floor(rand() * 4); n > 0; n--) await tick();
      const input = model === 'big' ? inputBound(c.request) : Math.floor(inputBound(c.request) / 4), output = Math.floor(rand() * r.maxOutputTokens);
      const usage = { inputTokens: input, outputTokens: output };
      const outcomes: (Terminal | undefined)[] = [
        done(usage),
        done({} as Usage),
        done({ inputTokens: input } as Usage),
        done({ inputTokens: String(input), outputTokens: -1 } as unknown as Usage),
        failed({ kind: 'filtered', message: 'x' }, { usage: {}, usageFinal: true }),
        done({ inputTokens: 0, outputTokens: 0 }, { unreported: true }),
        failed({ kind: 'rate-limit', message: 'x', notProcessed: true }),
        failed({ kind: 'server', message: 'x' }, { usage }),
        failed({ kind: 'filtered', message: 'x' }, { usage, usageFinal: true }),
        failed({ kind: 'aborted', message: 'Stopped.' }),
        undefined
      ];
      const last = outcomes[Math.floor(rand() * outcomes.length)];
      await caps.settle(r.reservation, last);
      check();
      const added = store.all.find((x) => x.reservation === r.reservation);
      // Whatever the endpoint said, or failed to say, the call really used input + output tokens; a
      // processed call must never be recorded as less.
      const processed = !(last?.type === 'error' && last.error.notProcessed);
      if (processed && (added?.tokens ?? 0) < input + output) {
        problems.push(`seed ${seed}: recorded ${added?.tokens ?? 'nothing'}, below the ${input + output} it really used (${JSON.stringify(last)})`);
      }
      if (added && added.tokens > r.reserved.tokens && last?.type === 'done' && !last.unreported) {
        problems.push(`seed ${seed}: ${model} used ${added.tokens}, past the ${r.reserved.tokens} reserved for it: its bound wasn't an upper bound`);
      }
      if (wholeUsage(last?.usage) && !(last.type === 'error' && last.error.notProcessed) && (!added || added.tokens < last.usage.inputTokens + last.usage.outputTokens)) {
        problems.push(`seed ${seed}: settled to ${added?.tokens ?? "nothing"}, below the reported ${last.usage.inputTokens + last.usage.outputTokens}`);
      }
    })
  );
  check();
  return problems;
}

describe.each(STORES)('the ledger under concurrent calls, $name', ({ make, seeds }) => {
  it(`over ${seeds} seeded interleavings, with model switches and empty or partial usage, recorded plus reserved spend never passes a cap, and nothing settles below reported or real usage`, { timeout: 120000 }, async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= seeds; seed++) problems.push(...(await interleave(seed, make)));
    expect(problems.slice(0, 5)).toEqual([]);
  });
});
