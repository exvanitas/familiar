// Kill-mid-step scenarios, shared by the Node tests (fake IndexedDB, the engine torn down) and the page
// that headless Chromium runs (real IndexedDB, the page closed). Each scenario runs in two lives. Life 1
// starts a turn and calls `ready(kill)` once the step is under way; the driver then kills it. Life 2
// reopens the same store, resumes, and returns a summary the test checks. Counters persist across lives
// (in memory in Node, in localStorage in the page), and so does the clock's offset, so time can pass
// while the app is closed.
//
// No Node imports here: this file is bundled into the page.

import { createFakeModel, type FakeReply } from '../../src/testing/index.ts';
import { decideByRules, defineJournalDoc, McpClient, openJournal, posixPaths, type GatePolicy, type Decision, type DecisionPort, type PersonaEvent, type FamiliarTool, type Journal, type JournalClock, type JournalStore, type OwnerLock, type PresenceSnapshot, type ModelRequest, type ProcessEvent, type ProcessPort, type SettingsStore, type Stored } from '../../src/index.ts';

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
  /** Called on every IndexedDB transaction the journal's store opens. Returns a stop. */
  onTransaction(listener: (transaction?: IDBTransaction) => void): () => void;
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

/** The native timers under a life's clock: real timeouts, each also kept in this scheduler's own queue until
    it fires or is cleared, so a control can see which are still armed and fire them all, independently of the
    clock's own bookkeeping. */
/** The underlying timer API the native timers arm and clear their timeouts through: the platform's, unless a
    control puts a spy in its place to see each timeout's fate at the API itself. */
export const timerApi = {
  set: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clear: (real: unknown): void => clearTimeout(real as ReturnType<typeof setTimeout>)
};

export function nativeTimers(): { set(callback: () => void, delayMs: number): number; clear(handle: number): void; pending(): number; fireAll(): void } {
  let next = 0;
  const queue = new Map<number, { callback: () => void; real: unknown }>();
  return {
    set(callback, delayMs) {
      const handle = ++next;
      const real = timerApi.set(() => {
        if (queue.delete(handle)) callback();
      }, delayMs);
      queue.set(handle, { callback, real });
      return handle;
    },
    clear(handle) {
      const t = queue.get(handle);
      if (!t) return;
      queue.delete(handle);
      timerApi.clear(t.real);
    },
    pending: () => queue.size,
    fireAll() {
      for (const [handle, t] of [...queue]) {
        queue.delete(handle);
        timerApi.clear(t.real);
        t.callback();
      }
    }
  };
}

/** A clock for one life, over its own native timers: each timer runs when its native timer fires, or sooner
    when the clock is advanced (`advance`), unless it was cancelled. A simulated kill cancels them all, the
    native timers with them, as a closed page takes its timers along; in Node a killed life's would go on
    firing into the next (a real client's call timer, say, sending its cancel through the old life's port). */
export function lifeClock(counters: Counters, native = nativeTimers()): Pick<JournalClock, 'now' | 'setTimer'> & { armed(): number; discard(): void; advance(ms: number): void; native: ReturnType<typeof nativeTimers> } {
  const base = offsetClock(counters);
  let ahead = 0;
  const now = () => base.now() + ahead;
  const timers = new Set<{ due: number; fire: () => void; handle: number }>();
  let dead = false;
  return {
    native,
    now,
    setTimer: (callback, delayMs) => {
      if (dead) return () => {};
      const t = {
        due: now() + delayMs,
        fire: () => {
          if (!timers.delete(t)) return;
          native.clear(t.handle);
          callback();
        },
        handle: 0
      };
      t.handle = native.set(() => t.fire(), delayMs);
      timers.add(t);
      return () => {
        timers.delete(t);
        native.clear(t.handle);
      };
    },
    armed: () => timers.size,
    discard: () => {
      dead = true;
      for (const t of [...timers]) {
        timers.delete(t);
        native.clear(t.handle);
      }
    },
    advance: (ms) => {
      ahead += ms;
      for (const t of [...timers].sort((a, b) => a.due - b.due)) if (t.due <= now()) t.fire();
    }
  };
}

/** Each life's client clock, by the counters that outlive the lives: the controls advance a killed life's. */
export const lifeClocks = new WeakMap<Counters, Map<number, ReturnType<typeof lifeClock>>>();

/** The fake note store: rows appended, so a write made twice would show as two rows. */
export const NotesDoc = defineJournalDoc<{ notes: { step: string; text: string; token: string }[] }>('familiar.test-notes', () => ({ notes: [] }));

