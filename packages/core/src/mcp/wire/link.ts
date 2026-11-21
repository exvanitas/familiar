// One server's link: Familiar's own MCP client for it (docs/mcp-design.md 3.1 to 3.11, 5.4). Two halves:
//
// - The wire: the server's exchange slot, which outlives a run (so a Start of the same server waits for
//   nothing: it's refused while the old run's exchange drains), framing, the exchanges' native requests,
//   and the untrusted answers' checks. The exchange machine (exchange.ts) is pure; its effects are done here:
//   a remote request is one POST through the exe's net_fetch, read with net_read, ended with net_cancel; a
//   local one is one server_write of a line.
// - The driver of the run lifecycle (lifecycle.ts): Start, Stop, Test, the walk, the refresh, a session's
//   recovery, the relaunch, every end. Its state lives only in that pure machine. The driver turns every
//   native answer, deadline, slot change, server notice and person action into an event, feeds it, drains
//   every event the effects raise in the same task, and carries the effects out. It decides nothing.
//
// `handoff()` stays one synchronous step: it reads `callable()` from the machine, whose queue is empty
// between tasks, and hands off in the same step.

import { boundTools, checkTools, CatalogError, MAX_TOOLS } from '../catalog.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../process.ts';
import { LastOutput } from '../last-output.ts';
import type { CallOutcome, Failure, ListedTool } from '../types.ts';
import { exitFailure, protocolFailure, remoteFailure, startFailure } from '../words.ts';
import { emptySlot, step, type Effect, type End, type ExchangeKind, type Input, type Slot } from './exchange.ts';
import { frame, frameCall, LEGACY_VERSIONS, legacyVersion, MODERN_VERSION, type AdminMessage, type Era, type RpcId } from './framing.ts';
import { HEADER_WORDS, paramHeaders, scanDeclarations, type HeaderDeclaration } from './headers.ts';
import { BUSY_SLOT, callable, failureOf, fenced, offering, initialState, next, phaseOf, STOPPED_WORDS, type AdminOutcome, type LcEffect, type LcEvent, type LcState, type Mode, type Reply, type StartFacts, type Want } from './lifecycle.ts';
import { mutant } from '../../mutations.ts';
import { callResult, cutText, EventStream, initializeResult, Invalid, listResult, MAX_HANDSHAKE_BYTES, MAX_MESSAGE_BYTES, parseMessage, resultText, type Inbound } from './parse.ts';

export { MAX_PAGES, STOP_REFUSED, STOP_UNCONFIRMED } from './lifecycle.ts';

export interface NetSpec {
  readonly id: string;
  readonly address: string;
  readonly url: string;
  readonly method: 'POST';
  readonly headers: readonly (readonly [string, string])[];
  readonly maxBytes?: number;
  readonly headersMs?: number;
  readonly idleMs?: number;
}
export interface NetHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly url: string;
  readonly redirected: boolean;
}
export interface NetPort {
  fetch(spec: NetSpec, body: Uint8Array): Promise<NetHead>;
  /** Waits for output; empty only at the real end. */
  read(id: string): Promise<Uint8Array>;
  /** Ends the request. Resolves once the exe has ended it. */
  cancel(id: string): Promise<void>;
}

export interface LinkClock {
  now(): number;
  setTimer(callback: () => void, ms: number, options: { readonly background: boolean }): (() => void) | undefined;
}

export type Target =
  | { readonly where: 'remote'; readonly address: string; readonly url: string; readonly headers: readonly (readonly [string, string])[] }
  | { readonly where: 'local'; readonly setup: ProcessSetup };

export interface LinkLimits {
  /** The whole start: handshake and first list. */
  readonly startMs: number;
  /** A list walk, over all its pages. */
  readonly listMs: number;
  /** A pong's own native bounds. */
  readonly pongMs: number;
  /** A remote request's time to its head and between chunks. */
  readonly headersMs: number;
  readonly idleMs: number;
  /**
   * The interim local write bound (4.3): a write pending longer ends the run and stops the server, which
   * has stopped reading. It goes when the exe's own write bound lands.
   */
  readonly writeMs: number;
  /** Stop's own bound: past it, a process not yet seen to exit may still be running (5.4). */
  readonly stopMs: number;
  /** How long a modern-only stdio server's exit is awaited before a relaunch is decided (3.9). */
  readonly graceMs: number;
}

export const LINK_LIMITS: LinkLimits = { startMs: 60_000, listMs: 30_000, pongMs: 5_000, headersMs: 120_000, idleMs: 15 * 60_000, writeMs: 10_000, stopMs: 10_000, graceMs: 2_000 };
export const MAX_SESSION_ID = 1024;
const DROPPED_LINE = /^a stdout line over \d+ MiB was dropped$/;

export interface LinkEvents {
  /** A run ended in a failure (a crash, an exit, a failed walk, a second session drop). */
  ended?(run: string, failure: Failure): void;
  /** A run's catalog was published: save it. Its outcome settles the start that waits for it. */
  listed?(run: string, tools: readonly ListedTool[]): Promise<'saved' | 'skipped' | 'failed' | void> | 'saved' | 'skipped' | 'failed' | void;
  /** The owner's admission for a native start: held while the exe answers it (5.1). */
  admit?(): { readonly release: () => void } | { readonly words: string };
  /** The committed record now, for a relaunch the machine decides (3.9): whether it's enabled, and its
      launch fingerprint ('' when the record is gone). The owner's admission is asked separately. */
  record?(): { readonly enabled: boolean; readonly launch: string };
  /** The phase or its words changed. */
  changed?(): void;
  /** The test build's conformance record: every event fed, the state the driver then holds, and the
      exchange machine's slot (busy or not), with whether the queue had drained. */
  transition?(event: LcEvent, state: LcState, slot: { readonly busy: boolean; readonly quiet: boolean }): void;
  /** The test build's record of the exchange machine's own outputs: each exchange admitted, for which run, and
      its terminal end (the conformance check matches the machine's end-live effects against them). */
  exchange?(e: { readonly t: 'admit' | 'ended'; readonly n: number; readonly run: string; readonly kind: string; readonly end?: string }): void;
}

/** What one exchange gave back. */
interface Outcome {
  readonly end: End;
  readonly response?: Extract<Inbound, { t: 'response' }>;
  /** Remote initialize: the session id its answer's head carried, success or not. */
  readonly offered?: string;
}

/** The wire's record of one run: what its exchanges need. Nothing in it decides anything. */
interface Wire {
  readonly id: string;
  readonly target: Target;
  readonly launch: string;
  /** The limits the run was admitted with: its own, never changed by a later action. */
  readonly limits: LinkLimits;
  era: Era;
  version?: string;
  sessionId?: string;
  /** The process run id the exe gave, for a local server. */
  process?: string;
  exited?: boolean;
  exitedEarly?: { readonly code: number | null };
  tools: readonly ListedTool[];
  /** Modern remote: each offered tool's header declarations. */
  declarations: Map<string, readonly HeaderDeclaration[]>;
  /** Tools listed but not offered, with why (Test shows them). */
  notOffered: readonly { readonly name: string; readonly reason: string }[];
  nextId: number;
  readonly last: LastOutput;
  /** The walk's pages so far, and its cursor. */
  pages: Record<string, unknown>[];
  cursor?: string;
  /** The catalog the last page built, published by the machine's effect. */
  built?: { readonly tools: readonly ListedTool[]; readonly declarations: Map<string, readonly HeaderDeclaration[]>; readonly notOffered: readonly { name: string; reason: string }[] };
  /** A session's recovery is under way (for a named mutation's resend). */
  recovering?: boolean;
  /** The last call's body and arguments (for named mutations only). */
  lastCall?: { readonly body: string; readonly args: string };
}

