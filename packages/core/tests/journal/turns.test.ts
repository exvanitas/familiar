// Turns kept apart, and kept until they're finished: the turn registry (turns.ts), parking without losing
// a queued message, the gate on a recovered call, and answers checked inside their commit.
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../src/index.ts';
import type { FakeReply } from '../../src/testing/index.ts';
import { nodeWorld, type NodeWorld } from './node-env.ts';
import { NotesDoc, openFor, type Env, type OpenOptions } from './scenarios.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const envOf = (world: NodeWorld, life: number): Env => ({
  life,
  counters: world.counters,
  owner: world.owner,
  openStore: world.open,
  ready: () => {},
  onTransaction: (l) => {
    world.listeners.add(l);
    return () => world.listeners.delete(l);
  }
});
const users = (r: ModelRequest) => r.messages.flatMap((m, i) => (m.role === 'user' ? [{ i, text: m.content }] : []));
/** The person's last message, and how many replies have come since. */
function after(r: ModelRequest): { text: string; replies: number } {
  const last = users(r).at(-1)!;
  return { text: last.text, replies: r.messages.slice(last.i).filter((m) => m.role === 'assistant').length };
}
const looks = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, name: 'look', arguments: { what: `${tag}-${i}` } }));
const results = (requests: readonly ModelRequest[]) => requests.flatMap((r) => r.messages).filter((m) => m.role === 'tool').map((m) => (m as any).content as string);

/** Life 1 runs `act` until `hung` holds, then is killed; life 2 opens the same store. */
async function twoLives(world: NodeWorld, name: string, o: (life: number) => OpenOptions, act: (j: any) => Promise<void>, hung: () => boolean) {
  const one = await openFor(envOf(world, 1), await world.open(name), o(1));
  await act(one.journal);
  while (!hung()) await sleep(5);
  one.journal.kill();
  const two = await openFor(envOf(world, 2), await world.open(name), o(2));
  return { one, two };
}

describe('parking keeps the inbox', () => {
  it("a message sent while another's effect runs is kept when that call is parked after a crash, and answered later", async () => {
    const world = nodeWorld();
    const script = (r: ModelRequest): FakeReply => {
      const { text, replies } = after(r);
      if (replies > 0) return { text: `Done: ${text}` };
      if (text === 'Tell Sam.' || text.startsWith('Yes, do it now')) return { toolCalls: [{ id: `s-${users(r).length}`, name: 'send_message', arguments: { to: 'Sam', text: 'hi' } }] };
      return { text: `Answer to ${text}` };
    };
    const { two } = await twoLives(
      world,
      'park-inbox',
      (life) => ({ script, hang: (n) => life === 1 && n === 'send_message' }),
      async (j) => {
        void j.send('Tell Sam.', 'a');
        while (world.counters.get('hung:send_message') < 1) await sleep(5);
        // B arrives while A's effect runs: it queues.
        await j.send('And what time is it?', 'b');
      },
      () => world.counters.get('hung:send_message') >= 1
    );
    const a = await two.journal.send('Tell Sam.', 'a');
    if (!a.replied) throw new Error('A was taken for an acknowledgement');
    const end = await a.turn.wait();
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'redo' } });
    // B is kept: still queued, never aborted.
    const b = await two.journal.send('And what time is it?', 'b');
    if (!b.replied) throw new Error('B was taken for an acknowledgement');
    const queued = ((await two.journal.inspect()) as any).submissions.find((x: any) => String(x.id) === b.turn.id);
    expect(queued?.status).toBe('queued');
    // The person answers A; B goes with it, and gets its real answer.
    if (end.status !== 'asks') return;
    await (await two.journal.answer(end.question.id, true, 'redo'))!.wait();
    const resent = await two.journal.send('And what time is it?', 'b');
    expect(resent.replied && resent.turn.id).toBe(b.turn.id);
    expect(resent.replied && (await resent.turn.wait())).toMatchObject({ status: 'answered' });
    expect(two.model.requests.some((r) => r.messages.some((m) => m.role === 'user' && m.content === 'And what time is it?'))).toBe(true);
    await two.journal.close();
  });
});

