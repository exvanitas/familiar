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
import { addressIdentity, BUILT_IN, modelName, Owner, type Outcome } from './owner.ts';
export { BUILT_IN };
import { mutant } from '../mutations.ts';
import type { PathRules } from './native-rules.ts';
import type { Draft } from './paste.ts';
import type { ProcessPort } from './process.ts';
import { ServerRuntime, type Phase } from './runtime.ts';
import { fresh, type SavedTool, type ServerLimits } from './saved.ts';
import { choiceKey, ownHolds, parseChoiceKey, serverTool, toolChanges, toolPolicies, type ServerTool, type ToolChanges, type ToolChoice } from './server-tools.ts';
import type { GatePolicy, GateVerdict } from '../journal/gate.ts';


/** A revoke whose durable write didn't land. */
export const REVOKE_NOT_SAVED = 'Revoked for now, but not saved: it comes back when Familiar restarts. Try again.';

/** The built-in tool a choice key names, or undefined for a server's tool or a key that names nothing. */
function builtInTool(key: string): string | undefined {
  const k = parseChoiceKey(key);
  return k && k[0] === BUILT_IN ? k[1] : undefined;
}
import { secretRefs, setupFingerprint, setupProblems, type ServerSetup } from './setup.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';
import { unpinned, type Unpinned } from './unpinned.ts';
import type { LinkLimits, NetPort } from './wire/link.ts';
import type { LcEvent, LcState } from './wire/lifecycle.ts';

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

/** How many recent Test reports Mark reviewed can still name. */
const REPORTS_KEPT = 16;

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
  /** The test build's conformance record: each server's lifecycle events and the states they gave. */
  readonly transition?: (id: string, event: LcEvent, state: LcState, slot: { readonly busy: boolean; readonly quiet: boolean }) => void;
  /** The test build's record of each exchange admitted and ended, per server (the conformance check). */
  readonly exchange?: (id: string, e: { readonly t: 'admit' | 'ended'; readonly n: number; readonly run: string; readonly kind: string; readonly end?: string }) => void;
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
  /** Set while the run's latest tool list couldn't be saved (tried twice): the saved list is older. The
      machine decides it (noteOf, 6b.13). */
  readonly unsaved?: string;
}

export interface TestedTool extends ListedTool {
  /** New or changed since the person last reviewed it. */
  readonly fresh: boolean;
}

export type TestReport =
  | {
      readonly ok: true;
      /** Core's id for this report: Mark reviewed names it, and marks what this report showed. */
      readonly report: string;
      readonly tools: readonly TestedTool[];
      readonly changes: ToolChanges;
      readonly unpinned?: Unpinned;
      readonly notOffered?: readonly { readonly name: string; readonly reason: string }[];
    }
  | { readonly ok: false; readonly failure: Failure };

export class McpClient {
  readonly owner: Owner;
  private readonly runtimes = new Map<string, ServerRuntime>();
  /** Revokes that hold at once, whatever the owner is doing: "always" back to ask, or anything to never. */
  private readonly overlay = new Map<string, 'ask' | 'never'>();
  /** How many revokes each key has had, so a choice clears only the revokes made before it. */
  private readonly revokes = new Map<string, number>();
  /** What each recent Test report showed, by the report's id: its server, and each tool's fingerprint by
      name. Mark reviewed binds to one of them. The newest few are kept. */
  private readonly reports = new Map<string, { readonly server: string; readonly shown: ReadonlyMap<string, string>; readonly listing: number }>();
  /** Counts each server's listings (every run's, Test's included): a report is the newest while none came after it. */
  private readonly listings = new Map<string, number>();
  private readonly runListing = new Map<string, number>();
  private reportCount = 0;
  /**
   * "May run on its own" as one check at each call (5.6). Per server and tool, a counter bumped on every
   * publication in which the tool's fingerprint or setup differs from the previous one, or the tool is
   * absent. A grant holds only while the live fingerprint and setup are the grant's and the counter is the
   * one the grant recorded when it was given. Nothing else is tracked.
   */
  private readonly changeCount = new Map<string, number>();
  /** Each server's last publication, tool by tool (`fingerprint|launch`). */
  private readonly lastPublished = new Map<string, Map<string, string>>();
  /** Each grant's fingerprint, setup and counter, recorded as it was given (or as it loaded). */
  private readonly grants = new Map<string, { readonly fingerprint: string; readonly setup: string; readonly counter: number }>();
  /** Grants that no longer hold, still to be cleared from the record: cleanup only, kept until it lands. */
  private readonly clears = new Map<string, { readonly server: string; readonly tool: string; readonly fingerprint: string }>();
  /** Catalog writes under way: a durable clear waits for them, never taking the owner first. */
  private seeing = 0;
  private readonly o: McpClientOptions;