/** Per exchange: its waiter, and what the natives hold for it. */
interface Pending {
  readonly n: number;
  readonly kind: ExchangeKind;
  readonly run: Wire;
  readonly requestId?: number;
  readonly body: string;
  readonly done: (o: Outcome) => void;
  response?: Extract<Inbound, { t: 'response' }>;
  cancelTimer?: () => void;
  /** Remote: whether the request carried the session id. */
  carriedSession?: boolean;
  /** Remote initialize: the session id its successful answer offers. */
  offeredSession?: string;
  /** The JSON-RPC method, for the modern era's `Mcp-Method`. */
  readonly method?: string;
  /** Modern tools/call: `Mcp-Name` and the `Mcp-Param-*` headers, built from the decision. */
  readonly extra?: readonly (readonly [string, string])[];
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

export class ServerLink {
  private slot: Slot = emptySlot;
  private readonly pending = new Map<number, Pending>();
  /** Native request id per handle, remote. */
  private readonly natives = new Map<string, string>();
  private readonly idle: (() => void)[] = [];
  /** The number of the exchange exchangeNow last admitted. */
  private admitted = 0;

  /* The lifecycle: its state lives only in the machine (lifecycle.ts); the driver feeds it events and does
     its effects, and decides nothing. */
  private lc: LcState;
  private readonly queue: LcEvent[] = [];
  private draining = false;
  /** Depth of the exchange machine's effects under way: lifecycle events wait until they're done. */
  private effecting = 0;
  /** The wire's own record of each run (what the exchanges need), by run id. */
  private readonly wires = new Map<string, Wire>();
  private readonly timers = new Map<number, () => void>();
  private readonly answers = new Map<string, (r: Reply) => void>();
  private tokens = 0;
  /** The owner's admission while the machine holds it (a native start), released by its effect. */
  private ownerHold?: () => void;
  /** Each start asked but not yet consumed by the machine: what its run would be, and the owner's
      reservation bound to its token until next() decides (kept, if the machine holds the owner; released,
      if not). Nothing about it touches any other run. */
  private readonly asked = new Map<string, { readonly target: Target; readonly launch: string; readonly limits: LinkLimits; readonly release?: () => void }>();
  /** The relaunch's owner reservation, bound to its run until the machine decides its readmit. */
  private readmitHold?: { readonly run: string; readonly release: () => void };
  /** Test-only watchers, called after every drain (list()). */
  private readonly watchers = new Set<() => void>();
  /** Test reports, captured when a Test run publishes: never read from a wire a later run replaced. */
  private readonly reports = new Map<string, { readonly tools: readonly ListedTool[]; readonly notOffered: readonly { readonly name: string; readonly reason: string }[] }>();
  /** The exe's cleanup refusal for good, as words (the machine holds the same). */
  private stuck?: Failure;

  readonly serverId: string;
  private readonly ports: { readonly net?: NetPort; readonly processes?: ProcessPort };
  private readonly clock: LinkClock;
  private readonly events: LinkEvents;
  private readonly limits: LinkLimits;

  constructor(serverId: string, ports: { readonly net?: NetPort; readonly processes?: ProcessPort }, clock: LinkClock, events: LinkEvents, limits: LinkLimits = LINK_LIMITS) {
    this.serverId = serverId;
    this.ports = ports;
    this.clock = clock;
    this.events = events;
    this.limits = limits;
    this.lc = initialState(serverId);
  }

  /* ---------- what the rest of core reads ---------- */

