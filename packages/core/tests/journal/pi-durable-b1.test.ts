// Build-start check B1 (docs/mcp-design.md, the rebuild): pi-durable 1.5.2's own run-failure and queue
// rules, observed on the real engine on a fake IndexedDB. The rebuild's question view, Send now and her
// line all rest on these, so they're pinned here: a pi-durable upgrade must pass this file first.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { decodeModelError } from '../../src/journal/provider.ts';
import { defineJournalDoc } from '../../src/journal/tools.ts';
import { commitOf, compactionWorld, fact, failedWorld, gate, isSummary, lastUser, runStarts, statusOf, sub, world, type World } from './pi-durable-world.ts';

const ctx = BACKGROUND_CONTEXT;

/* ---------- runFailure: set, and removed ---------- */

describe('B1: runFailure on pi-durable 1.5.2', () => {
  it('turn_limit is set in the commit that settles the inputs unanswered; the inbox is kept; run.inputs[0] holds across generations', async () => {
    const hold = gate();
    const w = await world({
      maxTurns: 3,
      script: (request) => {
        if (lastUser(request) === 'B') return { text: 'B done' };
        const results = request.messages.filter((m) => m.role === 'tool').length;
        return { toolCalls: [{ id: `c${results}`, name: 'look', arguments: { what: String(results) } }], ...(results === 0 ? { pause: { afterEvents: 0, until: hold.until } } : {}) };
      }
    });
    const a = await sub(w, { type: 'input', content: 'A' });
    await w.until(async () => !!(await w.live())?.run, 'A running');
    const b = await sub(w, { type: 'input', content: 'B' });
    expect(await statusOf(w, b.id)).toBe('queued');
    hold.open();
    await w.idle();
    const ended = commitOf(w.log, String(a.id), 'unanswered')!;
    fact('turn_limit end commit', { livePre: { run: ended.livePre?.run, runFailure: ended.livePre?.runFailure }, livePost: { run: ended.livePost?.run, runFailure: ended.livePost?.runFailure }, inboxPost: ended.inboxPost, submissions: ended.submissions });
    expect(ended.livePre.run).toBeDefined();
    expect(ended.livePost.run).toBeUndefined();
    expect(ended.livePost.runFailure).toMatchObject({ reason: 'turn_limit', detail: '3 turns' });
    expect(ended.livePost.runFailure.inputs.map(String)).toEqual([String(a.id)]);
    expect(ended.submissions.find((s) => s.id === String(a.id))!.reason).toBe('turn_limit');
    // afterFailedRun "keep": B stays queued, nothing started.
    expect(await statusOf(w, b.id)).toBe('queued');
    expect((await w.inbox()).items.map((i: any) => String(i.id))).toEqual([String(b.id)]);
    expect(runStarts(w.log)).toHaveLength(1);
    // run.inputs[0] across the run's three generations: one value, A's.
    const firsts = new Set(w.log.filter((c) => c.livePost?.run).map((c) => String(c.livePost.run.inputs?.[0])));
    const tasks = new Set(w.log.filter((c) => c.livePost?.run).map((c) => String(c.livePost.run.taskId)));
    fact('run.inputs[0] across generations', { firsts: [...firsts], generationTasks: tasks.size, first: [...new Set(w.log.filter((c) => c.livePost?.run).map((c) => String(c.livePost.run.first)))] });
    expect([...firsts]).toEqual([String(a.id)]);
    expect(tasks.size).toBeGreaterThanOrEqual(3);
    await w.close();
  });

  it('a cap pause through cappedPort ends model_error, with a decodable paused detail, and no resend', async () => {
    const w = await world({ script: () => ({ text: 'never' }) });
    w.setCap(true);
    const a = await sub(w, { type: 'input', content: 'A' });
    const t0 = Date.now();
    await w.idle();
    const ended = commitOf(w.log, String(a.id), 'unanswered')!;
    const f = ended.livePost.runFailure;
    fact('cap pause', { reason: f.reason, decoded: decodeModelError(f.detail), ms: Date.now() - t0, modelRequests: w.fake.requests.length });
    expect(ended.livePre.run).toBeDefined();
    expect(f.reason).toBe('model_error');
    expect(decodeModelError(f.detail)).toMatchObject({ kind: 'paused', pause: 'day-tokens' });
    // Not retried: the 2 s backoff never ran, and the endpoint saw nothing.
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(w.fake.requests).toHaveLength(0);
    await w.close();
  });

  it('abortTask (a Stop, or the park hook) ends aborted and keeps the inbox', async () => {
    const hold = gate();
    const w = await world({ script: (request) => (lastUser(request) === 'A' ? { text: 'slow', pause: { afterEvents: 0, until: hold.until } } : { text: 'ok' }) });
    const a = await sub(w, { type: 'input', content: 'A' });
    await w.until(async () => !!(await w.live())?.run, 'A running');
    const b = await sub(w, { type: 'input', content: 'B' });
    await w.harness.abortTask((await w.live()).run.taskId, ctx);
    await w.idle();
    const ended = commitOf(w.log, String(a.id), 'unanswered')!;
    fact('abortTask', { runFailure: ended.livePost.runFailure, inboxPost: ended.inboxPost.items.map((i: any) => i.id), b: await statusOf(w, b.id) });
    expect(ended.livePost.runFailure).toMatchObject({ reason: 'aborted' });
    expect(await statusOf(w, b.id)).toBe('queued');
    expect(runStarts(w.log)).toHaveLength(1);
    hold.open();
    await w.close();
  });

  it('the park hook: abortTask from afterTools ends aborted after the round, inbox kept', async () => {
    const hold = gate();
    const w = await world({
      parkOn: 'park',
      script: (request) => {
        if (lastUser(request) === 'B') return { text: 'B done' };
        return { toolCalls: [{ id: 'p1', name: 'look', arguments: { what: 'park' } }], pause: { afterEvents: 0, until: hold.until } };
      }
    });
    const a = await sub(w, { type: 'input', content: 'A' });
    await w.until(async () => !!(await w.live())?.run, 'A running');
    const b = await sub(w, { type: 'input', content: 'B' });
    hold.open();
    await w.idle();
    const ended = commitOf(w.log, String(a.id), 'unanswered')!;
    fact('park hook abort', { runFailure: ended.livePost.runFailure, b: await statusOf(w, b.id) });
    expect(ended.livePost.runFailure).toMatchObject({ reason: 'aborted' });
    expect(await statusOf(w, b.id)).toBe('queued');
    await w.close();
  });
});

