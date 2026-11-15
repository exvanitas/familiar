// Kill-mid-step scenarios, shared by the Node tests (fake IndexedDB, the engine torn down) and the page
// that headless Chromium runs (real IndexedDB, the page closed). Each scenario runs in two lives. Life 1
// starts a turn and calls `ready(kill)` once the step is under way; the driver then kills it. Life 2
// reopens the same store, resumes, and returns a summary the test checks. Counters persist across lives
// (in memory in Node, in localStorage in the page), and so does the clock's offset, so time can pass
// while the app is closed.
//
// No Node imports here: this file is bundled into the page.

import { createFakeModel, type FakeReply } from '../../src/testing/index.ts';
import { decideByRules, defineJournalDoc, openJournal, type Decision, type DecisionPort, type PersonaEvent, type FamiliarTool, type Journal, type JournalClock, type JournalStore, type OwnerLock, type PresenceSnapshot, type ModelRequest } from '../../src/index.ts';

export interface Counters {
  get(name: string): number;
  bump(name: string): number;
  set(name: string, value: number): void;
  /** Free-form notes that survive a life, such as an id seen in life 1. */
  note(name: string, value?: string): string | undefined;
}

export interface Env {
  readonly life: number;
  readonly counters: Counters;
  openStore(name: string): Promise<JournalStore>;
  readonly owner: OwnerLock;
  /** Life 1: the step is under way. The driver kills the engine (Node) or closes the page (Chromium). */
  ready(kill: () => void): void;
}

export type Summary = Record<string, unknown>;

export interface Scenario {
  readonly name: string;
  run(env: Env): Promise<Summary | undefined>;
}

const never = new Promise<never>(() => {});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The wall clock plus an offset kept in the counters, so a test can let an hour pass while the app is closed. */
export function offsetClock(counters: Counters): JournalClock & { advance(ms: number): void } {
  return {
    now: () => Date.now() + counters.get('clock-offset'),
    setTimer: (callback, delayMs) => {
      const t = setTimeout(callback, delayMs);
      return () => clearTimeout(t);
    },
    advance: (ms) => counters.set('clock-offset', counters.get('clock-offset') + ms)
  };
}

export const NotesDoc = defineJournalDoc<{ notes: Record<string, string> }>('familiar.test-notes', () => ({ notes: {} }));

/** The fake tools: one of each kind. Each counts its starts; a hang holds it in flight for the kill. */
export function fakeTools(env: Env, hang: (name: string) => boolean): FamiliarTool[] {
  const start = (name: string) => env.counters.bump(`starts:${name}`);
  const maybeHang = async (name: string) => {
    if (hang(name)) await never;
  };
  const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  return [
    {
      name: 'look',
      description: 'Looks something up. A pure read.',
      inputSchema: object({ what: { type: 'string' } }),
      kind: 'read',
      doing: (a: any) => `looking up ${a.what}`,
      async run(args: any) {
        start('look');
        await maybeHang('look');
        return `seen: ${args.what}`;
      }
    },
    {
      name: 'save_note',
      description: 'Saves a note. A built-in write.',
      inputSchema: object({ text: { type: 'string' } }),
      kind: 'write',
      doing: (a: any) => `saving a note "${a.text}"`,
      async run(args: any, step) {
        start('save_note');
        await step.write(async (tx) => {
          env.counters.bump('writes:save_note');
          (await tx.doc(NotesDoc)).notes[step.id] = args.text;
          return null;
        });
        await maybeHang('save_note');
        return `saved: ${args.text}`;
      }
    },
    {
      name: 'send_message',
      description: 'Sends a message to someone. A built-in tool with an outside effect.',
      inputSchema: object({ to: { type: 'string' }, text: { type: 'string' } }),
      kind: 'effect',
      asks: true,
      doing: (a: any) => `sending a message to ${a.to}`,
      async run(args: any) {
        start('send_message');
        await maybeHang('send_message');
        return `sent to ${args.to}`;
      }
    },
    {
      name: 'server_lookup',
      description: "An MCP server's tool.",
      inputSchema: object({ q: { type: 'string' } }),
      kind: 'server',
      doing: (a: any) => `asking the server about ${a.q}`,
      async run(args: any) {
        start('server_lookup');
        await maybeHang('server_lookup');
        return `server says: ${args.q}`;
      }
    }
  ];
}

