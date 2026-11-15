// A person's actions are atomic and idempotent: an answer and what it starts are one commit, and a
// message sent again with the same request id gets the first send's result, whatever has changed since.
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../src/index.ts';
import { nodeWorld, type NodeWorld } from './node-env.ts';
import { openFor, type Env } from './scenarios.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lastIsTool = (r: ModelRequest) => r.messages.at(-1)?.role === 'tool';
const toolResults = (r: ModelRequest) => r.messages.filter((m) => m.role === 'tool').length;
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

describe('answering a question', () => {
  it('a kill at any point of an answer leaves it all done or not done; answering again gives the same result, and the turn goes on once', async () => {
    const problems: string[] = [];
    for (let k = 1; k <= 12; k++) {
      const world = nodeWorld();
      // Three tool steps with a step cap of 2: the turn asks after the second.
      const script = (r: ModelRequest) => (toolResults(r) < 3 ? { toolCalls: [{ id: `c${toolResults(r)}`, name: 'note_add', arguments: { text: `n${toolResults(r)}` } }] } : { text: 'All noted.' });
      const one = await openFor(envOf(world, 1), await world.open('answer'), { script, stepCap: 2 });
      const sent = await one.journal.send('Note two things.', 'r1');
      if (!sent.replied) throw new Error('no reply');
      const end = await sent.turn.wait();
      if (end.status !== 'asks') throw new Error(`expected a question, got ${JSON.stringify(end)}`);
      // The kill lands right after the k-th transaction of the answer.
      let n = 0;
      let killed = false;
      const stop = envOf(world, 1).onTransaction(() => {
        if (killed || ++n < k) return;
        killed = true;
        one.journal.kill();
      });
      await one.journal.answer(end.question.id, true, 'go-1').catch(() => undefined);
      while (!killed) await sleep(2);
      stop();

      const two = await openFor(envOf(world, 2), await world.open('answer'), { script, stepCap: 2 });
      const again = await two.journal.answer(end.question.id, true, 'go-1');
      if (!again) problems.push(`kill after transaction ${k}: answering again started nothing; the turn is stuck`);
      else {
        const last = await again.wait();
        if (last.status !== 'answered') problems.push(`kill after transaction ${k}: the turn ended ${JSON.stringify(last)}`);
        const third = await two.journal.answer(end.question.id, true, 'go-2');
        if (third?.id !== again.id) problems.push(`kill after transaction ${k}: a third answer gave ${third?.id}, not ${again.id}`);
      }
      const rows = ((await two.journal.read((await import('./scenarios.ts')).NotesDoc))?.notes ?? []).map((x) => x.text);
      if (JSON.stringify(rows) !== JSON.stringify(['n0', 'n1', 'n2'])) problems.push(`kill after transaction ${k}: notes ${JSON.stringify(rows)}`);
      await two.journal.close();
    }
    expect(problems).toEqual([]);
  });
});

describe('sending a message', () => {
  it('a resend finds the first send by its request id before it reads the text again: an "ok" that answered her stays a turn', async () => {
    const world = nodeWorld();
    const script = (r: ModelRequest) => {
      const last = r.messages.at(-1);
      return last?.role === 'user' && last.content === 'ok' ? { text: 'Saved it.' } : { text: 'Shall I save it?' };
    };
    const one = await openFor(envOf(world, 1), await world.open('send'), { script });
    const first = await one.journal.send('I like this one.', 'r1');
    if (first.replied) await first.turn.wait();
    const ok = await one.journal.send('ok', 'r2');
    expect(ok.replied).toBe(true);
    if (!ok.replied) return;
    expect(await ok.turn.wait()).toMatchObject({ status: 'answered', text: 'Saved it.' });
    // Her last message no longer asks anything, so "ok" read again would be a bare acknowledgement.
    one.journal.kill();

    const two = await openFor(envOf(world, 2), await world.open('send'), { script });
    const resent = await two.journal.send('ok', 'r2');
    expect(resent.replied).toBe(true);
    if (!resent.replied) return;
    expect(resent.turn.id).toBe(ok.turn.id);
    expect(await resent.turn.wait()).toMatchObject({ status: 'answered', text: 'Saved it.' });
    expect(two.model.requests).toHaveLength(0);
    // And a bare "thanks" resent stays an acknowledgement, with its first reaction.
    const thanks = await two.journal.send('thanks', 'r3');
    const thanksAgain = await two.journal.send('thanks', 'r3');
    expect(thanks).toMatchObject({ replied: false });
    expect(thanksAgain).toEqual(thanks);
    expect((await two.journal.transcript()).filter((e) => e.kind === 'familiar.ack')).toHaveLength(1);
    await two.journal.close();
  });
});
