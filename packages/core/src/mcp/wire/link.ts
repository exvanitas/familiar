// One server's link: Familiar's own MCP client for it (docs/mcp-design.md 3.1 to 3.11). It holds the
// server's exchange slot, which outlives a run, so a Start of the same server waits for nothing: it's
// refused busy until the old run's exchange has drained. For each run (one Start to its end) it holds the
// run id, the era, the negotiated version, the remote session id, and the catalog with its stale bit.
// There's no queue, no second exchange and no timer that isn't an exchange's own.
//
// The effects of the pure exchange machine (exchange.ts) are done here: a remote request is one POST
// through the exe's net_fetch, read with net_read, ended with net_cancel; a local one is one server_write
// of a line. What comes back is checked (parse.ts) and fed to the machine as inputs, in order.

import { checkTools, CatalogError } from '../catalog.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../process.ts';
import { LastOutput } from '../last-output.ts';
import type { CallOutcome, Failure, ListedTool } from '../types.ts';
import { exitFailure, protocolFailure, remoteFailure, startFailure } from '../words.ts';
import { emptySlot, step, type Effect, type End, type ExchangeKind, type Input, type Slot } from './exchange.ts';
import { frame, frameCall, LEGACY_VERSIONS, MODERN_VERSION, type AdminMessage, type Era, type RpcId } from './framing.ts';
import { callResult, EventStream, initializeResult, Invalid, listResult, MAX_HANDSHAKE_BYTES, MAX_MESSAGE_BYTES, parseMessage, resultText, type Inbound } from './parse.ts';

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
}

export const LINK_LIMITS: LinkLimits = { startMs: 60_000, listMs: 30_000, pongMs: 5_000, headersMs: 120_000, idleMs: 15 * 60_000 };
export const MAX_PAGES = 16;
export const MAX_SESSION_ID = 1024;
const DROPPED_LINE = /^a stdout line over \d+ MiB was dropped$/;

export interface LinkEvents {
  /** The run ended: a crash, an exit, a failed walk, a second session drop. Called once per run. */
  ended(run: string, failure: Failure): void;
  /** The catalog changed after a walk. */
  listed?(run: string, tools: readonly ListedTool[]): void;
}

/** What one exchange gave back. */
interface Outcome {
  readonly end: End;
  readonly response?: Extract<Inbound, { t: 'response' }>;
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
  stale: boolean;
  ready: boolean;
  ended: boolean;
  nextId: number;
  /** Re-handshakes since the last exchange that completed without a 404. */
  dropped: number;
  readonly last: LastOutput;
  /** Why the run ended, once it has. */
  failure?: Failure;
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

  /** Whether an exchange holds the slot, Live or Draining. */
  get busy(): boolean {
    return this.slot.ex !== undefined;
  }
  get current(): { readonly run: string; readonly era: Era; readonly ready: boolean; readonly stale: boolean; readonly tools: readonly ListedTool[]; readonly sessionId?: string; readonly version?: string; readonly launch: string } | undefined {
    const r = this.run;
    return r && !r.ended ? { run: r.id, era: r.era, ready: r.ready, stale: r.stale, tools: r.tools, launch: r.launch, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.version ? { version: r.version } : {}) } : undefined;
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
  async start(target: Target, launch: string): Promise<{ readonly ok: true; readonly run: string; readonly tools: readonly ListedTool[] } | { readonly ok: false; readonly failure: Failure }> {
    if (this.busy || (this.run && !this.run.ended)) return { ok: false, failure: { kind: 'busy', words: 'The server is still finishing its last request. Try again in a moment.' } };
    let finish!: () => void;
    const over = new Promise<void>((r) => (finish = r));
    const run: Run = { id: `${this.serverId}#${++this.runs}`, target, launch, era: 'legacy', tools: [], stale: true, ready: false, ended: false, nextId: 1, dropped: 0, last: new LastOutput(), over, finish };
    this.run = run;
    if (target.where === 'local') {
      const processes = this.ports.processes!;
      try {
        const started = await processes.start(target.setup, (e) => this.processEvent(run, e));
        run.process = started.run;
      } catch (e) {
        run.ended = true;
        return { ok: false, failure: startFailure(e, target.setup.program) };
      }
      if (run.ended) return { ok: false, failure: this.exitWords(run) };
    }
    let expired = false;
    const cancel = this.clock.setTimer(() => {
      expired = true;
      const ex = this.slot.ex;
      if (ex && this.pending.get(ex.n)?.run === run) this.input({ t: 'terminal', n: ex.n, end: { t: 'timeout' } });
    }, this.limits.startMs, { background: false });
    try {
      const failure = await this.handshake(run, () => expired);
      if (failure) {
        this.endRun(run, failure, false);
        return { ok: false, failure };
      }
      const listed = await this.walk(run, () => expired);
      if (!('tools' in listed)) {
        this.endRun(run, listed.failure, false);
        return { ok: false, failure: listed.failure };
      }
      run.ready = true;
      return { ok: true, run: run.id, tools: run.tools };
    } finally {
      cancel?.();
    }
  }

