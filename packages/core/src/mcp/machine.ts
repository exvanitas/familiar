// One MCP server's rules, as a pure function: a state and a message in, the changed state and a list of
// effects out. The actor (actor.ts) is the only owner of a Machine: it feeds every command and every
// completion through `step`, one at a time, and does the effects. Nothing here waits or touches I/O, so a
// property test can drive it with any order of messages. See "One actor per server" in docs/mcp-design.md.
// Longer than 400 lines on purpose: one server's rules read best in one place.
//
// Every run has a generation, and every other wait (a write, a cleanup, an add, a removal, a tool list) a
// number of its own. Events and timers carry theirs, and anything that isn't current is dropped.
//
// Two rules hold every effect that changes something outside (the saved record, Credential Manager, the
// exe's addresses and approvals). Every change goes through here, and an effect stays owned until it
// settles: its deadline answers the caller, but the server stays busy for conflicting commands until the
// effect lands, so nothing is released while it can still land late. A call that was sent belongs to the run it was sent on: when that run ends, the call is
// answered `interrupted` and is never sent again. A call made for a tool as the person saw it is sent only
// if the server still offers that exact tool, from that exact setup.

import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';

export type Phase = 'adding' | 'stopped' | 'starting' | 'initializing' | 'ready' | 'restarting' | 'down' | 'stopping' | 'removing' | 'removed';

export interface Limits {
  /** A call's deadline when it names none. */
  readonly callMs: number;
  /** From the start of a run to the run starting: the exe's dialog, a remote connection. */
  readonly startMs: number;
  /** The handshake's deadline: from the run starting to the first tool list. */
  readonly initMs: number;
  /** A later tool list's deadline. */
  readonly listMs: number;
  /** How long a run may take to close before it counts as closed. */
  readonly stopMs: number;
  /** A write of the saved record, an edit's cleanup, and a removal. */
  readonly saveMs: number;
  /** Restarts allowed in the window. One more crash and the server is down. */
  readonly restarts: number;
  readonly restartWindowMs: number;
  /** The pause before a restart. */
  readonly backoffMs: number;
  /** Calls waiting or running at once. */
  readonly maxCalls: number;
  /** Starts, stops or removes waiting at once, each. */
  readonly maxWaiters: number;
}

export const CALL_MS = 60_000;
export const CALL_MS_MIN = 1_000;
export const CALL_MS_MAX = 15 * 60_000;
export const INIT_MS = 120_000;
export const INIT_MS_MIN = 10_000;
export const INIT_MS_MAX = 5 * 60_000;

export const DEFAULT_LIMITS: Limits = {
  callMs: CALL_MS,
  startMs: 5 * 60_000,
  initMs: INIT_MS,
  listMs: 30_000,
  stopMs: 5_000,
  saveMs: 30_000,
  restarts: 2,
  restartWindowMs: 10 * 60_000,
  backoffMs: 1_000,
  maxCalls: 16,
  maxWaiters: 8
};

/** What a call was made for: the tool as the person saw it, from the setup it was offered by. */
export interface Expect {
  readonly setup: string;
  readonly tool: string;
}

interface Call {
  readonly id: number;
  readonly tool: string;
  readonly args: unknown;
  readonly expect?: Expect;
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
  /** Why the machine itself is ending the current run (a deadline, a bad tool list), if it is. */
  ending?: Failure;
  /** The number of the last save, removal or tool list asked for. */
  seq: number;
  /** The one write of the saved record in flight, if any, and whether its deadline has passed. */
  writing?: number;
  writeOverdue: boolean;
  /** Another write is wanted once this one lands. */
  dirty: boolean;
  /** Callers answered when the write in flight lands, and when the next one does. */
  writeTokens: number[];
  nextTokens: number[];
  /** A setup edit: waiting for the write that carries it, then for the cleanup of secrets it dropped. */
  edit?: { readonly token: number; write?: number; cleanup?: number; overdue: boolean; replied: boolean };
  /** The add under way while `adding`: its number and caller. */
  registering?: { readonly n: number; readonly token: number; replied: boolean };
  /** A removal under way: its number, and whether its deadline has passed. */
  forgetting?: number;
  forgetOverdue: boolean;
  /** A tool list under way: its number. */
  listing?: number;
  /** The tools changed again while a list was under way. */
  listDirty: boolean;
  /** The server said its tools changed, and no list since has answered: calls wait. */
  stale: boolean;
  readonly calls: Map<number, Call>;
  readonly starts: number[];
  readonly stops: number[];
  readonly removes: number[];
  /** When each restart in the window was made. */
  crashes: number[];
  failure?: Failure;
  tools: readonly ListedTool[];
  /** The current run's tools by name, with their fingerprints, and the setup it was started from. */
  catalog: ReadonlyMap<string, string>;
  setup?: string;
  readonly limits: Limits;
}

