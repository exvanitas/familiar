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

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, GenerationTask, Harness, LiveDoc, ToolTask, createRegistry, defineExtension, defineTask, hook } from '@earendil-works/pi-durable';
import { needsReply } from '../decide/ack.ts';
import type { Decision, DecisionContext, DecisionPort, PastReaction, PersonaEvent } from '../decide/port.ts';
import type { CallInfo, CapsConfig, CapsOptions, Clock, Ledger } from '../model/caps.ts';
import { cappedPort, createCaps, emptyLedger, extendTurn } from '../model/caps.ts';
import type { ModelPort } from '../model/port.ts';
import type { RetryOptions } from '../model/retry.ts';
import { withRetries } from '../model/retry.ts';
import { journalUsageStore, LedgerDoc } from './ledger.ts';
import type { OwnerLock } from './owner.ts';
import type { PresencePort } from './presence.ts';
import { presenceReporter, stateOf } from './presence.ts';
import { decodeModelError, portProvider } from './provider.ts';
import type { JournalStore } from './store.ts';
import { admit, boundWords, type Budget } from './bounds.ts';
import { finishTurn, openTurn, turnKeyOf, TurnsDoc } from './turns.ts';
import { gateFor, type GatePolicy } from './gate.ts';
import type { FamiliarTool, JournalDocToken } from './tools.ts';
import { defineJournalDoc, toDurableTool, type AllowedBy } from './tools.ts';

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
}

export interface ConsentPort {
  /** Shows the card and resolves with the person's answer. After a restart the same card is asked again. */
  ask(card: ConsentCard, signal?: AbortSignal): Promise<boolean>;
}

