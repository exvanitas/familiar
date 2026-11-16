// The MCP client: every saved server with its actor, and what the app does with them. Add, Test, start,
// stop, remove, the tools for a turn, and reviewing tools. Only the person adds, changes or removes a
// server, in Settings; nothing here is reachable from a tool or from anything a model reads.
//
// Secrets: Settings puts a draft's secret values straight into Credential Manager (`secret_set` is a
// Settings command). Core keeps only their names, and deletes them when the server is removed.

import type { JournalClock } from '../journal/journal.ts';
import type { SettingsStore } from '../settings/store.ts';
import { ServerActor, type ServerView } from './actor.ts';
import { DEFAULT_LIMITS, INIT_MS_MAX, INIT_MS_MIN, type Limits, type Phase } from './machine.ts';
import type { Draft } from './paste.ts';
import type { ProcessPort } from './process.ts';
import { ProcessTransport } from './process-transport.ts';
import { RemoteTransport, type FetchLike } from './remote.ts';
import { deleteServer, fresh, loadServers, saveServer, type SavedServer, type SavedTool, type ServerLimits } from './saved.ts';
import { modelNames, serverTool, toolChanges, toolFingerprint, type ServerTool, type ToolChanges } from './server-tools.ts';
import { openSession } from './session.ts';
import { processSetupOf, remoteTargetOf, secretRefs, setupFingerprint, setupProblems, type ServerSetup } from './setup.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';
import { unpinned, type Unpinned } from './unpinned.ts';

/**
 * The address the person approves for a remote server. Streamable HTTP uses one URL, so that's the
 * address. A legacy SSE server names the URL for its posts itself, often beside the stream's path rather
 * than under it, and the SDK keeps it to the same origin, so an SSE server's address is its origin.
 */
export function addressUrl(s: { url: string; transport: 'http' | 'sse' }): string {
  return s.transport === 'sse' ? new URL(s.url).origin : s.url;
}

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
  readonly fingerprint: string;
  /** New or changed since the person last reviewed it. */
  readonly fresh: boolean;
}

export type TestReport =
  | { readonly ok: true; readonly tools: readonly TestedTool[]; readonly changes: ToolChanges; readonly unpinned?: Unpinned }
  | { readonly ok: false; readonly failure: Failure };