  /** The machine's state, as it stands between events (the queue is always empty between tasks). */
  get state(): LcState {
    return this.lc;
  }
  get phase(): ReturnType<typeof phaseOf> {
    return phaseOf(this.lc);
  }
  get failure(): Failure | undefined {
    return failureOf(this.lc);
  }
  /** Set once cleanup the exe refused for good has left the slot held until a restart: the words. */
  get held(): Failure | undefined {
    return this.lc.held;
  }
  /** Whether an exchange holds the slot, Live or Draining. */
  get busy(): boolean {
    return this.slot.ex !== undefined;
  }
  /** Person actions not yet answered. */
  get waiting(): number {
    return this.lc.waiters.length;
  }
  get current(): { readonly run: string; readonly era: Era; readonly ready: boolean; readonly stale: boolean; readonly tools: readonly ListedTool[]; readonly notOffered: readonly { readonly name: string; readonly reason: string }[]; readonly sessionId?: string; readonly version?: string; readonly launch: string } | undefined {
    const r = this.lc.run;
    const w = r && this.wires.get(r.id);
    if (!r || !w || r.step === 'closing') return undefined;
    const stale = r.refreshOwed || r.published === undefined || r.changes !== r.published || r.step !== 'ready';
    return { run: r.id, era: r.era, ready: r.step === 'ready', stale, tools: w.tools, notOffered: w.notOffered, launch: w.launch, ...(w.sessionId ? { sessionId: w.sessionId } : {}), ...(w.version ? { version: w.version } : {}) };
  }
  /** Resolves when the slot is next Idle. */
  drained(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /* ---------- the driver ---------- */

  /** Feeds one event, and drains every event its effects raise, in this same task. */
  private feed(e: LcEvent): void {
    this.queue.push(e);
    // Never in the middle of the exchange machine's own effects: those finish first, so the machine always
    // sees the slot as the exchange machine left it.
    if (this.draining || this.effecting > 0) return;
    this.drain();
  }

  private drain(): void {
    this.draining = true;
    const before = `${phaseOf(this.lc)}:${failureOf(this.lc)?.words ?? ''}`;
    try {
      while (this.queue.length) {
        const ev = this.queue.shift()!;
        const before = this.lc;
        const out = next(this.lc, ev);
        this.lc = out.state;
        this.bind(ev, before, out.state);
        for (const fx of out.effects) this.apply(fx);
        // A driver that decides outside next() (the conformance check's control).
        if (__FAMILIAR_MUTATIONS__ && ev.t === 'slot' && !ev.idle && mutant('driver-decides')) this.lc = { ...this.lc, slot: 'idle' };
        this.events.transition?.(ev, this.lc, { busy: this.busy, quiet: this.queue.length === 0 && this.effecting === 0 });
      }
    } finally {
      this.draining = false;
    }
    for (const w of [...this.watchers]) w();
    if (`${phaseOf(this.lc)}:${failureOf(this.lc)?.words ?? ''}` !== before) this.events.changed?.();
  }

  /**
   * What an action asked for, bound once next() has consumed its event: a new run gets its own wire (target,
   * launch, limits), and the owner's reservation is kept only if the machine now holds the owner for a
   * native start, released otherwise. A refused action leaves every run as it was.
   */
  private bind(ev: LcEvent, before: LcState, after: LcState): void {
    const created = after.run && after.run.id !== before.run?.id ? after.run : undefined;
    if (ev.t === 'start') {
      const a = this.asked.get(ev.token);
      this.asked.delete(ev.token);
      if (!a) return;
      if (created) this.newWire(created.id, a);
      if (after.owner === 'start' && before.owner !== 'start' && created && !this.ownerHold) this.ownerHold = a.release;
      else a.release?.();
      return;
    }
    if (ev.t === 'readmit') {
      const h = this.readmitHold?.run === ev.run ? this.readmitHold : undefined;
      if (h) this.readmitHold = undefined;
      const from = this.wires.get(ev.run);
      if (created && from) this.newWire(created.id, from);
      if (h && after.owner === 'start' && before.owner !== 'start' && created && !this.ownerHold) this.ownerHold = h.release;
      else h?.release();
    }
  }

  private newWire(run: string, from: { readonly target: Target; readonly launch: string; readonly limits: LinkLimits }): void {
    this.wires.set(run, { id: run, target: from.target, launch: from.launch, limits: from.limits, era: 'legacy', tools: [], declarations: new Map(), notOffered: [], nextId: 1, last: new LastOutput(), pages: [] });
    // Keep only what's still needed: the current run and any whose process may still be running.
    for (const id of [...this.wires.keys()]) if (id !== run && id !== this.lc.run?.id && !this.lc.orphans.some((o) => o.run === id)) this.wires.delete(id);
  }

  /** The run's wire, made when its admission was bound (bind()). */
  private wireFor(run: string, era: Era): Wire {
    const w = this.wires.get(run)!;
    w.era = era;
    return w;
  }

  /** The limits of the run the machine is on now (deadlines are armed for it), else the link's own. */
  private limitsNow(): LinkLimits {
    const r = this.lc.run;
    return (r && this.wires.get(r.id)?.limits) ?? this.limits;
  }

  private apply(fx: LcEffect): void {
    switch (fx.t) {
      case 'native-start': {
        const w = this.wireFor(fx.run, fx.era);
        const setup = (w.target as Extract<Target, { where: 'local' }>).setup;
        // A port that throws before returning its promise is a rejected start, the same event.
        let starting: Promise<{ readonly run: string }>;
        try {
          starting = this.ports.processes!.start(setup, (e) => this.processEvent(w, e));
        } catch (e) {
          starting = Promise.reject(e);
        }
        starting.then(
          (started) => {
            w.process = started.run;
            this.feed({ t: 'started', run: fx.run, ok: true, process: started.run });
            // An exit that came before the exe's answer named the process.
            if (w.exitedEarly) this.feed({ t: 'exit', process: started.run, failure: exitFailure(w.exitedEarly.code, w.last.text()) });
          },
          (e: unknown) => this.feed({ t: 'started', run: fx.run, ok: false, failure: startFailure(e, setup.program, setup.secrets) })
        );
        return;
      }
      case 'native-stop': {
        const stop = () =>
          // A port that throws before returning its promise is a refused stop, the same event.
          new Promise<void>((res, rej) => {
            try {
              this.ports.processes!.stop(fx.process).then(res, rej);
            } catch (e) {
              rej(e);
            }
          }).then(
            () => this.feed({ t: 'stop-answered', run: fx.run, ok: true }),
            () => {
              const w = this.wires.get(fx.run);
              if (w && (__FAMILIAR_MUTATIONS__ && mutant('release-on-refused-cancel'))) this.releaseWrites(w);
              this.feed({ t: 'stop-answered', run: fx.run, ok: false });
            }
          );
        void stop();
        if (__FAMILIAR_MUTATIONS__ && mutant('stop-twice')) void this.ports.processes!.stop(fx.process).catch(() => {});
        return;
      }
      case 'admin':
        return this.admin(fx.run, fx.want, fx.era);
      case 'end-live': {
        // (The named mutation: a driver that skips an effect the machine asked for.)
        if (__FAMILIAR_MUTATIONS__ && mutant('driver-skips-effect')) return;
        const ex = this.slot.ex;
        if (ex && ex.phase === 'live' && this.pending.get(ex.n)?.run.id === fx.run) this.input({ t: 'terminal', n: ex.n, end: { t: 'run-ended' } });
        return;
      }
      case 'arm': {
        const l = this.limitsNow();
        const ms = { start: l.startMs, list: l.listMs, recovery: l.startMs, grace: l.graceMs, stop: l.stopMs }[fx.which];
        const cancel = this.clock.setTimer(() => {
          this.timers.delete(fx.id);
          this.feed({ t: 'deadline', id: fx.id });
        }, ms, { background: false });
        if (cancel) this.timers.set(fx.id, cancel);
        return;
      }
      case 'disarm':
        this.timers.get(fx.id)?.();
        this.timers.delete(fx.id);
        return;
      case 'owner-hold':
        // The reservation was taken before the event and bound to it (bind()): nothing is acquired here, so a
        // native start never goes out on an admission that failed.
        return;
      case 'owner-release': {
        const r = this.ownerHold;
        this.ownerHold = undefined;
        r?.();
        return;
      }
      case 'publish': {
        const w = this.wires.get(fx.run);
        if (!w || !w.built) return;
        w.tools = w.built.tools;
        w.declarations = w.built.declarations;
        w.notOffered = w.built.notOffered;
        w.built = undefined;
        if (w.recovering) {
          w.recovering = false;
          const resend = __FAMILIAR_MUTATIONS__ && mutant('resend-404-call') ? w.lastCall?.body : undefined;
          if (resend) void this.drained().then(() => this.exchangeNow(w, 'call', w.nextId++, resend, 'tools/call'));
        }
        // A Test's report, captured as its run publishes.
        if (this.lc.run?.id === fx.run && this.lc.run.mode === 'test') this.reports.set(fx.run, { tools: w.tools, notOffered: w.notOffered });
        return;
      }
      case 'save': {
        const w = this.wires.get(fx.run);
        const tools = w?.tools ?? [];
        Promise.resolve(this.events.listed ? this.events.listed(fx.run, tools) : 'saved').then(
          (o) => this.feed({ t: 'saved', gen: fx.gen, outcome: o === 'skipped' || o === 'failed' ? o : 'saved' }),
          () => this.feed({ t: 'saved', gen: fx.gen, outcome: 'failed' })
        );
        return;
      }
      case 'answer': {
        const a = this.answers.get(fx.token);
        this.answers.delete(fx.token);
        a?.(fx.reply);
        return;
      }
      case 'release-writes': {
        const w = [...this.wires.values()].find((x) => x.process === fx.process);
        if (w) this.releaseWrites(w);
        return;
      }
      case 'ended':
        this.events.ended?.(fx.run, fx.failure ?? { kind: 'exited', words: 'The server stopped.' });
        return;
      case 'readmit-check': {
        // The relaunch's facts, read now: the owner's admission (bound to this run until the machine decides)
        // and the committed record. The machine decides (3.9).
        const a = this.events.admit ? this.events.admit() : { release: () => {} };
        if ('release' in a) this.readmitHold = { run: fx.run, release: a.release };
        const rec = this.events.record ? this.events.record() : { enabled: true, launch: this.wires.get(fx.run)?.launch ?? '' };
        this.feed({ t: 'readmit', run: fx.run, facts: { ownerFree: 'release' in a, ...('words' in a ? { ownerWords: a.words } : {}), enabled: rec.enabled, launch: rec.launch } });
        return;
      }
      case 'new-session': {
        const w = this.wires.get(fx.run);
        if (!w) return;
        if (!(__FAMILIAR_MUTATIONS__ && mutant('keep-old-session-id'))) delete w.sessionId;
        delete w.version;
        w.recovering = true;
        return;
      }
    }
  }

  /** A person action, fed as an event, answered by its own effect. */
  private ask(make: (token: string) => LcEvent): Promise<Reply> {
    const token = `a${++this.tokens}`;
    return new Promise<Reply>((resolve) => {
      this.answers.set(token, resolve);
      this.feed(make(token));
    });
  }

  /* ---------- start, stop, Test ---------- */

  /**
   * A Start (or Test, by `mode`) as the machine answers it. `facts` are read by the caller in the same
   * step; the owner's admission is asked here, once, and handed to the machine as a fact.
   */
  startReply(target: Target, launch: string, mode: Mode = 'start', facts: Partial<StartFacts> = {}, limits: LinkLimits = this.limits): Promise<Reply> {
    if (this.busy && (__FAMILIAR_MUTATIONS__ && mutant('slot-per-run'))) {
      this.slot = emptySlot;
      this.feed({ t: 'slot', idle: true });
    }
    const record = facts.record ?? 'ok';
    let ownerFree = facts.ownerFree ?? true;
    let ownerWords = facts.ownerWords;
    let admitted: (() => void) | undefined;
    if (record === 'ok' && ownerFree && this.events.admit) {
      const a = this.events.admit();
      if ('release' in a) admitted = a.release;
      else {
        ownerFree = false;
        ownerWords = a.words;
      }
    }
    // Bound to the action's token: consumed (kept or released) only once next() has decided (bind()).
    return this.ask((token) => {
      this.asked.set(token, { target, launch, limits, ...(admitted ? { release: admitted } : {}) });
      return { t: 'start', token, mode, facts: { record, ownerFree, ...(ownerWords !== undefined ? { ownerWords } : {}), where: target.where, launch } };
    });
  }

  /** The old shape, for the wire's own tests: Ready with the run and its tools, or a failure in words. */
  async start(target: Target, launch: string, _options: { readonly era?: Era } = {}): Promise<{ readonly ok: true; readonly run: string; readonly tools: readonly ListedTool[] } | { readonly ok: false; readonly failure: Failure }> {
    const r = await this.startReply(target, launch);
    if (r.kind === 'ready') {
      const run = this.lc.run;
      return { ok: true, run: run?.id ?? '', tools: (run && this.wires.get(run.id)?.tools) ?? [] };
    }
    if (r.kind === 'failed') return { ok: false, failure: r.failure };
    if (r.kind === 'refused') return { ok: false, failure: { kind: 'busy', words: r.words } };
    return { ok: false, failure: { kind: 'exited', words: STOPPED_WORDS } };
  }

  /** Test: a start whose run, once listed, stops itself; ok only once that run has ended. */
  async test(target: Target, launch: string, facts: Partial<StartFacts> = {}, limits: LinkLimits = this.limits): Promise<{ readonly ok: true; readonly run: string; readonly tools: readonly ListedTool[]; readonly notOffered: readonly { readonly name: string; readonly reason: string }[] } | { readonly ok: false; readonly failure: Failure; readonly refused?: true }> {
    const r = await this.startReply(target, launch, 'test', facts, limits);
    if (r.kind === 'tested') {
      const report = this.reports.get(r.run);
      this.reports.delete(r.run);
      return { ok: true, run: r.run, tools: report?.tools ?? [], notOffered: report?.notOffered ?? [] };
    }
    if (r.kind === 'failed') return { ok: false, failure: r.failure };
    if (r.kind === 'refused') return { ok: false, failure: { kind: 'failed', words: r.words }, refused: true };
    return { ok: false, failure: { kind: 'failed', words: 'The server was stopped before it was ready.' } };
  }

  /** Stop, as the machine answers it. */
  stopReply(): Promise<Reply> {
    // (The named mutation: a driver that answers an action without feeding its event.)
    if (__FAMILIAR_MUTATIONS__ && this.lc.run && mutant('driver-answers-unasked')) return Promise.resolve({ kind: 'stopped' });
    const r = this.lc.run;
    if (r && r.where === 'remote' && r.step !== 'closing' && (__FAMILIAR_MUTATIONS__ && mutant('delete-at-stop'))) {
      const w = this.wires.get(r.id);
      const t = w?.target as Extract<Target, { where: 'remote' }> | undefined;
      if (w && t) void this.ports.net!.fetch({ id: randomId(), address: t.address, url: t.url, method: 'DELETE' as 'POST', headers: this.headers(w, undefined) }, new Uint8Array(0)).catch(() => {});
    }
    return this.ask((token) => ({ t: 'stop', token }));
  }

  /** The old shape: stopped, or refused (the exe refused, or the process may still be running). */
  async stop(): Promise<'stopped' | 'refused'> {
    const r = await this.stopReply();
    return r.kind === 'stopped' ? 'stopped' : 'refused';
  }

  /** For tests: the tool list again, as a notice of changed tools would bring it. */
  async list(): Promise<readonly ListedTool[] | Failure> {
    if (this.lc.held) return this.lc.held;
    const r = this.lc.run;
    if (!r || phaseOf(this.lc) !== 'ready') return { kind: 'failed', words: 'The server is not running.' };
    if (!callable(this.lc) || r.era !== 'legacy') return { kind: 'busy', words: 'The server is busy. Try again in a moment.' };
    const id = r.id;
    const gen = r.gen;
    // One watcher, settled and unregistered on either outcome: a newer catalog published, or the run over.
    await new Promise<void>((res) => {
      const watch = () => {
        const now = this.lc.run;
        if (now?.id === id && now.gen === gen) return;
        this.watchers.delete(watch);
        res();
      };
      this.watchers.add(watch);
      this.feed({ t: 'notice', run: id });
    });
    await this.drained();
    const w = this.wires.get(id);
    return this.lc.run?.id === id && w ? w.tools : (this.lc.held ?? failureOf(this.lc) ?? { kind: 'failed', words: 'The server is not running.' });
  }

  /* ---------- administrative exchanges, classified for the machine ---------- */

  private admin(run: string, want: Want, era: Era): void {
    const w = this.wireFor(run, era);
    let p: Promise<Outcome> | undefined;
    const onEnd = (o: Outcome) => {
      let outcome: AdminOutcome;
      try {
        outcome = this.classify(w, want, o);
      } catch (e) {
        outcome = { k: 'invalid', failure: unexpected(e) };
      }
      this.feed({ t: 'admin-done', run, outcome });
    };
    if (want.kind === 'initialize') {
      const id = w.nextId++;
      p = this.exchangeNow(w, 'initialize', id, frame({ kind: 'initialize', id }, 'legacy', w.target.where), 'initialize', undefined, onEnd);
    } else if (want.kind === 'initialized') {
      p = this.exchangeNow(w, 'initialized', undefined, frame({ kind: 'initialized' }, 'legacy', w.target.where), 'notifications/initialized', undefined, onEnd);
    } else {
      if (want.page === 1) {
        w.pages = [];
        w.cursor = undefined;
      }
      const id = w.nextId++;
      const msg: AdminMessage = { kind: 'list', id, ...(w.cursor !== undefined ? { cursor: w.cursor } : {}) };
      p = this.exchangeNow(w, 'list', id, frame(msg, w.era, w.target.where), 'tools/list', undefined, onEnd);
    }
    // The machine issues only at an Idle slot: a refusal here would mean the mirror drifted.
    if (!p) this.feed({ t: 'admin-done', run, outcome: { k: 'unanswered', failure: { kind: 'busy', words: BUSY_SLOT } } });
  }

  private classify(w: Wire, want: Want, o: Outcome): AdminOutcome {
    const end = o.end;
    if (end.t === 'session-ended') return { k: 'session-ended' };
    // A notification completes on its write (local) or its 202 (remote): there's no response to read.
    if (want.kind === 'initialized' && end.t === 'done') return { k: 'ok' };
    const answered = end.t === 'invalid' || end.t === 'line-too-long' || end.t === 'flood';
    if (end.t !== 'done' || !o.response) return answered ? { k: 'invalid', failure: this.startWords(w, end) } : { k: 'unanswered', failure: this.startWords(w, end) };
    const r = o.response;
    if (want.kind === 'initialize') {
      if (r.error) {
        if (modernRefusal(r.error) || (__FAMILIAR_MUTATIONS__ && mutant('modern-on-any-error'))) {
          if (o.offered !== undefined && (__FAMILIAR_MUTATIONS__ && mutant('session-id-on-modern'))) w.sessionId = o.offered;
          else delete w.sessionId;
          return { k: 'modern-refusal' };
        }
        return { k: 'refused', failure: refusedWords(r.error) };
      }
      try {
        w.version = initializeResult(r.result ?? {}).protocolVersion;
        return { k: 'legacy' };
      } catch (e) {
        return { k: 'invalid', failure: { kind: 'protocol', words: `The server's answer to the handshake was wrong: ${(e as Error).message}.`, ...(w.last.text() ? { lastOutput: w.last.text()! } : {}) } };
      }
    }
    if (want.kind === 'initialized') return { k: 'ok' };
    // A page of the list: any answer is the server's word.
    if (r.error) {
      if (w.era === 'modern' && r.error.code === -32022) return { k: 'refused', failure: refusedWords(r.error) };
      return { k: 'refused', failure: { kind: 'protocol', words: `The server refused to list its tools: ${r.error.message}` } };
    }
    let page;
    try {
      page = listResult(r.result ?? {}, w.era);
    } catch (e) {
      return { k: 'invalid', failure: { kind: 'protocol', words: `The server's tool list was wrong: ${(e as Error).message}.` } };
    }
    // Bounded before anything is kept: every listed tool counts, offered or not.
    if (w.pages.length + page.tools.length > MAX_TOOLS) return { k: 'invalid', failure: { kind: 'protocol', words: `The server lists more than ${MAX_TOOLS} tools. Familiar takes at most ${MAX_TOOLS}.` } };
    for (const t of page.tools) w.pages.push(t);
    w.cursor = page.nextCursor;
    if (w.cursor !== undefined) return { k: 'page', more: true };
    return { k: 'page', more: false, catalog: this.build(w) };
  }

  /** The listed tools, bounded and scanned, kept for the publish effect; or why the list fails. */
  private build(w: Wire): 'ok' | Failure {
    const raw = w.pages;
    // Every listed tool is bounded before any is scanned (names, shape, bytes, the whole list): one that
    // isn't offered still can't share a name with one that is, nor outgrow the bounds unchecked.
    if (!(__FAMILIAR_MUTATIONS__ && mutant('bound-offered-only'))) {
      try {
        boundTools(raw as never);
      } catch (e) {
        if (e instanceof CatalogError) return e.failure;
        return unexpected(e);
      }
    }
    // A modern remote run mirrors declared arguments into headers: a tool whose declarations break the
    // rules isn't offered, and Test says why (3.5). The tool's fingerprint covers its declarations and the
    // era, since they change what goes on the wire: the same tool listed by a legacy run is another tool.
    const offered: Record<string, unknown>[] = [];
    const notOffered: { name: string; reason: string }[] = [];
    const declarations = new Map<string, readonly HeaderDeclaration[]>();
    for (const t of raw) {
      if (w.era === 'modern' && w.target.where === 'remote') {
        const scan = scanDeclarations(t.inputSchema);
        if (!scan.ok) {
          notOffered.push({ name: cutText(String(t.name), 128), reason: cutText(scan.reason, 200) });
          continue;
        }
        if (typeof t.name === 'string') declarations.set(t.name, scan.declarations);
      }
      offered.push(t);
    }
    try {
      w.built = { tools: checkTools(offered as never, w.era === 'modern' && w.target.where === 'remote' ? { declarations } : {}), declarations, notOffered };
      return 'ok';
    } catch (e) {
      if (e instanceof CatalogError) return e.failure;
      return unexpected(e);
    }
  }

  /* ---------- calls: the synchronous handoff ---------- */


  /**
   * Hands a call off, synchronously: the caller (client.ts) has checked the decision in the same step,
   * and the body comes from it. Returns undefined if the slot isn't Idle or the run isn't Ready, with
   * nothing sent; otherwise the call's outcome, once it ends. `ms` is the call's time limit.
   */
  handoff(name: string, canonicalArguments: string, signal: AbortSignal, ms: number): Promise<CallOutcome> | undefined {
    const run = this.lc.run && this.wires.get(this.lc.run.id);
    if (!run || !callable(this.lc) || this.busy) return undefined;
    // Modern remote: the headers come from the same decision as the body, in this same step (3.6).
    let extra: (readonly [string, string])[] | undefined;
    if (run.era === 'modern' && run.target.where === 'remote') {
      const mirrored = (__FAMILIAR_MUTATIONS__ && mutant('mirror-previous-call')) && run.lastCall ? run.lastCall.args : canonicalArguments;
      const values = JSON.parse(mirrored);
      // A named mutation: a mirrored value that isn't the body's.
      if ((__FAMILIAR_MUTATIONS__ && mutant('mirror-wrong-value')) && values && typeof values === 'object' && 'region' in values) values.region = `${String(values.region)}-x`;
      const params = paramHeaders(run.declarations.get(name) ?? [], values, this.headers(run, 'tools/call').length + 1);
      if (!params.ok) return Promise.resolve({ kind: 'error', reason: 'protocol', words: HEADER_WORDS });
      extra = [['Mcp-Name', name], ...params.headers];
    }
    const id = run.nextId++;
    const body = frameCall(id, name, canonicalArguments, run.era, run.target.where);
    // Kept only for named mutations (the test build): the app build drops it.
    if (__FAMILIAR_MUTATIONS__) run.lastCall = { body, args: canonicalArguments };
    const outcome = this.exchangeNow(run, 'call', id, body, 'tools/call', extra);
    if (!outcome) return undefined;
    // The exchange this call was admitted as, kept here: the slot may have moved on by now (an exit the
    // port delivered from inside its own call).
    const n = this.admitted;
    const timer = this.clock.setTimer(() => this.input({ t: 'terminal', n, end: { t: 'timeout' } }), ms, { background: false });
    const onAbort = () => {
      this.input({ t: 'terminal', n, end: { t: 'stopped' } });
      if (run.target.where === 'remote' && (__FAMILIAR_MUTATIONS__ && mutant('remote-cancel'))) this.post(run, `${n}:cancel`, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }), undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return outcome.then((o) => {
      timer?.();
      signal.removeEventListener('abort', onAbort);
      return this.callOutcome(run, o);
    });
  }

  /** Whether the run offers this tool with this fingerprint, catalog fresh. */
  offers(run: string, tool: string, fingerprint: string): boolean {
    const r = this.lc.run && this.wires.get(this.lc.run.id);
    return !!r && r.id === run && offering(this.lc) && r.tools.some((t) => t.name === tool && t.fingerprint === fingerprint);
  }


  private callOutcome(run: Wire, o: Outcome): CallOutcome {
    const end = o.end;
    if (end.t === 'done' && o.response) {
      const r = o.response;
      if (r.error) {
        if (run.era === 'modern' && r.error.code === -32022) {
          // The server changed its mind about the era: the run ended in the exchange's terminal step (effect()).
          if (__FAMILIAR_MUTATIONS__ && mutant('era-refusal-late')) this.feed({ t: 'call-ended', run: run.id, end: 'era-refusal', failure: refusedWords(r.error) });
          return { kind: 'interrupted' };
        }
        if (run.era === 'modern' && r.error.code === -32020) return { kind: 'result', text: "The server said the call's headers didn't match its body. Familiar didn't send it again.", isError: true };
        if (run.era === 'modern' && r.error.code === -32021) return { kind: 'result', text: "The server asked for something Familiar didn't offer. Familiar didn't send it again.", isError: true };
        return { kind: 'result', text: `The server answered with an error: ${r.error.message}`, isError: true };
      }
      if (run.era === 'modern') {
        const type = r.result?.resultType;
        if (type === 'input_required') {
          if ((__FAMILIAR_MUTATIONS__ && mutant('retry-after-input-required')) && run.lastCall) {
            const again = run.lastCall.body;
            void this.drained().then(() => this.exchangeNow(run, 'call', run.nextId++, again, 'tools/call'));
          }
          return { kind: 'result', text: "The server asked for input Familiar can't give.", isError: true };
        }
        if (type === undefined) return { kind: 'error', reason: 'protocol', words: 'The server sent a result without its resultType, which the protocol requires.' };
        if (type !== 'complete') return { kind: 'result', text: `The server sent a result Familiar can't use (${shown(type)}).`, isError: true };
      }
      try {
        const result = callResult(r.result ?? {}, run.era);
        return { kind: 'result', text: resultText(result), isError: result.isError };
      } catch (e) {
        return { kind: 'error', reason: 'protocol', words: `The server sent something Familiar couldn't read: ${(e as Error).message}.` };
      }
    }
    switch (end.t) {
      case 'stopped':
        return { kind: 'stopped' };
      case 'timeout':
        return { kind: 'timed-out' };
      case 'stream-ended':
      case 'run-ended':
        return { kind: 'interrupted' };
      case 'session-ended':
        return { kind: 'error', reason: 'protocol', words: 'The server had ended its session. The call was not sent again: ask again.' };
      default:
        return { kind: 'error', reason: 'protocol', words: endWords(end) };
    }
  }


  /* ---------- exchanges ---------- */

  /** Only under a named mutation: admitting before the slot has drained. */
  private early(kind: ExchangeKind): boolean {
    const ex = this.slot.ex;
    return ex?.phase === 'draining' && ((__FAMILIAR_MUTATIONS__ && mutant('admit-while-draining')) || (kind === 'list' && ex.kind === 'list' && (__FAMILIAR_MUTATIONS__ && mutant('page-before-drain'))));
  }

  /** Admits and hands off in one synchronous step, or undefined if the slot isn't Idle. */
  private exchangeNow(run: Wire, kind: ExchangeKind, requestId: number | undefined, body: string, method?: string, extra?: readonly (readonly [string, string])[], onEnd?: (o: Outcome) => void): Promise<Outcome> | undefined {
    if (this.busy && !this.early(kind)) return undefined;
    let settle!: (o: Outcome) => void;
    const promise = new Promise<Outcome>((r) => (settle = r));
    // An administrative exchange's outcome reaches the lifecycle in the exchange's own end step, before its
    // drain: the machine sees "done", then Idle, in that order.
    const resolve = (o: Outcome) => {
      settle(o);
      onEnd?.(o);
    };
    const n = this.slot.next;
    this.pending.set(n, { n, kind, run, ...(requestId !== undefined ? { requestId } : {}), body, done: resolve, ...(method ? { method } : {}), ...(extra ? { extra } : {}) });
    this.events.exchange?.({ t: 'admit', n, run: run.id, kind });
    // Busy is both machines' before any port is invoked: the exchange machine takes the admission, the
    // lifecycle hears busy, and only then do the admission's effects (the port's call) run. A callback the
    // port makes from inside its own call finds the slot busy in both. (An admin exchange's busy is the
    // lifecycle's own, set when it issued it; the event then changes nothing.)
    const late = __FAMILIAR_MUTATIONS__ && mutant('busy-after-handoff');
    this.input({ t: 'admit', kind, where: run.target.where, era: run.era, ...(requestId !== undefined ? { requestId } : {}) }, late ? undefined : () => this.feed({ t: 'slot', idle: false }));
    if (late) this.feed({ t: 'slot', idle: false });
    this.admitted = n;
    return promise;
  }

  /** Feeds the exchange machine one input and does its effects, synchronously; `between` runs after its new
      state is taken and before any of its effects. */
  private input(input: Input, between?: () => void): void {
    const s = step(this.slot, input);
    this.slot = s.slot;
    between?.();
    this.effecting++;
    try {
      for (const e of s.effects) this.effect(e);
    } finally {
      this.effecting--;
    }
    if (this.effecting === 0 && !this.draining && this.queue.length) this.drain();
  }

  private effect(e: Effect): void {
    switch (e.t) {
      case 'busy':
        return;
      case 'send':
        return this.send(e);
      case 'cancel':
        return this.cancel(e.handle);
      case 'ended': {
        const p = this.pending.get(e.n);
        if (!p) return;
        this.events.exchange?.({ t: 'ended', n: e.n, run: p.run.id, kind: p.kind, end: e.end.t });
        p.done({ end: e.end, ...(p.response ? { response: p.response } : {}), ...(p.offeredSession !== undefined ? { offered: p.offeredSession } : {}) });
        // A call that completes rearms a recovered session's 404 bound; a call that met a 404 is the
        // lifecycle's (3.8). An administrative exchange's outcome reaches it through its own classifier.
        // A modern server's era refusal on a call is classified here, in the exchange's own terminal step, so
        // the machine ends the run before the slot is published Idle: no second call can reach it.
        const eraRefusal = p.kind === 'call' && e.end.t === 'done' && p.run.era === 'modern' && p.response?.error?.code === -32022 && !(__FAMILIAR_MUTATIONS__ && mutant('era-refusal-late'));
        if (eraRefusal) this.feed({ t: 'call-ended', run: p.run.id, end: 'era-refusal', failure: refusedWords(p.response!.error!) });
        else if (p.kind === 'call' && e.end.t === 'done') this.feed({ t: 'call-ended', run: p.run.id, end: 'done' });
        if (p.kind === 'call' && e.end.t === 'session-ended') this.feed({ t: 'call-ended', run: p.run.id, end: 'session-ended' });
        return;
      }
      case 'idle': {
        this.pending.delete(e.n);
        for (const [h] of [...this.natives]) if (h.startsWith(`${e.n}:`)) this.natives.delete(h);
        const waiters = this.idle.splice(0);
        for (const w of waiters) w();
        this.feed({ t: 'slot', idle: true });
        return;
      }
      case 'departure':
        return;
    }
  }

  private n(handle: string): number {
    return Number(handle.slice(0, handle.indexOf(':')));
  }

  private send(e: Extract<Effect, { t: 'send' }>): void {
    const n = this.n(e.handle);
    const p = this.pending.get(n);
    if (!p) return;
    const run = p.run;
    const text =
      e.message === 'request' ? p.body : e.message === 'pong' ? frame({ kind: 'pong', id: e.pingId! }, run.era, run.target.where) : frame({ kind: 'cancelled', requestId: e.requestId! }, run.era, run.target.where);
    if (run.target.where === 'local') return this.write(run, e.handle, text, e.message === 'request' ? p : undefined);
    return this.post(run, e.handle, text, e.message === 'request' ? p : undefined);
  }


  /* ---------- local ---------- */

  private write(run: Wire, handle: string, text: string, request: Pending | undefined): void {
    if (run.process === undefined || run.exited) {
      // No process to write to: the write ends at once.
      queueMicrotask(() => this.input({ t: 'released', handle }));
      return;
    }
    // The page's watchdog on this write: past the bound, the server has stopped reading.
    const watchdog = (__FAMILIAR_MUTATIONS__ && mutant('no-write-bound'))
      ? undefined
      : this.clock.setTimer(() => this.feed({ t: 'write-bound', run: run.id }), run.limits.writeMs, { background: false });
    // A port that throws before returning its promise fails the write, the same way.
    let writing: Promise<void>;
    try {
      writing = this.ports.processes!.write(run.process, enc.encode(`${text}\n`));
    } catch (e) {
      writing = Promise.reject(e);
    }
    writing.then(
      () => {
        watchdog?.();
        this.input({ t: 'released', handle });
      },
      (err: unknown) => {
        watchdog?.();
        if (request) this.input({ t: 'terminal', n: request.n, end: { t: 'native', kind: kindText(err) } });
        this.input({ t: 'released', handle });
      }
    );
  }

  private processEvent(run: Wire, e: ProcessEvent): void {
    if (e.t === 'exit') {
      run.exited = true;
      if (run.process === undefined) {
        run.exitedEarly = { code: e.code };
        return;
      }
      this.feed({ t: 'exit', process: run.process, failure: exitFailure(e.code, run.last.text()) });
      return;
    }
    // Lines of a run that isn't the current one (an orphan) are nobody's now.
    if (this.lc.run?.id !== run.id) return;
    if (e.t === 'err') {
      if (DROPPED_LINE.test(e.line)) {
        const ex = this.slot.ex;
        if (ex && ex.phase === 'live' && this.pending.get(ex.n)?.run === run) this.input({ t: 'terminal', n: ex.n, end: { t: 'line-too-long' } });
        return;
      }
      return run.last.push(e.line);
    }
    let m: Inbound;
    try {
      // A local initialize's answer has the handshake's bound, as a remote one's does.
      const ex = this.slot.ex;
      const opening = ex && ex.phase === 'live' && ex.kind === 'initialize' && this.pending.get(ex.n)?.run === run;
      m = parseMessage(e.line, opening ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES);
    } catch (err) {
      // Not JSON-RPC: kept as output while idle; it fails a live exchange.
      const ex = this.slot.ex;
      if (ex && ex.phase === 'live' && this.pending.get(ex.n)?.run === run && e.line.trim().startsWith('{')) this.input({ t: 'terminal', n: ex.n, end: { t: 'invalid', why: (err as Error).message } });
      else if (e.line.trim()) run.last.push(e.line);
      return;
    }
    this.inbound(run, m, false);
  }

  /* ---------- remote ---------- */

  private headers(run: Wire, method: string | undefined): [string, string][] {
    const t = run.target as Extract<Target, { where: 'remote' }>;
    // Reserved names never come from a setup (5.7): refused when it's saved, and dropped here too.
    const h: [string, string][] = t.headers.filter(([k]) => !reservedHeader(k)).map(([k, v]) => [k, v]);
    // The client's own headers go after the setup's, so none of the setup's can override them.
    const set = (k: string, v: string) => {
      for (let i = h.length - 1; i >= 0; i--) if (h[i]![0].toLowerCase() === k.toLowerCase()) h.splice(i, 1);
      h.push([k, v]);
    };
    set('Content-Type', 'application/json');
    set('Accept', 'application/json, text/event-stream');
    if (run.era === 'modern') {
      // Modern: the version and the method on every request; no session, ever.
      set('MCP-Protocol-Version', MODERN_VERSION);
      if (method) set('Mcp-Method', method);
      if (run.sessionId) set('Mcp-Session-Id', run.sessionId);
      return h;
    }
    if (run.version) set('MCP-Protocol-Version', run.version);
    if (run.sessionId) set('Mcp-Session-Id', run.sessionId);
    return h;
  }

  private post(run: Wire, handle: string, text: string, request: Pending | undefined): void {
    const t = run.target as Extract<Target, { where: 'remote' }>;
    const id = randomId();
    this.natives.set(handle, id);
    const pong = request === undefined && handle.includes(':pong:');
    if (request) request.carriedSession = run.sessionId !== undefined;
    const spec: NetSpec = {
      id,
      address: t.address,
      url: t.url,
      method: 'POST',
      headers: [...this.headers(run, request?.method), ...(request?.extra ?? []).map(([k, v]) => [k, v] as [string, string])],
      maxBytes: request?.kind === 'initialize' ? MAX_HANDSHAKE_BYTES : 2 * MAX_MESSAGE_BYTES,
      headersMs: pong ? run.limits.pongMs : run.limits.headersMs,
      idleMs: pong ? run.limits.pongMs : run.limits.idleMs
    };
    // A port that throws before returning its promise fails the request, the same way.
    let fetching: ReturnType<NetPort['fetch']>;
    try {
      fetching = this.ports.net!.fetch(spec, enc.encode(text));
    } catch (e) {
      fetching = Promise.reject(e);
    }
    fetching.then(
      (head) => {
        if (pong) return this.input({ t: 'pong-head', handle });
        if (request) void this.response(run, request, id, head);
      },
      (err: unknown) => {
        if (pong) return this.input({ t: 'pong-head', handle });
        if (request) this.input({ t: 'terminal', n: request.n, end: { t: 'native', kind: kindText(err) } });
      }
    );
  }

  /**
   * net_cancel, and the handle released only when the exe says the request has ended. A refusal is tried
   * again (1, 2, then 4 s later); after that the run ends, and the request stays counted, so the slot never
   * frees on cleanup the exe didn't confirm.
   */
  private cancel(handle: string, attempt = 0): void {
    const id = this.natives.get(handle);
    if (id === undefined) return this.input({ t: 'released', handle });
    this.ports.net!.cancel(id).then(
      () => this.input({ t: 'released', handle }),
      () => {
        if ((__FAMILIAR_MUTATIONS__ && mutant('release-on-refused-cancel'))) return this.input({ t: 'released', handle });
        if (attempt < 3) return void this.clock.setTimer(() => this.cancel(handle, attempt + 1), 1000 * 2 ** attempt, { background: false });
        // For good: the slot stays held until a restart. The machine answers every waiter, a start parked
        // between its handshake's steps included, with these words.
        const failure: Failure = { kind: 'protocol', words: "Familiar couldn't end a request to the server. Restart Familiar to use it again." };
        this.stuck = failure;
        this.feed({ t: 'exhausted', failure });
      }
    );
  }

  /** A request's head and body. */
  private async response(run: Wire, p: Pending, id: string, head: NetHead): Promise<void> {
    const live = () => this.slot.ex?.n === p.n && this.slot.ex.phase === 'live';
    if (!live()) return;
    if ((head.redirected || (head.status >= 300 && head.status < 400)) && !(__FAMILIAR_MUTATIONS__ && mutant('ignore-redirected'))) return this.input({ t: 'terminal', n: p.n, end: { t: 'redirected', status: head.status } });
    if (head.status === 404 && p.carriedSession) return this.input({ t: 'terminal', n: p.n, end: { t: 'session-ended' } });
    const type = (head.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '').toLowerCase();
    if (head.status === 202 && p.kind === 'initialized') return this.input({ t: 'completed', n: p.n });
    const ok = head.status >= 200 && head.status < 300;
    // The opening's classifier (3.3): a JSON-RPC error body for this request decides first, whatever the status.
    // Legacy: a status other than 2xx decides. Modern: a JSON-RPC error body for the request is read first.
    if (!ok && p.kind !== 'initialize' && run.era !== 'modern') return this.input({ t: 'terminal', n: p.n, end: { t: 'http', status: head.status } });
    if (p.kind === 'initialize' && run.target.where === 'remote' && ok) {
      const sid = head.headers.filter(([k]) => k.toLowerCase() === 'mcp-session-id');
      if (sid.length > 1 || (sid.length === 1 && !/^[\x21-\x7e]{1,1024}$/.test(sid[0]![1]))) return this.input({ t: 'terminal', n: p.n, end: { t: 'invalid', why: 'a session id Familiar can\'t use' } });
      // Adopted only if the answer turns out to be a successful initialize (below).
      if (sid[0]) p.offeredSession = sid[0][1];
    }
    const small = p.kind === 'initialize' || !ok;
    // Only the two media types the transport allows, exactly: the type before any parameters, trimmed. A
    // lookalike (application/jsonp, text/event-streaming) is another type. Its words are Familiar's own:
    // none of the server's header text reaches them.
    const media = (__FAMILIAR_MUTATIONS__ && mutant('media-prefix')) ? (type.startsWith('text/event-stream') ? 'text/event-stream' : type.startsWith('application/json') ? 'application/json' : type) : type.split(';')[0]!.trim();
    const events = media === 'text/event-stream' ? new EventStream(small ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES) : undefined;
    if (!events && media !== 'application/json') return this.input({ t: 'terminal', n: p.n, end: ok ? { t: 'invalid', why: "an answer of a type Familiar doesn't read" } : { t: 'http', status: head.status } });
    // One decoder for the whole body, so a character split across reads comes out whole.
    const decoder = new TextDecoder();
    const status = !ok ? head.status : undefined;
    let json = '';
    try {
      for (;;) {
        const chunk = await this.ports.net!.read(id);
        if (!live()) return;
        if (chunk.length === 0) break;
        if (events) {
          for (const data of events.push(chunk)) if (this.remoteMessage(run, p, data, status)) return;
        } else {
          json += (__FAMILIAR_MUTATIONS__ && mutant('decoder-per-chunk')) ? new TextDecoder().decode(chunk, { stream: true }) : decoder.decode(chunk, { stream: true });
          if (json.length > (small ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES)) throw new Invalid('a response past its size bound');
        }
      }
      if (events) {
        for (const data of events.end()) if (this.remoteMessage(run, p, data, status)) return;
        return this.input({ t: 'terminal', n: p.n, end: status !== undefined ? { t: 'http', status } : { t: 'stream-ended' } });
      }
      json += decoder.decode();
      if (!ok && json.trim() === '') return this.input({ t: 'terminal', n: p.n, end: { t: 'http', status: head.status } });
      if (!this.remoteMessage(run, p, json, !ok ? head.status : undefined)) this.input({ t: 'terminal', n: p.n, end: ok ? { t: 'stream-ended' } : { t: 'http', status: head.status } });
    } catch (err) {
      if (!live()) return;
      if (err instanceof Invalid) return this.input({ t: 'terminal', n: p.n, end: { t: 'invalid', why: err.message } });
      this.input({ t: 'terminal', n: p.n, end: { t: 'native', kind: kindText(err) } });
    }
  }

  /** One message on a remote request's stream. True once the exchange has its response. */
  private remoteMessage(run: Wire, p: Pending, text: string, status?: number): boolean {
    let m: Inbound;
    try {
      m = parseMessage(text, p.kind === 'initialize' || status !== undefined ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES);
    } catch (err) {
      if (status !== undefined) {
        this.input({ t: 'terminal', n: p.n, end: { t: 'http', status } });
        return true;
      }
      throw err;
    }
    if (status !== undefined && !(m.t === 'response' && m.error && m.id === p.requestId)) {
      this.input({ t: 'terminal', n: p.n, end: { t: 'http', status } });
      return true;
    }
    return this.inbound(run, m, true, p);
  }

  /* ---------- inbound, both transports ---------- */

  /** True when the message completed the live exchange. */
  private inbound(run: Wire, m: Inbound, remote: boolean, on?: Pending): boolean {
    const ex = this.slot.ex;
    const live = ex && ex.phase === 'live' ? this.pending.get(ex.n) : undefined;
    const mine = live && live.run === run && (!remote || live === on) ? live : undefined;
    if (m.t === 'response') {
      if (!mine || mine.requestId === undefined || (m.id !== mine.requestId && !(__FAMILIAR_MUTATIONS__ && mutant('accept-any-response-id')))) return false;
      mine.response = m;
      if (mine.kind === 'initialize' && !m.error && mine.offeredSession !== undefined) run.sessionId = mine.offeredSession;
      this.input({ t: 'completed', n: mine.n });
      return true;
    }
    if (m.t === 'request') {
      // Only a legacy ping is answered; any other request gets no reply (Familiar declares no capabilities).
      if (m.method === 'ping' && run.era === 'modern' && remote && on && (__FAMILIAR_MUTATIONS__ && mutant('answer-stray-ping-modern'))) {
        this.post(run, `${on.n}:pong:stray`, JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }), undefined);
        return false;
      }
      if (m.method !== 'ping' || run.era !== 'legacy') return false;
      if (mine && (__FAMILIAR_MUTATIONS__ && mutant('pong-in-microtask'))) {
        const n = mine.n;
        queueMicrotask(() => this.input({ t: 'ping', n, id: m.id }));
      } else if (mine) this.input({ t: 'ping', n: mine.n, id: m.id });
      else if (!remote && !this.busy && this.lc.run?.id === run.id && !fenced(this.lc)) this.idlePing(run, m.id);
      else if (ex && ex.phase === 'draining' && !remote) this.input({ t: 'ping', n: ex.n, id: m.id });
      return false;
    }
    // The lifecycle decides what a notice of changed tools brings: a walk now, after the exchange that
    // carried it, or folded into a walk under way.
    if (m.method === 'notifications/tools/list_changed' && run.era === 'legacy') this.feed({ t: 'notice', run: run.id });
    return false;
  }

