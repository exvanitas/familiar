// One MCP server's rules, as a pure function: a state and a message in, the changed state and a list of
// effects out. The actor (actor.ts) is the only owner of a Machine: it feeds every command and event
// through `step`, one at a time, and does the effects. Nothing here waits or touches I/O, so a property
// test can drive it with any order of messages. See "One actor per server" in docs/mcp-design.md.
//
// Every run has a generation. Events and timers carry the generation they belong to, and anything that
// isn't the current one is dropped. A call that was sent belongs to the run it was sent on: when that
// run ends, the call is answered `interrupted` and is never sent again.

import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';

export type Phase = 'stopped' | 'starting' | 'initializing' | 'ready' | 'restarting' | 'down' | 'stopping' | 'removing' | 'removed';

export interface Limits {
  /** A call's deadline when it names none. */
  readonly callMs: number;
  /** The handshake's deadline: from the run starting to the first tool list. */
  readonly initMs: number;
  /** How long a run may take to close before it counts as closed. */
  readonly stopMs: number;
  /** Restarts allowed in the window. One more crash and the server is down. */
  readonly restarts: number;
  readonly restartWindowMs: number;
  /** The pause before a restart. */
  readonly backoffMs: number;
  /** Calls waiting or running at once. */
  readonly maxCalls: number;
}

export const CALL_MS = 60_000;
export const CALL_MS_MIN = 1_000;
export const CALL_MS_MAX = 15 * 60_000;
export const INIT_MS = 120_000;
export const INIT_MS_MIN = 10_000;
export const INIT_MS_MAX = 5 * 60_000;

export const DEFAULT_LIMITS: Limits = {
  callMs: CALL_MS,
  initMs: INIT_MS,
  stopMs: 5_000,
  restarts: 2,
  restartWindowMs: 10 * 60_000,
  backoffMs: 1_000,
  maxCalls: 16
};

interface Call {
  readonly id: number;
  readonly tool: string;
  readonly args: unknown;
  /** The generation it was sent on. Undefined while it waits for the server to be ready. */
  sent?: number;
}

export interface Machine {
  phase: Phase;
  gen: number;
  /** The current run may still be open: it started and hasn't closed, and its stop deadline hasn't passed. */
  open: boolean;
  /** The current run is a restart after a crash, not a start the person made. */
  auto: boolean;
  /** Why the machine itself is ending the current run (the handshake's deadline), if it is. */
  ending?: Failure;
  /** A removal is under way. */
  forgetting: boolean;
  readonly calls: Map<number, Call>;
  readonly starts: number[];
  readonly stops: number[];
  readonly removes: number[];
  /** When each restart in the window was made. */
  crashes: number[];
  failure?: Failure;
  tools: readonly ListedTool[];
  readonly limits: Limits;
}

export type Input =
  | { readonly t: 'start'; readonly token: number }
  | { readonly t: 'stop'; readonly token: number }
  | { readonly t: 'remove'; readonly token: number }
  | { readonly t: 'call'; readonly token: number; readonly tool: string; readonly args: unknown; readonly ms?: number }
  /** The person pressed Stop on one call. */
  | { readonly t: 'cancel'; readonly call: number }
  | { readonly t: 'refresh' }
  /** The run started: the process runs, or the remote transport connected. */
  | { readonly t: 'launched'; readonly gen: number }
  /** The handshake and the first tool list are done. */
  | { readonly t: 'ready'; readonly gen: number; readonly tools: readonly ListedTool[] }
  | { readonly t: 'listed'; readonly gen: number; readonly tools: readonly ListedTool[] }
  | { readonly t: 'tools-changed'; readonly gen: number }
  | { readonly t: 'result'; readonly gen: number; readonly call: number; readonly outcome: CallOutcome }
  /** The run ended, for any reason: an exit, a closed transport, a refused start, a failed handshake. */
  | { readonly t: 'closed'; readonly gen: number; readonly failure?: Failure }
  | { readonly t: 'timer'; readonly key: string }
  | { readonly t: 'forgotten'; readonly failure?: Failure };

export type Effect =
  | { readonly t: 'launch'; readonly gen: number }
  | { readonly t: 'send'; readonly gen: number; readonly call: number; readonly tool: string; readonly args: unknown }
  | { readonly t: 'abort'; readonly gen: number; readonly call: number }
  | { readonly t: 'list'; readonly gen: number }
  | { readonly t: 'halt'; readonly gen: number }
  | { readonly t: 'forget' }
  | { readonly t: 'arm'; readonly key: string; readonly at: number }
  | { readonly t: 'disarm'; readonly key: string }
  | { readonly t: 'answer'; readonly call: number; readonly outcome: CallOutcome }
  | { readonly t: 'reply'; readonly token: number; readonly reply: Reply }
  | { readonly t: 'changed' };

