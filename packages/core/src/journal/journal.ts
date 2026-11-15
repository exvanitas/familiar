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
import { AssistantEntry, Harness, LiveDoc, ToolTask, createRegistry, defineExtension, defineTask, hook } from '@earendil-works/pi-durable';
import { needsReply } from '../decide/ack.ts';
import type { Decision, DecisionContext, DecisionPort, PastReaction, PersonaEvent } from '../decide/port.ts';
import type { CallInfo, CapsConfig, CapsOptions, Clock, Ledger } from '../model/caps.ts';
import { cappedPort, createCaps } from '../model/caps.ts';
import type { ModelPort } from '../model/port.ts';
import type { RetryOptions } from '../model/retry.ts';
import { withRetries } from '../model/retry.ts';
import { journalUsageStore } from './ledger.ts';
import type { OwnerLock } from './owner.ts';
import type { PresencePort } from './presence.ts';
import { presenceReporter, stateOf } from './presence.ts';
import { decodeModelError, portProvider } from './provider.ts';
import type { JournalStore } from './store.ts';
import { admit, boundWords, emptyBudget, type Budget } from './bounds.ts';
import type { FamiliarTool, JournalDocToken } from './tools.ts';
import { defineJournalDoc, toDurableTool } from './tools.ts';

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

const QuestionsDoc = defineJournalDoc<{ open: Record<string, Question>; dismissed: Record<string, true>; answered: Record<string, { yes: boolean; submission?: string }>; opened?: number }>(
  'familiar.questions',
  () => ({ open: {}, dismissed: {}, answered: {} })
);
type SentRecord = { kind: 'turn'; submission: string } | { kind: 'ack'; decision: Decision };
/** What each request id of a person's message did, so a resend gets the same result. */
const SentDoc = defineJournalDoc<{ byRequest: Record<string, SentRecord>; order: string[] }>('familiar.sent', () => ({ byRequest: {}, order: [] }));
const ConsentDoc = defineJournalDoc<{ cards: Record<string, ConsentCard & { answer?: 'allow' | 'deny' }>; opened?: number }>('familiar.consent', () => ({ cards: {} }));
const AckEntry = 'familiar.ack';
const NoticeEntry = 'familiar.notice';
/** The tool-call budget of the current turn, and which turn each submission belongs to. */
const BudgetDoc = defineJournalDoc<{ budget: Budget; turns: Record<string, string>; order: string[]; current: string }>('familiar.tool-budget', () => ({
  budget: emptyBudget(),
  turns: {},
  order: [],
  current: ''
}));

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
  // "go on". The turns that can still go on keep their spend whole, however long they wait.
  const unfinished = new Set<string>();
  const turnOf = async (): Promise<string> => {
    const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
    const budget: any = await harness.snapshot(BudgetDoc, ctx);
    const key = turnKeyOf(live, budget);
    unfinished.clear();
    unfinished.add(key);
    if (budget?.current) unfinished.add(budget.current);
    return key;
  };
  const port = async (): Promise<ModelPort> => {
    const turn = await turnOf();
    const capped = cappedPort(options.model, caps!, () => ({ ...options.caps.call, turn, conversation: String(rootId) }));
    return withRetries(capped, { ...options.retries, sleep });
  };
  const { provider } = portProvider(port, { id: PROVIDER, modelId: options.modelId });
  const models = createModels();
  models.setProvider(provider);

  /* ---------- consent, and the questions a restart leaves ---------- */

  /**
   * The turn a run belongs to: the newest of its inputs that belongs to one. A run with none (a continue)
   * goes on with the turn it continues.
   */
  const turnKeyOf = (live: any, budget: any): string => {
    const inputs: string[] = (live?.run?.inputs ?? []).map(String);
    return [...inputs].reverse().map((i) => budget?.turns?.[i]).find((k) => k !== undefined) ?? budget?.budget?.turn ?? budget?.current ?? 'turn';
  };

  /** The bounds on tool calls (bounds.ts), counted in the journal before anything else about the call. */
  const bounded = async (api: any): Promise<string | undefined> => {
    const id = String(api.taskId);
    const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
    const slots: any[] = live?.tools ?? [];
    const found = slots.findIndex((s) => String(s.taskId) === id);
    const index = found < 0 ? slots.length : found;
    const verdict = await harness.commit(async (tx: any) => {
      const doc = await tx.doc(BudgetDoc);
      // The turn: the newest of the run's inputs that belongs to one. A run with none (a continue)
      // goes on counting the turn it continues.
      const key = turnKeyOf(live, doc);
      const budget: Budget = key === doc.budget.turn ? JSON.parse(JSON.stringify(doc.budget)) : emptyBudget(key);
      const out = admit(budget, id, index);
      doc.budget = budget;
      return { ...out, turn: budget.turn };
    }, ctx);
    if (verdict.ok) return undefined;
    const words = boundWords(verdict.bound);
    // One line in chat per reply, or per turn. The request id finds the same line after a restart.
    const reply = verdict.bound === 'reply' ? `:${String(slots[0]?.taskId ?? id)}` : '';
    await root.submit({ type: 'write', entry: { kind: NoticeEntry, data: { text: words } }, requestId: `bound:${verdict.turn}:${verdict.bound}${reply}` }, ctx);
    return `${words} This call was not run.`;
  };

  /** Submits for the person's own message (a new turn) or for an answer that carries on the current one. */
  /**
   * Submits for the person's own message (a new turn) or for an answer that carries on the current one,
   * in one commit with `also`, the person's own record of what they did. Retried with the same request
   * id, it finds the same submission.
   */
  const submitInTurn = async (draft: any, carry: boolean, also?: (tx: any, sid: string) => Promise<void>) => {
    const id = await harness.commit(async (tx: any) => {
      const sid = draft ? String(await root.submit(tx, draft)) : '';
      if (sid) {
        const doc = await tx.doc(BudgetDoc);
        const key = carry ? doc.current || sid : sid;
        if (!carry) doc.current = sid;
        if (doc.turns[sid] === undefined) {
          doc.turns[sid] = key;
          doc.order.push(sid);
          while (doc.order.length > 64) delete doc.turns[doc.order.shift()!];
        }
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

  const consentHook = hook(ToolTask, {
    beforeTool: async (call: any, api: any, context: any) => {
      const refused = await bounded(api);
      if (refused) return { block: refused };
      const tool = tools.get(call.name);
      if (!tool?.asks) return undefined;
      const id = String(api.taskId);
      const stored = (await harness.snapshot(ConsentDoc, ctx))?.cards?.[id];
      if (stored?.answer) return stored.answer === 'allow' ? undefined : { block: 'The person said no.' };
      const card: ConsentCard = stored ?? { id, tool: call.name, arguments: call.arguments, doing: tool.doing(call.arguments), askedAt: clock.now() };
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
      return ok ? undefined : { block: 'The person said no.' };
    },
    afterTool: async (call: any, result: any, api: any) => {
      const id = String(api.taskId);
      const tool = tools.get(call.name);
      const interrupted = (result.diagnostics ?? []).some((d: any) => d.code === 'interrupted');
      await harness.commit(async (tx: any) => {
        const consent = await tx.doc(ConsentDoc);
        if (consent.cards[id]) delete consent.cards[id];
        if (!interrupted || !tool) return;
        const questions = await tx.doc(QuestionsDoc);
        if (questions.dismissed[id] || questions.open[id]) return;
        questions.open[id] =
          tool.kind === 'server'
            ? { id, kind: 'rerun', tool: call.name, arguments: call.arguments, text: `${call.name} was cut off when the app closed, and may have partially run.` }
            : { id, kind: 'redo', tool: call.name, arguments: call.arguments, text: `I was ${tool.doing(call.arguments)} when the app closed. Do it now?` };
      }, ctx);
      if (interrupted && tool?.kind === 'effect') return { ...result, output: [{ type: 'text', text: STOPPED_WORDS }] };
      return undefined;
    }
  } as any);

  const familiar = defineExtension({ name: 'familiar', tools: options.tools.map(toDurableTool), hooks: [consentHook], tasks: [WakeAt] } as any);
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
  caps = createCaps(options.caps.config, usage, clock, { ...options.caps.options, unfinished: () => unfinished });

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
  const refresh = () => presence.update(stateOf({ live: lastLive, waiting: consentOpen || !!failureQuestion(lastLive, dismissedNow), failed: failedRun(lastLive) }));
  // Watches need their documents to exist.
  await harness.commit(async (tx: any) => {
    (await tx.doc(ConsentDoc)).opened = clock.now();
    (await tx.doc(QuestionsDoc)).opened = clock.now();
  }, ctx);
  const liveWatch = await harness.watchDoc(LiveDoc, rootId, ctx);
  const consentWatch = await harness.watchDoc(ConsentDoc, ctx);
  const questionsWatch = await harness.watchDoc(QuestionsDoc, ctx);
  const seenTools = new Set<string>();
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
    if (wasRunning && !live?.run) {
      lastChatAt = clock.now();
      if (!live?.runFailure && !options.ambient().chatInFront) void notice({ name: 'reply-done-hidden', at: clock.now() }).catch((e) => report('decide', e));
    }
  };
  const openCards = (doc: any) => Object.values(doc?.cards ?? {}).some((c: any) => !c.answer);
  onLive(liveWatch.value);
  consentOpen = openCards(consentWatch.value);
  dismissedNow = questionsWatch.value?.dismissed ?? {};
  refresh();
  liveWatch.start(async (call: any) => call.kind === 'value' && onLive(call.value));
  consentWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    consentOpen = openCards(call.value);
    refresh();
  });
  questionsWatch.start(async (call: any) => {
    if (call.kind !== 'value') return;
    dismissedNow = call.value?.dismissed ?? {};
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
    return [...Object.values(doc.open as Record<string, Question>), ...(fromRun ? [fromRun] : [])];
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
        await submitInTurn({ type: 'write', entry: { kind: AckEntry, data: { text } }, requestId }, true, (tx) => rememberIn(tx, requestId, { kind: 'ack', decision }));
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
      // Answered already, by this request or another: the same result again.
      const before = ((await harness.snapshot(QuestionsDoc, ctx)) as any)?.answered?.[id] as { submission?: string } | undefined;
      if (before) return before.submission ? turnFor(await harness.submission(Number(before.submission), ctx)) : undefined;
      const question = (await questions()).find((q) => q.id === id);
      if (!question) return undefined;
      // A yes carries on the same turn: its tool-call budget goes on counting.
      const words = question.kind === 'redo' ? `Yes, do it now: ${tools.get(question.tool!)?.doing(question.arguments) ?? question.tool}.` : `Run ${question.tool} again.`;
      const draft = !yes ? undefined : question.kind === 'steps' || question.kind === 'cap' ? { type: 'continue', requestId } : { type: 'input', content: words, requestId };
      // The answer and what it starts are one commit, so a kill can't keep one without the other.
      const submission = await submitInTurn(draft, true, async (tx, sid) => {
        const doc = await tx.doc(QuestionsDoc);
        delete doc.open[id];
        doc.dismissed[id] = true;
        (doc.answered ??= {})[id] = { yes, ...(sid ? { submission: sid } : {}) };
      });
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