  /** A local ping with no live exchange: answered as an exchange of its own, one write. */
  private idlePing(run: Wire, id: RpcId): void {
    const n = this.slot.next;
    this.pending.set(n, { n, kind: 'pong', run, body: frame({ kind: 'pong', id }, run.era, 'local'), done: () => {} });
    this.input({ t: 'admit', kind: 'pong', where: 'local', era: run.era });
    this.feed({ t: 'slot', idle: false });
  }

  /* ---------- the wire's end of a process ---------- */

  /** A local process is gone: the writes of its exchange have ended. */
  private releaseWrites(run: Wire): void {
    const ex = this.slot.ex;
    if (ex && this.pending.get(ex.n)?.run === run) for (const h of [...ex.open]) this.input({ t: 'released', handle: h });
  }

  private startWords(run: Wire, end: End): Failure {
    if (end.t === 'run-ended') return run.target.where === 'local' ? protocolFailure(run.last.text()) : { kind: 'exited', words: 'The connection to the server closed.' };
    if (end.t === 'timeout') return { kind: 'timed-out', words: "The server didn't finish starting in time." };
    if (end.t === 'native') return remoteFailure({ kind: end.kind });
    if (end.t === 'http') return remoteFailure({ code: end.status });
    return { kind: 'protocol', words: endWords(end), ...(run.last.text() ? { lastOutput: run.last.text()! } : {}) };
  }
}