export type Input =
  | { readonly t: 'start'; readonly token: number }
  | { readonly t: 'stop'; readonly token: number }
  | { readonly t: 'remove'; readonly token: number }
  /** A change to the setup, which the actor holds as pending. Only while stopped or down. */
  | { readonly t: 'edit'; readonly token: number }
  /** A change to the rest of the record (enabled, limits, review), which the actor holds as pending. */
  | { readonly t: 'update'; readonly token: number }
  /** A change with no caller (a new tool list's fingerprints): written when the writer is free. */
  | { readonly t: 'touch' }
  /** The add itself, while `adding`. */
  | { readonly t: 'register'; readonly token: number }
  | { readonly t: 'call'; readonly token: number; readonly tool: string; readonly args: unknown; readonly ms?: number; readonly expect?: Expect }
  /** The person pressed Stop on one call. */
  | { readonly t: 'cancel'; readonly call: number }
  | { readonly t: 'refresh' }
  /** The run started: the process runs, or the remote transport connected. */
  | { readonly t: 'launched'; readonly gen: number }
  /** The handshake and the first tool list are done. `setup` is the fingerprint of the setup this run was started from. */
  | { readonly t: 'ready'; readonly gen: number; readonly tools: readonly ListedTool[]; readonly setup: string }
  | { readonly t: 'listed'; readonly gen: number; readonly n: number; readonly tools: readonly ListedTool[] }
  | { readonly t: 'list-failed'; readonly gen: number; readonly n: number; readonly failure: Failure }
  | { readonly t: 'tools-changed'; readonly gen: number }
  | { readonly t: 'result'; readonly gen: number; readonly call: number; readonly outcome: CallOutcome }
  /** The run ended, for any reason: an exit, a closed transport, a refused start, a failed handshake. */
  | { readonly t: 'closed'; readonly gen: number; readonly failure?: Failure }
  | { readonly t: 'timer'; readonly key: string }
  | { readonly t: 'written'; readonly n: number; readonly failure?: Failure }
  | { readonly t: 'cleaned'; readonly n: number }
  | { readonly t: 'registered'; readonly n: number; readonly failure?: Failure }
  | { readonly t: 'forgotten'; readonly n: number; readonly failure?: Failure };

export type Effect =
  | { readonly t: 'launch'; readonly gen: number }
  | { readonly t: 'send'; readonly gen: number; readonly call: number; readonly tool: string; readonly args: unknown }
  | { readonly t: 'abort'; readonly gen: number; readonly call: number }
  | { readonly t: 'list'; readonly gen: number; readonly n: number }
  | { readonly t: 'halt'; readonly gen: number }
  /** Write the pending record, fenced by revision `n`. */
  | { readonly t: 'write'; readonly n: number }
  /** Write `n` landed: the record it carried is now the committed one. */
  | { readonly t: 'committed'; readonly n: number }
  /** Write `n` failed: changes since the committed record are dropped. */
  | { readonly t: 'reverted'; readonly n: number }
  /** Delete the secrets the edit dropped. */
  | { readonly t: 'cleanup'; readonly n: number }
  /** Add the server: its address, if remote, and its first record. */
  | { readonly t: 'register'; readonly n: number }
  | { readonly t: 'forget'; readonly n: number }
  | { readonly t: 'arm'; readonly key: string; readonly at: number }
  | { readonly t: 'disarm'; readonly key: string }
  | { readonly t: 'answer'; readonly call: number; readonly outcome: CallOutcome }
  | { readonly t: 'reply'; readonly token: number; readonly reply: Reply }
  | { readonly t: 'changed' };

