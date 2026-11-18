// Questions are a view over pi-durable's own record of how the newest run ended (`pi.live.runFailure`),
// read live. Familiar keeps no copy of "a question is open": pi-durable sets the record in the commit
// that settles the run's inputs unanswered, and removes it in the next commit that starts a run, so a
// question closes in the very commit that supersedes it. Familiar adds only two things beside it:
//   - interruption records, one per cut-off step, grouped under the run's task id (written by the
//     afterTool hook before the round's afterTools hook stops the run), inert unless runFailure names
//     that task;
//   - answer records, keyed by the task id, written in the answer's own commit.
// This holds only under the pins in journal.ts (no afterRun hooks, afterFailedRun "keep", no resets):
// with them, a failure can last exactly until the next run starts.

import { decodeModelError } from './provider.ts';

export interface InterruptedStep {
  /** The step's id. */
  readonly step: string;
  /** The task id of the run's generation when the round ran: the task runFailure will name. */
  readonly task: string;
  readonly tool: string;
  readonly arguments: unknown;
  /** `redo`: a built-in effect, "Do it now?". `rerun`: a server tool, Run again. */
  readonly kind: 'redo' | 'rerun';
  /** One line about this step. */
  readonly text: string;
  /** The turn the step belongs to. */
  readonly turn: string;
}

export interface Interruptions {
  steps: Record<string, InterruptedStep>;
  opened?: number;
}

export interface AnswerRecord {
  readonly yes: boolean;
  readonly kind: Question['kind'];
  /** What the answer started, if anything. */
  readonly submission?: string;
  /** The turn the question was about. */
  readonly turn: string;
  /** For a Skip: the tools the gate refuses for the rest of that turn. */
  readonly tools?: readonly string[];
}

export interface Answers {
  byTask: Record<string, AnswerRecord>;
  order?: string[];
  opened?: number;
}

/** Something the loop asks you, in chat. */
export interface Question {
  /** `run:<task id>`: one question per stopped run. */
  readonly id: string;
  /**
   * `steps`: the turn took its tool steps and asks before going on.
   * `cap`: a cap paused the turn; going on needs a cap with room, or tomorrow.
   * `redo`: built-in effects were cut off by a close and not run again ("Do it now?").
   * `rerun`: a server tool was cut off and may have partly run (Run again).
   */
  readonly kind: 'redo' | 'rerun' | 'steps' | 'cap';
  readonly text: string;
  /** For `redo` and `rerun`: every interrupted step of the run. One answer settles all of them. */
  readonly steps?: readonly InterruptedStep[];
  /** The first interrupted step's tool and arguments, for one-step questions. */
  readonly tool?: string;
  readonly arguments?: unknown;
  readonly pause?: string;
  /** The turn the question is about (for interruptions, the steps' turn). */
  readonly turn?: string;
}

/** What the view says about the conversation now. */
export type RunView =
  | { readonly state: 'running' }
  | { readonly state: 'idle' }
  | { readonly state: 'question'; readonly question: Question }
  /** The question was answered; nothing more to show. */
  | { readonly state: 'answered'; readonly task: string; readonly answer: AnswerRecord }
  /** Your own Stop: idle, nothing asked. */
  | { readonly state: 'stopped'; readonly task: string }
  | { readonly state: 'error'; readonly task: string; readonly reason: string; readonly message: string };

const COMPACTION = 'Compaction failed: ';
const SUMMARY = 'Summarization failed: ';

/**
 * A model error's detail, decoded. A pause hit by a blocking compaction's own summary request arrives as
 * `Compaction failed: Summarization failed: <coded>` (B1 on pi-durable 1.5.2), so both prefixes go first.
 */
export function decodeFailure(detail: string | undefined) {
  let text = detail ?? '';
  if (text.startsWith(COMPACTION)) text = text.slice(COMPACTION.length);
  if (text.startsWith(SUMMARY)) text = text.slice(SUMMARY.length);
  return decodeModelError(text);
}

/** The interrupted steps recorded for a task, oldest step first. */
export function stepsOf(interruptions: Partial<Interruptions> | undefined, task: string): InterruptedStep[] {
  return Object.values(interruptions?.steps ?? {})
    .filter((s) => s.task === task)
    .sort((a, b) => Number(a.step) - Number(b.step) || a.step.localeCompare(b.step));
}

function interruptionQuestion(id: string, steps: InterruptedStep[]): Question {
  const rerun = steps.some((s) => s.kind === 'rerun');
  const text = steps.length === 1 ? steps[0]!.text : `${steps.length} steps were cut off when the app closed: ${steps.map((s) => s.text).join(' ')}`;
  return { id, kind: rerun ? 'rerun' : 'redo', text, steps, tool: steps[0]!.tool, arguments: steps[0]!.arguments, turn: steps[0]!.turn };
}

/** The view, from `pi.live`, the interruption records and the answer records, all read together. */
export function runView(live: any, interruptions: Partial<Interruptions> | undefined, answers: Partial<Answers> | undefined, stepCap: number): RunView {
  if (live?.run) return { state: 'running' };
  const f = live?.runFailure;
  if (!f) return { state: 'idle' };
  const task = String(f.taskId);
  const answer = answers?.byTask?.[task];
  if (answer) return { state: 'answered', task, answer };
  const id = `run:${task}`;
  if (f.reason === 'turn_limit') return { state: 'question', question: { id, kind: 'steps', text: `I've taken ${stepCap} steps on this. Shall I keep going?` } };
  const decoded = decodeFailure(f.detail);
  if (f.reason === 'model_error' && decoded?.kind === 'paused') return { state: 'question', question: { id, kind: 'cap', text: decoded.message, pause: decoded.pause } };
  if (f.reason === 'aborted') {
    const steps = stepsOf(interruptions, task);
    if (steps.length) return { state: 'question', question: interruptionQuestion(id, steps) };
    return { state: 'stopped', task };
  }
  return { state: 'error', task, reason: String(f.reason), message: decoded?.message ?? String(f.detail ?? '') };
}

/** The open question, if any. */
export function openQuestion(view: RunView): Question | undefined {
  return view.state === 'question' ? view.question : undefined;
}

/** The first queued input in `pi.inbox` (its oldest follow-up or steer), by submission id. */
export function oldestQueued(inbox: any): string | undefined {
  const item = (inbox?.items ?? []).find((i: any) => i.mode !== 'write');
  return item ? String(item.id) : undefined;
}
