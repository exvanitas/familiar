// One server's run lifecycle as one pure machine (docs/mcp-design.md 5.4): Start, Stop, Test, the walk of the
// tool list, the refresh after list_changed, a remote session's recovery, the modern relaunch, and every way
// a run ends. `next(state, event)` returns the next state and the effects to carry out. It has no awaits, no
// clock, no I/O and no randomness; the driver (runtime.ts) turns every native answer, deadline, exchange-slot
// change, server notice and person action into an event, and does the effects. No lifecycle decision is made
// anywhere else. W (tests/harness/lifecycle.walk.test.ts) walks it exhaustively.
//
// The exchange machine (exchange.ts) stays as it is: this machine reads its Idle and busy changes as events,
// and asks for an administrative exchange only while the slot is Idle. `send()` and `handoff()` read
// `callable(state)` synchronously and stay one synchronous step.

import { mutant } from '../../mutations.ts';
import type { Failure } from '../types.ts';

export type Where = 'local' | 'remote';
export type Mode = 'start' | 'auto' | 'test';
export type Purpose = 'start' | 'refresh' | 'recovery';
export type Step = 'launching' | 'opening' | 'initialized' | 'walking' | 'settling' | 'ready' | 'grace' | 'relaunch' | 'closing';
export type DeadlineKind = 'start' | 'list' | 'recovery' | 'grace' | 'stop';
export type Cause =
  | 'person-stop'
  | 'test-done'
  | 'deadline'
  | 'watchdog'
  | 'exit'
  | 'start-failed'
  | 'list-answered'
  | 'list-unanswered'
  | 'handshake'
  | 'session-ended'
  | 'era-changed'
  | 'catalog-failed'
  | 'held'
  | 'readmit-refused'
  | 'turned-off';
export type Want = { readonly kind: 'initialize' } | { readonly kind: 'initialized' } | { readonly kind: 'list'; readonly page: number };

export interface Native {
  readonly start: 'pending' | 'ok' | 'failed';
  readonly process?: string;
  readonly stop: 'none' | 'pending' | 'ok' | 'refused';
  readonly exited: boolean;
}
export interface Walk {
  readonly attempt: number;
  readonly page: number;
  /** The notice count when this walk began: it publishes only if none came while it ran. */
  readonly startedAt: number;
  /** Any page of this walk was answered: the list's outcome is the server's word, never a relaunch. */
  readonly answered: boolean;
}
export interface Run {
  readonly id: string;
  readonly where: Where;
  /** The setup's launch fingerprint, as admitted: a relaunch runs only this launch. */
  readonly launch: string;
  readonly era: 'legacy' | 'modern';
  readonly mode: Mode;
  readonly relaunched: boolean;
  /** What the handshake-and-walk sequence under way is for. */
  readonly purpose: Purpose;
  readonly step: Step;
  readonly native?: Native;
  /** The administrative exchange the step needs next, issued only while the slot is Idle. */
  readonly want?: Want;
  readonly inFlight?: Want;
  readonly walk?: Walk;
  /** list_changed notices read on this run. */
  readonly changes: number;
  /** The notice count the published catalog was walked under, once one is. */
  readonly published?: number;
  /** The published catalog's generation (0: none). */
  readonly gen: number;
  readonly refreshOwed: boolean;
  /** Remote: 1 once a session drop was recovered from, until a page or call completes after it (3.8). */
  readonly dropped: 0 | 1;
  readonly recovered: boolean;
  readonly deadline?: { readonly which: DeadlineKind; readonly id: number };
  /** The start's (or Test's) own deadline, armed once at admission and kept, for that action's answer only,
      while the step holds a deadline of its own (grace, a refresh's list, cleanup's stop) or none (Ready
      with its first catalog write saving). Disarmed when the action is answered. */
  readonly saveBy?: number;
  /** Why the run is ending, once it is: the words every waiter of it gets. */
  readonly cause?: Cause;
  readonly failure?: Failure;
  /** Familiar asked the exe to stop this process (a watchdog, a deadline, Stop, Test). */
  readonly killed: boolean;
  /** This run's opening was refused by a modern-only server: a local one may be relaunched once (3.9). */
  readonly modernOpening: boolean;
  /** The run's first catalog write: the start (or Test) is answered once it settles. */
  readonly firstSave: 'none' | 'pending' | 'done';
  readonly firstGen: number;
  /** The unanswered list's words, kept through the relaunch grace. */
  readonly graceFailure?: Failure;
  /** A later catalog write failed: its generation, kept until a retry lands (one retry). */
  readonly unsaved?: number;
  /** The first Stop's answer, once given: a later Stop of this run gets the same (4.6, I8). */
  readonly stopAnswer?: Reply;

}
export interface Waiter {
  readonly kind: 'start' | 'test' | 'stop';
  readonly token: string;
  readonly run?: string;
}
export interface Orphan {
  readonly run: string;
  readonly process: string;
  /** How its stop ended: the exe refused it, or the stop deadline outran the exit. Its words follow. */
  readonly how?: 'refused' | 'unconfirmed';
}
export interface LcState {
  readonly id: string;
  readonly nextRun: number;
  readonly nextDeadline: number;
  readonly nextGen: number;
  readonly run?: Run;
  /** Earlier local processes not yet seen to exit: a refused stop, or one Stop's deadline outran. */
  readonly orphans: readonly Orphan[];
  readonly waiters: readonly Waiter[];
  /** This server's own owner admission: held while a native start is pending. */
  readonly owner: 'free' | 'start';
  /** The exchange machine's slot, as this machine last saw or set it. */
  readonly slot: 'idle' | 'busy';
  /** Cleanup was refused for good: a restart is the only way back. */
  readonly held?: Failure;
  /** After a run: Stopped, or Failed with words. */
  readonly after?: { readonly failed: boolean; readonly failure?: Failure };
  /** The catalog write in flight, and whether a newer catalog was published while it was. */
  readonly saving?: { readonly run: string; readonly gen: number };
  readonly dirty: boolean;
  /** Under a named mutation only: a relaunch Stop cancelled, still answerable. */
  readonly zombie?: string;
}

export type StartFacts = {
  readonly record: 'ok' | 'missing' | 'unreadable' | 'removing' | 'disabled' | 'sse' | 'unlaunchable';
  readonly ownerFree: boolean;
  readonly ownerWords?: string;
  readonly where: Where;
  /** The committed setup's launch fingerprint, read in the admission's step. */
  readonly launch?: string;
};
/** The relaunch's facts, read again when it is due: the owner's admission and the committed record now. */
export type ReadmitFacts = {
  readonly ownerFree: boolean;
  readonly ownerWords?: string;
  /** The record is enabled now (an automatic start's relaunch needs it). */
  readonly enabled: boolean;
  /** The committed setup's launch fingerprint now ('' when the record is gone). */
  readonly launch: string;
};
export type AdminOutcome =
  | { readonly k: 'legacy' }
  | { readonly k: 'modern-refusal' }
  | { readonly k: 'refused'; readonly failure: Failure }
  | { readonly k: 'ok' }
  | { readonly k: 'page'; readonly more: boolean; readonly catalog?: 'ok' | Failure }
  | { readonly k: 'invalid'; readonly failure: Failure }
  | { readonly k: 'unanswered'; readonly failure: Failure }
  | { readonly k: 'session-ended' };