/** The states nothing pending will leave on its own. A failed removal rests too, until the next remove. */
export function resting(m: Machine): boolean {
  if (m.edit || m.writing !== undefined || m.dirty || m.registering || m.listing !== undefined || m.stale) return false;
  if (m.phase === 'removing') return m.forgetting === undefined && m.failure !== undefined;
  return m.phase === 'stopped' || m.phase === 'ready' || m.phase === 'down' || m.phase === 'removed';
}

/** A machine for a saved server (`stopped`), or for one being added (`adding`, which a `register` starts). */
export function createMachine(limits: Limits = DEFAULT_LIMITS, phase: 'stopped' | 'adding' = 'stopped'): Machine {
  return {
    phase, gen: 0, open: false, auto: false, seq: 0, listDirty: false, stale: false,
    writeOverdue: false, dirty: false, writeTokens: [], nextTokens: [], forgetOverdue: false,
    calls: new Map(), starts: [], stops: [], removes: [], crashes: [], tools: [], catalog: new Map(), limits
  };
}

const callKey = (id: number) => `call:${id}`;
const startKey = (gen: number) => `start:${gen}`;
const initKey = (gen: number) => `init:${gen}`;
const stopKey = (gen: number) => `stop:${gen}`;
const restartKey = (gen: number) => `restart:${gen}`;
const listKey = (n: number) => `list:${n}`;
const writeKey = (n: number) => `write:${n}`;
const cleanupKey = (n: number) => `cleanup:${n}`;
const registerKey = (n: number) => `register:${n}`;
const forgetKey = (n: number) => `forget:${n}`;