/** The states nothing pending will leave on its own. A failed removal rests too, until the next remove. */
export function resting(m: Machine): boolean {
  if (m.phase === 'removing') return !m.forgetting && m.failure !== undefined;
  return m.phase === 'stopped' || m.phase === 'ready' || m.phase === 'down' || m.phase === 'removed';
}

export function createMachine(limits: Limits = DEFAULT_LIMITS): Machine {
  return {
    phase: 'stopped', gen: 0, open: false, auto: false, forgetting: false,
    calls: new Map(), starts: [], stops: [], removes: [], crashes: [], tools: [], limits
  };
}

const callKey = (id: number) => `call:${id}`;
const initKey = (gen: number) => `init:${gen}`;
const stopKey = (gen: number) => `stop:${gen}`;
const restartKey = (gen: number) => `restart:${gen}`;

const refusal = (reason: 'not-running' | 'stopping' | 'removed' | 'busy' | 'down', words: string): CallOutcome => ({ kind: 'error', reason, words });
const NOT_RUNNING = refusal('not-running', "The server isn't running.");
const STOPPING = refusal('stopping', 'The server is stopping.');
const REMOVED = refusal('removed', 'The server was removed.');
const BUSY = refusal('busy', 'The server has too many calls waiting. Try again in a moment.');

/** Applies one message. Changes `m` and returns what the actor must do, in order. */
export function step(m: Machine, input: Input, now: number): Effect[] {
  const fx: Effect[] = [];
  const before = { phase: m.phase, tools: m.tools, failure: m.failure };
  handle(m, input, now, fx);
  if (m.phase !== before.phase || m.tools !== before.tools || m.failure !== before.failure) fx.push({ t: 'changed' });
  return fx;
}

function handle(m: Machine, input: Input, now: number, fx: Effect[]): void {
  switch (input.t) {
    case 'start': return start(m, input.token, now, fx);
    case 'stop': return stop(m, input.token, now, fx);
    case 'remove': return remove(m, input.token, now, fx);
    case 'call': return call(m, input, now, fx);
    case 'cancel': {
      const c = m.calls.get(input.call);
      if (!c) return;
      if (c.sent !== undefined) fx.push({ t: 'abort', gen: c.sent, call: c.id });
      return answer(m, c, { kind: 'stopped' }, fx);
    }
    case 'refresh':
      if (m.phase === 'ready') fx.push({ t: 'list', gen: m.gen });
      return;
    case 'launched':
      if (input.gen !== m.gen || m.phase !== 'starting') return;
      m.phase = 'initializing';
      fx.push({ t: 'arm', key: initKey(m.gen), at: now + m.limits.initMs });
      return;
    case 'ready':
      if (input.gen !== m.gen || m.phase !== 'initializing' || m.ending) return;
      m.phase = 'ready';
      m.tools = input.tools;
      m.failure = undefined;
      fx.push({ t: 'disarm', key: initKey(m.gen) });
      for (const c of m.calls.values()) {
        c.sent = m.gen;
        fx.push({ t: 'send', gen: m.gen, call: c.id, tool: c.tool, args: c.args });
      }
      return replyAll(m.starts, { kind: 'ready' }, fx);
    case 'listed':
      if (input.gen === m.gen && m.phase === 'ready') m.tools = input.tools;
      return;
    case 'tools-changed':
      if (input.gen === m.gen && m.phase === 'ready') fx.push({ t: 'list', gen: m.gen });
      return;
    case 'result': {
      const c = m.calls.get(input.call);
      if (!c || c.sent !== input.gen) return;
      return answer(m, c, input.outcome, fx);
    }
    case 'closed':
      if (input.gen !== m.gen || !m.open) return;
      return closed(m, input.failure, now, fx);
    case 'timer':
      return timer(m, input.key, now, fx);
    case 'forgotten':
      if (m.phase !== 'removing' || !m.forgetting) return;
      m.forgetting = false;
      if (input.failure) {
        m.failure = input.failure;
        return replyAll(m.removes, { kind: 'failed', failure: input.failure }, fx);
      }
      m.phase = 'removed';
      m.failure = undefined;
      m.tools = [];
      return replyAll(m.removes, { kind: 'removed' }, fx);
  }
}