/* ---------- what removes it ---------- */

describe('B1: what removes runFailure', () => {
  it('a new message, idle with an empty inbox: starts a run and removes runFailure in that commit', async () => {
    const { w } = await failedWorld(0);
    expect((await w.live()).runFailure.reason).toBe('turn_limit');
    const c = await sub(w, { type: 'input', content: 'C' });
    const started = commitOf(w.log, String(c.id), 'placed')!;
    fact('new message, empty inbox', { pre: started.livePre?.runFailure?.reason, postRun: !!started.livePost.run, postFailure: started.livePost.runFailure ?? null });
    expect(started.livePre.runFailure.reason).toBe('turn_limit');
    expect(started.livePost.run.inputs.map(String)).toEqual([String(c.id)]);
    expect(started.livePost.runFailure).toBeUndefined();
    await w.idle();
    await w.close();
  });

  it('a new message, idle with B queued: queues behind B and a final boundary starts B, removing runFailure in that commit', async () => {
    const { w, qs } = await failedWorld(1);
    const c = await sub(w, { type: 'input', content: 'C' });
    const started = commitOf(w.log, String(qs[0].id), 'placed')!;
    fact('new message, B queued', { sameCommit: started.submissions, postRunInputs: started.livePost.run.inputs, postFailure: started.livePost.runFailure ?? null, inboxPost: started.inboxPost.items.map((i: any) => i.id) });
    expect(started.submissions.some((s) => s.id === String(c.id) && s.status === 'queued')).toBe(true);
    expect(started.livePost.run.inputs.map(String)).toEqual([String(qs[0].id)]);
    expect(started.livePost.runFailure).toBeUndefined();
    expect(started.inboxPost.items.map((i: any) => String(i.id))).toEqual([String(c.id)]);
    await w.idle();
    await w.close();
  });

  it('a continue, idle: with an empty inbox it runs alone; with B queued, B is placed first; runFailure goes in that commit', async () => {
    const one = await failedWorld(0);
    const k1 = await sub(one.w, { type: 'continue' });
    const s1 = commitOf(one.w.log, String(k1.id), 'placed')!;
    expect(s1.livePost.run.inputs.map(String)).toEqual([String(k1.id)]);
    expect(s1.livePost.runFailure).toBeUndefined();
    await one.w.idle();
    await one.w.close();
    const two = await failedWorld(2);
    const k2 = await sub(two.w, { type: 'continue' });
    const s2 = commitOf(two.w.log, String(k2.id), 'placed')!;
    fact('continue with two queued', { runInputs: s2.livePost.run.inputs, queued: two.qs.map((q: any) => q.id), inboxPost: s2.inboxPost.items.map((i: any) => i.id), postFailure: s2.livePost.runFailure ?? null });
    // The oldest queued item first, then the continue; the second queued item stays (one-at-a-time).
    expect(s2.livePost.run.inputs.map(String)).toEqual([String(two.qs[0].id), String(k2.id)]);
    expect(s2.inboxPost.items.map((i: any) => String(i.id))).toEqual([String(two.qs[1].id)]);
    expect(s2.livePost.runFailure).toBeUndefined();
    await two.w.idle();
    await two.w.close();
  });

  it('a continue while busy throws ConversationBusy and writes nothing', async () => {
    const hold = gate();
    const w = await world({ script: () => ({ text: 'x', pause: { afterEvents: 0, until: hold.until } }) });
    await sub(w, { type: 'input', content: 'A' });
    await w.until(async () => !!(await w.live())?.run, 'A running');
    const before = w.log.length;
    await expect(sub(w, { type: 'continue' })).rejects.toThrow(/busy/i);
    expect(w.log.slice(before).some((c) => c.submissions.some((s) => s.type === 'continue'))).toBe(false);
    hold.open();
    await w.idle();
    await w.close();
  });
});