/** The fake tools: one of each kind. Each counts its starts; a hang holds it in flight for the kill. */
export function fakeTools(env: Env, hang: (name: string) => boolean, onRun?: (name: string, args: any) => void): FamiliarTool[] {
  const start = (name: string, args?: unknown) => {
    onRun?.(name, args);
    return env.counters.bump(`starts:${name}`);
  };
  const maybeHang = async (name: string) => {
    if (!hang(name)) return;
    // Counted where the hang starts: for a write, after its commit is stored.
    env.counters.bump(`hung:${name}`);
    await never;
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
        start('look', args);
        await maybeHang('look');
        return `seen: ${args.what}`;
      }
    },
    {
      name: 'note_add',
      description: 'Saves a note. A built-in write.',
      inputSchema: object({ text: { type: 'string' } }),
      kind: 'write',
      doing: (a: any) => `saving a note "${a.text}"`,
      async run(args: any, step) {
        start('note_add', args);
        // Held before its write, for a kill that lands before anything is written.
        await maybeHang('note_add:before');
        // The token says which life made the row. A rerun that finds its receipt gets the first token back.
        const token = `${args.text}#life${env.life}`;
        const got = await step.write(async (tx) => {
          // Calls of the write's change, which a kill can cut off before its commit lands.
          env.counters.bump(`write-calls:life${env.life}`);
          (await tx.doc(NotesDoc)).notes.push({ step: step.id, text: args.text, token });
          return token;
        });
        await maybeHang('note_add');
        return `saved: ${args.text} (${got})`;
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
        start('send_message', args);
        await maybeHang('send_message');
        return `sent to ${args.to}`;
      }
    },
    {
      name: 'note_list',
      description: 'Lists notes. A built-in pure read.',
      inputSchema: object({}),
      kind: 'read',
      doing: () => 'listing notes',
      async run(args: any) {
        start('note_list', args);
        return 'notes: none';
      }
    },
    {
      name: 'server_read',
      description: "An MCP server's tool that says it only reads.",
      inputSchema: object({ q: { type: 'string' } }),
      kind: 'server',
      readOnlyHint: true,
      doing: (a: any) => `reading ${a.q} from the server`,
      async run(args: any) {
        start('server_read', args);
        return `read: ${args.q}`;
      }
    },
    {
      name: 'server_lookup',
      description: "An MCP server's tool.",
      inputSchema: object({ q: { type: 'string' } }),
      kind: 'server',
      // Bound to consent at the call, as a real server's wrapper is: the facts a card shows and a grant
      // ("may run on its own") is checked against.
      consent: { facts: (args: unknown) => ({ server: 'srv', tool: 'server_lookup', run: 'srv#1', launch: 'launch-1', fingerprint: 'fp-1', canonical: JSON.stringify(args), hash: 'h' }) },
      doing: (a: any) => `asking the server about ${a.q}`,
      async run(args: any) {
        start('server_lookup', args);
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
  /** Called when a notification is first shown, with its id. */
  readonly onNotify?: (id: string) => void;
  readonly chatInFront?: () => boolean;
  readonly decider?: DecisionPort;
  readonly onReaction?: (decision: Decision, event: PersonaEvent) => void;
  readonly newGen?: () => string;
  readonly onRun?: (name: string, args: any) => void;
  /** Timers that fire this many milliseconds early, as real timers can. */
  readonly earlyTimersMs?: number;
  /** The person's per-tool choices, as step 8's Settings will give them. */
  readonly policy?: GatePolicy;
  /** The gate's policy read at each call, in place of a fixed one (a real client's, say). */
  readonly policyNow?: () => GatePolicy;
  /** The tools the turn holds, from the fake ones (a real server's wrappers in place of one, say). */
  readonly tools?: (fakes: FamiliarTool[]) => FamiliarTool[];
}

/** Opens the scenario's journal over the shared store, with the fake model, tools and ports. */
export async function openFor(env: Env, store: JournalStore, o: OpenOptions) {
  const base = offsetClock(env.counters);
  const early = o.earlyTimersMs ?? 0;
  const clock = early ? { ...base, setTimer: (cb: () => void, ms: number, opts: { background: boolean }) => base.setTimer(cb, Math.max(0, ms - early), opts) } : base;
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
    tools: (o.tools ?? ((t) => t))(fakeTools(env, o.hang ?? (() => false), o.onRun)),
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
    policy: o.policyNow ?? (o.policy ? () => o.policy! : undefined),
    // A notifier that shows each id once, as the real one must. Calls and ids are counted apart.
    notifier: {
      notify: (n) => {
        env.counters.bump('notify-calls');
        env.counters.note(`notify-call-${env.counters.get('notify-calls')}`, n.id);
        if (env.counters.note(`shown:${n.id}`)) return;
        env.counters.note(`shown:${n.id}`, '1');
        env.counters.bump('delivered');
        o.onNotify?.(n.id);
        o.onDeliver?.(n.text, n.at, clock.now());
      }
    }
  });
  return { journal, model, presence, wakes, clock };
}