const lastIsTool = (r: ModelRequest) => r.messages.at(-1)?.role === 'tool';
const lastText = (r: ModelRequest) => r.messages.at(-1)?.content ?? '';

export interface OpenOptions {
  readonly script: (request: ModelRequest, life: number) => FakeReply;
  readonly hang?: (name: string) => boolean;
  /** Consent: resolves with the answer, or hangs. Default yes. */
  readonly consent?: (life: number, id: string) => Promise<boolean>;
  readonly stepCap?: number;
  readonly caps?: { maxDayTokens?: number; maxTurnTokens?: number };
  readonly onDeliver?: (text: string, at: number, firedAt: number) => void;
  readonly chatInFront?: () => boolean;
  readonly decider?: DecisionPort;
  readonly onReaction?: (decision: Decision, event: PersonaEvent) => void;
  readonly newGen?: () => string;
}

/** Opens the scenario's journal over the shared store, with the fake model, tools and ports. */
export async function openFor(env: Env, store: JournalStore, o: OpenOptions) {
  const clock = offsetClock(env.counters);
  const presence: PresenceSnapshot[] = [];
  const wakes: (number | undefined)[] = [];
  const model = createFakeModel((request) => {
    env.counters.bump('model-requests');
    return o.script(request, env.life);
  });
  const journal: Journal = await openJournal({
    store,
    owner: env.owner,
    model,
    modelId: 'fake-1',
    caps: { config: { maxReplyTokens: 200, ...o.caps }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
    tools: fakeTools(env, o.hang ?? (() => false)),
    clock,
    wake: { wakeAt: (at) => wakes.push(at) },
    consent: {
      ask: (card) => {
        env.counters.bump('consent-asks');
        env.counters.note('consent-id', card.id);
        return o.consent ? o.consent(env.life, card.id) : Promise.resolve(true);
      }
    },
    presence: { report: (s) => presence.push(s) },
    persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
    decider: o.decider ?? { decide: async (event, context) => decideByRules(event, context) },
    ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: o.chatInFront?.() ?? true, teaserDue: false }),
    onReaction: o.onReaction,
    newGen: o.newGen,
    stepCap: o.stepCap,
    resendDelayMs: 50,
    wakeTask: {
      deliver: (input, firedAt) => {
        env.counters.bump('delivered');
        o.onDeliver?.(input.text, input.at, firedAt);
      }
    }
  });
  return { journal, model, presence, wakes, clock };
}

const callOnce = (name: string, args: unknown): FakeReply => ({ text: 'On it.', toolCalls: [{ id: 'call-1', name, arguments: args }] });
const answerTool = (r: ModelRequest): FakeReply => ({ text: `Done. (${lastText(r)})` });

/** A scenario where the first reply calls one tool, which hangs in life 1. */
function toolKill(name: string, scenario: string, tool: string, args: unknown, extra: (env: Env, j: Journal) => Promise<Summary> = async () => ({})): Scenario {
  return {
    name,
    async run(env) {
      const store = await env.openStore(scenario);
      const { journal, model, presence } = await openFor(env, store, {
        script: (r) => (lastIsTool(r) ? answerTool(r) : callOnce(tool, args)),
        hang: (n) => env.life === 1 && n === tool
      });
      if (env.life === 1) {
        void journal.send('Please do the thing.', 'turn-1');
        while (env.counters.get(`starts:${tool}`) < 1) await sleep(10);
        env.ready(() => journal.kill());
        return undefined;
      }
      const end = await journal.turn(await turnId(journal)).wait();
      const summary = {
        end,
        starts: env.counters.get(`starts:${tool}`),
        modelRequests: env.counters.get('model-requests'),
        requestsSent: model.requests.length,
        questions: await journal.questions(),
        transcript: await journal.transcript(),
        states: presence.map((p) => p.state),
        ...(await extra(env, journal))
      };
      await journal.close();
      return summary;
    }
  };
}

