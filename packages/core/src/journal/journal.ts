// The journal: Familiar's turn loop on pi-durable, behind one small facade. Nothing outside journal/
// imports pi-durable, so an upgrade or a swap touches this folder only.
//
// Every turn is committed before anything is shown, and a reopened journal goes on where the last one
// stopped (docs/turn-design.md has the resume table as built):
//   - a model call that finished is replayed from its record; one in flight is sent again, and its open
//     cap reservation stays spent while the new call takes its own,
//   - a finished tool's result is reused; a started read or built-in write runs again (the write finds its
//     receipt); a started built-in effect becomes a question, "Do it now?"; a started server tool is
//     reported as interrupted, with Run again,
//   - a consent card still open, and a wait for a wake time, are still there.
//
// Nothing here starts or places a run on its own. Every submission that can start one is your act, made in
// one commit that reads pi-durable's state first: a message (`send`), an answer (`answer`), Send now
// (`sendNow`). Her own line (`remark`) is model-visible only into a quiet chat, and never starts a run.
// Questions are a view over pi-durable's `runFailure`, read live (view.ts). That holds only under these
// pins, each with its test (tests/journal/pins.test.ts):
//   - background compaction off (`backgroundTokens: 0`), no model overrides, no conversation `configure`,
//     and any compaction task a journal made before the pin aborted at open, before `resume()`;
//   - `afterFailedRun` left at "keep", the queue modes at "one-at-a-time", no `afterRun` or `onYield` hook,
//     no reset, handoff, `terminate`, `compact`, conversation or submission abort, or raw submission;
//   - exactly one extension, Familiar's own;
//   - every write but her line display-only: the bound notice, the reminder line, `familiar.ack`.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, GenerationTask, Harness, InboxDoc, LiveDoc, ToolTask, createRegistry, defineExtension, defineTask, hook } from '@earendil-works/pi-durable';
import { needsReply } from '../decide/ack.ts';
import type { Decision, DecisionContext, DecisionPort, PastReaction, PersonaEvent } from '../decide/port.ts';
import type { CallInfo, CapsConfig, CapsOptions, Clock, Ledger } from '../model/caps.ts';
import { cappedPort, createCaps, emptyLedger, extendTurn } from '../model/caps.ts';
import type { ChatMessage, ModelPort } from '../model/port.ts';
import type { RetryOptions } from '../model/retry.ts';
import { withRetries } from '../model/retry.ts';
import { journalUsageStore, LedgerDoc } from './ledger.ts';
import type { OwnerLock } from './owner.ts';
import type { PresencePort } from './presence.ts';
import { presenceReporter, stateOf } from './presence.ts';
import { decodeModelError, portProvider } from './provider.ts';
import type { JournalStore } from './store.ts';
import { admit, boundWords, type Budget } from './bounds.ts';
import { finishTurn, openTurn, recordSubmission, turnKeyOf, turnOfInputs, TurnsDoc } from './turns.ts';
import { oldestQueued, runView, type Answers, type Interruptions, type Question, type RunView } from './view.ts';
import { mutant } from '../mutations.ts';

/** For a named mutation only: the newest queued input, where Send now must offer the oldest. */
const newestQueued = (inbox: any): string | undefined => {
  const items = (inbox?.items ?? []).filter((i: any) => i.mode !== 'write');
  return items.length ? String(items.at(-1).id) : undefined;
};
import { gateFor, type GatePolicy } from './gate.ts';
import type { Allowed, FamiliarTool, JournalDocToken } from './tools.ts';
import { defineJournalDoc, toDurableTool } from './tools.ts';
import { sameFacts, type CardFacts } from '../mcp/decision.ts';

const ctx = BACKGROUND_CONTEXT;
const PROVIDER = 'familiar';

/** The Harness clock and its timers. Sleep deadlines are stored on `now`, so keep it the wall clock. */
export interface JournalClock extends Clock {
  /** Arms a timer; returns a cancel. `background` timers only free memory. */
  setTimer(callback: () => void, delayMs: number, options: { readonly background: boolean }): (() => void) | undefined;
}

export const systemClock: JournalClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => {
    const t = setTimeout(callback, delayMs);
    return () => clearTimeout(t);
  }
};

/**
 * Wakes the app for a parked wait: in the app, the exe's `wake_at`, so a reminder fires though the page
 * was asleep or closed. Told the earliest wake time whenever it changes, `undefined` for none.
 */
export interface WakePort {
  wakeAt(at: number | undefined): void;
}

export interface ConsentCard {
  /** The step's id. The same card after a restart has the same id. */
  readonly id: string;
  readonly tool: string;
  readonly arguments: unknown;
  /** Plain words: "saving a note". */
  readonly doing: string;
  readonly askedAt: number;
  /** The turn the call belongs to. */
  readonly turn?: string;
  /**
   * This presentation's own one-use id: each showing of a card gets a fresh one, and when the facts
   * change the old id is retired and the card asked again. An answer for a retired id answers nothing.
   */
  readonly presentation?: string;
  /** For a server's tool: what the card shows and a Yes binds to, stored when the card is made. */
  readonly facts?: CardFacts;
  /** Whether the card may offer "Always": never while the conversation carries outside content. */
  readonly always?: boolean;
}

export interface ConsentPort {
  /** Shows the card and resolves with the person's answer. After a restart the same card is asked again. */
  ask(card: ConsentCard, signal?: AbortSignal): Promise<boolean>;
}

export type { Question } from './view.ts';

/** Send now, as it was shown: the oldest queued message, and the stopped run it was shown after. */
export interface SendNowOffer {
  readonly submission: string;
  /** `runFailure.taskId` when it was shown, or null for none. */
  readonly failure: string | null;
}

/** What her line is made from: the prompt the decider built, and the sources of everything in it. */
export interface RemarkPrompt {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  /** Where the prompt's content came from (a server, say). Empty for her own words and yours. */
  readonly sources?: readonly string[];
}

export interface Remark {
  readonly text: string;
  /** Her model sees it: written into a quiet chat. Otherwise it's shown only. */
  readonly visible: boolean;
  readonly sources: readonly string[];
}

/** What the decider sees that the loop doesn't know itself. */
export type AmbientState = Omit<DecisionContext, 'recentEvents' | 'recentReactions' | 'minutesSinceChat' | 'now' | 'localHour'>;

export interface CapsSetup {
  readonly config: CapsConfig;
  /** Everything a call's caps need but the request and the turn. */
  readonly call: Omit<CallInfo, 'request' | 'turn' | 'conversation'>;
  readonly options?: CapsOptions;
}

export interface JournalOptions {
  readonly store: JournalStore;
  readonly owner: OwnerLock;
  /** The adapter's port. The journal puts caps around it, and retries around those. */
  readonly model: ModelPort;
  readonly modelId: string;
  readonly caps: CapsSetup;
  readonly retries?: Omit<RetryOptions, 'sleep'>;
  readonly tools: readonly FamiliarTool[];
  readonly clock?: JournalClock;
  readonly wake: WakePort;
  /** The person's per-tool choices (step 8's Settings), read at each call. The gate's defaults hold without it. */
  readonly policy?: () => GatePolicy;
  /** Shows a parked wake's notification when it fires. */
  readonly notifier: NotifierPort;
  readonly consent: ConsentPort;
  readonly presence: PresencePort;
  readonly persona: { readonly id: string; readonly name: string; readonly instructions: string };
  readonly decider: DecisionPort;
  readonly ambient: () => AmbientState;
  /** The decider chose to react. */
  readonly onReaction?: (decision: Decision, event: PersonaEvent) => void;
  /** Tool rounds per turn before it asks. Default 8. */
  readonly stepCap?: number;
  /** The backoff before a request a crash cut off is sent again. Default 2 s, doubling. */
  readonly resendDelayMs?: number;
  /** A new id for each start of the journal: the presence `gen`. */
  readonly newGen?: () => string;
  /** Failures that don't fail a call: a hook that threw, a faulted task, the store failing. */
  readonly onReport?: (report: { kind: string; message: string }) => void;
}