/** A -32022 whose list names 2026-07-28 and no legacy version Familiar speaks: the server is modern-only. */
export function modernRefusal(error: { code: number; data?: unknown }): boolean {
  if (error.code !== -32022) return false;
  const supported = (error.data as { supported?: unknown } | undefined)?.supported;
  return Array.isArray(supported) && supported.every((v) => typeof v === 'string') && supported.includes(MODERN_VERSION) && !supported.some((v) => legacyVersion(v));
}

/** A refused handshake, with the server's own versions in words when it named them. */
function refusedWords(error: { code: number; message: string; data?: unknown }): Failure {
  const supported = (error.data as { supported?: unknown } | undefined)?.supported;
  if (error.code === -32022 && Array.isArray(supported) && supported.every((v) => typeof v === 'string')) {
    const list = (supported as string[]).slice(0, 8).map((v) => cutText(v, 20)).join(', ');
    return { kind: 'protocol', words: `This server speaks MCP ${list} only; Familiar speaks ${LEGACY_VERSIONS[0]} to ${MODERN_VERSION}.` };
  }
  return { kind: 'protocol', words: `The server refused the handshake: ${error.message}` };
}

export function endWords(end: End): string {
  switch (end.t) {
    case 'done':
      return 'Done.';
    case 'timeout':
      return 'Timed out.';
    case 'stopped':
      return 'Stopped.';
    case 'stream-ended':
      return 'The server ended the reply.';
    case 'flood':
      return 'The server sent too many pings.';
    case 'invalid':
      return `The server sent something Familiar couldn't read (${end.why}).`;
    case 'native':
      return remoteFailure({ kind: end.kind }).words;
    case 'redirected':
      return `The server redirected Familiar's request${end.status ? ` (HTTP ${end.status})` : ''}.`;
    case 'line-too-long':
      return 'The server sent a line too long.';
    case 'session-ended':
      return 'The server had ended its session.';
    case 'http':
      return remoteFailure({ code: end.status }).words;
    case 'run-ended':
      return 'Interrupted: it may have partly run.';
  }
}

/** A header a setup may never supply (5.7). */
export function reservedHeader(name: string): boolean {
  const n = name.toLowerCase();
  return ['mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'content-type', 'accept', 'host', 'mcp-method', 'mcp-name'].includes(n) || n.startsWith('mcp-param-');
}

/** A throw from reading a server's answers, as words: it ends the run like any invalid answer. */
function unexpected(e: unknown): Failure {
  return { kind: 'protocol', words: `The server sent something Familiar couldn't handle (${e instanceof Error ? e.name : 'an error'}).` };
}

/** A value a server sent, for words: never converted by its own methods, and bounded. */
function shown(v: unknown): string {
  const text = typeof v === 'string' ? v : (() => {
    try {
      return JSON.stringify(v) ?? typeof v;
    } catch {
      return typeof v;
    }
  })();
  return [...text].slice(0, 40).join('');
}

function kindText(e: unknown): string {
  const k = e !== null && typeof e === 'object' && 'kind' in e ? (e as { kind: unknown }).kind : undefined;
  const c = e instanceof Error && e.cause && typeof e.cause === 'object' && 'kind' in e.cause ? (e.cause as { kind: unknown }).kind : undefined;
  return typeof k === 'string' ? k : typeof c === 'string' ? c : 'network';
}