export type LcEvent =
  | { readonly t: 'start'; readonly token: string; readonly mode: Mode; readonly facts: StartFacts }
  | { readonly t: 'stop'; readonly token: string }
  | { readonly t: 'started'; readonly run: string; readonly ok: true; readonly process: string }
  | { readonly t: 'started'; readonly run: string; readonly ok: false; readonly failure: Failure }
  | { readonly t: 'stop-answered'; readonly run: string; readonly ok: boolean }
  | { readonly t: 'exit'; readonly process: string; readonly failure: Failure }
  | { readonly t: 'write-bound'; readonly run: string }
  | { readonly t: 'slot'; readonly idle: boolean }
  | { readonly t: 'admin-done'; readonly run: string; readonly outcome: AdminOutcome }
  | { readonly t: 'call-ended'; readonly run: string; readonly end: 'done' | 'session-ended' | 'era-refusal'; readonly failure?: Failure }
  | { readonly t: 'notice'; readonly run: string }
  | { readonly t: 'exhausted'; readonly failure: Failure }
  | { readonly t: 'deadline'; readonly id: number }
  | { readonly t: 'saved'; readonly gen: number; readonly outcome: 'saved' | 'skipped' | 'failed' }
  | { readonly t: 'readmit'; readonly run: string; readonly facts: ReadmitFacts };

export type Reply = { readonly kind: 'ready' } | { readonly kind: 'stopped' } | { readonly kind: 'failed'; readonly failure: Failure } | { readonly kind: 'refused'; readonly words: string } | { readonly kind: 'tested'; readonly run: string };
export type LcEffect =
  | { readonly t: 'native-start'; readonly run: string; readonly era: 'legacy' | 'modern' }
  | { readonly t: 'native-stop'; readonly run: string; readonly process: string }
  | { readonly t: 'admin'; readonly run: string; readonly want: Want; readonly era: 'legacy' | 'modern' }
  | { readonly t: 'end-live'; readonly run: string }
  | { readonly t: 'arm'; readonly id: number; readonly which: DeadlineKind }
  | { readonly t: 'disarm'; readonly id: number }
  | { readonly t: 'owner-hold' }
  | { readonly t: 'owner-release' }
  | { readonly t: 'publish'; readonly run: string; readonly gen: number }
  | { readonly t: 'save'; readonly run: string; readonly gen: number }
  | { readonly t: 'answer'; readonly token: string; readonly reply: Reply }
  | { readonly t: 'release-writes'; readonly process: string }
  | { readonly t: 'ended'; readonly run: string; readonly failure?: Failure }
  | { readonly t: 'readmit-check'; readonly run: string }
  | { readonly t: 'new-session'; readonly run: string };

export const STOPPED_WORDS = 'The server was stopped.';
export const STOP_REFUSED: Failure = { kind: 'failed', words: 'Familiar asked Windows to stop the server and was refused, so it may still be running. Familiar starts it again only once it has exited; restarting Familiar ends it for sure.' };
export const STOP_UNCONFIRMED: Failure = { kind: 'failed', words: "Familiar asked Windows to stop the server and it hasn't exited yet, so it may still be running. Familiar starts it again only once it has exited; restarting Familiar ends it for sure." };
export const START_UNANSWERED: Failure = { kind: 'timed-out', words: "The server didn't finish starting in time: Windows hasn't answered the start, so it may still be starting." };
export const START_TIMEOUT: Failure = { kind: 'timed-out', words: "The server didn't finish starting in time." };
/** A Start answered as its run is stopped by the person, before it finished starting. */
export const STOPPED_EARLY: Failure = { kind: 'exited', words: 'The server was stopped before it finished starting.' };
export const LIST_TIMEOUT: Failure = { kind: 'timed-out', words: "The server's tool list didn't arrive in time." };
export const SESSION_ENDED: Failure = { kind: 'http', words: 'The server ended its session.' };
export const KEPT_CHANGING: Failure = { kind: 'protocol', words: "The server's tools kept changing while Familiar listed them." };
export const TOO_MANY_PAGES: Failure = { kind: 'protocol', words: "The server's tool list ran past 16 pages." };
export const WATCHDOG: Failure = { kind: 'protocol', words: 'The server stopped reading what Familiar sent, so it was stopped.' };
export const CATALOG_FAILED: Failure = { kind: 'failed', words: "Familiar couldn't save the server's tool list, so it was stopped. Try again." };
export const BUSY_SLOT = 'The server is still finishing its last request. Try again in a moment.';
export const MAX_PAGES = 16;
const MAX_ATTEMPTS = 3;

const RECORD_WORDS: Record<Exclude<StartFacts['record'], 'ok'>, Reply> = {
  missing: { kind: 'refused', words: 'No server is saved with that id.' },
  unreadable: { kind: 'refused', words: "Familiar can't read this server's saved setup, so it won't start it." },
  removing: { kind: 'refused', words: 'It is being removed.' },
  disabled: { kind: 'refused', words: 'It is turned off.' },
  sse: { kind: 'failed', failure: { kind: 'protocol', words: "Legacy SSE servers are not supported. Use the server's Streamable HTTP address." } },
  unlaunchable: { kind: 'failed', failure: { kind: 'failed', words: "Familiar can't read this server's saved setup, so it won't start it." } }
};

// Every switch is guarded at its own site by the build constant, so the app build drops it with its name.

export function initialState(id: string): LcState {
  return { id, nextRun: 0, nextDeadline: 0, nextGen: 0, orphans: [], waiters: [], owner: 'free', slot: 'idle', dirty: false };
}

/** What Settings shows. */
export function phaseOf(s: LcState): 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed' | 'held' {
  if (s.held) return 'held';
  const r = s.run;
  if (!r) return s.after?.failed ? 'failed' : 'stopped';
  if (r.step === 'closing') return 'stopping';
  if (r.step === 'ready') return 'ready';
  if (r.purpose !== 'start' && ['opening', 'initialized', 'walking', 'settling'].includes(r.step)) return 'ready';
  return 'starting';
}

/** Whether the run's catalog is the one calls may be checked against: Ready, and walked under every notice
    read (G26). A call on it may still meet a busy slot. */
export function offering(s: LcState): boolean {
  const r = s.run;
  if (!r || s.held) return false;
  if (r.purpose === 'recovery' && r.step !== 'closing' && (__FAMILIAR_MUTATIONS__ && mutant('ready-during-recovery'))) return true;
  if (r.step === 'closing' && r.cause === 'person-stop' && (__FAMILIAR_MUTATIONS__ && mutant('no-stop-fence'))) return true;
  return r.step === 'ready' && !r.refreshOwed && r.published !== undefined && r.changes === r.published;
}

/** Whether a call may be handed off now: offering, and the slot Idle. */
export function callable(s: LcState): boolean {
  return offering(s) && s.slot === 'idle';
}

