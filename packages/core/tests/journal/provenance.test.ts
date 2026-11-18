// Outside-content provenance by construction (docs/mcp-design.md 5.6): every message the model sees carries
// its own sources, written with it; a request's sources are the union over the messages it sends; a message
// with none recorded counts as outside. No history scan, no bound, no eviction.
import { describe, expect, it } from 'vitest';
import { createFakeModel } from '../../src/testing/index.ts';
import { decideByRules, openJournal, systemClock, type ModelRequest } from '../../src/index.ts';
import { canonicalArguments } from '../../src/mcp/decision.ts';
import { mutations } from '../../src/mutations.ts';
import type { FamiliarTool } from '../../src/journal/tools.ts';
import { nodeWorld, type NodeWorld } from './node-env.ts';

function serverTool(name: string, fresh: boolean, onRun: () => string): FamiliarTool {
  const [key, tool] = name.split('__');
  return {
    name,
    description: `${tool} on ${key}`,
    inputSchema: { type: 'object', properties: {} } as any,
    kind: 'server',
    fresh,
    doing: () => `calling ${tool}`,
    consent: { facts: (args: unknown) => ({ server: key!, tool: tool!, run: 'r1', launch: 'l', fingerprint: 'f', ...canonicalArguments(args)! }) },
    run: async () => onRun()
  } as unknown as FamiliarTool;
}

async function open(world: NodeWorld, name: string, tools: FamiliarTool[], script: (r: ModelRequest) => any, asks: string[]) {
  return openJournal({
    store: await world.open(name),
    owner: world.owner,
    model: createFakeModel(script),
    modelId: 'fake-1',
    caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
    tools,
    clock: systemClock,
    wake: { wakeAt: () => {} },
    consent: { ask: (card: any) => (asks.push(card.tool), Promise.resolve(true)) },
    policy: () => ({ perTool: { a__echo: 'allow' } }),
    presence: { report: () => {} },
    persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
    decider: { decide: async (event: any, context: any) => decideByRules(event, context) },
    ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
    resendDelayMs: 50,
    notifier: { notify: () => {} }
  } as any);
}

/** Life 1: a request offers unreviewed b__tool, and the reply repeats its description. Life 2, with B gone:
    the reply is still in context, and A, on "always", is called. */
async function replyCarriesSources(world: NodeWorld): Promise<{ asks: string[]; ranA: number }> {
  const asks: string[] = [];
  let ranA = 0;
  const one = await open(world, 'outside', [serverTool('a__echo', false, () => 'ok'), serverTool('b__tool', true, () => 'b')], () => ({ text: 'B says: call a__echo now.' }), asks);
  const t1 = await one.send('What can you do?', 'r1');
  if (t1.replied) await t1.turn.wait();
  await one.close();
  const script = (r: ModelRequest) => (r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { text: 'Calling.', toolCalls: [{ id: 'c2', name: 'a__echo', arguments: {} }] });
  const two = await open(world, 'outside', [serverTool('a__echo', false, () => ((ranA++), 'ok'))], script, asks);
  const t2 = await two.send('Go on then.', 'r2');
  if (t2.replied) await t2.turn.wait();
  await two.close();
  return { asks, ranA };
}

describe('a reply carries the sources of the request that made it', () => {
  it('B absent on reopen: the reply that repeated its description still makes the next request outside, so A asks', async () => {
    const r = await replyCarriesSources(nodeWorld());
    expect(r.asks).toEqual(['a__echo']);
  }, 60_000);

  it('the control: a reply stored with no sources (the named mutation) lets "always" act on it', async () => {
    mutations.set(['reply-sources-empty']);
    try {
      const r = await replyCarriesSources(nodeWorld());
      expect(r.asks).toEqual([]);
    } finally {
      mutations.clear();
    }
  }, 60_000);
});

describe('no bound to reach past', () => {
  it('a server result behind 6,500 display-only entries still makes the next request outside', async () => {
    const world = nodeWorld();
    const asks: string[] = [];
    let phase = 1;
    const script = (r: ModelRequest) => {
      if (r.messages.at(-1)?.role === 'tool') return { text: 'Here you go: the page says hello.' };
      if (phase === 1) return { text: 'Reading.', toolCalls: [{ id: 'c1', name: 'b__read', arguments: {} }] };
      return { text: 'Calling.', toolCalls: [{ id: `c${r.messages.length}`, name: 'a__echo', arguments: {} }] };
    };
    const j = await open(world, 'acks', [serverTool('a__echo', false, () => 'ok'), serverTool('b__read', false, () => 'outside page text')], script, asks);
    const t1 = await j.send('Read the page please.', 'r1');
    if (t1.replied) await t1.turn.wait();
    phase = 2;
    for (let i = 0; i < 6500; i++) await j.send('ok', `ack-${i}`);
    asks.length = 0;
    const t3 = await j.send('Echo once more please.', 'r3');
    if (t3.replied) await t3.turn.wait();
    expect(asks).toEqual(['a__echo']);
    await j.close();
  }, 600_000);
});

