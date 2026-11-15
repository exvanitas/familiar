// The turn loop's own rules, in Node on a strict fake IndexedDB: the strict store, the step cap, cap
// pauses that park instead of failing, the bare "thanks" rule, the decision slot, the state it reports,
// one owner, and model errors that pi-durable never retries on its own.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { decodeModelError, encodeModelError, NotStrict, openJournalStore, replayOf, type Decision, type ModelRequest, type PersonaEvent } from '../../src/index.ts';
import { nodeWorld } from './node-env.ts';
import { openFor, type Env } from './scenarios.ts';

const lastIsTool = (r: ModelRequest) => r.messages.at(-1)?.role === 'tool';
const toolResults = (r: ModelRequest) => r.messages.filter((m) => m.role === 'tool').length;

function envOf(world = nodeWorld()): Env & { world: typeof world } {
  return { life: 1, counters: world.counters, owner: world.owner, openStore: world.open, ready: () => {}, world };
}

describe('the store', () => {
  it('opens every transaction strict, and refuses to open when a transaction reports otherwise', async () => {
    const world = nodeWorld();
    const env = envOf(world);
    const { journal } = await openFor(env, await world.open('strict'), { script: (r) => (lastIsTool(r) ? { text: 'ok' } : { toolCalls: [{ id: 'c', name: 'save_note', arguments: { text: 'x' } }] }) });
    const sent = await journal.send('Note x.', 'r1');
    if (sent.replied) await sent.turn.wait();
    await journal.close();
    expect(world.transactions.length).toBeGreaterThan(10);
    expect(new Set(world.transactions.map((t) => (t as any).durability))).toEqual(new Set(['strict']));

    // A browser that drops the hint: the probe sees "default", and nothing opens.
    const real = new IDBFactory();
    const ignoring = {
      open(name: string, version?: number) {
        const request = real.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const open = db.transaction;
          Object.defineProperty(db, 'transaction', { configurable: true, value: (s: any, m: any) => open.call(db, s, m, { durability: 'default' }) });
        });
        return request;
      },
      deleteDatabase: (n: string) => real.deleteDatabase(n),
      cmp: (a: unknown, b: unknown) => real.cmp(a, b),
      databases: () => real.databases()
    } as unknown as globalThis.IDBFactory;
    await expect(openJournalStore('loose', { indexedDB: ignoring })).rejects.toBeInstanceOf(NotStrict);
  });
});

// pi-durable's own storage conformance suite, with Vitest's expect, against the strict store on a fake
// IndexedDB. The same suite runs in headless Chromium on the real one (browser.test.ts).
registerStorageConformance({ describe, expect, it } as any, 'pi-durable storage conformance, strict IndexedDB store (fake IndexedDB)', async (use: any) => {
  const factory = new IDBFactory() as unknown as globalThis.IDBFactory;
  const store = await openJournalStore('conformance', { indexedDB: factory });
  try {
    await use(store.storage);
  } finally {
    await store.storage.close(BACKGROUND_CONTEXT);
  }
});

describe('tools and replay', () => {
  it('only pure reads and built-in writes may run again; effects and every server tool never', () => {
    expect(replayOf('read')).toBe('safe');
    expect(replayOf('write')).toBe('safe');
    expect(replayOf('effect')).toBe('unsafe');
    expect(replayOf('server')).toBe('unsafe');
  });

  it('sends no attribution: no request names pi to a provider', () => {
    const source = readFileSync(join(import.meta.dirname, '../../src/journal/journal.ts'), 'utf8');
    expect(source).toMatch(/identity: \{ attribution: null \}/);
  });
});

describe('the step cap', () => {
  it('after 8 tool steps the turn asks; yes goes on with a fresh 8', async () => {
    const env = envOf();
    const { journal, presence } = await openFor(env, await env.world.open('cap'), {
      script: (r) => (toolResults(r) < 10 ? { toolCalls: [{ id: `c${toolResults(r)}`, name: 'look', arguments: { what: `page ${toolResults(r)}` } }] } : { text: 'All ten pages read.' })
    });
    const sent = await journal.send('Read all ten pages.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    const end = await sent.turn.wait();
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'steps', text: "I've taken 8 steps on this. Shall I keep going?" } });
    expect(env.counters.get('starts:look')).toBe(8);
    expect(presence.at(-1)?.state).toBe('waiting');
    const [question] = await journal.questions();
    const next = await journal.answer(question!.id, true, 'r2');
    expect(await next!.wait()).toMatchObject({ status: 'answered', text: 'All ten pages read.' });
    expect(env.counters.get('starts:look')).toBe(10);
    expect(await journal.questions()).toEqual([]);
    expect(presence.at(-1)?.state).toBe('idle');
    await journal.close();
  });
});