/* ---------- writes in every state ---------- */

const display = (n: string) => ({ type: 'write', entry: { kind: 'familiar.note', data: { text: n } } });
const modelWrite = (n: string) => ({ type: 'write', entry: { kind: 'familiar.remark', data: { text: n }, model: [{ role: 'assistant', content: [{ type: 'text', text: n }], api: 'x', provider: 'familiar', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 }] } });

async function writeIn(w: World, draft: any) {
  const s = await sub(w, draft);
  const c = w.log.find((x) => x.submissions.some((y) => y.id === String(s.id)))!;
  return {
    status: c.submissions.find((y) => y.id === String(s.id))!.status,
    appended: c.entries.map((e) => e.kind),
    startedRun: !c.livePre?.run && !!c.livePost?.run,
    runFailurePre: c.livePre?.runFailure?.reason ?? null,
    runFailurePost: c.livePost?.runFailure?.reason ?? null,
    inboxPost: (c.inboxPost?.items ?? []).map((i: any) => i.mode)
  };
}

describe('B1: writes in each state', () => {
  it('idle, empty inbox, no runFailure', async () => {
    const w = await world({ script: () => ({ text: 'ok' }) });
    const d = await writeIn(w, display('d'));
    const m = await writeIn(w, modelWrite('m'));
    fact('writes idle/empty/no failure', { display: d, model: m });
    expect(d).toMatchObject({ status: 'done', appended: ['familiar.note'], startedRun: false });
    expect(m).toMatchObject({ status: 'done', appended: ['familiar.remark'], startedRun: false });
    await w.close();
  });

  it('idle, empty inbox, with runFailure: both appended, no run, runFailure kept', async () => {
    const { w } = await failedWorld(0);
    const d = await writeIn(w, display('d'));
    const m = await writeIn(w, modelWrite('m'));
    fact('writes idle/empty/failure', { display: d, model: m });
    expect(d).toMatchObject({ status: 'done', startedRun: false, runFailurePost: 'turn_limit' });
    expect(m).toMatchObject({ status: 'done', startedRun: false, runFailurePost: 'turn_limit' });
    await w.close();
  });

  it('idle, B queued, with runFailure: display-only is appended and starts nothing; a model write starts B and removes runFailure', async () => {
    const { w, qs } = await failedWorld(1);
    const d = await writeIn(w, display('d'));
    expect(await statusOf(w, qs[0].id)).toBe('queued');
    const m = await writeIn(w, modelWrite('m'));
    fact('writes idle/queued/failure', { display: d, model: m, b: await statusOf(w, qs[0].id) });
    expect(d).toMatchObject({ status: 'done', startedRun: false, runFailurePost: 'turn_limit' });
    expect(m).toMatchObject({ startedRun: true, runFailurePost: null });
    await w.idle();
    await w.close();
  });

  it('busy, no runFailure: display-only at once; a model write queues for the next boundary', async () => {
    const hold = gate();
    const w = await world({ script: (request) => (lastUser(request) === 'A' ? { text: 'x', pause: { afterEvents: 0, until: hold.until } } : { text: 'ok' }) });
    await sub(w, { type: 'input', content: 'A' });
    await w.until(async () => !!(await w.live())?.run, 'A running');
    const d = await writeIn(w, display('d'));
    const m = await writeIn(w, modelWrite('m'));
    fact('writes busy/no failure', { display: d, model: m });
    expect(d).toMatchObject({ status: 'done', appended: ['familiar.note'] });
    expect(m).toMatchObject({ status: 'queued', appended: [], inboxPost: ['write'] });
    hold.open();
    await w.idle();
    await w.close();
  });

  it('busy with runFailure (afterFailedRun "continue" only): the run started in the failure commit keeps it, and an answer leaves it', async () => {
    const { w, a, qs } = await failedWorld(1, { afterFailedRun: 'continue' });
    const ended = commitOf(w.log, String(a.id), 'unanswered')!;
    fact('continue: failure commit', { started: !!ended.livePost.run, runInputs: ended.livePost.run?.inputs, runFailure: ended.livePost.runFailure?.reason });
    expect(ended.livePost.run.inputs.map(String)).toEqual([String(qs[0].id)]);
    expect(ended.livePost.runFailure.reason).toBe('turn_limit');
    await w.idle();
    const after = await w.live();
    fact('continue: after the next run answered', { runFailure: after.runFailure?.reason ?? null, q0: await statusOf(w, qs[0].id) });
    // The stale failure: still set after a run that answered.
    expect(await statusOf(w, qs[0].id)).toBe('done');
    expect(after.runFailure.reason).toBe('turn_limit');
    // A continue on it settles nothing_to_answer.
    const k = await sub(w, { type: 'continue' });
    await w.idle();
    const ks = await w.harness.submission(Number(k.id), ctx);
    fact('continue on a stale failure', { status: ks.status, reason: ks.reason ?? ks.settlement?.reason, runFailure: (await w.live()).runFailure?.reason });
    expect((await w.live()).runFailure.reason).toBe('nothing_to_answer');
    await w.close();
  });
});