interface Entry {
  saved: SavedServer;
  actor: ServerActor;
  /** Saves of this server, one after another. */
  saving: Promise<void>;
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
    for (const e of this.entries.values()) if (e.saved.enabled) void e.actor.start();
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
    const problems = [...draft.problems, ...setupProblems(draft.setup)];
    if (problems.length) throw new Error(problems[0]);
    if (this.entries.has(draft.setup.id)) throw new Error('A server with this id is already saved.');
    let setup: ServerSetup = draft.setup;
    if (setup.kind === 'remote') {
      const address = await this.o.addresses.add({ url: addressUrl(setup), label: setup.label });
      setup = { ...setup, address: address.id };
    }
    const saved: SavedServer = { setup, enabled: false, limits: {}, tools: [] };
    await saveServer(this.o.store, saved);
    this.track(saved);
    return { id: setup.id, secretRefs: secretRefs(setup) };
  }

  /**
   * Changes a stopped server's setup, keeping its id, so its tools' review carries over and a changed
   * tool shows as changed. A new command, folder, setting or version asks in the exe's dialog at the next
   * start, and puts every tool back to ask. A remote server's address can't change here: that's a new
   * address, with its own approval and key, so it's removed and added again.
   */
  async edit(id: string, draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ secretRefs: string[] }> {
    const e = this.entry(id);
    const phase = e.actor.view.phase;
    if (phase !== 'stopped' && phase !== 'down') throw new Error('Stop the server before changing it.');
    const before = e.saved.setup;
    let setup: ServerSetup = { ...draft.setup, id } as ServerSetup;
    const problems = [...draft.problems, ...setupProblems(setup)];
    if (problems.length) throw new Error(problems[0]);
    if (setup.kind !== before.kind) throw new Error("A server can't change between local and remote. Add it again instead.");
    if (setup.kind === 'remote' && before.kind === 'remote') {
      if (setup.url !== before.url || setup.transport !== before.transport) throw new Error('A new address needs its own approval and key. Remove the server and add it again.');
      setup = { ...setup, ...(before.address ? { address: before.address } : {}) };
    }
    const gone = secretRefs(before).filter(r => !secretRefs(setup).includes(r));
    await this.update(e, s => ({ ...s, setup }));
    for (const ref of gone) await this.o.secrets.delete(ref);
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
    const wasUp = e.actor.view.phase === 'ready';
    const r = await e.actor.start();
    if (r.kind !== 'ready') {
      const failure: Failure = r.kind === 'failed' ? r.failure : r.kind === 'refused' ? { kind: 'failed', words: r.words } : { kind: 'failed', words: r.kind === 'removed' ? 'The server was removed.' : 'The server was stopped before it was ready.' };
      return { ok: false, failure };
    }
    const listed = e.actor.view.tools;
    await e.saving;
    const saved = new Map(e.saved.tools.map(t => [t.name, t]));
    const tools = listed.map(t => {
      const fingerprint = toolFingerprint(t);
      return { ...t, fingerprint, fresh: fresh(saved.get(t.name), fingerprint) };
    });
    if (!wasUp) await e.actor.stop();
    const flag = e.saved.setup.kind === 'local' ? unpinned(e.saved.setup.program, e.saved.setup.args) : undefined;
    // Changes against what the person reviewed.
    const reviewed = e.saved.tools.flatMap(t => (t.reviewed ? [{ name: t.name, fingerprint: t.reviewed }] : []));
    return { ok: true, tools, changes: toolChanges(reviewed, tools), ...(flag ? { unpinned: flag } : {}) };
  }

  /** The person has seen these tools' names and descriptions as they are now. */
  async markReviewed(id: string, names: readonly string[]): Promise<void> {
    const e = this.entry(id);
    await this.update(e, s => ({ ...s, tools: s.tools.map(t => (names.includes(t.name) ? { ...t, reviewed: t.fingerprint } : t)) }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update(this.entry(id), s => ({ ...s, enabled }));
  }

  /** A call's deadline applies from the next call; the handshake's from the next start of the app. */
  async setLimits(id: string, limits: ServerLimits): Promise<void> {
    await this.update(this.entry(id), s => ({ ...s, limits }));
  }

  /** The tools a turn may offer the model: those of every Ready server. */
  tools(): ServerTool[] {
    const ready = [...this.entries.values()].filter(e => e.actor.view.phase === 'ready');
    const names = modelNames(ready.map(e => ({ id: e.saved.setup.id, label: e.saved.setup.label, tools: e.actor.view.tools })));
    const out: ServerTool[] = [];
    for (const e of ready) {
      const server = { id: e.saved.setup.id, label: e.saved.setup.label };
      const setupFp = setupFingerprint(e.saved.setup);
      const saved = new Map(e.saved.tools.map(t => [t.name, t]));
      for (const listed of e.actor.view.tools) {
        const fp = toolFingerprint(listed);
        out.push(serverTool({
          server,
          listed,
          modelName: names.get(server.id)!.get(listed.name)!,
          setupFingerprint: setupFp,
          fresh: fresh(saved.get(listed.name), fp),
          call: (tool, args, options) => this.call(server.id, tool, args, options)
        }));
      }
    }
    return out;
  }

  /** One call, under the server's own deadline unless the caller gives one. */
  call(id: string, tool: string, args: unknown, options: { ms?: number; signal?: AbortSignal } = {}): Promise<CallOutcome> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve({ kind: 'error', reason: 'removed', words: 'The server was removed.' });
    const ms = options.ms ?? e.saved.limits.callMs;
    return e.actor.call(tool, args, { ...(ms !== undefined ? { ms } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error('No server is saved with that id.');
    return e;
  }

  private status(e: Entry): ServerStatus {
    const v = e.actor.view;
    const s = e.saved.setup;
    const flag = s.kind === 'local' ? unpinned(s.program, s.args) : undefined;
    return { id: s.id, label: s.label, kind: s.kind, enabled: e.saved.enabled, phase: v.phase, ...(v.failure ? { failure: v.failure } : {}), ...(flag ? { unpinned: flag } : {}), tools: e.saved.tools };
  }

  private track(saved: SavedServer): void {
    const id = saved.setup.id;
    const initMs = saved.limits.initMs === undefined ? undefined : Math.min(INIT_MS_MAX, Math.max(INIT_MS_MIN, saved.limits.initMs));
    const limits: Limits = { ...DEFAULT_LIMITS, ...(initMs !== undefined ? { initMs } : {}), ...this.o.limits };
    const entry: Entry = {
      saved,
      saving: Promise.resolve(),
      actor: new ServerActor({
        clock: this.o.clock,
        limits,
        // The setup as saved at each start, so an edit applies from the next start.
        open: events => {
          const setup = entry.saved.setup;
          const transport = setup.kind === 'local' ? new ProcessTransport(this.o.processes, processSetupOf(setup)) : new RemoteTransport(remoteTargetOf(setup), this.o.fetchFor(setup.address ?? ''));
          return openSession(transport, events, { initMs: limits.initMs });
        },
        forget: async () => {
          await entry.saving;
          await this.forget(entry.saved.setup);
        },
        onChange: view => this.changed(entry, view)
      })
    };
    this.entries.set(id, entry);
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

  /** A changed tool list is saved. What the person reviewed is kept, so a changed tool shows as changed. */
  private changed(e: Entry, view: ServerView): void {
    if (view.phase === 'ready') {
      const before = new Map(e.saved.tools.map(t => [t.name, t]));
      const tools: SavedTool[] = view.tools.map(t => {
        const reviewed = before.get(t.name)?.reviewed;
        return { name: t.name, fingerprint: toolFingerprint(t), ...(reviewed ? { reviewed } : {}) };
      });
      if (JSON.stringify(tools) !== JSON.stringify(e.saved.tools)) void this.update(e, s => ({ ...s, tools }));
    }
    this.o.onChange?.(e.saved.setup.id);
  }

  /** Changes a server's saved record, one change after another, and keeps the record in memory in step. */
  private update(e: Entry, change: (s: SavedServer) => SavedServer): Promise<void> {
    const next = e.saving.then(async () => {
      if (e.actor.view.phase === 'removed' || e.actor.view.phase === 'removing') return;
      const s = change(e.saved);
      await saveServer(this.o.store, s);
      e.saved = s;
    });
    e.saving = next.catch(() => {});
    return next;
  }
}
