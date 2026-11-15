// The bounds on tool calls: at most TOOL_CALLS_PER_REPLY calls of one reply run, and at most
// TOOL_CALLS_PER_TURN in one turn, counted in the journal, so restarts, resumes and "go on" can't reset
// them. A refused call never runs, and says why.
import { describe, expect, it } from 'vitest';
import { admit, emptyBudget, TOOL_CALLS_PER_REPLY, TOOL_CALLS_PER_TURN, type ModelRequest } from '../../src/index.ts';
import type { FakeReply } from '../../src/testing/index.ts';
import { nodeWorld, type NodeWorld } from './node-env.ts';
import { openFor, type Env } from './scenarios.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const REPLY_WORDS = `Familiar stopped after ${TOOL_CALLS_PER_REPLY} tool calls in one reply.`;
const TURN_WORDS = `Familiar stopped after ${TOOL_CALLS_PER_TURN} tool calls in this turn.`;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Which turn and reply a request is for: turns are your messages, replies count from your message. */
function position(r: ModelRequest): { turn: number; reply: number } {
  const turn = r.messages.filter((m) => m.role === 'user' && m.content.startsWith('Turn ')).length - 1;
  const lastUser = r.messages.map((m) => m.role).lastIndexOf('user');
  return { turn, reply: r.messages.slice(lastUser).filter((m) => m.role === 'assistant').length };
}

/** A model that, in turn t, gives plan[t][k] tool calls in its k-th reply, then answers. */
function planned(plan: number[][], tool = (_t: number, _r: number, _i: number) => 'look') {
  return (r: ModelRequest): FakeReply => {
    const { turn, reply } = position(r);
    const n = plan[turn]?.[reply];
    if (n === undefined) return { text: `Turn ${turn} done.` };
    return {
      toolCalls: Array.from({ length: n }, (_, i) => {
        const name = tool(turn, reply, i);
        const key = `${turn}.${reply}.${i}`;
        return { id: `k${turn}-${reply}-${i}`, name, arguments: name === 'look' ? { what: key } : { to: key, text: 'hi' } };
      })
    };
  };
}

const envOf = (world: NodeWorld, life = 1): Env => ({ life, counters: world.counters, owner: world.owner, openStore: world.open, ready: () => {} });

/** Every tool result the model was sent, by call id. */
function results(requests: readonly ModelRequest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of requests) for (const m of r.messages) if (m.role === 'tool') out.set(m.toolCallId, m.content);
  return out;
}

/** Answers yes to the step cap until the turn ends. */
async function finish(journal: any, turn: any) {
  for (let end = await turn.wait(), n = 0; ; end = await turn.wait(), n++) {
    if (end.status !== 'asks' || n > 20) return end;
    turn = await journal.answer(end.question.id, end.question.kind === 'steps', `go-${end.question.id}`);
    if (!turn) return end;
  }
}

describe('the bound, as a rule', () => {
  it('lets 8 calls of one reply through and refuses the rest; 32 in a turn, then refuses', () => {
    const b = emptyBudget('t');
    const verdicts = Array.from({ length: 20 }, (_, i) => admit(b, `s${i}`, i));
    expect(verdicts.filter((v) => v.ok)).toHaveLength(8);
    expect(verdicts.slice(8)).toEqual(Array(12).fill({ ok: false, bound: 'reply' }));
    for (let i = 8; i < 32; i++) expect(admit(b, `r${i}`, i % 8)).toEqual({ ok: true });
    expect(admit(b, 'last', 0)).toEqual({ ok: false, bound: 'turn' });
    // Asked again, as after a restart: an admitted call stays admitted, a refused one stays refused.
    expect(admit(b, 's3', 3)).toEqual({ ok: true });
    expect(admit(b, 's12', 0)).toEqual({ ok: false, bound: 'reply' });
    expect(b.admitted).toHaveLength(32);
  });
});

