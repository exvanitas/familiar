// The caps ledger in the journal's store, across restarts: an open reservation survives a restart and stays
// spent past its deadline, and the caps hold when the engine dies in the middle of concurrent calls.
import { describe, expect, it } from 'vitest';
import { createCaps, inputBound, worstCost, type CallInfo, type Ledger, type ModelEvent, type ModelRequest, type Price, type Usage } from '../../src/index.ts';
import { nodeWorld } from './node-env.ts';
import { openLedger } from './durable-ledger.ts';

const request: ModelRequest = { model: 'm', system: 'You are kind.', messages: [{ role: 'user', content: 'Hello there' }], tools: [] };
const price: Price = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
const call = (o: Partial<CallInfo> = {}): CallInfo => ({ request, persona: 'p', turn: 't1', price, ...o });
type Terminal = Extract<ModelEvent, { type: 'done' | 'error' }>;
const done = (usage: Usage): Terminal => ({ type: 'done', stopReason: 'end', usage });

describe("the caps ledger in the journal's store", () => {
  it('an open reservation survives a restart, still counts, and stays spent past its deadline', async () => {
    const world = nodeWorld();
    let now = 0;
    const clock = { now: () => now };
    const config = { maxReplyTokens: 100, maxDayTokens: (inputBound(request) + 100) * 2 };
    const first = await openLedger(world);
    const caps = createCaps(config, first.usage, clock, { dayOf: () => 'd', reservationMs: 1000 });
    const r = await caps.before(call());
    if (!r.go) throw new Error('paused');
    // The engine dies with the call in flight: no settle, no close.
    first.store.sever();

    const second = await openLedger(world);
    expect((await second.usage.read()).open.map((x) => x.id)).toEqual([r.reservation]);
    const again = createCaps(config, second.usage, clock, { dayOf: () => 'd', reservationMs: 1000 });
    // It still counts: room for one more call today, not two.
    expect((await again.before(call())).go).toBe(true);
    expect(await again.before(call())).toMatchObject({ go: false, pause: 'day-tokens' });
    // Nobody settles it, and a settle from this instance can't reach it.
    expect(await again.settle(r.reservation, done({ inputTokens: 1, outputTokens: 1 }))).toBeUndefined();
    // Past its deadline it's a spent record, at what was reserved.
    now = 5000;
    await again.before(call({ turn: 't2' }));
    const ledger = await second.usage.read();
    expect(ledger.open.some((x) => x.id === r.reservation)).toBe(false);
    expect(ledger.records.find((x) => x.reservation === r.reservation)).toMatchObject({ tokens: r.reserved.tokens, cost: { usd: r.reserved.usd } });
  });

  it('a second instance on the same store waits for the first to go: one owner, so updates never interleave', async () => {
    const world = nodeWorld();
    const first = await world.owner.acquire('journal');
    let second = false;
    const waiting = world.owner.acquire('journal').then((h) => ((second = true), h));
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    first.release();
    (await waiting).release();
    expect(second).toBe(true);
  });

  it('settled records older than two days fold into per-turn totals, and a turn keeps its cap', async () => {
    const world = nodeWorld();
    let now = new Date('2026-11-01T10:00:00Z').getTime();
    const { usage } = await openLedger(world);
    const worst = inputBound(request) + 100;
    const caps = createCaps({ maxReplyTokens: 100, maxTurnTokens: worst * 2 }, usage, { now: () => now });
    const r = await caps.before(call({ turn: 'long' }));
    if (!r.go) throw new Error('paused');
    await caps.settle(r.reservation, done({ inputTokens: worst - 100, outputTokens: 100 }));
    now += 3 * 24 * 60 * 60_000;
    await caps.before(call({ turn: 'long' }));
    const ledger: Ledger = await usage.read();
    expect(ledger.records.some((x) => x.reservation === r.reservation)).toBe(false);
    expect(ledger.turns.long?.tokens).toBe(worst);
    expect(await caps.before(call({ turn: 'long' }))).toMatchObject({ go: false, pause: 'turn-tokens' });
  });
});

/* ---------- the property, with a restart in the middle ---------- */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