const refusal = (reason: 'not-running' | 'stopping' | 'removed' | 'busy' | 'down' | 'changed', words: string): CallOutcome => ({ kind: 'error', reason, words });
const NOT_RUNNING = refusal('not-running', "The server isn't running.");
const STOPPING = refusal('stopping', 'The server is stopping.');
const REMOVED = refusal('removed', 'The server was removed.');
const BUSY = refusal('busy', 'The server has too many calls waiting. Try again in a moment.');
const TOO_MANY: Reply = { kind: 'refused', words: 'Too many requests are waiting for this server. Try again in a moment.' };
const SETTLING: Reply = { kind: 'refused', words: 'Familiar is still finishing an earlier change to this server. Try again in a moment.' };
const ADDING: Reply = { kind: 'refused', words: 'The server is still being added.' };
const late = (what: string): Failure => ({ kind: 'timed-out', words: `${what} didn't finish in time. It may still finish, and Settings will show it if it does.` });
const secs = (ms: number) => Math.round(ms / 1000);

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
    case 'start': return start(m, input.token, fx, now);
    case 'stop': return stop(m, input.token, now, fx);
    case 'remove': return remove(m, input.token, now, fx);
    case 'edit': return edit(m, input.token, now, fx);
    case 'update':
      if (m.phase === 'adding') return reply(input.token, ADDING, fx);
      if (m.phase === 'removing' || m.phase === 'removed') return reply(input.token, { kind: 'removed' }, fx);
      return requestWrite(m, now, fx, input.token);
    case 'touch':
      if (m.phase === 'adding' || m.phase === 'removing' || m.phase === 'removed') return;
      return requestWrite(m, now, fx);
    case 'register':
      if (m.phase !== 'adding' || m.registering) return reply(input.token, ADDING, fx);
      m.registering = { n: ++m.seq, token: input.token, replied: false };
      fx.push({ t: 'register', n: m.registering.n }, { t: 'arm', key: registerKey(m.registering.n), at: now + m.limits.startMs });
      return;
    case 'registered': {
      const r = m.registering;
      if (!r || r.n !== input.n || m.phase !== 'adding') return;
      fx.push({ t: 'disarm', key: registerKey(r.n) });
      m.registering = undefined;
      if (input.failure) {
        m.phase = 'removed';
        m.failure = input.failure;
        if (!r.replied) reply(r.token, { kind: 'failed', failure: input.failure }, fx);
        return;
      }
      m.phase = 'stopped';
      if (!r.replied) reply(r.token, { kind: 'added' }, fx);
      return;
    }
    case 'written':
      if (m.writing !== input.n) return;
      fx.push({ t: 'disarm', key: writeKey(input.n) });
      return written(m, input.n, input.failure, now, fx);
    case 'cleaned':
      if (m.edit?.cleanup !== input.n) return;
      fx.push({ t: 'disarm', key: cleanupKey(input.n) });
      if (!m.edit.replied) reply(m.edit.token, { kind: 'edited' }, fx);
      m.edit = undefined;
      return afterOwned(m, now, fx);
    case 'call': return call(m, input, now, fx);
    case 'cancel': {
      const c = m.calls.get(input.call);
      if (!c) return;
      if (c.sent !== undefined) fx.push({ t: 'abort', gen: c.sent, call: c.id });
      return answer(m, c, { kind: 'stopped' }, fx);
    }
    case 'refresh':
      if (m.phase === 'ready' && !m.ending) requestList(m, now, fx);
      return;
    case 'launched':
      if (input.gen !== m.gen || m.phase !== 'starting' || m.ending) return;
      m.phase = 'initializing';
      fx.push({ t: 'disarm', key: startKey(m.gen) }, { t: 'arm', key: initKey(m.gen), at: now + m.limits.initMs });
      return;
    case 'ready':
      if (input.gen !== m.gen || m.phase !== 'initializing' || m.ending) return;
      m.phase = 'ready';
      m.setup = input.setup;
      setTools(m, input.tools);
      m.failure = undefined;
      fx.push({ t: 'disarm', key: initKey(m.gen) });
      sendWaiting(m, fx);
      return replyAll(m.starts, { kind: 'ready' }, fx);
    case 'listed':
      if (input.gen !== m.gen || m.phase !== 'ready' || input.n !== m.listing || m.ending) return;
      fx.push({ t: 'disarm', key: listKey(input.n) });
      m.listing = undefined;
      setTools(m, input.tools);
      if (m.listDirty) {
        m.listDirty = false;
        return requestList(m, now, fx);
      }
      m.stale = false;
      return sendWaiting(m, fx);
    case 'list-failed':
      if (input.gen !== m.gen || m.phase !== 'ready' || input.n !== m.listing || m.ending) return;
      return endRun(m, input.failure, now, fx);
    case 'tools-changed':
      if (input.gen !== m.gen || m.phase !== 'ready' || m.ending) return;
      m.stale = true;
      return requestList(m, now, fx);
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
      if (m.phase !== 'removing' || m.forgetting !== input.n) return;
      fx.push({ t: 'disarm', key: forgetKey(input.n) });
      return forgotten(m, input.failure, fx);
  }
}

/** Joins a waiting list, or is refused when it's full. */
function wait(m: Machine, list: number[], token: number, fx: Effect[]): boolean {
  if (list.length >= m.limits.maxWaiters) {
    reply(token, TOO_MANY, fx);
    return false;
  }
  list.push(token);
  return true;
}