/* ---------- compaction ---------- */

describe('B4: a compaction task persisted before the pin', () => {
  it('is found at open and aborted before resume(): it never places B', async () => {
    const before = await compactionWorld(undefined);
    expect(before.w.log.some((c) => (c.livePost?.compactions ?? []).length > 0)).toBe(true);
    before.w.kill();
    let found: any[] = [];
    let marks: string[] = [];
    let summariesAfter = 0;
    const after = await world({
      reopen: { factory: before.w.factory, name: before.w.name },
      contextWindow: 100_000,
      settings: { compaction: { backgroundTokens: 0 } },
      script: (request) => {
        if (isSummary(request)) summariesAfter++;
        return { text: 'ok' };
      },
      beforeResume: async (harness, root) => {
        found = await harness.commit(async (tx: any) => (await tx.scanTasks({ conversationId: root.id, kind: 'pi.compaction' }, 50)).items.filter((t: any) => t.state.status !== 'terminal' && t.owner === undefined).map((t: any) => ({ id: String(t.id), status: t.state.status, background: t.background })), ctx);
        for (const t of found) marks.push(await harness.abortTask(Number(t.id), ctx));
      }
    });
    await after.idle();
    await new Promise((r) => setTimeout(r, 100));
    const live = await after.live();
    const b = await statusOf(after, before.b.id);
    fact('sweep at open', { found, marks, summariesAfter, b, runFailure: live.runFailure?.reason, compactions: live.compactions ?? [] });
    expect(found).toHaveLength(1);
    expect(summariesAfter).toBe(0);
    expect(b).toBe('queued');
    expect(live.runFailure.reason).toBe('turn_limit');
    await after.close();
  });

  it('control: without the sweep, the reopened compaction resumes and places B', async () => {
    const before = await compactionWorld(undefined);
    before.w.kill();
    const after = await world({
      reopen: { factory: before.w.factory, name: before.w.name },
      contextWindow: 100_000,
      settings: { compaction: { backgroundTokens: 0 } },
      script: (request) => (isSummary(request) ? { text: 'SUMMARY' } : { text: 'ok' })
    });
    await after.until(async () => (await statusOf(after, before.b.id)) !== 'queued', 'B placed');
    await after.idle();
    const b = await statusOf(after, before.b.id);
    fact('no sweep at open', { b, runFailure: (await after.live()).runFailure?.reason ?? null });
    expect(b).toBe('done');
    await after.close();
  });
});