const callOnce = (name: string, args: unknown): FakeReply => ({ text: 'On it.', toolCalls: [{ id: 'call-1', name, arguments: args }] });

/** A settings store kept in the counters, so the client's saved record (its servers and the person's
    choices) outlives a life as the app's own store does. Two faults for the controls: `drop-grant-write`
    keeps every write without its choices (a grant that never reached the store, though life 1 holds it in
    memory); `lose-grant`, life 2 reads the record with its choices gone (a grant saved but not reloaded). */
export function countersSettings(env: Env): SettingsStore {
  const { counters } = env;
  const keys = (): string[] => JSON.parse(counters.note('settings-keys') || '[]');
  const read = (key: string): Stored | undefined => {
    const text = counters.note(`settings:${key}`);
    if (!text) return undefined;
    const r = JSON.parse(text) as Stored;
    if (env.life === 2 && counters.get('lose-grant') && r.value && typeof r.value === 'object' && 'choices' in r.value) return { ...r, value: { ...r.value, choices: {} } };
    return r;
  };
  const write = (key: string, record: Stored | undefined) => {
    if (record && counters.get('drop-grant-write') && record.value && typeof record.value === 'object' && 'choices' in record.value) record = { ...record, value: { ...record.value, choices: {} } };
    counters.note(`settings:${key}`, record ? JSON.stringify(record) : '');
    const all = new Set(keys());
    if (record) all.add(key);
    else all.delete(key);
    counters.note('settings-keys', JSON.stringify([...all].sort()));
  };
  return {
    get: async (key) => read(key),
    put: async (key, record) => write(key, record),
    delete: async (key) => write(key, undefined),
    keys: async (prefix) => keys().filter((k) => k.startsWith(prefix)),
    putIf: async (key, record, guard) => (guard(read(key)) ? (write(key, record), true) : false),
    deleteIf: async (key, guard) => (guard(read(key)) ? (write(key, undefined), true) : false)
  };
}

/** A local MCP server as the exe's process port shows it: it lists `server_lookup`, and counts each call that
    reaches it, which only the client's send() can make. In life 1 the call reaches it and is never
    answered: the step is under way at the kill. */
