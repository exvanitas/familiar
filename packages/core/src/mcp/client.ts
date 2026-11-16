// The MCP client: every saved server with its actor, and what the app does with them. Add, Test, start,
// stop, remove, the tools for a turn, and reviewing tools. Only the person adds, changes or removes a
// server, in Settings; nothing here is reachable from a tool or from anything a model reads.
//
// Secrets: Settings puts a draft's secret values straight into Credential Manager (`secret_set` is a
// Settings command). Core keeps only their names, and deletes them when the server is removed.

import type { JournalClock } from '../journal/journal.ts';
import type { SettingsStore } from '../settings/store.ts';
import { ServerActor, type ServerView } from './actor.ts';
import type { PathRules } from './native-rules.ts';
import { DEFAULT_LIMITS, INIT_MS_MAX, INIT_MS_MIN, type Limits, type Phase } from './machine.ts';
import type { Draft } from './paste.ts';
import type { ProcessPort } from './process.ts';
import { ProcessTransport } from './process-transport.ts';
import { RemoteTransport, type FetchLike } from './remote.ts';
import { addServer, deleteServer, fresh, loadServers, saveServer, type SavedServer, type SavedTool, type ServerLimits } from './saved.ts';
import type { Expect } from './machine.ts';
import { choiceKey, modelNames, serverTool, toolChanges, type ServerTool, type ToolChanges, type ToolChoice } from './server-tools.ts';
import { openSession, type Session, type SessionEvents } from './session.ts';
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
  /** A new incarnation for an added server. Random by default; tests pass their own. */
  readonly newIncarnation?: () => string;
  /** Opens one run: the real session over a process or a fetch unless a test gives its own. */
  readonly connect?: (setup: ServerSetup, events: SessionEvents) => Session;
  /** The person's choices, keyed by `choiceKey` (step 8 keeps them). Read again at every call a wrapper
      makes, by the wrapper's own identity: a "never" refuses the call even if the gate let it through. */
  readonly choices?: () => Readonly<Record<string, ToolChoice>>;
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
  /** The actor owns the whole record and every change to it, the add and the removal included. */
  readonly actor: ServerActor<SavedServer>;
  /** What the record was loaded or added with: writes are numbered on from its revision. */
  readonly baseRev: number;
}