describe('B1: compaction', () => {
  it('default policy: a background summary lands in the idle failed conversation, places B and starts a run, clearing runFailure', async () => {
    const { w, a, b, summary, summaries } = await compactionWorld(undefined);
    const created = w.log.find((c) => (c.livePost?.compactions ?? []).length > 0 && !(c.livePre?.compactions ?? []).length);
    expect(created).toBeDefined();
    expect((await w.live()).runFailure.reason).toBe('turn_limit');
    expect(await statusOf(w, b.id)).toBe('queued');
    summary.open();
    await w.until(async () => (await statusOf(w, b.id)) !== 'queued', 'B placed');
    const placed = commitOf(w.log, String(b.id), 'placed')!;
    fact('default compaction placement', {
      summaries: summaries(),
      created: created!.livePost.compactions,
      commit: { submissions: placed.submissions, entries: placed.entries, startedRun: !placed.livePre.run && !!placed.livePost.run, runFailurePre: placed.livePre.runFailure?.reason, runFailurePost: placed.livePost.runFailure ?? null }
    });
    expect(placed.entries.map((e) => e.kind)).toContain('pi.compaction');
    expect(placed.livePre.run).toBeUndefined();
    expect(placed.livePost.run.inputs.map(String)).toEqual([String(b.id)]);
    expect(placed.livePost.runFailure).toBeUndefined();
    void a;
    await w.idle();
    await w.close();
  });

  it('backgroundTokens 0: no compaction task, no summary request; B stays queued and runFailure stays', async () => {
    const { w, b, summaries } = await compactionWorld(0);
    await w.idle();
    await new Promise((r) => setTimeout(r, 100));
    const any = w.log.some((c) => (c.livePost?.compactions ?? []).length > 0) || w.log.some((c) => c.tasks.some((t) => /compact/i.test(String(t.name))));
    fact('backgroundTokens 0', { compactions: any, summaries: summaries(), b: await statusOf(w, b.id), runFailure: (await w.live()).runFailure?.reason });
    expect(any).toBe(false);
    expect(summaries()).toBe(0);
    expect(await statusOf(w, b.id)).toBe('queued');
    expect((await w.live()).runFailure.reason).toBe('turn_limit');
    await w.close();
  });

  it('backgroundTokens 0 with a model override that sets other fields: still 0; one that sets backgroundTokens wins for that model', async () => {
    const quiet = await compactionWorld(0, { 'familiar/m': { keepRecentTokens: 10 } });
    await quiet.w.idle();
    expect(quiet.summaries()).toBe(0);
    await quiet.w.close();
    const loud = await compactionWorld(0, { 'familiar/m': { backgroundTokens: 32768 } });
    const created = loud.w.log.some((c) => (c.livePost?.compactions ?? []).length > 0);
    fact('override backgroundTokens', { overrideOther: quiet.summaries(), overrideSets: created });
    expect(created).toBe(true);
    loud.summary.open();
    await loud.w.until(async () => (await statusOf(loud.w, loud.b.id)) !== 'queued', 'B placed');
    await loud.w.idle();
    await loud.w.close();
  });

  it('a cap pause inside a blocking compaction: model_error, and the detail text it carries', async () => {
    const w = await world({
      contextWindow: 100_000,
      settings: { compaction: { keepRecentTokens: 10, backgroundTokens: 0 } },
      script: (request) => (lastUser(request) === 'first' ? { text: 'hello', usage: { inputTokens: 90_000, outputTokens: 10 } } : { text: 'ok' })
    });
    const first = await sub(w, { type: 'input', content: 'first' });
    await first.wait(ctx);
    await w.idle();
    w.setCap(true);
    const a = await sub(w, { type: 'input', content: 'A' });
    await w.idle();
    const f = (await w.live()).runFailure;
    const stripped = String(f.detail).replace(/^Compaction failed: /, '');
    const both = stripped.replace(/^Summarization failed: /, '');
    fact('blocking compaction cap pause', { reason: f.reason, detailPrefix: String(f.detail).slice(0, 60), decodeWhole: decodeModelError(f.detail) ?? null, decodeAfterCompactionPrefix: decodeModelError(stripped) ?? null, decodeAfterBothPrefixes: decodeModelError(both) ?? null, a: await statusOf(w, a.id) });
    expect(f.reason).toBe('model_error');
    await w.close();
  });
});