/** Something the turn loop asks the person, in chat. */
export interface Question {
  readonly id: string;
  /**
   * `redo`: a built-in effect was cut off by a close and not run again ("Do it now?").
   * `rerun`: a server tool was cut off and may have partially run (Run again).
   * `steps`: the turn took its 8 tool steps and asks before going on.
   * `cap`: a cap paused the turn; going on needs a cap with room, or tomorrow.
   */
  readonly kind: 'redo' | 'rerun' | 'steps' | 'cap';
  readonly text: string;
  readonly tool?: string;
  readonly arguments?: unknown;
  readonly pause?: string;
  /** For `redo` and `rerun`: the turn the cut-off call belonged to. */
  readonly turn?: string;
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

const QuestionsDoc = defineJournalDoc<{ open: Record<string, Question>; dismissed: Record<string, true>; answered: Record<string, { yes: boolean; submission?: string; tool?: string; turn?: string }>; opened?: number }>(
  'familiar.questions',
  () => ({ open: {}, dismissed: {}, answered: {} })
);
type SentRecord = { kind: 'turn'; submission: string } | { kind: 'ack'; decision: Decision };
/** What each request id of a person's message did, so a resend gets the same result. */
const SentDoc = defineJournalDoc<{ byRequest: Record<string, SentRecord>; order: string[] }>('familiar.sent', () => ({ byRequest: {}, order: [] }));
const ConsentDoc = defineJournalDoc<{ cards: Record<string, ConsentCard & { answer?: 'allow' | 'deny' }>; opened?: number }>('familiar.consent', () => ({ cards: {} }));
const AckEntry = 'familiar.ack';
const NoticeEntry = 'familiar.notice';

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
  /** What the loop is asking you, in chat. */
  questions(): Promise<readonly Question[]>;
  /** Answers a question. Yes to `steps` or `cap` goes on with the turn; yes to `redo` or `rerun` asks her to do it again. */
  answer(id: string, yes: boolean, requestId: string): Promise<Turn | undefined>;
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

export async function openJournal(options: JournalOptions): Promise<Journal> {
  const clock = options.clock ?? systemClock;
  const owner = await options.owner.acquire(options.store.name);
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const gen = options.newGen?.() ?? Math.random().toString(36).slice(2, 10);
  const presence = presenceReporter(options.presence, options.persona.id, gen);
  const WakeAt = wakeAtTask(options.notifier);
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
  const port = async (): Promise<ModelPort> => {
    const turn = await turnOf();
    const capped = cappedPort(options.model, caps!, () => ({ ...options.caps.call, turn, conversation: String(rootId) }));
    return withRetries(capped, { ...options.retries, sleep });
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
        if (registry.of[sid] === undefined) registry.of[sid] = key;
        openTurn(registry, key, clock.now());
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

  /** Why a call of `name` waits for the person, if it does: an open interruption, or one skipped this turn. */
  const parkedFor = async (name: string, step: string): Promise<string | undefined> => {
    const doc: any = await harness.snapshot(QuestionsDoc, ctx);
    const open = Object.values(doc?.open ?? {}).find((q: any) => (q.kind === 'rerun' || q.kind === 'redo') && q.tool === name && q.id !== step);
    if (open) return `${name} was cut off when the app closed. It waits for the person to choose Run again or skip.`;
    const turn = turnKeyOf(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(TurnsDoc, ctx));
    const skipped = Object.entries(doc?.answered ?? {}).some(([qid, a]: [string, any]) => !a.yes && a.tool === name && a.turn === turn && qid !== step);
    if (skipped) return `The person chose to skip ${name} in this turn.`;
    return undefined;
  };
  // A round that left an interruption question ends its run: the model gets no chance to call the tool
  // again on its own, and the turn waits for the person's answer. Read from the journal, so it holds
  // after a restart. Only that run's task is stopped: messages you sent meanwhile stay queued, and go
  // on with the person's answer.
  const parkHook = hook(GenerationTask, {
    afterTools: async (_assistant: unknown, _results: unknown, api: any) => {
      const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
      const steps = new Set((live?.tools ?? []).map((t: any) => String(t.taskId)));
      const open: any = (await harness.snapshot(QuestionsDoc, ctx))?.open ?? {};
      if (!Object.values(open).some((q: any) => (q.kind === 'rerun' || q.kind === 'redo') && steps.has(q.id))) return;
      void harness.abortTask(api.taskId, ctx).catch((e: unknown) => report('park', e));
    }
  } as any);

  /**
   * The consent gate (gate.ts): the bounds, a parked interruption, then the policy, and consent when it
   * asks. A reason not to run, or how the call was allowed: by a standing "always", or by the person's yes
   * to this call. `beforeTool` runs it on every call, and each tool's own execute runs it again, for a call
   * recovered after a crash, which never passes `beforeTool`; the execute hands the tool how it was allowed.
   */
  const gateCall = async (call: { name: string; arguments: unknown }, api: any, context: any): Promise<{ refused: string } | { allowedBy: AllowedBy }> => {
    const v = await gateWords(call, api, context);
    return typeof v === 'string' ? { refused: v } : { allowedBy: v.allowedBy };
  };
  const gateWords = async (call: { name: string; arguments: unknown }, api: any, context: any): Promise<string | { allowedBy: AllowedBy }> => {
    const refused = await bounded(api);
    if (refused) return refused;
    const tool = tools.get(call.name);
    const id = String(api.taskId);
    // A tool cut off by a close waits for the person: Run again, or skip. Until then, and for the
    // rest of the turn after a skip, a call the model makes to it again doesn't run.
    const parked = await parkedFor(call.name, id);
    if (parked) return parked;
    const policy = gateFor(call.name, tool, options.policy?.());
    if (policy === 'deny') return `${call.name} is turned off.`;
    if (policy === 'allow') return { allowedBy: 'always' };
    const stored = (await harness.snapshot(ConsentDoc, ctx))?.cards?.[id];
    if (stored?.answer) return stored.answer === 'allow' ? { allowedBy: 'asked' } : 'The person said no.';
    const turn = turnKeyOf(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(TurnsDoc, ctx));
    const card: ConsentCard = stored ?? { id, tool: call.name, arguments: call.arguments, doing: tool ? tool.doing(call.arguments) : `using ${call.name}`, askedAt: clock.now(), turn };
    if (!stored) {
      await harness.commit(async (tx: any) => {
        (await tx.doc(ConsentDoc)).cards[id] = card;
      }, ctx);
    }
      // The wait observes the call's abort signal, so a close never hangs on an unanswered card. The card
      // stays in the journal, unanswered, and is asked again on the next open.
      const signal: AbortSignal | undefined = context?.abortSignal;
      const ok = await new Promise<boolean | 'closed'>((resolve) => {
        if (signal?.aborted) return resolve('closed');
        signal?.addEventListener('abort', () => resolve('closed'), { once: true });
        options.consent.ask(card, signal).then(resolve, () => resolve(false));
      });
    if (ok === 'closed') throw new Error('The journal closed while the card was open.');
    await harness.commit(async (tx: any) => {
      const doc = await tx.doc(ConsentDoc);
      if (doc.cards[id]) doc.cards[id].answer = ok ? 'allow' : 'deny';
    }, ctx);
    return ok ? { allowedBy: 'asked' } : 'The person said no.';
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
      const turn = interrupted ? turnKeyOf(await harness.snapshot(LiveDoc, rootId, ctx), await harness.snapshot(TurnsDoc, ctx)) : '';
      await harness.commit(async (tx: any) => {
        const consent = await tx.doc(ConsentDoc);
        if (consent.cards[id]) delete consent.cards[id];
        if (!interrupted || !tool) return;
        const questions = await tx.doc(QuestionsDoc);
        if (questions.dismissed[id] || questions.open[id]) return;
        questions.open[id] =
          tool.kind === 'server'
            ? { id, kind: 'rerun', tool: call.name, arguments: call.arguments, turn, text: `${call.name} was cut off when the app closed, and may have partially run.` }
            : { id, kind: 'redo', tool: call.name, arguments: call.arguments, turn, text: `I was ${tool.doing(call.arguments)} when the app closed. Do it now?` };
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

  try {
    harness = await Harness.open(
      options.store.storage,
      {
        models,
        registry,
        identity: { attribution: null },
        settings: { retry: { maxRetries: 2, baseDelayMs: options.resendDelayMs ?? 2000 }, toolExecution: 'sequential' },
        now: () => clock.now(),
        setTimer: (cb: () => void, ms: number, o: { background: boolean }) => clock.setTimer(cb, ms, o),
        onWake,
        onReport: (r: any) => report(r.kind, r.error)
      } as any,
      ctx
    );
  } catch (error) {
    owner.release();
    throw error;
  }
  const root: any = await harness.root(ctx, {
    agent: { model: { provider: PROVIDER, modelId: options.modelId }, instructions: options.persona.instructions, maxTurns: options.stepCap ?? 8 }
  });
  rootId = root.id;
  const usage = journalUsageStore(harness);
  caps = createCaps(options.caps.config, usage, clock, options.caps.options);

  /* ---------- questions from how the last run ended ---------- */

  const failureQuestion = (live: any, dismissed: Record<string, true>): Question | undefined => {
    const f = live?.runFailure;
    if (!f || live?.run) return undefined;
    const id = `run:${f.taskId}`;
    if (dismissed[id]) return undefined;
    if (f.reason === 'turn_limit') return { id, kind: 'steps', text: `I've taken ${options.stepCap ?? 8} steps on this. Shall I keep going?` };
    const error = decodeModelError(f.detail);
    if (f.reason === 'model_error' && error?.kind === 'paused') return { id, kind: 'cap', text: error.message, pause: error.pause };
    return undefined;
  };
  const failedRun = (live: any): boolean => !!live?.runFailure && !failureQuestion(live, {}) && !['aborted', 'reset', 'nothing_to_answer'].includes(live.runFailure.reason);

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

  let consentOpen = false;
  let lastLive: any;
  let dismissedNow: Record<string, true> = {};
  let questionOpen = false;
  const refresh = () => presence.update(stateOf({ live: lastLive, waiting: consentOpen || questionOpen || !!failureQuestion(lastLive, dismissedNow), failed: failedRun(lastLive) }));
  // Watches need their documents to exist.
  await harness.commit(async (tx: any) => {
    (await tx.doc(ConsentDoc)).opened = clock.now();
    (await tx.doc(QuestionsDoc)).opened = clock.now();
  }, ctx);
  const liveWatch = await harness.watchDoc(LiveDoc, rootId, ctx);
  const consentWatch = await harness.watchDoc(ConsentDoc, ctx);
  const questionsWatch = await harness.watchDoc(QuestionsDoc, ctx);
  const seenTools = new Set<string>();
  let lastRunInputs: string[] = [];
  /**
   * A run ended. A pause or the step cap leaves a question, recorded with its turn, and the turn stays
   * open. Otherwise, with nothing left to resume it (no open question, no open card), the turn is
   * finished. Only the run's own turn: a message queued meanwhile has its own, still open.
   */
  const endOfRun = async (inputs: string[], live: any) => {
    if (dead) return;
    await harness.commit(async (tx: any) => {
      const registry = await tx.doc(TurnsDoc);
      const qs = await tx.doc(QuestionsDoc);
      const cards = await tx.doc(ConsentDoc);
      const turn = turnKeyOf({ run: { inputs: inputs.length ? inputs : (live?.runFailure?.inputs ?? []).map(String) } }, registry);
      const q = failureQuestion(live, qs.dismissed);
      if (q && !qs.open[q.id] && !qs.answered?.[q.id]) qs.open[q.id] = { ...q, turn };
      const waiting = Object.values(qs.open).some((x: any) => x.turn === turn) || Object.values(cards.cards).some((c: any) => c.turn === turn && !c.answer);
      if (!waiting) finishTurn(registry, turn, clock.now());
    }, ctx);
  };
  const onLive = (live: any) => {
    const wasRunning = !!lastLive?.run;
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
    if (wasRunning && !live?.run) void endOfRun(lastRunInputs, live).catch((e) => report('turns', e));
    if (live?.run) lastRunInputs = (live.run.inputs ?? []).map(String);
    if (wasRunning && !live?.run) {
      lastChatAt = clock.now();
      if (!live?.runFailure && !options.ambient().chatInFront) void notice({ name: 'reply-done-hidden', at: clock.now() }).catch((e) => report('decide', e));
    }
  };
  const openCards = (doc: any) => Object.values(doc?.cards ?? {}).some((c: any) => !c.answer);
  onLive(liveWatch.value);
  consentOpen = openCards(consentWatch.value);
  dismissedNow = questionsWatch.value?.dismissed ?? {};
  questionOpen = Object.keys(questionsWatch.value?.open ?? {}).length > 0;
  refresh();
  if (!liveWatch.value?.run && failureQuestion(liveWatch.value, dismissedNow)) await endOfRun([], liveWatch.value);
  liveWatch.start(async (call: any) => call.kind === 'value' && onLive(call.value));
  consentWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    consentOpen = openCards(call.value);
    refresh();
  });
  questionsWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    dismissedNow = call.value?.dismissed ?? {};
    questionOpen = Object.keys(call.value?.open ?? {}).length > 0;
    refresh();
  });

  /* ---------- turns ---------- */

  const entryText = (entry: any): { role?: string; text: string; error?: string } => {
    const m = entry?.model?.[0];
    if (!m) return { text: typeof entry?.data?.text === 'string' ? entry.data.text : '' };
    const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((b: any) => (b.type === 'text' ? b.text : b.type === 'toolCall' ? `[${b.name} ${JSON.stringify(b.arguments)}]` : '')).join('');
    const error = m.errorMessage ? (decodeModelError(m.errorMessage)?.message ?? m.errorMessage) : undefined;
    return { role: m.role, text, ...(m.stopReason && m.stopReason !== 'stop' && m.stopReason !== 'toolUse' ? { error: error ?? m.stopReason } : {}) };
  };
  const lastPersonaText = async (): Promise<string | undefined> => {
    const page = await root.entries({ order: 'descending' }, 50, undefined, ctx);
    for (const e of page.items) {
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
      const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
      const question = failureQuestion(live, {});
      if (question) return { status: 'asks', question };
      // A run ended to wait on a cut-off tool: the turn asks the person.
      const interruption = (await questions()).find((q) => q.kind === 'redo' || q.kind === 'rerun');
      if (interruption) return { status: 'asks', question: interruption };
      const error = decodeModelError(live?.runFailure?.detail);
      return { status: 'failed', reason: String(settled.reason ?? live?.runFailure?.reason ?? 'unknown'), message: error?.message ?? String(live?.runFailure?.detail ?? '') };
    }
  });