function start(m: Machine, token: number, fx: Effect[], now: number): void {
  switch (m.phase) {
    case 'adding': return reply(token, ADDING, fx);
    case 'removed': return reply(token, { kind: 'removed' }, fx);
    case 'removing': return reply(token, { kind: 'refused', words: 'The server is being removed.' }, fx);
    case 'ready': return reply(token, { kind: 'ready' }, fx);
    case 'starting': case 'initializing': case 'restarting': case 'stopping':
      wait(m, m.starts, token, fx);
      return;
    case 'stopped': case 'down':
      // A removal waiting for a write to land goes first, and nothing starts after it.
      if (m.removes.length) return reply(token, { kind: 'refused', words: 'The server is being removed.' }, fx);
      // An edit past its deadline still owns the setup: busy until it lands.
      if (m.edit?.overdue) return reply(token, SETTLING, fx);
      if (!wait(m, m.starts, token, fx)) return;
      // An edit being saved goes first; the start follows it.
      if (m.edit) return;
      m.crashes = [];
      m.failure = undefined;
      return launch(m, false, now, fx);
  }
}

function stop(m: Machine, token: number, now: number, fx: Effect[]): void {
  // A stop settles every start made before it. Only a start after it can ask for another run.
  replyAll(m.starts, { kind: 'stopped' }, fx);
  switch (m.phase) {
    case 'adding': return reply(token, ADDING, fx);
    case 'removed': return reply(token, { kind: 'removed' }, fx);
    case 'stopped': case 'down': case 'removing': return reply(token, { kind: 'stopped' }, fx);
    case 'stopping':
      if (!wait(m, m.stops, token, fx)) return;
      return;
    case 'restarting':
      // Its run already closed: nothing to halt.
      fx.push({ t: 'disarm', key: restartKey(m.gen) });
      settleCalls(m, () => NOT_RUNNING, fx);
      m.phase = 'stopped';
      return reply(token, { kind: 'stopped' }, fx);
    case 'starting': case 'initializing': case 'ready':
      m.stops.push(token);
      return beginStop(m, now, fx);
  }
}

function remove(m: Machine, token: number, now: number, fx: Effect[]): void {
  switch (m.phase) {
    case 'adding': return reply(token, ADDING, fx);
    case 'removed': return reply(token, { kind: 'removed' }, fx);
    case 'removing':
      // A removal past its deadline still owns everything it touches: busy until it lands.
      if (m.forgetOverdue) return reply(token, SETTLING, fx);
      if (!wait(m, m.removes, token, fx)) return;
      if (m.forgetting === undefined) beginForget(m, now, fx);
      return;
    case 'stopping':
      wait(m, m.removes, token, fx);
      return;
    case 'starting': case 'initializing': case 'ready':
      m.removes.push(token);
      return beginStop(m, now, fx);
    case 'restarting':
      fx.push({ t: 'disarm', key: restartKey(m.gen) });
      m.removes.push(token);
      m.phase = 'stopped';
      settleCalls(m, () => REMOVED, fx);
      return afterOwned(m, now, fx);
    case 'stopped': case 'down':
      if (m.edit?.overdue || m.writeOverdue) return reply(token, SETTLING, fx);
      if (!wait(m, m.removes, token, fx)) return;
      // A write or an edit under way finishes first; the removal follows it.
      return afterOwned(m, now, fx);
  }
}

function edit(m: Machine, token: number, now: number, fx: Effect[]): void {
  if (m.phase === 'adding') return reply(token, ADDING, fx);
  if (m.phase !== 'stopped' && m.phase !== 'down') return reply(token, { kind: 'refused', words: m.phase === 'removed' || m.phase === 'removing' ? 'The server was removed.' : 'Stop the server before changing it.' }, fx);
  if (m.edit) return reply(token, m.edit.overdue ? SETTLING : { kind: 'refused', words: 'Another change to this server is being saved.' }, fx);
  if (m.writeOverdue) return reply(token, SETTLING, fx);
  if (m.removes.length) return reply(token, { kind: 'refused', words: 'The server is being removed.' }, fx);
  m.edit = { token, overdue: false, replied: false };
  requestWrite(m, now, fx);
}

/** One write in flight, and a dirty flag for the next. Callers wait within the admission cap. */
function requestWrite(m: Machine, now: number, fx: Effect[], token?: number): void {
  if (m.writing !== undefined) {
    if (m.writeOverdue && token !== undefined) return reply(token, SETTLING, fx);
    if (token !== undefined && !wait(m, m.nextTokens, token, fx)) return;
    m.dirty = true;
    return;
  }
  if (token !== undefined) m.nextTokens.push(token);
  startWrite(m, now, fx);
}