  private constructor(options: McpClientOptions, owner: Owner) {
    this.o = options;
    this.owner = owner;
    owner.onChange(() => {
      this.sync();
      this.loadGrants();
      this.clearGrants();
    });
    this.sync();
    this.loadGrants();
  }

  /** A grant in the record with no counter yet (loaded from disk, or saved there directly) starts at the
      current counter: from now on, any change asks again. */
  private loadGrants(): void {
    for (const [key, c] of Object.entries(this.owner.choices())) {
      if (c.policy !== 'own') continue;
      const g = this.grants.get(key);
      if (!g || g.fingerprint !== c.fingerprint || g.setup !== c.setupFingerprint) this.grants.set(key, { fingerprint: c.fingerprint, setup: c.setupFingerprint, counter: this.changeCount.get(key) ?? 0 });
    }
  }

  /** Whether "may run on its own" stands for this tool now, at this fingerprint and setup. */
  private ownNow(key: string, fingerprint: string, setup: string): boolean {
    const c = this.owner.choices()[key];
    if (!ownHolds(c, fingerprint, setup)) return false;
    // (Named mutations: the old "always" back, or a grant kept whatever the tool became; neither counts.)
    if (__FAMILIAR_MUTATIONS__ && (mutant('server-always') && c?.policy === 'allow' || mutant('own-ignores-fingerprint'))) return true;
    const g = this.grants.get(key);
    if (!g || g.fingerprint !== c!.fingerprint || g.setup !== c!.setupFingerprint) return false;
    return (this.changeCount.get(key) ?? 0) === g.counter || !!(__FAMILIAR_MUTATIONS__ && mutant('own-counter-ignored'));
  }