const randomIncarnation = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

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
    for (const saved of await loadServers(options.store)) c.track(saved, false);
    return c;
  }

  /** Starting with the app: every enabled server starts. Approved ones start with no dialog. */
  startEnabled(): void {
    for (const e of this.entries.values()) if (e.actor.setup.enabled) void e.actor.start();
  }

  list(): ServerStatus[] {
    return [...this.entries.values()].filter(e => e.actor.view.phase !== 'adding').map(e => this.status(e));
  }

  get(id: string): ServerStatus | undefined {
    const e = this.entries.get(id);
    return e && e.actor.view.phase !== 'adding' ? this.status(e) : undefined;
  }

  /**
   * Adds a draft as a server, stopped and not yet enabled. Its entry is held from the first moment, with
   * its address, so a second add of the same id or address is refused while this one runs, the exe's
   * dialog included. The actor owns the add: a remote server's address is added first (the dialog), then
   * the first record is written where nothing is saved. Returns the refs Settings must store the draft's
   * secret values under. The draft's values never pass through here.
   */
  async add(draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ id: string; secretRefs: string[] }> {
    const problems = [...draft.problems, ...setupProblems(draft.setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    const setup = draft.setup;
    if (this.entries.has(setup.id)) throw new Error('A server with this id is already saved.');
    if (setup.kind === 'remote') {
      const other = this.sharing(setup.id, s => s.kind === 'remote' && sameAddress(s.url, setup.url));
      if (other) throw new Error(`Another server, ${other.label}, already uses this address. Familiar keeps one server per address.`);
    }
    const record: SavedServer = { setup, enabled: false, limits: {}, tools: [], incarnation: (this.o.newIncarnation ?? randomIncarnation)(), rev: 0 };
    const entry = this.track(record, true);
    const r = await entry.actor.register();
    if (r.kind !== 'added') throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server could not be added.');
    return { id: setup.id, secretRefs: secretRefs(entry.actor.setup.setup) };
  }

  /**
   * Changes a stopped server's setup, keeping its id, so its tools' review carries over and a changed
   * tool shows as changed. The actor admits it (only while stopped or down), writes it, then deletes the
   * secrets it dropped, all owned by the actor: it counts once saved, and the server takes no other
   * change until the deletes land. A start made meanwhile waits for it. A new command, folder, setting or
   * version asks in the exe's dialog at the next start, and puts every tool back to ask. A remote
   * server's address can't change here: that's a new address, with its own approval and key.
   */
  async edit(id: string, draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ secretRefs: string[] }> {
    const e = this.entry(id);
    const before = e.actor.setup.setup;
    let setup: ServerSetup = { ...draft.setup, id } as ServerSetup;
    const problems = [...draft.problems, ...setupProblems(setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    if (setup.kind !== before.kind) throw new Error("A server can't change between local and remote. Add it again instead.");
    if (setup.kind === 'remote' && before.kind === 'remote') {
      if (!sameAddress(setup.url, before.url)) throw new Error('A new address needs its own approval and key. Remove the server and add it again.');
      setup = { ...setup, url: before.url, ...(before.address ? { address: before.address } : {}) };
    }
    const next = setup;
    const r = await e.actor.edit(rec => ({ ...rec, setup: next }));
    if (r.kind !== 'edited') throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server was removed.');
    return { secretRefs: secretRefs(next) };
  }

  start(id: string): Promise<Reply> { return this.entry(id).actor.start(); }
  stop(id: string): Promise<Reply> { return this.entry(id).actor.stop(); }

  /** Stops it, removes its approval or address, its secrets and its saved setup. A call in flight is
      answered `interrupted`. The actor owns the removal until it lands, past its deadline too: until then
      the id and its address stay taken. A failed removal can be tried again. */
  async remove(id: string): Promise<Reply> {
    return this.entry(id).actor.remove();
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
    const meta = e.actor.pendingSetup;
    const saved = new Map(meta.tools.map(t => [t.name, t]));
    const tools = e.actor.view.tools.map(t => ({ ...t, fresh: fresh(saved.get(t.name), t.fingerprint) }));
    if (!wasUp) await e.actor.stop();
    const setup = e.actor.setup.setup;
    const flag = setup.kind === 'local' ? unpinned(setup.program, setup.args) : undefined;
    // Changes against what the person reviewed.
    const reviewed = meta.tools.flatMap(t => (t.reviewed ? [{ name: t.name, fingerprint: t.reviewed }] : []));
    return { ok: true, tools, changes: toolChanges(reviewed, tools), ...(flag ? { unpinned: flag } : {}) };
  }

  /** The person has seen these tools' names and descriptions as they are now. */
  markReviewed(id: string, names: readonly string[]): Promise<void> {
    return this.update(id, r => ({ ...r, tools: r.tools.map(t => (names.includes(t.name) ? { ...t, reviewed: t.fingerprint } : t)) }));
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.update(id, r => ({ ...r, enabled }));
  }

  /** A call's deadline applies from the next call; the handshake's from the next start of the app. */
  setLimits(id: string, limits: ServerLimits): Promise<void> {
    return this.update(id, r => ({ ...r, limits }));
  }

  /** The tools a turn may offer the model: those of every Ready server, each bound to the tool as listed
      and the setup its run started from. Every model name is unique. */
  tools(): ServerTool[] {
    const ready = [...this.entries.values()].flatMap(e => {
      const run = e.actor.runSetup;
      return e.actor.view.phase === 'ready' && run ? [{ e, setup: run.setup }] : [];
    });
    const names = modelNames(ready.map(({ e, setup }) => ({ id: setup.id, label: setup.label, tools: e.actor.view.tools })));
    const out: ServerTool[] = [];
    const taken = new Set<string>();
    for (const { e, setup } of ready) {
      const server = { id: setup.id, label: setup.label };
      const setupFp = setupFingerprint(setup);
      const saved = new Map(e.actor.pendingSetup.tools.map(t => [t.name, t]));
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
    if (!e || e.actor.view.phase === 'adding') return Promise.resolve({ kind: 'error', reason: 'removed', words: 'The server was removed.' });
    // A wrapper's call: its identity is this server's id and the tool's own name, and the person's
    // choice for exactly that identity is read now.
    if (options.expect && this.o.choices?.()[choiceKey(id, tool)]?.policy === 'deny') {
      return Promise.resolve({ kind: 'error', reason: 'changed', words: `You chose never to run ${tool} on this server, so Familiar didn't send the call.` });
    }
    const ms = options.ms ?? e.actor.setup.limits.callMs;
    return e.actor.call(tool, args, { ...(ms !== undefined ? { ms } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.expect ? { expect: options.expect } : {}) });
  }

  /** The record as the actor last committed it: what the store should hold once things are quiet. */
  record(id: string): SavedServer | undefined {
    const e = this.entries.get(id);
    return e && e.actor.view.phase !== 'adding' ? e.actor.setup : undefined;
  }

  /** Callers waiting on a server, of every kind. Bounded by the actor's admission caps. */
  waiting(id: string): number {
    return this.entries.get(id)?.actor.waiting ?? 0;
  }

  private async update(id: string, change: (r: SavedServer) => SavedServer): Promise<void> {
    const r = await this.entry(id).actor.update(change);
    if (r.kind !== 'edited') throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server was removed.');
  }

  /** Another entry, added or being added, whose setup matches. */
  private sharing(self: string, match: (s: ServerSetup) => boolean): ServerSetup | undefined {
    for (const [id, e] of this.entries) if (id !== self && match(e.actor.pendingSetup.setup)) return e.actor.pendingSetup.setup;
    return undefined;
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e || e.actor.view.phase === 'adding') throw new Error('No server is saved with that id.');
    return e;
  }

  private status(e: Entry): ServerStatus {
    const v = e.actor.view;
    const r = e.actor.setup;
    const s = r.setup;
    const flag = s.kind === 'local' ? unpinned(s.program, s.args) : undefined;
    return { id: s.id, label: s.label, kind: s.kind, enabled: r.enabled, phase: v.phase, ...(v.failure ? { failure: v.failure } : {}), ...(flag ? { unpinned: flag } : {}), tools: e.actor.pendingSetup.tools };
  }

  private track(saved: SavedServer, adding: boolean): Entry {
    const initMs = saved.limits.initMs === undefined ? undefined : Math.min(INIT_MS_MAX, Math.max(INIT_MS_MIN, saved.limits.initMs));
    const limits: Limits = { ...DEFAULT_LIMITS, ...(initMs !== undefined ? { initMs } : {}), ...this.o.limits };
    const id = saved.setup.id;
    const baseRev = saved.rev;
    const entry: Entry = {
      baseRev,
      actor: new ServerActor<SavedServer>({
        setup: saved,
        adding,
        clock: this.o.clock,
        limits,
        fingerprint: r => setupFingerprint(r.setup),
        open: (events, r) => {
          if (this.o.connect) return this.o.connect(r.setup, events);
          const setup = r.setup;
          const transport = setup.kind === 'local' ? new ProcessTransport(this.o.processes, processSetupOf(setup)) : new RemoteTransport(remoteTargetOf(setup), this.o.fetchFor(setup.address ?? ''));
          return openSession(transport, events, { initMs: limits.initMs });
        },
        // Fenced in the store's own transaction: same incarnation, a higher revision.
        save: async (r, n) => {
          if (!(await saveServer(this.o.store, { ...r, rev: baseRev + n }))) throw new Error('A newer record is saved.');
        },
        cleanup: async (before, after) => {
          for (const ref of secretRefs(before.setup).filter(x => !secretRefs(after.setup).includes(x))) await this.o.secrets.delete(ref);
        },
        register: r => this.register(r),
        forget: r => this.forget(r),
        onChange: view => this.changed(id, entry, view)
      })
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** The add's own effects, owned by the actor: the address (the exe's dialog), then the first record,
      written only where nothing is saved. An address the exe gives that another server holds is never
      removed here: it's that server's. */
  private async register(r: SavedServer): Promise<SavedServer> {
    let setup = r.setup;
    if (setup.kind === 'remote') {
      const address = await this.o.addresses.add({ url: setup.url, label: setup.label });
      const other = this.sharing(setup.id, s => s.kind === 'remote' && s.address === address.id);
      if (other) throw new Error(`Another server, ${other.label}, already uses this address. Familiar keeps one server per address.`);
      setup = { ...setup, address: address.id };
    }
    const added = { ...r, setup };
    if (!(await addServer(this.o.store, added))) throw new Error('A server with this id is already saved.');
    return added;
  }

  /** What removing a server removes, in an order a retry can repeat. The record is deleted only if it's
      still this incarnation's. */
  private async forget(r: SavedServer): Promise<void> {
    const setup = r.setup;
    if (setup.kind === 'local') {
      await this.o.processes.forget(setup.id);
      for (const ref of secretRefs(setup)) await this.o.secrets.delete(ref);
    } else if (setup.address) {
      await this.o.addresses.remove(setup.address);
    }
    await deleteServer(this.o.store, setup.id, r.incarnation);
  }

  /** A changed tool list is written as a change no one waits for. What the person reviewed is kept, so a
      changed tool shows as changed. A server removed, or whose add failed, leaves the client. */
  private changed(id: string, e: Entry, view: ServerView): void {
    if (view.phase === 'removed') {
      if (this.entries.get(id) === e) this.entries.delete(id);
    } else if (view.phase === 'ready') {
      const before = new Map(e.actor.pendingSetup.tools.map(t => [t.name, t]));
      const tools: SavedTool[] = view.tools.map(t => {
        const reviewed = before.get(t.name)?.reviewed;
        return { name: t.name, fingerprint: t.fingerprint, ...(reviewed ? { reviewed } : {}) };
      });
      if (JSON.stringify(tools) !== JSON.stringify(e.actor.pendingSetup.tools)) e.actor.touch(r => ({ ...r, tools }));
    }
    this.o.onChange?.(id);
  }
}