/* ---------- B5: the inbox and submissions inside a commit ---------- */

describe('B5: reads inside submit(tx, ...)', () => {
  it('tx.doc(InboxDoc) and tx.submission(id) read inside a commit, before and after root.submit(tx, ...)', async () => {
    const { w, qs } = await failedWorld(1);
    const seen = await w.harness.commit(async (tx: any) => {
      const inboxBefore = (await tx.doc(InboxDoc, w.root.id)).items.map((i: any) => String(i.id));
      const liveBefore = await tx.doc(LiveDoc, w.root.id);
      const bBefore = (await tx.submission(qs[0].id))?.status;
      const id = await w.root.submit(tx, display('her line'));
      const inboxAfter = (await tx.doc(InboxDoc, w.root.id)).items.map((i: any) => String(i.id));
      let after: string;
      try {
        after = (await tx.submission(qs[0].id))?.status;
      } catch (e: any) {
        after = `throws ${e?.name}: ${e?.message}`;
      }
      return { inboxBefore, runFailure: liveBefore.runFailure?.reason, bBefore, inboxAfter, submissionReadAfterAdmission: after, id: String(id) };
    }, ctx);
    fact('B5 in-commit reads', seen);
    expect(seen.inboxBefore).toEqual([String(qs[0].id)]);
    expect(seen.bBefore).toBe('queued');
    // A second commit: a continue placed B; tx.submission in that same commit sees the staged placement.
    const staged = await w.harness.commit(async (tx: any) => {
      const before = (await tx.submission(qs[0].id))?.status;
      // A document write before the admission: allowed (documents aren't tables).
      (await tx.doc(InboxDoc, w.root.id)).items.length;
      const k = await w.root.submit(tx, { type: 'continue' });
      const inboxAfter = (await tx.doc(InboxDoc, w.root.id)).items.map((i: any) => String(i.id));
      return { before, k: String(k), inboxAfterAdmission: inboxAfter };
    }, ctx);
    fact('B5 staged status after an admission in the same commit', staged);
    // A commit with no admission, as the ledger fold's: a document write first, then tx.submission.
    const Notes = defineJournalDoc<{ n: number }>('familiar.b5-notes', () => ({ n: 0 }));
    const fold = await w.harness.commit(async (tx: any) => {
      (await tx.doc(Notes)).n += 1;
      try {
        return { status: (await tx.submission(qs[0].id))?.status };
      } catch (e: any) {
        return { throws: `${e?.name}: ${e?.message}` };
      }
    }, ctx);
    fact('B5 tx.submission after a document write', fold);
    expect(fold).toHaveProperty('status');
    await w.idle();
    await w.close();
  });
});
