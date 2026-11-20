// P2's preconditions (the MCP rebuild, docs/mcp-design.md): every way pi-durable 1.5.2 could admit a
// submission, run a boundary or start a run on its own is pinned off, and each pin has a test here. With
// them, Familiar never starts or places a run: only your message, your answer and Send now do, and her
// line never does. An upgrade of pi-durable must recheck these against its new spec first.

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { IDBFactory } from 'fake-indexeddb';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { decideByRules, journalSettings, openJournal, openJournalStore, type JournalStore } from '../../src/index.ts';
import { createFakeModel } from '../../src/testing/index.ts';
import { memoryOwner, nodeWorld } from './node-env.ts';
import { openFor, type Env } from './scenarios.ts';
import { mutations } from '../../src/mutations.ts';
import { compactionWorld, isSummary, recordCommits, statusOf } from './pi-durable-world.ts';

const ctx = BACKGROUND_CONTEXT;
const src = join(import.meta.dirname, '..', '..', 'src');

async function open(store: JournalStore, modelId = 'fake-1', script: Parameters<typeof createFakeModel>[0] = () => ({ text: 'ok' })) {
  const model = createFakeModel(script);
  const journal = await openJournal({
    store,
    owner: memoryOwner(),
    model,
    modelId,
    caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
    tools: [],
    wake: { wakeAt: () => {} },
    notifier: { notify: () => {} },
    consent: { ask: async () => true },
    presence: { report: () => {} },
    persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
    decider: { decide: async (event, context) => decideByRules(event, context) },
    ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
    resendDelayMs: 50
  });
  return { journal, model };
}

describe('2.5: the settings pins', () => {
  it('background compaction is off, with no model override; afterFailedRun and the queue modes are left at their defaults', () => {
    const s: any = journalSettings();
    expect(s.compaction).toEqual({ backgroundTokens: 0 });
    expect(s.compaction.modelOverrides).toBeUndefined();
    // Absent means pi-durable's defaults: "keep", "one-at-a-time" and "one-at-a-time" (spec:528-530).
    expect(s).not.toHaveProperty('afterFailedRun');
    expect(s).not.toHaveProperty('followUpMode');
    expect(s).not.toHaveProperty('steeringMode');
    expect(s).not.toHaveProperty('extensions');
  });

  it("the journal's engine runs with exactly those settings, one extension (Familiar's own), and no afterRun, onYield or compaction hook", async () => {
    const store = await openJournalStore('pins-setup', { indexedDB: new IDBFactory() as any });
    const { journal } = await open(store);
    const setup = journal.setup();
    expect(setup.settings).toEqual(journalSettings(50));
    expect(setup.extensions).toEqual(['familiar']);
    const hooks = setup.hooks.flatMap((h) => h.hooks);
    expect(hooks.sort()).toEqual(['afterTool', 'afterTools', 'beforeTool']);
    expect(setup.hooks.map((h) => h.task)).not.toContain('pi.compaction');
    expect(hooks).not.toContain('afterRun');
    expect(hooks).not.toContain('onYield');
    await journal.close();
  });
});

describe('2.5 row 1: a compaction task made before the pin', () => {
  it('is aborted at open, before anything is scheduled: B stays queued and the step-cap question stays open', async () => {
    // A bare engine with the default policy leaves a background compaction pending, with B queued
    // behind a step cap, and is killed.
    const before = await compactionWorld(undefined);
    expect(before.w.log.some((c) => (c.livePost?.compactions ?? []).length > 0)).toBe(true);
    before.w.kill();
    // The journal opens that store (the same root, the same model id).
    const store = await openJournalStore(before.w.name, { indexedDB: before.w.factory as any });
    let summaries = 0;
    const { journal } = await open(store, 'm', (request) => {
      if (isSummary(request)) summaries++;
      return { text: 'ok' };
    });
    await new Promise((r) => setTimeout(r, 200));
    const inspect: any = await journal.inspect();
    const compactions = (inspect.tasks ?? []).filter((t: any) => t.kind === 'pi.compaction');
    expect(summaries).toBe(0);
    expect(compactions.every((t: any) => t.state?.status === 'terminal' || t.status === 'terminal')).toBe(true);
    expect((await journal.questions()).map((q) => q.kind)).toEqual(['steps']);
    expect((await journal.queued())).toBeUndefined();
    await journal.close();
    void ctx;
    void statusOf;
  });
});

