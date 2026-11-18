// The journal's independent checks, H6 to H9 (docs/mcp-design.md 7.2). They read the commit log and the
// evidence log only. H6 keeps its own history of endings from the submissions' own settlements; it never
// reads `runFailure` to judge `runFailure`.

import type { JCommit, JRun } from './journal.ts';

export type JCheck = (r: JRun) => string[];

/** A run starts in a commit when one is live after it that wasn't before (a new run id). */
const runId = (live: any) => (live?.run ? JSON.stringify([live.run.taskId ?? null, live.run.first ?? null, live.run.inputs ?? null]) : undefined);
export const startsRun = (c: JCommit) => !!c.livePost?.run && runId(c.livePost) !== runId(c.livePre);
const endsRun = (c: JCommit) => !!c.livePre?.run && (!c.livePost?.run || runId(c.livePost) !== runId(c.livePre));

/** An ending that leaves inputs unanswered, from the submissions' own records: its commit and reason. */
interface Ending {
  readonly seq: number;
  readonly reason: string;
  /** An aborted run whose steps were cut off: the harness saw an interruption record written in its run. */
  readonly interrupted: boolean;
  /** A model error that is a cap's pause, read from the settlement's own detail. */
  readonly paused: boolean;
  /** The task that held the run when it ended (pi.live before the ending commit): the question it asks is
      `run:<task>`, and an answer to it is recorded under this task. */
  readonly task: string;
}

/**
 * Whether a settlement's detail is a cap's pause, read here on its own: Familiar's model errors are
 * `familiar.model-error:` and hex JSON, after any compaction prefixes.
 */
function pausedDetail(detail: unknown): boolean {
  let text = typeof detail === 'string' ? detail : '';
  for (const prefix of ['Compaction failed: ', 'Summarization failed: ']) if (text.startsWith(prefix)) text = text.slice(prefix.length);
  const m = /^familiar\.model-error:((?:[0-9a-f]{2})*)$/.exec(text);
  if (!m) return false;
  try {
    const bytes = new Uint8Array(m[1]!.length / 2).map((_, i) => parseInt(m[1]!.slice(i * 2, i * 2 + 2), 16));
    return JSON.parse(new TextDecoder().decode(bytes))?.kind === 'paused';
  } catch {
    return false;
  }
}

function history(log: JCommit[], upTo: number) {
  const endings: Ending[] = [];
  const starts: number[] = [];
  const answers: number[] = [];
  let lastStart = 0;
  for (const c of log) {
    if (c.seq > upTo) break;
    if (c.answered.length) answers.push(c.seq);
    const unanswered = c.submissions.filter((s) => s.status === 'unanswered');
    if (unanswered.length && endsRun(c)) {
      const reason = unanswered[0]!.reason ?? '';
      const interrupted = log.some((x) => x.seq >= lastStart && x.seq <= c.seq && x.interrupted.length > 0);
      endings.push({ seq: c.seq, reason, interrupted, paused: reason === 'model_error' && pausedDetail(unanswered[0]!.detail), task: String(c.livePre?.run?.taskId ?? '') });
    }
    if (startsRun(c)) {
      starts.push(c.seq);
      lastStart = c.seq;
    }
  }
  return { endings, starts, answers };
}

/** Whether a question is due at commit `upTo`, by the independent history. */
export function due(log: JCommit[], upTo: number): Ending | undefined {
  const { endings, starts, answers } = history(log, upTo);
  const last = endings.at(-1);
  if (!last) return undefined;
  if (starts.some((s) => s > last.seq)) return undefined;
  // A start in the ending's own commit (a successor) supersedes it too.
  const own = log.find((c) => c.seq === last.seq);
  if (own && own.livePost?.run) return undefined;
  if (answers.some((a) => a > last.seq)) return undefined;
  // Which endings ask: the step cap, a cap's pause, and a run whose steps were cut off. Your own Stop and
  // an error don't.
  if (last.reason === 'turn_limit') return last;
  if (last.paused) return last;
  if (last.reason === 'aborted' && last.interrupted) return last;
  return undefined;
}

/** H6: a question is shown exactly when one is due, after every step, and it's that ending's question. */
export const H6: JCheck = (r) => {
  const problems: string[] = [];
  for (const e of r.evidence) {
    if (e.what !== 'shown') continue;
    const d = due(r.log, e.at ?? 0);
    const shown = (e.questions ?? []).length > 0;
    if (shown && !d) problems.push(`H6: step ${e.step} shows "${e.questions![0]!.text.slice(0, 40)}", which isn't due`);
    if (!shown && d) problems.push(`H6: step ${e.step} shows no question, though the ending at commit ${d.seq} (${d.reason}) is due one`);
    if (shown && d && e.questions![0]!.id !== `run:${d.task}`) problems.push(`H6: step ${e.step} shows question ${e.questions![0]!.id}, but the one due is run:${d.task} (commit ${d.seq}, ${d.reason})`);
  }
  return problems.slice(0, 3);
};

/** H7: every run start is in a commit holding your message, an answer to an open question, a Send now of
    the oldest queued item, or pi-durable's own boundary after a run that ended answered. */