/** Whether nothing may be admitted to the run now (Stop's fence, or no run): an idle ping goes unanswered. */
export function fenced(s: LcState): boolean {
  const r = s.run;
  if (!r || s.held) return true;
  if (r.step === 'closing') return !(r.cause === 'person-stop' && (__FAMILIAR_MUTATIONS__ && mutant('no-stop-fence')));
  return false;
}

/** The words a failed or stopped server shows. */
export function failureOf(s: LcState): Failure | undefined {
  return s.held ?? (s.run ? undefined : s.after?.failure);
}

/* ---------- the machine ---------- */

class Tx {
  s: { -readonly [K in keyof LcState]: LcState[K] };
  readonly fx: LcEffect[] = [];
  constructor(s: LcState) {
    this.s = { ...s };
  }
  get run(): Run | undefined {
    return this.s.run;
  }
  setRun(patch: Partial<Run>): void {
    this.s.run = { ...this.s.run!, ...patch };
  }
  emit(e: LcEffect): void {
    this.fx.push(e);
  }
  answer(token: string, reply: Reply): void {
    const w = this.s.waiters.find((x) => x.token === token);
    this.s.waiters = this.s.waiters.filter((x) => x.token !== token);
    this.emit({ t: 'answer', token, reply });
    if (w?.kind === 'stop' && this.s.run && w.run === this.s.run.id && !this.s.run.stopAnswer) this.setRun({ stopAnswer: reply });
    // The action's own deadline goes once its last start or Test waiter is answered.
    const r = this.s.run;
    if (!w || w.kind === 'stop' || !r || w.run !== r.id || this.actionOpen()) return;
    if (r.saveBy !== undefined) {
      this.emit({ t: 'disarm', id: r.saveBy });
      this.setRun({ saveBy: undefined });
    }
    if (r.deadline?.which === 'start') {
      this.emit({ t: 'disarm', id: r.deadline.id });
      this.setRun({ deadline: undefined });
    }
  }
  /** A start or Test of the current run still waits. */
  actionOpen(): boolean {
    const r = this.s.run;
    return !!r && this.s.waiters.some((x) => x.run === r.id && x.kind !== 'stop');
  }
  arm(which: DeadlineKind): void {
    this.disarm();
    const id = ++this.s.nextDeadline;
    this.setRun({ deadline: { which, id } });
    this.emit({ t: 'arm', id, which });
  }
  /** The step's deadline goes. A start deadline whose action still waits is kept, not disarmed: it moves
      aside (saveBy) and still answers that action at its original time (one deadline per action). */
  disarm(): void {
    const d = this.s.run?.deadline;
    if (!d) return;
    this.setRun({ deadline: undefined });
    if (d.which === 'start' && this.actionOpen() && this.s.run!.saveBy === undefined && !(__FAMILIAR_MUTATIONS__ && mutant('lc-start-deadline-dropped'))) {
      this.setRun({ saveBy: d.id });
      return;
    }
    this.emit({ t: 'disarm', id: d.id });
  }
  /** The step's administrative exchange, issued now if the slot is Idle, and the slot marked busy at once. */
  issue(): void {
    const r = this.s.run;
    if (!r || !r.want || this.s.held) return;
    const early = (__FAMILIAR_MUTATIONS__ && mutant('admit-while-draining')) || (r.want.kind === 'list' && r.want.page > 1 && (__FAMILIAR_MUTATIONS__ && mutant('page-before-drain')));
    if (this.s.slot !== 'idle' && !early) return;
    if (r.step === 'closing' && !(__FAMILIAR_MUTATIONS__ && mutant('lc-admit-after-fence')) && !(__FAMILIAR_MUTATIONS__ && mutant('no-stop-fence'))) return;
    this.emit({ t: 'admin', run: r.id, want: r.want, era: r.era });
    this.setRun({ inFlight: r.want, want: undefined });
    this.s.slot = 'busy';
  }
  saveCatalog(): void {
    const r = this.s.run!;
    if (this.s.saving && !(__FAMILIAR_MUTATIONS__ && mutant('lc-save-overlap'))) {
      this.s.dirty = true;
      return;
    }
    this.s.saving = { run: r.id, gen: r.gen };
    this.emit({ t: 'save', run: r.id, gen: r.gen });
  }
}

export function next(state: LcState, e: LcEvent): { readonly state: LcState; readonly effects: readonly LcEffect[] } {
  const tx = new Tx(state);
  step(tx, e);
  return { state: tx.s, effects: tx.fx };
}

const isCurrent = (tx: Tx, run: string) => tx.run?.id === run || ((__FAMILIAR_MUTATIONS__ && mutant('lc-old-run-events')) && !!tx.run);

function step(tx: Tx, e: LcEvent): void {
  switch (e.t) {
    case 'start':
      return start(tx, e);
    case 'stop':
      return stop(tx, e.token);
    case 'started':
      if (!isCurrent(tx, e.run) || tx.run!.native?.start !== 'pending') return;
      return started(tx, e);
    case 'stop-answered': {
      const r = tx.run;
      if (!r || r.id !== e.run || r.native?.stop !== 'pending') return;
      tx.setRun({ native: { ...r.native, stop: e.ok ? 'ok' : 'refused' } });
      if (e.ok && (__FAMILIAR_MUTATIONS__ && mutant('stop-before-exit'))) for (const w of tx.s.waiters.filter((x) => x.run === r.id && x.kind === 'stop')) tx.answer(w.token, { kind: 'stopped' });
      if (!e.ok && !(__FAMILIAR_MUTATIONS__ && mutant('stop-refused-waits'))) finish(tx, (__FAMILIAR_MUTATIONS__ && mutant('lc-stopped-on-refusal')) ? 'done' : 'refused');
      return;
    }
    case 'exit':
      return exit(tx, e.process, e.failure);
    case 'write-bound': {
      const r = tx.run;
      if (!r || r.id !== e.run || r.step === 'closing' || !r.native?.process || r.native.exited) return;
      return end(tx, 'watchdog', WATCHDOG);
    }
    case 'slot':
      return slot(tx, e.idle);
    case 'admin-done':
      if (!tx.run || tx.run.id !== e.run || !tx.run.inFlight) return;
      return adminDone(tx, e.outcome);
    case 'call-ended':
      return callEnded(tx, e);
    case 'notice':
      return notice(tx, e.run);
    case 'exhausted':
      return exhausted(tx, e.failure);
    case 'deadline':
      if (tx.run?.saveBy !== undefined && tx.run.saveBy === e.id) return actionDeadline(tx);
      if (!tx.run?.deadline || tx.run.deadline.id !== e.id) return;
      return deadline(tx, tx.run.deadline.which);
    case 'saved':
      return saved(tx, e.gen, e.outcome);
    case 'readmit':
      return readmit(tx, e);
  }
}

/* ---------- person actions ---------- */

