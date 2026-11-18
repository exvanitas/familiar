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
import { addressIdentity, modelName, Owner, type Outcome } from './owner.ts';
import { mutant } from '../mutations.ts';
import type { PathRules } from './native-rules.ts';
import type { Draft } from './paste.ts';
import type { ProcessPort } from './process.ts';
import { ServerRuntime, type Phase } from './runtime.ts';
import { fresh, type SavedTool, type ServerLimits } from './saved.ts';
import { choiceKey, serverTool, toolChanges, toolPolicies, type ServerTool, type ToolChanges, type ToolChoice } from './server-tools.ts';
import type { GatePolicy, ToolPolicy } from '../journal/gate.ts';

/** The server id built-in tools' choices are kept under: no saved server can have it (ids are non-empty). */
export const BUILT_IN = '';
import { secretRefs, setupFingerprint, setupProblems, type ServerSetup } from './setup.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';
import { unpinned, type Unpinned } from './unpinned.ts';
import type { LinkLimits, NetPort } from './wire/link.ts';

/** Saved addresses: the exe's `address_add` (which asks the person), `address_remove` (which deletes
    the address's key) and `address_list` (for the start-time sweep of addresses no record owns). */
export interface AddressPort {
  add(spec: { url: string; label: string }): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  list?(): Promise<readonly { id: string; kind: string; url: string }[]>;
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
}

export interface ServerStatus {
  readonly id: string;
  readonly label: string;
  /** The frozen key models see before `__`. */
  readonly key: string;
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
  | { readonly ok: true; readonly tools: readonly TestedTool[]; readonly changes: ToolChanges; readonly unpinned?: Unpinned; readonly notOffered?: readonly { readonly name: string; readonly reason: string }[] }
  | { readonly ok: false; readonly failure: Failure };

export class McpClient {
  readonly owner: Owner;
  private readonly runtimes = new Map<string, ServerRuntime>();
  /** Revokes that hold at once, whatever the owner is doing: "always" back to ask, or anything to never. */
  private readonly overlay = new Map<string, 'ask' | 'never'>();
  private readonly o: McpClientOptions;

  private constructor(options: McpClientOptions, owner: Owner) {
    this.o = options;
    this.owner = owner;
    owner.onChange(() => this.sync());
    this.sync();
  }

  /** Loads the owner's record. Nothing starts until `startEnabled`; `repair` first, in a fresh exe. */
  static async open(options: McpClientOptions): Promise<McpClient> {
    const owner = await Owner.open({ store: options.store, forget: id => options.processes.forget(id), addresses: options.addresses, secrets: options.secrets, now: () => options.clock.now() });
    return new McpClient(options, owner);
  }

  /** A runtime for every saved server; a removed one's goes. */
  private sync(): void {
    const ids = new Set(this.owner.servers().map(s => s.setup.id));
    for (const id of ids) {
      if (this.runtimes.has(id)) continue;
      const rt: ServerRuntime = new ServerRuntime(
        id,
        this.owner,
        { processes: this.o.processes, net: this.o.net, clock: this.o.clock, ...(this.o.limits ? { limits: this.o.limits } : {}) },
        () => this.o.onChange?.(id),
        tools => void this.seen(id, tools)
      );
      this.runtimes.set(id, rt);
    }
    for (const id of [...this.runtimes.keys()]) if (!ids.has(id)) this.runtimes.delete(id);
  }

  /** Repair, in a fresh exe only (5.3): the one mark finished or rolled back, tombstones retried, orphan
      addresses removed. */
  repair(): Promise<Outcome> {
    return this.owner.repair();
  }

  /** Starting with the app: every enabled server starts, one admitted start at a time. */
  async startEnabled(): Promise<void> {
    for (const s of this.owner.servers()) if (s.enabled && !s.removing) await this.runtimes.get(s.setup.id)?.start();
  }

  list(): ServerStatus[] {
    return this.owner.servers().filter(s => !s.removing).flatMap(s => {
      const st = this.get(s.setup.id);
      return st ? [st] : [];
    });
  }