/* ---------- the module graph ---------- */

/** Core's own source files that its entry pulls in, with comments stripped. */
async function coreSources(): Promise<{ file: string; code: string }[]> {
  const r = await build({ entryPoints: [join(src, 'index.ts')], bundle: true, platform: 'neutral', format: 'esm', write: false, metafile: true, logLevel: 'silent', packages: 'external' });
  return Object.keys(r.metafile.inputs)
    .filter((i) => !i.includes('node_modules'))
    .map((i) => {
      // Forward slashes on every platform: on Windows `relative` gives `journal\journal.ts`.
      const file = relative(src, join(process.cwd(), i)).split(sep).join('/');
      const text = readFileSync(join(process.cwd(), i), 'utf8');
      // Comments out: block comments, then line comments not inside a string (a rough cut, enough here).
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      return { file, code };
    });
}

/**
 * The spans of code that run only under a named mutation switch (mutations.ts), off in the app: the branch
 * a guard condition picks. A guard is an `&&` chain with `mutant(...)` or `__FAMILIAR_MUTATIONS__` as one
 * of its conjuncts (false in the app, so the whole chain is). Guarded: an `if`'s then-branch, a
 * conditional's true branch, and the right side of `guard && …`. Read from the parsed source, so a real
 * call site sharing a line with a switch is still a call site.
 */
function mutationSpans(code: string): [number, number][] {
  const sf = ts.createSourceFile('core.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const strip = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? strip(e.expression) : e);
  const guards = (e: ts.Expression): boolean => {
    const x = strip(e);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return guards(x.left) || guards(x.right);
    if (ts.isIdentifier(x)) return x.text === '__FAMILIAR_MUTATIONS__';
    return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'mutant';
  };
  const spans: [number, number][] = [];
  const span = (n: ts.Node) => spans.push([n.getStart(sf), n.getEnd()]);
  const walk = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && guards(n.expression)) span(n.thenStatement);
    else if (ts.isConditionalExpression(n) && guards(n.condition)) span(n.whenTrue);
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && guards(n.left)) span(n.right);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return spans;
}

// A call site inside a mutation-only branch is the harness's control, off in the app, and isn't one; the
// last test of the module graph holds that nothing in core turns a switch on. Each match counts once.
const sitesOf = (files: { file: string; code: string }[], pattern: RegExp) =>
  files.flatMap(({ file, code }) => {
    const spans = mutationSpans(code);
    const all = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    return [...code.matchAll(all)].flatMap((m) => {
      const at = m.index ?? 0;
      if (spans.some(([a, b]) => at >= a && at < b)) return [];
      const line = code.slice(code.lastIndexOf('\n', at) + 1, code.indexOf('\n', at) < 0 ? code.length : code.indexOf('\n', at));
      return [`${file}: ${line.trim()}`];
    });
  });

/** The old scan, kept as the control below: it dropped every line that mentions a switch. */
const lineSites = (files: { file: string; code: string }[], pattern: RegExp) =>
  files.flatMap(({ file, code }) => code.split('\n').flatMap((line) => (pattern.test(line) && !line.includes('mutant(') ? [`${file}: ${line.trim()}`] : [])));