function start(tx: Tx, e: Extract<LcEvent, { t: 'start' }>): void {
  const s = tx.s;
  if (s.held && !(__FAMILIAR_MUTATIONS__ && mutant('forget-exhaustion'))) return tx.emit({ t: 'answer', token: e.token, reply: { kind: 'failed', failure: s.held } });
  if (s.run) {
    const words = s.run.step === 'ready' ? 'It is already running.' : `It is ${phaseOf(s)}.`;
    return tx.emit({ t: 'answer', token: e.token, reply: { kind: 'refused', words } });
  }
  if (e.facts.record !== 'ok') return refuseStart(tx, e.token, RECORD_WORDS[e.facts.record]);
  // A process whose stop was refused may still be running: nothing starts beside it (I2).
  if (s.orphans.length && !(__FAMILIAR_MUTATIONS__ && mutant('lc-start-beside-orphan'))) return refuseStart(tx, e.token, { kind: 'failed', failure: orphanWords(s) });
  if (!e.facts.ownerFree) return tx.emit({ t: 'answer', token: e.token, reply: { kind: 'refused', words: e.facts.ownerWords ?? '' } });
  // (A slot still draining an earlier run's exchange doesn't refuse it: the new run's first request waits
  // for Idle, as every administrative request does, 6b.5.)
  const id = `${s.id}#${++s.nextRun}`;
  const local = e.facts.where === 'local';
  s.after = undefined;
  s.zombie = undefined;
  s.run = {
    id,
    where: e.facts.where,
    launch: e.facts.launch ?? '',
    era: 'legacy',
    mode: e.mode,
    relaunched: false,
    purpose: 'start',
    step: local ? 'launching' : 'opening',
    ...(local ? { native: { start: 'pending' as const, stop: 'none' as const, exited: false } } : { want: { kind: 'initialize' as const } }),
    changes: 0,
    gen: 0,
    refreshOwed: false,
    dropped: 0,
    recovered: false,
    killed: false,
    modernOpening: false,
    firstSave: 'none',
    firstGen: 0
  };
  s.waiters = [...s.waiters, { kind: e.mode === 'test' ? 'test' : 'start', token: e.token, run: id }];
  tx.arm('start');
  if (local) {
    s.owner = 'start';
    tx.emit({ t: 'owner-hold' });
    tx.emit({ t: 'native-start', run: id, era: 'legacy' });
  } else tx.issue();
}

/** A start answered at once. A failure (a setup that can't be launched, a slot still draining, a process
    that may still run) is the server's state, so it shows beside Failed; a refusal changes nothing. */
function refuseStart(tx: Tx, token: string, reply: Reply): void {
  if (reply.kind === 'failed') tx.s.after = { failed: true, failure: reply.failure };
  tx.emit({ t: 'answer', token, reply });
}

function stop(tx: Tx, token: string): void {
  const s = tx.s;
  if (s.held) return tx.emit({ t: 'answer', token, reply: { kind: 'failed', failure: s.held } });
  const r = s.run;
  if (!r) {
    // After a refused stop the process may still run: every later Stop says so, until its exit (r33 #4).
    if (s.orphans.length && !(__FAMILIAR_MUTATIONS__ && mutant('lc-second-stop-stopped'))) return tx.emit({ t: 'answer', token, reply: { kind: 'failed', failure: orphanWords(s) } });
    return tx.emit({ t: 'answer', token, reply: { kind: 'stopped' } });
  }
  if (r.step === 'relaunch') {
    // The relaunch is cancelled: its process already exited, and a readmit that comes later is for an
    // ended run.
    for (const w of s.waiters.filter((x) => x.run === r.id)) tx.answer(w.token, w.kind === 'test' ? { kind: 'failed', failure: STOPPED_EARLY } : { kind: 'stopped' });
    tx.disarm();
    if ((__FAMILIAR_MUTATIONS__ && mutant('lc-readmit-after-stop'))) s.zombie = r.id;
    s.run = undefined;
    s.after = { failed: false };
    return tx.emit({ t: 'answer', token, reply: { kind: 'stopped' } });
  }
  if (r.step === 'launching' && (__FAMILIAR_MUTATIONS__ && mutant('stop-skips-pending-start'))) {
    tx.emit({ t: 'answer', token, reply: { kind: 'stopped' } });
    return end(tx, 'person-stop', { kind: 'exited', words: STOPPED_WORDS });
  }
  // A second Stop after the first was answered gets that same answer (4.6, I8).
  if (r.step === 'closing' && r.stopAnswer && !(__FAMILIAR_MUTATIONS__ && mutant('lc-second-stop-stopped'))) return tx.emit({ t: 'answer', token, reply: r.stopAnswer });
  s.waiters = [...s.waiters, { kind: 'stop', token, run: r.id }];
  // A Stop during Test's own cleanup is the person's: Test then answers no success (4.7), with still one
  // native stop.
  // 6b.3: it answers Test at once, failed; the kept cause stays Test's own cleanup.
  if (r.step === 'closing' && r.cause === 'test-done' && !(__FAMILIAR_MUTATIONS__ && mutant('lc-test-ok-after-stop'))) {
    for (const w of s.waiters.filter((x) => x.run === r.id && x.kind === 'test')) tx.answer(w.token, { kind: 'failed', failure: { kind: 'exited', words: STOPPED_WORDS } });
  }
  if (r.step === 'closing') {
    // Every Stop has a deadline: one made after an earlier Stop's deadline was answered arms it again.
    if (!r.deadline && !(__FAMILIAR_MUTATIONS__ && mutant('lc-no-stop-deadline'))) tx.arm('stop');
    if ((__FAMILIAR_MUTATIONS__ && mutant('lc-two-native-stops')) && r.native?.process && r.native.stop === 'pending') tx.emit({ t: 'native-stop', run: r.id, process: r.native.process });
    return;
  }
  end(tx, 'person-stop', { kind: 'exited', words: STOPPED_WORDS });
}

/* ---------- native answers ---------- */

function started(tx: Tx, e: Extract<LcEvent, { t: 'started' }>): void {
  const r = tx.run!;
  const keep = r.step === 'closing' && (__FAMILIAR_MUTATIONS__ && mutant('lc-owner-held-on-stop'));
  if (!keep) {
    tx.s.owner = 'free';
    tx.emit({ t: 'owner-release' });
  }
  if (!e.ok) {
    tx.setRun({ native: { ...r.native!, start: 'failed' } });
    if (r.step === 'closing') return finish(tx, 'done');
    return end(tx, 'start-failed', e.failure);
  }
  tx.setRun({ native: { ...r.native!, start: 'ok', process: e.process } });
  if (r.step === 'closing') {
    // Stopped while the exe was still starting it: the process it then started is stopped now, under a
    // stop deadline of its own (the earlier one may have answered already): past it, an orphan.
    tx.setRun({ native: { ...tx.run!.native!, stop: 'pending' }, killed: true });
    tx.emit({ t: 'native-stop', run: r.id, process: e.process });
    if (!tx.run!.deadline && !(__FAMILIAR_MUTATIONS__ && mutant('lc-late-start-unbounded'))) tx.arm('stop');
    return;
  }
  // A modern relaunch skips the opening: the era was decided by the refusal on the first launch.
  if (r.era === 'modern') tx.setRun({ step: 'walking', walk: { attempt: 0, page: 1, startedAt: r.changes, answered: false }, want: { kind: 'list', page: 1 } });
  else tx.setRun({ step: 'opening', want: { kind: 'initialize' } });
  tx.issue();
}