describe('the turn registry', () => {
  // A message sent while a question is open closes it (pi-durable starts its run and removes runFailure),
  // so B queues behind A while A runs. The question holds B; Run again then queues behind B, B runs
  // its tools in its own turn, and A's Run again runs after, in A's turn.
  it("turn A parked at its 32nd call while turn B runs tools: when A resumes, its 33rd call is refused", async () => {
    const world = nodeWorld();
    const script = (r: ModelRequest): FakeReply => {
      const { text, replies } = after(r);
      if (text === 'Turn A') {
        if (replies < 3) return { toolCalls: looks(8, `a${replies}`) };
        if (replies === 3) return { toolCalls: [...looks(7, 'a3'), { id: 'a3-srv', name: 'server_lookup', arguments: { q: 'trains' } }] };
        return { text: 'A stops.' };
      }
      if (text === 'Turn B') return replies === 0 ? { toolCalls: looks(3, 'b') } : { text: 'B done.' };
      if (text.startsWith('Run ')) return replies === 0 ? { toolCalls: [{ id: 'a-again', name: 'server_lookup', arguments: { q: 'trains' } }] } : { text: 'A done.' };
      return { text: 'x' };
    };
    const { one, two } = await twoLives(
      world,
      'registry-calls',
      (life) => ({ script, hang: (n) => life === 1 && n === 'server_lookup' }),
      async (j) => {
        void j.send('Turn A', 'a');
        while (world.counters.get('hung:server_lookup') < 1) await sleep(5);
        await j.send('Turn B', 'b');
      },
      () => world.counters.get('hung:server_lookup') >= 1
    );
    const a = await two.journal.send('Turn A', 'a');
    const parked = a.replied ? await a.turn.wait() : undefined;
    expect(parked).toMatchObject({ status: 'asks', question: { kind: 'rerun' } });
    expect(world.counters.get('starts:look')).toBe(31);
    // A resumes with Run again: B, queued first, runs its own tools first, in its own turn.
    if (parked?.status !== 'asks') return;
    const again = (await two.journal.answer(parked.question.id, true, 'again'))!;
    const b = await two.journal.send('Turn B', 'b');
    expect(b.replied && (await b.turn.wait())).toMatchObject({ status: 'answered', text: 'B done.' });
    expect(world.counters.get('starts:look')).toBe(34);
    // Then A's Run again, in A's turn: its 33rd call is refused, however many B made.
    expect(await again.wait()).toMatchObject({ status: 'answered', text: 'A done.' });
    expect(world.counters.get('starts:server_lookup')).toBe(1);
    expect(results([...one.model.requests, ...two.model.requests]).some((t) => t.includes('Familiar stopped after 32 tool calls in this turn.'))).toBe(true);
    await two.journal.close();
  });

  it("A's question left open 31 days while B runs and tidies: when A resumes, its spend still counts", async () => {
    const world = nodeWorld();
    const script = (r: ModelRequest): FakeReply => {
      const { text, replies } = after(r);
      if (text === 'Turn A') return replies === 0 ? { toolCalls: [{ id: 'a-srv', name: 'server_lookup', arguments: { q: 'x' } }], usage: { inputTokens: 4500, outputTokens: 2 } } : { text: 'A stops.' };
      if (text === 'Turn B') return { text: 'B done.', usage: { inputTokens: 10, outputTokens: 2 } };
      if (text.startsWith('Run ')) return replies === 0 ? { toolCalls: [{ id: 'a-again', name: 'server_lookup', arguments: { q: 'x' } }] } : { text: 'A done.' };
      return { text: 'x' };
    };
    const { two } = await twoLives(
      world,
      'registry-spend',
      (life) => ({ script, hang: (n) => life === 1 && n === 'server_lookup', caps: { maxTurnTokens: 5000 } }),
      async (j) => {
        void j.send('Turn A', 'a');
        while (world.counters.get('hung:server_lookup') < 1) await sleep(5);
        await j.send('Turn B', 'b');
      },
      () => world.counters.get('hung:server_lookup') >= 1
    );
    const a = await two.journal.send('Turn A', 'a');
    const parked = a.replied ? await a.turn.wait() : undefined;
    expect(parked).toMatchObject({ status: 'asks', question: { kind: 'rerun' } });
    two.clock.advance(31 * 24 * 60 * 60_000);
    // A month on, Run again: B, queued first, runs and its calls tidy the ledger while A's Run again
    // waits queued behind it. A's turn is kept whole because that queued submission is read live.
    if (parked?.status !== 'asks') return;
    const again = (await two.journal.answer(parked.question.id, true, 'again'))!;
    const b = await two.journal.send('Turn B', 'b');
    expect(b.replied && (await b.turn.wait())).toMatchObject({ status: 'answered' });
    const ledger = await two.journal.ledger();
    expect(ledger.records.length + Object.keys(ledger.turns).length).toBeGreaterThan(0);
    // A's Run again: what it spent a month ago still counts toward its turn cap.
    expect(await again.wait()).toMatchObject({ status: 'asks', question: { kind: 'cap', pause: 'turn-tokens' } });
    await two.journal.close();
  });
});

