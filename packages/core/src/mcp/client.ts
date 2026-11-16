// The MCP client: every saved server with its actor, and what the app does with them. Add, Test, start,
// stop, remove, the tools for a turn, and reviewing tools. Only the person adds, changes or removes a
// server, in Settings; nothing here is reachable from a tool or from anything a model reads.
//
// Secrets: Settings puts a draft's secret values straight into Credential Manager (`secret_set` is a
// Settings command). Core keeps only their names, and deletes them when the server is removed.

import type { JournalClock } from '../journal/journal.ts';
import type { SettingsStore } from '../settings/store.ts';
import { ServerActor, type ServerView } from './actor.ts';
import { CoalescedWriter } from './writer.ts';
import type { PathRules } from './native-rules.ts';
import { DEFAULT_LIMITS, INIT_MS_MAX, INIT_MS_MIN, type Limits, type Phase } from './machine.ts';
import type { Draft } from './paste.ts';
import type { ProcessPort } from './process.ts';
import { ProcessTransport } from './process-transport.ts';
import { RemoteTransport, type FetchLike } from './remote.ts';
import { deleteServer, fresh, loadServers, saveServer, type SavedServer, type SavedTool, type ServerLimits } from './saved.ts';
import type { Expect } from './machine.ts';
import { modelNames, serverTool, toolChanges, type ServerTool, type ToolChanges } from './server-tools.ts';
import { openSession } from './session.ts';
import { processSetupOf, remoteTargetOf, secretRefs, setupFingerprint, setupProblems, type ServerSetup } from './setup.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';
import { unpinned, type Unpinned } from './unpinned.ts';

/** Saved addresses: the exe's `address_add` (which asks the person) and `address_remove` (which deletes
    the address's key). */
export interface AddressPort {
  add(spec: { url: string; label: string }): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
}

/** Credential Manager, as core may use it: delete only. */
export interface SecretPort {
  delete(ref: string): Promise<void>;
}

export interface McpClientOptions {
  readonly store: SettingsStore;
  readonly processes: ProcessPort;
  /** The fetch for a saved address: in the app, the guarded fetch. */
  readonly fetchFor: (address: string) => FetchLike;
  readonly addresses: AddressPort;
  readonly secrets: SecretPort;
  readonly clock: Pick<JournalClock, 'now' | 'setTimer'>;
  /** Overrides for every server's limits, for tests. */
  readonly limits?: Partial<Limits>;
  /** How setups' paths are checked: Windows' rules unless a test says otherwise. */
  readonly paths?: PathRules;
  /** Hears that a server's state, tools or failure changed. */
  readonly onChange?: (id: string) => void;
}

export interface ServerStatus {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'remote';
  readonly enabled: boolean;
  readonly phase: Phase;
  readonly failure?: Failure;
  readonly unpinned?: Unpinned;
  /** The tools as last seen, with whether the person has reviewed each as it is now. */
  readonly tools: readonly SavedTool[];
}

export interface TestedTool extends ListedTool {
  /** New or changed since the person last reviewed it. */
  readonly fresh: boolean;
}

export type TestReport =
  | { readonly ok: true; readonly tools: readonly TestedTool[]; readonly changes: ToolChanges; readonly unpinned?: Unpinned }
  | { readonly ok: false; readonly failure: Failure };

interface Entry {
  readonly actor: ServerActor<ServerSetup>;
  /** Everything of the record but the setup, which the actor holds. Changed here, then written. */
  meta: Omit<SavedServer, 'setup'>;
  /** The one writer of this server's record. */
  readonly writer: CoalescedWriter;
}

/** An address as compared for sharing: one saved address can't serve two servers, since removing either
    would remove the other's address and key. */
function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch {
    return a === b;
  }
}

export class McpClient {
  private readonly entries = new Map<string, Entry>();

  private readonly o: McpClientOptions;

  private constructor(options: McpClientOptions) {
    this.o = options;
  }

  /** Loads the saved servers. Nothing starts until `startEnabled`. */
  static async open(options: McpClientOptions): Promise<McpClient> {
    const c = new McpClient(options);
    for (const saved of await loadServers(options.store)) c.track(saved);
    return c;
  }

  /** Starting with the app: every enabled server starts. Approved ones start with no dialog. */
  startEnabled(): void {
    for (const e of this.entries.values()) if (e.meta.enabled) void e.actor.start();
  }

  list(): ServerStatus[] {
    return [...this.entries.values()].map(e => this.status(e));
  }

  get(id: string): ServerStatus | undefined {
    const e = this.entries.get(id);
    return e && this.status(e);
  }

