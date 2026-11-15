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
  ask(card: ConsentCard): Promise<boolean>;
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

/** A reminder-style task: parks until `at`, then delivers. Step 8 gives it the real reminder. */
export interface WakeTask {
  /** Runs when the wait is over. */
  deliver(input: { text: string; at: number }, firedAt: number): void | Promise<void>;
}

const QuestionsDoc = defineJournalDoc<{ open: Record<string, Question>; dismissed: Record<string, true>; opened?: number }>('familiar.questions', () => ({ open: {}, dismissed: {} }));
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

// pi-durable finds a task's code by its name in the registry, not by a closure per open, so the parked
// wake reads the hooks of the journal this page opened. Familiar opens one journal per page.
let reminderHooks: WakeTask | undefined;
/** A parked wake: sleeps durably until `at`, then delivers. */
const WakeAt = defineTask<{ text: string; at: number }, { phase: 'wait' } | { phase: 'deliver' }, null>({
  name: 'familiar.wake-at',
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    wait: (task: any, runtime: any, context: any) => runtime.sleepUntil(task.input.at, { phase: 'deliver' }, context),
    deliver: async (task: any, runtime: any, context: any) => {
      await reminderHooks?.deliver(task.input, runtime.now());
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
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

export async function openJournal(options: JournalOptions & { wakeTask?: WakeTask }): Promise<Journal> {
  const clock = options.clock ?? systemClock;
  const owner = await options.owner.acquire(options.store.name);
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const gen = options.newGen?.() ?? Math.random().toString(36).slice(2, 10);
  const presence = presenceReporter(options.presence, options.persona.id, gen);
  reminderHooks = options.wakeTask;
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
  const turnOf = async (): Promise<string> => {
    const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
    return String(live?.run?.inputs?.[0] ?? live?.run?.taskId ?? 'turn');
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

  /** The bounds on tool calls (bounds.ts), counted in the journal before anything else about the call. */
  const bounded = async (api: any): Promise<string | undefined> => {
    const id = String(api.taskId);
    const live: any = await harness.snapshot(LiveDoc, rootId, ctx);
    const slots: any[] = live?.tools ?? [];
    const found = slots.findIndex((s) => String(s.taskId) === id);
    const index = found < 0 ? slots.length : found;
    const inputs: string[] = (live?.run?.inputs ?? []).map(String);
    const verdict = await harness.commit(async (tx: any) => {
      const doc = await tx.doc(BudgetDoc);
      // The turn: the newest of the run's inputs that belongs to one. A run with none (a continue)
      // goes on counting the turn it continues.
      const key = [...inputs].reverse().map((i) => doc.turns[i]).find((k) => k !== undefined) ?? doc.budget.turn;
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
  const submitInTurn = async (draft: any, carry: boolean) => {
    const id = await harness.commit(async (tx: any) => {
      const sid = String(await root.submit(tx, draft));
      const doc = await tx.doc(BudgetDoc);
      const key = carry ? doc.current || sid : sid;
      if (!carry) doc.current = sid;
      if (doc.turns[sid] === undefined) {
        doc.turns[sid] = key;
        doc.order.push(sid);
        while (doc.order.length > 64) delete doc.turns[doc.order.shift()!];
      }
      return sid;
    }, ctx);
    return harness.submission(Number(id), ctx);
  };

  const consentHook = hook(ToolTask, {
    beforeTool: async (call: any, api: any) => {
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
      const ok = await options.consent.ask(card);
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
    if (w.at !== undefined) cancelWake = clock.setTimer(() => !dead && harness?.resume(), Math.max(0, w.at - clock.now()), { background: false });
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

  const questions = async (): Promise<readonly Question[]> => {
    const doc: any = (await harness.snapshot(QuestionsDoc, ctx)) ?? { open: {}, dismissed: {} };
    const fromRun = failureQuestion(await harness.snapshot(LiveDoc, rootId, ctx), doc.dismissed);
    return [...Object.values(doc.open as Record<string, Question>), ...(fromRun ? [fromRun] : [])];
  };

  return {
    gen,
    async send(text, requestId) {
      const at = clock.now();
      remember({ name: 'message-sent', at });
      if (!needsReply(text, await lastPersonaText(), { personaName: options.persona.name })) {
        // Kept in the transcript for you, never sent to the model: nothing is answered.
        await root.submit({ type: 'write', entry: { kind: AckEntry, data: { text } }, requestId }, ctx);
        return { replied: false, decision: await notice({ name: 'ack-sent', at }) };
      }
      lastChatAt = at;
      const submission = await submitInTurn({ type: 'input', content: text, requestId }, false);
      return { replied: true, turn: turnFor(submission) };
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
      const question = (await questions()).find((q) => q.id === id);
      if (!question) return undefined;
      await harness.commit(async (tx: any) => {
        const doc = await tx.doc(QuestionsDoc);
        delete doc.open[id];
        doc.dismissed[id] = true;
      }, ctx);
      if (!yes) return undefined;
      // A yes carries on the same turn: its tool-call budget goes on counting.
      if (question.kind === 'steps' || question.kind === 'cap') return turnFor(await submitInTurn({ type: 'continue', requestId }, true));
      const words = question.kind === 'redo' ? `Yes, do it now: ${tools.get(question.tool!)?.doing(question.arguments) ?? question.tool}.` : `Run ${question.tool} again.`;
      return turnFor(await submitInTurn({ type: 'input', content: words, requestId }, true));
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
    read: (token) => harness.snapshot(token, ctx),
    async transcript() {
      const page = await root.entries({ order: 'ascending' }, 500, undefined, ctx);
      return page.items.map((e: any) => ({ kind: e.kind, ...entryText(e) }));
    },
    async close() {
      dead = true;
      presence.stop();
      cancelWake?.();
      await Promise.allSettled([liveWatch.stop(), consentWatch.stop(), questionsWatch.stop()]);
      await harness.close(ctx);
      owner.release();
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