  /**
   * A run published its catalog: the counters move now, synchronously, before anything can read the new
   * catalog. The first publication a client sees for a server compares with the saved catalog.
   */
  private published(id: string, tools: readonly ListedTool[], launch: string): void {
    const prev = this.lastPublished.get(id) ?? new Map((this.owner.server(id)?.tools ?? []).map(t => [t.name, `${t.fingerprint}|${launch}`]));
    const now = new Map(tools.map(t => [t.name, `${t.fingerprint}|${launch}`]));
    for (const name of new Set([...prev.keys(), ...now.keys()])) {
      const was = prev.get(name);
      const is = now.get(name);
      if (was === is) continue;
      if (is === undefined && (__FAMILIAR_MUTATIONS__ && mutant('own-kept-on-absence'))) {
        // (The named mutation: an absent tool counts as still listed as it was.)
        now.set(name, was!);
        continue;
      }
      if (is !== undefined && was !== undefined && (__FAMILIAR_MUTATIONS__ && mutant('own-kept-on-skip'))) continue;
      const key = choiceKey(id, name);
      this.changeCount.set(key, (this.changeCount.get(key) ?? 0) + 1);
    }
    this.lastPublished.set(id, now);
    // Grants of this server that no longer hold: their durable clear is queued (cleanup only).
    const listed = new Map(tools.map(t => [t.name, t.fingerprint]));
    for (const [key, c] of Object.entries(this.owner.choices())) {
      const k = parseChoiceKey(key);
      if (!k || k[0] !== id || c.policy !== 'own') continue;
      const fp = listed.get(k[1]);
      if ((fp === undefined || !this.ownNow(key, fp, launch)) && !checkOnly()) this.clears.set(key, { server: id, tool: k[1], fingerprint: c.fingerprint });
    }
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
        (tools, current, run) => this.seen(id, tools, current, run),
        (tools, launch) => this.published(id, tools, launch),
        {
          ...(this.o.transition ? { transition: (event: LcEvent, state: LcState, slot: { readonly busy: boolean; readonly quiet: boolean }) => this.o.transition!(id, event, state, slot) } : {}),
          ...(this.o.exchange ? { exchange: (e: Parameters<NonNullable<McpClientOptions['exchange']>>[1]) => this.o.exchange!(id, e) } : {})
        }
      );
      this.runtimes.set(id, rt);
    }
    for (const id of [...this.runtimes.keys()]) if (!ids.has(id)) this.runtimes.delete(id);
  }

  /**
   * The durable clear of a grant that no longer holds: cleanup only, since the check at each call already
   * refuses it. Tried whenever the owner is free and no catalog write is under way (never before one), and
   * kept until its write lands; a write refused or lost is tried again at the next chance.
   */
  private clearGrants(): void {
    if (this.owner.busy || this.seeing > 0 || !this.clears.size) return;
    for (const [key, c] of this.clears) {
      const now = this.owner.choices()[key];
      if (now?.policy !== 'own' || now.fingerprint !== c.fingerprint) {
        this.clears.delete(key);
        continue;
      }
      if (__FAMILIAR_MUTATIONS__ && mutant('clear-dropped-on-error')) this.clears.delete(key);
      void this.owner.choose(c.server, c.tool, undefined).then(
        (r) => {
          if (r.ok) this.clears.delete(key);
        },
        () => {}
      );
      return;
    }
  }

  /** Repair, in a fresh exe only (5.3): the one mark finished or rolled back, tombstones retried, orphan
      addresses removed. */
  repair(): Promise<Outcome> {
    return this.owner.repair();
  }

  /** Starting with the app: every enabled server starts, one admitted start at a time. Each start reads
      the committed record again, enabled flag included, so one turned off meanwhile isn't started. */
  async startEnabled(): Promise<void> {
    for (const s of this.owner.servers()) if (s.enabled && !s.removing) await this.runtimes.get(s.setup.id)?.start({ auto: true });
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
    const unsaved = rt.note;
    return { id, label: s.setup.label, key: s.key, kind: s.setup.kind, enabled: s.enabled, phase: rt.phase, ...(rt.failure ? { failure: rt.failure } : {}), ...(flag ? { unpinned: flag } : {}), tools: s.tools, ...(unsaved ? { unsaved } : {}) };
  }

  /** Adds a draft as a server, stopped and not yet enabled. Returns the refs Settings must store its
      secret values under; the values never pass through here. */
  async add(draft: Pick<Draft, 'setup' | 'problems'>): Promise<{ id: string; secretRefs: string[] }> {
    // Core's own snapshot, taken before validation or any await; nothing after reads the caller's draft.
    const setup = JSON.parse(JSON.stringify(draft.setup)) as ServerSetup;
    const problems = [...draft.problems, ...setupProblems(setup, this.o.paths)];
    if (problems.length) throw new Error(problems[0]);
    const r = await this.owner.add(setup);
    if (!r.ok) throw new Error(r.words);
    // The saved record's refs (a remote one's include its address's key), by the snapshot's id.
    return { id: setup.id, secretRefs: secretRefs(this.owner.server(setup.id)!.setup) };
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
    // Test's own run, from its start to its own stop, is the machine's (5.4): its answer comes only once that
    // run has ended, and it never touches another run.
    const r = await rt.test();
    if (!r.ok) return { ok: false, failure: r.failure };
    const saved = new Map(s.tools.map(t => [t.name, t]));
    const named = r.tools.map(t => ({ t, n: modelName(s.key, t.name) }));
    const tools = named.filter(x => 'name' in x.n).map(({ t }) => ({ ...t, fresh: fresh(saved.get(t.name), t.fingerprint) }));
    const notOffered = [...r.notOffered, ...named.flatMap(({ t, n }) => ('reason' in n ? [{ name: t.name, reason: n.reason }] : []))];
    const flag = s.setup.kind === 'local' ? unpinned(s.setup.program, s.setup.args) : undefined;
    const reviewed = s.tools.flatMap(t => (t.reviewed ? [{ name: t.name, fingerprint: t.reviewed }] : []));
    const report = `test-${++this.reportCount}-${Math.random().toString(36).slice(2, 10)}`;
    this.reports.set(report, { server: id, shown: new Map(tools.map(t => [t.name, t.fingerprint])), listing: this.runListing.get(r.run) ?? this.listings.get(id) ?? 0 });
    for (const old of this.reports.keys()) if (this.reports.size > REPORTS_KEPT) this.reports.delete(old);
    return { ok: true, report, tools, changes: toolChanges(reviewed, tools), ...(flag ? { unpinned: flag } : {}), ...(notOffered.length ? { notOffered } : {}) };
  }

  /**
   * The person has seen these tools' names and descriptions, as one Test report showed them: each named
   * tool is marked reviewed at the fingerprint that report showed, never at whatever the catalog holds when
   * this lands, so a tool changed since stays unreviewed. A name the report didn't show is marked nothing,
   * and a report core didn't issue for this server (or one too old to be kept) marks nothing: "Test again".
   * A tool the report showed that the saved list lacks (Test's own catalog write was skipped while the
   * owner was busy) is saved as seen at that fingerprint, reviewed, so the review isn't lost; but only on
   * the newest listing's report: after a later listing, a tool missing from the saved list was removed, and
   * an old report brings nothing back.
   */
  markReviewed(id: string, report: string, names: readonly string[]): Promise<void> {
    const shown = this.reports.get(report);
    if (!shown || shown.server !== id) return Promise.reject(new Error('That Test report is no longer open. Test again.'));
    const at = new Map<string, string>();
    for (const name of names) {
      const fingerprint = shown.shown.get(name);
      if (fingerprint !== undefined) at.set(name, fingerprint);
    }
    const newest = shown.listing === (this.listings.get(id) ?? 0) || !!(__FAMILIAR_MUTATIONS__ && mutant('review-appends-old'));
    return this.update(id, r => {
      const tools = r.tools.map(t => (at.has(t.name) ? { ...t, reviewed: at.get(t.name)! } : t));
      if (newest) for (const [name, fingerprint] of at) if (!r.tools.some(t => t.name === name)) tools.push({ name, fingerprint, reviewed: fingerprint });
      return { ...r, tools };
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.update(id, r => ({ ...r, enabled }));
  }

  /** A call's time limit applies from the next call; the handshake's from the next start. */
  setLimits(id: string, limits: ServerLimits): Promise<void> {
    return this.update(id, r => ({ ...r, limits }));
  }

  /**
   * The person's choice for one tool: "always" for exactly this tool and setup, "ask", or "never". Once
   * it's saved it replaces a revoke made before it, so that key's overlay goes; a revoke made while it was
   * saving is newer, and stays.
   */
  async choose(serverId: string, tool: string, choice: ToolChoice | undefined): Promise<void> {
    const key = choiceKey(serverId, tool);
    const before = this.revokes.get(key) ?? 0;
    // "May run on its own" is granted only for the version the server lists now, with its setup, and records
    // the change counter here, synchronously, before any await: a change while it saves leaves it standing
    // for nothing (5.6). This attempt's record is its own; a refused attempt records nothing.
    const own = choice?.policy === 'own' && serverId !== BUILT_IN;
    let attempt: { readonly fingerprint: string; readonly setup: string; readonly counter: number } | undefined;
    if (own) {
      const live = this.tools().find(t => t.server.id === serverId && t.serverName === tool);
      if (!(__FAMILIAR_MUTATIONS__ && mutant('own-grant-unchecked')) && (!live || live.fingerprint !== choice.fingerprint || live.setupFingerprint !== choice.setupFingerprint)) throw new Error(`${tool} changed or stopped since you saw it, so "may run on its own" was not saved.`);
      attempt = { fingerprint: choice.fingerprint, setup: choice.setupFingerprint, counter: this.changeCount.get(key) ?? 0 };
    }
    const r = await this.owner.choose(serverId, tool, choice);
    if (!r.ok) throw new Error(r.words);
    if (attempt) {
      this.grants.set(key, attempt);
      // Already stale (a change while it saved): refused at every call; its record is cleaned up.
      const live = this.tools().find(t => t.server.id === serverId && t.serverName === tool);
      if ((!live || !this.ownNow(key, live.fingerprint, live.setupFingerprint)) && !checkOnly()) {
        this.clears.set(key, { server: serverId, tool, fingerprint: attempt.fingerprint });
        this.clearGrants();
      }
    }
    if ((this.revokes.get(key) ?? 0) === before) this.overlay.delete(key);
  }

  /**
   * The gate's policy for a turn (journal's `policy`): each server wrapper's from its own identity, and each
   * built-in's from the owner's choice under the built-in id, the revoke overlay on top. Read at each call.
   * With the whole record unreadable no choice loads, and no built-in falls back to its default allow:
   * every tool asks, and a revoke to never still denies (5.1).
   */
  policy(wrappers: readonly ServerTool[]): GatePolicy {
    const choices = this.owner.choices();
    const perTool: Record<string, GateVerdict> = { ...toolPolicies(wrappers, choices) };
    // "May run on its own" only while its grant still stands: the one check, at each call (5.6).
    for (const w of wrappers) if (perTool[w.name] === 'own' && !this.ownNow(choiceKey(w.server.id, w.serverName), w.fingerprint, w.setupFingerprint)) delete perTool[w.name];
    for (const [key, c] of Object.entries(choices)) {
      const tool = builtInTool(key);
      if (tool !== undefined) perTool[tool] = c.policy;
    }
    for (const w of wrappers) this.tighten(perTool, w.name, choiceKey(w.server.id, w.serverName));
    for (const [key] of this.overlay) {
      const tool = builtInTool(key);
      if (tool !== undefined) this.tighten(perTool, tool, key);
    }
    return this.owner.unreadable ? { perTool, askAll: true } : { perTool };
  }

  /** The overlay on top: "never" denies; "ask" asks, explicitly, since a built-in's absent entry is its
      default, which for some is allow. */
  private tighten(perTool: Record<string, GateVerdict>, name: string, key: string): void {
    const o = this.overlay.get(key);
    if (o === 'never') perTool[name] = 'deny';
    else if (o === 'ask' && perTool[name] !== 'deny') perTool[name] = 'ask';
  }

  /** The person's choices, from the owner. */
  choices(): Readonly<Record<string, ToolChoice>> {
    return this.owner.choices();
  }

  /**
   * A tightening holds at once, in memory, whatever the owner is doing; its durable write follows, and its
   * outcome is the answer. "Ask" is saved as an explicit ask, never as no choice, since no choice is a
   * built-in's default. A write the owner refuses (busy, a change unfinished) or the store loses is
   * answered not ok, in words Settings shows: the revoke holds until Familiar restarts, and the saved
   * choice comes back then unless it's tried again.
   */
  async revoke(serverId: string, tool: string, to: 'ask' | 'never'): Promise<Outcome> {
    const key = choiceKey(serverId, tool);
    this.revokes.set(key, (this.revokes.get(key) ?? 0) + 1);
    if (this.overlay.get(key) !== 'never') this.overlay.set(key, to);
    const cur = this.owner.choices()[key];
    // Ask after never isn't a tightening: the saved never stands, and nothing is written. But only once
    // the owner admits it: while another write is in flight (an earlier choice of allow, say), the saved
    // never may be about to change, and the answer is not saved. (The old shortcut, answering ok at once
    // from whatever was committed, is a named mutation.)
    if (to === 'ask' && cur?.policy === 'deny') {
      if (__FAMILIAR_MUTATIONS__ && mutant('revoke-denied-shortcut')) return { ok: true };
      const t = this.owner.admit('choice');
      if (!('release' in t)) return { ok: false, words: `${REVOKE_NOT_SAVED} ${t.ok ? '' : t.words}`.trim() };
      t.release();
      return { ok: true };
    }
    const r = await this.owner.choose(serverId, tool, { policy: to === 'never' ? 'deny' : 'ask', fingerprint: cur?.fingerprint ?? '', setupFingerprint: cur?.setupFingerprint ?? '' }).catch((): Outcome => ({ ok: false, words: 'The store failed.' }));
    return r.ok ? r : { ok: false, words: `${REVOKE_NOT_SAVED} ${r.words}` };
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
   * choice, with the revoke overlay, still allows it (a decision minted on "may run on its own" needs that
   * grant still saved for these fingerprints and not revoked; a Yes not turned to "never"); and the
   * exchange slot is Idle. Then it marks the decision
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
    if (!rt.link.offers(run.id, decision.tool, decision.fingerprint) && !(rt.link.offers(run.id, decision.tool, rt.link.current?.tools.find((t) => t.name === decision.tool)?.fingerprint ?? '') && (__FAMILIAR_MUTATIONS__ && mutant('ignore-fingerprint')))) return refuse('changed', 'The tool changed since it was allowed, so it was not sent. It will ask again.');
    const key = choiceKey(decision.server, decision.tool);
    const choice = this.owner.choices()[key];
    const overlay = this.overlay.get(key);
    if (choice?.policy === 'deny' || overlay === 'never') return refuse('changed', `You chose never to run ${decision.tool} on this server, so Familiar didn't send the call.`);
    if (decision.by === 'own' && (overlay === 'ask' || !this.ownNow(key, decision.fingerprint, decision.launch))) {
      return refuse('changed', `Your "may run on its own" for ${decision.tool} on this server no longer stands, so Familiar didn't send the call. It will ask.`);
    }
    const ms = Math.min(CALL_MS_MAX, Math.max(CALL_MS_MIN, record.limits.callMs ?? CALL_MS));
    // Named mutations: queue behind a live exchange, a gap between the checks and the handoff, or a body
    // from the model's own arguments instead of the decision's.
    const hand = (): Promise<CallOutcome> => {
      const canonical = raw !== undefined && (__FAMILIAR_MUTATIONS__ && mutant('body-from-model-args')) ? (canonicalArguments(raw)?.canonical ?? decision.canonical) : decision.canonical;
      markUsed(decision);
      const sent = rt.link.handoff(decision.tool, canonical, signal, ms);
      return sent ?? refuse('busy', 'The server is busy with another request. Try again in a moment.');
    };
    if (rt.link.busy && (__FAMILIAR_MUTATIONS__ && mutant('queue-call'))) return rt.link.drained().then(hand);
    if (rt.link.busy) return refuse('busy', 'The server is busy with another request. Try again in a moment.');
    if ((__FAMILIAR_MUTATIONS__ && mutant('await-before-handoff'))) return Promise.resolve().then(hand);
    return hand();
  }

  private async update(id: string, change: (r: OwnedServerRecord) => OwnedServerRecord): Promise<void> {
    const r = await this.owner.update(id, s => ({ ...s, ...change(s) }));
    if (!r.ok) throw new Error(r.words);
  }

  /** A run's tool list, saved as the tools last seen while its run is current; what the person reviewed is kept. */
  private async seen(id: string, now: readonly ListedTool[], current: () => boolean, run?: string): Promise<void> {
    const n = (this.listings.get(id) ?? 0) + 1;
    this.listings.set(id, n);
    // Which listing each run's was, so a Test report is dated by its own run's list, never by whatever
    // listed by the time Test answered.
    if (run !== undefined) {
      this.runListing.set(run, n);
      for (const old of this.runListing.keys()) if (this.runListing.size > REPORTS_KEPT) this.runListing.delete(old);
    }
    // The catalog write goes first; a grant's durable clear waits for it (clearGrants).
    const s = this.owner.server(id);
    if (!s) return;
    const before = new Map(s.tools.map(t => [t.name, t]));
    const tools: SavedTool[] = now.map(t => {
      const reviewed = before.get(t.name)?.reviewed;
      return { name: t.name, fingerprint: t.fingerprint, ...(reviewed ? { reviewed } : {}) };
    });
    this.seeing++;
    try {
      // A write that fails throws to the driver, which feeds the machine; the machine decides what shows.
      await this.owner.seen(id, tools, current);
    } finally {
      this.seeing--;
      this.clearGrants();
    }
  }
}

type OwnedServerRecord = import('./owner.ts').OwnedServer;

/** Under the grant mutations, the durable clear (cleanup) is off too, so their controls measure the check at
    each call alone: that check is what the guarantee rests on. */
function checkOnly(): boolean {
  return !!(__FAMILIAR_MUTATIONS__ && (mutant('own-kept-on-skip') || mutant('own-kept-on-absence') || mutant('own-counter-ignored') || mutant('own-ignores-fingerprint')));
}

/** An address as compared for an edit: the same exe identity. */
function sameAddress(a: string, b: string): boolean {
  return addressIdentity(a) !== undefined && addressIdentity(a) === addressIdentity(b);
}
