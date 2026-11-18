// The MCP client: every saved server with its runtime, and what the app does with them. Add, Test, start,
// stop, remove, the tools for a turn, reviewing tools, and `send`, the only way a call reaches a server.
// Only the person adds, changes or removes a server, in Settings; nothing here is reachable from a tool or
// from anything a model reads.
//
// Secrets: Settings puts a draft's secret values straight into Credential Manager (`secret_set` is a
// Settings command). Core keeps only their names, and deletes them when the server is removed.

import type { JournalClock } from '../journal/journal.ts';
import type { SettingsStore } from '../settings/store.ts';
import { canonicalArguments, markUsed, usable, type CardFacts, type ToolDecision } from './decision.ts';
import type { PathRules } from './native-rules.ts';
import type { Draft } from './paste.ts';
import type { ProcessPort } from './process.ts';
import { ServerRuntime, type Phase } from './runtime.ts';
import { fresh, loadServers, type SavedServer, type SavedTool, type ServerLimits } from './saved.ts';
import { choiceKey, modelNames, serverTool, toolChanges, type ServerTool, type ToolChanges, type ToolChoice } from './server-tools.ts';
import { secretRefs, setupFingerprint, setupProblems, type ServerSetup } from './setup.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';
import { unpinned, type Unpinned } from './unpinned.ts';
import type { LinkLimits, NetPort } from './wire/link.ts';

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

/** A call's time limit when the server's record names none, and its bounds. */
export const CALL_MS = 60_000;
export const CALL_MS_MIN = 1_000;
export const CALL_MS_MAX = 15 * 60_000;

export interface McpClientOptions {
  readonly store: SettingsStore;
  readonly processes: ProcessPort;
  /** The exe's net_fetch, net_read and net_cancel. */
  readonly net: NetPort;
  readonly addresses: AddressPort;
  readonly secrets: SecretPort;
  readonly clock: Pick<JournalClock, 'now' | 'setTimer'>;
  /** Overrides for every server's link limits, for tests. */
  readonly limits?: Partial<LinkLimits>;
  /** How setups' paths are checked: Windows' rules unless a test says otherwise. */
  readonly paths?: PathRules;
  /** Hears that a server's state, tools or failure changed. */
  readonly onChange?: (id: string) => void;
  /** A new incarnation for an added server. Random by default; tests pass their own. */
  readonly newIncarnation?: () => string;
  /** The person's choices, keyed by `choiceKey` (step 8 keeps them). `send` reads them, with the revoke
      overlay on top, in its synchronous check. */
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

const randomIncarnation = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

/** An address as compared for sharing: one saved address can't serve two servers, since removing either
    would remove the other's address and key. (Phase 4 replaces this with the exe's own identity.) */
function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch {
    return a === b;
  }
}

export class McpClient {
  private readonly entries = new Map<string, ServerRuntime>();
  /** Revokes that hold at once, whatever the store is doing: "never" for a tool, or "always" withdrawn. */
  private readonly overlay = new Map<string, 'ask' | 'never'>();
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

  /** Starting with the app: every enabled server starts, one admitted start at a time. */
  startEnabled(): Promise<void> {
    return (async () => {
      for (const e of [...this.entries.values()]) if (e.setup.enabled) await e.start();
    })();
  }

  list(): ServerStatus[] {
    return [...this.entries.values()].filter(e => e.phase !== 'adding' && e.phase !== 'removed').map(e => this.status(e));
  }

  get(id: string): ServerStatus | undefined {
    const e = this.entries.get(id);
    return e && e.phase !== 'adding' && e.phase !== 'removed' ? this.status(e) : undefined;
  }