function exit(tx: Tx, process: string, failure: Failure): void {
  const s = tx.s;
  const orphan = s.orphans.find((o) => o.process === process);
  if (orphan) {
    // An orphan's exit lifts its fence: the one old-run event that changes anything, and only its record.
    s.orphans = s.orphans.filter((o) => o !== orphan);
    tx.emit({ t: 'release-writes', process });
    return;
  }
  const r = s.run;
  if (!r || r.native?.process !== process || r.native.exited) return;
  tx.setRun({ native: { ...r.native, exited: true } });
  if (r.step === 'closing') return finish(tx, 'done');
  // A modern-only stdio server that ended its process after refusing the legacy opening, before its list
  // was answered: one relaunch (3.9).
  if (r.step === 'grace' || (r.step === 'walking' && relaunchable(tx.run!))) {
    // The exited process's exchange (its unanswered list) ends first, as the run's end: the slot frees, and
    // the relaunch's own list can go out. Then its writes, then the relaunch's facts.
    if (!(__FAMILIAR_MUTATIONS__ && mutant('lc-relaunch-keeps-exchange'))) tx.emit({ t: 'end-live', run: r.id });
    tx.emit({ t: 'release-writes', process });
    // The grace deadline goes; the admission's own deadline (kept aside through grace) is the relaunch's.
    if (tx.run!.deadline?.which !== 'start') tx.disarm();
    const kept = tx.run!.saveBy;
    if (kept !== undefined && !tx.run!.deadline) tx.setRun({ deadline: { which: 'start', id: kept }, saveBy: undefined });
    tx.setRun({ step: 'relaunch', want: undefined, inFlight: undefined });
    tx.emit({ t: 'readmit-check', run: r.id });
    return;
  }
  end(tx, 'exit', failure);
}

function relaunchable(r: Run): boolean {
  if (r.where !== 'local' || !r.modernOpening || r.relaunched || r.purpose !== 'start') return false;
  if (r.killed && !(__FAMILIAR_MUTATIONS__ && (mutant('lc-relaunch-after-kill') || mutant('relaunch-after-kill')))) return false;
  if (r.walk?.answered && !(__FAMILIAR_MUTATIONS__ && (mutant('lc-relaunch-on-answer') || mutant('relaunch-on-answer')))) return false;
  return true;
}

/* ---------- the slot ---------- */

function slot(tx: Tx, idle: boolean): void {
  if (!idle) {
    tx.s.slot = 'busy';
    return;
  }
  tx.s.slot = 'idle';
  const r = tx.run;
  if (!r || tx.s.held) return;
  if (r.want) return tx.issue();
  if (r.step === 'settling') return settle(tx);
  if (r.step === 'ready' && r.refreshOwed) return refresh(tx);
}

/** Ready only at an Idle slot, and only on a catalog walked under every notice read: otherwise walk again. */
function settle(tx: Tx): void {
  const r = tx.run!;
  if (r.changes !== r.published && !(__FAMILIAR_MUTATIONS__ && (mutant('lc-ready-stale') || mutant('publish-stale-walk')))) {
    const attempt = (r.walk?.attempt ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS) return end(tx, 'list-answered', KEPT_CHANGING);
    tx.setRun({ step: 'walking', walk: { attempt, page: 1, startedAt: r.changes, answered: false }, want: { kind: 'list', page: 1 } });
    return tx.issue();
  }
  const purpose = r.purpose;
  const beside = r.refreshOwed && (__FAMILIAR_MUTATIONS__ && mutant('walk-beside-walk'));
  tx.setRun({ step: 'ready', walk: undefined, refreshOwed: beside, purpose: 'start' });
  if (purpose === 'recovery') tx.setRun({ recovered: true });
  if (purpose === 'start' && r.firstSave === 'none') {
    // The start's deadline keeps running, for its answer only, until the first catalog write settles.
    tx.setRun({ firstSave: 'pending', firstGen: r.gen });
    tx.disarm();
    tx.saveCatalog();
    return;
  }
  tx.disarm();
  tx.saveCatalog();
  if (beside && tx.s.slot === 'idle') refresh(tx);
}

function refresh(tx: Tx): void {
  const r = tx.run!;
  tx.setRun({ refreshOwed: false, purpose: 'refresh', step: 'walking', walk: { attempt: 0, page: 1, startedAt: r.changes, answered: false }, want: { kind: 'list', page: 1 } });
  // The list deadline starts now, once the exchange that carried the notice has drained.
  tx.arm('list');
  tx.issue();
}

/* ---------- administrative exchanges ---------- */