  /** Ends the run: a local server is stopped (its exit ends the run); a remote run ends at once. */
  async stop(): Promise<void> {
    const run = this.run;
    if (!run || run.ended) return;
    // The run's end answers a call in flight "interrupted, it may have partly run" (3.11).
    if (run.target.where === 'local' && run.process !== undefined) {
      // Waits for the exe's answer and the exit, with no deadline of its own (5.4).
      await this.ports.processes!.stop(run.process).catch(() => {});
      await run.over;
      return;
    }
    this.endRun(run, { kind: 'exited', words: 'The server was stopped.' }, false);
  }

  /** The tool list again (Test, or after list_changed). A failed walk ends the run. */
  async list(): Promise<readonly ListedTool[] | Failure> {
    const run = this.run;
    if (!run || run.ended || !run.ready) return { kind: 'failed', words: 'The server is not running.' };
    if (this.busy) return { kind: 'busy', words: 'The server is busy. Try again in a moment.' };
    let expired = false;
    const cancel = this.clock.setTimer(() => {
      expired = true;
      const ex = this.slot.ex;
      if (ex && this.pending.get(ex.n)?.run === run) this.input({ t: 'terminal', n: ex.n, end: { t: 'timeout' } });
    }, this.limits.listMs, { background: false });
    try {
      const r = await this.walk(run, () => expired);
      if ('tools' in r) {
        this.events.listed?.(run.id, r.tools);
        return r.tools;
      }
      this.endRun(run, r.failure, true);
      return r.failure;
    } finally {
      cancel?.();
    }
  }

  /* ---------- calls: the synchronous handoff ---------- */

  /**
   * Hands a call off, synchronously: the caller (client.ts) has checked the decision in the same step,
   * and the body comes from it. Returns undefined if the slot isn't Idle or the run isn't Ready, with
   * nothing sent; otherwise the call's outcome, once it ends. `ms` is the call's time limit.
   */
  handoff(name: string, canonicalArguments: string, signal: AbortSignal, ms: number): Promise<CallOutcome> | undefined {
    const run = this.run;
    if (!run || run.ended || !run.ready || run.stale || this.busy) return undefined;
    const id = run.nextId++;
    const body = frameCall(id, name, canonicalArguments, run.era, run.target.where);
    const outcome = this.exchangeNow(run, 'call', id, body);
    if (!outcome) return undefined;
    const n = this.slot.ex!.n;
    const timer = this.clock.setTimer(() => this.input({ t: 'terminal', n, end: { t: 'timeout' } }), ms, { background: false });
    const onAbort = () => this.input({ t: 'terminal', n, end: { t: 'stopped' } });
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
    return !!r && r.id === run && !r.ended && r.ready && !r.stale && r.tools.some((t) => t.name === tool && t.fingerprint === fingerprint);
  }