  harness.resume();

  const resultOf = async (record: SentRecord): Promise<SendResult> => {
    if (record.kind === 'ack') return { replied: false, decision: record.decision };
    return { replied: true, turn: turnFor(await harness.submission(Number(record.submission), ctx)) };
  };

  const questions = async (): Promise<readonly Question[]> => {
    const doc: any = (await harness.snapshot(QuestionsDoc, ctx)) ?? { open: {}, dismissed: {} };
    const fromRun = failureQuestion(await harness.snapshot(LiveDoc, rootId, ctx), doc.dismissed);
    const open = Object.values(doc.open as Record<string, Question>);
    return [...open, ...(fromRun && !open.some((q) => q.id === fromRun.id) && !doc.answered?.[fromRun.id] ? [fromRun] : [])];
  };

  return {
    gen,
    async send(text, requestId) {
      // A resend finds what the first send did, before the text is looked at again: by then her last
      // message may have changed, and the same text would be read another way.
      const prior = await remembered(requestId);
      if (prior) return resultOf(prior);
      const at = clock.now();
      remember({ name: 'message-sent', at });
      if (!needsReply(text, await lastPersonaText(), { personaName: options.persona.name })) {
        const decision = await notice({ name: 'ack-sent', at });
        // Kept in the transcript for you, never sent to the model: nothing is answered.
        await submitInTurn({ type: 'write', entry: { kind: AckEntry, data: { text } }, requestId }, true, (tx) => rememberIn(tx, requestId, { kind: 'ack', decision }), undefined, { track: false });
        return resultOf((await remembered(requestId))!);
      }
      lastChatAt = at;
      await submitInTurn({ type: 'input', content: text, requestId }, false, (tx, sid) => rememberIn(tx, requestId, { kind: 'turn', submission: sid }));
      return resultOf((await remembered(requestId))!);
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
      // Answered already, by this request or another: the same result again. Checked again inside the
      // commit below, so two answers at once can't both act.
      const given = (doc: any) => doc?.answered?.[id] as { submission?: string } | undefined;
      const before = given(await harness.snapshot(QuestionsDoc, ctx));
      if (before) return before.submission ? turnFor(await harness.submission(Number(before.submission), ctx)) : undefined;
      const question = (await questions()).find((q) => q.id === id);
      if (!question) return undefined;
      const words = question.kind === 'redo' ? `Yes, do it now: ${tools.get(question.tool!)?.doing(question.arguments) ?? question.tool}.` : `Run ${question.tool} again.`;
      // Skipping a cut-off tool lets the turn go on without it; the gate keeps that tool from running
      // again in this turn. No to going on finishes the turn.
      const skipInterrupted = !yes && (question.kind === 'redo' || question.kind === 'rerun');
      const draft = skipInterrupted ? { type: 'continue', requestId } : !yes ? undefined : question.kind === 'steps' || question.kind === 'cap' ? { type: 'continue', requestId } : { type: 'input', content: words, requestId };
      // The turn the question is about, from the question itself, or the paused run's inputs.
      const asked = question.turn || turnKeyOf({ run: { inputs: ((await harness.snapshot(LiveDoc, rootId, ctx)) as any)?.runFailure?.inputs ?? [] } }, await harness.snapshot(TurnsDoc, ctx));
      // The answer and what it starts are one commit, so a kill can't keep one without the other. A Yes at
      // a turn-tokens pause gives the turn one more allowance, in the same commit, granted by this Yes once;
      // a Yes never lifts a daily or dollar cap.
      const submission = await submitInTurn(
        draft,
        true,
        async (tx, sid) => {
          if (yes && question.kind === 'cap' && question.pause === 'turn-tokens') {
            const ledgerDoc = await tx.doc(LedgerDoc);
            const ledger = { ...emptyLedger(), extensions: { ...(ledgerDoc.extensions ?? {}) }, granted: { ...(ledgerDoc.granted ?? {}) } };
            if (extendTurn(ledger, asked, id)) {
              ledgerDoc.extensions = ledger.extensions;
              ledgerDoc.granted = ledger.granted;
            }
          }
          const doc = await tx.doc(QuestionsDoc);
          delete doc.open[id];
          doc.dismissed[id] = true;
          doc.answered[id] = { yes, ...(sid ? { submission: sid } : {}), ...(question.tool ? { tool: question.tool } : {}), turn: asked };
          if (!draft) finishTurn(await tx.doc(TurnsDoc), asked, clock.now());
        },
        asked,
        { already: async (tx) => given(await tx.doc(QuestionsDoc))?.submission ?? (given(await tx.doc(QuestionsDoc)) ? '' : undefined) }
      );
      return submission ? turnFor(submission) : undefined;
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
        await Promise.allSettled([liveWatch.stop(), consentWatch.stop(), questionsWatch.stop()]);
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