function adminDone(tx: Tx, o: AdminOutcome): void {
  const r = tx.run!;
  const kind = r.inFlight!.kind;
  tx.setRun({ inFlight: undefined });
  // A run Familiar is ending takes no more of its list: an unanswered page after a kill is Familiar's own
  // doing, never a server that ended its process (r32 #2).
  if ((r.step === 'closing' && !((__FAMILIAR_MUTATIONS__ && (mutant('lc-relaunch-after-kill') || mutant('relaunch-after-kill'))) && o.k === 'unanswered')) || r.step === 'relaunch' || r.step === 'grace') return;
  if (o.k === 'session-ended') return sessionEnded(tx);
  if (kind === 'initialize') {
    if (o.k === 'legacy') {
      // A modern run's re-handshake answered in the legacy era: the run's era stays (G29), and a modern run
      // sends no notifications/initialized; its walk follows.
      if (r.era === 'modern') {
        tx.setRun({ step: 'walking', walk: { attempt: 0, page: 1, startedAt: r.changes, answered: false }, want: { kind: 'list', page: 1 } });
        return tx.issue();
      }
      tx.setRun({ step: 'initialized', want: { kind: 'initialized' } });
      return tx.issue();
    }
    if (o.k === 'modern-refusal') {
      // Decided once, at the run's opening; a re-handshake never changes the era (G29).
      if (r.purpose === 'recovery' && !(__FAMILIAR_MUTATIONS__ && (mutant('lc-era-on-recovery') || mutant('era-change-on-recovery')))) return end(tx, 'session-ended', SESSION_ENDED);
      if ((__FAMILIAR_MUTATIONS__ && mutant('initialized-on-modern'))) {
        tx.setRun({ era: 'modern', modernOpening: r.purpose === 'start', step: 'initialized', want: { kind: 'initialized' } });
        return tx.issue();
      }
      tx.setRun({ era: 'modern', modernOpening: r.purpose === 'start', step: 'walking', walk: { attempt: 0, page: 1, startedAt: r.changes, answered: false }, want: { kind: 'list', page: 1 } });
      return tx.issue();
    }
    // 4.5: a recovery runs the opening rows: a refusal or a bad answer ends it in the handshake's words.
    return end(tx, 'handshake', 'failure' in o ? o.failure : { kind: 'protocol', words: "The server's answer to the handshake was wrong." });
  }
  if (kind === 'initialized') {
    if (o.k === 'ok') {
      tx.setRun({ step: 'walking', walk: { attempt: 0, page: 1, startedAt: r.changes, answered: false }, want: { kind: 'list', page: 1 } });
      return tx.issue();
    }
    return end(tx, 'handshake', 'failure' in o ? o.failure : { kind: 'protocol', words: 'The handshake failed.' });
  }
  // A page of the list.
  const walk = r.walk!;
  if (o.k === 'page') {
    // A page that completes rearms the 404 bound once the recovery is over (3.8).
    if (r.recovered || (r.purpose === 'recovery' && (__FAMILIAR_MUTATIONS__ && mutant('rearm-in-recovery')))) tx.setRun({ dropped: 0, recovered: false });
    if (o.more) {
      if (walk.page >= MAX_PAGES) return end(tx, 'list-answered', TOO_MANY_PAGES);
      tx.setRun({ walk: { ...walk, page: walk.page + 1, answered: true }, want: { kind: 'list', page: walk.page + 1 } });
      return tx.issue();
    }
    // 4.3's rows in order, the first that matches: a notice outran the walk (walk again, or kept changing),
    // then a catalog that fails its bounds, then the publish. A retry keeps that the list was answered.
    const now = tx.run!;
    if (now.changes !== walk.startedAt && !(__FAMILIAR_MUTATIONS__ && (mutant('lc-ready-stale') || mutant('publish-stale-walk')))) {
      if (walk.attempt + 1 >= MAX_ATTEMPTS) return end(tx, 'list-answered', KEPT_CHANGING);
      tx.setRun({ walk: { attempt: walk.attempt + 1, page: 1, startedAt: now.changes, answered: true }, want: { kind: 'list', page: 1 } });
      return tx.issue();
    }
    if (o.catalog !== undefined && o.catalog !== 'ok') return end(tx, 'list-answered', o.catalog);
    const gen = ++tx.s.nextGen;
    // (The named mutation publishes a walk a notice outran, as if it were fresh.)
    tx.setRun({ published: (__FAMILIAR_MUTATIONS__ && (mutant('lc-ready-stale') || mutant('publish-stale-walk'))) ? now.changes : walk.startedAt, gen, step: 'settling', walk: { ...walk, answered: true } });
    tx.emit({ t: 'publish', run: r.id, gen });
    if ((__FAMILIAR_MUTATIONS__ && (mutant('lc-ready-before-idle') || mutant('ready-before-drain')))) return settle(tx);
    if (tx.s.slot === 'idle') return settle(tx);
    return;
  }
  if (o.k === 'invalid' || o.k === 'refused') {
    // Any answer to the list, a refusal or a line the parser rejected, is the server's word: no relaunch.
    tx.setRun({ walk: { ...walk, answered: true } });
    if ((__FAMILIAR_MUTATIONS__ && (mutant('lc-relaunch-on-answer') || mutant('relaunch-on-answer'))) && relaunchable(tx.run!)) return unanswered(tx, o.failure);
    return end(tx, 'list-answered', o.failure);
  }
  if (o.k === 'unanswered') return unanswered(tx, o.failure);
  return end(tx, 'list-answered', { kind: 'protocol', words: "The server's tool list was wrong." });
}

function unanswered(tx: Tx, failure: Failure): void {
  const r = tx.run!;
  if (r.purpose === 'start' && r.walk && relaunchable(r)) {
    if (r.native?.exited) {
      tx.setRun({ step: 'relaunch' });
      if (tx.run!.deadline?.which !== 'start') tx.arm('start');
      tx.emit({ t: 'readmit-check', run: r.id });
      return;
    }
    // The pipe can close before the exe reports the exit: wait for it, up to 2 s, before deciding.
    if ((__FAMILIAR_MUTATIONS__ && mutant('relaunch-races-exit'))) return end(tx, 'list-unanswered', failure);
    tx.setRun({ step: 'grace', graceFailure: failure });
    tx.arm('grace');
    return;
  }
  end(tx, 'list-unanswered', failure);
}

function sessionEnded(tx: Tx): void {
  const r = tx.run!;
  if (r.where !== 'remote') return end(tx, 'list-unanswered', SESSION_ENDED);
  // Ready, or refreshing (a refresh's walk, its settling included): one recovery (4.5).
  const fromReady = r.step === 'ready' || (r.purpose === 'refresh' && ['opening', 'initialized', 'walking', 'settling'].includes(r.step));
  if (r.purpose === 'refresh' && r.step !== 'ready' && (__FAMILIAR_MUTATIONS__ && mutant('end-on-refresh-404'))) return end(tx, 'session-ended', SESSION_ENDED);
  if ((!fromReady || r.dropped > 0) && !(__FAMILIAR_MUTATIONS__ && mutant('rehandshake-every-404'))) return end(tx, 'session-ended', SESSION_ENDED);
  // One fresh handshake, then the tool list; calls are refused meanwhile.
  tx.setRun({ purpose: 'recovery', step: 'opening', want: { kind: 'initialize' }, walk: undefined, dropped: 1, recovered: false, refreshOwed: false });
  tx.emit({ t: 'new-session', run: r.id });
  tx.arm('recovery');
  tx.issue();
}

function callEnded(tx: Tx, e: Extract<LcEvent, { t: 'call-ended' }>): void {
  const r = tx.run;
  if (!r || r.id !== e.run || r.step === 'closing') return;
  if (e.end === 'done') {
    if (r.recovered) tx.setRun({ dropped: 0, recovered: false });
    return;
  }
  // 4.5: an era refusal ends a modern run that is Ready (or refreshing or recovering on it); on a legacy run,
  // or one not yet Ready, it is that call's alone (G18).
  if (e.end === 'era-refusal') {
    if (r.era !== 'modern' || phaseOf(tx.s as LcState) !== 'ready') return;
    return end(tx, 'era-changed', e.failure ?? { kind: 'protocol', words: 'The server changed its protocol version.' });
  }
  sessionEnded(tx);
}

function notice(tx: Tx, run: string): void {
  const r = tx.run;
  if (!r || r.id !== run || r.era !== 'legacy' || r.step === 'closing' || r.step === 'relaunch' || r.step === 'grace' || r.step === 'launching') return;
  tx.setRun({ changes: r.changes + 1 });
  if (r.step !== 'ready' && r.purpose !== 'start' && (__FAMILIAR_MUTATIONS__ && mutant('walk-beside-walk'))) tx.setRun({ refreshOwed: true });
  if (r.step !== 'ready') return; // a walk under way absorbs it, at its end or its settle
  if (tx.s.slot === 'idle') return refresh(tx);
  if (!(__FAMILIAR_MUTATIONS__ && (mutant('lc-refresh-dropped') || mutant('refresh-through-list')))) tx.setRun({ refreshOwed: true });
}

/* ---------- deadlines, saves, the relaunch ---------- */

