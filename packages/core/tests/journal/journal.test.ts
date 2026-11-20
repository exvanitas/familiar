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
import { BUILT_IN_READS, decodeModelError, encodeModelError, gateFor, NotStrict, openJournalStore, replayOf, RUN_WITHOUT_ASKING, type Decision, type FamiliarTool, type ModelRequest, type PersonaEvent } from '../../src/index.ts';
import { nodeWorld } from './node-env.ts';
import { openFor, type Env } from './scenarios.ts';

const lastIsTool = (r: ModelRequest) => r.messages.at(-1)?.role === 'tool';
const toolResults = (r: ModelRequest) => r.messages.filter((m) => m.role === 'tool').length;

function envOf(world = nodeWorld()): Env & { world: typeof world } {
  return { life: 1, counters: world.counters, owner: world.owner, openStore: world.open, onTransaction: () => () => {}, ready: () => {}, world };
}

describe('the store', () => {
  it('opens every transaction strict, and refuses to open when a transaction reports otherwise', async () => {
    const world = nodeWorld();
    const env = envOf(world);
    const { journal } = await openFor(env, await world.open('strict'), { script: (r) => (lastIsTool(r) ? { text: 'ok' } : { toolCalls: [{ id: 'c', name: 'note_add', arguments: { text: 'x' } }] }) });
    const sent = await journal.send('Note x.', 'r1');
    if (sent.replied) await sent.turn.wait();
    await journal.close();
    expect(world.transactions.length).toBeGreaterThan(10);
    expect(new Set(world.transactions.map((t) => (t as any).durability))).toEqual(new Set(['strict']));
    // The one exception, recorded by name: the schema's upgrade, when the database was made.
    expect(world.upgrades).toEqual(['default']);

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

describe('the consent gate', () => {
  const tool = (o: Partial<FamiliarTool>): FamiliarTool => ({ name: 'x', description: '', inputSchema: {}, kind: 'read', doing: () => 'x', run: async () => '', ...o });

  it('fails closed: only the listed built-ins run without asking; deny wins; asks only makes it stricter', () => {
    expect(RUN_WITHOUT_ASKING).toEqual(['note_add', 'reminder_set', 'reminder_cancel']);
    expect(BUILT_IN_READS).toEqual(['note_search', 'note_list', 'reminder_list']);
    // A built-in pure read runs without asking. A server tool of the same name, or one that says it only
    // reads, still asks.
    expect(gateFor('note_list', tool({ name: 'note_list', kind: 'read' }))).toBe('allow');
    expect(gateFor('note_list', tool({ name: 'note_list', kind: 'server' }))).toBe('ask');
    expect(gateFor('srv_read', tool({ name: 'srv_read', kind: 'server', readOnlyHint: true }))).toBe('ask');
    expect(gateFor('note_list', tool({ name: 'note_list', kind: 'effect' }))).toBe('ask');
    expect(gateFor('note_add', tool({ name: 'note_add', kind: 'write' }))).toBe('allow');
    // Not on the list: a read, an effect, a server tool named like a listed one, a tool nobody knows.
    expect(gateFor('look', tool({ name: 'look', kind: 'read' }))).toBe('ask');
    expect(gateFor('send_message', tool({ name: 'send_message', kind: 'effect' }))).toBe('ask');
    expect(gateFor('note_add', tool({ name: 'note_add', kind: 'server' }))).toBe('ask');
    expect(gateFor('mystery', undefined)).toBe('ask');
    // Deny wins, over the list too.
    expect(gateFor('note_add', tool({ name: 'note_add', kind: 'write' }), { perTool: { note_add: 'deny' } })).toBe('deny');
    // No "always" for a server's tool: an allow from anywhere asks. Only the person's "may run on its own"
    // runs it unasked, and a tool's own `asks` still asks: it can only be stricter.
    expect(gateFor('srv', tool({ name: 'srv', kind: 'server' }), { perTool: { srv: 'allow' } })).toBe('ask');
    expect(gateFor('srv', tool({ name: 'srv', kind: 'server' }), { perTool: { srv: 'own' } })).toBe('own');
    expect(gateFor('note_add', tool({ name: 'note_add', kind: 'write', asks: true }))).toBe('ask');
    expect(gateFor('srv', tool({ name: 'srv', kind: 'server', asks: true }), { perTool: { srv: 'own' } })).toBe('ask');
    // A built-in off the list asks whatever a policy says; "own" means nothing for a built-in.
    expect(gateFor('send_message', tool({ name: 'send_message', kind: 'effect' }), { perTool: { send_message: 'allow' } })).toBe('ask');
    expect(gateFor('note_add', tool({ name: 'note_add', kind: 'write' }), { perTool: { note_add: 'own' } })).toBe('allow');
  });

  it('in the loop: a built-in read and note_add run without asking; another read, a server tool and a read-only server tool ask; a denied tool never runs or asks', async () => {
    const env = envOf();
    const calls = [
      { id: 'a', name: 'look', arguments: { what: 'x' } },
      { id: 'b', name: 'server_lookup', arguments: { q: 'y' } },
      { id: 'c', name: 'note_add', arguments: { text: 'z' } },
      { id: 'd', name: 'send_message', arguments: { to: 'Sam', text: 'hi' } },
      { id: 'e', name: 'note_list', arguments: {} },
      { id: 'f', name: 'server_read', arguments: { q: 'r' } }
    ];
    const asked: string[] = [];
    const { journal } = await openFor(env, await env.world.open('gate'), {
      script: (r) => (lastIsTool(r) ? { text: 'Done.' } : { toolCalls: calls }),
      consent: (_life, id) => (asked.push(id), Promise.resolve(true)),
      policy: { perTool: { send_message: 'deny' } }
    });
    const sent = await journal.send('Do four things.', 'r1');
    if (sent.replied) await sent.turn.wait();
    // Asked: the read that isn't built in, the server tool, and the server tool that says it only reads.
    expect(asked).toHaveLength(3);
    expect(['look', 'server_lookup', 'note_add', 'send_message', 'note_list', 'server_read'].map((n) => env.counters.get(`starts:${n}`))).toEqual([1, 1, 1, 0, 1, 1]);
    const results = (await journal.transcript()).filter((e) => e.role === 'toolResult').map((e) => e.text);
    expect(results[3]).toMatch(/send_message is turned off/);
    await journal.close();
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

  it('a turn waiting 31 days on a consent card, then approved, still counts what it spent before toward its turn cap', async () => {
    const env = envOf();
    let answer: ((ok: boolean) => void) | undefined;
    const { journal, clock } = await openFor(env, await env.world.open('month'), {
      // The first reply reports a big input; the reply after the tool would pass the turn cap.
      script: (r) => (lastIsTool(r) ? { text: 'Sent.', usage: { inputTokens: 10, outputTokens: 2 } } : { toolCalls: [{ id: 'c', name: 'send_message', arguments: { to: 'Sam', text: 'hi' } }], usage: { inputTokens: 4000, outputTokens: 2 } }),
      consent: () => new Promise<boolean>((r) => (answer = r)),
      caps: { maxTurnTokens: 5000 }
    });
    const sent = await journal.send('Tell Sam hi.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    while (!answer) await new Promise((r) => setTimeout(r, 5));
    clock.advance(31 * 24 * 60 * 60_000);
    answer(true);
    const end = await sent.turn.wait();
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'turn-tokens' } });
    expect(env.counters.get('starts:send_message')).toBe(1);
    await journal.close();
  });

  // Each reply reports a big input, so each one after the first needs one more turn allowance.
  const bigSteps = (steps: number) => (r: ModelRequest) =>
    toolResults(r) < steps ? { toolCalls: [{ id: `n${toolResults(r)}`, name: 'note_add', arguments: { text: `n${toolResults(r)}` } }], usage: { inputTokens: 4500, outputTokens: 2 } } : { text: 'All noted.', usage: { inputTokens: 10, outputTokens: 2 } };

  it('a Yes at a turn-tokens pause goes on with exactly one more allowance; a second pause needs a second Yes', async () => {
    const env = envOf();
    const { journal, model } = await openFor(env, await env.world.open('extend'), { script: bigSteps(2), caps: { maxTurnTokens: 5000 } });
    const sent = await journal.send('Note two things.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    const first = await sent.turn.wait();
    expect(first).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'turn-tokens', text: expect.stringMatching(/Say yes to give it 5000 more/) } });
    if (first.status !== 'asks') return;
    const second = await (await journal.answer(first.question.id, true, 'yes-1'))!.wait();
    // One more allowance took one more reply; the next pauses again.
    expect(second).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'turn-tokens' } });
    expect(model.requests).toHaveLength(2);
    expect(Object.values((await journal.ledger()).extensions)).toEqual([1]);
    if (second.status !== 'asks') return;
    expect(await (await journal.answer(second.question.id, true, 'yes-2'))!.wait()).toMatchObject({ status: 'answered', text: 'All noted.' });
    expect(Object.values((await journal.ledger()).extensions)).toEqual([2]);
    // Answering the first again changes nothing.
    await journal.answer(first.question.id, true, 'yes-1');
    expect(Object.values((await journal.ledger()).extensions)).toEqual([2]);
    await journal.close();
  });

  it('the extension survives a kill between the Yes and the next call, and is granted once', async () => {
    const world = nodeWorld();
    const one = await openFor(envOf(world), await world.open('extend-kill'), { script: bigSteps(1), caps: { maxTurnTokens: 5000 } });
    const sent = await one.journal.send('Note one thing.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    const end = await sent.turn.wait();
    if (end.status !== 'asks') throw new Error(JSON.stringify(end));
    // The kill lands right after the answer's commit, before the next call reserves anything.
    let killed = false;
    world.listeners.add(() => {
      if (killed) return;
      killed = true;
      one.journal.kill();
    });
    await one.journal.answer(end.question.id, true, 'yes-1').catch(() => undefined);
    world.listeners.clear();
    expect(one.model.requests).toHaveLength(1);
    const two = await openFor({ ...envOf(world), life: 2 }, await world.open('extend-kill'), { script: bigSteps(1), caps: { maxTurnTokens: 5000 } });
    const again = await two.journal.answer(end.question.id, true, 'yes-1');
    expect(await again!.wait()).toMatchObject({ status: 'answered', text: 'All noted.' });
    expect(Object.values((await two.journal.ledger()).extensions)).toEqual([1]);
    await two.journal.close();
  });

  it('a Yes at a daily-cap pause never lifts it: nothing more is spent, and it says what it needs', async () => {
    const env = envOf();
    const { journal, model } = await openFor(env, await env.world.open('daily-yes'), { script: bigSteps(1), caps: { maxDayTokens: 5000 } });
    const sent = await journal.send('Note one thing.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    const end = await sent.turn.wait();
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'day-tokens', text: expect.stringMatching(/Raise the daily cap, or wait until tomorrow/) } });
    if (end.status !== 'asks') return;
    const before = await journal.ledger();
    const after = await (await journal.answer(end.question.id, true, 'yes-1'))!.wait();
    expect(after).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'day-tokens' } });
    expect(model.requests).toHaveLength(1);
    const ledger = await journal.ledger();
    expect(ledger.records).toEqual(before.records);
    expect(ledger.open).toEqual([]);
    expect(ledger.extensions).toEqual({});
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