function startWrite(m: Machine, now: number, fx: Effect[]): void {
  m.writing = ++m.seq;
  m.writeOverdue = false;
  m.dirty = false;
  m.writeTokens = m.nextTokens.splice(0);
  if (m.edit && m.edit.write === undefined) m.edit.write = m.writing;
  fx.push({ t: 'write', n: m.writing }, { t: 'arm', key: writeKey(m.writing), at: now + m.limits.saveMs });
}

/** The write in flight landed, on time or late. Whatever it carried is now what's committed, or, if it
    failed, the changes since are dropped. */
function written(m: Machine, n: number, failure: Failure | undefined, now: number, fx: Effect[]): void {
  const overdue = m.writeOverdue;
  m.writing = undefined;
  m.writeOverdue = false;
  fx.push(failure ? { t: 'reverted', n } : { t: 'committed', n });
  if (!overdue) replyAll(m.writeTokens, failure ? { kind: 'failed', failure } : { kind: 'edited' }, fx);
  m.writeTokens = [];
  const e = m.edit;
  if (e && e.write === n) {
    if (failure) {
      if (!e.replied) reply(e.token, { kind: 'failed', failure }, fx);
      m.edit = undefined;
    } else {
      // The secrets the edit dropped are deleted under the same ownership, with a deadline.
      e.cleanup = ++m.seq;
      fx.push({ t: 'cleanup', n: e.cleanup }, { t: 'arm', key: cleanupKey(e.cleanup), at: now + m.limits.saveMs });
    }
  }
  afterOwned(m, now, fx);
}

/** When the owned effects settle: the next write, then a waiting removal, then a waiting start. */
function afterOwned(m: Machine, now: number, fx: Effect[]): void {
  if (m.writing === undefined && (m.dirty || m.nextTokens.length) && m.phase !== 'removing' && m.phase !== 'removed') startWrite(m, now, fx);
  if (m.writing !== undefined || m.edit) return;
  if ((m.phase === 'stopped' || m.phase === 'down') && m.removes.length) return beginRemove(m, now, fx);
  if ((m.phase === 'stopped' || m.phase === 'down') && m.starts.length) {
    if (m.open) return;
    m.crashes = [];
    m.failure = undefined;
    launch(m, false, now, fx);
  }
}

function forgotten(m: Machine, failure: Failure | undefined, fx: Effect[]): void {
  const overdue = m.forgetOverdue;
  m.forgetting = undefined;
  m.forgetOverdue = false;
  if (failure) {
    m.failure = failure;
    return replyAll(m.removes, { kind: 'failed', failure }, fx);
  }
  void overdue;
  m.phase = 'removed';
  m.failure = undefined;
  m.tools = [];
  m.catalog = new Map();
  replyAll(m.removes, { kind: 'removed' }, fx);
}

function call(m: Machine, input: Extract<Input, { t: 'call' }>, now: number, fx: Effect[]): void {
  const refuse = (o: CallOutcome) => fx.push({ t: 'answer', call: input.token, outcome: o });
  switch (m.phase) {
    case 'adding': return void refuse(refusal('not-running', 'The server is still being added.'));
    case 'removed': case 'removing': return void refuse(REMOVED);
    case 'stopping': return void refuse(STOPPING);
    case 'stopped': return void refuse(m.failure ? refusal('not-running', `The server isn't running. ${m.failure.words}`) : NOT_RUNNING);
    case 'down': return void refuse(refusal('down', "The server is down: it stopped three times in ten minutes. Start it again in Settings."));
  }
  if (m.calls.size >= m.limits.maxCalls) return void refuse(BUSY);
  const c: Call = { id: input.token, tool: input.tool, args: input.args, ...(input.expect ? { expect: input.expect } : {}) };
  m.calls.set(c.id, c);
  fx.push({ t: 'arm', key: callKey(c.id), at: now + callMs(m.limits, input.ms) });
  if (m.phase === 'ready' && !m.stale && !m.ending) send(m, c, fx);
}