  get(id: string): ServerStatus | undefined {
    const s = this.owner.server(id);
    const rt = this.runtimes.get(id);
    if (!s || s.removing || !rt) return undefined;
    const flag = s.setup.kind === 'local' ? unpinned(s.setup.program, s.setup.args) : undefined;
    return { id, label: s.setup.label, key: s.key, kind: s.setup.kind, enabled: s.enabled, phase: rt.phase, ...(rt.failure ? { failure: rt.failure } : {}), ...(flag ? { unpinned: flag } : {}), tools: s.tools };
  }

  /** Adds a draft as a server, stopped and not yet enabled. Returns the refs Settings must store its
      secret values under; the values never pass through here. */
  async add(draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ id: string; secretRefs: string[] }> {
    const problems = [...draft.problems, ...setupProblems(draft.setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    const r = await this.owner.add(draft.setup);
    if (!r.ok) throw new Error(r.words);
    return { id: draft.setup.id, secretRefs: secretRefs(this.owner.server(draft.setup.id)!.setup) };
  }

  /** Changes a stopped server's setup, keeping its id. A remote server's address can't change here. */
  async edit(id: string, draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ secretRefs: string[] }> {
    const cur = this.owner.server(id);
    if (!cur) throw new Error('No server is saved with that id.');
    const before = cur.setup;
    let setup: ServerSetup = { ...draft.setup, id } as ServerSetup;
    const problems = [...draft.problems, ...setupProblems(setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    if (setup.kind !== before.kind) throw new Error("A server can't change between local and remote. Add it again instead.");
    if (setup.kind === 'remote' && before.kind === 'remote') {
      if (!sameAddress(setup.url, before.url)) throw new Error('A new address needs its own approval and key. Remove the server and add it again.');
      setup = { ...setup, url: before.url, ...(before.address ? { address: before.address } : {}) };
    }
    const phase = this.runtimes.get(id)?.phase;
    const r = await this.owner.edit(id, setup, phase === 'stopped' || phase === 'failed');
    if (!r.ok) throw new Error(r.words);
    return { secretRefs: secretRefs(setup) };
  }

  start(id: string): Promise<Reply> {
    const rt = this.runtimes.get(id);
    return rt ? rt.start() : Promise.resolve({ kind: 'refused', words: 'No server is saved with that id.' });
  }
  stop(id: string): Promise<Reply> {
    const rt = this.runtimes.get(id);
    return rt ? rt.stop() : Promise.resolve({ kind: 'stopped' });
  }

  /** Stops it (awaited), then removes its approval or address, its secrets, its record and choices. */
  async remove(id: string): Promise<Reply> {
    const rt = this.runtimes.get(id);
    const r = await this.owner.remove(id, async () => void (await rt?.stop()));
    if (!r.ok) return { kind: 'failed', failure: { kind: 'failed', words: r.words } };
    this.sync();
    return { kind: 'removed' };
  }

  /** Finishes a change whose cleanup didn't. */
  retry(): Promise<Outcome> {
    return this.owner.retry();
  }

  /** Test runs only while the server is Stopped: an admitted start, the tool list, then a stop. */
  async test(id: string): Promise<TestReport> {
    const rt = this.runtimes.get(id);
    const s = this.owner.server(id);
    if (!rt || !s) return { ok: false, failure: { kind: 'failed', words: 'No server is saved with that id.' } };
    if (rt.phase !== 'stopped' && rt.phase !== 'failed') return { ok: false, failure: { kind: 'busy', words: 'Stop the server to test it. Test never disturbs a running server.' } };
    const r = await rt.start();
    if (r.kind !== 'ready') {
      rt.settle();
      const failure: Failure = r.kind === 'failed' ? r.failure : r.kind === 'refused' ? { kind: 'failed', words: r.words } : { kind: 'failed', words: 'The server was stopped before it was ready.' };
      return { ok: false, failure };
    }
    const saved = new Map(s.tools.map(t => [t.name, t]));
    const named = rt.tools.map(t => ({ t, n: modelName(s.key, t.name) }));
    const tools = named.filter(x => 'name' in x.n).map(({ t }) => ({ ...t, fresh: fresh(saved.get(t.name), t.fingerprint) }));
    const notOffered = [...rt.notOffered, ...named.flatMap(({ t, n }) => ('reason' in n ? [{ name: t.name, reason: n.reason }] : []))];
    await rt.stop();
    const flag = s.setup.kind === 'local' ? unpinned(s.setup.program, s.setup.args) : undefined;
    const reviewed = s.tools.flatMap(t => (t.reviewed ? [{ name: t.name, fingerprint: t.reviewed }] : []));
    return { ok: true, tools, changes: toolChanges(reviewed, tools), ...(flag ? { unpinned: flag } : {}), ...(notOffered.length ? { notOffered } : {}) };
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

  /** The person's choice for one tool: "always" for exactly this tool and setup, "ask", or "never". */
  async choose(serverId: string, tool: string, choice: ToolChoice | undefined): Promise<void> {
    const r = await this.owner.choose(serverId, tool, choice);
    if (!r.ok) throw new Error(r.words);
  }

  /**
   * The gate's policy for a turn (journal's `policy`): each server wrapper's from its own identity, and each
   * built-in's from the owner's choice under the built-in id, the revoke overlay on top. Read at each call.
   */
  policy(wrappers: readonly ServerTool[]): GatePolicy {
    const choices = this.owner.choices();
    const perTool: Record<string, ToolPolicy> = { ...toolPolicies(wrappers, choices) };
    for (const [key, c] of Object.entries(choices)) {
      const [server, tool] = JSON.parse(key) as [string, string];
      if (server === BUILT_IN) perTool[tool] = c.policy;
    }
    for (const w of wrappers) this.tighten(perTool, w.name, choiceKey(w.server.id, w.serverName));
    for (const [key] of this.overlay) {
      const [server, tool] = JSON.parse(key) as [string, string];
      if (server === BUILT_IN) this.tighten(perTool, tool, key);
    }
    return { perTool };
  }

  private tighten(perTool: Record<string, ToolPolicy>, name: string, key: string): void {
    const o = this.overlay.get(key);
    if (o === 'never') perTool[name] = 'deny';
    else if (o === 'ask' && perTool[name] === 'allow') delete perTool[name];
  }

  /** The person's choices, from the owner. */
  choices(): Readonly<Record<string, ToolChoice>> {
    return this.owner.choices();
  }

  /** A tightening holds at once, in memory, whatever the owner is doing; its durable write follows. */
  revoke(serverId: string, tool: string, to: 'ask' | 'never'): void {
    const key = choiceKey(serverId, tool);
    if (this.overlay.get(key) !== 'never') this.overlay.set(key, to);
    const cur = this.owner.choices()[key];
    void this.owner.choose(serverId, tool, to === 'never' ? { policy: 'deny', fingerprint: cur?.fingerprint ?? '', setupFingerprint: cur?.setupFingerprint ?? '' } : undefined).catch(() => undefined);
  }

  /** The tools a turn may offer the model: those of every Ready server, named `<key>__<tool>`, bound to
      the run they came from. A tool whose name can't be offered is left out (Test says why). */
  tools(): ServerTool[] {
    const out: ServerTool[] = [];
    for (const s of this.owner.servers()) {
      const rt = this.runtimes.get(s.setup.id);
      if (!rt || rt.phase !== 'ready' || !rt.run || s.removing) continue;
      const server = { id: s.setup.id, label: s.setup.label };
      const saved = new Map(s.tools.map(t => [t.name, t]));
      for (const listed of rt.tools) {
        const n = modelName(s.key, listed.name);
        if (!('name' in n)) continue;
        out.push(serverTool({
          server,
          listed,
          modelName: n.name,
          setupFingerprint: setupFingerprint(s.setup),
          fresh: fresh(saved.get(listed.name), listed.fingerprint),
          facts: args => this.facts(server.id, listed.name, args),
          send: (decision, signal, raw) => this.send(decision, signal, raw)
        }));
      }
    }
    return out;
  }

  /** What a card for this call shows, read from the server's run now. */
  facts(serverId: string, tool: string, args: unknown): CardFacts | undefined {
    const rt = this.runtimes.get(serverId);
    const run = rt?.run;
    const listed = rt?.tools.find(t => t.name === tool);
    const canon = canonicalArguments(args);
    if (!rt || !run || !listed || !canon) return undefined;
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
  send(decision: ToolDecision, signal: AbortSignal, raw?: unknown): Promise<CallOutcome> {
    const refuse = (reason: Extract<CallOutcome, { kind: 'error' }>['reason'], words: string): Promise<CallOutcome> => Promise.resolve({ kind: 'error', reason, words });
    if (!usable(decision)) return refuse('changed', 'That call had no consent of its own, or it was used already, so it was not sent.');
    if (signal.aborted) return Promise.resolve({ kind: 'stopped' });
    const rt = this.runtimes.get(decision.server);
    const record = this.owner.server(decision.server);
    const run = rt?.run;
    if (!rt || !run || !record) return refuse('not-running', 'The server is not running.');
    if (run.id !== decision.run || run.launch !== decision.launch) return refuse('changed', 'The server restarted since this call was allowed, so it was not sent.');
    if (!rt.link.offers(run.id, decision.tool, decision.fingerprint) && !(rt.link.offers(run.id, decision.tool, rt.link.current?.tools.find((t) => t.name === decision.tool)?.fingerprint ?? '') && mutant('ignore-fingerprint'))) return refuse('changed', 'The tool changed since it was allowed, so it was not sent. It will ask again.');
    const key = choiceKey(decision.server, decision.tool);
    const choice = this.owner.choices()[key];
    const overlay = this.overlay.get(key);
    if (choice?.policy === 'deny' || overlay === 'never') return refuse('changed', `You chose never to run ${decision.tool} on this server, so Familiar didn't send the call.`);
    if (decision.by === 'always' && (decision.outside || overlay === 'ask' || !(choice?.policy === 'allow' && choice.fingerprint === decision.fingerprint && choice.setupFingerprint === decision.launch))) {
      return refuse('changed', `Your "always" for ${decision.tool} on this server no longer stands, so Familiar didn't send the call. It will ask.`);
    }
    const ms = Math.min(CALL_MS_MAX, Math.max(CALL_MS_MIN, record.limits.callMs ?? CALL_MS));
    // Named mutations: queue behind a live exchange, a gap between the checks and the handoff, or a body
    // from the model's own arguments instead of the decision's.
    const hand = (): Promise<CallOutcome> => {
      const canonical = raw !== undefined && mutant('body-from-model-args') ? (canonicalArguments(raw)?.canonical ?? decision.canonical) : decision.canonical;
      markUsed(decision);
      const sent = rt.link.handoff(decision.tool, canonical, signal, ms);
      return sent ?? refuse('busy', 'The server is busy with another request. Try again in a moment.');
    };
    if (rt.link.busy && mutant('queue-call')) return rt.link.drained().then(hand);
    if (rt.link.busy) return refuse('busy', 'The server is busy with another request. Try again in a moment.');
    if (mutant('await-before-handoff')) return Promise.resolve().then(hand);
    return hand();
  }

  private async update(id: string, change: (r: OwnedServerRecord) => OwnedServerRecord): Promise<void> {
    const r = await this.owner.update(id, s => ({ ...s, ...change(s) }));
    if (!r.ok) throw new Error(r.words);
  }

  /** A run's tool list, saved as the tools last seen; what the person reviewed is kept. */
  private async seen(id: string, now: readonly ListedTool[]): Promise<void> {
    const s = this.owner.server(id);
    if (!s) return;
    const before = new Map(s.tools.map(t => [t.name, t]));
    const tools: SavedTool[] = now.map(t => {
      const reviewed = before.get(t.name)?.reviewed;
      return { name: t.name, fingerprint: t.fingerprint, ...(reviewed ? { reviewed } : {}) };
    });
    await this.owner.seen(id, tools);
  }
}

type OwnedServerRecord = import('./owner.ts').OwnedServer;

/** An address as compared for an edit: the same exe identity. */
function sameAddress(a: string, b: string): boolean {
  return addressIdentity(a) !== undefined && addressIdentity(a) === addressIdentity(b);
}