describe('waking', () => {
  it('a wake timer that fires early arms again, so the parked wait still runs once it is due', async () => {
    const env = envOf();
    const { journal, clock } = await openFor(env, await env.world.open('early'), { script: () => ({ text: 'x' }), earlyTimersMs: 20 });
    await journal.parkUntil('stretch', clock.now() + 60);
    for (let i = 0; i < 100 && env.counters.get('delivered') === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(env.counters.get('delivered')).toBe(1);
    await journal.close();
  });
});

describe('close', () => {
  it('never hangs on a pending consent: it releases the owner lock, and the unanswered card is there on reopen', async () => {
    const world = nodeWorld();
    const env = envOf(world);
    let answer: ((ok: boolean) => void) | undefined;
    const first = await openFor(env, await world.open('close'), {
      script: (r) => (lastIsTool(r) ? { text: 'Sent.' } : { toolCalls: [{ id: 'c', name: 'send_message', arguments: { to: 'Sam', text: 'hi' } }] }),
      consent: () => new Promise<boolean>(() => {})
    });
    void first.journal.send('Tell Sam hi.', 'r1');
    while ((await first.journal.consents()).length < 1) await new Promise((r) => setTimeout(r, 5));
    const card = (await first.journal.consents())[0]!;
    const closed = await Promise.race([first.journal.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    expect(closed).toBe('closed');
    // The lock is free: a new journal opens at once.
    const second = await openFor(env, await world.open('close'), {
      script: (r) => (lastIsTool(r) ? { text: 'Sent.' } : { toolCalls: [{ id: 'c', name: 'send_message', arguments: { to: 'Sam', text: 'hi' } }] }),
      consent: () => new Promise<boolean>((r) => (answer = r))
    });
    expect(await second.journal.consents()).toEqual([card]);
    while (!answer) await new Promise((r) => setTimeout(r, 5));
    answer(true);
    const sent = await second.journal.send('Tell Sam hi.', 'r1');
    if (!sent.replied) throw new Error('no reply');
    expect(await sent.turn.wait()).toMatchObject({ status: 'answered', text: 'Sent.' });
    expect(env.counters.get('starts:send_message')).toBe(1);
    await second.journal.close();
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
