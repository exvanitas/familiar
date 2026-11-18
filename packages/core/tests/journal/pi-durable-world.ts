// A bare pi-durable engine on a fake IndexedDB, with every commit recorded at the storage boundary (one
// batch is one commit) and `pi.live` and `pi.inbox` rebuilt from the stored documents, so "in the same
// commit" is read from what was stored, not from a later snapshot. Used by pi-durable-b1.test.ts and the
// pin tests.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { applyImmutable } from '@earendil-works/chord/delta';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { portProvider } from '../../src/journal/provider.ts';
import { openJournalStore } from '../../src/journal/store.ts';
import { cappedPort, createCaps, memoryUsageStore } from '../../src/model/caps.ts';
import type { ModelRequest } from '../../src/model/port.ts';
import { createFakeModel, type FakeReply } from '../../src/testing/fake-model.ts';

(globalThis as any).IDBKeyRange ??= IDBKeyRange;
const ctx = BACKGROUND_CONTEXT;

/* ---------- the commit recorder ---------- */

export interface Commit {
  readonly seq: number;
  readonly livePre: any;
  readonly livePost: any;
  readonly inboxPre: any;
  readonly inboxPost: any;
  /** Submission records this commit wrote: id, type, status, reason. */
  readonly submissions: { id: string; type: string; status: string; reason?: string }[];
  /** Entries this commit appended: kind, and whether the model sees it. */
  readonly entries: { id: string; kind: string; model: boolean }[];
  /** Tasks this commit wrote: id, name, status. */
  readonly tasks: { id: string; name: string; status: string }[];
}

export function recordCommits(storage: any) {
  const kinds = new Map<string, string>();
  const values = new Map<string, any>();
  const log: Commit[] = [];
  const liveOf = () => [...values.entries()].find(([id]) => kinds.get(id) === 'pi.live')?.[1];
  const inboxOf = () => [...values.entries()].find(([id]) => kinds.get(id) === 'pi.inbox')?.[1];
  const original = storage.commit.bind(storage);
  storage.commit = (batches: any[][], receive: (i: number, seq: any) => void, context: any) =>
    original(
      batches,
      (index: number, seq: any) => {
        const livePre = structuredClone(liveOf());
        const inboxPre = structuredClone(inboxOf());
        const commit: Commit = { seq: Number(seq), livePre, livePost: undefined, inboxPre, inboxPost: undefined, submissions: [], entries: [], tasks: [] };
        for (const w of batches[index]!) {
          if (w.type === 'document.create') {
            kinds.set(String(w.record.id), w.record.kind);
            values.set(String(w.record.id), structuredClone(w.content.value));
          } else if (w.type === 'document.change') {
            const id = String(w.id);
            values.set(id, w.content.kind === 'base' ? structuredClone(w.content.value) : applyImmutable(values.get(id), w.content.ops));
          } else if (w.type === 'submission') {
            commit.submissions.push({ id: String(w.value.id), type: w.value.type ?? w.value.draft?.type, status: w.value.status, reason: w.value.reason ?? w.value.settlement?.reason });
          } else if (w.type === 'entry') {
            commit.entries.push({ id: String(w.value.id), kind: w.value.kind, model: w.value.model !== undefined });
          } else if (w.type === 'task') {
            commit.tasks.push({ id: String(w.value.id), name: w.value.kind, status: w.value.state?.status });
          }
        }
        (commit as any).livePost = structuredClone(liveOf());
        (commit as any).inboxPost = structuredClone(inboxOf());
        log.push(commit);
        receive(index, seq);
      },
      context
    );
  return log;
}

/* ---------- one engine ---------- */

export interface World {
  factory: IDBFactory;
  name: string;
  /** Drops the connection with no shutdown, as a crash would. */
  kill(): void;
  harness: any;
  root: any;
  log: Commit[];
  fake: ReturnType<typeof createFakeModel>;
  setCap(on: boolean): void;
  live(): Promise<any>;
  inbox(): Promise<any>;
  until(predicate: () => Promise<boolean>, what: string): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

let worlds = 0;

export async function world(options: {
  script: (request: ModelRequest, index: number) => FakeReply;
  maxTurns?: number;
  settings?: Record<string, unknown>;
  contextWindow?: number;
  parkOn?: string;
  /** Reopens an existing database, as a restarted app would. */
  reopen?: { factory: IDBFactory; name: string };
  /** Runs after open, before scheduling starts. */
  beforeResume?: (harness: any, root: any) => Promise<void>;
}): Promise<World> {
  const factory = options.reopen?.factory ?? new IDBFactory();
  const name = options.reopen?.name ?? `b1-${++worlds}`;
  const store = await openJournalStore(name, { indexedDB: factory });
  const log = recordCommits(store.storage);
  const fake = createFakeModel(options.script);
  let cap = false;
  // The day cap at one token: any request pauses, through the real cappedPort, as a cap pause does.
  const caps = createCaps({ maxReplyTokens: 1000, maxDayTokens: 1 }, memoryUsageStore(), { now: () => Date.now() });
  const port = () => (cap ? cappedPort(fake, caps, () => ({ persona: 'p', turn: 't', price: undefined })) : fake);
  const { provider } = portProvider(port, { id: 'familiar', modelId: 'm', contextWindow: options.contextWindow ?? 32000 });
  const models = createModels();
  models.setProvider(provider);
  const look = defineTool({
    name: 'look',
    description: 'Looks.',
    parameters: { type: 'object', properties: { what: { type: 'string' } } } as any,
    execute: async (args: any) => {
      if (options.parkOn && args?.what === options.parkOn) parkNext = true;
      return { output: [{ type: 'text', text: `saw ${args?.what ?? ''}` }] };
    }
  } as any);
  let harness: any;
  let root: any;
  let parkNext = false;
  // As the journal's park hook does: a round whose tool asked to park ends its run with abortTask.
  const park = hook(GenerationTask, {
    afterTools: async (_assistant: unknown, _results: unknown, api: any) => {
      if (!parkNext) return;
      parkNext = false;
      void harness.abortTask(api.taskId, ctx);
    }
  } as any);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'b1', tools: [look], hooks: [park] } as any));
  harness = await Harness.open(
    store.storage,
    {
      models,
      registry,
      identity: { attribution: null },
      // Familiar's own settings (journal.ts), plus the scenario's.
      settings: { retry: { maxRetries: 2, baseDelayMs: 2000 }, toolExecution: 'sequential', ...options.settings }
    } as any,
    ctx
  );
  root = await harness.root(ctx, { agent: { model: { provider: 'familiar', modelId: 'm' }, instructions: 'Be brief.', maxTurns: options.maxTurns ?? 8 } });
  await options.beforeResume?.(harness, root);
  harness.resume();
  const live = () => harness.snapshot(LiveDoc, root.id, ctx);
  const inbox = () => harness.snapshot(InboxDoc, root.id, ctx);
  const until = async (predicate: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 1000; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return {
    factory,
    name,
    kill: () => store.sever(),
    harness,
    root,
    log,
    fake,
    setCap: (on) => void (cap = on),
    live,
    inbox,
    until,
    idle: () => until(async () => { const l = await live(); return !l?.run && !(l?.compactions?.length); }, 'idle'),
    close: () => harness.close(ctx)
  };
}