  private callOutcome(run: Run, o: Outcome): CallOutcome {
    const end = o.end;
    if (end.t === 'done' && o.response) {
      const r = o.response;
      if (r.error) return { kind: 'result', text: `The server answered with an error: ${r.error.message}`, isError: true };
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

  private async handshake(run: Run, expired: () => boolean): Promise<Failure | undefined> {
    const id = run.nextId++;
    const init = await this.exchange(run, 'initialize', id, frame({ kind: 'initialize', id }, 'legacy', run.target.where));
    if (expired()) return { kind: 'timed-out', words: "The server didn't finish starting in time." };
    if (init.end.t !== 'done' || !init.response) return this.startWords(run, init.end);
    const r = init.response;
    if (r.error) return refusedWords(r.error);
    let info;
    try {
      info = initializeResult(r.result ?? {});
    } catch (e) {
      return { kind: 'protocol', words: `The server's answer to the handshake was wrong: ${(e as Error).message}.`, ...(run.last.text() ? { lastOutput: run.last.text()! } : {}) };
    }
    run.version = info.protocolVersion;
    const sent = await this.exchange(run, 'initialized', undefined, frame({ kind: 'initialized' }, 'legacy', run.target.where));
    if (expired()) return { kind: 'timed-out', words: "The server didn't finish starting in time." };
    if (sent.end.t !== 'done') return this.startWords(run, sent.end);
    return undefined;
  }

  /** Pages of tools/list, each its own exchange through the barrier, at most 16. */
  private async walk(run: Run, expired: () => boolean): Promise<{ readonly tools: readonly ListedTool[] } | { readonly failure: Failure }> {
    run.stale = true;
    const raw: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) return { failure: { kind: 'protocol', words: `The server's tool list ran past ${MAX_PAGES} pages.` } };
      const id = run.nextId++;
      const msg: AdminMessage = { kind: 'list', id, ...(cursor !== undefined ? { cursor } : {}) };
      const o = await this.exchange(run, 'list', id, frame(msg, run.era, run.target.where));
      if (expired()) return { failure: { kind: 'timed-out', words: "The server's tool list didn't arrive in time." } };
      if (o.end.t !== 'done' || !o.response) return { failure: this.startWords(run, o.end) };
      if (o.response.error) return { failure: { kind: 'protocol', words: `The server refused to list its tools: ${o.response.error.message}` } };
      let p;
      try {
        p = listResult(o.response.result ?? {}, run.era);
      } catch (e) {
        return { failure: { kind: 'protocol', words: `The server's tool list was wrong: ${(e as Error).message}.` } };
      }
      raw.push(...p.tools);
      cursor = p.nextCursor;
      if (cursor === undefined) break;
    }
    try {
      run.tools = checkTools(raw as never);
    } catch (e) {
      if (e instanceof CatalogError) return { failure: e.failure };
      throw e;
    }
    run.stale = false;
    return { tools: run.tools };
  }

  /* ---------- exchanges ---------- */

  /** One administrative exchange: waits for the slot to be Idle first (the walk's own pages, the handshake). */
  private async exchange(run: Run, kind: ExchangeKind, requestId: number | undefined, body: string): Promise<Outcome> {
    // A local idle ping can take the slot between two of the walk's own steps: wait for it too.
    for (;;) {
      await this.drained();
      if (run.ended) return { end: { t: 'run-ended' } };
      const started = this.exchangeNow(run, kind, requestId, body);
      if (started) return started;
    }
  }

  /** Admits and hands off in one synchronous step, or undefined if the slot isn't Idle. */
  private exchangeNow(run: Run, kind: ExchangeKind, requestId: number | undefined, body: string): Promise<Outcome> | undefined {
    if (this.busy) return undefined;
    let resolve!: (o: Outcome) => void;
    const promise = new Promise<Outcome>((r) => (resolve = r));
    const n = this.slot.next;
    this.pending.set(n, { n, kind, run, ...(requestId !== undefined ? { requestId } : {}), body, done: resolve });
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
        p.done({ end: e.end, ...(p.response ? { response: p.response } : {}) });
        // The first page or call after a re-handshake that completes without a 404 rearms the bound (3.8).
        if (e.end.t === 'done' && (p.kind === 'list' || p.kind === 'call')) p.run.dropped = 0;
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
    this.ports.processes!.write(run.process, enc.encode(`${text}\n`)).then(
      () => this.input({ t: 'released', handle }),
      (err: unknown) => {
        if (request) this.input({ t: 'terminal', n: request.n, end: { t: 'native', kind: kindText(err) } });
        this.input({ t: 'released', handle });
      }
    );
  }