export type TurnEnd =
  | { readonly status: 'answered'; readonly text: string }
  | { readonly status: 'asks'; readonly question: Question }
  | { readonly status: 'failed'; readonly reason: string; readonly message: string };

export interface Turn {
  readonly id: string;
  wait(): Promise<TurnEnd>;
}

export type SendResult =
  | { readonly replied: true; readonly turn: Turn }
  /** A bare acknowledgement: no reply message. `decision` is the reaction, a gesture at most. */
  | { readonly replied: false; readonly decision: Decision };

export interface Notification {
  /**
   * Stable for one delivery: derived from the parked wake's task id, so a delivery a kill cut off and
   * ran again has the same id. On Windows it becomes the toast's tag.
   */
  readonly id: string;
  readonly text: string;
  /** When it was due. */
  readonly at: number;
}

/** Shows notifications. It must show each id once: a delivery can run again after a kill. */
export interface NotifierPort {
  notify(notification: Notification): void | Promise<void>;
}

/** One record per cut-off step, keyed by step id, under the run's task id (view.ts). */
export const InterruptionsDoc = defineJournalDoc<Interruptions>('familiar.interruptions', () => ({ steps: {} }));
/** One record per answered question, keyed by the stopped run's task id, written by the answer's commit. */
export const AnswersDoc = defineJournalDoc<Answers>('familiar.answers', () => ({ byTask: {}, order: [] }));
/** Each Send now by its request id: the submission it was shown for, and the continue it started. */
export const SendNowDoc = defineJournalDoc<{ byRequest: Record<string, { submission: string; sent?: string }>; order: string[] }>('familiar.send-now', () => ({ byRequest: {}, order: [] }));
/**
 * The outside record: one per request Familiar makes outside a turn (her line), written before the
 * request is sent and never changed. A request is outside if any of its input carries a source.
 */
export const OutsideDoc = defineJournalDoc<{ requests: Record<string, { sources: string[]; at: number }>; order: string[] }>('familiar.outside', () => ({ requests: {}, order: [] }));
const RemarkEntry = 'familiar.remark';
/** Records kept per document before the oldest go. */
const KEEP_RECORDS = 256;
const keepNewest = (order: string[], byKey: Record<string, unknown>, key: string) => {
  if (!order.includes(key)) order.push(key);
  while (order.length > KEEP_RECORDS) delete byKey[order.shift()!];
};
/** An ack's decision is written after the ack's own commit wins: absent while it's being decided, or if a
    kill came between. */
type SentRecord = { kind: 'turn'; submission: string } | { kind: 'ack'; decision?: Decision };
/** What each request id of a person's message did, so a resend gets the same result. */
const SentDoc = defineJournalDoc<{ byRequest: Record<string, SentRecord>; order: string[] }>('familiar.sent', () => ({ byRequest: {}, order: [] }));
const ConsentDoc = defineJournalDoc<{ cards: Record<string, ConsentCard & { answer?: 'allow' | 'deny' }>; opened?: number }>('familiar.consent', () => ({ cards: {} }));
const AckEntry = 'familiar.ack';
const NoticeEntry = 'familiar.notice';

const RECOVERED_WORDS = "This turn was resumed after a restart, so server tools aren't used in it. They work again from your next message.";

const STOPPED_WORDS = 'Not done: the app closed while this was running, and it was not run again. The person was asked whether to do it now.';

const ReminderEntry = 'familiar.reminder';

/**
 * A parked wake: sleeps durably until `at`, then delivers. Each journal makes its own, around its own
 * notifier: pi-durable finds a task's code by name in the journal's registry, so nothing is shared.
 */
const wakeAtTask = (notifier: NotifierPort) => defineTask<{ text: string; at: number }, { phase: 'wait' } | { phase: 'deliver' }, null>({
  name: 'familiar.wake-at',
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    wait: (task: any, runtime: any, context: any) => runtime.sleepUntil(task.input.at, { phase: 'deliver' }, context),
    // The notification goes out first, with an id the notifier shows once; then one commit writes the
    // chat line and marks the wake done. A kill between the two runs this phase again: the same id, so
    // one notification, and the line is written once, with the done mark.
    deliver: async (task: any, runtime: any, context: any) => {
      const id = `wake:${task.id}`;
      await notifier.notify({ id, text: task.input.text, at: task.input.at });
      const chat = await runtime.conversation(runtime.conversationId, context);
      await runtime.commit(async (tx: any) => {
        await chat.submit(tx, { type: 'write', entry: { kind: ReminderEntry, data: { text: task.input.text, at: task.input.at, notification: id } } });
        return { status: 'terminal', outcome: { status: 'completed', result: null } };
      }, context);
    }
  },
  abort: (_task: any, runtime: any, context: any) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
} as any);

export interface Journal {
  /** The presence `gen` of this start. */
  readonly gen: string;
  /**
   * Sends your message. A bare acknowledgement ("thanks", "ok") gets no reply message, unless it answers
   * her last message's question. `requestId` makes a resend after a restart find the same turn.
   */
  send(text: string, requestId: string): Promise<SendResult>;
  /** Waits for a turn by its id, after a restart too. */
  turn(id: string): Turn;
  /** Open consent cards, as stored: the ones a restart left are here before they're asked again. */
  consents(): Promise<readonly ConsentCard[]>;
  /** What the loop is asking you, in chat: the view over how the newest run stopped. At most one. */
  questions(): Promise<readonly Question[]>;
  /**
   * Answers a question, in one commit that checks it's still open. Yes to `steps` or `cap` goes on with
   * the turn; Yes to `redo` or `rerun` asks her to do every listed step again; No or Skip sends a queued
   * message on, if there is one (Skip always goes on, without the calls). A question no longer open
   * starts nothing: you get the earlier answer's turn, or nothing if you moved on.
   */
  answer(id: string, yes: boolean, requestId: string): Promise<Turn | undefined>;
  /** Send now, when it shows: nothing running, a message queued, no question open. */
  queued(): Promise<SendNowOffer | undefined>;
  /** Sends the oldest queued message on, if what the button was shown for still holds. */
  sendNow(offer: SendNowOffer, requestId: string): Promise<Turn | undefined>;
  /**
   * Her own line: one model call with no tools, through the caps, then one commit. Model-visible only
   * into a quiet chat (nothing running, nothing queued, no stopped run); otherwise shown only. Never starts
   * a run. Undefined when the call failed or paused: she stays quiet.
   */
  remark(prompt: RemarkPrompt): Promise<Remark | undefined>;
  /** The engine's setup, for the pin tests: installed extensions, hooks, settings. */
  setup(): { readonly extensions: readonly string[]; readonly hooks: readonly { task: string; hooks: readonly string[] }[]; readonly settings: unknown };
  /** Parks a wait until `at` that survives a restart. */
  parkUntil(text: string, at: number): Promise<void>;
  /** Something happened that nobody asked about: the decider says whether and how she reacts. */
  notice(event: PersonaEvent): Promise<Decision>;
  /** The wake port fired: run what's due. */
  wake(): void;
  /** What's live in the engine: unfinished tasks and submissions, and what each waits on. For diagnostics. */
  inspect(): Promise<unknown>;
  /** The caps ledger as stored: settled spend and open reservations. */
  ledger(): Promise<Ledger>;
  /** One of Familiar's own documents, as committed. */
  read<T extends Record<string, any>>(token: JournalDocToken<T>): Promise<Readonly<T> | undefined>;
  /** The text of every entry, oldest first, for checks and the chat. */
  transcript(): Promise<readonly { kind: string; role?: string; text: string; error?: string }[]>;
  close(): Promise<void>;
  /** Tears the journal down with no shutdown path, as a crash would. Tests use it. */
  kill(): void;
}

