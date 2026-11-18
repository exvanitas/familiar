// One server's link: Familiar's own MCP client for it (docs/mcp-design.md 3.1 to 3.11). It holds the
// server's exchange slot, which outlives a run, so a Start of the same server waits for nothing: it's
// refused busy until the old run's exchange has drained. For each run (one Start to its end) it holds the
// run id, the era, the negotiated version, the remote session id, and the catalog with its stale bit.
// There's no queue, no second exchange and no timer that isn't an exchange's own.
//
// The effects of the pure exchange machine (exchange.ts) are done here: a remote request is one POST
// through the exe's net_fetch, read with net_read, ended with net_cancel; a local one is one server_write
// of a line. What comes back is checked (parse.ts) and fed to the machine as inputs, in order.

import { boundTools, checkTools, CatalogError, MAX_TOOLS } from '../catalog.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../process.ts';
import { LastOutput } from '../last-output.ts';
import type { CallOutcome, Failure, ListedTool } from '../types.ts';
import { exitFailure, protocolFailure, remoteFailure, startFailure } from '../words.ts';
import { emptySlot, step, type Effect, type End, type ExchangeKind, type Input, type Slot } from './exchange.ts';
import { frame, frameCall, LEGACY_VERSIONS, legacyVersion, MODERN_VERSION, type AdminMessage, type Era, type RpcId } from './framing.ts';
import { HEADER_WORDS, paramHeaders, scanDeclarations, type HeaderDeclaration } from './headers.ts';
import { mutant } from '../../mutations.ts';
import { callResult, cutText, EventStream, initializeResult, Invalid, listResult, MAX_HANDSHAKE_BYTES, MAX_MESSAGE_BYTES, parseMessage, resultText, type Inbound } from './parse.ts';

/** The exe's fetch, as core uses it: one request per id, its head, its body pulled, and its end. */
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
}

export const LINK_LIMITS: LinkLimits = { startMs: 60_000, listMs: 30_000, pongMs: 5_000, headersMs: 120_000, idleMs: 15 * 60_000, writeMs: 10_000 };
export const MAX_PAGES = 16;
export const MAX_SESSION_ID = 1024;
const DROPPED_LINE = /^a stdout line over \d+ MiB was dropped$/;

export interface LinkEvents {
  /** The run ended: a crash, an exit, a failed walk, a second session drop. Called once per run. */
  ended(run: string, failure: Failure): void;
  /** The catalog changed after a walk. */
  listed?(run: string, tools: readonly ListedTool[]): void;
}

/** A start's, a walk's or a re-handshake's deadline: every step of it races it, the slot's waits included. */
interface Deadline {
  expired: boolean;
  readonly over: Promise<void>;
}

/** What one exchange gave back. */
interface Outcome {
  readonly end: End;
  readonly response?: Extract<Inbound, { t: 'response' }>;
  /** Remote initialize: the session id its answer's head carried, success or not. */
  readonly offered?: string;
}

interface Run {
  readonly id: string;
  readonly target: Target;
  readonly launch: string;
  era: Era;
  version?: string;
  sessionId?: string;
  /** The process run id the exe gave, for a local server. */
  process?: string;
  tools: readonly ListedTool[];
  /** Modern remote: each offered tool's header declarations. */
  declarations: Map<string, readonly HeaderDeclaration[]>;
  /** Tools listed but not offered, with why (Test shows them). */
  notOffered: readonly { readonly name: string; readonly reason: string }[];
  stale: boolean;
  /** Counts list_changed notifications: a walk publishes its catalog only if none came while it ran. */
  changes: number;
  /** A refresh walk is already scheduled for list_changed: a burst is one more walk. */
  relisting?: boolean;
  /** The walk under way, if any: one walk owns the run's list at a time, its own retry absorbing list_changed. */
  walker?: object;
  /** Counts the server's ended sessions: a walk begun under an earlier one sends nothing more. */
  session: number;
  ready: boolean;
  ended: boolean;
  /** A local run's process has exited (the exe said so). */
  exited?: boolean;
  /** Resolves when the exe says a local run's process has exited. */
  readonly exit: Promise<void>;
  sawExit: () => void;
  /** Resolves when a local run's native start has answered, whether or not a process came of it. */
  readonly launched: Promise<void>;
  /** The one native stop of a local run's process: asked once, whoever asks first (Stop, or the run's end). */
  stopCall?: Promise<void>;
  /** Stop has begun: set synchronously before Stop awaits anything, so no exchange is admitted after it. */
  closing?: boolean;
  nextId: number;
  /** Re-handshakes since the last exchange that completed without a 404. */
  dropped: number;
  readonly last: LastOutput;
  /** Why the run ended, once it has. */
  failure?: Failure;
  /** The last call's body and arguments (for named mutations only). */
  lastCall?: { readonly body: string; readonly args: string };
  /** Resolves when the run has ended. */
  readonly over: Promise<void>;
  finish: () => void;
}