/** A gate a fake reply waits on. */
export function gate() {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { until, open };
}

export const lastUser = (request: ModelRequest) => {
  const users = request.messages.filter((m) => m.role === 'user');
  return String(users[users.length - 1]?.content ?? '');
};
export const isSummary = (request: ModelRequest) => request.messages.some((m) => m.role === 'user' && String(m.content).includes('<conversation>'));

/** The commit whose stored submissions include `id` with `status`. */
export const commitOf = (log: Commit[], id: string, status: string) => log.find((c) => c.submissions.some((s) => s.id === id && s.status === status));
export const runStarts = (log: Commit[]) => log.filter((c) => !c.livePre?.run && c.livePost?.run);
export const sub = async (w: World, draft: any) => w.root.submit(draft, ctx);
export const statusOf = async (w: World, id: unknown) => (await (await w.harness.submission(Number(id), ctx))?.status(ctx))?.status;

/** Prints a fact for BUILD-checks.md. */
export const fact = (name: string, value: unknown) => console.log(`B1 ${name}: ${JSON.stringify(value)}`);


/** A world left idle after a turn_limit failure, with `queued` messages behind it. */
export async function failedWorld(queued: number, settings?: Record<string, unknown>) {
  const hold = gate();
  const w = await world({
    maxTurns: 1,
    settings,
    script: (request) => {
      const u = lastUser(request);
      if (u === 'A' && !request.messages.some((m) => m.role === 'tool')) return { toolCalls: [{ id: 'a1', name: 'look', arguments: { what: 'a' } }], pause: { afterEvents: 0, until: hold.until } };
      return { text: `answer to ${u || 'tool results'}` };
    }
  });
  const a = await sub(w, { type: 'input', content: 'A' });
  await w.until(async () => !!(await w.live())?.run, 'A running');
  const qs = [];
  for (let i = 0; i < queued; i++) qs.push(await sub(w, { type: 'input', content: `Q${i}` }));
  hold.open();
  if (settings?.afterFailedRun === 'continue') {
    await w.until(async () => !!commitOf(w.log, String(a.id), 'unanswered'), 'A ended');
  } else {
    await w.idle();
  }
  return { w, a, qs };
}

export async function compactionWorld(backgroundTokens: number | undefined, overrides?: Record<string, unknown>) {
  const summary = gate();
  const hold = gate();
  let summaries = 0;
  const w = await world({
    maxTurns: 1,
    contextWindow: 100_000,
    settings: { compaction: { keepRecentTokens: 10, ...(backgroundTokens === undefined ? {} : { backgroundTokens }), ...(overrides ? { modelOverrides: overrides } : {}) } },
    script: (request) => {
      if (isSummary(request)) {
        summaries++;
        return { text: 'SUMMARY', pause: { afterEvents: 0, until: summary.until } };
      }
      const u = lastUser(request);
      // The first reply reports 60000 input tokens: above the background threshold (100000 - 16384 - 32768),
      // below the blocking one.
      if (u === 'first') return { text: 'hello', usage: { inputTokens: 60_000, outputTokens: 10 } };
      if (u === 'A' && !request.messages.some((m) => m.role === 'tool')) return { toolCalls: [{ id: 'a1', name: 'look', arguments: { what: 'a' } }], pause: { afterEvents: 0, until: hold.until } };
      return { text: `answer to ${u}` };
    }
  });
  const first = await sub(w, { type: 'input', content: 'first' });
  await first.wait(ctx);
  await w.idle();
  const a = await sub(w, { type: 'input', content: 'A' });
  await w.until(async () => !!(await w.live())?.run, 'A running');
  const b = await sub(w, { type: 'input', content: 'B' });
  hold.open();
  await w.until(async () => !!commitOf(w.log, String(a.id), 'unanswered'), 'A ended');
  return { w, a, b, summary, summaries: () => summaries };
}