describe('2.5: the module graph', () => {
  it('reads call sites, not lines: a real call on a line with a switch is found, and only the branch the switch guards is skipped', () => {
    const code = [
      "const a = (__FAMILIAR_MUTATIONS__ && mutant('m')) ? root.submit(x, ctx) : root.submit(y, ctx);",
      "if ((__FAMILIAR_MUTATIONS__ && mutant('n'))) void root.submit(z, ctx);",
      "const b = ready && (__FAMILIAR_MUTATIONS__ && mutant('o')) && root.submit(w, ctx);",
      "if (!(__FAMILIAR_MUTATIONS__ && mutant('p'))) root.submit(v, ctx); // a negated switch guards nothing"
    ].join('\n');
    const files = [{ file: 'x.ts', code: code.replace(/\/\/.*$/gm, '') }];
    expect(sitesOf(files, /root\.submit\(/)).toEqual(['x.ts: ' + code.split('\n')[0], 'x.ts: ' + code.split('\n')[3]!.replace(/\s*\/\/.*$/, '')]);
    // The control: the old line scan misses both real sites.
    expect(lineSites(files, /root\.submit\(/)).toEqual([]);
  });

  it('pulls in the journal, and finds call sites in it (the scan can see)', async () => {
    const files = await coreSources();
    expect(files.map((f) => f.file)).toContain('journal/journal.ts');
    expect(sitesOf(files, /root\.submit\(/).length).toBeGreaterThan(0);
  });

  it('no compact, reset, handoff, terminate, raw submission, conversation or submission abort, configure, steer, afterRun or onYield anywhere in core', async () => {
    const files = await coreSources();
    expect(sitesOf(files, /\bcompact\(/)).toEqual([]);
    expect(sitesOf(files, /\breset\(/)).toEqual([]);
    expect(sitesOf(files, /\bhandoff\s*:/)).toEqual([]);
    expect(sitesOf(files, /\bterminate\s*:/)).toEqual([]);
    expect(sitesOf(files, /createSubmission/)).toEqual([]);
    expect(sitesOf(files, /appendEntry\(/)).toEqual([]);
    expect(sitesOf(files, /\.configure\(/)).toEqual([]);
    expect(sitesOf(files, /whenBusy|whenIdle|steeringMode|followUpMode|afterFailedRun|modelOverrides/)).toEqual([]);
    expect(sitesOf(files, /\bafterRun\b|\bonYield\b/)).toEqual([]);
    // No compaction hook at all: nothing declines, supplies or watches a summary.
    expect(sitesOf(files, /\bbeforeCompact\b|\bafterCompact\b|CompactionTask/)).toEqual([]);
    expect(sitesOf(files, /[{,]\s*(decline|summary)\s*:/)).toEqual([]);
    expect(sitesOf(files, /api\.conversation\(/)).toEqual([]);
    // An abort on a conversation or a submission handle: `.abort(ctx)` or `.abort(context)`.
    expect(sitesOf(files, /\.abort\(\s*(ctx|context)\b/)).toEqual([]);
  });

  it('submits only from send, answer, Send now and her line, plus the two display-only writes, the bound notice and the reminder line', async () => {
    const files = await coreSources();
    const sites = sitesOf(files, /\.submit\(/);
    expect(sites).toHaveLength(6);
    expect(sites.every((s) => s.startsWith('journal/journal.ts: '))).toBe(true);
    const text = sites.join('\n');
    // send (input or familiar.ack), through submitInTurn
    expect(text).toContain('String(await root.submit(tx, draft))');
    // answer
    expect(text).toContain('String(await root.submit(tx, draft)) :');
    // Send now
    expect(text).toContain("root.submit(tx, { type: 'continue', requestId })");
    // her line
    expect(text).toContain('await root.submit(tx, {');
    // the bound notice and the reminder line: display-only, kind and data only
    expect(text).toMatch(/root\.submit\(\{ type: 'write', entry: \{ kind: NoticeEntry, data: \{ text: words \} \}/);
    expect(text).toMatch(/chat\.submit\(tx, \{ type: 'write', entry: \{ kind: ReminderEntry, data: \{/);
    // A continue is drafted only by an answer and by Send now.
    expect(sitesOf(files, /type: 'continue'/)).toHaveLength(2);
    // The one task that submits is the wake's delivery, through its runtime's conversation handle.
    expect(sitesOf(files, /runtime\.conversation\(/)).toEqual([expect.stringContaining('journal/journal.ts: ')]);
  });

  it('turns no named mutation on: only mutations.ts itself touches the switches', async () => {
    const files = await coreSources();
    expect(sitesOf(files, /mutations\.set\(|\bon\.add\(/).filter((s) => !s.startsWith('mutations.ts: '))).toEqual([]);
  });
});

/* ---------- row 10: every write but her line is display-only ---------- */

describe('2.5 row 10: display-only writes', () => {
  /** Runs every Familiar write once, and says what's wrong with them: empty when each is display-only. */
  async function writesProblems(name: string): Promise<string[]> {
    const problems: string[] = [];
    const world = nodeWorld();
    const store = await world.open(name);
    const log = recordCommits(store.storage);
    const env: Env = { life: 1, counters: world.counters, owner: world.owner, openStore: world.open, ready: () => {}, onTransaction: () => () => {} };
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, name: 'look', arguments: { what: String(i) } }));
    const { journal } = await openFor(env, store, {
      script: (r) => (r.system === 'One line.' ? { text: 'Hello there.' } : r.messages.some((m) => m.role === 'tool') ? { text: 'Looked.' } : { toolCalls: nine })
    });
    const a = await journal.send('Look at nine things.', 'a');
    if (a.replied) await a.turn.wait();
    expect((await journal.send('thanks', 'b')).replied).toBe(false);
    await journal.parkUntil('Water the plants.', Date.now() + 30);
    for (let i = 0; i < 100 && !(await journal.transcript()).some((e) => e.kind === 'familiar.reminder'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(await journal.remark({ system: 'One line.', messages: [{ role: 'user', content: 'Say hi.' }] })).toMatchObject({ visible: true });
    const writes = log.flatMap((c) => c.entries).filter((e) => e.kind.startsWith('familiar.'));
    expect(new Set(writes.map((e) => e.kind))).toEqual(new Set(['familiar.notice', 'familiar.ack', 'familiar.reminder', 'familiar.remark']));
    // Only her visible line carries a model message; none carries a head or edits, hers included.
    for (const e of writes) {
      if (e.model && e.kind !== 'familiar.remark') problems.push(`${e.kind} carries a model message`);
      if (e.head) problems.push(`${e.kind} carries a head`);
      if (e.edits) problems.push(`${e.kind} carries edits`);
    }
    if (!writes.some((e) => e.kind === 'familiar.remark' && e.model)) problems.push('no visible remark was written, so the check saw nothing');
    // Each was a submission, never a raw append: its commit stored a write submission settled done.
    for (const c of log.filter((x) => x.entries.some((e) => e.kind.startsWith('familiar.')))) if (!c.submissions.some((s) => s.type === 'write' && s.status === 'done')) problems.push(`commit ${c.seq} appended a write with no write submission`);
    await journal.close();
    return problems;
  }

  it('the bound notice, the reminder line and familiar.ack carry no model, head or edits; only a visible remark carries a model', async () => {
    expect(await writesProblems('pins-writes')).toEqual([]);
  });

  it('the control: an ack written with a head fails the check', async () => {
    mutations.set(['ack-head']);
    try {
      const problems = await writesProblems('pins-writes-mutant');
      expect(mutations.hits('ack-head')).toBeGreaterThan(0);
      expect(problems).toEqual(['familiar.ack carries a head']);
    } finally {
      mutations.clear();
    }
  });
});

/* ---------- 5.5: only the gate mints ---------- */

describe('5.5: decisions are minted only by the gate', () => {
  it("core's graph mints in one place, the journal's tool execute, and nothing in core but `send` marks one used", async () => {
    const files = await coreSources();
    expect(sitesOf(files, /\bmintDecision\(/).filter((s) => !s.startsWith('mcp/decision.ts: '))).toEqual([expect.stringMatching(/^journal\/tools\.ts: /)]);
    expect(sitesOf(files, /\bmarkUsed\(/).filter((s) => !s.startsWith('mcp/decision.ts: '))).toEqual([expect.stringMatching(/^mcp\/client\.ts: /)]);
    // The app's entry never reaches the test-only consent helpers.
    expect(files.map((f) => f.file)).not.toContain('testing/consent.ts');
    // A tools/call is framed only by the link's handoff, which only send reaches.
    expect(sitesOf(files, /\bframeCall\(/).filter((s) => !s.startsWith('mcp/wire/framing.ts: '))).toEqual([expect.stringMatching(/^mcp\/wire\/link\.ts: /)]);
    expect(sitesOf(files, /\.handoff\(/)).toEqual([expect.stringMatching(/^mcp\/client\.ts: /)]);
  });
});

/* ---------- 5.9: the reserved namespace ---------- */

describe('5.9: `__` is reserved for server tools', () => {
  it("no built-in's name holds it, and the journal refuses a built-in that does", async () => {
    const { RUN_WITHOUT_ASKING, BUILT_IN_READS } = await import('../../src/index.ts');
    expect([...RUN_WITHOUT_ASKING, ...BUILT_IN_READS].filter((n) => n.includes('__'))).toEqual([]);
    const store = await openJournalStore('pins-names', { indexedDB: new IDBFactory() as any });
    const model = createFakeModel(() => ({ text: 'ok' }));
    await expect(
      openJournal({
        store,
        owner: memoryOwner(),
        model,
        modelId: 'fake-1',
        caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
        tools: [{ name: 'files__read', description: '', inputSchema: {}, kind: 'read', doing: () => 'x', run: async () => '' }],
        wake: { wakeAt: () => {} },
        notifier: { notify: () => {} },
        consent: { ask: async () => true },
        presence: { report: () => {} },
        persona: { id: 'olive', name: 'Olive', instructions: '' },
        decider: { decide: async (event, context) => decideByRules(event, context) },
        ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false })
      })
    ).rejects.toThrow(/may not have __/);
  });

  it('an open that fails, before or after the engine opens, gives the journal back: the next open with the same owner goes ahead', async () => {
    const owner = memoryOwner();
    const base = {
      owner,
      model: createFakeModel(() => ({ text: 'ok' })),
      modelId: 'fake-1',
      caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
      tools: [],
      wake: { wakeAt: () => {} },
      notifier: { notify: () => {} },
      consent: { ask: async () => true },
      presence: { report: () => {} },
      persona: { id: 'olive', name: 'Olive', instructions: '' },
      decider: { decide: async (event: any, context: any) => decideByRules(event, context) },
      ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium' as const, doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false })
    };
    const factory = new IDBFactory();
    // A store handle per open, as the app makes one: a failed open closes the engine, and its storage with it.
    const storeOf = () => openJournalStore('pins-lease', { indexedDB: factory as any });
    const free = async () => Promise.race([owner.acquire('pins-lease').then((l) => (l.release(), 'acquired')), new Promise((r) => setTimeout(() => r('held'), 200))]);
    // A bad name.
    await expect(openJournal({ ...base, store: await storeOf(), tools: [{ name: 'bad__name', description: '', inputSchema: {}, kind: 'effect', doing: () => 'x', run: async () => '' }] } as any)).rejects.toThrow(/__/);
    expect(await free()).toBe('acquired');
    // A failure once the engine is open: the persona's instructions, first read for the conversation's agent.
    const persona = { id: 'olive', name: 'Olive', get instructions(): string { throw new Error('no instructions'); } };
    await expect(openJournal({ ...base, store: await storeOf(), persona } as any)).rejects.toThrow(/no instructions/);
    expect(await free()).toBe('acquired');
    // And then a good open of the same journal.
    const journal = await openJournal({ ...base, store: await storeOf() } as any);
    await journal.close();
  });
});