/**
 * The Harness settings. Background compaction is off (B1: a background summary landing in an idle,
 * failed conversation places your queued message and starts a run, which Familiar must never do). Blocking
 * compaction stays: a long chat is summarized inside the turn. Everything else is pi-durable's default,
 * `afterFailedRun: "keep"` and the one-at-a-time queue modes among them. No `modelOverrides`: an override
 * that set `backgroundTokens` would turn it back on for that model.
 */
export function journalSettings(resendDelayMs = 2000) {
  return {
    retry: { maxRetries: 2, baseDelayMs: resendDelayMs },
    toolExecution: 'sequential' as const,
    compaction: (__FAMILIAR_MUTATIONS__ && mutant('background-compaction')) ? {} : { backgroundTokens: 0 },
    ...((__FAMILIAR_MUTATIONS__ && mutant('after-failed-continue')) ? { afterFailedRun: 'continue' as const } : {})
  };
}

export async function openJournal(options: JournalOptions): Promise<Journal> {
  // The reserved namespace (5.9): `__` belongs to server tools' `<key>__<tool>` names, so no built-in may
  // take one, and no later tool can replace a server's. Checked before the journal is held.
  for (const t of options.tools) if (t.kind !== 'server' && t.name.includes('__')) throw new Error(`A built-in tool may not have __ in its name: ${t.name}`);
  const owner = await options.owner.acquire(options.store.name);
  // An open that fails anywhere after the acquire gives the journal back: its engine closed if it opened,
  // its timers stopped, and the lease released, so the next open goes ahead.
  const opened: { harness?: any; stop?: () => void } = {};
  try {
    return await openHeld(options, owner, opened);
  } catch (error) {
    opened.stop?.();
    try {
      await opened.harness?.close(ctx);
    } catch {
      // Closing is best effort here: the open's own error is the one to report.
    }
    owner.release();
    throw error;
  }
}