describe('the gate on recovery', () => {
  it('a built-in write allowed before the crash and denied before the reopen never runs when it is recovered', async () => {
    const world = nodeWorld();
    const script = (r: ModelRequest): FakeReply => (r.messages.at(-1)?.role === 'tool' ? { text: 'ok' } : { toolCalls: [{ id: 'n', name: 'note_add', arguments: { text: 'buy milk' } }] });
    const { two } = await twoLives(
      world,
      'recovered-gate',
      (life) => ({ script, hang: (n) => life === 1 && n === 'note_add:before', policy: life === 2 ? { perTool: { note_add: 'deny' } } : undefined }),
      async (j) => void j.send('Note it.', 'a'),
      () => world.counters.get('hung:note_add:before') >= 1
    );
    const a = await two.journal.send('Note it.', 'a');
    expect(a.replied && (await a.turn.wait())).toMatchObject({ status: 'answered' });
    expect((await two.journal.read(NotesDoc))?.notes ?? []).toEqual([]);
    expect(world.counters.get('starts:note_add')).toBe(1);
    expect(world.counters.get('write-calls:life2')).toBe(0);
    expect((await two.journal.transcript()).find((e) => e.role === 'toolResult')?.text).toMatch(/note_add is turned off/);
    await two.journal.close();
  });
});

describe('answers checked in their commit', () => {
  const bigSteps = (r: ModelRequest): FakeReply =>
    r.messages.filter((m) => m.role === 'tool').length < 1
      ? { toolCalls: [{ id: 'n0', name: 'note_add', arguments: { text: 'n0' } }], usage: { inputTokens: 4500, outputTokens: 2 } }
      : { text: 'All noted.', usage: { inputTokens: 10, outputTokens: 2 } };

  it('two overlapping answers to one turn-tokens pause give one turn and grant exactly one extension', async () => {
    const world = nodeWorld();
    const { journal } = await openFor(envOf(world, 1), await world.open('overlap'), { script: bigSteps, caps: { maxTurnTokens: 5000 } });
    const sent = await journal.send('Note it.', 'r1');
    const end = sent.replied ? await sent.turn.wait() : undefined;
    if (end?.status !== 'asks') throw new Error(JSON.stringify(end));
    const [x, y] = await Promise.all([journal.answer(end.question.id, true, 'yes-a'), journal.answer(end.question.id, true, 'yes-b')]);
    expect(x?.id).toBeDefined();
    expect(y?.id).toBe(x?.id);
    expect(await x!.wait()).toMatchObject({ status: 'answered' });
    expect(Object.values((await journal.ledger()).extensions)).toEqual([1]);
    await journal.close();
  });

  for (const when of ['after', 'before'] as const) {
    it(`a kill ${when} the answer's commit: ${when === 'after' ? 'the extension and the submission are stored, and a retry grants nothing more' : 'nothing is stored, and the retry grants the extension once'}`, async () => {
      const world = nodeWorld();
      const one = await openFor(envOf(world, 1), await world.open(`answer-${when}`), { script: bigSteps, caps: { maxTurnTokens: 5000 } });
      const sent = await one.journal.send('Note it.', 'r1');
      const end = sent.replied ? await sent.turn.wait() : undefined;
      if (end?.status !== 'asks') throw new Error(JSON.stringify(end));
      // The answer's commit is its first commit transaction: read-write over every store (an id being
      // minted takes one store only). "after": the kill drops the connection as that transaction opens,
      // which lets it finish. "before": on the read just before it.
      const isCommit = (t?: IDBTransaction) => t?.mode === 'readwrite' && t.objectStoreNames.length > 1;
      // Let the run's own end settle first (it records the pause's question), so the next commit is the answer's.
      await sleep(100);
      let killed = false;
      world.listeners.add((t) => {
        if (killed) return;
        if (when === 'after' ? !isCommit(t) : t?.mode !== 'readonly') return;
        killed = true;
        one.journal.kill();
      });
      await one.journal.answer(end.question.id, true, 'yes-1').catch(() => undefined);
      world.listeners.clear();
      expect(killed).toBe(true);
      const two = await openFor(envOf(world, 2), await world.open(`answer-${when}`), { script: bigSteps, caps: { maxTurnTokens: 5000 } });
      const stored = await two.journal.ledger();
      const continues = ((await two.journal.inspect()) as any).submissions.filter((x: any) => x.type === 'continue').length + (world.counters.get('model-requests') > 1 ? 1 : 0);
      if (when === 'after') {
        expect(Object.values(stored.extensions)).toEqual([1]);
        expect(continues).toBeGreaterThan(0);
      } else {
        expect(stored.extensions).toEqual({});
        expect(continues).toBe(0);
      }
      const again = await two.journal.answer(end.question.id, true, 'yes-1');
      expect(await again!.wait()).toMatchObject({ status: 'answered', text: 'All noted.' });
      expect(Object.values((await two.journal.ledger()).extensions)).toEqual([1]);
      await two.journal.close();
    });
  }
});