/** The first turn's id: a resend with the same request id finds the same submission. */
async function turnId(journal: Journal): Promise<string> {
  const sent = await journal.send('Please do the thing.', 'turn-1');
  if (!sent.replied) throw new Error('The resend was taken for an acknowledgement.');
  return sent.turn.id;
}

export const SCENARIOS: readonly Scenario[] = [
  // A model call that finished, then the app died during the tool it asked for. The call isn't sent
  // again: life 2 sends only the request after the tool.
  toolKill('model-finished', 'model-finished', 'look', { what: 'the weather' }),

  // A read, started: run again.
  toolKill('read-started', 'read-started', 'look', { what: 'the time' }),

  // A built-in write that wrote, then hung before its step was done: run again, written once.
  toolKill('write-started', 'write-started', 'save_note', { text: 'buy milk' }, async (env, j) => ({
    writes: env.counters.get('writes:save_note'),
    notes: Object.values((await j.read(NotesDoc))?.notes ?? {})
  })),

  // A built-in effect, started (consent given in life 1): not run again; a question instead.
  toolKill('effect-started', 'effect-started', 'send_message', { to: 'Sam', text: 'hi' }, async (env, j) => {
    const [question] = await j.questions();
    const consentAsks = env.counters.get('consent-asks');
    // Yes: she's asked to do it now, and the model calls it again, through consent again.
    const turn = question ? await j.answer(question.id, true, 'redo-1') : undefined;
    const redo = turn ? await turn.wait() : undefined;
    return { consentAsksBeforeRedo: consentAsks, redo, startsAfterRedo: env.counters.get('starts:send_message'), questionsAfter: await j.questions() };
  }),

  // A server tool, started: never repeated on its own. Reported as interrupted, with Run again.
  toolKill('server-started', 'server-started', 'server_lookup', { q: 'trains' }),

  // A tool that finished, then the app died during the next model call. The result is reused.
  {
    name: 'tool-finished',
    async run(env) {
      const store = await env.openStore('tool-finished');
      const { journal, model } = await openFor(env, store, {
        script: (r, life) => (lastIsTool(r) ? (life === 1 ? { text: 'Thinking it over...', chunkSize: 4, pause: { afterEvents: 2, until: never } } : answerTool(r)) : callOnce('send_message', { to: 'Ana', text: 'hello' }))
      });
      if (env.life === 1) {
        void journal.send('Please do the thing.', 'turn-1');
        while (env.counters.get('model-requests') < 2) await sleep(10);
        env.ready(() => journal.kill());
        return undefined;
      }
      const end = await journal.turn(await turnId(journal)).wait();
      const summary = { end, starts: env.counters.get('starts:send_message'), consentAsks: env.counters.get('consent-asks'), modelRequests: env.counters.get('model-requests'), requestsSent: model.requests.length, transcript: await journal.transcript() };
      await journal.close();
      return summary;
    }
  },

  // A model call killed mid-stream, with its cap reservation open. Sent again: the old reservation stays
  // spent, the new call takes its own, and past its deadline the old one is a spent record.
  {
    name: 'model-in-flight',
    async run(env) {
      const store = await env.openStore('model-in-flight');
      const { journal, model, clock } = await openFor(env, store, {
        script: (_r, life) => (life === 1 ? { text: 'Let me think about where to put that...', chunkSize: 4, pause: { afterEvents: 4, until: never } } : { text: 'Here is the whole answer.', usage: { inputTokens: 40, outputTokens: 6 } })
      });
      if (env.life === 1) {
        void journal.send('Where should this go?', 'turn-1');
        while (env.counters.get('model-requests') < 1) await sleep(10);
        // Partial answers reach the store within a second (pi-durable's persistWithinMs); twice that, for slow runners.
        await sleep(2000);
        const open = (await journal.ledger()).open;
        env.counters.note('reservation', open[0]?.id);
        env.counters.set('reserved-tokens', open[0]?.tokens ?? -1);
        env.ready(() => journal.kill());
        return undefined;
      }
      const sent = await journal.send('Where should this go?', 'turn-1');
      const end = sent.replied ? await sent.turn.wait() : undefined;
      const afterResend = await journal.ledger();
      // Thirty-one minutes later the old reservation is past its deadline: it becomes a spent record.
      clock.advance(31 * 60_000);
      const second = await journal.send('And one more question?', 'turn-2');
      if (second.replied) await second.turn.wait();
      const later = await journal.ledger();
      const summary = {
        end,
        modelRequests: env.counters.get('model-requests'),
        requestsSent: model.requests.length,
        oldReservation: env.counters.note('reservation'),
        reservedTokens: env.counters.get('reserved-tokens'),
        afterResend,
        later,
        transcript: await journal.transcript()
      };
      await journal.close();
      return summary;
    }
  },

  // A consent card still open when the app died: still there after a restart, asked again, and the tool
  // runs once, after the answer.
  {
    name: 'consent-parked',
    async run(env) {
      const store = await env.openStore('consent-parked');
      const { journal, presence } = await openFor(env, store, {
        script: (r) => (lastIsTool(r) ? answerTool(r) : callOnce('send_message', { to: 'Sam', text: 'see you' })),
        consent: (life) => (life === 1 ? never : Promise.resolve(true))
      });
      if (env.life === 1) {
        void journal.send('Tell Sam I will be late.', 'turn-1');
        while ((await journal.consents()).length < 1) await sleep(10);
        env.ready(() => journal.kill());
        return undefined;
      }
      // Before anything is asked again, the open card is in the store for the chat to show.
      const cards = await journal.consents();
      const end = await journal.turn(await turnId(journal)).wait();
      const summary = {
        cardsAtOpen: cards,
        lifeOneCard: env.counters.note('consent-id'),
        end,
        starts: env.counters.get('starts:send_message'),
        consentAsks: env.counters.get('consent-asks'),
        cardsAfter: await journal.consents(),
        states: presence.map((p) => p.state)
      };
      await journal.close();
      return summary;
    }
  },

  // A parked wake: due while the app is closed, it fires once on the next open.
  {
    name: 'wake-parked',
    async run(env) {
      const store = await env.openStore('wake-parked');
      const fired: number[] = [];
      const { journal, wakes, clock } = await openFor(env, store, { script: () => ({ text: 'unused' }), onDeliver: (_t, at, firedAt) => fired.push(firedAt - at) });
      if (env.life === 1) {
        const at = clock.now() + 60 * 60_000;
        env.counters.set('wake-at', at);
        await journal.parkUntil('stretch', at);
        while (!wakes.includes(at)) await sleep(10);
        env.counters.set('life-one-wakes', wakes.filter((w) => w === at).length);
        env.ready(() => journal.kill());
        return undefined;
      }
      // Life 2 opens before it's due: the wake is still asked for, and nothing fires.
      await sleep(200);
      const firedEarly = env.counters.get('delivered');
      const askedAgain = wakes.includes(env.counters.get('wake-at'));
      // An hour passes; the wake port fires.
      clock.advance(60 * 60_000 + 1000);
      journal.wake();
      while (env.counters.get('delivered') < 1) await sleep(10);
      await sleep(100);
      const summary = { lifeOneWakes: env.counters.get('life-one-wakes'), firedEarly, askedAgain, delivered: env.counters.get('delivered'), lateMs: fired[0], wakesAfter: wakes.at(-1) };
      await journal.close();
      return summary;
    }
  }
];

export function scenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
}