function deadline(tx: Tx, which: DeadlineKind): void {
  const r = tx.run!;
  tx.setRun({ deadline: undefined });
  if (which === 'stop') {
    if (r.native?.start === 'pending') {
      // The exe hasn't answered the start: every waiter is answered now, in those words; the owner stays
      // held for the native start (5.4), and its answer finishes the run.
      for (const w of tx.s.waiters.filter((x) => x.run === r.id)) tx.answer(w.token, { kind: 'failed', failure: START_UNANSWERED });
      return;
    }
    return finish(tx, 'unconfirmed');
  }
  if (which === 'start') {
    if (r.step === 'launching') {
      for (const w of tx.s.waiters.filter((x) => x.run === r.id && x.kind !== 'stop')) tx.answer(w.token, { kind: 'failed', failure: START_UNANSWERED });
      return end(tx, 'deadline', START_UNANSWERED);
    }
    if (r.step === 'relaunch') return finish(tx, 'done', 'deadline', START_TIMEOUT);
    return endAnswering(tx, 'deadline', START_TIMEOUT);
  }
  if (which === 'list') return endAnswering(tx, 'deadline', LIST_TIMEOUT);
  if (which === 'recovery') return endAnswering(tx, 'session-ended', SESSION_ENDED);
  return endAnswering(tx, 'list-unanswered', r.graceFailure ?? { kind: 'exited', words: 'The server closed the connection.' });
}

/**
 * The start's (or Test's) own deadline, kept aside while the step had another: the action is answered now,
 * at its original time. A run already closing answers it from its kept cause and carries on with its
 * cleanup under the stop deadline; any other step ends as the start deadline ends it.
 */
function actionDeadline(tx: Tx): void {
  const r = tx.run!;
  tx.setRun({ saveBy: undefined });
  if (r.step === 'closing') {
    const failure: Failure = r.native?.start === 'pending' ? START_UNANSWERED : r.cause === 'test-done' ? START_TIMEOUT : (r.failure ?? START_TIMEOUT);
    for (const w of tx.s.waiters.filter((x) => x.run === r.id && x.kind !== 'stop')) {
      tx.answer(w.token, w.kind === 'start' && (r.cause === 'person-stop' || r.cause === 'turned-off') ? { kind: 'stopped' } : { kind: 'failed', failure });
    }
    return;
  }
  return deadline(tx, 'start');
}

/** The words an orphan gives every later action, by how its stop ended. */
function orphanWords(s: LcState): Failure {
  return s.orphans.some((o) => o.how === 'refused' || o.how === undefined) ? STOP_REFUSED : STOP_UNCONFIRMED;
}

/** A deadline ends the run, and answers its start or Test at once, in the cause's words: the person's action
    never waits on the process's own stop (I9). A Stop's waiter keeps waiting for the stop, under its own
    deadline. */
function endAnswering(tx: Tx, cause: Cause, failure: Failure): void {
  const r = tx.run!;
  for (const w of tx.s.waiters.filter((x) => x.run === r.id && x.kind !== 'stop')) tx.answer(w.token, { kind: 'failed', failure });
  end(tx, cause, failure);
}

function answerReady(tx: Tx): void {
  const r = tx.run!;
  for (const w of tx.s.waiters.filter((x) => x.run === r.id && x.kind === 'start')) tx.answer(w.token, { kind: 'ready' });
  // Test lists, then stops its own run.
  if (tx.s.waiters.some((x) => x.run === r.id && x.kind === 'test')) end(tx, 'test-done', { kind: 'exited', words: STOPPED_WORDS });
}

function saved(tx: Tx, gen: number, outcome: 'saved' | 'skipped' | 'failed'): void {
  const s = tx.s;
  if (s.saving?.gen !== gen) return;
  s.saving = undefined;
  const r = s.run;
  if (s.dirty) {
    s.dirty = false;
    if (r && r.gen > gen && r.step !== 'closing') tx.saveCatalog();
  }
  const first = !!r && r.firstSave === 'pending' && r.firstGen === gen;
  // A later catalog write that failed keeps its generation and is tried once more; a second failure is the
  // owner's to report (the client shows it), and the generation stays marked unsaved.
  if (r && !first && r.step !== 'closing') {
    if (outcome === 'failed' && r.gen === gen && !s.saving && r.unsaved !== gen && !(__FAMILIAR_MUTATIONS__ && mutant('lc-failed-save-dropped'))) {
      tx.setRun({ unsaved: gen });
      tx.saveCatalog();
      return;
    }
    if (outcome !== 'failed' && r.unsaved !== undefined && r.unsaved <= gen) tx.setRun({ unsaved: undefined });
  }
  if (!r || !first) return;
  tx.setRun({ firstSave: 'done' });
  // Already ending (a Stop, a crash): its waiters get the kept cause's words when it ends.
  if (r.step === 'closing') return;
  if (outcome === 'failed') return end(tx, 'catalog-failed', CATALOG_FAILED);
  answerReady(tx);
}

function readmit(tx: Tx, e: Extract<LcEvent, { t: 'readmit' }>): void {
  const s = tx.s;
  if ((__FAMILIAR_MUTATIONS__ && mutant('lc-readmit-after-stop')) && s.zombie === e.run && !s.run && e.facts.ownerFree) {
    // The mutation: the relaunch Stop cancelled launches anyway.
    const id = `${s.id}#${++s.nextRun}`;
    s.run = { ...emptyRun(id, 'local', 'start', e.facts.launch), era: 'modern', relaunched: true, step: 'launching', native: { start: 'pending', stop: 'none', exited: false } };
    s.owner = 'start';
    tx.emit({ t: 'owner-hold' });
    tx.emit({ t: 'native-start', run: id, era: 'modern' });
    return;
  }
  const r = s.run;
  if (!r || r.id !== e.run || r.step !== 'relaunch') return;
  // Decided here, from the run's own admitted mode and launch and the facts read now: never from anything a
  // later action changed.
  const f = e.facts;
  if (!f.ownerFree) return finish(tx, 'done', 'readmit-refused', { kind: 'busy', words: f.ownerWords || 'Familiar is saving another change. Press Start again.' });
  // Turned off meanwhile (an automatic start's relaunch): Stopped, as it was asked.
  if (r.mode === 'auto' && !f.enabled) return finish(tx, 'done', 'turned-off', { kind: 'exited', words: 'It is turned off.' });
  if (f.launch !== r.launch) return finish(tx, 'done', 'readmit-refused', { kind: 'busy', words: 'The setup changed. Press Start again.' });
  const id = `${s.id}#${++s.nextRun}`;
  // The admission's own deadline carries over: the relaunch gets no fresh budget.
  s.run = { ...emptyRun(id, 'local', r.mode, r.launch), era: 'modern', relaunched: true, step: 'launching', native: { start: 'pending', stop: 'none', exited: false }, ...(r.deadline ? { deadline: r.deadline } : {}), ...(r.saveBy !== undefined ? { saveBy: r.saveBy } : {}) };
  s.waiters = s.waiters.map((w) => (w.run === r.id ? { ...w, run: id } : w));
  s.owner = 'start';
  tx.emit({ t: 'owner-hold' });
  tx.emit({ t: 'native-start', run: id, era: 'modern' });
  if (__FAMILIAR_MUTATIONS__ && mutant('lc-relaunch-fresh-budget')) tx.arm('start');
}

function emptyRun(id: string, where: Where, mode: Mode, launch: string): Run {
  return { id, where, launch, era: 'legacy', mode, relaunched: false, purpose: 'start', step: 'launching', changes: 0, gen: 0, refreshOwed: false, dropped: 0, recovered: false, killed: false, modernOpening: false, firstSave: 'none', firstGen: 0 };
}