function start(m: Machine, token: number, now: number, fx: Effect[]): void {
  switch (m.phase) {
    case 'removed': return reply(token, { kind: 'removed' }, fx);
    case 'removing': return reply(token, { kind: 'refused', words: 'The server is being removed.' }, fx);
    case 'ready': return reply(token, { kind: 'ready' }, fx);
    case 'starting': case 'initializing': case 'restarting': case 'stopping':
      m.starts.push(token);
      return;
    case 'stopped': case 'down':
      m.starts.push(token);
      m.crashes = [];
      m.failure = undefined;
      return launch(m, false, fx);
  }
}

function stop(m: Machine, token: number, now: number, fx: Effect[]): void {
  switch (m.phase) {
    case 'removed': return reply(token, { kind: 'removed' }, fx);
    case 'stopped': case 'down': case 'removing': return reply(token, { kind: 'stopped' }, fx);
    case 'stopping':
      m.stops.push(token);
      return;
    case 'restarting':
      // Its run already closed: nothing to halt.
      fx.push({ t: 'disarm', key: restartKey(m.gen) });
      settleCalls(m, () => NOT_RUNNING, fx);
      replyAll(m.starts, { kind: 'stopped' }, fx);
      m.phase = 'stopped';
      return reply(token, { kind: 'stopped' }, fx);
    case 'starting': case 'initializing': case 'ready':
      m.stops.push(token);
      return beginStop(m, now, fx);
  }
}

function remove(m: Machine, token: number, now: number, fx: Effect[]): void {
  switch (m.phase) {
    case 'removed': return reply(token, { kind: 'removed' }, fx);
    case 'removing':
      m.removes.push(token);
      if (!m.forgetting) {
        m.forgetting = true;
        fx.push({ t: 'forget' });
      }
      return;
    case 'stopping':
      m.removes.push(token);
      return;
    case 'starting': case 'initializing': case 'ready':
      m.removes.push(token);
      return beginStop(m, now, fx);
    case 'restarting':
      fx.push({ t: 'disarm', key: restartKey(m.gen) });
      m.removes.push(token);
      return beginRemove(m, fx);
    case 'stopped': case 'down':
      m.removes.push(token);
      return beginRemove(m, fx);
  }
}

function call(m: Machine, input: Extract<Input, { t: 'call' }>, now: number, fx: Effect[]): void {
  const refuse = (o: CallOutcome) => fx.push({ t: 'answer', call: input.token, outcome: o });
  switch (m.phase) {
    case 'removed': case 'removing': return void refuse(REMOVED);
    case 'stopping': return void refuse(STOPPING);
    case 'stopped': return void refuse(m.failure ? refusal('not-running', `The server isn't running. ${m.failure.words}`) : NOT_RUNNING);
    case 'down': return void refuse(refusal('down', "The server is down: it stopped three times in ten minutes. Start it again in Settings."));
  }
  if (m.calls.size >= m.limits.maxCalls) return void refuse(BUSY);
  const c: Call = { id: input.token, tool: input.tool, args: input.args };
  m.calls.set(c.id, c);
  fx.push({ t: 'arm', key: callKey(c.id), at: now + callMs(m.limits, input.ms) });
  if (m.phase === 'ready') {
    c.sent = m.gen;
    fx.push({ t: 'send', gen: m.gen, call: c.id, tool: c.tool, args: c.args });
  }
}

/** A call's deadline in ms, within the limits. */
export function callMs(limits: Limits, ms?: number): number {
  const want = ms === undefined || !Number.isFinite(ms) ? limits.callMs : ms;
  return Math.min(CALL_MS_MAX, Math.max(CALL_MS_MIN, want));
}

function timer(m: Machine, key: string, now: number, fx: Effect[]): void {
  const [kind, n] = key.split(':') as [string, string];
  const id = Number(n);
  if (kind === 'call') {
    const c = m.calls.get(id);
    if (!c) return;
    if (c.sent !== undefined) fx.push({ t: 'abort', gen: c.sent, call: c.id });
    return answer(m, c, { kind: 'timed-out' }, fx);
  }
  if (id !== m.gen) return;
  if (kind === 'init' && m.phase === 'initializing' && !m.ending) {
    // The handshake took too long: end the run, and treat it as closed when it closes or its stop
    // deadline passes.
    m.ending = { kind: 'timed-out', words: `The server didn't finish starting within ${Math.round(m.limits.initMs / 1000)} seconds.` };
    fx.push({ t: 'halt', gen: m.gen }, { t: 'arm', key: stopKey(m.gen), at: now + m.limits.stopMs });
    return;
  }
  if (kind === 'stop' && m.open && (m.phase === 'stopping' || m.ending)) return closed(m, undefined, now, fx);
  if (kind === 'restart' && m.phase === 'restarting') return launch(m, true, fx);
}