/** Per exchange: its waiter, and what the natives hold for it. */
interface Pending {
  readonly n: number;
  readonly kind: ExchangeKind;
  readonly run: Run;
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
  private run: Run | undefined;
  private readonly pending = new Map<number, Pending>();
  /** Native request id per handle, remote. */
  private readonly natives = new Map<string, string>();
  private readonly idle: (() => void)[] = [];
  /** Cleanup the exe refused for good: the slot is held until Familiar restarts, and these are the words. */
  private stuck?: Failure;
  private stuckNow!: () => void;
  /** Resolves when the slot is held for good: an exchange waiting for it stops waiting. */
  private readonly stuckAt = new Promise<void>((r) => (this.stuckNow = r));
  private runs = 0;

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
  }

  /* ---------- the slot, for the lifecycle and the tests ---------- */

  /** Set once cleanup the exe refused for good has left the slot held until a restart: the words. */
  get held(): Failure | undefined {
    return this.stuck;
  }

  /** Whether an exchange holds the slot, Live or Draining. */
  get busy(): boolean {
    return this.slot.ex !== undefined;
  }
  get current(): { readonly run: string; readonly era: Era; readonly ready: boolean; readonly stale: boolean; readonly tools: readonly ListedTool[]; readonly notOffered: readonly { readonly name: string; readonly reason: string }[]; readonly sessionId?: string; readonly version?: string; readonly launch: string } | undefined {
    const r = this.run;
    return r && !r.ended ? { run: r.id, era: r.era, ready: r.ready, stale: r.stale, tools: r.tools, notOffered: r.notOffered, launch: r.launch, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.version ? { version: r.version } : {}) } : undefined;
  }
  /** Resolves when the slot is next Idle. */
  drained(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /* ---------- start, stop, list ---------- */

  /**
   * Starts a run: the legacy handshake (initialize, then initialized, each its own exchange), then the
   * tool list. Refused busy while the slot holds an exchange (a Stop's drain included). The whole start
   * runs under one deadline; past it the local process is stopped, or the remote run ends.
   */
  async start(target: Target, launch: string, options: { readonly era?: Era; readonly launched?: () => void } = {}): Promise<{ readonly ok: true; readonly run: string; readonly tools: readonly ListedTool[] } | { readonly ok: false; readonly failure: Failure; readonly relaunch?: 'modern' }> {
    if (this.busy && (__FAMILIAR_MUTATIONS__ && mutant('slot-per-run'))) this.slot = emptySlot;
    // Held for good: a restart is the only way back, and the words say so (not "try again in a moment").
    if (this.stuck && !(__FAMILIAR_MUTATIONS__ && mutant('forget-exhaustion'))) return { ok: false, failure: this.stuck };
    if (this.busy || (this.run && !this.run.ended)) return { ok: false, failure: { kind: 'busy', words: 'The server is still finishing its last request. Try again in a moment.' } };
    let finish!: () => void;
    const over = new Promise<void>((r) => (finish = r));
    let sawExit!: () => void;
    const exit = new Promise<void>((r) => (sawExit = r));
    let launchedNow!: () => void;
    const launched = new Promise<void>((r) => (launchedNow = r));
    const run: Run = { id: `${this.serverId}#${++this.runs}`, target, launch, era: options.era ?? 'legacy', tools: [], declarations: new Map(), notOffered: [], stale: true, changes: 0, session: 0, ready: false, ended: false, nextId: 1, dropped: 0, last: new LastOutput(), over, finish, exit, sawExit, launched };
    this.run = run;
    if (target.where === 'local') {
      const processes = this.ports.processes!;
      try {
        const started = await processes.start(target.setup, (e) => this.processEvent(run, e));
        run.process = started.run;
      } catch (e) {
        run.ended = true;
        run.finish();
        launchedNow();
        options.launched?.();
        return { ok: false, failure: startFailure(e, target.setup.program, target.setup.secrets) };
      }
      launchedNow();
      // Stopped while the exe was still starting it: the process it then started is stopped here, and its
      // exit awaited, before the start answers, so the next Start meets no orphan.
      if (run.closing || (run.ended && !run.exited)) {
        await this.stopProcess(run).catch(() => {});
        await run.exit;
        this.endRun(run, { kind: 'exited', words: 'The server was stopped.' }, false);
        options.launched?.();
        return { ok: false, failure: { kind: 'exited', words: 'The server was stopped.' } };
      }
      // The exe answered: the owner's native start is over (5.1).
      options.launched?.();
      if (run.ended) return { ok: false, failure: this.exitWords(run) };
    }
    if (target.where === 'remote') options.launched?.();
    const { deadline, cancel } = this.deadline(run, this.limits.startMs);
    try {
      // A modern relaunch skips the opening: the era was decided by the refusal on the first start.
      const failure = run.era === 'modern' ? undefined : await this.handshake(run, deadline);
      if (failure) {
        this.endRun(run, failure, false);
        return { ok: false, failure };
      }
      const refusedOnStdio = run.era === 'modern' && options.era === undefined && target.where === 'local';
      const listed = await this.walk(run, deadline);
      if (!('tools' in listed)) {
        // A modern-only stdio server that ended its process after refusing (rmcp does, B2): one relaunch
        // with the era fixed to modern, readmitted by the caller. Only when the list got no answer (a
        // refused write, a closed pipe): an answer, a refusal included, is the server's word and decides.
        // The pipe can close before the exe reports the exit: a write refused then is the pipe closing, so
        // the exit is awaited, within 2 s and the start's deadline, before deciding. Only an actual exit
        // counts: a run Familiar ended itself (the write bound's) is not a server that ended its process.
        const answered = 'answered' in listed && listed.answered && !(__FAMILIAR_MUTATIONS__ && mutant('relaunch-on-answer'));
        if (refusedOnStdio && !answered && !run.exited && !deadline.expired && !(__FAMILIAR_MUTATIONS__ && mutant('relaunch-races-exit'))) {
          let stop: (() => void) | undefined;
          await Promise.race([run.exit, deadline.over, new Promise<void>((r) => (stop = this.clock.setTimer(r, 2_000, { background: false })))]);
          stop?.();
        }
        const relaunch = refusedOnStdio && !answered && !!run.exited && !deadline.expired;
        this.endRun(run, listed.failure, false);
        return { ok: false, failure: listed.failure, ...(relaunch ? { relaunch: 'modern' as const } : {}) };
      }
      run.ready = true;
      return { ok: true, run: run.id, tools: run.tools };
    } catch (e) {
      // Nothing a server sends may throw out of a start: whatever did ends the run, in words.
      const failure = unexpected(e);
      this.endRun(run, failure, false);
      return { ok: false, failure };
    } finally {
      cancel?.();
    }
  }

  /** Ends the run: a local server is stopped (its exit ends the run); a remote run ends at once. */
  async stop(): Promise<void> {
    const run = this.run;
    if (!run || run.ended) return;
    // The fence, before any await: a local Stop waits for the exe and the exit, and nothing may be
    // admitted to the stopping server meanwhile (a walk's next page, a call, an idle ping's pong).
    if (!(__FAMILIAR_MUTATIONS__ && mutant('no-stop-fence'))) {
      run.closing = true;
      run.ready = false;
      // The live exchange ends in this same step ("interrupted"): no pong or reply of it is taken after
      // Stop. Its native writes still end only at the exit.
      const ex = this.slot.ex;
      if (ex && ex.phase === 'live' && this.pending.get(ex.n)?.run === run) this.input({ t: 'terminal', n: ex.n, end: { t: 'run-ended' } });
    }
    // The run's end answers a call in flight "interrupted, it may have partly run" (3.11).
    if (run.target.where === 'local') {
      // A native start still pending is waited out first: the start itself then stops what it started.
      if (run.process === undefined) await run.launched;
      if (run.process === undefined) return;
      // Waits for the exe's answer and the exit, with no deadline of its own (5.4): Stop answers only once
      // the process is gone. One native stop per run, whoever asks first. A stop the exe refuses answers
      // once the run has ended; its writes, and the slot, still wait for the exit (H1).
      if (!run.exited) {
        const asked = await this.stopProcess(run).then(
          () => true,
          () => false
        );
        await (asked && !(__FAMILIAR_MUTATIONS__ && mutant('stop-before-exit')) ? run.exit : run.over);
      }
      await run.over;
      return;
    }
    if ((__FAMILIAR_MUTATIONS__ && mutant('delete-at-stop'))) {
      const t = run.target as Extract<Target, { where: 'remote' }>;
      void this.ports.net!.fetch({ id: randomId(), address: t.address, url: t.url, method: 'DELETE' as 'POST', headers: this.headers(run, undefined) }, new Uint8Array(0)).catch(() => {});
    }
    this.endRun(run, { kind: 'exited', words: 'The server was stopped.' }, false);
  }

  /** The tool list again (Test, or after list_changed). A failed walk ends the run. */
  async list(): Promise<readonly ListedTool[] | Failure> {
    const run = this.run;
    if (this.stuck) return this.stuck;
    if (!run || run.ended || !run.ready) return { kind: 'failed', words: 'The server is not running.' };
    // One walk at a time: one under way (between its pages the slot is idle) answers busy too.
    if (this.busy || (run.walker && !(__FAMILIAR_MUTATIONS__ && mutant('walk-beside-walk')))) return { kind: 'busy', words: 'The server is busy. Try again in a moment.' };
    const { deadline, cancel } = this.deadline(run, this.limits.listMs);
    try {
      const r = await this.walk(run, deadline).catch((e: unknown) => ({ failure: unexpected(e) }));
      if ('tools' in r) {
        this.events.listed?.(run.id, r.tools);
        return r.tools;
      }
      // A 404 on a page: the session's recovery is under way (3.8), and decides the run's end.
      if ('session' in r && r.session && !(__FAMILIAR_MUTATIONS__ && mutant('end-on-refresh-404'))) return r.failure;
      this.endRun(run, r.failure, true);
      return r.failure;
    } finally {
      cancel?.();
    }
  }

  /** A deadline for a start, a walk or a re-handshake: when it passes, the step under way ends. */
  private deadline(run: Run, ms: number): { readonly deadline: Deadline; readonly cancel: () => void } {
    let fire!: () => void;
    const deadline: Deadline = { expired: false, over: new Promise<void>((r) => (fire = r)) };
    const cancel = this.clock.setTimer(() => {
      deadline.expired = true;
      fire();
      const ex = this.slot.ex;
      if (ex && ex.phase === 'live' && this.pending.get(ex.n)?.run === run && ex.kind !== 'pong') this.input({ t: 'terminal', n: ex.n, end: { t: 'timeout' } });
    }, ms, { background: false });
    return { deadline, cancel: () => cancel?.() };
  }

  /* ---------- calls: the synchronous handoff ---------- */

  /**
   * Hands a call off, synchronously: the caller (client.ts) has checked the decision in the same step,
   * and the body comes from it. Returns undefined if the slot isn't Idle or the run isn't Ready, with
   * nothing sent; otherwise the call's outcome, once it ends. `ms` is the call's time limit.
   */
  handoff(name: string, canonicalArguments: string, signal: AbortSignal, ms: number): Promise<CallOutcome> | undefined {
    const run = this.run;
    if (!run || run.ended || run.closing || !run.ready || run.stale || this.busy) return undefined;
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
    const n = this.slot.ex!.n;
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
    const r = this.run;
    return !!r && r.id === run && !r.ended && !r.closing && r.ready && !r.stale && r.tools.some((t) => t.name === tool && t.fingerprint === fingerprint);
  }

  private callOutcome(run: Run, o: Outcome): CallOutcome {
    const end = o.end;
    if (end.t === 'done' && o.response) {
      const r = o.response;
      if (r.error) {
        if (run.era === 'modern' && r.error.code === -32022) {
          // The server changed its mind about the era: the run ends, with its versions in words.
          this.endRun(run, refusedWords(r.error), true);
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

  /* ---------- the handshake and the walk ---------- */

  private async handshake(run: Run, deadline: Deadline, opening = true): Promise<Failure | undefined> {
    const id = run.nextId++;
    const init = await this.exchange(run, 'initialize', id, frame({ kind: 'initialize', id }, 'legacy', run.target.where), deadline, 'initialize');
    if (deadline.expired) return { kind: 'timed-out', words: "The server didn't finish starting in time." };
    if (init.end.t !== 'done' || !init.response) return this.startWords(run, init.end);
    const r = init.response;
    if (r.error) {
      // The opening's classifier (3.3): a -32022 naming 2026-07-28 and no legacy version Familiar speaks
      // makes this run modern. There's no new exchange: no discover, no initialized, straight to the list.
      // Only on a run's opening: a re-handshake never changes an established run's era. There, the refusal
      // ends the run, and Start opens a new one.
      if (opening && (modernRefusal(r.error) || (__FAMILIAR_MUTATIONS__ && mutant('modern-on-any-error')))) {
        run.era = 'modern';
        if (init.offered !== undefined && (__FAMILIAR_MUTATIONS__ && mutant('session-id-on-modern'))) run.sessionId = init.offered;
        else delete run.sessionId;
        // The mutant keeps sending initialized on a modern run.
        if ((__FAMILIAR_MUTATIONS__ && mutant('initialized-on-modern'))) await this.exchange(run, 'initialized', undefined, frame({ kind: 'initialized' }, 'legacy', run.target.where), deadline, 'notifications/initialized');
        return undefined;
      }
      return refusedWords(r.error);
    }
    let info;
    try {
      info = initializeResult(r.result ?? {});
    } catch (e) {
      return { kind: 'protocol', words: `The server's answer to the handshake was wrong: ${(e as Error).message}.`, ...(run.last.text() ? { lastOutput: run.last.text()! } : {}) };
    }
    run.version = info.protocolVersion;
    const sent = await this.exchange(run, 'initialized', undefined, frame({ kind: 'initialized' }, 'legacy', run.target.where), deadline, 'notifications/initialized');
    if (deadline.expired) return { kind: 'timed-out', words: "The server didn't finish starting in time." };
    if (sent.end.t !== 'done') return this.startWords(run, sent.end);
    return undefined;
  }

  /**
   * The tool list, published only if no list_changed came while it was walked: otherwise it's walked
   * again, from the first page, within the same deadline, and a server whose tools keep changing fails the
   * walk rather than leave a catalog Familiar knows is stale.
   */
  private async walk(run: Run, deadline: Deadline): Promise<{ readonly tools: readonly ListedTool[] } | { readonly failure: Failure; readonly session?: true; readonly answered?: true }> {
    // This walk owns the run's list until it ends: a list_changed meanwhile only counts, and its retry
    // absorbs it. A session the server ends meanwhile ends the walk before it sends anything more.
    const me = {};
    run.walker = me;
    const session = run.session;
    try {
      for (let attempt = 0; ; attempt++) {
        const at = run.changes;
        run.stale = true;
        const r = await this.walkOnce(run, deadline, session);
        if (!('tools' in r)) return r;
        if (run.changes !== at && !(__FAMILIAR_MUTATIONS__ && mutant('publish-stale-walk'))) {
          if (attempt >= 2) return { failure: { kind: 'protocol', words: "The server's tools kept changing while Familiar listed them." } };
          continue;
        }
        run.tools = r.tools;
        run.declarations = r.declarations;
        run.notOffered = r.notOffered;
        run.stale = false;
        return { tools: run.tools };
      }
    } finally {
      if (run.walker === me) run.walker = undefined;
    }
  }

  /** Pages of tools/list, each its own exchange through the barrier, at most 16, and 128 tools in all. */
  private async walkOnce(run: Run, deadline: Deadline, session: number): Promise<{ readonly tools: ListedTool[]; readonly declarations: Map<string, readonly HeaderDeclaration[]>; readonly notOffered: { name: string; reason: string }[] } | { readonly failure: Failure; readonly session?: true; readonly answered?: true }> {
    const raw: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) return { failure: { kind: 'protocol', words: `The server's tool list ran past ${MAX_PAGES} pages.` } };
      const id = run.nextId++;
      const msg: AdminMessage = { kind: 'list', id, ...(cursor !== undefined ? { cursor } : {}) };
      const o = await this.exchange(run, 'list', id, frame(msg, run.era, run.target.where), deadline, 'tools/list', session);
      if (deadline.expired) return { failure: { kind: 'timed-out', words: run.ready ? "The server's tool list didn't arrive in time." : "The server didn't finish starting in time." } };
      if (o.end.t !== 'done' || !o.response) return { failure: this.startWords(run, o.end), ...(o.end.t === 'session-ended' ? { session: true } : {}) };
      if (o.response.error) {
        // An answer, not a closed pipe: the server's own word, which decides (no relaunch follows it).
        if (run.era === 'modern' && o.response.error.code === -32022) return { failure: refusedWords(o.response.error), answered: true };
        return { failure: { kind: 'protocol', words: `The server refused to list its tools: ${o.response.error.message}` }, answered: true };
      }
      let p;
      try {
        p = listResult(o.response.result ?? {}, run.era);
      } catch (e) {
        return { failure: { kind: 'protocol', words: `The server's tool list was wrong: ${(e as Error).message}.` } };
      }
      // Bounded before anything is kept: every listed tool counts, offered or not.
      if (raw.length + p.tools.length > MAX_TOOLS) return { failure: { kind: 'protocol', words: `The server lists more than ${MAX_TOOLS} tools. Familiar takes at most ${MAX_TOOLS}.` } };
      for (const t of p.tools) raw.push(t);
      cursor = p.nextCursor;
      if (cursor === undefined) break;
    }
    // Every listed tool is bounded before any is scanned (names, shape, bytes, the whole list): one that
    // isn't offered still can't share a name with one that is, nor outgrow the bounds unchecked.
    if (!(__FAMILIAR_MUTATIONS__ && mutant('bound-offered-only'))) {
      try {
        boundTools(raw as never);
      } catch (e) {
        if (e instanceof CatalogError) return { failure: e.failure };
        throw e;
      }
    }
    // A modern remote run mirrors declared arguments into headers: a tool whose declarations break the
    // rules isn't offered, and Test says why (3.5). The tool's fingerprint covers its declarations and the
    // era, since they change what goes on the wire: the same tool listed by a legacy run is another tool.
    const offered: Record<string, unknown>[] = [];
    const notOffered: { name: string; reason: string }[] = [];
    const declarations = new Map<string, readonly HeaderDeclaration[]>();
    for (const t of raw) {
      if (run.era === 'modern' && run.target.where === 'remote') {
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
      return { tools: checkTools(offered as never, run.era === 'modern' && run.target.where === 'remote' ? { declarations } : {}), declarations, notOffered };
    } catch (e) {
      if (e instanceof CatalogError) return { failure: e.failure };
      throw e;
    }
  }

  /* ---------- exchanges ---------- */

  /** One administrative exchange: waits for the slot to be Idle first (the walk's own pages, the handshake). */
  private async exchange(run: Run, kind: ExchangeKind, requestId: number | undefined, body: string, deadline: Deadline, method: string, session?: number): Promise<Outcome> {
    // A local idle ping can take the slot between two of the walk's own steps: wait for it too, but never
    // past the step's deadline, whatever a server keeps sending.
    for (;;) {
      if (!this.early(kind)) await Promise.race([this.drained(), deadline.over, ...((__FAMILIAR_MUTATIONS__ && mutant('forget-exhaustion')) ? [] : [this.stuckAt])]);
      if (this.stuck && !(__FAMILIAR_MUTATIONS__ && mutant('forget-exhaustion'))) return { end: { t: 'run-ended' } };
      if (deadline.expired) return { end: { t: 'timeout' } };
      if (run.ended || run.closing) return { end: { t: 'run-ended' } };
      // A walk begun under a session the server has since ended: nothing more of it goes out.
      if (session !== undefined && run.session !== session && !(__FAMILIAR_MUTATIONS__ && mutant('walk-across-recovery'))) return { end: { t: 'session-ended' } };
      const started = this.exchangeNow(run, kind, requestId, body, method);
      if (started) return started;
    }
  }

  /** Only under a named mutation: admitting before the slot has drained. */
  private early(kind: ExchangeKind): boolean {
    const ex = this.slot.ex;
    return ex?.phase === 'draining' && ((__FAMILIAR_MUTATIONS__ && mutant('admit-while-draining')) || (kind === 'list' && ex.kind === 'list' && (__FAMILIAR_MUTATIONS__ && mutant('page-before-drain'))));
  }

  /** Admits and hands off in one synchronous step, or undefined if the slot isn't Idle. */
  private exchangeNow(run: Run, kind: ExchangeKind, requestId: number | undefined, body: string, method?: string, extra?: readonly (readonly [string, string])[]): Promise<Outcome> | undefined {
    if (this.busy && !this.early(kind)) return undefined;
    if (run.ended || run.closing) return Promise.resolve({ end: { t: 'run-ended' } });
    let resolve!: (o: Outcome) => void;
    const promise = new Promise<Outcome>((r) => (resolve = r));
    const n = this.slot.next;
    this.pending.set(n, { n, kind, run, ...(requestId !== undefined ? { requestId } : {}), body, done: resolve, ...(method ? { method } : {}), ...(extra ? { extra } : {}) });
    this.input({ t: 'admit', kind, where: run.target.where, era: run.era, ...(requestId !== undefined ? { requestId } : {}) });
    return promise;
  }

  /** Feeds the machine one input and does its effects, synchronously. */
  private input(input: Input): void {
    const s = step(this.slot, input);
    this.slot = s.slot;
    for (const e of s.effects) this.effect(e);
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
        p.done({ end: e.end, ...(p.response ? { response: p.response } : {}), ...(p.offeredSession !== undefined ? { offered: p.offeredSession } : {}) });
        // The first page or call after a re-handshake that completes without a 404 rearms the bound (3.8).
        // Rearmed only by a page or call after the recovery, not by the re-handshake's own walk.
        if (e.end.t === 'done' && (p.kind === 'list' || p.kind === 'call') && (p.run.ready || (__FAMILIAR_MUTATIONS__ && mutant('rearm-in-recovery')))) p.run.dropped = 0;
        if (e.end.t === 'session-ended') this.sessionDropped(p.run);
        return;
      }
      case 'idle': {
        this.pending.delete(e.n);
        for (const [h] of [...this.natives]) if (h.startsWith(`${e.n}:`)) this.natives.delete(h);
        const waiters = this.idle.splice(0);
        for (const w of waiters) w();
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

  private write(run: Run, handle: string, text: string, request: Pending | undefined): void {
    if (run.ended || run.process === undefined) {
      // No run to write to: the write ends at once.
      queueMicrotask(() => this.input({ t: 'released', handle }));
      return;
    }
    // The page's watchdog on this write: past the bound, the server has stopped reading.
    const watchdog = (__FAMILIAR_MUTATIONS__ && mutant('no-write-bound'))
      ? undefined
      : this.clock.setTimer(() => this.endRun(run, { kind: 'protocol', words: 'The server stopped reading what Familiar sent, so it was stopped.' }, true), this.limits.writeMs, { background: false });
    this.ports.processes!.write(run.process, enc.encode(`${text}\n`)).then(
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

  private processEvent(run: Run, e: ProcessEvent): void {
    if (e.t === 'exit') {
      run.exited = true;
      run.sawExit();
      if (run.ended) return this.releaseWrites(run);
      this.endRun(run, exitFailure(e.code, run.last.text()), true);
      return;
    }
    if (run.ended) return;
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

  private headers(run: Run, method: string | undefined): [string, string][] {
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

  private post(run: Run, handle: string, text: string, request: Pending | undefined): void {
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
      headersMs: pong ? this.limits.pongMs : this.limits.headersMs,
      idleMs: pong ? this.limits.pongMs : this.limits.idleMs
    };
    this.ports.net!.fetch(spec, enc.encode(text)).then(
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
        // For good: the slot stays held until a restart. Every later Start, and an exchange waiting for the
        // slot (a start parked between its handshake's steps), answers with these words.
        const failure: Failure = { kind: 'protocol', words: "Familiar couldn't end a request to the server. Restart Familiar to use it again." };
        this.stuck = failure;
        const run = this.run;
        if (run && !run.ended) this.endRun(run, failure, true);
        this.stuckNow();
      }
    );
  }

  /** A request's head and body. */
  private async response(run: Run, p: Pending, id: string, head: NetHead): Promise<void> {
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
  private remoteMessage(run: Run, p: Pending, text: string, status?: number): boolean {
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
  private inbound(run: Run, m: Inbound, remote: boolean, on?: Pending): boolean {
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
      else if (!remote && !this.busy && !run.closing) this.idlePing(run, m.id);
      else if (ex && ex.phase === 'draining' && !remote) this.input({ t: 'ping', n: ex.n, id: m.id });
      return false;
    }
    if (m.method === 'notifications/tools/list_changed' && run.era === 'legacy') {
      run.stale = true;
      run.changes++;
      // Idle: walk now; otherwise after the exchange that carried it. A burst is one more walk, and a walk
      // under way when it comes walks again on its own.
      const beside = !!(__FAMILIAR_MUTATIONS__ && mutant('walk-beside-walk'));
      if (run.ready && !run.relisting && (!run.walker || beside)) {
        run.relisting = true;
        void this.drained().then(() => {
          run.relisting = false;
          return run.ended || !run.stale || (run.walker && !beside) ? undefined : this.list();
        });
      }
    }
    return false;
  }

  /** A local ping with no live exchange: answered as an exchange of its own, one write. */
  private idlePing(run: Run, id: RpcId): void {
    const n = this.slot.next;
    this.pending.set(n, { n, kind: 'pong', run, body: frame({ kind: 'pong', id }, run.era, 'local'), done: () => {} });
    this.input({ t: 'admit', kind: 'pong', where: 'local', era: run.era });
  }

  /* ---------- a remote session that ended (3.8) ---------- */

  /**
   * A 404 on a request that carried the session id: the server ended the session. The call that met it
   * isn't resent. The next exchange is one fresh handshake (initialize with no session id, the new id on
   * `initialized` onward), then the tool list; calls are refused busy meanwhile. A second drop before a
   * page or a call has completed since, or a failed re-handshake, ends the run.
   */
  private sessionDropped(run: Run): void {
    if (run.ended || run.closing) return;
    if ((run.dropped > 0 || !run.ready) && !(__FAMILIAR_MUTATIONS__ && mutant('rehandshake-every-404'))) {
      this.endRun(run, { kind: 'http', words: 'The server ended its session.' }, true);
      return;
    }
    run.dropped = 1;
    run.session++;
    if (!(__FAMILIAR_MUTATIONS__ && mutant('ready-during-recovery'))) {
      run.ready = false;
      run.stale = true;
    }
    const resend = (__FAMILIAR_MUTATIONS__ && mutant('resend-404-call')) && run.lastCall ? run.lastCall.body : undefined;
    if (!(__FAMILIAR_MUTATIONS__ && mutant('keep-old-session-id'))) delete run.sessionId;
    delete run.version;
    void (async () => {
      const { deadline, cancel } = this.deadline(run, this.limits.startMs);
      try {
        const failure = run.ended ? undefined : await this.handshake(run, deadline, !!(__FAMILIAR_MUTATIONS__ && mutant('era-change-on-recovery')));
        if (run.ended) return;
        if (failure) return this.endRun(run, { kind: 'http', words: 'The server ended its session.' }, true);
        const listed = await this.walk(run, deadline);
        if (run.ended) return;
        if (!('tools' in listed)) {
          // The mutant's own re-handshake for the walk's 404 is already under way.
          if (/ended its session/.test(listed.failure.words) && (__FAMILIAR_MUTATIONS__ && mutant('rehandshake-every-404'))) return;
          return this.endRun(run, { kind: 'http', words: 'The server ended its session.' }, true);
        }
        run.ready = true;
        this.events.listed?.(run.id, run.tools);
        if (resend) {
          await this.drained();
          void this.exchangeNow(run, 'call', run.nextId++, resend, 'tools/call');
        }
      } finally {
        cancel?.();
      }
    })().catch((e: unknown) => this.endRun(run, unexpected(e), true));
  }

  /* ---------- the run's end ---------- */

  private endRun(run: Run, failure: Failure, report: boolean): void {
    if (run.ended) return;
    run.ended = true;
    run.ready = false;
    run.failure = failure;
    run.finish();
    const ex = this.slot.ex;
    if (ex && ex.phase === 'live' && this.pending.get(ex.n)?.run === run) this.input({ t: 'terminal', n: ex.n, end: { t: 'run-ended' } });
    if (run.target.where === 'local') {
      // A local run that ends with its process still running stops it, whatever ended it; its writes end
      // when the exe says the process has exited, not before, so a blocked write keeps the slot (H1).
      // Remote requests end through net_cancel.
      // A refused stop releases nothing: the writes end only when the exe says the process has exited.
      if (run.process !== undefined && !run.exited) void this.stopProcess(run).catch(() => ((__FAMILIAR_MUTATIONS__ && mutant('release-on-refused-cancel')) ? this.releaseWrites(run) : undefined));
      else this.releaseWrites(run);
    }
    if (report) this.events.ended(run.id, failure);
  }

  /** The run's one native stop: asked the first time, the same answer after. */
  private stopProcess(run: Run): Promise<void> {
    if ((__FAMILIAR_MUTATIONS__ && mutant('stop-twice'))) return this.ports.processes!.stop(run.process!);
    return (run.stopCall ??= this.ports.processes!.stop(run.process!));
  }

  /** A local run's process is gone: its exchange's writes have ended. */
  private releaseWrites(run: Run): void {
    const ex = this.slot.ex;
    if (ex && this.pending.get(ex.n)?.run === run) for (const h of [...ex.open]) this.input({ t: 'released', handle: h });
  }

  private exitWords(run: Run): Failure {
    return exitFailure(undefined, run.last.text());
  }

  private startWords(run: Run, end: End): Failure {
    if (end.t === 'run-ended') return run.failure ?? (run.target.where === 'local' ? protocolFailure(run.last.text()) : { kind: 'exited', words: 'The connection to the server closed.' });
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