function lookupServer(env: Env): ProcessPort {
  let emit: (e: ProcessEvent) => void = () => {};
  const send = (m: unknown) => queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(m) }));
  return {
    async start(_setup, on) {
      emit = on;
      return { run: `life-${env.life}` };
    },
    async write(_run, bytes) {
      const m = JSON.parse(new TextDecoder().decode(bytes));
      // Anything life 1's client writes once its life was killed (a time limit's cancel, say).
      if (env.life === 1 && env.counters.get('life1-killed')) env.counters.bump('life1-writes-after-kill');
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'srv' } } });
      else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'server_lookup', description: "An MCP server's tool.", inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } }] } });
      else if (m.method === 'tools/call') {
        env.counters.bump('starts:server_lookup');
        if (env.life === 1) return void env.counters.bump('hung:server_lookup');
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `server says: ${m.params?.arguments?.q}` }] } });
      }
    },
    async stop() {
      queueMicrotask(() => emit({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
}

/** The real client over the counters' store and the fake server, Ready; in life 1 the server is added and
    "may run on its own" saved for its tool, through the client, as Settings saves it. */
async function grantedClient(env: Env) {
  const clock = lifeClock(env.counters);
  if (!lifeClocks.has(env.counters)) lifeClocks.set(env.counters, new Map());
  lifeClocks.get(env.counters)!.set(env.life, clock);
  const client = await McpClient.open({ store: countersSettings(env), processes: lookupServer(env), net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock, paths: posixPaths });
  if (env.life === 1) await client.add({ setup: { kind: 'local', id: 'srv', label: 'Srv', program: '/usr/bin/srv', args: [], cwd: '/', env: [], secrets: [] }, problems: [] });
  const started = await client.start('srv');
  if (started.kind !== 'ready') throw new Error(`The server didn't start: ${JSON.stringify(started)}`);
  const wrappers = client.tools();
  const lookup = wrappers.find((t) => t.serverName === 'server_lookup');
  if (!lookup) throw new Error('The server offers no server_lookup.');
  // The person's press on the tool's card, with the card's own facts, then its save.
  if (env.life === 1 && !(await client.owner.grant('srv', 'server_lookup', { fingerprint: lookup.fingerprint, setupFingerprint: lookup.setupFingerprint })).ok) throw new Error('The grant was not saved.');
  return { client, clock, wrappers, name: lookup.name };
}
const answerTool = (r: ModelRequest): FakeReply => ({ text: `Done. (${lastText(r)})` });

/** A scenario where the first reply calls one tool, which hangs in life 1. */
function toolKill(name: string, scenario: string, tool: string, args: unknown, extra: (env: Env, j: Journal) => Promise<Summary> = async () => ({}), more: (env: Env) => Partial<OpenOptions> = () => ({})): Scenario {
  return {
    name,
    async run(env) {
      const store = await env.openStore(scenario);
      const { journal, model, presence } = await openFor(env, store, {
        script: (r) => (lastIsTool(r) ? answerTool(r) : callOnce(tool, args)),
        hang: (n) => env.life === 1 && n === tool,
        ...more(env)
      });
      if (env.life === 1) {
        void journal.send('Please do the thing.', 'turn-1');
        while (env.counters.get(`hung:${tool}`) < 1) await sleep(10);
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
  toolKill('write-started', 'write-started', 'note_add', { text: 'buy milk' }, async (env, j) => ({
    rows: (await j.read(NotesDoc))?.notes ?? [],
    writeCalls: [env.counters.get('write-calls:life1'), env.counters.get('write-calls:life2')]
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

  // The same, with the tool marked "may run on its own", and a model that calls it again on its own, with a new id,
  // as soon as it sees the interruption. The turn ends instead: the model gets no request, and nothing
  // runs until the person picks Run again. The grant is a real one: saved through the client in life 1,
  // reloaded from its store in life 2, and the tool is the client's own wrapper, sending through send().
  {
    name: 'server-reissue',
    async run(env) {
      const store = await env.openStore('server-reissue');
      const { client, clock, wrappers, name } = await grantedClient(env);
      const { journal } = await openFor(env, store, {
        tools: (fakes) => [...fakes.filter((t) => t.name !== 'server_lookup'), ...wrappers],
        policyNow: () => client.policy(wrappers),
        script: (r) => {
          const last = r.messages.at(-1);
          if (last?.role === 'user' && last.content.startsWith('Run ')) return { toolCalls: [{ id: 'call-3', name, arguments: { q: 'trains' } }] };
          if (lastIsTool(r) && /may have partially run/.test(last!.content)) {
            env.counters.bump('reissue-asked');
            return { toolCalls: [{ id: 'call-2', name, arguments: { q: 'trains' } }] };
          }
          return lastIsTool(r) ? answerTool(r) : callOnce(name, { q: 'trains' });
        }
      });
      if (env.life === 1) {
        void journal.send('Please do the thing.', 'turn-1');
        while (env.counters.get('hung:server_lookup') < 1) await sleep(10);
        // The kill ends the life: the journal, and the client's timers with it (its call's time limit among
        // them), as a closed page would.
        env.ready(() => {
          journal.kill();
          env.counters.set('life1-timers-at-kill', clock.armed());
          clock.discard();
          env.counters.set('life1-killed', 1);
        });
        return undefined;
      }
      const end = await journal.turn(await turnId(journal)).wait();
      const [question] = await journal.questions();
      const asksBefore = env.counters.get('reissue-asked');
      const startsBefore = env.counters.get('starts:server_lookup');
      const cardsBefore = env.counters.get('consent-asks');
      const turn = question ? await journal.answer(question.id, true, 'rerun-1') : undefined;
      const rerun = turn ? await turn.wait() : undefined;
      const summary = { end, asksBefore, startsBefore, cardsBefore, rerun, startsAfter: env.counters.get('starts:server_lookup'), cardsAfter: env.counters.get('consent-asks'), transcript: await journal.transcript() };
      await journal.close();
      await client.stop('srv');
      return summary;
    }
  },

  // Skip: the turn goes on without it, and a call the model makes to it again doesn't run in this turn.
  toolKill(
    'server-skip',
    'server-skip',
    'server_lookup',
    { q: 'trains' },
    async (env, j) => {
      const [question] = await j.questions();
      const turn = question ? await j.answer(question.id, false, 'skip-1') : undefined;
      const after = turn ? await turn.wait() : undefined;
      return { after, startsAfter: env.counters.get('starts:server_lookup'), reissued: env.counters.get('reissue-asked') };
    },
    (env) => ({
      policy: { perTool: { server_lookup: 'own' } },
      script: (r) => {
        const last = r.messages.at(-1);
        if (lastIsTool(r) && /may have partially run/.test(last!.content)) {
          env.counters.bump('reissue-asked');
          return { toolCalls: [{ id: 'call-2', name: 'server_lookup', arguments: { q: 'trains' } }] };
        }
        return lastIsTool(r) ? answerTool(r) : callOnce('server_lookup', { q: 'trains' });
      }
    })
  ),

  // "Do it now?" asks consent again: withheld, nothing runs; denied, nothing runs.
  toolKill(
    'redo-withheld',
    'redo-withheld',
    'send_message',
    { to: 'Sam', text: 'hi' },
    async (env, j) => {
      const [question] = await j.questions();
      const asks = env.counters.get('consent-asks');
      if (question) void j.answer(question.id, true, 'redo-1');
      for (let i = 0; i < 100 && env.counters.get('consent-asks') === asks; i++) await sleep(10);
      await sleep(200);
      return { asksAfterYes: env.counters.get('consent-asks') - asks, startsAfter: env.counters.get('starts:send_message'), cards: await j.consents() };
    },
    () => ({ consent: (life) => (life === 1 ? Promise.resolve(true) : never) })
  ),
  toolKill(
    'redo-denied',
    'redo-denied',
    'send_message',
    { to: 'Sam', text: 'hi' },
    async (env, j) => {
      const [question] = await j.questions();
      const asks = env.counters.get('consent-asks');
      const turn = question ? await j.answer(question.id, true, 'redo-1') : undefined;
      const redo = turn ? await turn.wait() : undefined;
      return { redo, asksAfterYes: env.counters.get('consent-asks') - asks, startsAfter: env.counters.get('starts:send_message'), transcriptAfter: await j.transcript() };
    },
    () => ({ consent: (life) => Promise.resolve(life === 1) })
  ),

  // Replay state across a restart: the reply that called the tool gave replay state (signed thinking),
  // and, as step 4's contract control does, the next request is refused unless it comes back unchanged.
  {
    name: 'replay-restart',
    async run(env) {
      const store = await env.openStore('replay-restart');
      const REPLAY = { adapter: 'anthropic', data: { signature: 'sig-1', blocks: [{ type: 'thinking', thinking: 'Hm.' }] } };
      const { journal } = await openFor(env, store, {
        script: (r) => {
          if (!lastIsTool(r)) return { thinking: 'Hm.', toolCalls: [{ id: 'call-1', name: 'look', arguments: { what: 'x' } }], replay: REPLAY };
          const calling = r.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
          const back = calling?.role === 'assistant' && JSON.stringify(calling.replay) === JSON.stringify(REPLAY);
          env.counters.bump(back ? 'replay-ok' : 'replay-missing');
          return back ? { text: 'With the thinking, done.' } : { error: { kind: 'bad-request', message: 'The thinking was missing.' } };
        },
        hang: (n) => env.life === 1 && n === 'look'
      });
      if (env.life === 1) {
        void journal.send('Please do the thing.', 'turn-1');
        while (env.counters.get('hung:look') < 1) await sleep(10);
        env.ready(() => journal.kill());
        return undefined;
      }
      const end = await journal.turn(await turnId(journal)).wait();
      const summary = { end, ok: env.counters.get('replay-ok'), missing: env.counters.get('replay-missing') };
      await journal.close();
      return summary;
    }
  },

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

/**
 * A built-in write killed at a point through its whole window. With `kill-after` k set in the counters,
 * life 1 drops the store's connection right after the k-th transaction since the tool started, from
 * inside the store, so the point is exact; k runs past the turn's end too. Without it, life 1 calls
 * `ready` as the tool starts, and the driver closes the page after a delay of its own.
 */
export const WRITE_WINDOW: Scenario = {
  name: 'write-window',
  async run(env) {
    const store = await env.openStore('write-window');
    const k = env.counters.get('kill-after');
    let killed = false;
    let stop: (() => void) | undefined;
    const opened = await openFor(env, store, {
      script: (r) => (lastIsTool(r) ? answerTool(r) : callOnce('note_add', { text: 'buy milk' })),
      onRun: () => {
        env.counters.bump(`tool-runs:life${env.life}`);
        if (env.life !== 1 || stop) return;
        if (k === 0) return env.ready(() => opened.journal.kill());
        let n = 0;
        stop = env.onTransaction(() => {
          if (killed || ++n < k) return;
          killed = true;
          opened.journal.kill();
          env.ready(() => {});
        });
      }
    });
    const { journal } = opened;
    if (env.life === 1) {
      const sent = await journal.send('Note: buy milk.', 'turn-1');
      if (sent.replied) await sent.turn.wait().catch(() => undefined);
      // k past the turn's end: the kill comes after it.
      if (!killed) {
        killed = true;
        journal.kill();
        env.ready(() => {});
      }
      return undefined;
    }
    const end = await journal.turn(await turnId(journal)).wait();
    const summary = {
      end,
      rows: (await journal.read(NotesDoc))?.notes ?? [],
      result: (await journal.transcript()).find((e) => e.role === 'toolResult')?.text,
      writeCalls: [env.counters.get('write-calls:life1'), env.counters.get('write-calls:life2')],
      toolRuns: [env.counters.get('tool-runs:life1'), env.counters.get('tool-runs:life2')]
    };
    await journal.close();
    return summary;
  }
};

/** Exactly one committed row, whatever the kill point, and the step's result carries that row's token. */
export function writeWindowProblems(s: any): string[] {
  const p: string[] = [];
  if (s.end?.status !== 'answered') p.push(`turn ended ${JSON.stringify(s.end)}`);
  if (s.rows.length !== 1) p.push(`${s.rows.length} committed rows: ${JSON.stringify(s.rows)}`);
  else if (!String(s.result).includes(`(${s.rows[0].token})`)) p.push(`result ${s.result} does not match the committed row ${s.rows[0].token}`);
  return p;
}

/** Which way a run went: the row from life 1 found by its receipt, or made in life 2. */
export function writeWindowPath(s: any): 'receipt' | 'made-again' | 'before-tool' | 'other' {
  const token = s.rows[0]?.token ?? '';
  if (token.endsWith('#life1') && s.toolRuns[1] > 0 && s.writeCalls[1] === 0) return 'receipt';
  if (token.endsWith('#life2') && s.writeCalls[0] > 0) return 'made-again';
  if (token.endsWith('#life2')) return 'before-tool';
  return 'other';
}

/**
 * A wake killed after its notification went out but before the commit that writes its chat line and marks
 * it done. Life 2 runs the delivery again: the same notification id, so one notification, and one line.
 */
export const WAKE_DELIVERY: Scenario = {
  name: 'wake-delivery',
  async run(env) {
    const store = await env.openStore('wake-delivery');
    let kill: (() => void) | undefined;
    let fired = false;
    const opened = await openFor(env, store, {
      script: () => ({ text: 'unused' }),
      onNotify: () => {
        if (env.life !== 1) return;
        // Right after the notification, before the delivery's commit: no shutdown path.
        fired = true;
        kill?.();
        env.ready(() => {});
      }
    });
    const { journal, clock } = opened;
    kill = () => journal.kill();
    if (env.life === 1) {
      await journal.parkUntil('stretch', clock.now() + 50);
      while (!fired) await sleep(5);
      return undefined;
    }
    for (let i = 0; i < 200 && (await journal.transcript()).every((e) => e.kind !== 'familiar.reminder'); i++) await sleep(10);
    await sleep(100);
    const lines = (await journal.transcript()).filter((e) => e.kind === 'familiar.reminder');
    const calls = env.counters.get('notify-calls');
    const ids = Array.from({ length: calls }, (_, i) => env.counters.note(`notify-call-${i + 1}`));
    const summary = { lines: lines.map((l) => l.text), calls, ids, shown: env.counters.get('delivered') };
    await journal.close();
    return summary;
  }
};

export function scenario(name: string): Scenario {
  if (name === WAKE_DELIVERY.name) return WAKE_DELIVERY;
  if (name === WRITE_WINDOW.name) return WRITE_WINDOW;
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
}