function exhausted(tx: Tx, failure: Failure): void {
  const s = tx.s;
  if (s.held) return;
  s.held = failure;
  // (The named mutation leaves a start parked between its handshake's steps to its own deadline.)
  if ((__FAMILIAR_MUTATIONS__ && mutant('no-stuck-wake'))) return;
  // Every waiter, a start parked between its handshake's steps included, is answered in this transition.
  for (const w of [...s.waiters]) tx.answer(w.token, { kind: 'failed', failure });
  if (s.run && s.run.step !== 'closing') end(tx, 'held', failure);
}

/* ---------- every end ---------- */

/** The one way a run ends: the cause kept, the live exchange ended, a local process stopped once. */
function end(tx: Tx, cause: Cause, failure: Failure): void {
  const r = tx.run!;
  if (r.step === 'closing') return;
  tx.disarm();
  const unfenced = cause === 'person-stop' && (__FAMILIAR_MUTATIONS__ && mutant('no-stop-fence'));
  if (!unfenced) tx.emit({ t: 'end-live', run: r.id });
  tx.setRun({ cause, failure, step: 'closing', ...((__FAMILIAR_MUTATIONS__ && mutant('lc-admit-after-fence')) || unfenced ? {} : { want: undefined }) });
  // 6b.2 and 6b.3: a Start, and a Test (but for its own cleanup), is answered now, as its run begins closing,
  // in the kept cause's words: it never waits on cleanup. Only Stop waits for the exit.
  if (!(__FAMILIAR_MUTATIONS__ && mutant('lc-start-waits-cleanup'))) {
    const words: Failure = cause === 'person-stop' ? STOPPED_EARLY : failure;
    // Kind failed, in the kept cause's words; a person's Stop in words saying it was stopped before it finished
    // starting (6b.2). Kind stopped is the Stop waiter's, once the exit is seen.
    for (const w of tx.s.waiters.filter((x) => x.run === r.id && (x.kind === 'start' || (x.kind === 'test' && cause !== 'test-done')))) {
      // (The named mutation answers a start Stop met during its catalog write as if it were ready.)
      if (cause === 'person-stop' && r.firstSave === 'pending' && (__FAMILIAR_MUTATIONS__ && mutant('ready-after-stop'))) tx.answer(w.token, w.kind === 'test' ? { kind: 'tested', run: r.id } : { kind: 'ready' });
      else tx.answer(w.token, { kind: 'failed', failure: words });
    }
  }
  // Test's own cleanup: its waiter moves to the stop deadline armed below (the one rebinding allowed).
  if (cause === 'test-done' && tx.run!.saveBy !== undefined) {
    tx.emit({ t: 'disarm', id: tx.run!.saveBy });
    tx.setRun({ saveBy: undefined });
  }
  if (r.where === 'remote') return finish(tx, 'done');
  const n = r.native!;
  if (n.start === 'pending') {
    if (!(__FAMILIAR_MUTATIONS__ && mutant('lc-no-stop-deadline'))) tx.arm('stop');
    return;
  }
  if (n.process && !n.exited) {
    if (n.stop === 'none') {
      tx.setRun({ native: { ...n, stop: 'pending' }, killed: true });
      tx.emit({ t: 'native-stop', run: r.id, process: n.process });
    }
    if (!(__FAMILIAR_MUTATIONS__ && mutant('lc-no-stop-deadline'))) tx.arm('stop');
    return;
  }
  finish(tx, 'done');
}

/**
 * The run is over for Familiar. `refused`: the exe refused the stop; `unconfirmed`: the stop deadline
 * outran the exit. In both the process may still run: it stays as an orphan, fencing the next Start, and
 * every waiter's words say so. A start or Test waiter is answered from the kept cause.
 */
function finish(tx: Tx, how: 'done' | 'refused' | 'unconfirmed', causeNow?: Cause, failureNow?: Failure): void {
  const s = tx.s;
  const r = s.run!;
  tx.disarm();
  const cause = r.cause ?? causeNow ?? 'exit';
  const failure = r.failure ?? failureNow ?? { kind: 'exited', words: STOPPED_WORDS };
  const alive = !!r.native?.process && !r.native.exited;
  const mayRun = alive && how !== 'done';
  if (alive) s.orphans = [...s.orphans, { run: r.id, process: r.native!.process!, how: how === 'refused' ? 'refused' : 'unconfirmed' }];
  // Once per exit: a relaunch released them when its process exited.
  else if (r.native?.process && r.step !== 'relaunch') tx.emit({ t: 'release-writes', process: r.native.process });
  const stillWords = how === 'refused' ? STOP_REFUSED : STOP_UNCONFIRMED;
  if (r.saveBy !== undefined && !s.waiters.some((w) => w.run === r.id && w.kind !== 'stop')) {
    tx.emit({ t: 'disarm', id: r.saveBy });
    tx.setRun({ saveBy: undefined });
  }
  const own = cause === 'person-stop' || cause === 'test-done' || cause === 'turned-off';
  const words: Failure = mayRun ? (own ? stillWords : { kind: failure.kind, words: `${failure.words} ${stillWords.words}` }) : failure;
  for (const w of s.waiters.filter((x) => x.run === r.id)) {
    // A Stop's own answer is the stop's outcome: the orphan's words when it may still run (6b.8).
    if (w.kind === 'stop') tx.answer(w.token, mayRun || (alive && !(__FAMILIAR_MUTATIONS__ && mutant('lc-stopped-on-refusal'))) ? { kind: 'failed', failure: mayRun ? stillWords : words } : { kind: 'stopped' });
    else if (w.kind === 'test' && cause === 'turned-off') tx.answer(w.token, { kind: 'failed', failure: { kind: 'exited', words: STOPPED_WORDS } });
    else if (w.kind === 'test') tx.answer(w.token, (cause === 'test-done' || (cause === 'person-stop' && (__FAMILIAR_MUTATIONS__ && mutant('ready-after-stop')))) && (!mayRun || (__FAMILIAR_MUTATIONS__ && mutant('lc-test-ok-on-refusal'))) ? { kind: 'tested', run: r.id } : { kind: 'failed', failure: words });
    else tx.answer(w.token, (cause === 'person-stop' || cause === 'turned-off' || (__FAMILIAR_MUTATIONS__ && mutant('lc-crash-words-lost'))) && !mayRun ? { kind: 'stopped' } : { kind: 'failed', failure: words });
  }
  // A Test leaves the server Stopped unless the process may still run; a person's Stop too.
  const failed = mayRun || (!own && r.mode !== 'test');
  s.run = undefined;
  // Beside Failed, a process that may still run shows its own words (section 6's residual, 6b.8); the cause's
  // words otherwise. (A waiter's words add "may still be running" to the cause's, 4.6.)
  s.after = failed ? { failed: true, failure: mayRun ? stillWords : words } : { failed: false };
  // Reported whenever the person didn't ask for it (4.6: "report-ended (if not person-asked)"): every end
  // but their Stop and Test's own cleanup, a Test's failure included.
  if (cause !== 'person-stop' && cause !== 'test-done' && cause !== 'turned-off' && cause !== 'held') tx.emit({ t: 'ended', run: r.id, failure: words });
}