/** Sends a call, unless the tool it was made for isn't what the server offers now. */
function send(m: Machine, c: Call, fx: Effect[]): void {
  if (c.expect) {
    const now = m.catalog.get(c.tool);
    if (c.expect.setup !== m.setup || now !== c.expect.tool) {
      return answer(m, c, refusal('changed', now === undefined
        ? `The server no longer offers ${c.tool}, so Familiar didn't send the call.`
        : `${c.tool} changed since it was offered, so Familiar didn't send the call. It will ask again.`), fx);
    }
  }
  c.sent = m.gen;
  fx.push({ t: 'send', gen: m.gen, call: c.id, tool: c.tool, args: c.args });
}

function sendWaiting(m: Machine, fx: Effect[]): void {
  for (const c of [...m.calls.values()]) if (c.sent === undefined) send(m, c, fx);
}

function setTools(m: Machine, tools: readonly ListedTool[]): void {
  m.tools = tools;
  m.catalog = new Map(tools.map(t => [t.name, t.fingerprint]));
}

/** One tool list at a time: a change while one is under way asks for one more, after it. */
function requestList(m: Machine, now: number, fx: Effect[]): void {
  if (m.listing !== undefined) {
    m.listDirty = true;
    return;
  }
  m.listing = ++m.seq;
  fx.push({ t: 'list', gen: m.gen, n: m.listing }, { t: 'arm', key: listKey(m.listing), at: now + m.limits.listMs });
}

/** A call's deadline in ms, within the limits. */
export function callMs(limits: Limits, ms?: number): number {
  const want = ms === undefined || !Number.isFinite(ms) ? limits.callMs : ms;
  return Math.min(CALL_MS_MAX, Math.max(CALL_MS_MIN, want));
}

function timer(m: Machine, key: string, now: number, fx: Effect[]): void {
  const [kind, num] = key.split(':') as [string, string];
  const n = Number(num);
  switch (kind) {
    case 'call': {
      const c = m.calls.get(n);
      if (!c) return;
      if (c.sent !== undefined) fx.push({ t: 'abort', gen: c.sent, call: c.id });
      return answer(m, c, { kind: 'timed-out' }, fx);
    }
    // An owned effect past its deadline: its callers are answered, and the server stays busy for
    // anything that conflicts with it until it lands.
    case 'write':
      if (m.writing === n && !m.writeOverdue) {
        m.writeOverdue = true;
        const why = late('Saving the change');
        replyAll(m.writeTokens, { kind: 'failed', failure: why }, fx);
        replyAll(m.nextTokens, SETTLING, fx);
        if (m.edit && m.edit.write === n) overdueEdit(m, why, fx);
        replyAll(m.removes, SETTLING, fx);
      }
      return;
    case 'cleanup':
      if (m.edit?.cleanup === n && !m.edit.overdue) overdueEdit(m, late('Removing the secrets the change dropped'), fx);
      return;
    case 'register':
      if (m.registering?.n === n && !m.registering.replied) {
        m.registering.replied = true;
        reply(m.registering.token, { kind: 'failed', failure: late('Adding the server') }, fx);
      }
      return;
    case 'forget':
      if (m.phase === 'removing' && m.forgetting === n && !m.forgetOverdue) {
        m.forgetOverdue = true;
        replyAll(m.removes, { kind: 'failed', failure: late('Removing the server') }, fx);
      }
      return;
    case 'list':
      if (m.phase === 'ready' && m.listing === n && !m.ending) endRun(m, { kind: 'protocol', words: `The server didn't list its tools within ${secs(m.limits.listMs)} seconds.` }, now, fx);
      return;
  }
  if (n !== m.gen) return;
  if (kind === 'start' && m.phase === 'starting' && !m.ending) return endRun(m, { kind: 'timed-out', words: `The server didn't start within ${secs(m.limits.startMs)} seconds.` }, now, fx);
  if (kind === 'init' && m.phase === 'initializing' && !m.ending) return endRun(m, { kind: 'timed-out', words: `The server didn't finish starting within ${secs(m.limits.initMs)} seconds.` }, now, fx);
  if (kind === 'stop' && m.open && (m.phase === 'stopping' || m.ending)) return closed(m, undefined, now, fx);
  if (kind === 'restart' && m.phase === 'restarting') return launch(m, true, now, fx);
}