export const H7: JCheck = (r) => {
  const problems: string[] = [];
  const mine = new Set(r.evidence.filter((e) => e.what === 'send').map((e) => e.requestId));
  for (const c of r.log) {
    if (!startsRun(c)) continue;
    // Your message, admitted in this very commit (a message closes an open question and places the
    // oldest queued input, which may be an earlier one), not one placed later from the queue on its own.
    if (c.submissions.some((s) => s.requestId !== undefined && mine.has(s.requestId) && !r.log.some((x) => x.seq < c.seq && x.submissions.some((y) => y.id === s.id)))) continue;
    // An answer recorded in this commit to the very question the independent history had due: its record
    // is under that ending's task. An answer recorded under another task starts nothing.
    const asked = c.answered.length ? due(r.log.filter((x) => x.seq < c.seq), c.seq - 1) : undefined;
    if (asked && c.answered.includes(asked.task)) continue;
    if (c.answered.length) {
      problems.push(`H7: commit ${c.seq} (step ${c.step}) started a run on an answer to ${c.answered.join(', ')}, ${asked ? `but the question due was run:${asked.task}` : 'with no question due'}`);
      continue;
    }
    // A Send now record (SendNowDoc.byRequest) written in this commit, which started something, and whose
    // offered submission the commit's pre-state shows queued, the oldest of the inbox.
    const now = c.sentNow.find((x) => x.sent !== undefined);
    if (now) {
      const oldest = (c.inboxPre?.items ?? []).find((i: any) => i.mode !== 'write');
      if (oldest && String(oldest.id) === now.submission) continue;
      problems.push(`H7: commit ${c.seq} started a run from a Send now of ${now.submission}, which its pre-state doesn't show queued first`);
      continue;
    }
    // pi-durable's own boundary: the previous run ended in this commit with nothing left unanswered.
    if (c.livePre?.run && !c.submissions.some((s) => s.status === 'unanswered')) continue;
    problems.push(`H7: commit ${c.seq} (step ${c.step}) started a run on no act of yours`);
  }
  return problems.slice(0, 3);
};

/** H8: after every step, an idle conversation with queued input and no question shows Send now. */
export const H8: JCheck = (r) => {
  const problems: string[] = [];
  for (const e of r.evidence) {
    if (e.what !== 'shown') continue;
    const c = [...r.log].reverse().find((x) => x.seq <= (e.at ?? 0));
    if (!c || c.livePost?.run) continue;
    const queued = (c.inboxPost?.items ?? []).some((i: any) => i.mode !== 'write');
    if (queued && !(e.questions ?? []).length && !e.sendNow) problems.push(`H8: step ${e.step}: idle, a message queued, no question, and no Send now`);
  }
  return problems.slice(0, 3);
};

/** H9: her line is model-visible only into a quiet chat (no run, nothing queued, no failure), and never in
    a commit that starts a run. */
export const H9: JCheck = (r) => {
  const problems: string[] = [];
  for (const c of r.log) {
    const line = c.entries.find((e) => e.kind === 'familiar.remark');
    if (!line) continue;
    if (startsRun(c)) problems.push(`H9: her line in commit ${c.seq} started a run`);
    if (!line.model) continue;
    const quiet = !c.livePre?.run && !c.livePre?.runFailure && !(c.inboxPre?.items ?? []).length;
    if (!quiet) problems.push(`H9: her line in commit ${c.seq} went to the model though the chat wasn't quiet`);
  }
  return problems.slice(0, 3);
};

export const JOURNAL_CHECKS: Record<string, JCheck> = { H6, H7, H8, H9 };

/** Each check's witness: a step where its condition was in play. */
export const JOURNAL_WITNESSES: Record<string, (r: JRun) => boolean> = {
  'H6 a due question': (r) => r.evidence.some((e) => e.what === 'shown' && due(r.log, e.at ?? 0)),
  'H6 a due pause': (r) => r.evidence.some((e) => e.what === 'shown' && due(r.log, e.at ?? 0)?.paused),
  'H7 a late answer to an earlier question': (r) => {
    const shown = new Map<string, number>();
    for (const e of r.evidence) if (e.what === 'shown') for (const q of e.questions ?? []) if (!shown.has(q.id)) shown.set(q.id, e.step);
    return r.evidence.some((e, i) => e.what === 'answer' && e.question !== undefined && r.evidence.slice(0, i).filter((x) => x.what === 'shown').at(-1)?.questions?.[0]?.id !== e.question);
  },
  'H6 a superseded question': (r) => {
    const { endings } = history(r.log, Infinity);
    return endings.some((x) => (x.reason === 'turn_limit' || x.interrupted) && r.log.some((c) => c.seq > x.seq && startsRun(c)));
  },
  'H7 a run started by an answer': (r) => r.log.some((c) => startsRun(c) && c.answered.length > 0),
  'H7 a run started by Send now': (r) => r.log.some((c) => startsRun(c) && c.sentNow.some((x) => x.sent !== undefined)),
  'H8 Send now shown': (r) => r.evidence.some((e) => e.what === 'shown' && e.sendNow),
  'H9 her line, visible': (r) => r.log.some((c) => c.entries.some((e) => e.kind === 'familiar.remark' && e.model)),
  'H9 her line, display only': (r) => r.log.some((c) => c.entries.some((e) => e.kind === 'familiar.remark' && !e.model))
};