async function openHeld(options: JournalOptions, owner: { release(): void }, opened: { harness?: any; stop?: () => void }): Promise<Journal> {
  const clock = options.clock ?? systemClock;
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const gen = options.newGen?.() ?? Math.random().toString(36).slice(2, 10);
  const presence = presenceReporter(options.presence, options.persona.id, gen);
  const WakeAt = wakeAtTask(options.notifier);
  const stepCap = options.stepCap ?? 8;
  let dead = false;
  let rootId: any;
  let harness: any;

  const report = (kind: string, error: unknown) => options.onReport?.({ kind, message: String((error as any)?.message ?? error) });

  /* ---------- the model, under caps, under retries ---------- */

  let caps: ReturnType<typeof createCaps> | undefined;
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const cancel = clock.setTimer(resolve, ms, { background: false });
      signal?.addEventListener('abort', () => {
        cancel?.();
        resolve();
      });
    });
  // The caps count a turn as the tool-call bound does (bounds.ts): from your message, across every
  // "go on", by its id in the turn registry (turns.ts).
  const turnOf = async (): Promise<string> => turnKeyOf(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(TurnsDoc, ctx));
  /**
   * The sources of everything in the conversation's current context, newest first back to its start (the
   * newest head marker): a server tool's result carries its server, her remark the sources it was made
   * from. A context that starts at a compaction summary counts as outside if any request ever was, since a
   * summary made while handling outside content carries it (5.6). A request is outside if this is not empty.
   */
  const contextSources = async (): Promise<string[]> => {
    const out = new Set<string>();
    let cursor: unknown;
    for (let pages = 0; pages < 64; pages++) {
      const page = await root.entries({ order: 'descending' }, 100, cursor, ctx);
      for (const e of page.items) {
        if (e.kind === RemarkEntry) for (const src of e.data?.sources ?? []) out.add(String(src));
        const m = e.model?.[0];
        if (m?.role === 'toolResult' && typeof m.toolName === 'string' && m.toolName.includes('__')) out.add(`server:${m.toolName.slice(0, m.toolName.indexOf('__'))}`);
        if (e.head !== undefined || e.kind === 'pi.compaction') {
          const records: any = await harness.snapshot(OutsideDoc, ctx);
          if (Object.values(records?.requests ?? {}).some((r: any) => (r.sources ?? []).length > 0)) out.add('compacted');
          return [...out].sort();
        }
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return [...out].sort();
  };
  /** The outside record of each turn request, written before it's sent and never changed. */
  const recordOutside = async (): Promise<void> => {
    const sources = await contextSources();
    const key = `request:${Math.random().toString(36).slice(2, 12)}`;
    await harness.commit(async (tx: any) => {
      const doc = await tx.doc(OutsideDoc);
      doc.requests[key] = { sources, at: clock.now() };
      keepNewest(doc.order, doc.requests, key);
    }, ctx);
  };
  const port = async (): Promise<ModelPort> => {
    const turn = await turnOf();
    const capped = cappedPort(options.model, caps!, () => ({ ...options.caps.call, turn, conversation: String(rootId) }));
    const retried = withRetries(capped, { ...options.retries, sleep });
    // The request's outside record goes first, then the request.
    return {
      async *stream(request, signal) {
        await recordOutside();
        yield* retried.stream(request, signal);
      }
    };
  };
  const { provider } = portProvider(port, { id: PROVIDER, modelId: options.modelId });
  const models = createModels();
  models.setProvider(provider);

  /* ---------- consent, and the questions a restart leaves ---------- */

  /** The bounds on tool calls (bounds.ts), counted in the journal before anything else about the call. */
  const bounded = async (api: any): Promise<string | undefined> => {
    const id = String(api.taskId);
    const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
    const slots: any[] = live?.tools ?? [];
    const found = slots.findIndex((s) => String(s.taskId) === id);
    const index = found < 0 ? slots.length : found;
    const verdict = await harness.commit(async (tx: any) => {
      const registry = await tx.doc(TurnsDoc);
      // Each turn has its own budget, kept until the turn is finished: another turn can't reset it.
      const key = turnKeyOf(live, registry);
      const record = openTurn(registry, key, clock.now());
      const budget: Budget = JSON.parse(JSON.stringify(record.budget));
      const out = admit(budget, id, index);
      registry.turns[key] = { ...JSON.parse(JSON.stringify(record)), budget };
      return { ...out, turn: key };
    }, ctx);
    if (verdict.ok) return undefined;
    const words = boundWords(verdict.bound);
    // One line in chat per reply, or per turn. The request id finds the same line after a restart.
    const reply = verdict.bound === 'reply' ? `:${String(slots[0]?.taskId ?? id)}` : '';
    await root.submit({ type: 'write', entry: { kind: NoticeEntry, data: { text: words } }, requestId: `bound:${verdict.turn}:${verdict.bound}${reply}` }, ctx);
    return `${words} This call was not run.`;
  };

  /**
   * Submits for the person's own message (a new turn) or for an answer that carries on the current one,
   * in one commit with `also`, the person's own record of what they did. Retried with the same request
   * id, it finds the same submission.
   */
  const submitInTurn = async (
    draft: any,
    carry: boolean,
    also?: (tx: any, sid: string) => Promise<void>,
    carryKey?: string,
    opts: { track?: boolean; already?: (tx: any) => Promise<string | undefined> } = {}
  ) => {
    const id = await harness.commit(async (tx: any) => {
      // Checked inside the commit: an answer already given returns its result, and changes nothing.
      const existing = await opts.already?.(tx);
      if (existing !== undefined) return existing;
      const sid = draft ? String(await root.submit(tx, draft)) : '';
      if (sid && opts.track !== false) {
        const registry = await tx.doc(TurnsDoc);
        const key = carry ? carryKey || registry.current || sid : sid;
        if (!carry) registry.current = sid;
        recordSubmission(registry, sid, key, clock.now());
      }
      await also?.(tx, sid);
      return sid;
    }, ctx);
    return id ? harness.submission(Number(id), ctx) : undefined;
  };
  /** What a request id already did: a person's message is acted on once, however often it's sent. */
  const remembered = async (requestId: string) => ((await harness.snapshot(SentDoc, ctx)) as any)?.byRequest?.[requestId] as SentRecord | undefined;
  const rememberIn = async (tx: any, requestId: string, record: SentRecord) => {
    const sent = await tx.doc(SentDoc);
    if (sent.byRequest[requestId]) return;
    sent.byRequest[requestId] = record;
    sent.order.push(requestId);
    while (sent.order.length > 256) delete sent.byRequest[sent.order.shift()!];
  };

  /** The run live when this journal opened (2.7), and the current run's identity. */
  let recovered: string | undefined;
  const identityOf = (live: any): string | undefined => (live?.run ? String(live.run.inputs?.[0] ?? `first:${live.run.first}`) : undefined);
  const runIdentity = async () => identityOf(await harness.snapshot(LiveDoc, rootId, ctx));

  /** The view (view.ts) from committed state. */
  let atEnd: Question | undefined;
  const viewNow = async (): Promise<RunView> =>
    runView(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(InterruptionsDoc, ctx), await harness.snapshot(AnswersDoc, ctx), stepCap);
  /** The view inside a commit. */
  const viewIn = async (tx: any): Promise<RunView> => runView(await tx.doc(LiveDoc, rootId), await tx.doc(InterruptionsDoc), await tx.doc(AnswersDoc), stepCap);

  /** Why a call of `name` waits for the person, if it does: an open interruption, or one skipped this turn. */
  const parkedFor = async (name: string, step: string): Promise<string | undefined> => {
    const view = await viewNow();
    if (view.state === 'question' && view.question.steps?.some((s) => s.tool === name && s.step !== step)) return `${name} was cut off when the app closed. It waits for the person to choose Run again or skip.`;
    const turn = turnKeyOf(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(TurnsDoc, ctx));
    const answers: any = await harness.snapshot(AnswersDoc, ctx);
    const skipped = Object.values(answers?.byTask ?? {}).some((a: any) => !a.yes && a.turn === turn && (a.tools ?? []).includes(name));
    if (skipped) return `The person chose to skip ${name} in this turn.`;
    return undefined;
  };
  // A round that left interruption records ends its run: the model gets no chance to call the tool again
  // on its own, and the turn waits for the person's answer. Read from the journal, so it holds after a
  // restart: a kill between the records and the abort resumes the round, and this runs again. Only that
  // run's task is stopped: messages you sent meanwhile stay queued, and the question holds them.
  const parkHook = hook(GenerationTask, {
    afterTools: async (_assistant: unknown, _results: unknown, api: any) => {
      const records: any = await harness.snapshot(InterruptionsDoc, ctx);
      if (!Object.values(records?.steps ?? {}).some((r: any) => r.task === String(api.taskId))) return;
      void harness.abortTask(api.taskId, ctx).catch((e: unknown) => report('park', e));
    }
  } as any);

  /**
   * The consent gate (gate.ts): the bounds, a parked interruption, then the policy, and consent when it
   * asks. A reason not to run, or how the call was allowed: by a standing "always", or by the person's yes
   * to this call. `beforeTool` runs it on every call, and each tool's own execute runs it again, for a call
   * recovered after a crash, which never passes `beforeTool`; the execute hands the tool how it was allowed.
   */
  const gateCall = async (call: { name: string; arguments: unknown }, api: any, context: any): Promise<{ refused: string } | Allowed> => {
    const v = await gateWords(call, api, context);
    return typeof v === 'string' ? { refused: v } : v;
  };
  const gateWords = async (call: { name: string; arguments: unknown }, api: any, context: any): Promise<string | Allowed> => {
    const refused = await bounded(api);
    if (refused) return refused;
    const tool = tools.get(call.name);
    // The recovered-run gate (2.7): a run that was live when this journal opened is never given server
    // tools. pi-durable can't give a recovered run its own registry, so it would call with today's.
    if (tool?.kind === 'server' && recovered !== undefined && (await runIdentity()) === recovered) return RECOVERED_WORDS;
    const id = String(api.taskId);
    // A tool cut off by a close waits for the person: Run again, or skip. Until then, and for the
    // rest of the turn after a skip, a call the model makes to it again doesn't run.
    const parked = await parkedFor(call.name, id);
    if (parked) return parked;
    let policy = gateFor(call.name, tool, options.policy?.());
    if (policy === 'deny') return `${call.name} is turned off.`;
    // A server's tool is bound to the exact call: its facts are read from the server's run now.
    const bound = tool?.consent !== undefined;
    const factsNow = (): CardFacts | undefined => tool?.consent?.facts(call.arguments);
    let facts = bound ? factsNow() : undefined;
    if (bound && !facts) return `${call.name} can't be sent now: its server isn't running, it no longer offers this tool as it was, or the arguments aren't plain JSON.`;
    // "Always" never acts on outside content (5.6): while the conversation carries any, it asks.
    const outside = bound ? (await contextSources()).length > 0 : false;
    if (policy === 'allow' && bound && outside) policy = 'ask';
    if (policy === 'allow') return { allowedBy: 'always', ...(facts ? { facts, outside } : {}) };
    const stored: (ConsentCard & { answer?: 'allow' | 'deny' }) | undefined = (await harness.snapshot(ConsentDoc, ctx))?.cards?.[id];
    if (stored?.answer === 'deny') return 'The person said no.';
    if (stored?.answer === 'allow') {
      // A Yes covers only what its card showed: the stored facts must match this call now.
      if (!bound) return { allowedBy: 'asked' };
      if (stored.facts && facts && sameFacts(stored.facts, facts)) return { allowedBy: 'asked', facts: stored.facts, outside };
    }
    const turn = turnKeyOf(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(TurnsDoc, ctx));
    const signal: AbortSignal | undefined = context?.abortSignal;
    // Each pass is one presentation with a fresh one-use id. When the facts change while it's shown, the
    // id is retired and the card asked again with the new facts; a Yes to the old one mints nothing.
    for (let pass = 0; pass < 8; pass++) {
      const card: ConsentCard = {
        id,
        tool: call.name,
        arguments: call.arguments,
        doing: tool ? tool.doing(call.arguments) : `using ${call.name}`,
        askedAt: stored?.askedAt ?? clock.now(),
        turn,
        presentation: Math.random().toString(36).slice(2, 14),
        ...(facts ? { facts, always: !outside } : {})
      };
      await harness.commit(async (tx: any) => {
        (await tx.doc(ConsentDoc)).cards[id] = card;
      }, ctx);
      // The wait observes the call's abort signal, so a close never hangs on an unanswered card. The card
      // stays in the journal, unanswered, and is asked again on the next open.
      const ok = await new Promise<boolean | 'closed'>((resolve) => {
        if (signal?.aborted) return resolve('closed');
        signal?.addEventListener('abort', () => resolve('closed'), { once: true });
        options.consent.ask(card, signal).then(resolve, () => resolve(false));
      });
      if (ok === 'closed') throw new Error('The journal closed while the card was open.');
      // The answer counts only for the presentation still current.
      const current = (await harness.snapshot(ConsentDoc, ctx))?.cards?.[id];
      if (current?.presentation !== card.presentation) return 'The card was answered after it was replaced, so nothing was sent.';
      if (ok && bound) {
        const now = factsNow();
        if (!now || !sameFacts(now, card.facts!)) {
          facts = now;
          if (!facts) return `${call.name} changed or stopped while you were asked, so nothing was sent.`;
          continue;
        }
      }
      await harness.commit(async (tx: any) => {
        const doc = await tx.doc(ConsentDoc);
        if (doc.cards[id]?.presentation === card.presentation) doc.cards[id].answer = ok ? 'allow' : 'deny';
      }, ctx);
      return ok ? { allowedBy: 'asked', ...(card.facts ? { facts: card.facts, outside } : {}) } : 'The person said no.';
    }
    return `${call.name} kept changing while you were asked, so nothing was sent.`;
  };

  const consentHook = hook(ToolTask, {
    beforeTool: async (call: any, api: any, context: any) => {
      const verdict = await gateCall(call, api, context);
      return 'refused' in verdict ? { block: verdict.refused } : undefined;
    },
    afterTool: async (call: any, result: any, api: any) => {
      const id = String(api.taskId);
      const tool = tools.get(call.name);
      const interrupted = (result.diagnostics ?? []).some((d: any) => d.code === 'interrupted');
      // A server's call is known by its name too: the `__` namespace is server tools' alone (5.9), so a
      // cut-off call whose wrapper this open doesn't hold (its server not started) still gets Run again.
      const server = tool ? tool.kind === 'server' : String(call.name).includes('__');
      await harness.commit(async (tx: any) => {
        const consent = await tx.doc(ConsentDoc);
        if (consent.cards[id]) delete consent.cards[id];
        if (!interrupted || (!tool && !server)) return;
        // One record per interrupted step, under the task that runs this round: the task runFailure will
        // name once the park hook stops it. Written again unchanged if a kill makes the round run again.
        const records = await tx.doc(InterruptionsDoc);
        if (records.steps[id]) return;
        const live = await tx.doc(LiveDoc, rootId);
        const turn = turnKeyOf(live, await tx.doc(TurnsDoc));
        records.steps[id] =
          server || !tool
            ? { step: id, task: String(live?.run?.taskId ?? ''), kind: 'rerun', tool: call.name, arguments: call.arguments, turn, text: `${call.name} was cut off when the app closed, and may have partially run.` }
            : { step: id, task: String(live?.run?.taskId ?? ''), kind: 'redo', tool: call.name, arguments: call.arguments, turn, text: `I was ${tool.doing(call.arguments)} when the app closed. Do it now?` };
      }, ctx);
      if (interrupted && tool?.kind === 'effect') return { ...result, output: [{ type: 'text', text: STOPPED_WORDS }] };
      return undefined;
    }
  } as any);

  const familiar = defineExtension({ name: 'familiar', tools: options.tools.map((t) => toDurableTool(t, gateCall)), hooks: [consentHook, parkHook], tasks: [WakeAt] } as any);
  const registry = createRegistry();
  registry.install(familiar);

  /* ---------- waking ---------- */

  let cancelWake: (() => void) | undefined;
  const onWake = (w: { active: boolean; at?: number }) => {
    if (dead) return;
    options.wake.wakeAt(w.at);
    cancelWake?.();
    cancelWake = undefined;
    // While the page lives, its own timer wakes it too.
    if (w.at !== undefined) armWake(w.at);
  };
  // pi-durable offers a wake time once, when it changes, so a timer that fires before it's due (timers
  // may fire a millisecond early) must arm again, or the sleep is never run. One that fires while the
  // Harness is still opening is covered by the resume at the end of the open.
  const armWake = (at: number) => {
    cancelWake = clock.setTimer(
      () => {
        if (dead) return;
        if (clock.now() < at) return armWake(at);
        harness?.resume();
      },
      Math.max(0, at - clock.now()) + 1,
      { background: false }
    );
  };

  const settings = journalSettings(options.resendDelayMs);
  opened.stop = () => {
    dead = true;
    presence.stop();
    cancelWake?.();
  };
  harness = await Harness.open(
    options.store.storage,
    {
      models,
      registry,
      identity: { attribution: null },
      settings,
      now: () => clock.now(),
      setTimer: (cb: () => void, ms: number, o: { background: boolean }) => clock.setTimer(cb, ms, o),
      onWake,
      onReport: (r: any) => report(r.kind, r.error)
    } as any,
    ctx
  );
  opened.harness = harness;
  const root: any = await harness.root(ctx, {
    agent: { model: { provider: PROVIDER, modelId: options.modelId }, instructions: options.persona.instructions, maxTurns: stepCap }
  });
  rootId = root.id;
  // The ledger keeps whole every turn something can still resume, read live in its own commit.
  const usage = journalUsageStore(harness, async (tx) => [...(await liveResumable(tx))]);
  caps = createCaps(options.caps.config, usage, clock, options.caps.options);

  /* ---------- what can still resume, read live ---------- */

  /**
   * The turns something can still resume, read in the caller's commit: a run in flight, an open question,
   * an open consent card, a queued submission. Submissions are read with tx.submission, so the caller must
   * have made no admission in this commit yet. Settled ones leave the registry's pending list.
   */
  const liveResumable = async (tx: any): Promise<Set<string>> => {
    const registry = await tx.doc(TurnsDoc);
    const live = await tx.doc(LiveDoc, rootId);
    const out = new Set<string>();
    if (live?.run) out.add(turnOfInputs(live.run.inputs ?? [], registry));
    const view = runView(live, await tx.doc(InterruptionsDoc), await tx.doc(AnswersDoc), stepCap);
    if (view.state === 'question') out.add(view.question.turn ?? turnOfInputs(live.runFailure?.inputs ?? [], registry));
    for (const card of Object.values((await tx.doc(ConsentDoc)).cards) as any[]) if (!card.answer && card.turn) out.add(card.turn);
    const still: string[] = [];
    for (const sid of registry.pending ?? []) {
      const status = (await tx.submission(Number(sid)))?.status;
      if (status === 'queued') out.add(registry.of[sid] ?? sid);
      if (status === 'queued' || status === 'placed') still.push(sid);
    }
    if ((registry.pending ?? []).length !== still.length) registry.pending = still;
    return out;
  };

  /* ---------- the decision slot ---------- */

  const recentEvents: PersonaEvent[] = [];
  const recentReactions: PastReaction[] = [];
  let lastChatAt: number | undefined;
  const remember = (event: PersonaEvent) => {
    recentEvents.push(event);
    if (recentEvents.length > 10) recentEvents.shift();
  };
  const notice = async (event: PersonaEvent): Promise<Decision> => {
    const now = clock.now();
    const decision = await options.decider.decide(event, {
      ...options.ambient(),
      recentEvents: [...recentEvents],
      recentReactions: [...recentReactions],
      minutesSinceChat: lastChatAt === undefined ? null : (now - lastChatAt) / 60_000,
      now,
      localHour: new Date(now).getHours()
    });
    remember(event);
    if (decision.act !== 'quiet') {
      recentReactions.push({ at: now, decision, event: event.name });
      if (recentReactions.length > 3) recentReactions.shift();
      options.onReaction?.(decision, event);
    }
    return decision;
  };

  /* ---------- the state it reports ---------- */

  // Presence reads committed state only: pi.live, the consent cards, and the view's own records.
  let consentOpen = false;
  let lastLive: any;
  let records: any;
  let answered: any;
  const refresh = () => {
    const view = runView(lastLive, records, answered, stepCap);
    presence.update(stateOf({ live: lastLive, waiting: consentOpen || view.state === 'question', failed: view.state === 'error' }));
  };
  // Watches need their documents to exist.
  await harness.commit(async (tx: any) => {
    (await tx.doc(ConsentDoc)).opened = clock.now();
    (await tx.doc(InterruptionsDoc)).opened = clock.now();
    (await tx.doc(AnswersDoc)).opened = clock.now();
  }, ctx);
  const liveWatch = await harness.watchDoc(LiveDoc, rootId, ctx);
  const consentWatch = await harness.watchDoc(ConsentDoc, ctx);
  const recordsWatch = await harness.watchDoc(InterruptionsDoc, ctx);
  const answersWatch = await harness.watchDoc(AnswersDoc, ctx);
  const seenTools = new Set<string>();
  let lastRunInputs: string[] = [];
  /**
   * A run ended. The turn's "finished" mark is a hint, for display and the 64-turn cap: it's set when
   * nothing read live in this commit can resume the turn. Nothing about questions is recorded here: the
   * question is pi-durable's record already. Interruption records no failure names any more are tidied.
   */
  const endOfRun = async (inputs: string[]) => {
    if (dead) return;
    await harness.commit(async (tx: any) => {
      const registry = await tx.doc(TurnsDoc);
      const live = await tx.doc(LiveDoc, rootId);
      const resumable = await liveResumable(tx);
      const turn = turnOfInputs(inputs.length ? inputs : (live?.runFailure?.inputs ?? []).map(String), registry);
      if (!resumable.has(turn)) finishTurn(registry, turn, clock.now(), resumable);
      const records = await tx.doc(InterruptionsDoc);
      const keep = new Set([String(live?.runFailure?.taskId ?? ''), String(live?.run?.taskId ?? '')]);
      const steps = Object.keys(records.steps);
      if (steps.length > KEEP_RECORDS) for (const step of steps.slice(0, steps.length - KEEP_RECORDS)) if (!keep.has(records.steps[step].task)) delete records.steps[step];
    }, ctx);
  };
  const onLive = (live: any) => {
    const wasRunning = !!lastLive?.run;
    // Named mutations only: the old shape's question kept from the run's end, and RETHINK's automatic
    // placement after an error.
    if (wasRunning && !live?.run && live?.runFailure) {
      void viewNow().then((v) => {
        if (v.state === 'question') atEnd = v.question;
      });
      if ((__FAMILIAR_MUTATIONS__ && mutant('auto-placement'))) void harness.snapshot(InboxDoc, rootId, ctx).then((inbox: any) => (oldestQueued(inbox) ? root.submit({ type: 'continue' }, ctx) : undefined)).catch(() => undefined);
    }
    lastLive = live;
    refresh();
    if (dead) return;
    // A tool or a reply done while the chat is hidden: the decider picks a gesture or quiet.
    for (const slot of live?.tools ?? []) {
      if (slot.status === 'done' && slot.taskId && !seenTools.has(String(slot.taskId))) {
        seenTools.add(String(slot.taskId));
        if (!options.ambient().chatInFront) void notice({ name: 'tool-done', at: clock.now() }).catch((e) => report('decide', e));
      }
    }
    if (wasRunning && !live?.run) void endOfRun(lastRunInputs).catch((e) => report('turns', e));
    if (live?.run) lastRunInputs = (live.run.inputs ?? []).map(String);
    if (wasRunning && !live?.run) {
      lastChatAt = clock.now();
      if (!live?.runFailure && !options.ambient().chatInFront) void notice({ name: 'reply-done-hidden', at: clock.now() }).catch((e) => report('decide', e));
    }
  };
  const openCards = (doc: any) => Object.values(doc?.cards ?? {}).some((c: any) => !c.answer);
  records = recordsWatch.value;
  answered = answersWatch.value;
  consentOpen = openCards(consentWatch.value);
  onLive(liveWatch.value);
  liveWatch.start(async (call: any) => call.kind === 'value' && onLive(call.value));
  consentWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    consentOpen = openCards(call.value);
    refresh();
  });
  recordsWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    records = call.value;
    refresh();
  });
  answersWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    answered = call.value;
    refresh();
  });

  /* ---------- turns ---------- */

  const entryText = (entry: any): { role?: string; text: string; error?: string } => {
    // Her line: what she said, whether her model saw it or not.
    if (entry?.kind === RemarkEntry) return { role: 'assistant', text: String(entry.data?.text ?? '') };
    const m = entry?.model?.[0];
    if (!m) return { text: typeof entry?.data?.text === 'string' ? entry.data.text : '' };
    const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((b: any) => (b.type === 'text' ? b.text : b.type === 'toolCall' ? `[${b.name} ${JSON.stringify(b.arguments)}]` : '')).join('');
    const error = m.errorMessage ? (decodeModelError(m.errorMessage)?.message ?? m.errorMessage) : undefined;
    return { role: m.role, text, ...(m.stopReason && m.stopReason !== 'stop' && m.stopReason !== 'toolUse' ? { error: error ?? m.stopReason } : {}) };
  };
  const lastPersonaText = async (): Promise<string | undefined> => {
    const page = await root.entries({ order: 'descending' }, 50, undefined, ctx);
    for (const e of page.items) {
      if (e.kind === RemarkEntry) return entryText(e).text;
      const m = e.model?.[0];
      if (m?.role === 'assistant' && m.stopReason !== 'aborted' && m.stopReason !== 'error') return entryText(e).text;
    }
    return undefined;
  };
  const turnFor = (submission: any): Turn => ({
    id: String(submission.id),
    async wait() {
      const settled = await submission.wait(ctx);
      if (settled.status === 'done') {
        const answer = settled.answer !== undefined ? await root.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), ctx) : undefined;
        return { status: 'answered', text: answer ? entryText(answer).text : '' };
      }
      // All read in one transaction (2.2): how the newest run stopped, and whether that run is this
      // turn's, by its inputs (this submission, or another of its turn, a Yes's continue say). Another
      // turn's stop is never this turn's question or failure.
      const sid = String(submission.id);
      const now: { view: RunView; live: any; mine: boolean } = await harness.commit(async (tx: any) => {
        const live = await tx.doc(LiveDoc, rootId);
        const view = runView(live, await tx.doc(InterruptionsDoc), await tx.doc(AnswersDoc), stepCap);
        const registry = await tx.doc(TurnsDoc);
        const inputs: string[] = (live?.runFailure?.inputs ?? []).map(String);
        const mine = inputs.includes(sid) || (inputs.length > 0 && registry.of?.[sid] !== undefined && turnOfInputs(inputs, registry) === registry.of[sid]);
        // Plain copies: the transaction's documents can't be read once it settles.
        return JSON.parse(JSON.stringify({ view, live: live ?? null, mine }));
      }, ctx);
      if (now.mine && now.view.state === 'question') return { status: 'asks', question: now.view.question };
      if (!now.mine) {
        const detail = typeof settled.detail === 'string' ? settled.detail : undefined;
        return { status: 'failed', reason: String(settled.reason ?? 'unknown'), message: decodeModelError(detail)?.message ?? detail ?? '' };
      }
      const error = decodeModelError(now.live?.runFailure?.detail);
      return { status: 'failed', reason: String(settled.reason ?? now.live?.runFailure?.reason ?? 'unknown'), message: now.view.state === 'error' ? now.view.message : (error?.message ?? String(now.live?.runFailure?.detail ?? '')) };
    }
  });

  // Background compaction is pinned off, but a journal made before the pin may hold a compaction task
  // that would resume and place queued input. Abort each before anything is scheduled: opening and
  // committing schedule nothing, and the abort handler runs once resume() starts the scheduler.
  const staleCompactions = await harness.commit(async (tx: any) => {
    const ids: unknown[] = [];
    let cursor: any;
    do {
      const page = await tx.scanTasks({ conversationId: rootId, kind: 'pi.compaction' }, 100, cursor);
      for (const t of page.items) if (t.state?.status !== 'terminal' && t.owner === undefined) ids.push(t.id);
      cursor = page.next;
    } while (cursor);
    return ids;
  }, ctx);
  for (const id of staleCompactions) await harness.abortTask(id, ctx);
  // The run live at open, if any, by an identity that holds across its generations (B4): noted before any
  // task can run, in memory only.
  recovered = identityOf(await harness.snapshot(LiveDoc, rootId, ctx));

  harness.resume();

  /** Acks being decided now, by request id: a send that lost the ack's commit to an identical one waits
      for the winner's decision instead of deciding again. */
  const deciding = new Map<string, Promise<Decision>>();
  const QUIET: Decision = { act: 'quiet' } as Decision;
  const resultOf = async (record: SentRecord, requestId: string): Promise<SendResult> => {
    if (record.kind === 'ack') return { replied: false, decision: record.decision ?? (await deciding.get(requestId)?.catch(() => QUIET)) ?? QUIET };
    return { replied: true, turn: turnFor(await harness.submission(Number(record.submission), ctx)) };
  };

  const questions = async (): Promise<readonly Question[]> => {
    const view = await viewNow();
    // The old shape, as a named mutation: the question recorded when the run ended, kept until answered.
    if (atEnd && (__FAMILIAR_MUTATIONS__ && mutant('question-at-end'))) return (await harness.snapshot(AnswersDoc, ctx))?.byTask?.[atEnd.id.slice(4)] ? [] : [atEnd];
    return view.state === 'question' ? [view.question] : [];
  };
  /** The words of a Yes to cut-off steps: one line per step, through the gate again. */
  const againWords = (q: Question): string =>
    (q.steps ?? []).map((s) => (s.kind === 'redo' ? `Yes, do it now: ${tools.get(s.tool)?.doing(s.arguments) ?? s.tool}.` : `Run ${s.tool} again.`)).join(' ');

  return {
    gen,
    async send(text, requestId) {
      // A resend finds what the first send did, before the text is looked at again: by then her last
      // message may have changed, and the same text would be read another way.
      const prior = await remembered(requestId);
      if (prior) return resultOf(prior, requestId);
      // The record above keeps the newest 256 request ids; pi-durable's own record of the request id
      // keeps every one. An old ack's resend is an ack again, with no new reaction.
      const known: { id: string; type: string } | undefined = await harness.commit(async (tx: any) => {
        const r = await tx.submissionByRequest(rootId, requestId);
        return r ? { id: String(r.id), type: String(r.type) } : undefined;
      }, ctx);
      if (known) return known.type === 'write' ? { replied: false, decision: QUIET } : { replied: true, turn: turnFor(await harness.submission(Number(known.id), ctx)) };
      const at = clock.now();
      remember({ name: 'message-sent', at });
      if (!needsReply(text, await lastPersonaText(), { personaName: options.persona.name })) {
        // Kept in the transcript for you, never sent to the model: nothing is answered. The write and its
        // record come first, in one commit that checks the record inside it; only the send whose commit
        // wins decides the reaction, once.
        let won = false;
        let decide!: (d: Decision) => void;
        const decided = new Promise<Decision>((r) => (decide = r));
        try {
          await submitInTurn(
            { type: 'write', entry: { kind: AckEntry, data: { text } }, requestId },
            true,
            async (tx) => {
              // Noted as this commit wins, so an identical send that lost waits for this decision.
              won = true;
              deciding.set(requestId, decided);
              await rememberIn(tx, requestId, { kind: 'ack' });
            },
            undefined,
            { track: false, already: async (tx) => ((await tx.doc(SentDoc)).byRequest[requestId] ? '' : undefined) }
          );
          if (won) {
            const decision = await notice({ name: 'ack-sent', at });
            decide(decision);
            await harness.commit(async (tx: any) => {
              const record = (await tx.doc(SentDoc)).byRequest[requestId];
              if (record?.kind === 'ack' && !record.decision) record.decision = decision;
            }, ctx);
          }
        } finally {
          decide(QUIET);
          if (won && deciding.get(requestId) === decided) deciding.delete(requestId);
        }
        return resultOf((await remembered(requestId)) ?? { kind: 'ack' }, requestId);
      }
      lastChatAt = at;
      await submitInTurn({ type: 'input', content: text, requestId }, false, (tx, sid) => rememberIn(tx, requestId, { kind: 'turn', submission: sid }));
      return resultOf((await remembered(requestId))!, requestId);
    },
    turn(id) {
      return {
        id,
        async wait() {
          const submission = await harness.submission(Number(id), ctx);
          if (!submission) throw new Error(`No turn ${id} in the journal.`);
          return turnFor(submission).wait();
        }
      };
    },
    async consents() {
      const doc: any = await harness.snapshot(ConsentDoc, ctx);
      return Object.values(doc?.cards ?? {}).filter((c: any) => !c.answer).map(({ answer: _, ...card }: any) => card);
    },
    questions,
    async answer(id, yes, requestId) {
      if (!id.startsWith('run:')) return undefined;
      let splitLater: any;
      const task = id.slice('run:'.length);
      // One commit: read, check the question is still open, record the answer and admit what it starts.
      // Every read comes before the admission; the answer and its submission are stored together or not
      // at all, so a retry after a kill, or a second answer at the same moment, finds the first.
      const sid: string = await harness.commit(async (tx: any) => {
        const answers = await tx.doc(AnswersDoc);
        const prior = answers.byTask[task];
        if (prior) return prior.submission ?? '';
        const live = await tx.doc(LiveDoc, rootId);
        const view = runView(live, await tx.doc(InterruptionsDoc), answers, stepCap);
        // Not open: a run is live, the failure names another task, or you moved on. Nothing changes. (The
        // old shape, a named mutation, answers the question it kept from the run's end instead.)
        const kept = atEnd?.id === id && !live?.run && (__FAMILIAR_MUTATIONS__ && mutant('question-at-end')) ? atEnd : undefined;
        if (!kept && (view.state !== 'question' || view.question.id !== id)) return '';
        const q = kept ?? (view as Extract<RunView, { state: 'question' }>).question;
        const inbox = await tx.doc(InboxDoc, rootId);
        const registry = await tx.doc(TurnsDoc);
        const asked = q.turn ?? turnOfInputs(live.runFailure?.inputs ?? [], registry);
        const queued = oldestQueued(inbox);
        const cutOff = q.kind === 'redo' || q.kind === 'rerun';
        // Yes to cut-off steps: ask her to do them again. Yes otherwise, a Skip, or a No with a message
        // queued: a continue, which places the oldest queued item first. A No with nothing queued: nothing.
        const draft = yes && cutOff ? { type: 'input', content: againWords(q), requestId } : yes || cutOff || queued ? { type: 'continue', requestId } : undefined;
        // A named mutation: the answer's check in this commit, its submission in a later one.
        if (draft && (__FAMILIAR_MUTATIONS__ && mutant('split-answer'))) {
          answers.byTask[task] = { yes, kind: q.kind, turn: asked };
          splitLater = draft;
          return '';
        }
        const started = draft ? String(await root.submit(tx, draft)) : '';
        if (started) {
          // The turn rule: a run belongs to the turn of the first input it places. A continue placing a
          // queued item goes to that item's turn; anything else carries on the answered turn.
          const turn = draft!.type === 'continue' && queued ? (registry.of[queued] ?? asked) : asked;
          recordSubmission(registry, started, turn, clock.now());
          if (turn !== asked) finishTurn(registry, asked, clock.now(), new Set([turn]));
        } else {
          finishTurn(registry, asked, clock.now());
        }
        // A Yes at a turn-tokens pause gives the turn one more allowance, granted by this Yes once.
        // A Yes never lifts a daily or dollar cap.
        if (yes && q.kind === 'cap' && q.pause === 'turn-tokens') {
          const ledgerDoc = await tx.doc(LedgerDoc);
          const ledger = { ...emptyLedger(), extensions: { ...(ledgerDoc.extensions ?? {}) }, granted: { ...(ledgerDoc.granted ?? {}) } };
          if (extendTurn(ledger, asked, id)) {
            ledgerDoc.extensions = ledger.extensions;
            ledgerDoc.granted = ledger.granted;
          }
        }
        answers.order ??= [];
        answers.byTask[task] = {
          yes,
          kind: q.kind,
          turn: asked,
          ...(started ? { submission: started } : {}),
          ...(!yes && cutOff ? { tools: [...new Set((q.steps ?? []).map((s) => s.tool))] } : {})
        };
        keepNewest(answers.order, answers.byTask, task);
        return started;
      }, ctx);
      if (splitLater) {
        const later = splitLater;
        splitLater = undefined;
        const s2 = (__FAMILIAR_MUTATIONS__ && mutant('split-answer')) ? String(await root.submit(later, ctx)) : '';
        return s2 ? turnFor(await harness.submission(Number(s2), ctx)) : undefined;
      }
      return sid ? turnFor(await harness.submission(Number(sid), ctx)) : undefined;
    },
    async queued() {
      const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
      if (live?.run) return undefined;
      const inbox: any = await harness.snapshot(InboxDoc, rootId, ctx);
      const first = (__FAMILIAR_MUTATIONS__ && mutant('per-message-send-now')) ? newestQueued(inbox) : oldestQueued(inbox);
      if (!first) return undefined;
      if ((await viewNow()).state === 'question') return undefined;
      if (live?.runFailure && (__FAMILIAR_MUTATIONS__ && mutant('hide-send-now'))) return undefined;
      return { submission: first, failure: live?.runFailure ? String(live.runFailure.taskId) : null };
    },
    async sendNow(offer, requestId) {
      const sid: string = await harness.commit(async (tx: any) => {
        const done = await tx.doc(SendNowDoc);
        const prior = done.byRequest[requestId];
        if (prior) return prior.sent ?? '';
        // Read first: tx.submission can't read after the commit's admission.
        const status = (await tx.submission(Number(offer.submission)))?.status;
        const live = await tx.doc(LiveDoc, rootId);
        const inbox = await tx.doc(InboxDoc, rootId);
        const view = await viewIn(tx);
        const failure = live?.runFailure ? String(live.runFailure.taskId) : null;
        const holds = !live?.run && failure === offer.failure && view.state !== 'question' && status === 'queued' && ((__FAMILIAR_MUTATIONS__ && mutant('per-message-send-now')) ? newestQueued(inbox) : oldestQueued(inbox)) === offer.submission;
        let sent = '';
        if (holds) {
          sent = String(await root.submit(tx, { type: 'continue', requestId }));
          const registry = await tx.doc(TurnsDoc);
          recordSubmission(registry, sent, registry.of[offer.submission] ?? offer.submission, clock.now());
        }
        done.byRequest[requestId] = { submission: offer.submission, ...(sent ? { sent } : {}) };
        keepNewest(done.order, done.byRequest, requestId);
        return sent;
      }, ctx);
      return sid ? turnFor(await harness.submission(Number(sid), ctx)) : undefined;
    },
    async remark(prompt) {
      if (dead) return undefined;
      const key = `moment:${Math.random().toString(36).slice(2, 12)}`;
      const sources = [...new Set(prompt.sources ?? [])].sort();
      // The outside record, before the request is sent.
      await harness.commit(async (tx: any) => {
        const doc = await tx.doc(OutsideDoc);
        if (!doc.requests[key]) doc.requests[key] = { sources, at: clock.now() };
        keepNewest(doc.order, doc.requests, key);
      }, ctx);
      // One request, no tools, through the caps under its own key: never resumable, so its reservation
      // settles when the call returns, or becomes a spent record at its deadline if the app dies. One try
      // only (2.1): an error, retryable or not, means she stays quiet.
      const capped = withRetries(
        cappedPort(options.model, caps!, () => ({ ...options.caps.call, turn: key, conversation: String(rootId) })),
        { ...options.retries, tries: 1, sleep }
      );
      let text = '';
      try {
        for await (const e of capped.stream({ model: options.modelId, system: prompt.system, messages: prompt.messages, tools: [] })) {
          if (e.type === 'text') text += e.delta;
          else if (e.type === 'error') return undefined;
        }
      } catch (error) {
        report('remark', error);
        return undefined;
      }
      text = text.trim();
      if (!text || dead) return undefined;
      // One commit: model-visible only into a quiet chat, read in this commit before the write's admission.
      // A model-visible write into an idle chat with queued items would start them; after a failed run it
      // would end the context in her words.
      const visible: boolean = await harness.commit(async (tx: any) => {
        const live = await tx.doc(LiveDoc, rootId);
        const inbox = await tx.doc(InboxDoc, rootId);
        const quiet = !live?.run && (!live?.runFailure || (__FAMILIAR_MUTATIONS__ && mutant('remark-no-failure-check'))) && ((inbox?.items ?? []).length === 0 || (__FAMILIAR_MUTATIONS__ && mutant('remark-no-inbox-check')));
        const data = { text, sources, request: key };
        const note = `[${options.persona.name} said this on her own, not in reply to a message: "${text}"]`;
        await root.submit(tx, {
          type: 'write',
          entry: quiet ? { kind: RemarkEntry, data, model: [{ role: 'user', content: [{ type: 'text', text: note }], timestamp: clock.now() }] } : { kind: RemarkEntry, data }
        });
        return quiet;
      }, ctx);
      return { text, visible, sources };
    },
    setup() {
      const installed: any[] = [...registry.snapshot().installed()];
      const hooks = installed.flatMap((e) => (e.hooks ?? []).map((h: any) => ({ task: String(h.task), hooks: Object.keys(h.handlers ?? {}) })));
      return { extensions: installed.map((e) => e.name), hooks, settings };
    },
    async parkUntil(text, at) {
      await root.commit((tx: any) => tx.createTask(WakeAt, { text, at }, { ownership: { kind: 'conversation' }, background: true }), ctx);
      harness.resume();
    },
    notice,
    wake() {
      if (!dead) harness.resume();
    },
    ledger: () => usage.read(),
    inspect: () => harness.inspect(ctx),
    read: (token) => harness.snapshot(token, ctx),
    async transcript() {
      const page = await root.entries({ order: 'ascending' }, 500, undefined, ctx);
      return page.items.map((e: any) => ({ kind: e.kind, ...entryText(e) }));
    },
    async close() {
      dead = true;
      presence.stop();
      cancelWake?.();
      try {
        await Promise.allSettled([liveWatch.stop(), consentWatch.stop(), recordsWatch.stop(), answersWatch.stop()]);
        await harness.close(ctx);
      } finally {
        owner.release();
      }
    },
    kill() {
      dead = true;
      presence.stop();
      cancelWake?.();
      options.store.sever();
      owner.release();
    }
  };
}