  /**
   * Saves a draft as a server, stopped and not yet enabled. A remote server's address is added first,
   * which asks the person in the exe's dialog. Returns the refs Settings must store the draft's secret
   * values under. The draft's values never pass through here.
   */
  async add(draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ id: string; secretRefs: string[] }> {
    const problems = [...draft.problems, ...setupProblems(draft.setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    if (this.entries.has(draft.setup.id)) throw new Error('A server with this id is already saved.');
    let setup: ServerSetup = draft.setup;
    if (setup.kind === 'remote') {
      const url = setup.url;
      const sharing = (match: (s: ServerSetup) => boolean) => [...this.entries.values()].find(e => match(e.actor.setup));
      const before = sharing(s => s.kind === 'remote' && sameAddress(s.url, url));
      if (before) throw new Error(`Another server, ${before.actor.setup.label}, already uses this address. Familiar keeps one server per address.`);
      const address = await this.o.addresses.add({ url, label: setup.label });
      // The exe gives an identical address the same id. Never remove it here: it's the other server's.
      const other = sharing(s => s.kind === 'remote' && s.address === address.id);
      if (other) throw new Error(`Another server, ${other.actor.setup.label}, already uses this address. Familiar keeps one server per address.`);
      setup = { ...setup, address: address.id };
    }
    const saved: SavedServer = { setup, enabled: false, limits: {}, tools: [] };
    await saveServer(this.o.store, saved);
    this.track(saved);
    return { id: setup.id, secretRefs: secretRefs(setup) };
  }

  /**
   * Changes a stopped server's setup, keeping its id, so its tools' review carries over and a changed
   * tool shows as changed. The actor admits it (only while stopped or down) and it counts once saved; a
   * start made meanwhile waits for it. A new command, folder, setting or version asks in the exe's dialog
   * at the next start, and puts every tool back to ask. A remote server's address can't change here:
   * that's a new address, with its own approval and key, so it's removed and added again.
   */
  async edit(id: string, draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ secretRefs: string[] }> {
    const e = this.entry(id);
    const before = e.actor.setup;
    let setup: ServerSetup = { ...draft.setup, id } as ServerSetup;
    const problems = [...draft.problems, ...setupProblems(setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    if (setup.kind !== before.kind) throw new Error("A server can't change between local and remote. Add it again instead.");
    if (setup.kind === 'remote' && before.kind === 'remote') {
      if (!sameAddress(setup.url, before.url)) throw new Error('A new address needs its own approval and key. Remove the server and add it again.');
      setup = { ...setup, url: before.url, ...(before.address ? { address: before.address } : {}) };
    }
    const r = await e.actor.edit(setup);
    if (r.kind !== 'edited') throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server was removed.');
    for (const ref of secretRefs(before).filter(x => !secretRefs(setup).includes(x))) await this.o.secrets.delete(ref);
    return { secretRefs: secretRefs(setup) };
  }

  start(id: string): Promise<Reply> { return this.entry(id).actor.start(); }
  stop(id: string): Promise<Reply> { return this.entry(id).actor.stop(); }

  /** Stops it, removes its approval or address, its secrets and its saved setup. A call in flight is
      answered `interrupted`. A failed removal can be tried again. */
  async remove(id: string): Promise<Reply> {
    const e = this.entry(id);
    const r = await e.actor.remove();
    if (r.kind === 'removed') this.entries.delete(id);
    this.o.onChange?.(id);
    return r;
  }

  /** Starts it if it isn't running (the exe asks if the setup is new or changed), lists its tools, and
      stops it again if it wasn't running before. Every failure comes back in plain words. */
  async test(id: string): Promise<TestReport> {
    const e = this.entry(id);
    // Running or on its way up (starting with the app, or restarting): Test leaves it so.
    const before = e.actor.view.phase;
    const wasUp = before !== 'stopped' && before !== 'down';
    const r = await e.actor.start();
    if (r.kind !== 'ready') {
      const failure: Failure = r.kind === 'failed' ? r.failure : r.kind === 'refused' ? { kind: 'failed', words: r.words } : { kind: 'failed', words: r.kind === 'removed' ? 'The server was removed.' : 'The server was stopped before it was ready.' };
      return { ok: false, failure };
    }
    const saved = new Map(e.meta.tools.map(t => [t.name, t]));
    const tools = e.actor.view.tools.map(t => ({ ...t, fresh: fresh(saved.get(t.name), t.fingerprint) }));
    if (!wasUp) await e.actor.stop();
    const setup = e.actor.setup;
    const flag = setup.kind === 'local' ? unpinned(setup.program, setup.args) : undefined;
    // Changes against what the person reviewed.
    const reviewed = e.meta.tools.flatMap(t => (t.reviewed ? [{ name: t.name, fingerprint: t.reviewed }] : []));
    return { ok: true, tools, changes: toolChanges(reviewed, tools), ...(flag ? { unpinned: flag } : {}) };
  }

  /** The person has seen these tools' names and descriptions as they are now. */
  async markReviewed(id: string, names: readonly string[]): Promise<void> {
    const e = this.entry(id);
    e.meta = { ...e.meta, tools: e.meta.tools.map(t => (names.includes(t.name) ? { ...t, reviewed: t.fingerprint } : t)) };
    await e.writer.request();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const e = this.entry(id);
    e.meta = { ...e.meta, enabled };
    await e.writer.request();
  }

  /** A call's deadline applies from the next call; the handshake's from the next start of the app. */
  async setLimits(id: string, limits: ServerLimits): Promise<void> {
    const e = this.entry(id);
    e.meta = { ...e.meta, limits };
    await e.writer.request();
  }

  /** The tools a turn may offer the model: those of every Ready server, each bound to the tool as listed
      and the setup its run started from. Every model name is unique. */
  tools(): ServerTool[] {
    const ready = [...this.entries.values()].flatMap(e => {
      const setup = e.actor.runSetup;
      return e.actor.view.phase === 'ready' && setup ? [{ e, setup }] : [];
    });
    const names = modelNames(ready.map(({ e, setup }) => ({ id: setup.id, label: setup.label, tools: e.actor.view.tools })));
    const out: ServerTool[] = [];
    const taken = new Set<string>();
    for (const { e, setup } of ready) {
      const server = { id: setup.id, label: setup.label };
      const setupFp = setupFingerprint(setup);
      const saved = new Map(e.meta.tools.map(t => [t.name, t]));
      for (const listed of e.actor.view.tools) {
        const modelName = names.get(server.id)?.get(listed.name);
        if (!modelName || taken.has(modelName.toLowerCase())) continue;
        taken.add(modelName.toLowerCase());
        out.push(serverTool({
          server,
          listed,
          modelName,
          setupFingerprint: setupFp,
          fresh: fresh(saved.get(listed.name), listed.fingerprint),
          call: (tool, args, options) => this.call(server.id, tool, args, options)
        }));
      }
    }
    return out;
  }

  /** One call, under the server's own deadline unless the caller gives one. With `expect`, it's sent only
      if the server still offers exactly that tool, from that setup. */
  call(id: string, tool: string, args: unknown, options: { ms?: number; signal?: AbortSignal; expect?: Expect } = {}): Promise<CallOutcome> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve({ kind: 'error', reason: 'removed', words: 'The server was removed.' });
    const ms = options.ms ?? e.meta.limits.callMs;
    return e.actor.call(tool, args, { ...(ms !== undefined ? { ms } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.expect ? { expect: options.expect } : {}) });
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error('No server is saved with that id.');
    return e;
  }

  private status(e: Entry): ServerStatus {
    const v = e.actor.view;
    const s = e.actor.setup;
    const flag = s.kind === 'local' ? unpinned(s.program, s.args) : undefined;
    return { id: s.id, label: s.label, kind: s.kind, enabled: e.meta.enabled, phase: v.phase, ...(v.failure ? { failure: v.failure } : {}), ...(flag ? { unpinned: flag } : {}), tools: e.meta.tools };
  }

  private track(saved: SavedServer): void {
    const initMs = saved.limits.initMs === undefined ? undefined : Math.min(INIT_MS_MAX, Math.max(INIT_MS_MIN, saved.limits.initMs));
    const limits: Limits = { ...DEFAULT_LIMITS, ...(initMs !== undefined ? { initMs } : {}), ...this.o.limits };
    const { setup: first, ...meta } = saved;
    // The record as it is now: an edit being saved goes in with it.
    const record = (): SavedServer => ({ setup: entry.actor.pendingSetup ?? entry.actor.setup, ...entry.meta });
    const entry: Entry = {
      meta,
      writer: new CoalescedWriter(() => saveServer(this.o.store, record())),
      actor: new ServerActor<ServerSetup>({
        setup: first,
        clock: this.o.clock,
        limits,
        fingerprint: setupFingerprint,
        open: (events, setup) => {
          const transport = setup.kind === 'local' ? new ProcessTransport(this.o.processes, processSetupOf(setup)) : new RemoteTransport(remoteTargetOf(setup), this.o.fetchFor(setup.address ?? ''));
          return openSession(transport, events, { initMs: limits.initMs });
        },
        save: () => entry.writer.request(),
        forget: async setup => {
          // Nothing more is written, so no write can bring the record back after it's deleted.
          await entry.writer.close();
          await this.forget(setup);
        },
        onChange: view => this.changed(entry, view)
      })
    };
    this.entries.set(first.id, entry);
  }

  /** What removing a server removes, in an order a retry can repeat. */
  private async forget(setup: ServerSetup): Promise<void> {
    if (setup.kind === 'local') {
      await this.o.processes.forget(setup.id);
      for (const ref of secretRefs(setup)) await this.o.secrets.delete(ref);
    } else if (setup.address) {
      await this.o.addresses.remove(setup.address);
    }
    await deleteServer(this.o.store, setup.id);
  }

  /** A changed tool list is saved, coalesced. What the person reviewed is kept, so a changed tool shows as
      changed. */
  private changed(e: Entry, view: ServerView): void {
    if (view.phase === 'ready') {
      const before = new Map(e.meta.tools.map(t => [t.name, t]));
      const tools: SavedTool[] = view.tools.map(t => {
        const reviewed = before.get(t.name)?.reviewed;
        return { name: t.name, fingerprint: t.fingerprint, ...(reviewed ? { reviewed } : {}) };
      });
      if (JSON.stringify(tools) !== JSON.stringify(e.meta.tools)) {
        e.meta = { ...e.meta, tools };
        e.writer.request().catch(() => {});
      }
    }
    this.o.onChange?.(e.actor.setup.id);
  }
}