describe('the bound, in the journal', () => {
  it('a reply with 20 calls runs 8 and refuses 12, each with the reason, and says so once in chat', async () => {
    const world = nodeWorld();
    const ran: string[] = [];
    const { journal, model } = await openFor(envOf(world), await world.open('twenty'), { script: planned([[20]]), onRun: (_n, a) => ran.push(a.what) });
    const sent = await journal.send('Turn 0', 'r0');
    if (!sent.replied) throw new Error('no reply');
    expect(await sent.turn.wait()).toMatchObject({ status: 'answered' });
    expect(ran).toEqual(Array.from({ length: 8 }, (_, i) => `0.0.${i}`));
    const res = results(model.requests);
    for (let i = 8; i < 20; i++) expect(res.get(`k0-0-${i}`)).toMatch(new RegExp(`${REPLY_WORDS.replace(/\./g, '\\.')} This call was not run\\.`));
    const lines = (await journal.transcript()).filter((e) => e.kind === 'familiar.notice');
    expect(lines.map((l) => l.text)).toEqual([REPLY_WORDS]);
    await journal.close();
  });

  it('a turn reaching 32 across replies, a step-cap "go on" and a restart refuses the 33rd', async () => {
    const world = nodeWorld();
    const ran = new Set<string>();
    // Five replies of 8 calls: 40 asked for. The step cap (3) asks twice; a restart lands mid-turn.
    const plan = [[8, 8, 8, 8, 8]];
    let hangAt = 20;
    const open = async (life: number) =>
      openFor(envOf(world, life), await world.open('thirty-two'), {
        script: planned(plan),
        stepCap: 3,
        onRun: (_n, a) => ran.add(a.what),
        hang: (n) => n === 'look' && world.counters.get('starts:look') === hangAt
      });
    const first = await open(1);
    void first.journal.send('Turn 0', 'r0');
    while (world.counters.get('starts:look') < hangAt) await sleep(5);
    first.journal.kill();
    hangAt = -1;
    const second = await open(2);
    const sent = await second.journal.send('Turn 0', 'r0');
    if (!sent.replied) throw new Error('no reply');
    expect(await finish(second.journal, sent.turn)).toMatchObject({ status: 'answered' });
    expect(ran.size).toBe(32);
    const res = results([...first.model.requests, ...second.model.requests]);
    for (let i = 0; i < 8; i++) {
      expect(ran.has(`0.4.${i}`)).toBe(false);
      expect(res.get(`k0-4-${i}`)).toContain(TURN_WORDS);
    }
    expect((await second.journal.transcript()).filter((e) => e.kind === 'familiar.notice').map((e) => e.text)).toEqual([TURN_WORDS]);
    // Your next message is a new turn, with a new 32.
    const next = await second.journal.send('Turn 1', 'r1');
    plan.push([3]);
    if (next.replied) await finish(second.journal, next.turn);
    expect([...ran].filter((k) => k.startsWith('1.'))).toHaveLength(3);
    await second.journal.close();
  });
});

/* ---------- the property: random replies, every tool allowed, restarts mixed in ---------- */

/**
 * Waits until the turn has settled and nothing runs, answering yes to every step-cap question, including
 * one a restart left, which a message sent meanwhile would otherwise queue behind.
 */
async function drain(o: Awaited<ReturnType<typeof openFor>>, turn: { wait(): Promise<unknown> }) {
  let settled = false;
  void turn.wait().then(() => (settled = true), () => (settled = true));
  for (let quiet = 0; quiet < 3; ) {
    await sleep(10);
    const state = o.presence.at(-1)?.state;
    const q = (await o.journal.questions()).find((x) => x.kind === 'steps');
    if (q) {
      quiet = 0;
      await o.journal.answer(q.id, true, `go-${q.id}`);
      continue;
    }
    quiet = settled && (state === 'idle' || state === 'waiting' || state === 'error') ? quiet + 1 : 0;
  }
}