  private processEvent(run: Run, e: ProcessEvent): void {
    if (run.ended) return;
    if (e.t === 'exit') {
      this.endRun(run, exitFailure(e.code, run.last.text()), true);
      return;
    }
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
      m = parseMessage(e.line, MAX_MESSAGE_BYTES);
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

  private headers(run: Run, kind: 'request' | 'pong' | 'notification'): [string, string][] {
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
    if (run.version) set('MCP-Protocol-Version', run.version);
    if (run.sessionId) set('Mcp-Session-Id', run.sessionId);
    void kind;
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
      headers: this.headers(run, pong ? 'pong' : 'request'),
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

  private cancel(handle: string): void {
    const id = this.natives.get(handle);
    if (id === undefined) return this.input({ t: 'released', handle });
    this.ports.net!.cancel(id).then(
      () => this.input({ t: 'released', handle }),
      () => this.input({ t: 'released', handle })
    );
  }

  /** A request's head and body. */
  private async response(run: Run, p: Pending, id: string, head: NetHead): Promise<void> {
    const live = () => this.slot.ex?.n === p.n && this.slot.ex.phase === 'live';
    if (!live()) return;
    if (head.redirected || (head.status >= 300 && head.status < 400)) return this.input({ t: 'terminal', n: p.n, end: { t: 'redirected', status: head.status } });
    if (head.status === 404 && p.carriedSession) return this.input({ t: 'terminal', n: p.n, end: { t: 'session-ended' } });
    const type = (head.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '').toLowerCase();
    if (head.status === 202 && p.kind === 'initialized') return this.input({ t: 'completed', n: p.n });
    const ok = head.status >= 200 && head.status < 300;
    // The opening's classifier (3.3): a JSON-RPC error body for this request decides first, whatever the status.
    if (!ok && p.kind !== 'initialize') return this.input({ t: 'terminal', n: p.n, end: { t: 'http', status: head.status } });
    if (p.kind === 'initialize' && run.target.where === 'remote' && ok) {
      const sid = head.headers.filter(([k]) => k.toLowerCase() === 'mcp-session-id');
      if (sid.length > 1 || (sid.length === 1 && !/^[\x21-\x7e]{1,1024}$/.test(sid[0]![1]))) return this.input({ t: 'terminal', n: p.n, end: { t: 'invalid', why: 'a session id Familiar can\'t use' } });
      // Adopted only if the answer turns out to be a successful initialize (below).
      if (sid[0]) p.offeredSession = sid[0][1];
    }
    const events = type.startsWith('text/event-stream') ? new EventStream(p.kind === 'initialize' ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES) : undefined;
    let json = '';
    try {
      for (;;) {
        const chunk = await this.ports.net!.read(id);
        if (!live()) return;
        if (chunk.length === 0) break;
        if (events) {
          for (const data of events.push(chunk)) if (this.remoteMessage(run, p, data)) return;
        } else {
          json += new TextDecoder().decode(chunk, { stream: true });
          if (json.length > (p.kind === 'initialize' ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES)) throw new Invalid('a response past its size bound');
        }
      }
      if (events) {
        for (const data of events.end()) if (this.remoteMessage(run, p, data)) return;
        return this.input({ t: 'terminal', n: p.n, end: { t: 'stream-ended' } });
      }
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
      m = parseMessage(text, p.kind === 'initialize' ? MAX_HANDSHAKE_BYTES : MAX_MESSAGE_BYTES);
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
      if (!mine || mine.requestId === undefined || m.id !== mine.requestId) return false;
      mine.response = m;
      if (mine.kind === 'initialize' && !m.error && mine.offeredSession !== undefined) run.sessionId = mine.offeredSession;
      this.input({ t: 'completed', n: mine.n });
      return true;
    }
    if (m.t === 'request') {
      // Only a legacy ping is answered; any other request gets no reply (Familiar declares no capabilities).
      if (m.method !== 'ping' || run.era !== 'legacy') return false;
      if (mine) this.input({ t: 'ping', n: mine.n, id: m.id });
      else if (!remote && !this.busy) this.idlePing(run, m.id);
      else if (ex && ex.phase === 'draining' && !remote) this.input({ t: 'ping', n: ex.n, id: m.id });
      return false;
    }
    if (m.method === 'notifications/tools/list_changed' && run.era === 'legacy') {
      run.stale = true;
      // Idle: walk now; otherwise after the exchange that carried it.
      if (run.ready) void this.drained().then(() => (run.ended || !run.stale ? undefined : this.list()));
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
    if (run.ended) return;
    if (run.dropped > 0 || !run.ready) {
      this.endRun(run, { kind: 'http', words: 'The server ended its session.' }, true);
      return;
    }
    run.dropped = 1;
    run.ready = false;
    run.stale = true;
    delete run.sessionId;
    delete run.version;
    void (async () => {
      let expired = false;
      const cancel = this.clock.setTimer(() => {
        expired = true;
        const ex = this.slot.ex;
        if (ex && this.pending.get(ex.n)?.run === run) this.input({ t: 'terminal', n: ex.n, end: { t: 'timeout' } });
      }, this.limits.startMs, { background: false });
      try {
        await this.drained();
        const failure = run.ended ? undefined : await this.handshake(run, () => expired);
        if (run.ended) return;
        if (failure) return this.endRun(run, { kind: 'http', words: 'The server ended its session.' }, true);
        const listed = await this.walk(run, () => expired);
        if (run.ended) return;
        if (!('tools' in listed)) return this.endRun(run, { kind: 'http', words: 'The server ended its session.' }, true);
        run.ready = true;
        this.events.listed?.(run.id, run.tools);
      } finally {
        cancel?.();
      }
    })();
  }

  /* ---------- the run's end ---------- */

  private endRun(run: Run, failure: Failure, report: boolean): void {
    if (run.ended) return;
    run.ended = true;
    run.ready = false;
    run.failure = failure;
    run.finish();
    const ex = this.slot.ex;
    if (ex && this.pending.get(ex.n)?.run === run) {
      if (ex.phase === 'live') this.input({ t: 'terminal', n: ex.n, end: { t: 'run-ended' } });
      // A local run's end ends its writes; remote requests still end through net_cancel.
      if (run.target.where === 'local') for (const h of [...(this.slot.ex?.open ?? [])]) this.input({ t: 'released', handle: h });
    }
    if (run.target.where === 'local' && run.process !== undefined && !report) void this.ports.processes!.stop(run.process).catch(() => {});
    if (report) this.events.ended(run.id, failure);
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

/** A refused handshake, with the server's own versions in words when it named them. */
function refusedWords(error: { code: number; message: string; data?: unknown }): Failure {
  const supported = (error.data as { supported?: unknown } | undefined)?.supported;
  if (error.code === -32022 && Array.isArray(supported) && supported.every((v) => typeof v === 'string')) {
    const list = (supported as string[]).slice(0, 8).map((v) => v.slice(0, 20)).join(', ');
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

function kindText(e: unknown): string {
  const k = e !== null && typeof e === 'object' && 'kind' in e ? (e as { kind: unknown }).kind : undefined;
  const c = e instanceof Error && e.cause && typeof e.cause === 'object' && 'kind' in e.cause ? (e.cause as { kind: unknown }).kind : undefined;
  return typeof k === 'string' ? k : typeof c === 'string' ? c : 'network';
}