  /**
   * Adds a draft as a server, stopped and not yet enabled. Its entry is held from the first moment, with
   * its address, so a second add of the same id or address is refused while this one runs, the exe's
   * dialog included. Returns the refs Settings must store the draft's secret values under.
   */
  async add(draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ id: string; secretRefs: string[] }> {
    const problems = [...draft.problems, ...setupProblems(draft.setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    const setup = draft.setup;
    const held = this.entries.get(setup.id);
    if (held && held.phase !== 'removed') throw new Error('A server with this id is already saved.');
    if (setup.kind === 'remote') {
      const other = this.sharing(setup.id, s => s.kind === 'remote' && sameAddress(s.url, setup.url));
      if (other) throw new Error(`Another server, ${other.label}, already uses this address. Familiar keeps one server per address.`);
    }
    const record: SavedServer = { setup, enabled: false, limits: {}, tools: [], incarnation: (this.o.newIncarnation ?? randomIncarnation)(), rev: 0 };
    const entry = this.track(record, true);
    const r = await entry.register(address => this.sharing(setup.id, s => s.kind === 'remote' && s.address === address)?.label);
    if (r.kind !== 'added') {
      if (this.entries.get(setup.id) === entry) this.entries.delete(setup.id);
      throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server could not be added.');
    }
    return { id: setup.id, secretRefs: secretRefs(entry.setup.setup) };
  }

  /** Changes a stopped server's setup, keeping its id. A remote server's address can't change here. */
  async edit(id: string, draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ secretRefs: string[] }> {
    const e = this.entry(id);
    const before = e.setup.setup;
    let setup: ServerSetup = { ...draft.setup, id } as ServerSetup;
    const problems = [...draft.problems, ...setupProblems(setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    if (setup.kind !== before.kind) throw new Error("A server can't change between local and remote. Add it again instead.");
    if (setup.kind === 'remote' && before.kind === 'remote') {
      if (!sameAddress(setup.url, before.url)) throw new Error('A new address needs its own approval and key. Remove the server and add it again.');
      setup = { ...setup, url: before.url, ...(before.address ? { address: before.address } : {}) };
    }
    const next = setup;
    const r = await e.edit(rec => ({ ...rec, setup: next }));
    if (r.kind !== 'edited') throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server was removed.');
    return { secretRefs: secretRefs(next) };
  }

  start(id: string): Promise<Reply> { return this.entry(id).start(); }
  stop(id: string): Promise<Reply> { return this.entry(id).stop(); }

  /** Stops it (awaited), then removes its approval or address, its secrets and its saved setup. */
  async remove(id: string): Promise<Reply> {
    const e = this.entry(id);
    const r = await e.remove();
    if (r.kind === 'removed' && this.entries.get(id) === e) this.entries.delete(id);
    return r;
  }

  /** Test runs only while the server is Stopped: an admitted start, the tool list, then a stop. */
  async test(id: string): Promise<TestReport> {
    const e = this.entry(id);
    if (e.phase !== 'stopped' && e.phase !== 'failed') return { ok: false, failure: { kind: 'busy', words: 'Stop the server to test it. Test never disturbs a running server.' } };
    const r = await e.start();
    if (r.kind !== 'ready') {
      e.settle();
      const failure: Failure = r.kind === 'failed' ? r.failure : r.kind === 'refused' ? { kind: 'failed', words: r.words } : { kind: 'failed', words: 'The server was stopped before it was ready.' };
      return { ok: false, failure };
    }
    const saved = new Map(e.setup.tools.map(t => [t.name, t]));
    const tools = e.tools.map(t => ({ ...t, fresh: fresh(saved.get(t.name), t.fingerprint) }));
    await e.stop();
    const setup = e.setup.setup;
    const flag = setup.kind === 'local' ? unpinned(setup.program, setup.args) : undefined;
    const reviewed = e.setup.tools.flatMap(t => (t.reviewed ? [{ name: t.name, fingerprint: t.reviewed }] : []));
    return { ok: true, tools, changes: toolChanges(reviewed, tools), ...(flag ? { unpinned: flag } : {}) };
  }

  /** The person has seen these tools' names and descriptions as they are now. */
  markReviewed(id: string, names: readonly string[]): Promise<void> {
    return this.update(id, r => ({ ...r, tools: r.tools.map(t => (names.includes(t.name) ? { ...t, reviewed: t.fingerprint } : t)) }));
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.update(id, r => ({ ...r, enabled }));
  }

  /** A call's time limit applies from the next call; the handshake's from the next start. */
  setLimits(id: string, limits: ServerLimits): Promise<void> {
    return this.update(id, r => ({ ...r, limits }));
  }

  /** A tightening holds at once, in memory, whatever the owner is doing: "always" back to ask, or anything
      to never. Saving it is the caller's (Settings), after. */
  revoke(serverId: string, tool: string, to: 'ask' | 'never'): void {
    const key = choiceKey(serverId, tool);
    if (this.overlay.get(key) === 'never') return;
    this.overlay.set(key, to);
  }

  /** The tools a turn may offer the model: those of every Ready server, bound to the run they came from. */
  tools(): ServerTool[] {
    const ready = [...this.entries.values()].flatMap(e => (e.phase === 'ready' && e.run ? [e] : []));
    const names = modelNames(ready.map(e => ({ id: e.setup.setup.id, label: e.setup.setup.label, tools: e.tools })));
    const out: ServerTool[] = [];
    const taken = new Set<string>();
    for (const e of ready) {
      const setup = e.setup.setup;
      const server = { id: setup.id, label: setup.label };
      const saved = new Map(e.setup.tools.map(t => [t.name, t]));
      for (const listed of e.tools) {
        const modelName = names.get(server.id)?.get(listed.name);
        if (!modelName || taken.has(modelName.toLowerCase())) continue;
        taken.add(modelName.toLowerCase());
        out.push(serverTool({
          server,
          listed,
          modelName,
          setupFingerprint: setupFingerprint(setup),
          fresh: fresh(saved.get(listed.name), listed.fingerprint),
          facts: args => this.facts(server.id, listed.name, args),
          send: (decision, signal) => this.send(decision, signal)
        }));
      }
    }
    return out;
  }

  /** What a card for this call shows, read from the server's run now. */
  facts(serverId: string, tool: string, args: unknown): CardFacts | undefined {
    const e = this.entries.get(serverId);
    const run = e?.run;
    const listed = e?.tools.find(t => t.name === tool);
    const canon = canonicalArguments(args);
    if (!e || !run || !listed || !canon) return undefined;
    return { server: serverId, tool, run: run.id, launch: run.launch, fingerprint: listed.fingerprint, ...canon };
  }

  /**
   * The only way a call reaches a server (3.6). In one synchronous step, with no await: it refuses unless
   * the decision is genuine, unused and its signal not aborted; its server's run is Ready, the run and
   * launch it was minted for; the catalog is fresh and offers the tool with its fingerprint; the person's
   * choice, with the revoke overlay, still allows it ("always" still "always" for these fingerprints and no
   * outside content; a Yes not turned to "never"); and the exchange slot is Idle. Then it marks the decision
   * used, builds the body from the decision alone, and hands it off.
   */
  send(decision: ToolDecision, signal: AbortSignal): Promise<CallOutcome> {
    const refuse = (reason: Extract<CallOutcome, { kind: 'error' }>['reason'], words: string): Promise<CallOutcome> => Promise.resolve({ kind: 'error', reason, words });
    if (!usable(decision)) return refuse('changed', 'That call had no consent of its own, or it was used already, so it was not sent.');
    if (signal.aborted) return Promise.resolve({ kind: 'stopped' });
    const e = this.entries.get(decision.server);
    const run = e?.run;
    if (!e || !run) return refuse('not-running', 'The server is not running.');
    if (run.id !== decision.run || run.launch !== decision.launch) return refuse('changed', 'The server restarted since this call was allowed, so it was not sent.');
    if (!e.link.offers(run.id, decision.tool, decision.fingerprint)) return refuse('changed', 'The tool changed since it was allowed, so it was not sent. It will ask again.');
    const key = choiceKey(decision.server, decision.tool);
    const choice = this.o.choices?.()[key];
    const overlay = this.overlay.get(key);
    if (choice?.policy === 'deny' || overlay === 'never') return refuse('changed', `You chose never to run ${decision.tool} on this server, so Familiar didn't send the call.`);
    if (decision.by === 'always' && (decision.outside || overlay === 'ask' || !(choice?.policy === 'allow' && choice.fingerprint === decision.fingerprint && choice.setupFingerprint === decision.launch))) {
      return refuse('changed', `Your "always" for ${decision.tool} on this server no longer stands, so Familiar didn't send the call. It will ask.`);
    }
    if (e.link.busy) return refuse('busy', 'The server is busy with another request. Try again in a moment.');
    const ms = Math.min(CALL_MS_MAX, Math.max(CALL_MS_MIN, e.setup.limits.callMs ?? CALL_MS));
    markUsed(decision);
    const sent = e.link.handoff(decision.tool, decision.canonical, signal, ms);
    return sent ?? refuse('busy', 'The server is busy with another request. Try again in a moment.');
  }

  /** The record as last committed. */
  record(id: string): SavedServer | undefined {
    const e = this.entries.get(id);
    return e && e.phase !== 'adding' && e.phase !== 'removed' ? e.setup : undefined;
  }

  private async update(id: string, change: (r: SavedServer) => SavedServer): Promise<void> {
    const r = await this.entry(id).update(change);
    if (r.kind !== 'edited') throw new Error(r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : 'The server was removed.');
  }

  /** Another entry whose setup matches. */
  private sharing(self: string, match: (s: ServerSetup) => boolean): ServerSetup | undefined {
    for (const [id, e] of this.entries) if (id !== self && e.phase !== 'removed' && match(e.setup.setup)) return e.setup.setup;
    return undefined;
  }

  private entry(id: string): ServerRuntime {
    const e = this.entries.get(id);
    if (!e || e.phase === 'adding' || e.phase === 'removed') throw new Error('No server is saved with that id.');
    return e;
  }

  private status(e: ServerRuntime): ServerStatus {
    const r = e.setup;
    const s = r.setup;
    const flag = s.kind === 'local' ? unpinned(s.program, s.args) : undefined;
    return { id: s.id, label: s.label, kind: s.kind, enabled: r.enabled, phase: e.phase, ...(e.failure ? { failure: e.failure } : {}), ...(flag ? { unpinned: flag } : {}), tools: r.tools };
  }

  private track(saved: SavedServer, adding: boolean): ServerRuntime {
    const id = saved.setup.id;
    const entry: ServerRuntime = new ServerRuntime(
      saved,
      adding,
      { store: this.o.store, processes: this.o.processes, net: this.o.net, addresses: this.o.addresses, secrets: this.o.secrets, clock: this.o.clock, ...(this.o.limits ? { limits: this.o.limits } : {}) },
      () => this.o.onChange?.(id),
      tools => this.listed(entry, tools)
    );
    this.entries.set(id, entry);
    return entry;
  }

  /** A run's tool list is saved as the tools last seen; what the person reviewed is kept. */
  private listed(e: ServerRuntime, now: readonly ListedTool[]): void {
    const before = new Map(e.setup.tools.map(t => [t.name, t]));
    const tools: SavedTool[] = now.map(t => {
      const reviewed = before.get(t.name)?.reviewed;
      return { name: t.name, fingerprint: t.fingerprint, ...(reviewed ? { reviewed } : {}) };
    });
    if (JSON.stringify(tools) !== JSON.stringify(e.setup.tools)) e.touch(r => ({ ...r, tools }));
  }
}