/** The current run ended. */
function closed(m: Machine, failure: Failure | undefined, now: number, fx: Effect[]): void {
  m.open = false;
  fx.push({ t: 'disarm', key: initKey(m.gen) }, { t: 'disarm', key: stopKey(m.gen) });
  const why = m.ending ?? failure ?? { kind: 'exited', words: 'The server stopped.' };
  m.ending = undefined;
  switch (m.phase) {
    case 'stopping': return finishStop(m, fx);
    case 'starting': case 'initializing':
      if (m.auto) return crash(m, why, now, fx);
      // The person's own start failed: say why, and don't try again on its own.
      m.phase = 'stopped';
      m.failure = why;
      settleCalls(m, () => refusal('not-running', `The server didn't start. ${why.words}`), fx);
      return replyAll(m.starts, { kind: 'failed', failure: why }, fx);
    case 'ready': return crash(m, why, now, fx);
    default: return;
  }
}

function crash(m: Machine, why: Failure, now: number, fx: Effect[]): void {
  settleCalls(m, c => (c.sent !== undefined ? { kind: 'interrupted' } : undefined), fx);
  m.failure = why;
  m.crashes = m.crashes.filter(t => now - t < m.limits.restartWindowMs);
  if (m.crashes.length < m.limits.restarts) {
    m.crashes.push(now);
    m.phase = 'restarting';
    fx.push({ t: 'arm', key: restartKey(m.gen), at: now + m.limits.backoffMs });
    return;
  }
  m.phase = 'down';
  settleCalls(m, () => refusal('down', `The server is down. ${why.words}`), fx);
  replyAll(m.starts, { kind: 'failed', failure: why }, fx);
}

function launch(m: Machine, auto: boolean, fx: Effect[]): void {
  m.gen++;
  m.open = true;
  m.auto = auto;
  m.ending = undefined;
  m.phase = 'starting';
  fx.push({ t: 'launch', gen: m.gen });
}

function beginStop(m: Machine, now: number, fx: Effect[]): void {
  settleCalls(m, c => (c.sent !== undefined ? { kind: 'interrupted' } : STOPPING), fx);
  replyAll(m.starts, { kind: 'stopped' }, fx);
  m.phase = 'stopping';
  m.ending = undefined;
  fx.push({ t: 'halt', gen: m.gen }, { t: 'arm', key: stopKey(m.gen), at: now + m.limits.stopMs });
}

function finishStop(m: Machine, fx: Effect[]): void {
  replyAll(m.stops, { kind: 'stopped' }, fx);
  if (m.removes.length > 0) return beginRemove(m, fx);
  m.phase = 'stopped';
  if (m.starts.length > 0) {
    m.crashes = [];
    m.failure = undefined;
    launch(m, false, fx);
  }
}

function beginRemove(m: Machine, fx: Effect[]): void {
  settleCalls(m, () => REMOVED, fx);
  replyAll(m.starts, { kind: 'removed' }, fx);
  m.phase = 'removing';
  m.failure = undefined;
  m.forgetting = true;
  fx.push({ t: 'forget' });
}

/** Answers every call `outcome` gives an answer for, and keeps the rest. */
function settleCalls(m: Machine, outcome: (c: Call) => CallOutcome | undefined, fx: Effect[]): void {
  for (const c of [...m.calls.values()]) {
    const o = outcome(c);
    if (o) answer(m, c, o, fx);
  }
}

function answer(m: Machine, c: Call, outcome: CallOutcome, fx: Effect[]): void {
  m.calls.delete(c.id);
  fx.push({ t: 'disarm', key: callKey(c.id) }, { t: 'answer', call: c.id, outcome });
}

function reply(token: number, r: Reply, fx: Effect[]): void {
  fx.push({ t: 'reply', token, reply: r });
}

function replyAll(tokens: number[], r: Reply, fx: Effect[]): void {
  for (const token of tokens.splice(0)) reply(token, r, fx);
}