async function withRestart(seed: number): Promise<{ problems: string[]; cutOff: number; afterRestart: number }> {
  const rand = rng(seed);
  const tick = () => new Promise<void>((r) => (rand() < 0.9 ? queueMicrotask(r) : setTimeout(r, 0)));
  const world = nodeWorld();
  const worst = inputBound(request) + 100;
  const config = { maxReplyTokens: 100, maxDayTokens: worst * 7, maxTurnTokens: worst * 4, personaDayUsd: { a: (worstCost(inputBound(request), 100, price, false).usd as number) * 3.5 } };
  let now = 0;
  const clock = { now: () => now };
  const open = async (reopened: boolean) => {
    const instance = await openLedger(world);
    return { ...instance, reopened, caps: createCaps(config, instance.usage, clock, { dayOf: () => 'd', reservationMs: 60_000 }) };
  };
  let current = open(false);
  const problems: string[] = [];
  const check = async () => {
    const l = await (await current).usage.read();
    const all = [...l.records, ...l.open];
    const tokens = all.reduce((t, x) => t + x.tokens, 0);
    if (tokens > config.maxDayTokens) problems.push(`seed ${seed}: ${tokens} tokens past the day cap`);
    for (const turn of ['t0', 't1', 't2']) {
      const used = all.filter((x) => x.turn === turn).reduce((t, x) => t + x.tokens, 0);
      if (used > config.maxTurnTokens) problems.push(`seed ${seed}: turn ${turn} at ${used}`);
    }
    const usd = [...l.records.filter((r) => r.persona === 'a').map((r) => r.cost.usd), ...l.open.filter((r) => r.persona === 'a').map((r) => r.usd)].reduce<number>((t, x) => t + (x as number), 0);
    if (usd > config.personaDayUsd.a + 1e-12) problems.push(`seed ${seed}: persona a at $${usd}`);
  };
  // The restart lands once a random number of calls hold reservations, most of them not settled yet.
  // About a third of the calls start only after it, on the reopened store.
  const restartAt = 1 + Math.floor(rand() * 6);
  const granted = new Map<string, number>();
  let afterRestart = 0;
  let restart!: () => void;
  const restarted = new Promise<void>((resolve) => {
    let done = false;
    restart = () => {
      if (done) return;
      done = true;
      // The engine dies, with no shutdown path; the app opens again on the same store.
      void current.then((old) => old.store.sever());
      current = open(true);
      resolve();
    };
  });
  const cutOff = new Set<string>();
  const late = Array.from({ length: 24 }, () => rand() < 0.35);
  const pre: Promise<void>[] = [];
  const all = late.map(async (isLate, i) => {
      if (isLate) await restarted;
      for (let n = Math.floor(rand() * 3); n > 0; n--) await tick();
      const mine = await current;
      const model = rand() < 0.5 ? 'small' : 'big';
      const c = call({ persona: rand() < 0.5 ? 'a' : 'b', turn: `t${Math.floor(rand() * 3)}`, conversation: 'c', request: { ...request, model } });
      let r;
      try {
        r = await mine.caps.before(c);
      } catch {
        return; // cut off before it could reserve: nothing was sent
      }
      await check();
      if (!r.go) return;
      granted.set(r.reservation, r.reserved.tokens);
      if (mine.reopened) afterRestart++;
      if (granted.size >= restartAt) restart();
      for (let n = Math.floor(rand() * 4); n > 0; n--) await tick();
      const input = model === 'big' ? inputBound(c.request) : Math.floor(inputBound(c.request) / 4);
      const outcomes: (Terminal | undefined)[] = [
        done({ inputTokens: input, outputTokens: Math.floor(rand() * r.maxOutputTokens) }),
        done({} as Usage),
        { type: 'error', error: { kind: 'rate-limit', message: 'x', notProcessed: true } },
        { type: 'error', error: { kind: 'server', message: 'x' } },
        undefined
      ];
      try {
        await mine.caps.settle(r.reservation, outcomes[Math.floor(rand() * outcomes.length)]);
      } catch {
        cutOff.add(r.reservation); // the instance died first: the reservation must stay spent
      }
      await check();
      void i;
  });
  for (const [i, p] of all.entries()) if (!late[i]) pre.push(p);
  // If too few calls got a reservation, the restart still comes once the early ones are done.
  await Promise.all(pre);
  restart();
  await Promise.all(all);
  await check();
  // Every reservation the dead instance never settled is still in the store, open or spent, at full size.
  const after = await (await current).usage.read();
  for (const id of cutOff) {
    const kept = after.open.find((x) => x.id === id) ?? after.records.find((x) => x.reservation === id);
    if (!kept) problems.push(`seed ${seed}: reservation ${id} was lost in the restart`);
    else if (kept.tokens < granted.get(id)!) problems.push(`seed ${seed}: reservation ${id} shrank to ${kept.tokens} in the restart`);
  }
  // Past every deadline, they're spent records, and nothing is left open.
  now = 120_000;
  await (await current).caps.before(call({ turn: 'later' }));
  const final = await (await current).usage.read();
  for (const id of cutOff) if (!final.records.some((x) => x.reservation === id && x.tokens >= granted.get(id)!)) problems.push(`seed ${seed}: ${id} not spent past its deadline`);
  if (final.open.some((x) => cutOff.has(x.id))) problems.push(`seed ${seed}: a dead reservation is still open past its deadline`);
  return { problems, cutOff: cutOff.size, afterRestart };
}

describe('the caps ledger under concurrent calls, with the engine killed in the middle', () => {
  it('over 100 seeded interleavings with a restart, spend never passes a cap and no open reservation is lost', { timeout: 120000 }, async () => {
    const problems: string[] = [];
    let cutOff = 0;
    let afterRestart = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const run = await withRestart(seed);
      problems.push(...run.problems);
      cutOff += run.cutOff;
      afterRestart += run.afterRestart;
    }
    expect(problems.slice(0, 5)).toEqual([]);
    // The restarts really landed mid-call: reservations were cut off unsettled, and calls went on after.
    expect(cutOff).toBeGreaterThan(20);
    expect(afterRestart).toBeGreaterThan(20);
  });
});