async function boundRun(seed: number): Promise<{ problems: string[]; refused: number; kills: number }> {
  const rand = rng(seed);
  const world = nodeWorld();
  const turns = 2 + Math.floor(rand() * 2);
  const plan = Array.from({ length: turns }, () => Array.from({ length: 1 + Math.floor(rand() * 6) }, () => Math.floor(rand() * 21)));
  const effect = (t: number, r: number, i: number) => ((t * 31 + r * 7 + i) % 5 === 0 ? 'send_message' : 'look');
  const ran: string[] = [];
  const total = plan.flat().reduce((x, y) => x + y, 0);
  // Kill points: the n-th tool start, where that start is a read, which hangs so the kill lands mid-call.
  const targets = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => 1 + Math.floor(rand() * Math.max(1, Math.min(total, 60)))))].sort((x, y) => x - y);
  const requests: ModelRequest[] = [];
  const starts = () => world.counters.get('starts:look') + world.counters.get('starts:send_message');
  let life = 0;
  let hung = false;
  let current: Awaited<ReturnType<typeof openFor>>;
  const open = async () => {
    life++;
    hung = false;
    current = await openFor(envOf(world, life), await world.open('property'), {
      script: planned(plan, effect),
      stepCap: 2 + Math.floor(rand() * 4),
      onRun: (n, a) => ran.push(n === 'look' ? a.what : a.to),
      hang: (n) => {
        if (n !== 'look' || starts() !== targets[0]) return false;
        targets.shift();
        hung = true;
        return true;
      }
    });
  };
  await open();
  for (let t = 0; t < turns; t++) {
    for (;;) {
      const j = current!.journal;
      const sent = await j.send(`Turn ${t}`, `turn-${t}`);
      if (!sent.replied) break;
      const outcome = await new Promise<'done' | 'killed'>((resolve) => {
        const poll = setInterval(() => hung && (clearInterval(poll), resolve('killed')), 2);
        drain(current!, sent.turn).then(
          () => (clearInterval(poll), resolve('done')),
          () => (clearInterval(poll), resolve('done'))
        );
      });
      if (outcome === 'done') break;
      requests.push(...current!.model.requests);
      j.kill();
      await open();
    }
  }
  requests.push(...current!.model.requests);
  for (const q of await current!.journal.questions()) await current!.journal.answer(q.id, false, `no-${q.id}`);
  await current!.journal.close();

  const problems: string[] = [];
  const distinct = [...new Set(ran)];
  for (let t = 0; t < turns; t++) {
    const inTurn = distinct.filter((k) => k.startsWith(`${t}.`));
    if (inTurn.length > TOOL_CALLS_PER_TURN) problems.push(`seed ${seed}: turn ${t} ran ${inTurn.length} calls`);
    for (let r = 0; r < plan[t]!.length; r++) {
      const inReply = inTurn.filter((k) => k.startsWith(`${t}.${r}.`));
      if (inReply.length > TOOL_CALLS_PER_REPLY) problems.push(`seed ${seed}: reply ${t}.${r} ran ${inReply.length} calls`);
    }
  }
  const res = results(requests);
  let refused = 0;
  for (const [id, content] of res) {
    if (!content.includes('Familiar stopped after')) continue;
    refused++;
    const key = id.slice(1).replace(/-/g, '.');
    if (ran.includes(key)) problems.push(`seed ${seed}: refused call ${key} ran`);
  }
  return { problems, refused, kills: life - 1 };
}

describe('the bound under random replies and restarts', () => {
  it('over 25 seeds: no reply runs more than 8 calls, no turn more than 32, and no refused call ever runs', { timeout: 240_000 }, async () => {
    const problems: string[] = [];
    let refused = 0;
    let kills = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const run = await boundRun(seed);
      problems.push(...run.problems);
      refused += run.refused;
      kills += run.kills;
    }
    expect(problems.slice(0, 5)).toEqual([]);
    // The bounds and the restarts were really exercised.
    expect(refused).toBeGreaterThan(50);
    expect(kills).toBeGreaterThan(15);
  });
});
