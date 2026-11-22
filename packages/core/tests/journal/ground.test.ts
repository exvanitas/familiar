// The journal on the MCP rebuild's ground (docs/mcp-design.md 2.1 to 2.6): questions are a view over
// pi-durable's runFailure, answers are one checked commit, Send now is one action for the queue, a run
// belongs to the turn of the first input it places, and her line is one toolless call and one commit
// that never starts a run. All against the real pi-durable 1.5.2 on a fake IndexedDB.

import { describe, expect, it } from 'vitest';
import { alternate, decodeFailure, encodeModelError, runView, TurnsDoc, type ChatMessage, type Journal, type ModelRequest } from '../../src/index.ts';
import type { FakeReply } from '../../src/testing/index.ts';
import { mutations } from '../../src/mutations.ts';
import { nodeWorld, type NodeWorld } from './node-env.ts';
import { openFor, type Env, type OpenOptions } from './scenarios.ts';

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
const lastUser = (r: ModelRequest) => String([...r.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
const hasTool = (r: ModelRequest) => r.messages.some((m) => m.role === 'tool');
function gate() {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { until, open };
}
async function journalOf(o: OpenOptions, name = `ground-${Math.random()}`) {
  const world = nodeWorld();
  const opened = await openFor(envOf(world, 1), await world.open(name), o);
  return { ...opened, world };
}
const until = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out: ${what}`);
};
const inspectOf = async (j: Journal) => (await j.inspect()) as any;
/** A submission's status while it's unfinished; `settled` once inspect no longer lists it. */
const statusOf = async (j: Journal, id: string) => (await inspectOf(j)).submissions.find((s: any) => String(s.id) === id)?.status ?? 'settled';
const idle = (j: Journal) => until(async () => !(await inspectOf(j)).conversations?.some?.((c: any) => c.busy) && (await j.questions()) !== undefined, 'idle');

/* ---------- the view ---------- */

describe('2.2: the question view', () => {
  const live = (runFailure: unknown, run?: unknown) => ({ ...(run ? { run } : {}), ...(runFailure ? { runFailure } : {}) });
  it('reads each row of the table, and an answer record closes it', () => {
    expect(runView(live(undefined, { taskId: 1, inputs: [] }), {}, {}, 8)).toEqual({ state: 'running' });
    expect(runView({}, {}, {}, 8)).toEqual({ state: 'idle' });
    expect(runView(live({ taskId: 5, inputs: [2], reason: 'turn_limit', detail: '8 turns' }), {}, {}, 8)).toMatchObject({ state: 'question', question: { id: 'run:5', kind: 'steps', text: "I've taken 8 steps on this. Shall I keep going?" } });
    const pause = encodeModelError({ kind: 'paused', message: 'Say yes to give it 5000 more.', pause: 'turn-tokens' });
    expect(runView(live({ taskId: 5, inputs: [], reason: 'model_error', detail: pause }), {}, {}, 8)).toMatchObject({ state: 'question', question: { kind: 'cap', pause: 'turn-tokens' } });
    // A pause inside a blocking compaction carries both of pi-durable's prefixes (B1).
    const inCompaction = `Compaction failed: Summarization failed: ${pause}`;
    expect(decodeFailure(inCompaction)).toMatchObject({ kind: 'paused', pause: 'turn-tokens' });
    expect(runView(live({ taskId: 5, inputs: [], reason: 'model_error', detail: inCompaction }), {}, {}, 8)).toMatchObject({ state: 'question', question: { kind: 'cap' } });
    // Aborted with interruption records under its task: one question listing every step; without: your Stop.
    const steps = {
      '11': { step: '11', task: '5', tool: 'server_lookup', arguments: {}, kind: 'rerun' as const, text: 'a', turn: 't' },
      '12': { step: '12', task: '5', tool: 'send_message', arguments: {}, kind: 'redo' as const, text: 'b', turn: 't' },
      '13': { step: '13', task: '4', tool: 'send_message', arguments: {}, kind: 'redo' as const, text: 'c', turn: 't' }
    };
    const q = runView(live({ taskId: 5, inputs: [], reason: 'aborted' }), { steps }, {}, 8);
    expect(q).toMatchObject({ state: 'question', question: { kind: 'rerun', steps: [{ step: '11' }, { step: '12' }] } });
    expect(runView(live({ taskId: 6, inputs: [], reason: 'aborted' }), { steps }, {}, 8)).toEqual({ state: 'stopped', task: '6' });
    expect(runView(live({ taskId: 5, inputs: [], reason: 'model_error', detail: encodeModelError({ kind: 'server', message: 'It failed.' }) }), {}, {}, 8)).toMatchObject({ state: 'error', message: 'It failed.' });
    expect(runView(live({ taskId: 5, inputs: [], reason: 'nothing_to_answer' }), {}, {}, 8)).toMatchObject({ state: 'error' });
    const answered = { byTask: { '5': { yes: false, kind: 'steps' as const, turn: 't' } } };
    expect(runView(live({ taskId: 5, inputs: [2], reason: 'turn_limit' }), {}, answered, 8)).toMatchObject({ state: 'answered', task: '5' });
  });
});

/* ---------- B3: alternating roles ---------- */

describe('2.1 and B3: every request alternates roles', () => {
  it('merges a note and your next message, and two plain replies; never tool calls, replay or tool results', () => {
    const m: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '[Olive said this on her own]' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'a', toolCalls: [{ id: 'c', name: 'look', arguments: {} }] },
      { role: 'tool', toolCallId: 'c', toolName: 'look', content: 'r1' },
      { role: 'tool', toolCallId: 'd', toolName: 'look', content: 'r2' },
      { role: 'assistant', content: 'x' },
      { role: 'assistant', content: 'y' },
      { role: 'assistant', content: 'z', replay: { adapter: 'pi-ai', data: {} } as any }
    ];
    const out = alternate(m);
    expect(out.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'tool', 'assistant', 'assistant']);
    expect(out[2]).toEqual({ role: 'user', content: '[Olive said this on her own]\n\nthanks' });
    expect(out[6]).toEqual({ role: 'assistant', content: 'x\n\ny' });
  });
});

/* ---------- questions, answers, Send now ---------- */

/** A, stopped at the step cap (1), with `queued` messages sent while it ran. */
async function stepCapWithQueue(queued: string[], extra: Partial<OpenOptions> = {}) {
  const hold = gate();
  const o = await journalOf({
    stepCap: 1,
    script: (r) => {
      const u = lastUser(r);
      if (u === 'A' && !hasTool(r)) return { toolCalls: [{ id: 'a1', name: 'look', arguments: { what: 'a' } }], pause: { afterEvents: 0, until: hold.until } };
      return { text: `answer to ${u}` };
    },
    ...extra
  });
  const a = await o.journal.send('A', 'a');
  if (!a.replied) throw new Error('A was an ack');
  await until(async () => (await inspectOf(o.journal)).live?.run !== undefined || o.model.requests.length > 0, 'A running');
  const qs: string[] = [];
  for (const text of queued) {
    const s = await o.journal.send(text, text);
    if (!s.replied) throw new Error('an ack');
    qs.push(s.turn.id);
  }
  hold.open();
  const end = await a.turn.wait();
  return { ...o, a, end, qs };
}

describe('2.2 to 2.4: questions, answers and the queue', () => {
  it('a step-cap question holds the queue; a new message closes it in its own commit, and a delayed Yes then starts nothing', async () => {
    const { journal, end, qs } = await stepCapWithQueue(['B']);
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'steps' } });
    if (end.status !== 'asks') return;
    expect(await statusOf(journal, qs[0]!)).toBe('queued');
    expect(await journal.queued()).toBeUndefined();
    // Your new message: B is placed first, then yours; the question is gone.
    const c = await journal.send('C', 'c');
    expect(await journal.questions()).toEqual([]);
    if (!c.replied) return;
    expect(await c.turn.wait()).toMatchObject({ status: 'answered', text: 'answer to C' });
    expect(await journal.turn(qs[0]!).wait()).toMatchObject({ status: 'answered', text: 'answer to B' });
    // The delayed Yes: closed, you moved on. Nothing starts, nothing is recorded.
    const requests = c.replied ? Number(c.turn.id) : 0;
    expect(await journal.answer(end.question.id, true, 'late-yes')).toBeUndefined();
    const after = await journal.send('D', 'd');
    // The next submission id follows C's directly but for D's own: the late Yes made no submission.
    expect(after.replied && Number(after.turn.id)).toBeGreaterThan(requests);
    expect(((await journal.read((await import('../../src/index.ts')).AnswersDoc)) as any).byTask).toEqual({});
    await journal.close();
  });

  it("a No with B queued sends B on, and the new run is charged to B's turn", async () => {
    const { journal, end, qs, a } = await stepCapWithQueue(['B']);
    if (end.status !== 'asks') throw new Error(JSON.stringify(end));
    const next = await journal.answer(end.question.id, false, 'no-1');
    expect(next).toBeDefined();
    expect(await next!.wait()).toMatchObject({ status: 'answered', text: 'answer to B' });
    const registry: any = await journal.read(TurnsDoc);
    expect(registry.of[next!.id]).toBe(qs[0]);
    expect(registry.turns[a.replied ? a.turn.id : ''].open).toBe(false);
    // Answering again returns the same run and starts nothing more.
    expect((await journal.answer(end.question.id, false, 'no-2'))?.id).toBe(next!.id);
    await journal.close();
  });

  it('a No with nothing queued starts nothing and finishes the turn; a bare "ok" leaves an open question open', async () => {
    const { journal, end } = await stepCapWithQueue([]);
    if (end.status !== 'asks') throw new Error(JSON.stringify(end));
    const ok = await journal.send('ok', 'ok-1');
    expect(ok.replied).toBe(false);
    expect((await journal.questions()).map((q) => q.id)).toEqual([end.question.id]);
    expect(await journal.answer(end.question.id, false, 'no')).toBeUndefined();
    expect(await journal.questions()).toEqual([]);
    expect(await journal.queued()).toBeUndefined();
    await journal.close();
  });

  it('after an error, Send now shows for the oldest of three queued messages, sends it first, and the rest follow in order', async () => {
    const hold = gate();
    const { journal, model } = await journalOf({
      script: (r) => {
        const u = lastUser(r);
        if (u === 'A') return { text: 'x', error: { kind: 'bad-request', message: 'The endpoint refused it.' }, pause: { afterEvents: 0, until: hold.until } };
        return { text: `answer to ${u}` };
      }
    });
    const a = await journal.send('A', 'a');
    await until(async () => model.requests.length > 0, 'A running');
    const ids: string[] = [];
    for (const t of ['B', 'C', 'D']) {
      const s = await journal.send(t, t);
      if (s.replied) ids.push(s.turn.id);
    }
    hold.open();
    if (a.replied) expect(await a.turn.wait()).toMatchObject({ status: 'failed' });
    expect(await journal.questions()).toEqual([]);
    const offer = await journal.queued();
    expect(offer?.submission).toBe(ids[0]);
    // A button shown for another failure does nothing.
    expect(await journal.sendNow({ submission: ids[0]!, failure: 'not-this-one' }, 'stale')).toBeUndefined();
    expect(await statusOf(journal, ids[0]!)).toBe('queued');
    const sent = await journal.sendNow(offer!, 'send-1');
    expect(sent).toBeDefined();
    // A's message was never answered, so the context ends in A then B: one user message on the wire (B3).
    expect(await sent!.wait()).toMatchObject({ status: 'answered', text: 'answer to A\n\nB' });
    for (const id of ids) expect(await journal.turn(id).wait()).toMatchObject({ status: 'answered' });
    const answered = model.requests.filter((r) => !r.messages.some((m) => m.role === 'tool')).map(lastUser);
    expect(answered).toEqual(['A', 'A\n\nB', 'C', 'D']);
    // The same request id again: the same run, nothing more.
    expect((await journal.sendNow(offer!, 'send-1'))?.id).toBe(sent!.id);
    expect(await journal.queued()).toBeUndefined();
    await journal.close();
  });
});

/* ---------- interrupted steps: one question per task ---------- */

describe('2.4: Send now is read from one committed state', () => {
  it("asked while a Send now's commit is being written: it answers as of that commit, never with the offer it just used", async () => {
    const hold = gate();
    const world = nodeWorld();
    const store = await world.open(`ground-${Math.random()}`);
    const { journal } = await openFor(envOf(world, 1), store, {
      script: (r) => (lastUser(r) === 'A' ? { text: 'x', error: { kind: 'bad-request', message: 'The endpoint refused it.' }, pause: { afterEvents: 0, until: hold.until } } : { text: `answer to ${lastUser(r)}`, pause: { afterEvents: 0, until: new Promise<void>(() => {}) } })
    });
    const a = await journal.send('A', 'a');
    await sleep(20);
    await journal.send('B', 'b');
    await journal.send('C', 'c');
    hold.open();
    if (a.replied) await a.turn.wait();
    const offer = await journal.queued();
    expect(offer).toBeDefined();
    // As Send now's storage write lands, before the journal hears it, Send now is asked again.
    let again: Promise<unknown> | undefined;
    const write = store.storage.commit.bind(store.storage);
    (store.storage as any).commit = async (...args: unknown[]) => {
      const r = await (write as any)(...args);
      again ??= journal.queued();
      return r;
    };
    const sent = await journal.sendNow(offer!, 'go');
    expect(sent).toBeDefined();
    expect(again).toBeDefined();
    expect(await again).toBeUndefined();
    await journal.close();
  });
});

describe('2.4: a bare acknowledgement, acted on once per request id', () => {
  it('two sends of one request id at once: one ack, one decision, and both get it', async () => {
    let decides = 0;
    const { journal } = await journalOf({
      script: () => ({ text: 'Here is a fact about owls.' }),
      decider: { decide: async () => (decides++, await sleep(5), { act: 'gesture', gesture: 'nod' } as any) }
    });
    const first = await journal.send('hi there, tell me something', 'r0');
    if (first.replied) await first.turn.wait();
    decides = 0;
    const [x, y] = await Promise.all([journal.send('thanks', 'r1'), journal.send('thanks', 'r1')]);
    expect(decides).toBe(1);
    expect(x).toEqual({ replied: false, decision: { act: 'gesture', gesture: 'nod' } });
    expect(y).toEqual(x);
    expect((await journal.transcript()).filter((e) => e.kind === 'familiar.ack')).toHaveLength(1);
    // A resend later gets the same, with no new decision.
    expect(await journal.send('thanks', 'r1')).toEqual(x);
    expect(decides).toBe(1);
    await journal.close();
  });

  it("a resend while the first send is still deciding gets that decision, never a quiet one, even once its record has left the newest 256", async () => {
    let decides = 0;
    const held = gate();
    const { journal } = await journalOf({
      script: () => ({ text: 'Fine.' }),
      // The first acknowledgement's decision waits; every later one is quiet at once.
      decider: { decide: async () => (++decides === 1 ? (await held.until, { act: 'gesture', gesture: 'nod' } as any) : ({ act: 'quiet' } as any)) }
    });
    const first = journal.send('thanks', 'ack-0');
    await until(async () => decides === 1, 'the first decision under way');
    // Its record leaves the newest 256 while it decides; pi-durable still knows the request id.
    for (let i = 1; i <= 260; i++) await journal.send('ok', `ack-${i}`);
    const resent = journal.send('thanks', 'ack-0');
    await sleep(20);
    held.open();
    const x = await first;
    expect(x).toEqual({ replied: false, decision: { act: 'gesture', gesture: 'nod' } });
    expect(await resent).toEqual(x);
    await journal.close();
  }, 120_000);

  it("a resend after 300 later requests isn't read again: an ack, with no new decision and no second entry", async () => {
    let decides = 0;
    const { journal } = await journalOf({ script: () => ({ text: 'Fine.' }), decider: { decide: async () => (decides++, { act: 'quiet' } as any) } });
    expect((await journal.send('thanks', 'ack-0')).replied).toBe(false);
    for (let i = 1; i <= 300; i++) await journal.send('ok', `ack-${i}`);
    const before = (await journal.transcript()).filter((e) => e.kind === 'familiar.ack').length;
    decides = 0;
    expect(await journal.send('thanks', 'ack-0')).toEqual({ replied: false, decision: { act: 'quiet' } });
    expect(decides).toBe(0);
    expect((await journal.transcript()).filter((e) => e.kind === 'familiar.ack').length).toBe(before);
    await journal.close();
  }, 120_000);
});

describe("2.2: a turn's wait gives its own question only", () => {
  it("A fails, then B stops at its step cap: waiting for A again gives A's failure, never B's question", async () => {
    let fail = true;
    const script = (r: ModelRequest) => {
      if (fail && JSON.stringify(r.messages).includes('first')) return { error: { kind: 'auth', message: 'nope' } as any, text: '' };
      return { toolCalls: [{ id: `c${r.messages.length}`, name: 'note_add', arguments: { text: 'n' } }] };
    };
    const { journal } = await journalOf({ script, stepCap: 2 });
    const a = await journal.send('first message please answer', 'ra');
    if (!a.replied) throw new Error('a not replied');
    expect(await a.turn.wait()).toMatchObject({ status: 'failed' });
    fail = false;
    const b = await journal.send('second message, do notes', 'rb');
    if (!b.replied) throw new Error('b not replied');
    const bEnd = await b.turn.wait();
    expect(bEnd).toMatchObject({ status: 'asks', question: { kind: 'steps' } });
    expect(await journal.turn(a.turn.id).wait()).toMatchObject({ status: 'failed' });
    // B's own wait, and a Yes's continue (a submission of B's turn), still give B's question.
    expect(await journal.turn(b.turn.id).wait()).toEqual(bEnd);
    const going = await journal.answer((bEnd as { question: { id: string } }).question.id, true, 'yes-b');
    expect(await going!.wait()).toMatchObject({ status: 'asks', question: { kind: 'steps' } });
    await journal.close();
  });
});

describe('2.2: several interrupted steps in one round make one question (S7)', () => {
  // Two built-in effects: a recovered run never gets server tools (2.7), so its second server call would be
  // refused, not cut off. Effects are cut off the same way.
  it('two effects cut off in two lives, then a kill: one question lists both, and one Yes settles both', async () => {
    const world = nodeWorld();
    const script = (r: ModelRequest): FakeReply => {
      const u = lastUser(r);
      if (u === 'Ask twice.' && !hasTool(r)) return { toolCalls: [{ id: 'q1', name: 'send_message', arguments: { to: 'one', text: 'hi' } }, { id: 'q2', name: 'send_message', arguments: { to: 'two', text: 'hi' } }] };
      if (u.startsWith('Yes, do it now')) return { text: 'Both again.' };
      return { text: 'done' };
    };
    // Life n holds the n-th effect: life 1 the first, life 2 the second (the first is cut off there).
    const o = (life: number): OpenOptions => ({ script, hang: (n) => n === 'send_message' && world.counters.get('starts:send_message') === life });
    const one = await openFor(envOf(world, 1), await world.open('s7'), o(1));
    void one.journal.send('Ask twice.', 'a');
    await until(async () => world.counters.get('hung:send_message') >= 1, 'first call held');
    one.journal.kill();
    const two = await openFor(envOf(world, 2), await world.open('s7'), o(2));
    await until(async () => world.counters.get('hung:send_message') >= 2, 'second call held');
    two.journal.kill();
    const three = await openFor(envOf(world, 3), await world.open('s7'), o(3));
    const a = await three.journal.send('Ask twice.', 'a');
    if (!a.replied) throw new Error('ack');
    const end = await a.turn.wait();
    expect(end).toMatchObject({ status: 'asks', question: { kind: 'redo' } });
    if (end.status !== 'asks') return;
    expect(end.question.steps?.map((s) => s.tool)).toEqual(['send_message', 'send_message']);
    expect(end.question.steps?.map((s) => (s.arguments as any).to)).toEqual(['one', 'two']);
    expect(await three.journal.questions()).toHaveLength(1);
    const again = await three.journal.answer(end.question.id, true, 'again');
    expect(await again!.wait()).toMatchObject({ status: 'answered' });
    expect(three.model.requests.some((r) => lastUser(r) === 'Yes, do it now: sending a message to one. Yes, do it now: sending a message to two.')).toBe(true);
    expect(await three.journal.questions()).toEqual([]);
    expect(await three.journal.answer(end.question.id, false, 'skip-late')).toMatchObject({ id: again!.id });
    await three.journal.close();
  });
});

/* ---------- her line ---------- */

describe('2.1: her line', () => {
  const prompt = { system: 'Say one short line.', messages: [{ role: 'user' as const, content: 'Your reminder is due.' }] };

  it('is one model request: an error, even one that says it was never processed, is not tried again, and she stays quiet', async () => {
    let n = 0;
    const { journal, model } = await journalOf({ script: () => (++n === 1 ? { error: { kind: 'server', message: 'busy', notProcessed: true } as any, text: '' } : { text: 'Hello there.' }) });
    expect(await journal.remark(prompt)).toBeUndefined();
    expect(model.requests).toHaveLength(1);
    expect((await journal.transcript()).filter((e) => e.kind === 'familiar.remark')).toEqual([]);
    await journal.close();
  });

  it('into a quiet chat: model-visible, as a note that merges with your next message', async () => {
    const { journal, model } = await journalOf({ script: (r) => (r.tools.length === 0 && r.system === 'Say one short line.' ? { text: 'The kettle!' } : { text: `answer to ${lastUser(r)}` }) });
    const said = await journal.remark(prompt);
    expect(said).toEqual({ text: 'The kettle!', visible: true });
    expect(model.requests[0]).toMatchObject({ tools: [], system: 'Say one short line.' });
    expect((await journal.transcript()).at(-1)).toMatchObject({ kind: 'familiar.remark', text: 'The kettle!' });
    // Nothing ran: no run, no question.
    expect((await inspectOf(journal)).submissions.filter((s: any) => s.type !== 'write')).toEqual([]);
    const next = await journal.send('Where?', 'w');
    if (next.replied) await next.turn.wait();
    const last = model.requests.at(-1)!;
    expect(last.messages.map((m) => m.role)).toEqual(['user']);
    expect(last.messages[0]!.content).toMatch(/^\[Olive said this on her own.*The kettle!.*\]\n\nWhere\?$/s);
    await journal.close();
  });

  it('while you are mid-turn: shown only, and it starts nothing', async () => {
    const hold = gate();
    const { journal, model } = await journalOf({
      script: (r) => (r.tools.length === 0 && r.system === 'Say one short line.' ? { text: 'Oh!' } : { text: 'slow', pause: { afterEvents: 0, until: hold.until } })
    });
    const a = await journal.send('A', 'a');
    await until(async () => model.requests.length > 0, 'A running');
    expect(await journal.remark(prompt)).toMatchObject({ visible: false });
    hold.open();
    if (a.replied) await a.turn.wait();
    expect(model.requests.filter((r) => r.system !== 'Say one short line.')).toHaveLength(1);
    await journal.close();
  });

  it('after a stopped run with B queued: shown only; B stays queued and the question stays open', async () => {
    const { journal, end, qs, model } = await stepCapWithQueue(['B'], {});
    expect(end).toMatchObject({ status: 'asks' });
    const before = model.requests.length;
    model; // the remark's request goes through the same fake
    const said = await journal.remark({ ...prompt, system: 'Say one short line.' });
    expect(said?.visible).toBe(false);
    await sleep(50);
    expect(await statusOf(journal, qs[0]!)).toBe('queued');
    expect(await journal.questions()).toHaveLength(1);
    expect(model.requests.length).toBe(before + 1);
    await journal.close();
  });

  it('after a failed run with nothing queued: shown only, so a later Send now or Yes finds the context as the run left it', async () => {
    const { journal } = await journalOf({ script: (r) => (r.system === 'Say one short line.' ? { text: 'Hm.' } : { error: { kind: 'bad-request', message: 'no' } }) });
    const a = await journal.send('A', 'a');
    if (a.replied) await a.turn.wait();
    expect(await journal.remark(prompt)).toMatchObject({ visible: false });
    await journal.close();
  });

  it('a paused cap: she stays quiet, and nothing is written', async () => {
    const { journal } = await journalOf({ caps: { maxDayTokens: 1 }, script: () => ({ text: 'never' }) });
    const before = (await journal.transcript()).length;
    expect(await journal.remark(prompt)).toBeUndefined();
    expect((await journal.transcript()).length).toBe(before);
    await journal.close();
  });
});

void idle;

/* ---------- 5.6: no server tool runs without your Yes ---------- */

describe('5.6 and G12: no server tool runs without your Yes to that call, whatever a policy says (T9)', () => {
  async function run(answer: boolean) {
    const { IDBFactory } = await import('fake-indexeddb');
    const { openJournal, openJournalStore, decideByRules } = await import('../../src/index.ts');
    const { createFakeModel } = await import('../../src/testing/index.ts');
    const { memoryOwner } = await import('./node-env.ts');
    const { sha256 } = await import('../../src/mcp/hash.ts');
    const cards: any[] = [];
    const ran: unknown[] = [];
    const tool = {
      name: 'srv__look',
      description: 'A server tool.',
      inputSchema: { type: 'object', properties: {} },
      kind: 'server' as const,
      server: { id: 'srv', label: 'Weather' },
      doing: () => 'looking on the server',
      consent: { facts: () => ({ server: 'srv', tool: 'look', run: 'r1', launch: 'L', fingerprint: 'F', canonical: '{}', hash: sha256('{}') }) },
      run: async (_a: unknown, step: any) => {
        ran.push(step.decision);
        return 'looked';
      }
    };
    const model = createFakeModel((r: ModelRequest) => (r.system === 'One line.' ? { text: 'I saw the forecast.' } : r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { toolCalls: [{ id: `c${r.messages.length}`, name: 'srv__look', arguments: {} }] }));
    const journal = await openJournal({
      store: await openJournalStore(`t9-${Math.random()}`, { indexedDB: new IDBFactory() as any }),
      owner: memoryOwner(),
      model,
      modelId: 'fake-1',
      caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
      tools: [tool as any],
      // An "always", from anywhere: a clean chat, nothing a server said in it yet.
      policy: () => ({ perTool: { srv__look: 'allow' } }),
      wake: { wakeAt: () => {} },
      notifier: { notify: () => {} },
      consent: { ask: async (card) => { cards.push(card); return answer; } },
      presence: { report: () => {} },
      persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
      decider: { decide: async (event, context) => decideByRules(event, context) },
      ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
      resendDelayMs: 50
    });
    expect(await journal.remark({ system: 'One line.', messages: [{ role: 'user', content: 'Say something.' }] })).toMatchObject({ visible: true });
    for (const id of ['a', 'b']) {
      const t = await journal.send('Look it up.', id);
      if (t.replied) await t.turn.wait();
    }
    await journal.close();
    return { cards, ran };
  }

  it('each call shows its card, with no "May run on its own" in step 7 (step 8 wires its press); a No sends nothing', async () => {
    const yes = await run(true);
    expect(yes.cards).toHaveLength(2);
    expect(yes.cards[0]).toMatchObject({ facts: { server: 'srv', tool: 'look' } });
    expect(yes.cards[0]!.own).toBeUndefined();
    expect(yes.ran).toHaveLength(2);
    expect(yes.ran.every((d: any) => d.by === 'asked')).toBe(true);
    const no = await run(false);
    expect(no.cards).toHaveLength(2);
    expect(no.ran).toEqual([]);
  });

  it('the control: the old "always" (server-always) runs it with no Yes to the call', async () => {
    mutations.set(['server-always']);
    try {
      const r = await run(false);
      expect(r.cards).toEqual([]);
      expect(r.ran).toHaveLength(2);
    } finally {
      mutations.clear();
    }
  });
});

/* ---------- 2.7: the recovered-run gate ---------- */

describe('2.7: a run recovered after a restart never gets server tools', () => {
  it('its server call is refused in words and never starts; the next message\'s run can call it', async () => {
    const world = nodeWorld();
    const never = new Promise<void>(() => {});
    const script = (life: number) => (r: ModelRequest): FakeReply => {
      const u = lastUser(r);
      if (r.messages.at(-1)?.role === 'tool') return { text: 'Noted.' };
      // Life 1 holds the reply, so the run is live when the app dies.
      if (life === 1) return { text: 'x', pause: { afterEvents: 0, until: never } };
      return { toolCalls: [{ id: `r-${u}`, name: 'server_read', arguments: { q: u } }] };
    };
    const one = await openFor(envOf(world, 1), await world.open('recovered'), { script: script(1) });
    void one.journal.send('Read it.', 'a');
    await until(async () => one.model.requests.length > 0, 'the reply under way');
    one.journal.kill();
    const two = await openFor(envOf(world, 2), await world.open('recovered'), { script: script(2) });
    const a = await two.journal.send('Read it.', 'a');
    if (a.replied) expect(await a.turn.wait()).toMatchObject({ status: 'answered', text: 'Noted.' });
    expect(world.counters.get('starts:server_read')).toBe(0);
    expect(two.model.requests.some((r) => r.messages.some((m) => m.role === 'tool' && /resumed after a restart, so server tools aren't used in it/.test(m.content)))).toBe(true);
    const b = await two.journal.send('Read again.', 'b');
    if (b.replied) await b.turn.wait();
    expect(world.counters.get('starts:server_read')).toBe(1);
    await two.journal.close();
  });
});