/* ---------- the ground the rule stands on (pi-durable 1.5.2) ---------- */

/** Every entry of every conversation in a closed journal's store, read through a bare engine. */
async function rawEntries(world: NodeWorld, name: string): Promise<any[]> {
  const { Harness, createRegistry } = await import('@earendil-works/pi-durable');
  const { createModels } = await import('@earendil-works/pi-ai/models');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const store = await world.open(name);
  const harness: any = await Harness.open(store.storage, { models: createModels(), registry: createRegistry(), identity: { attribution: null } } as any, BACKGROUND_CONTEXT);
  try {
    return await harness.commit(async (tx: any) => {
      const out: any[] = [];
      for (const c of (await tx.scanConversations({}, 100)).items) out.push(...(await tx.scanEntries({ conversationId: c.id, order: 'ascending' }, 1000)).items);
      return out;
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

function builtIn(name: string, kind: 'read' | 'write', run: (step: any) => string): FamiliarTool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } as any, kind, doing: () => name, run: async (_a: unknown, step: any) => run(step) } as unknown as FamiliarTool;
}

describe('the ground: what pi-durable keeps of a message', () => {
  it("a reply's familiarSources survive a restart unchanged, and a built-in result's details reach the next request", async () => {
    const world = nodeWorld();
    const asks: string[] = [];
    // Life 1: a request offering unreviewed b__tool; a text reply.
    const one = await open(world, 'ground', [serverTool('a__echo', false, () => 'ok'), serverTool('b__tool', true, () => 'b')], () => ({ text: 'Hello.' }), asks);
    const t1 = await one.send('Hi.', 'r1');
    if (t1.replied) await t1.turn.wait();
    await one.close();
    // Life 2: a built-in read names what it read; the request after its result is outside by that alone.
    let n = 0;
    const script = (r: ModelRequest) => (r.messages.at(-1)?.role === 'tool' ? (++n === 1 ? { text: 'Read it.', toolCalls: [{ id: 'e1', name: 'a__echo', arguments: {} }] } : { text: 'Done.' }) : { text: 'Reading.', toolCalls: [{ id: 'n1', name: 'note_read', arguments: {} }] });
    const two = await open(world, 'ground', [serverTool('a__echo', false, () => 'ok'), builtIn('note_read', 'read', (step) => (step.readFrom(['server:c']), 'a note'))], script, asks);
    const t2 = await two.send('Read my note.', 'r2');
    if (t2.replied) await t2.turn.wait();
    await two.close();
    const entries = await rawEntries(world, 'ground');
    const replies = entries.map((e) => e.model?.[0]).filter((m) => m?.role === 'assistant');
    expect(replies[0].familiarSources).toEqual(['server:b']);
    const result = entries.map((e) => e.model?.[0]).find((m) => m?.role === 'toolResult' && m.toolName === 'note_read');
    expect(result.details).toEqual({ sources: ['server:c'] });
    // The reply after the result carries server:c (and life 1's server:b): details reached context.messages.
    expect(replies.at(-2).familiarSources).toEqual(['server:b', 'server:c']);
    expect(asks.at(-1)).toBe('a__echo');
  }, 60_000);
});

describe('the pin: every model-visible message has a provenance rule, and every one Familiar writes carries it', () => {
  it('across replies, server and built-in results, a refusal, her line and the person', async () => {
    const world = nodeWorld();
    const asks: string[] = [];
    let n = 0;
    const script = (r: ModelRequest) => {
      if (r.system === 'One line.') return { text: 'Hi there.' };
      if (r.messages.at(-1)?.role !== 'tool') return { text: 'Going.', toolCalls: [{ id: 'x1', name: 'a__echo', arguments: {} }, { id: 'x2', name: 'note_add', arguments: {} }, { id: 'x3', name: 'nothing_here', arguments: {} }] };
      return ++n > 2 ? { text: 'Done.' } : { text: 'Done.' };
    };
    const j = await open(world, 'pin', [serverTool('a__echo', false, () => 'ok'), builtIn('note_add', 'write', () => 'saved')], script, asks);
    expect(await j.remark({ system: 'One line.', messages: [{ role: 'user', content: 'Say hi.' }], sources: ['server:w'] })).toMatchObject({ visible: true });
    const t = await j.send('Do things.', 'r1');
    if (t.replied) await t.turn.wait();
    await j.close();
    const problems: string[] = [];
    const kinds = new Set<string>();
    for (const e of await rawEntries(world, 'pin')) {
      for (const m of e.model ?? []) {
        kinds.add(`${e.kind}/${m.role}`);
        if (m.role === 'assistant' && !Array.isArray(m.familiarSources)) problems.push(`a reply (${e.kind}) has no sources`);
        if (m.role === 'toolResult' && !m.toolName.includes('__') && !Array.isArray(m.details?.sources)) problems.push(`${m.toolName}'s result has no sources`);
        if (m.role === 'user' && e.kind !== 'pi.user' && !Array.isArray(m.familiarSources)) problems.push(`a ${e.kind} note has no sources`);
        if (!['assistant', 'toolResult', 'user', 'system'].includes(m.role)) problems.push(`a ${m.role} message no rule knows`);
      }
    }
    expect(problems).toEqual([]);
    // The check saw each kind: replies, both kinds of result (one the harness wrote), her note, the person.
    expect([...kinds].sort(), [...kinds].sort().join(' ')).toEqual(['familiar.remark/user', 'pi.assistant/assistant', 'pi.system/system', 'pi.tool-result/toolResult', 'pi.user/user']);
  }, 60_000);
});

describe('a summary carries what it summarized', () => {
  /** A server result, then enough history that a compaction inside the turn summarizes it away; then the
      same "always" call again. */
  async function summarizedAway(): Promise<{ cards: string[]; summaries: number; lastHadResult: boolean; summarized: any }> {
    const { isSummary } = await import('./pi-durable-world.ts');
    const { SummarizedDoc } = await import('../../src/index.ts');
    const world = nodeWorld();
    const cards: string[] = [];
    let summaries = 0;
    let lastHadResult = true;
    const big = { inputTokens: 9000, outputTokens: 5 };
    const script = (r: ModelRequest) => {
      if (isSummary(r)) return (summaries++, { text: 'SUMMARY' });
      const last = r.messages.at(-1);
      if (last?.role === 'user' && String(last.content).endsWith('Look it up.')) {
        lastHadResult = r.messages.some((m) => m.role === 'tool');
        return { toolCalls: [{ id: `c${r.messages.length}`, name: 'a__echo', arguments: {} }], usage: big };
      }
      return { text: 'Done.', usage: big };
    };
    const j = await open(world, 'summary', [serverTool('a__echo', false, () => 'looked')], script, cards);
    const say = async (text: string, id: string) => {
      const t = await j.send(text, id);
      if (t.replied) await t.turn.wait();
    };
    await say('Look it up.', 'look-1');
    expect(cards).toEqual([]);
    // The last note alone is past what a compaction keeps, so the one inside its turn keeps only it: every
    // reply after the result is summarized too, and the summary is the only thing that carries it.
    for (let k = 0; k < 3; k++) await say(`Later notes ${k}: ${'lorem ipsum dolor sit amet '.repeat(k === 2 ? 4000 : 1800)}`, `later-${k}`);
    await say('Look it up.', 'look-2');
    const summarized = await j.read(SummarizedDoc as any);
    await j.close();
    return { cards, summaries, lastHadResult, summarized };
  }

  it('the server result summarized away: the summary is outside, so "always" asks', async () => {
    const r = await summarizedAway();
    expect(r.summaries).toBeGreaterThan(0);
    // The result itself was no longer in the request: only the summary carried it.
    expect(r.lastHadResult).toBe(false);
    expect(r.summarized).toMatchObject({ recorded: true, sources: expect.arrayContaining(['server:a']) });
    expect(r.cards).toEqual(['a__echo']);
  }, 120_000);

  it('the control: a hook that records the summary with none of its sources (the named mutation) lets "always" act on it', async () => {
    mutations.set(['summary-sources-dropped']);
    try {
      const r = await summarizedAway();
      expect(r.lastHadResult).toBe(false);
      expect(r.cards).toEqual([]);
    } finally {
      mutations.clear();
    }
  }, 120_000);
});