function overdueEdit(m: Machine, why: Failure, fx: Effect[]): void {
  const e = m.edit!;
  e.overdue = true;
  if (!e.replied) reply(e.token, { kind: 'failed', failure: why }, fx);
  e.replied = true;
  replyAll(m.starts, SETTLING, fx);
}

/** The machine ends the current run itself, and treats it as closed when it closes or its stop deadline
    passes. Its calls are answered then, by the crash or failure path. */
function endRun(m: Machine, why: Failure, now: number, fx: Effect[]): void {
  m.ending = why;
  if (m.listing !== undefined) fx.push({ t: 'disarm', key: listKey(m.listing) });
  m.listing = undefined;
  fx.push({ t: 'halt', gen: m.gen }, { t: 'arm', key: stopKey(m.gen), at: now + m.limits.stopMs });
}

/** The current run ended. */
function closed(m: Machine, failure: Failure | undefined, now: number, fx: Effect[]): void {
  m.open = false;
  fx.push({ t: 'disarm', key: startKey(m.gen) }, { t: 'disarm', key: initKey(m.gen) }, { t: 'disarm', key: stopKey(m.gen) });
  if (m.listing !== undefined) fx.push({ t: 'disarm', key: listKey(m.listing) });
  m.listing = undefined;
  m.listDirty = false;
  m.stale = false;
  const why = m.ending ?? failure ?? { kind: 'exited', words: 'The server stopped.' };
  m.ending = undefined;
  switch (m.phase) {
    case 'stopping': return finishStop(m, now, fx);
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

function launch(m: Machine, auto: boolean, now: number, fx: Effect[]): void {
  m.gen++;
  m.open = true;
  m.auto = auto;
  m.ending = undefined;
  m.phase = 'starting';
  m.setup = undefined;
  m.catalog = new Map();
  fx.push({ t: 'launch', gen: m.gen }, { t: 'arm', key: startKey(m.gen), at: now + m.limits.startMs });
}

function beginStop(m: Machine, now: number, fx: Effect[]): void {
  settleCalls(m, c => (c.sent !== undefined ? { kind: 'interrupted' } : STOPPING), fx);
  replyAll(m.starts, { kind: 'stopped' }, fx);
  if (m.listing !== undefined) fx.push({ t: 'disarm', key: listKey(m.listing) });
  m.listing = undefined;
  m.listDirty = false;
  m.stale = false;
  m.phase = 'stopping';
  m.ending = undefined;
  fx.push({ t: 'halt', gen: m.gen }, { t: 'arm', key: stopKey(m.gen), at: now + m.limits.stopMs });
}

function finishStop(m: Machine, now: number, fx: Effect[]): void {
  replyAll(m.stops, { kind: 'stopped' }, fx);
  m.phase = 'stopped';
  afterOwned(m, now, fx);
}

function beginRemove(m: Machine, now: number, fx: Effect[]): void {
  settleCalls(m, () => REMOVED, fx);
  replyAll(m.starts, { kind: 'removed' }, fx);
  // Nothing is written from here on: a removal owns the record.
  m.dirty = false;
  replyAll(m.nextTokens, { kind: 'removed' }, fx);
  m.phase = 'removing';
  m.failure = undefined;
  beginForget(m, now, fx);
}

function beginForget(m: Machine, now: number, fx: Effect[]): void {
  m.forgetting = ++m.seq;
  fx.push({ t: 'forget', n: m.forgetting }, { t: 'arm', key: forgetKey(m.forgetting), at: now + m.limits.saveMs });
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