describe('caps that pause, not fail', () => {
  it('a cap pause parks the turn with what it needs to go on, reported as waiting, never as an error', async () => {
    const env = envOf();
    const { journal, presence, clock, model } = await openFor(env, await env.world.open('pause'), {
      // The first reply reports a big input, so the reply after the tool would pass the daily cap.
      script: (r) => (lastIsTool(r) ? { text: 'Done.', usage: { inputTokens: 10, outputTokens: 2 } } : { toolCalls: [{ id: 'c', name: 'look', arguments: { what: 'x' } }], usage: { inputTokens: 4000, outputTokens: 2 } }),
      caps: { maxDayTokens: 5000 }
    });
    const sent = await journal.send('Look at x.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    const end = await sent.turn.wait();
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'day-tokens', text: expect.stringMatching(/daily cap of 5000/) } });
    expect(model.requests).toHaveLength(1);
    expect(presence.at(-1)?.state).toBe('waiting');
    expect(presence.some((p) => p.state === 'error')).toBe(false);
    // Tomorrow there's room: yes goes on from the tool's result, without running it again.
    clock.advance(24 * 60 * 60_000);
    const [question] = await journal.questions();
    const next = await journal.answer(question!.id, true, 'r2');
    expect(await next!.wait()).toMatchObject({ status: 'answered', text: 'Done.' });
    expect(env.counters.get('starts:look')).toBe(1);
    await journal.close();
  });

  it("a model error is not sent again by pi-durable: Familiar's own retries already ran", async () => {
    const env = envOf();
    const { journal, model, presence } = await openFor(env, await env.world.open('err'), {
      script: () => ({ error: { kind: 'server', message: 'The server error 503 said: rate limit, overloaded.' } })
    });
    const sent = await journal.send('Hello?', 'r1');
    if (!sent.replied) throw new Error('no reply');
    expect(await sent.turn.wait()).toMatchObject({ status: 'failed', reason: 'model_error', message: 'The server error 503 said: rate limit, overloaded.' });
    expect(model.requests).toHaveLength(1);
    expect(presence.at(-1)?.state).toBe('error');
    await journal.close();
  });

  it('error text crosses to pi-ai coded, so no word or status code in it reads as retryable', () => {
    for (const message of ['rate limit', 'server error 503', 'overloaded', '429 Too Many Requests', 'network error', 'service temporarily unavailable']) {
      const text = encodeModelError({ kind: 'server', message });
      expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: text } as any), message).toBe(false);
      expect(decodeModelError(text)).toEqual({ kind: 'server', message });
    }
    expect(decodeModelError(encodeModelError({ kind: 'paused', message: 'm', pause: 'day-tokens' }))).toEqual({ kind: 'paused', message: 'm', pause: 'day-tokens' });
    expect(decodeModelError('anything else')).toBeUndefined();
  });
});

describe('a bare "thanks" or "ok"', () => {
  it('gets no reply message, only a reaction, unless it answers her question', async () => {
    const env = envOf();
    const reactions: [Decision, PersonaEvent][] = [];
    let ask = false;
    const { journal, model } = await openFor(env, await env.world.open('ack'), {
      script: () => ({ text: ask ? 'Shall I save it?' : 'Here you go.' }),
      onReaction: (d, e) => reactions.push([d, e])
    });
    const first = await journal.send('What is the time?', 'r1');
    if (first.replied) await first.turn.wait();
    expect(model.requests).toHaveLength(1);

    const thanks = await journal.send('thanks!', 'r2');
    expect(thanks).toMatchObject({ replied: false, decision: { act: 'gesture' } });
    expect(model.requests).toHaveLength(1);
    expect(reactions.at(-1)?.[1].name).toBe('ack-sent');
    expect((await journal.transcript()).at(-1)).toMatchObject({ kind: 'familiar.ack', text: 'thanks!' });

    // Her last message asked something: "ok" is an answer, and goes to the model.
    ask = true;
    const q = await journal.send('Make a note of it.', 'r3');
    if (q.replied) await q.turn.wait();
    const ok = await journal.send('ok', 'r4');
    expect(ok.replied).toBe(true);
    if (ok.replied) await ok.turn.wait();
    expect(model.requests).toHaveLength(3);
    expect(model.requests.at(-1)!.messages.at(-1)).toEqual({ role: 'user', content: 'ok' });
    await journal.close();
  });
});

describe('the decision slot', () => {
  it('asks the rules decider about what nobody asked for, with what the loop knows, and reacts', async () => {
    const env = envOf();
    const seen: { event: string; recent: string[]; minutesSinceChat: number | null }[] = [];
    const reactions: Decision[] = [];
    let front = true;
    const { decideByRules } = await import('../../src/index.ts');
    const { journal } = await openFor(env, await env.world.open('decide'), {
      script: (r) => (lastIsTool(r) ? { text: 'Done.' } : { toolCalls: [{ id: 'c', name: 'look', arguments: { what: 'x' } }] }),
      chatInFront: () => front,
      decider: {
        decide: async (event, context) => {
          seen.push({ event: event.name, recent: context.recentEvents.map((e) => e.name), minutesSinceChat: context.minutesSinceChat });
          return decideByRules(event, context);
        }
      },
      onReaction: (d) => reactions.push(d)
    });
    // Back after half an hour: a greeting bubble at medium chattiness.
    expect(await journal.notice({ name: 'back-after', at: Date.now(), minutesAway: 30 })).toMatchObject({ act: 'bubble', kind: 'greet' });
    expect(reactions).toHaveLength(1);
    // With the chat hidden, a tool done and a reply done go to the decider.
    front = false;
    const sent = await journal.send('Look at x.', 'r1');
    if (sent.replied) await sent.turn.wait();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((s) => s.event)).toEqual(['back-after', 'tool-done', 'reply-done-hidden']);
    // It sees the recent events: the message you sent is there, as context.
    expect(seen.at(-1)!.recent).toContain('message-sent');
    expect(seen.at(-1)!.minutesSinceChat).not.toBeNull();
    await journal.close();
  });
});

describe('the state it reports', () => {
  it('is a presence snapshot: one gen per start, seq rising, states in order, waiting beats working', async () => {
    const world = nodeWorld();
    const env = envOf(world);
    let gens = 0;
    const store = await world.open('presence');
    const opened = await openFor(env, store, {
      script: (r) => (lastIsTool(r) ? { text: 'Sent.' } : { toolCalls: [{ id: 'c', name: 'send_message', arguments: { to: 'Sam', text: 'hi' } }] }),
      consent: () => new Promise((r) => setTimeout(() => r(true), 30)),
      newGen: () => `g${++gens}`
    });
    const sent = await opened.journal.send('Tell Sam hi.', 'r1');
    if (sent.replied) await sent.turn.wait();
    await opened.journal.close();
    const p = opened.presence;
    expect(p.every((s) => s.v === 1 && s.agent === 'olive' && s.gen === 'g1' && s.ttl === 60)).toBe(true);
    expect(p.map((s) => s.seq)).toEqual(p.map((_, i) => i + 1));
    const states = p.map((s) => s.state + (s.tool ? `:${s.tool}` : ''));
    expect(states[0]).toBe('idle');
    expect(states).toContain('thinking');
    expect(states).toContain('waiting');
    expect(states).toContain('working:send_message');
    // While the card is open the tool's step is under way, but waiting beats working; it runs after.
    expect(states.indexOf('waiting')).toBeLessThan(states.lastIndexOf('working:send_message'));
    expect(states.at(-1)).toBe('idle');

    // A new start of the journal takes a new gen.
    const again = await openFor(env, await world.open('presence'), { script: () => ({ text: 'x' }), newGen: () => `g${++gens}` });
    expect(again.presence[0]).toMatchObject({ gen: 'g2', seq: 1, state: 'idle' });
    await again.journal.close();
  });
});

describe('one owner', () => {
  it('a second journal on the same store waits until the first is gone', async () => {
    const world = nodeWorld();
    const env = envOf(world);
    const first = await openFor(env, await world.open('own'), { script: () => ({ text: 'x' }) });
    let second: Awaited<ReturnType<typeof openFor>> | undefined;
    const opening = openFor(env, await world.open('own'), { script: () => ({ text: 'x' }) }).then((o) => (second = o));
    await new Promise((r) => setTimeout(r, 50));
    expect(second).toBeUndefined();
    await first.journal.close();
    await opening;
    expect(second).toBeDefined();
    await second!.journal.close();
  });
});
