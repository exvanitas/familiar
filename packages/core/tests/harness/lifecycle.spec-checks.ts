// Invariant checks and the event alphabet for W, the exhaustive walk over the lifecycle machine.
// Written from LIFECYCLE-machine.md (sections 1 to 7), design 5.4 and 6, and the types file only: the
// machine's bodies were never seen. Every violation string starts with its clause id (CLAUSES below).
//
// Conventions:
// - checkTransition(prev, e, next, effects, m, hist): `hist` is the history up to `prev` (before e).
// - checkState(s, m, hist): `hist` is the history including the transition that produced `s`.
//   A walk runs both: checkTransition on every step, then checkState(next, m, advance(hist, ...)).
// - History is the world's side: what Familiar asked of Windows, the exchange and the owner, and what is
//   still outstanding. It is plain data, kept sorted, so a walk can digest it with the state.

import type { LcState, LcEvent, LcEffect, Run, Failure, Reply, DeadlineKind, Cause, Mode, Where, Waiter, StartFacts } from './lifecycle.spec-types.ts';
import {
  STOPPED_WORDS, STOP_REFUSED, STOP_UNCONFIRMED, START_UNANSWERED, START_TIMEOUT, LIST_TIMEOUT, SESSION_ENDED,
  KEPT_CHANGING, TOO_MANY_PAGES, WATCHDOG, CATALOG_FAILED, MAX_PAGES, SETUP_CHANGED,
} from './lifecycle.spec-types.ts';

export type Phase = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed' | 'held';

export interface Machine {
  callable(s: LcState): boolean;
  phaseOf(s: LcState): Phase;
  fenced(s: LcState): boolean;
  offering(s: LcState): boolean;
  failureOf(s: LcState): Failure | undefined;
  /** The note Settings shows beside a running server (6b.13): today only the unsaved latest tool list. */
  noteOf(s: LcState): string | undefined;
}

// ---------------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------------

export interface OpenWaiter {
  readonly token: string;
  readonly kind: 'start' | 'test' | 'stop';
  /** The run the waiter belongs to (moved to the relaunched run on a relaunch). */
  readonly run?: string;
  /** The deadline that bounds its answer: the start deadline armed at admission for Start and Test, the
      stop deadline for Stop. Rebound only where the spec says so: a start or Test waiter moves to the stop
      deadline armed when its run enters closing (4.6, the kept-cause table). */
  readonly bound?: number;
}
export interface Armed { readonly id: number; readonly which: DeadlineKind; readonly run?: string }

export interface History {
  runs: string[];                                   // every run id that ever existed
  ids: number[];                                    // every deadline id ever armed
  armed: Armed[];                                   // armed, not yet fired or disarmed
  startPending: string[];                           // runs with a native start Windows hasn't answered
  stopPending: string[];                            // runs with a native stop Windows hasn't answered
  stopIssued: string[];                             // runs that were ever sent native-stop (killed)
  alive: { process: string; run: string }[];        // processes started and not seen to exit
  open: OpenWaiter[];                               // person actions not yet answered
  answered: string[];                               // tokens answered
  stopReply: { run: string; reply: string }[];      // the first Stop answer per run (canonical JSON)
  saving?: number;                                  // gen of the catalog write in flight
  lastSave?: number;                                // gen of the last save issued
  lastPublish?: number;                             // newest gen published
  runPublish: { run: string; last: number }[];      // newest gen published per run
  firstSave: { run: string; gen: number; outcome?: 'saved' | 'skipped' | 'failed' }[];
  kept: { run: string; cause: Cause; words: string }[];   // the kept cause, fixed when the run began ending ('*' = any words)
  fenced: string[];                                 // runs that got end-live
  /** Admin exchanges issued and awaiting their admin-done (ended: end-live made it terminal, it can only
      come back unanswered). Kept after its run leaves: the world still answers it. */
  exchange: { run: string; kind: 'initialize' | 'initialized' | 'list'; page?: number; ended?: boolean }[];
  slot: 'idle' | 'busy';                            // the exchange machine's slot, as the world has it
  live?: string;                                    // the run whose exchange (admin, call or ping) holds the slot, not yet ended
  remote: string[];                                 // runs that are remote
  orphanWords: { process: string; words: string }[]; // each orphan's own stop outcome (6b.8; '*' = unknown)
  listAnswered: string[];                           // runs whose list got an answer of any kind
  stoppedBy: string[];                              // runs a person's Stop reached
  readmit: string[];                                // runs awaiting the readmit facts
  graceWords: { run: string; words: string }[];     // the unanswered list's words, for grace's end
  reported: string[];                               // runs that got report-ended
  savingRun?: string;                               // the run whose catalog write is in flight
  saveFails: { gen: number; count: number }[];      // failures per generation of later writes (6b.13)
  writes: { run: string; gen: number; count: number }[]; // writes issued per run and generation (6b.13: at most two)
  /** A save asked for and deferred (6b.13 "in its turn"): the run's newest generation settled (Ready entered) while
      a write was in flight, and that generation hasn't been saved since. */
  askedFor?: { run: string; gen: number };
  unsaved?: { run: string; gen: number };           // the last generation a later write failed twice for (6b.13); kept once superseded
}

export function initialHistory(): History {
  return {
    runs: [], ids: [], armed: [], startPending: [], stopPending: [], stopIssued: [], alive: [], open: [], answered: [],
    stopReply: [], runPublish: [], firstSave: [], kept: [], fenced: [], exchange: [], slot: 'idle', remote: [], orphanWords: [],
    listAnswered: [], stoppedBy: [], readmit: [], graceWords: [], reported: [], saveFails: [], writes: [],
  };
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

export function canon(x: unknown): string {
  if (x === undefined) return 'undefined';
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  const o = x as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const uniq = <T>(xs: T[]) => Array.from(new Set(xs));
const WALK_STEPS = ['opening', 'initialized', 'walking', 'settling'];

/** Words that tell the person the process may still run (or start). */
export const msrWords = (w: string) => /may still be (running|starting)/.test(w);
/** Something of this server may still run: a process not seen to exit, or a native start not answered. */
export const msr = (h: History) => h.alive.length > 0 || h.startPending.length > 0;

const keptOf = (h: History, run?: string) => h.kept.find((k) => k.run === run);
/** 6b.13: the note shown with a server whose newest published generation is marked unsaved (exact words). */
export const UNSAVED_NOTE = "Familiar couldn't save this server's latest tool list; it shows the list it saved before.";
/** The same words, however punctuated, for the check that a failure never carries them. */
export const UNSAVED_RE = /couldn.t save this server.s latest tool list/i;
/** A later catalog write (a refresh's or a recovery's): not any run's first (6b.13). */
const laterSave = (h: History, gen: number) => !h.firstSave.some((f) => f.gen === gen);
const armedEntry = (h: History, id: number) => h.armed.find((a) => a.id === id);
const wordsOf = (r: Reply): string | undefined => (r.kind === 'failed' ? r.failure.words : r.kind === 'refused' ? r.words : undefined);

/** Phase "ready" covers ready, refreshing and recovering (section 1). */
export function phaseReadyRun(r: Run): boolean {
  return r.step === 'ready' || ((r.purpose === 'refresh' || r.purpose === 'recovery') && WALK_STEPS.includes(r.step));
}
/** The phase as section 1 derives it. With no run it is Stopped or Failed; which one is checked per ending. */
export function derivedPhase(s: LcState): Phase {
  if (s.held) return 'held';
  const r = s.run;
  if (!r) return s.after?.failed ? 'failed' : 'stopped';
  if (r.step === 'closing') return 'stopping';
  if (phaseReadyRun(r)) return 'ready';
  return 'starting';
}
/** callable as section 1 defines it (and never while held). */
export function callableFormula(s: LcState): boolean {
  const r = s.run;
  return !s.held && !!r && r.step === 'ready' && s.slot === 'idle' && !r.refreshOwed && r.published !== undefined && r.changes === r.published;
}

function eventRun(e: LcEvent): string | undefined {
  switch (e.t) {
    case 'started': case 'stop-answered': case 'write-bound': case 'admin-done': case 'call-ended': case 'notice': case 'readmit':
      return e.run;
    default:
      return undefined;
  }
}
/** An event carrying a run id that isn't the current run's (I4). */
const isOld = (prev: LcState, e: LcEvent) => { const id = eventRun(e); return id !== undefined && id !== prev.run?.id; };
function exitOf(prev: LcState, e: LcEvent): 'run' | 'orphan' | 'unknown' | undefined {
  if (e.t !== 'exit') return undefined;
  const r = prev.run;
  if (r?.native?.process === e.process && !r.native.exited) return 'run';
  if (prev.orphans.some((o) => o.process === e.process)) return 'orphan';
  return 'unknown';
}
/** A deadline the world has armed for the current run (anything else is stale). */
const liveDeadline = (prev: LcState, e: LcEvent, h: History) =>
  e.t === 'deadline' && h.armed.some((a) => a.id === e.id && a.run !== undefined && a.run === prev.run?.id);
/** 6b.11 (narrowed): turned off gates only an automatic start (4.1). A relaunch's readmit goes on when it is ok,
    or, for a person's own Start or Test (mode start or test), when turned off is its only refusal: `off` with the
    owner free and the setup unchanged. */
function readmitGoesOn(r: Run, e: Extract<LcEvent, { t: 'readmit' }>): boolean {
  return e.ok || (e.off === true && r.mode !== 'auto');
}
/** A readmit for the run waiting in relaunch that lets the relaunch go on (row 174, 6b.11). */
const readmitPasses = (prev: LcState, e: LcEvent) =>
  e.t === 'readmit' && !!prev.run && prev.run.step === 'relaunch' && e.run === prev.run.id && readmitGoesOn(prev.run, e);
/** The relaunch's continuation: a passing readmit in the relaunch step makes the new run. */
const isCont = (prev: LcState, e: LcEvent, next: LcState) =>
  readmitPasses(prev, e) && !!next.run && next.run.id !== prev.run!.id;
/** An exchange of this run still live in the world (6b.5, 6b.12): one holding the slot, or an admin exchange
    awaiting its outcome that no end-live has ended. */
const worldLive = (h: History, run: string) => h.live === run || h.exchange.some((x) => x.run === run && !x.ended);
/** The person's own choice (no report-ended; Stopped unless something may still run): a person's Stop, Test's
    own cleanup, and turned off, which only an automatic start's relaunch can meet (6b.11). */
const ownChoice = (cause: Cause, mode: Mode) => cause === 'person-stop' || cause === 'test-done' || (cause === 'turned-off' && mode === 'auto');
/** A live run ends now: it leaves the state or enters closing (not the relaunch's continuation). */
function endsNow(prev: LcState, e: LcEvent, next: LcState): boolean {
  const r = prev.run, n = next.run;
  if (!r || r.step === 'closing' || isCont(prev, e, next)) return false;
  return n?.id !== r.id || n.step === 'closing';
}
const recordOk = (mode: Mode, f: StartFacts) => f.record === 'ok' || (f.record === 'disabled' && mode !== 'auto');
const heldWordsOf = (prev: LcState, next: LcState, e: LcEvent) =>
  prev.held?.words ?? next.held?.words ?? (e.t === 'exhausted' ? e.failure.words : undefined);

function recoveryEligible(r: Run): boolean {
  return r.where === 'remote' && r.dropped === 0 && (r.step === 'ready' || (r.purpose === 'refresh' && WALK_STEPS.includes(r.step)));
}
function graceEligible(r: Run, h: History): boolean {
  return r.where === 'local' && r.era === 'modern' && !r.relaunched && r.purpose === 'start' && !r.killed && r.cause === undefined
    && !h.stopIssued.includes(r.id) && !h.listAnswered.includes(r.id);
}
/** The exits a relaunch may begin from: grace's (row 172), or one arriving while the modern opening's first
    list is still in flight on a local, unkilled, never-answered first launch (6b.9). */
function relaunchExit(r: Run, e: LcEvent, h: History): boolean {
  if (e.t !== 'exit' || r.native?.process !== e.process || r.native.exited) return false;
  if (r.step === 'grace') return !r.killed && !h.stopIssued.includes(r.id);
  return r.step === 'walking' && graceEligible(r, h) && (r.walk?.attempt ?? 0) === 0;
}
/** 6b.10 and row 155: a recovery's re-handshake answered in the other era (or refused as modern-only). */
function recoveryEraEnd(r: Run, e: LcEvent): boolean {
  return e.t === 'admin-done' && e.run === r.id && r.step === 'opening' && r.purpose === 'recovery'
    && (e.outcome.k === 'modern-refusal' || (e.outcome.k === 'legacy' && r.era === 'modern'));
}
function startingStep(r: Run): boolean {
  return r.step === 'relaunch' || r.step === 'launching' || r.step === 'grace' || (r.purpose === 'start' && WALK_STEPS.includes(r.step));
}

// ---------------------------------------------------------------------------------------------------------
// What the table says an event does to a live run (4.2 to 4.7): end it (with which causes and words), or not.
// ---------------------------------------------------------------------------------------------------------

type Ending = { k: 'end'; causes: Cause[]; words: string } | { k: 'stay' };
const END = (causes: Cause[], words: string): Ending => ({ k: 'end', causes, words });
const STAY: Ending = { k: 'stay' };

export function endingOf(prev: LcState, e: LcEvent, h: History): Ending {
  const r = prev.run;
  if (!r || r.step === 'closing') return STAY;
  switch (e.t) {
    case 'stop':
      return prev.held ? STAY : END(['person-stop'], STOPPED_WORDS);
    case 'started':
      return e.run === r.id && r.step === 'launching' && !e.ok ? END(['start-failed', 'handshake'], e.failure.words) : STAY;
    case 'exit':
      if (r.native?.process !== e.process || r.native.exited) return STAY;
      if (relaunchExit(r, e, h)) return STAY; // the relaunch check
      return END(['exit'], e.failure.words);
    case 'write-bound':
      return e.run === r.id && r.native?.start === 'ok' && !r.native.exited ? END(['watchdog'], WATCHDOG.words) : STAY;
    case 'slot':
      if (e.idle && r.step === 'settling' && r.changes !== r.published && (r.walk?.attempt ?? 0) >= 2) return END(['list-answered'], KEPT_CHANGING.words);
      return STAY;
    case 'admin-done': {
      if (e.run !== r.id) return STAY;
      const o = e.outcome;
      const dropped = recoveryEligible(r) ? STAY : END(['session-ended'], SESSION_ENDED.words);
      if (r.step === 'opening') {
        if (recoveryEraEnd(r, e)) return END(['session-ended'], SESSION_ENDED.words);
        if (o.k === 'refused' || o.k === 'invalid') return END(['handshake'], o.failure.words);
        if (o.k === 'unanswered') return END(['handshake', 'list-unanswered'], o.failure.words);
        if (o.k === 'session-ended') return dropped;
        return STAY;
      }
      if (r.step === 'initialized') {
        if (o.k === 'refused' || o.k === 'invalid') return END(['handshake'], o.failure.words);
        if (o.k === 'unanswered') return END(['handshake', 'list-unanswered'], o.failure.words);
        if (o.k === 'session-ended') return dropped;
        return STAY;
      }
      if (r.step === 'walking') {
        if (o.k === 'page') {
          const page = (r.inFlight?.kind === 'list' ? r.inFlight.page : undefined) ?? r.walk?.page ?? 1;
          if (o.more) return page >= MAX_PAGES ? END(['list-answered'], TOO_MANY_PAGES.words) : STAY;
          const startedAt = r.walk?.startedAt ?? r.changes;
          if (r.changes !== startedAt) return (r.walk?.attempt ?? 0) >= 2 ? END(['list-answered'], KEPT_CHANGING.words) : STAY;
          if (o.catalog !== undefined && o.catalog !== 'ok') return END(['list-answered'], o.catalog.words);
          return STAY;
        }
        if (o.k === 'refused' || o.k === 'invalid') return END(['list-answered'], o.failure.words);
        if (o.k === 'unanswered') return graceEligible(r, h) ? STAY : END(['list-unanswered'], o.failure.words);
        if (o.k === 'session-ended') return dropped;
        return STAY;
      }
      return STAY;
    }
    case 'call-ended':
      if (e.run !== r.id) return STAY;
      if (e.end === 'session-ended') return recoveryEligible(r) ? STAY : END(['session-ended'], SESSION_ENDED.words);
      if (e.end === 'era-refusal' && r.era === 'modern' && phaseReadyRun(r)) return END(['era-changed'], e.failure?.words ?? '*');
      return STAY;
    case 'exhausted':
      return prev.held ? STAY : END(['held'], e.failure.words);
    case 'deadline': {
      const a = armedEntry(h, e.id);
      if (!a || a.run !== r.id) return STAY;
      if (a.which === 'start') {
        if (r.step === 'launching') return END(['deadline'], START_UNANSWERED.words);
        if (startingStep(r)) return END(['deadline'], START_TIMEOUT.words);
        // The start's own deadline still bounds a start or Test waiter during its first catalog write.
        if (phaseReadyRun(r) && h.open.some((w) => w.run === r.id && w.bound === e.id)) return END(['deadline'], START_TIMEOUT.words);
        return STAY;
      }
      if (a.which === 'list') return r.purpose === 'refresh' && WALK_STEPS.includes(r.step) ? END(['deadline'], LIST_TIMEOUT.words) : STAY;
      if (a.which === 'recovery') return r.purpose === 'recovery' && WALK_STEPS.includes(r.step) ? END(['session-ended'], SESSION_ENDED.words) : STAY;
      if (a.which === 'grace') return r.step === 'grace' ? END(['list-unanswered'], h.graceWords.find((g) => g.run === r.id)?.words ?? '*') : STAY;
      return STAY;
    }
    case 'saved': {
      const fs = h.firstSave.find((f) => f.run === r.id);
      if (!fs || fs.gen !== e.gen || fs.outcome !== undefined || !phaseReadyRun(r)) return STAY;
      if (e.outcome === 'failed') return END(['catalog-failed'], CATALOG_FAILED.words);
      return r.mode === 'test' ? END(['test-done'], '') : STAY;
    }
    case 'readmit':
      if (e.run !== r.id || r.step !== 'relaunch' || readmitGoesOn(r, e)) return STAY;
      // 6b.11: an automatic start's turned off is the person's own choice; the other refusals fail in the
      // readmit's words. A person's own Start or Test is not gated by turned off (readmitGoesOn).
      return e.off && r.mode === 'auto' ? END(['turned-off'], e.words ?? '*') : END(['readmit-refused'], e.words ?? '*');
    default:
      return STAY;
  }
}

/** What an event does to a closing run: it leaves the state, or it stays (4.2, 4.6). */
export function closingOutcome(prev: LcState, e: LcEvent, h: History): 'leave' | 'stay' {
  const r = prev.run!;
  switch (e.t) {
    case 'exit': return r.native?.process === e.process && !r.native.exited ? 'leave' : 'stay';
    case 'stop-answered': return e.run === r.id && !e.ok ? 'leave' : 'stay';
    case 'started': return e.run === r.id && !e.ok ? 'leave' : 'stay';
    case 'deadline': {
      const a = armedEntry(h, e.id);
      if (!a || a.run !== r.id || a.which !== 'stop') return 'stay';
      return r.native?.start === 'pending' ? 'stay' : 'leave';
    }
    case 'exhausted': return prev.held ? 'stay' : 'leave';
    default: return 'stay';
  }
}

// ---------------------------------------------------------------------------------------------------------
// advance: the world after a transition
// ---------------------------------------------------------------------------------------------------------

export function advance(hist: History, prev: LcState, e: LcEvent, next: LcState, effects: readonly LcEffect[]): History {
  const x: History = JSON.parse(JSON.stringify(hist));
  const r = prev.run, n = next.run;
  const old = isOld(prev, e);
  const cont = isCont(prev, e, next);

  // The event's own facts about the world.
  switch (e.t) {
    case 'deadline': x.armed = x.armed.filter((a) => a.id !== e.id); break;
    case 'started':
      x.startPending = x.startPending.filter((s) => s !== e.run);
      if (e.ok) x.alive.push({ process: e.process, run: e.run });
      break;
    case 'stop-answered': x.stopPending = x.stopPending.filter((s) => s !== e.run); break;
    case 'exit':
      x.alive = x.alive.filter((a) => a.process !== e.process);
      x.orphanWords = x.orphanWords.filter((o) => o.process !== e.process);
      break;
    case 'slot':
      // A busy edge from idle is an exchange of the current run (a ping, or a call it handed off).
      if (!e.idle && hist.slot === 'idle' && r) x.live = r.id;
      if (e.idle) x.live = undefined;
      x.slot = e.idle ? 'idle' : 'busy';
      break;
    case 'saved':
      if (x.saving === e.gen && e.outcome === 'failed' && laterSave(hist, e.gen)) {
        const f = x.saveFails.find((y) => y.gen === e.gen);
        if (f) f.count++; else x.saveFails.push({ gen: e.gen, count: 1 });
        if ((f?.count ?? 1) >= 2 && x.savingRun !== undefined) x.unsaved = { run: x.savingRun, gen: e.gen };
      }
      if (x.saving === e.gen) { x.saving = undefined; x.savingRun = undefined; }
      for (const f of x.firstSave) if (f.gen === e.gen && f.outcome === undefined) f.outcome = e.outcome;
      break;
    case 'readmit': x.readmit = x.readmit.filter((s) => s !== e.run); break;
    case 'admin-done': {
      const i = x.exchange.findIndex((xx) => xx.run === e.run);
      if (i >= 0) x.exchange.splice(i, 1);
      if (r && e.run === r.id && r.step === 'walking') {
        if (e.outcome.k === 'page' || e.outcome.k === 'refused' || e.outcome.k === 'invalid') x.listAnswered.push(r.id);
        if (e.outcome.k === 'unanswered') { x.graceWords = x.graceWords.filter((g) => g.run !== r.id); x.graceWords.push({ run: r.id, words: e.outcome.failure.words }); }
      }
      break;
    }
    case 'stop': if (r && !prev.held) x.stoppedBy.push(r.id); break;
    default: break;
  }

  // The kept cause, fixed when a live run begins ending.
  if (r && !old && !keptOf(x, r.id) && endsNow(prev, e, next)) {
    const eo = endingOf(prev, e, hist);
    if (eo.k === 'end') {
      const cause = n && n.id === r.id && n.cause !== undefined && eo.causes.includes(n.cause) ? n.cause : eo.causes[0];
      x.kept.push({ run: r.id, cause, words: eo.words });
    }
  }

  // Effects.
  let startArm: number | undefined;
  let stopArm: number | undefined;
  const answeredNow = new Set<string>();
  for (const f of effects) {
    switch (f.t) {
      case 'arm':
        x.armed.push({ id: f.id, which: f.which, run: n?.id ?? r?.id });
        x.ids.push(f.id);
        if (f.which === 'start') startArm = f.id;
        if (f.which === 'stop') stopArm = f.id;
        break;
      case 'disarm': x.armed = x.armed.filter((a) => a.id !== f.id); break;
      case 'native-start': x.startPending.push(f.run); break;
      case 'native-stop': x.stopPending.push(f.run); x.stopIssued.push(f.run); break;
      case 'admin':
        x.exchange.push({ run: f.run, kind: f.want.kind, page: f.want.kind === 'list' ? f.want.page : undefined });
        x.slot = 'busy';
        x.live = f.run;
        break;
      case 'end-live':
        x.fenced.push(f.run);
        if (x.live === f.run) x.live = undefined;
        x.exchange = x.exchange.map((xx) => (xx.run === f.run ? { ...xx, ended: true } : xx));
        break;
      case 'publish':
        x.lastPublish = f.gen;
        x.runPublish = x.runPublish.filter((p) => p.run !== f.run);
        x.runPublish.push({ run: f.run, last: f.gen });
        break;
      case 'save':
        x.saving = f.gen;
        x.savingRun = f.run;
        x.lastSave = f.gen;
        { const w = x.writes.find((y) => y.run === f.run && y.gen === f.gen); if (w) w.count++; else x.writes.push({ run: f.run, gen: f.gen, count: 1 }); }
        if (x.askedFor && f.gen >= x.askedFor.gen) x.askedFor = undefined;
        if (!x.firstSave.some((s) => s.run === f.run)) x.firstSave.push({ run: f.run, gen: f.gen });
        break;
      case 'answer': {
        answeredNow.add(f.token);
        x.answered.push(f.token);
        const w = x.open.find((o) => o.token === f.token);
        x.open = x.open.filter((o) => o.token !== f.token);
        const isStop = w ? w.kind === 'stop' : e.t === 'stop' && e.token === f.token;
        const run = w ? w.run : r?.id;
        if (isStop && run !== undefined && !x.stopReply.some((s) => s.run === run)) x.stopReply.push({ run, reply: canon(f.reply) });
        break;
      }
      case 'readmit-check': x.readmit.push(f.run); break;
      case 'ended': x.reported.push(f.run); break;
      default: break;
    }
  }

  // A person action that became a waiter.
  if ((e.t === 'start' || e.t === 'stop') && !answeredNow.has(e.token) && next.waiters.some((w) => w.token === e.token)) {
    const kind: OpenWaiter['kind'] = e.t === 'stop' ? 'stop' : e.mode === 'test' ? 'test' : 'start';
    const run = n?.id;
    let bound: number | undefined;
    if (kind === 'stop') bound = stopArm ?? x.armed.find((a) => a.which === 'stop' && a.run !== undefined && a.run === run)?.id;
    else bound = startArm;
    x.open.push({ token: e.token, kind, run, bound });
  }

  // The relaunch carries the start's waiter and its deadline to the new run.
  if (cont && r && n) {
    x.open = x.open.map((w) => (w.run === r.id ? { ...w, run: n.id } : w));
    x.armed = x.armed.map((a) => (a.run === r.id ? { ...a, run: n.id } : a));
  }
  // The one rebinding (6b.3): a Test waiter whose run enters closing for its own cleanup moves to the stop
  // deadline armed in that same transition.
  if (n && n.step === 'closing' && n.cause === 'test-done' && !(r && r.id === n.id && r.step === 'closing') && stopArm !== undefined) {
    x.open = x.open.map((w) => (w.run === n.id && w.kind === 'test' ? { ...w, bound: stopArm } : w));
  }
  // A run that leaves with its process alive leaves an orphan, which keeps its own stop outcome (6b.8).
  if (r && n?.id !== r.id && r.native?.process && x.alive.some((a) => a.process === r.native!.process)
    && !x.orphanWords.some((o) => o.process === r.native!.process)) {
    const words = e.t === 'stop-answered' && !e.ok ? STOP_REFUSED.words : e.t === 'deadline' ? STOP_UNCONFIRMED.words : '*';
    x.orphanWords.push({ process: r.native.process, words });
  }
  // A settle (Ready entered from settling) while a write is in flight asks for the newest's save, deferred (6b.13).
  if (r && n && r.id === n.id && r.step === 'settling' && n.step === 'ready' && hist.saving !== undefined && x.saving === hist.saving) {
    const newest = x.runPublish.find((p) => p.run === n.id)?.last;
    if (newest !== undefined && newest !== x.saving && !effects.some((f) => f.t === 'save' && f.gen === newest)) x.askedFor = { run: n.id, gen: newest };
  }
  if (n && !x.runs.includes(n.id)) x.runs.push(n.id);
  if (n && n.where === 'remote' && !x.remote.includes(n.id)) x.remote.push(n.id);

  return normalize(x);
}

function normalize(x: History): History {
  const s = (a: string[]) => uniq(a).sort();
  const byJson = <T>(a: T[]) => a.slice().sort((p, q) => (canon(p) < canon(q) ? -1 : canon(p) > canon(q) ? 1 : 0));
  return {
    ...x,
    runs: s(x.runs), ids: uniq(x.ids).sort((a, b) => a - b), armed: byJson(x.armed), startPending: s(x.startPending),
    stopPending: s(x.stopPending), stopIssued: s(x.stopIssued), alive: byJson(x.alive), open: byJson(x.open),
    answered: s(x.answered), stopReply: byJson(x.stopReply), runPublish: byJson(x.runPublish), firstSave: byJson(x.firstSave),
    kept: byJson(x.kept), fenced: s(x.fenced), exchange: byJson(x.exchange), remote: s(x.remote), orphanWords: byJson(x.orphanWords),
    listAnswered: s(x.listAnswered),
    stoppedBy: s(x.stoppedBy), readmit: s(x.readmit), graceWords: byJson(x.graceWords), reported: s(x.reported),
    saveFails: byJson(x.saveFails), writes: byJson(x.writes),
  };
}

// ---------------------------------------------------------------------------------------------------------
// checkTransition
// ---------------------------------------------------------------------------------------------------------

export function checkTransition(
  prev: LcState, e: LcEvent, next: LcState, effects: readonly LcEffect[], m: Machine, hist: History,
): string[] {
  const out: string[] = [];
  const v = (id: string, msg: string) => out.push(`${id}: ${msg}`);
  const h2 = advance(hist, prev, e, next, effects);
  const r = prev.run, n = next.run;
  const answers = effects.filter((f): f is Extract<LcEffect, { t: 'answer' }> => f.t === 'answer');
  const count = (t: LcEffect['t']) => effects.filter((f) => f.t === t).length;
  const person = e.t === 'start' || e.t === 'stop';
  const old = isOld(prev, e);
  const ex = exitOf(prev, e);
  const cont = isCont(prev, e, next);
  const admitted = e.t === 'start' && !!n && n.id !== r?.id;
  const ended = endsNow(prev, e, next);
  const left = !!r && n?.id !== r.id && !cont;
  const unchanged = same(prev, next);

  // ---- I4: old-run events, unknown exits, stale deadlines ----
  if (old || ex === 'unknown') {
    if (!unchanged || effects.length) v('I4.old', `${e.t} for an earlier run (or an unknown process) changed the state or emitted ${effects.map((f) => f.t).join(',') || 'nothing'}`);
  }
  if (e.t === 'deadline' && !liveDeadline(prev, e, hist)) {
    if (!unchanged || effects.length) v('DL.stale', `deadline ${e.id} isn't armed for the current run, yet it changed something`);
  }
  if (ex === 'orphan' && e.t === 'exit') {
    const want = { ...prev, orphans: prev.orphans.filter((o) => o.process !== e.process) };
    if (!same(want, next) || effects.some((f) => f.t !== 'release-writes')) v('I4.orphan', `an orphan's exit changed more than its own orphan record`);
  }

  // ---- Person actions: admission (4.1), held, refusals ----
  if (person) {
    const ans = answers.some((a) => a.token === e.token);
    const inN = next.waiters.some((w) => w.token === e.token);
    if (ans === inN) v('I9.admit', `the ${e.t} (${e.token}) was ${ans ? 'both answered and kept as a waiter' : 'neither answered nor kept as a waiter'}`);
    const own = answers.find((a) => a.token === e.token);
    if (prev.held) {
      if (!own || !(own.reply.kind === 'failed' || own.reply.kind === 'refused') || wordsOf(own.reply) !== prev.held.words) v('HELD.words', `a ${e.t} while held wasn't answered the restart words`);
      if (!unchanged) v('PERSON.unchanged', `a ${e.t} while held changed the state`);
    } else if (e.t === 'stop' && !r) {
      if (!unchanged) v('PERSON.unchanged', 'a Stop with no run changed the state');
    }
  }
  if (e.t === 'start' && !prev.held) {
    const own = answers.find((a) => a.token === e.token);
    if (admitted && n) {
      if (r) v('ADMIT.no-run', `a ${e.mode} was admitted while run ${r.id} exists (phase ${m.phaseOf(prev)})`);
      if (!recordOk(e.mode, e.facts)) v('ADMIT.record', `admitted with record ${e.facts.record} (mode ${e.mode})`);
      if (msr(hist)) v('ADMIT.fence-admit', 'admitted while a process of this server may still run');
      if (!e.facts.ownerFree) v('ADMIT.owner-admit', 'admitted while the owner was busy');
      const ns = effects.filter((f) => f.t === 'native-start');
      const arms = effects.filter((f) => f.t === 'arm' && f.which === 'start');
      const local = e.facts.where === 'local';
      const shapeOk = n.where === e.facts.where && n.mode === e.mode && !n.relaunched && n.cause === undefined && !n.killed && arms.length === 1
        && (local ? n.step === 'launching' && ns.length === 1 && ns[0].t === 'native-start' && ns[0].run === n.id && count('owner-hold') === 1
          : n.step === 'opening' && ns.length === 0 && count('owner-hold') === 0);
      if (!shapeOk) v('ADMIT.shape', `the admitted run's shape or effects aren't the admission row's (${n.where}, ${n.step}, ${effects.map((f) => f.t).join(',')})`);
      if (hist.runs.includes(n.id)) v('ADMIT.fresh-id', `run id ${n.id} was used before`);
      if (n.era !== 'legacy') v('ERA.new', 'a new run must open legacy first');
    } else if (own) {
      const rep = own.reply;
      if (r) {
        if (rep.kind !== 'refused') v('ADMIT.busy-reply', `a start while ${m.phaseOf(prev)} must be refused, got ${rep.kind}`);
      } else if (!recordOk(e.mode, e.facts)) {
        if (rep.kind !== 'refused' && rep.kind !== 'failed') v('ADMIT.record-reply', `a start on record ${e.facts.record} answered ${rep.kind}`);
      } else if (msr(hist)) {
        if (!(rep.kind === 'failed' && msrWords(rep.failure.words))) v('ADMIT.fence-reply', 'a start fenced by a process that may still run must answer failed, "may still be running"');
      } else if (!e.facts.ownerFree) {
        if (!(rep.kind === 'refused' && (e.facts.ownerWords === undefined || rep.words === e.facts.ownerWords))) v('ADMIT.owner-reply', "a start refused by the owner must carry the owner's words");
      } else {
        v('ADMIT.must', 'every admission guard passed, yet the start was answered instead of admitted');
      }
      if (!unchanged) v('PERSON.unchanged', 'a start that was answered at once changed the state');
    }
  }

  // ---- New runs, relaunch ----
  if (n && n.id !== r?.id && !admitted && !cont) v('ADMIT.only', `run ${n.id} appeared on ${e.t}, not on an admitted start or a readmit`);
  if (cont && r && n) {
    const ok = n.relaunched && n.where === 'local' && n.step === 'launching' && n.mode === r.mode
      && effects.some((f) => f.t === 'native-start' && f.run === n.id);
    if (!ok) v('I7.readmit', 'the relaunched run is not a local, relaunched, launching run of the same mode with its native start');
    if (hist.runs.includes(n.id)) v('ADMIT.fresh-id', `run id ${n.id} was used before`);
    if (n.era !== 'modern') v('ERA.new', 'the relaunched run must be modern');
  }
  // Row 174 and 6b.11 (narrowed): a readmit that passes makes the relaunched run; for a person's own Start or
  // Test that holds even when the server is turned off. Ending or keeping the run instead is reported here.
  const goOnMissed = readmitPasses(prev, e) && !cont;
  if (goOnMissed) v('I7.go-on', `the readmit for ${r!.id} (mode ${r!.mode}${e.t === 'readmit' && e.off ? ', turned off' : ''}) passes, yet no relaunched run was made`);
  if (n && n.step === 'grace' && !(r && r.id === n.id && r.step === 'grace')) {
    const ok = !!r && r.id === n.id && r.step === 'walking' && e.t === 'admin-done' && e.run === r.id && e.outcome.k === 'unanswered' && graceEligible(r, hist);
    if (!ok) v('I7.grace', 'grace entered without an unanswered list on a modern, local, first, unkilled, never-answered start');
  }
  const enteredRelaunch = !!n && n.step === 'relaunch' && !(r && r.id === n.id && r.step === 'relaunch');
  const graceExit = !!r && relaunchExit(r, e, hist);
  if (enteredRelaunch && !(graceExit && r && n && r.id === n.id)) v('I7.relaunch', `relaunch entered from ${r?.step} on ${e.t}, not on an exit grace or 6b.9 allows`);
  {
    // A relaunch entered where none may begin is I7.relaunch's; here, the readmit check itself.
    const checks = effects.filter((f) => f.t === 'readmit-check');
    const ok = graceExit ? checks.length === 1 && checks[0].t === 'readmit-check' && checks[0].run === r!.id && enteredRelaunch : enteredRelaunch || checks.length === 0;
    if (!ok) v('I7.check', graceExit ? 'a relaunch exit must request the readmit facts once and wait in relaunch' : 'readmit facts requested outside a relaunch exit');
  }
  // 6b.9: either order of the two signals leads to the same relaunch: once waiting in relaunch, the list's
  // own late outcome changes nothing.
  if (r && r.step === 'relaunch' && e.t === 'admin-done' && e.run === r.id && (!unchanged || effects.length)) v('I7.same', 'the list\'s late outcome changed a run waiting in relaunch');

  // 6b.13: a later catalog write of the current, still-running run fails. The run goes on.
  const laterFail = e.t === 'saved' && e.outcome === 'failed' && hist.saving === e.gen && laterSave(hist, e.gen)
    && !!r && hist.savingRun === r.id && r.cause === undefined && r.step !== 'closing' && r.step !== 'relaunch' && !prev.held;

  // ---- Endings (the transition table: anything not listed is ignored) ----
  const recoveryEntry = !!r && !!n && r.id === n.id && n.purpose === 'recovery' && n.step === 'opening' && !(r.purpose === 'recovery' && r.step === 'opening');
  if (r && !admitted && !old && ex !== 'unknown' && !(e.t === 'deadline' && !liveDeadline(prev, e, hist))) {
    if (r.step !== 'closing') {
      const eo = endingOf(prev, e, hist);
      if (ended && eo.k !== 'end' && !goOnMissed && !laterFail) v(e.t === 'call-ended' ? 'G18.call' : 'END.unlisted', `${e.t} ended run ${r.id} (from ${r.step}), which the table doesn't list`);
      // Entering grace or a re-handshake instead of ending is reported by I7.grace and REC.once.
      if (!ended && eo.k === 'end' && n?.step !== 'grace' && n?.step !== 'relaunch' && !recoveryEntry) {
        v(recoveryEraEnd(r, e) ? 'ERA.recovery' : 'END.must', `${e.t} must end run ${r.id} from ${r.step} (${eo.causes.join('|')})`);
      }
      if (ended && eo.k === 'end' && n && n.id === r.id && (n.cause === undefined || !eo.causes.includes(n.cause))) v('END.cause', `kept cause ${n.cause} isn't ${eo.causes.join('|')}`);
    } else {
      const co = closingOutcome(prev, e, hist);
      if (left && co === 'stay') v('END.unlisted', `${e.t} ended the closing run ${r.id}, which the table doesn't list`);
      if (!left && co === 'leave') v('END.must', `${e.t} must end the closing run ${r.id}`);
    }
  }
  if (r && n && r.id === n.id && r.cause !== undefined && n.cause !== r.cause) v('END.cause-kept', `the kept cause changed from ${r.cause} to ${n.cause}`);

  // end-live, the fence (6b.5, 6b.12): when a run's process exits, or the run ends, begins closing or is
  // replaced, an exchange of that run still live in the world is ended in that same transition. A closing run
  // that leaves is a run ending (left), so an exchange taken after closing began is ended there too.
  const fenceMoment = ended || left || cont || ex === 'run';
  if (r && !admitted && fenceMoment && worldLive(hist, r.id) && !effects.some((f) => f.t === 'end-live' && f.run === r.id)) v('END.live', `run ${r.id}'s live exchange wasn't ended when ${e.t} ${ex === 'run' ? 'ended its process' : 'ended or closed the run'}`);
  for (const f of effects) {
    // 6b.12: a run already fenced gets end-live again only for an exchange live since (taken after closing began).
    if (f.t === 'end-live' && (!r || f.run !== r.id || !fenceMoment || (hist.fenced.includes(f.run) && !worldLive(hist, f.run)) || count('end-live') > 1)) v('END.live-once', `end-live for ${f.run} outside its run's ending, or twice`);
  }
  // 6b.2 and 6b.3: Start waiters, and Test waiters but for Test's own cleanup, are answered at once when
  // their run enters closing or ends.
  if (r && ended && !admitted && e.t !== 'exhausted') {
    const ownCleanup = !!n && n.id === r.id && n.step === 'closing' && n.cause === 'test-done';
    for (const w of hist.open) {
      if (w.run !== r.id || answers.some((a) => a.token === w.token)) continue;
      if (w.kind === 'start') v('I9.start-at-once', `${w.token} still waits after its run ${n?.id === r.id ? 'began closing' : 'ended'}`);
      if (w.kind === 'test' && !ownCleanup) v('I9.test-at-once', `Test ${w.token} still waits after its run ${n?.id === r.id ? 'began closing' : 'ended'} (not its own cleanup)`);
    }
  }
  if (r && r.step === 'closing' && r.cause === 'test-done' && e.t === 'stop' && !prev.held) {
    for (const w of hist.open) if (w.run === r.id && w.kind === 'test' && !answers.some((a) => a.token === w.token)) v('TEST.stop-cleanup', `a Stop during Test's cleanup left Test ${w.token} waiting`);
  }
  // 6b.1: a saved for a run that already ended or began closing changes nothing more.
  if (e.t === 'saved') {
    const fs = hist.firstSave.find((f) => f.gen === e.gen && f.outcome === undefined);
    if (fs && keptOf(hist, fs.run)) {
      // Pass 5h: the save bookkeeping of the run it's on: `firstSave` and the run's own queue (`queued`).
      const strip = (x: LcState) => ({ ...x, saving: undefined, run: x.run ? { ...x.run, firstSave: undefined, queued: undefined } : undefined });
      // Pass 5f: issuing a save carries its own bookkeeping. For each save this transition issues, that run's
      // `written` may become that save's generation; and (5h) when that save is the run's first (firstSave now
      // 'pending', not before), its `firstGen` may become that generation too. `retried` and `unsaved` are not stripped.
      const issued = (run: string, gen: number | undefined) => effects.some((f) => f.t === 'save' && f.run === run && f.gen === gen);
      let nextW: LcState = next;
      if (next.run && prev.run && next.run.id === prev.run.id) {
        const nr = next.run, pr = prev.run;
        const written = nr.written !== pr.written && issued(nr.id, nr.written) ? pr.written : nr.written;
        const firstIssued = nr.firstSave === 'pending' && pr.firstSave !== 'pending' && pr.firstSave !== 'done';
        const firstGen = nr.firstGen !== pr.firstGen && firstIssued && issued(nr.id, nr.firstGen) ? pr.firstGen : nr.firstGen;
        nextW = { ...next, run: { ...nr, written, firstGen } };
      }
      if (!same(strip(prev), strip(nextW)) || effects.some((f) => f.t !== 'save')) v('SAVED.late', `the catalog write of run ${fs.run}, which already ended or began closing, changed more than the save bookkeeping`);
    }
  }
  // 6b.13: a later write that fails keeps its generation and is tried once more; a second failure leaves it
  // unsaved, with no third try. Only the first save's failure ends a run. That retry is due only while the failed
  // generation is still the run's newest published one. Once a newer one is published, the failure retries
  // nothing: a save of the newest is allowed there but not required (it comes "in its turn", at its settle, or
  // here only if it was already asked for), and a save of the failed or any older generation is I11.newest's.
  if (laterFail && e.t === 'saved') {
    const tries = hist.saveFails.find((f) => f.gen === e.gen)?.count ?? 0;
    const saves = effects.filter((f): f is Extract<LcEffect, { t: 'save' }> => f.t === 'save');
    const newest = hist.runPublish.find((p) => p.run === r!.id)?.last;
    if (ended || left) v('SAVE.goes-on', `run ${r!.id} ended on its later catalog write's failure (gen ${e.gen})`);
    else if (newest !== e.gen) {
      // Superseded: no retry. Whether the newer generation is written here is SAVE.turn's (pass 5i, below).
    }
    else if (tries === 0 && saves.length !== 1) v('SAVE.retry', `the later catalog write of gen ${e.gen} failed and wasn't tried once more`);
    else if (tries >= 1 && saves.some((f) => f.gen === e.gen)) v('SAVE.retry', `gen ${e.gen} failed twice and was tried a third time`);
  }
  // 6b.13: a queued re-save belongs to the run that queued it. A write landing for a run that has left issues only
  // a save of the current run, for a generation it asked for itself: its settle came while that write was in
  // flight (History `askedFor`, never the state's own fields). As I11's re-save, a newer generation of that same run may be
  // written in its place.
  if (e.t === 'saved' && hist.saving === e.gen && hist.savingRun !== undefined && hist.savingRun !== r?.id) {
    for (const f of effects) {
      if (f.t !== 'save') continue;
      const asked = hist.askedFor;
      if (!(r && f.run === r.id && asked && asked.run === r.id && f.gen >= asked.gen)) v('SAVE.own-queue', `the late landing of ${hist.savingRun}'s write issued a save of gen ${f.gen} for ${f.run}, which ${r && f.run === r.id ? "didn't ask for it" : "isn't the current run"}`);
    }
  }
  // 6b.13: closing issues no new save; a write already in flight just settles.
  const closingSave = (f: Extract<LcEffect, { t: 'save' }>) => (!!r && r.id === f.run && r.step === 'closing') || (!!n && n.id === f.run && n.step === 'closing');
  for (const f of effects) if (f.t === 'save' && closingSave(f)) v('SAVE.closing', `save of gen ${f.gen} for run ${f.run}, which is closing`);
  // Pass 5i (r35): a write is checked as its whole pair, (run, generation), never by its generation alone.
  {
    const saveList = effects.filter((f): f is Extract<LcEffect, { t: 'save' }> => f.t === 'save');
    const landing = e.t === 'saved' && hist.saving === e.gen;
    const curRun = r && n && r.id === n.id && !prev.held && !next.held ? n.id : undefined;
    const lateLeft = landing && hist.savingRun !== undefined && hist.savingRun !== r?.id;
    // SAVE.whose: every save is the current run's write of its own newest published generation (History
    // runPublish). A closing run's save is SAVE.closing's; a late landing's save for anyone but the current run is
    // SAVE.own-queue's; a generation that isn't the newest published is I11.newest's.
    const accepted: Extract<LcEffect, { t: 'save' }>[] = [];
    for (const f of saveList) {
      if (closingSave(f)) continue;
      if (f.run !== curRun) { if (!lateLeft) v('SAVE.whose', `save of gen ${f.gen} for run ${f.run}, which isn't the current running run ${curRun ?? '(none)'}`); continue; }
      if (f.gen !== h2.lastPublish) continue;
      const own = h2.runPublish.find((p) => p.run === f.run)?.last;
      if (own !== f.gen) { v('SAVE.whose', `save of gen ${f.gen} for run ${f.run}, whose own newest published generation is ${own ?? 'none'}`); continue; }
      accepted.push(f);
    }
    // SAVE.turn: a generation is written in its turn: at its settle (the transition entering Ready), or on a
    // landing. On a landing of the current run's own write, a save of a generation other than the landed one is
    // the run's queued write, so the run must have asked for one: a settle came while that write was in flight
    // (History askedFor, never the state). A save at any other moment is outside every turn. The landed
    // generation's own retry or rewrite is SAVE.retry's and SAVE.once's; a late landing's is SAVE.own-queue's.
    const asked = curRun !== undefined && hist.askedFor?.run === curRun;
    const entersReady = curRun !== undefined && n!.step === 'ready' && r!.step !== 'ready';
    for (const f of accepted) {
      if (entersReady || lateLeft) continue;
      if (landing) {
        if (e.t === 'saved' && f.gen !== e.gen && !asked) v('SAVE.turn', `the landing of gen ${e.gen} wrote gen ${f.gen}, which run ${curRun} never asked for (no settle came while gen ${e.gen} was in flight)`);
        continue;
      }
      v('SAVE.turn', `save of gen ${f.gen} on ${e.t}, outside its turn (neither its settle nor a landing)`);
    }
    // ...and when a write lands, a run that asked gets its newest generation written in that transition, if it is
    // still running. In Ready with nothing in flight, I11.owed reports a missing one.
    if (landing && asked && n!.cause === undefined && !['closing', 'relaunch', 'ready'].includes(n!.step) && !saveList.some((f) => f.run === curRun)) {
      v('SAVE.turn', `run ${curRun} asked for a write while gen ${e.t === 'saved' ? e.gen : '?'} was in flight, and its landing didn't write the run's newest generation`);
    }
  }
  // 6b.13: each generation is written once, plus its one retry, issued in its first failure's own transition.
  // A save SAVE.closing, SAVE.retry's third-try branch or I11.newest (not the newest published) reports is theirs.
  {
    const firstFailNow = e.t === 'saved' && e.outcome === 'failed' && hist.saving === e.gen && laterSave(hist, e.gen)
      && (hist.saveFails.find((y) => y.gen === e.gen)?.count ?? 0) === 0;
    const thirdTry = laterFail && e.t === 'saved' && (hist.saveFails.find((y) => y.gen === e.gen)?.count ?? 0) >= 1;
    const seen = new Map<string, number>();
    for (const f of effects) {
      if (f.t !== 'save') continue;
      const key = `${f.run} ${f.gen}`;
      const prior = (hist.writes.find((y) => y.run === f.run && y.gen === f.gen)?.count ?? 0) + (seen.get(key) ?? 0);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const retry = prior === 1 && firstFailNow && e.t === 'saved' && f.gen === e.gen && hist.savingRun === f.run;
      if (prior === 0 || retry || closingSave(f) || (thirdTry && e.t === 'saved' && f.gen === e.gen) || f.gen !== h2.lastPublish) continue;
      v('SAVE.once', `gen ${f.gen} of run ${f.run} written again (${prior} write${prior === 1 ? '' : 's'} issued before), not as its one retry`);
    }
  }
  // report-ended
  {
    const reps = effects.filter((f) => f.t === 'ended');
    for (const f of reps) {
      if (f.t === 'ended' && (!r || f.run !== r.id || !(ended || left) || hist.reported.includes(f.run) || reps.length > 1)) v('END.report', `report-ended for ${f.run} outside its run's ending, or twice`);
    }
    if (r && left && !admitted) {
      const k = keptOf(h2, r.id);
      if (k) {
        const has = h2.reported.includes(r.id);
        if (!(ownChoice(k.cause, r.mode) || k.cause === 'held') && !has) v('END.report', `run ${r.id} ended (${k.cause}) without report-ended`);
        if (ownChoice(k.cause, r.mode) && has) v('END.report', `run ${r.id} ended by the person (${k.cause}), yet report-ended`);
      }
    }
  }
  // the phase after a run
  if (r && left && !admitted && !next.held) {
    const k = keptOf(h2, r.id);
    if (k) {
      const msrNow = msr(h2);
      const failed = msrNow || !(ownChoice(k.cause, r.mode) || r.mode === 'test');
      const ph = m.phaseOf(next);
      if (ph !== (failed ? 'failed' : 'stopped')) v('PHASE.after', `after ${k.cause}${msrNow ? ' (may still run)' : ''} the phase is ${ph}`);
      else if (failed) {
        const f = m.failureOf(next);
        const orphan = h2.alive.find((x) => x.run !== n?.id);
        const own = orphan && h2.orphanWords.find((o) => o.process === orphan.process)?.words;
        const ok = !f || (msrNow ? (own !== undefined && own !== '*' && h2.startPending.length === 0 ? f.words === own : msrWords(f.words))
          : k.words === '*' || f.words === k.words || (k.words === START_UNANSWERED.words && f.words === START_TIMEOUT.words));
        if (!ok) v('PHASE.after-words', `Failed shows "${f?.words}", not the kept cause's words`);
      }
    }
  }

  // ---- G18: a call's end ends that call only ----
  // (reported above through endingOf: call-ended done, and era-refusal on a legacy run, never end the run)

  // ---- Native start and stop, owner (I2, I6) ----
  {
    const stopsNow = new Set<string>();
    for (const f of effects) {
      if (f.t !== 'native-stop') continue;
      if (hist.stopIssued.includes(f.run) || stopsNow.has(f.run)) v('I2.stop-once', `native-stop for ${f.run} twice`);
      stopsNow.add(f.run);
      if (!h2.alive.some((a) => a.run === f.run && a.process === f.process)) v('I2.stop-target', `native-stop for ${f.run}/${f.process}, which isn't that run's live process`);
      if (n && n.id === f.run && !n.killed) v('KILL.flag', `native-stop sent for ${f.run} without marking it killed`);
    }
    const holds = count('owner-hold'), rels = count('owner-release');
    const ok6 = prev.owner === next.owner ? holds === 0 && rels === 0 : prev.owner === 'free' ? holds === 1 && rels === 0 : rels === 1 && holds === 0;
    if (!ok6) v('I6.effects', `owner ${prev.owner}->${next.owner} with ${holds} hold(s) and ${rels} release(s)`);
    if (count('native-start') !== holds) v('I6.pair', 'native-start and owner-hold must come together');
    for (const f of effects) if (f.t === 'native-start' && n && f.run === n.id && f.era !== n.era) v('ERA.frame', `native-start framed ${f.era} for a ${n.era} run`);
  }
  // release-writes: exactly at a seen exit
  {
    const rw = effects.filter((f) => f.t === 'release-writes');
    const p = e.t === 'exit' && hist.alive.some((a) => a.process === e.process) ? e.process : undefined;
    const ok = p !== undefined ? rw.length === 1 && rw[0].t === 'release-writes' && rw[0].process === p : rw.length === 0;
    if (!ok) v('END.release', p ? `the exit of ${p} must release its writes once` : 'release-writes without an exit');
  }

  // ---- Slot mirror and admin exchanges (section 0, G14, G15, G29) ----
  {
    const admins = effects.filter((f): f is Extract<LcEffect, { t: 'admin' }> => f.t === 'admin');
    const slotIdleEv = e.t === 'slot' && e.idle;
    if (admins.length && next.slot !== 'busy') v('SLOT.busy', 'an admin was issued without setting the slot busy');
    if (admins.length && !(hist.slot === 'idle' || slotIdleEv)) v('SLOT.world-idle', "admin issued while the world's slot is busy");
    else if (admins.length > 1 || (admins.length === 1 && !(prev.slot === 'idle' || slotIdleEv))) v('SLOT.idle-only', 'admin issued while the slot was busy (or twice)');
    if (!admins.length) {
      const exp = e.t === 'slot' ? (e.idle ? 'idle' : 'busy') : prev.slot;
      if (next.slot !== exp) v('SLOT.mirror', `slot ${prev.slot}->${next.slot} on ${e.t}${e.t === 'slot' ? `(${e.idle ? 'idle' : 'busy'})` : ''}`);
    }
    for (const a of admins) {
      if (!n || a.run !== n.id || n.step === 'closing' || n.step === 'relaunch' || n.cause !== undefined || h2.fenced.includes(a.run)) {
        v('G15.fence', `admin for ${a.run} on a closing, ended or fenced run`);
        continue;
      }
      const stepFor = a.want.kind === 'initialize' ? 'opening' : a.want.kind === 'initialized' ? 'initialized' : 'walking';
      if (n.step !== stepFor) v('SLOT.want-match', `admin ${a.want.kind} while the step is ${n.step}`);
      if (a.era !== n.era) v('ERA.frame', `admin framed ${a.era} for a ${n.era} run`);
      if (a.want.kind === 'initialized' && n.era !== 'legacy') v('ERA.initialized', 'a modern run sent notifications/initialized');
      if (a.want.kind === 'list' && (a.want.page < 1 || a.want.page > MAX_PAGES)) v('WALK.pages', `list page ${a.want.page}`);
    }
  }
  if (r && n && r.id === n.id && r.era !== n.era) {
    const ok = r.era === 'legacy' && n.era === 'modern' && e.t === 'admin-done' && e.outcome.k === 'modern-refusal' && r.step === 'opening' && r.purpose === 'start';
    if (!ok) v('ERA.once', `era ${r.era}->${n.era} on ${e.t} from ${r.step}/${r.purpose}`);
  }

  // ---- Deadlines (I5, I9, 4.4) ----
  {
    const now = new Set<number>();
    for (const f of effects) {
      if (f.t !== 'arm') continue;
      if (hist.ids.includes(f.id) || now.has(f.id)) v('DL.fresh', `deadline id ${f.id} reused`);
      now.add(f.id);
      if (f.which === 'list' && !(prev.slot === 'idle' || (e.t === 'slot' && e.idle))) v('DL.list-drained', "the list deadline was armed before the carrying exchange drained");
      if (f.which === 'start' && !admitted) v('DL.start-once', 'a start deadline armed outside the admission (it must still run from there)');
    }
    for (const f of effects) if (f.t === 'disarm' && h2.open.some((w) => w.bound === f.id)) v('I9.disarm', `deadline ${f.id} disarmed while it still bounds an open waiter`);
    if (e.t === 'deadline' && armedEntry(hist, e.id) && h2.open.some((w) => w.bound === e.id)) v('I9.fire', `deadline ${e.id} fired and a waiter it bounds is still unanswered`);
  }

  // ---- Answers (I3, I8, Test) ----
  {
    const seen = new Set<string>();
    for (const a of answers) {
      const tok = a.token;
      if (hist.answered.includes(tok) || seen.has(tok)) v('I3.once', `${tok} answered twice`);
      seen.add(tok);
      const immediate = person && tok === e.token;
      const w = hist.open.find((o) => o.token === tok);
      if (!immediate && !w) { v('I3.known', `answer for ${tok}, which isn't waiting`); continue; }
      const kind = w ? w.kind : e.t === 'stop' ? 'stop' : e.t === 'start' && e.mode === 'test' ? 'test' : 'start';
      const wrun = w ? w.run : r?.id;
      const rep = a.reply;
      const kinds = kind === 'start' ? ['ready', 'failed', 'stopped', 'refused'] : kind === 'test' ? ['tested', 'failed', 'refused'] : ['stopped', 'failed', 'refused'];
      const kindOk = kinds.includes(rep.kind);
      if (!kindOk) v('I3.kind', `a ${kind} waiter answered ${rep.kind}`);
      if (rep.kind === 'stopped' && msr(h2)) v('I3.stopped-truth', `${tok} answered stopped while a process may still run`);
      const words = wordsOf(rep);
      if (words !== undefined && msrWords(words) && !msr(h2)) v('I3.msr-truth', `${tok} answered "may still be running" with nothing left running`);
      if (words !== undefined && msrWords(words) && h2.startPending.length === 0) {
        const orphan = h2.alive.find((x) => x.run !== n?.id);
        const own = orphan && h2.orphanWords.find((o) => o.process === orphan.process)?.words;
        if (own !== undefined && own !== '*' && words !== own) v('ORPH.words', `${tok} answered "${words}", the orphan's own words are "${own}"`);
      }
      const heldW = heldWordsOf(prev, next, e);
      const isHeld = words !== undefined && heldW !== undefined && words === heldW;
      if (kind === 'stop') {
        const ok = rep.kind === 'stopped' || (rep.kind === 'failed' && msrWords(rep.failure.words)) || isHeld;
        if (!ok) v('I8.kind', `a Stop answered ${rep.kind} "${words ?? ''}"`);
        if (wrun !== undefined) {
          const first = hist.stopReply.find((s) => s.run === wrun)?.reply
            ?? answers.filter((b) => b !== a && (hist.open.find((o) => o.token === b.token)?.kind === 'stop' || (e.t === 'stop' && b.token === e.token))
              && (hist.open.find((o) => o.token === b.token)?.run ?? r?.id) === wrun).map((b) => canon(b.reply))[0];
          if (first !== undefined && first !== canon(rep)) v('I8.same', `two Stops of run ${wrun} got different answers`);
        }
        continue;
      }
      if (immediate || !kindOk) continue;
      if (left && rep.kind === 'failed' && !isHeld && msr(h2) && !msrWords(rep.failure.words)) v('I3.msr-owed', `${tok} failed while a process may still run, without saying so`);
      if (rep.kind === 'ready') {
        const fs = hist.firstSave.find((f) => f.run === wrun);
        const ok = e.t === 'saved' && e.outcome !== 'failed' && !!fs && fs.gen === e.gen && fs.outcome === undefined
          && !!n && n.id === wrun && phaseReadyRun(n) && n.cause === undefined;
        if (!ok) v('I3.ready', `${tok} answered ready not at its run's first catalog write settling`);
        continue;
      }
      if (rep.kind === 'tested') {
        if (rep.run !== wrun) v('TEST.tested-run', `tested names ${rep.run}, the waiter's run is ${wrun}`);
        if (n?.id === wrun || msr(h2)) v('TEST.tested-ended', 'Test answered its report before its run ended with its exit seen');
        const k = keptOf(h2, wrun);
        if (!k || k.cause !== 'test-done') v('TEST.tested-cause', `Test answered ok but its run's cause is ${k?.cause}`);
        if (wrun !== undefined && h2.stoppedBy.includes(wrun)) v('TEST.no-stop', "Test answered ok after a person's Stop reached its run");
        const fs = h2.firstSave.find((f) => f.run === wrun);
        if (!fs || (fs.outcome !== 'saved' && fs.outcome !== 'skipped')) v('TEST.tested-saved', "Test answered ok without its catalog write settled");
        continue;
      }
      if (e.t === 'exhausted') continue;
      const k = keptOf(h2, wrun);
      if (!k) { if (!goOnMissed) v('I3.kept', `${tok} answered ${rep.kind} while its run hasn't ended`); continue; }
      if (k.cause === 'held') continue;
      let ok: boolean;
      const msrW = words !== undefined && msrWords(words);
      const stopW = words !== undefined && /stopped/i.test(words);
      if (k.cause === 'person-stop') ok = kind === 'start' ? rep.kind === 'stopped' || (rep.kind === 'failed' && (msrW || stopW)) : rep.kind === 'failed' && (msrW || stopW);
      // 6b.11: only an automatic start meets turned off, so only a Start waiter, answered stopped.
      else if (k.cause === 'turned-off') ok = kind === 'start' && rep.kind === 'stopped';
      else if (k.cause === 'test-done') ok = rep.kind === 'failed';
      else if (k.cause === 'readmit-refused') ok = (rep.kind === 'failed' || rep.kind === 'refused') && (k.words === '*' || words === k.words);
      else ok = rep.kind === 'failed' && (k.words === '*' || words === k.words || (msrW && words!.startsWith(k.words)));
      if (!ok) v('I3.kept', `${tok} answered ${rep.kind} "${words ?? ''}" but the kept cause is ${k.cause} "${k.words}"`);
    }
  }
  if (e.t === 'saved' && e.outcome !== 'failed' && r && r.cause === undefined && phaseReadyRun(r)) {
    const fs = hist.firstSave.find((f) => f.run === r.id);
    if (fs && fs.gen === e.gen && fs.outcome === undefined) {
      for (const w of hist.open) {
        if (w.run === r.id && w.kind === 'start' && !answers.some((a) => a.token === w.token && a.reply.kind === 'ready')) v('I3.ready-owed', `the first catalog write settled and ${w.token} wasn't answered ready`);
      }
    }
  }
  if (e.t === 'exhausted' && !prev.held) {
    for (const w of hist.open) {
      const a = answers.find((x) => x.token === w.token);
      if (!a || !(a.reply.kind === 'failed' || a.reply.kind === 'refused') || wordsOf(a.reply) !== e.failure.words) v('EXH.answer', `${w.token} wasn't answered the restart words at exhaustion`);
    }
    if (next.held?.words !== e.failure.words) v('EXH.held', 'exhaustion must hold the server with the restart words');
  }

  // ---- Remote session recovery (4.5, G31) ----
  if (r && n && r.id === n.id) {
    const entry = recoveryEntry;
    const ns = effects.filter((f) => f.t === 'new-session');
    if (entry) {
      if (!(r.dropped === 0 && n.dropped === 1 && r.where === 'remote')) v('REC.once', 'a re-handshake without a fresh drop (dropped must go 0 to 1)');
      if (!(ns.length === 1 && ns[0].t === 'new-session' && ns[0].run === n.id)) v('REC.session', 'a recovery must start one new session');
    } else {
      if (ns.length) v('REC.session', 'new-session outside a recovery');
      if (r.dropped === 0 && n.dropped === 1) v('REC.once', 'dropped set without a recovery');
    }
    if (r.dropped === 1 && n.dropped === 0) {
      const ok = (e.t === 'call-ended' && e.end === 'done') || (e.t === 'admin-done' && e.outcome.k === 'page' && r.purpose === 'refresh');
      if (!ok) v('REC.reset', `dropped re-armed on ${e.t}, not on a page or call completing after the recovery`);
    }
    if (e.t === 'call-ended' && e.run === r.id && e.end === 'done' && r.dropped === 1 && r.step === 'ready' && n.dropped !== 0) v('REC.reset', 'a call completed after the recovery and dropped stayed 1');
  }

  // ---- The walk and the catalog (4.3, rule 8, I1, I12, G26) ----
  if (n && n.walk && n.step === 'walking') {
    const r0 = r && r.id === n.id ? r : undefined;
    const sameWalk = !!r0 && !!r0.walk && r0.step === 'walking' && r0.walk.attempt === n.walk.attempt && r0.purpose === n.purpose;
    if (sameWalk ? n.walk.startedAt !== r0!.walk!.startedAt : n.walk.startedAt !== n.changes) v('WALK.started', `walk startedAt ${n.walk.startedAt} (changes ${n.changes})`);
  }
  {
    const pubs = effects.filter((f): f is Extract<LcEffect, { t: 'publish' }> => f.t === 'publish');
    const lastPage = !!r && e.t === 'admin-done' && e.run === r.id && r.step === 'walking' && e.outcome.k === 'page' && !e.outcome.more && !!r.walk;
    const cat = e.t === 'admin-done' && e.outcome.k === 'page' ? e.outcome.catalog : undefined;
    const fresh = lastPage && r!.changes === r!.walk!.startedAt && (cat === undefined || cat === 'ok') && r!.cause === undefined;
    for (const p of pubs) {
      if (!fresh || p.run !== r!.id || pubs.length > 1) v('PUB.fresh', 'publish without a fresh last page of a walk');
      if (hist.lastPublish !== undefined && p.gen <= hist.lastPublish) v('PUB.gen', `publish gen ${p.gen} isn't newer than ${hist.lastPublish}`);
    }
    if (fresh && pubs.length === 0) v('PUB.must', 'a fresh last page must publish');
    if (fresh && pubs.length === 1 && n && r && n.id === r.id && n.published !== r.walk!.startedAt) v('PUB.mark', `published.changes ${n.published}, the walk began at ${r.walk!.startedAt}`);
  }
  if (e.t === 'notice' && r && e.run === r.id) {
    if ((r.step === 'walking' || r.step === 'settling') && n && n.id === r.id && n.changes !== r.changes + 1) v('NOT.count', 'a notice during a walk was not counted');
    if (r.step === 'ready' && m.callable(next)) v('G26.notice', 'callable after a notice on a Ready run');
  }
  if (r && n && r.id === n.id && n.changes !== r.changes && !(e.t === 'notice' && e.run === r.id && n.changes === r.changes + 1)) v('NOT.only', `changes ${r.changes}->${n.changes} on ${e.t}`);
  if (n && n.step === 'ready' && !(r && r.id === n.id && r.step === 'ready')) {
    if (!(next.slot === 'idle' && !n.refreshOwed && n.published !== undefined && n.changes === n.published)) v('I1.enter', 'Ready entered stale, owing a refresh, or busy');
    if (!(e.t === 'slot' && e.idle && r && r.id === n.id && r.step === 'settling')) v('I1.at-idle', `Ready entered from ${r?.step} on ${e.t}, not from settling at a slot-idle`);
  }

  // ---- Catalog writes (I11) ----
  {
    const saves = effects.filter((f): f is Extract<LcEffect, { t: 'save' }> => f.t === 'save');
    const settledNow = e.t === 'saved' && hist.saving === e.gen;
    const inFlight = hist.saving !== undefined && !settledNow;
    if (saves.length > 1 || (saves.length === 1 && inFlight)) v('I11.one', 'a second catalog write while one is in flight');
    for (const s of saves) if (s.gen !== h2.lastPublish) v('I11.newest', `save of gen ${s.gen}, the newest published is ${h2.lastPublish}`);
  }

  return out;
}

// ---------------------------------------------------------------------------------------------------------
// checkState
// ---------------------------------------------------------------------------------------------------------

export function checkState(s: LcState, m: Machine, h: History): string[] {
  const out: string[] = [];
  const v = (id: string, msg: string) => out.push(`${id}: ${msg}`);
  const r = s.run;
  const ph = m.phaseOf(s);

  // Predicates the rest of the app reads.
  if (r || s.held) { if (ph !== derivedPhase(s)) v('P.phase', `phase ${ph}, the step says ${derivedPhase(s)}`); }
  else if (ph !== 'stopped' && ph !== 'failed') v('P.phase', `phase ${ph} with no run`);
  if (m.callable(s) !== callableFormula(s)) v('I1.callable', `callable ${m.callable(s)}, the formula says ${callableFormula(s)}`);
  if (!r && !s.held && m.fenced(s) !== msr(h)) v('P.fenced', `fenced ${m.fenced(s)} while a process ${msr(h) ? 'may' : 'may not'} still run`);
  {
    const f = m.failureOf(s);
    if ((ph === 'failed' && !f) || (ph === 'held' && f?.words !== s.held?.words) || (ph === 'stopped' && f)) v('P.failure', `phase ${ph} shows failure "${f?.words}"`);
  }
  if (m.offering(s) && !(r && !s.held && phaseReadyRun(r) && r.published !== undefined)) v('P.offering', 'tools offered while not Ready with a published catalog');

  // Ready stays fresh (I12) and the slot mirror never strands a want.
  if (r && !s.held && r.step === 'ready') {
    if (r.published !== undefined && r.changes !== r.published && !r.refreshOwed && !r.want) v('I12.stranded', 'Ready with unwalked notices and no refresh owed');
    if (r.refreshOwed && s.slot === 'idle') v('I12.owed-idle', 'a refresh owed while the slot is idle and none began');
  }
  if (r && r.want && s.slot === 'idle' && !['closing', 'relaunch', 'launching'].includes(r.step)) v('SLOT.want-idle', `step ${r.step} wants ${r.want.kind} while the slot is idle`);
  if (r && r.walk && r.walk.attempt > 2) v('WALK.attempts', `walk attempt ${r.walk.attempt}`);

  // I5: every waiting step has its deadline armed.
  if (r) {
    let need: DeadlineKind | undefined;
    if (r.step === 'launching' || r.step === 'relaunch') need = 'start';
    else if (WALK_STEPS.includes(r.step)) need = r.purpose === 'refresh' ? 'list' : r.purpose === 'recovery' ? 'recovery' : 'start';
    else if (r.step === 'grace') need = 'grace';
    else if (r.step === 'closing') need = r.native?.start === 'pending' ? undefined : 'stop'; // the owner's hold, unbounded by design; its waiters are I9's
    if (need) {
      const d = r.deadline;
      if (!d || d.which !== need || !h.armed.some((a) => a.id === d.id)) v(`I5.${r.step}`, `step ${r.step} (${r.purpose}) has no armed ${need} deadline`);
    }
  }

  // The world and its mirror (I2, I6).
  if (r && r.where === 'local' && r.native) {
    const pend = r.native.start === 'pending';
    const aliveState = r.native.start === 'ok' && !r.native.exited && r.native.process !== undefined;
    const aliveWorld = h.alive.some((a) => a.run === r.id);
    const aliveMatch = !aliveState || h.alive.some((a) => a.run === r.id && a.process === r.native!.process);
    if (pend !== h.startPending.includes(r.id) || aliveState !== aliveWorld || !aliveMatch) v('NAT.mirror', `run ${r.id}'s native record disagrees with what Windows was asked and answered`);
  }
  {
    const others = h.alive.filter((a) => a.run !== r?.id).map((a) => a.process).sort();
    const orph = s.orphans.map((o) => o.process).sort();
    if (!same(others, orph)) v('ORPH.mirror', `orphans [${orph}] but processes not seen to exit [${others}]`);
  }
  if (h.startPending.length + h.alive.length > 1) v('I2.one', `${h.startPending.length} pending start(s) and ${h.alive.length} live process(es)`);
  if ((s.owner === 'start') !== (h.startPending.length > 0)) v('I6.owner', `owner ${s.owner} while ${h.startPending.length} native start(s) pending`);
  if (r && r.step === 'closing' && h.alive.some((a) => a.run === r.id) && !h.stopIssued.includes(r.id)) v('END.stop-owed', `closing run ${r.id} has a live process and no native-stop`);

  // Waiters (I3, I8, I9).
  {
    const st = s.waiters.map((w) => w.token).sort();
    const ht = h.open.map((w) => w.token).sort();
    if (!same(st, ht)) v('W.mirror', `waiters [${st}] but unanswered [${ht}]`);
  }
  for (const w of h.open) {
    if (w.run === undefined || w.run !== r?.id) v('W.current', `${w.token} belongs to ${w.run}, not the current run ${r?.id}`);
    if (w.bound === undefined) v('I9.bounded', `${w.token} has no deadline bounding its answer`);
    else if (w.kind === 'stop') { const a = armedEntry(h, w.bound); if (a && a.which !== 'stop') v('I8.bound', `Stop ${w.token} is bounded by a ${a.which} deadline`); }
  }
  {
    const quiet = h.armed.length === 0 && h.startPending.length === 0 && h.stopPending.length === 0 && h.saving === undefined
      && h.readmit.length === 0 && h.exchange.length === 0 && h.slot === 'idle';
    if (quiet && h.open.length) v('I3.quiescent', `nothing pending, yet ${h.open.map((w) => w.token)} wait`);
  }

  // 6b.13: the machine's own note. noteOf gives the unsaved words exactly while the run is current and its
  // newest published generation is marked unsaved, and nothing otherwise: never with nothing marked (a first
  // failure included, its retry still due), and not once a newer generation was published (and so not once it
  // saved). failureOf never carries them.
  {
    const note = m.noteOf(s);
    const newest = r ? h.runPublish.find((p) => p.run === r.id)?.last : undefined;
    const want = !!h.unsaved && !!r && r.id === h.unsaved.run && newest === h.unsaved.gen;
    if (want && note !== UNSAVED_NOTE) v('SAVE.unsaved', `gen ${h.unsaved!.gen} is marked unsaved, yet noteOf gives "${note ?? ''}"`);
    if (!want && note !== undefined) {
      if (h.unsaved) v('SAVE.note-cleared', `noteOf gives "${note}" though gen ${h.unsaved.gen}'s mark was superseded by a newer generation (or its run left)`);
      else v('SAVE.note-none', `noteOf gives "${note}" with no generation marked unsaved`);
    }
    const f = m.failureOf(s);
    if (f && (f.words === UNSAVED_NOTE || UNSAVED_RE.test(f.words))) v('P.failure-note', `failureOf carries the unsaved note "${f.words}"`);
  }
  // Catalog writes (I11).
  // Pass 5i: the write in flight is mirrored as its pair, whose it is and its generation.
  if (s.saving?.gen !== h.saving || s.saving?.run !== (h.saving === undefined ? undefined : h.savingRun)) v('I11.mirror', `saving ${canon(s.saving)}, in flight ${h.saving === undefined ? 'none' : `${h.savingRun} gen ${h.saving}`}`);
  if (h.saving === undefined && r && !s.held && r.step === 'ready') {
    const last = h.runPublish.find((p) => p.run === r.id)?.last;
    if (last !== undefined && h.lastSave !== last) v('I11.owed', `Ready on gen ${last}, last saved ${h.lastSave}, nothing in flight`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The alphabet: what the world may deliver next, read from History's record of the world
// ---------------------------------------------------------------------------------------------------------

/**
 * Per-path budgets for the walk. Ctx is part of the walk's digest, with the state and the History.
 * - persons:  person actions left (Start in its modes, Test, Stop; owner free or busy; enabled or turned off).
 *             Default 4, so each action can come twice. Tokens are `p<persons>`, fresh along a path.
 * - notices:  list_changed notices left (legacy runs only: the notice is legacy). Default 2.
 * - pings:    the slot taken while idle by an exchange of the current run (an idle ping, or a call). Default 1.
 * - calls:    call ends left (done, a 404 session end, a modern era refusal) while such an exchange holds the slot. Default 1.
 * - pages:    extra list pages (a cursor) left. Default 1. Set 16 to reach the 16-page bound.
 * - stale:    stale events left: old-run events (notice, readmit, page, write-bound, a 404) and deadline ids
 *             that fired or were disarmed. Default 1.
 * - exhaust:  cleanup exhaustion left, remote runs only (6b.6). Default 1.
 * - watchdog: write-bound left. Default 1.
 * Everything outstanding comes from History: the native starts and stops Windows hasn't answered, the
 * processes not seen to exit (orphans included), the admin exchanges awaiting their outcome, the world's
 * slot and the exchange holding it, the save in flight, every armed deadline and the pending readmits.
 * The state is read only for facts: which run is current, and its era (notices are legacy).
 */
export interface Ctx {
  readonly persons: number; readonly notices: number; readonly pings: number; readonly calls: number; readonly pages: number;
  readonly stale: number; readonly exhaust: number; readonly watchdog: number;
}
export const CTX0: Ctx = { persons: 4, notices: 2, pings: 1, calls: 1, pages: 1, stale: 1, exhaust: 1, watchdog: 1 };

export const EXIT_FAILURE: Failure = { kind: 'exited', words: 'The server exited.', lastOutput: 'last line' };
export const START_REFUSED_F: Failure = { kind: 'refused', words: 'Windows refused the setup.' };
export const HELD_FAILURE: Failure = { kind: 'failed', words: 'Familiar could not clean up after the server. Restart Familiar.' };
export const WIRE_F: Failure = { kind: 'protocol', words: 'The server broke the protocol.' };
export const NO_ANSWER_F: Failure = { kind: 'exited', words: "The server didn't answer." };
export const RUN_ENDED_F: Failure = { kind: 'exited', words: 'The run ended.' };
export const BAD_CATALOG_F: Failure = { kind: 'protocol', words: 'Two tools share one name.' };
export const ERA_F: Failure = { kind: 'protocol', words: 'The server now speaks only versions 2026-xx.' };
export const OWNER_WORDS = 'Familiar is saving another change. Try again in a moment.';
/** Every StartFacts record value, and every mode, the alphabet offers (pass 5i). The type below fails to compile
    if T gains a record value this list lacks. */
export const RECORDS = ['ok', 'disabled', 'missing', 'unreadable', 'removing', 'sse', 'unlaunchable'] as const satisfies readonly StartFacts['record'][];
export const MODES = ['start', 'auto', 'test'] as const satisfies readonly Mode[];
type Unoffered = Exclude<StartFacts['record'], (typeof RECORDS)[number]> | Exclude<Mode, (typeof MODES)[number]>;
export const EVERY_RECORD_OFFERED: [Unoffered] extends [never] ? true : never = true;

const procOf = (run: string) => `${run}:p`;

export function alphabet(s: LcState, h: History, ctx: Ctx, where: Where): [LcEvent, Ctx][] {
  const out: [LcEvent, Ctx][] = [];
  const add = (e: LcEvent, c: Ctx = ctx) => out.push([e, c]);
  const cur = s.run?.id;
  const curRemote = cur !== undefined && h.remote.includes(cur);
  const curPeer = cur !== undefined && (curRemote || h.alive.some((a) => a.run === cur));

  // Person actions, at any point.
  if (ctx.persons > 0) {
    const c = { ...ctx, persons: ctx.persons - 1 };
    const token = `p${ctx.persons}`;
    const facts = (p: Partial<StartFacts> = {}): StartFacts => ({ record: 'ok', ownerFree: true, where, ...p });
    // Pass 5i: every record value T declares, once per mode. 4.1's refusals (missing, unreadable, removing, SSE,
    // and the types-only unlaunchable) refuse every mode; disabled refuses only auto, and admits start and Test.
    for (const mode of MODES) for (const record of RECORDS) add({ t: 'start', token, mode, facts: facts({ record }) }, c);
    add({ t: 'start', token, mode: 'start', facts: facts({ ownerFree: false, ownerWords: OWNER_WORDS }) }, c);
    add({ t: 'stop', token }, c);
  }
  // Native starts Windows hasn't answered, the current run's or a late one's.
  for (const run of h.startPending) {
    add({ t: 'started', run, ok: true, process: procOf(run) });
    add({ t: 'started', run, ok: false, failure: START_REFUSED_F });
  }
  // Native stops Windows hasn't answered.
  for (const run of h.stopPending) {
    add({ t: 'stop-answered', run, ok: true });
    add({ t: 'stop-answered', run, ok: false });
  }
  // Processes started and not seen to exit: the current run's, and every orphan's.
  for (const a of h.alive) {
    add({ t: 'exit', process: a.process, failure: EXIT_FAILURE });
    if (ctx.watchdog > 0 && a.run === cur) add({ t: 'write-bound', run: a.run }, { ...ctx, watchdog: ctx.watchdog - 1 });
  }
  // Admin exchanges awaiting their outcome. One that end-live ended can only come back unanswered.
  for (const x of h.exchange) {
    const ad = (outcome: Extract<LcEvent, { t: 'admin-done' }>['outcome'], c: Ctx = ctx) => add({ t: 'admin-done', run: x.run, outcome }, c);
    const remote = h.remote.includes(x.run);
    if (x.ended) { ad({ k: 'unanswered', failure: RUN_ENDED_F }); continue; }
    if (x.kind === 'initialize') {
      ad({ k: 'legacy' }); ad({ k: 'modern-refusal' }); ad({ k: 'refused', failure: WIRE_F }); ad({ k: 'invalid', failure: WIRE_F });
      ad({ k: 'unanswered', failure: NO_ANSWER_F });
      if (remote) ad({ k: 'session-ended' });
    } else if (x.kind === 'initialized') {
      ad({ k: 'ok' }); ad({ k: 'unanswered', failure: NO_ANSWER_F });
    } else {
      if (ctx.pages > 0) ad({ k: 'page', more: true }, { ...ctx, pages: ctx.pages - 1 });
      ad({ k: 'page', more: false, catalog: 'ok' }); ad({ k: 'page', more: false, catalog: BAD_CATALOG_F });
      ad({ k: 'refused', failure: WIRE_F }); ad({ k: 'invalid', failure: WIRE_F }); ad({ k: 'unanswered', failure: NO_ANSWER_F });
      if (remote) ad({ k: 'session-ended' });
    }
  }
  // The world's slot: it frees only once no exchange awaits its outcome; the exchange machine's own busy
  // event for an exchange already holding it; an idle ping (or a call) taking it from idle.
  if (h.slot === 'busy') {
    if (h.exchange.length === 0) add({ t: 'slot', idle: true });
    else add({ t: 'slot', idle: false });
  } else if (ctx.pings > 0 && curPeer) add({ t: 'slot', idle: false }, { ...ctx, pings: ctx.pings - 1 });
  // A call (or ping) of the current run holding the slot: a call may end.
  if (ctx.calls > 0 && h.slot === 'busy' && h.live !== undefined && h.live === cur && !h.exchange.some((x) => x.run === cur && !x.ended)) {
    const c = { ...ctx, calls: ctx.calls - 1 };
    add({ t: 'call-ended', run: cur, end: 'done' }, c);
    if (curRemote) add({ t: 'call-ended', run: cur, end: 'session-ended' }, c);
    add({ t: 'call-ended', run: cur, end: 'era-refusal', failure: ERA_F }, c);
  }
  // Every armed deadline.
  for (const a of h.armed) add({ t: 'deadline', id: a.id });
  // Pending readmits.
  for (const run of h.readmit) {
    add({ t: 'readmit', run, ok: true });
    add({ t: 'readmit', run, ok: false, words: OWNER_WORDS });
    // Row 175's third refusal, the setup changed (lead, from r35 #4). 6b.11 ends it Failed "in the readmit's words",
    // so the event carries words of its own, distinct from the owner's: with none, the kept words would be '*' and
    // I3.kept and PHASE.after-words would pass any words (pass 5i).
    add({ t: 'readmit', run, ok: false, words: SETUP_CHANGED.words });
    add({ t: 'readmit', run, ok: false, off: true, words: 'The server was turned off.' });
  }
  // The save in flight.
  if (h.saving !== undefined) for (const o of ['saved', 'skipped', 'failed'] as const) add({ t: 'saved', gen: h.saving, outcome: o });
  // Notices on the current legacy run, which has a server to send them.
  if (ctx.notices > 0 && cur !== undefined && curPeer && s.run!.era === 'legacy') add({ t: 'notice', run: cur }, { ...ctx, notices: ctx.notices - 1 });
  // Exhaustion: remote runs only (6b.6).
  if (ctx.exhaust > 0 && curRemote) add({ t: 'exhausted', failure: HELD_FAILURE }, { ...ctx, exhaust: ctx.exhaust - 1 });
  // Stale events: earlier runs, and deadline ids that fired or were disarmed.
  if (ctx.stale > 0) {
    const c = { ...ctx, stale: ctx.stale - 1 };
    for (const old of h.runs.filter((x) => x !== cur)) {
      add({ t: 'notice', run: old }, c);
      add({ t: 'readmit', run: old, ok: true }, c);
      add({ t: 'admin-done', run: old, outcome: { k: 'page', more: false, catalog: 'ok' } }, c);
      add({ t: 'write-bound', run: old }, c);
      add({ t: 'call-ended', run: old, end: 'session-ended' }, c);
    }
    const dead = h.ids.filter((id) => !h.armed.some((a) => a.id === id)).slice(-3);
    for (const id of dead) add({ t: 'deadline', id }, c);
  }
  return out;
}
// ---------------------------------------------------------------------------------------------------------
// CLAUSES: every clause id, with the spec sentence it comes from (M = LIFECYCLE-machine.md, D = design 5.4/6)
// ---------------------------------------------------------------------------------------------------------

export const CLAUSES: Record<string, string> = {
  // predicates and phase
  'P.phase': 'M1: "The phase is derived, not stored apart, so it can\'t drift: `starting` while the run\'s step is launching to grace; `ready` while ready, refreshing or recovering …; `stopping` while closing; `stopped` or `failed` with no run; `held` once cleanup was refused for good." M4.3: "The phase of \\"ended (relaunch pending)\\" is **starting**"',
  'I1.callable': 'M1: "`callable(state)` is `run.step === \'ready\' && slot === \'idle\' && !run.refreshOwed && run.changes === run.published.changes`." I1: "`callable()` is never true otherwise"',
  'P.fenced': 'D5.4: "A process whose stop was refused or never exited fences the next Start, which answers \\"may still be running\\", until its exit."',
  'P.failure': 'M1: "failure?: Failure // what the person sees beside Failed (and Held)". D5.4: "When cleanup is refused for good the server shows Failed with the restart words"',
  'P.offering': 'M3: "`publish{run, catalog}` (what `link.current` and `tools()` read)". D5.4: "A call while not Ready is refused \\"not running\\""',
  // I1, I12, the slot
  'I1.enter': 'I1: "Ready is entered only with a fresh catalog (`changes = published.changes`, no refresh owed) and `slot = idle`"',
  'I1.at-idle': 'M4.3 rule 8: "Ready is entered only from `settling`, at a slot-idle event, and only when no notice came since the catalog\'s walk began."',
  'I12.stranded': 'M7: "I12 (added for W): a run Ready with notices it hasn\'t walked (`changes ≠ published.changes`) always owes or runs a refresh; it is never stranded stale"',
  'I12.owed-idle': 'M4.4: "| ready (refreshOwed) | slot idle | — | refreshing (want page 1) | arm(list, listMs) — the list deadline starts when the carrying exchange has drained |"',
  'SLOT.busy': 'M0: "A transition that emits `admin` sets `slot = busy` in its own next state, without waiting for the exchange machine\'s busy event"',
  'SLOT.idle-only': 'M3: "`admin{run, kind, cursor?}` (emitted only while `slot = idle`; the driver calls `exchangeNow` synchronously)"',
  'SLOT.mirror': 'M1: "slot: \'idle\' | \'busy\' // mirror of the exchange machine, fed as events". M0: "the mirror ignores a busy event it already set"',
  'SLOT.want-idle': 'M0: "A step entered with a `want` while `slot = idle` issues its `admin` in that same transition; only a step entered while busy waits for a slot-idle event."',
  'SLOT.want-match': 'M4.3: "| any step with `want` | slot idle | run alive | the step, in flight | admin(want) |"',
  // era
  'ERA.new': 'D5.4: "opening | `initialize` sent (legacy first; modern on the server\'s refusal, 3.3)". M4.3: "new run #n+1, era modern, relaunched, launching"',
  'ERA.once': 'I10: "G29 (the era decided once, at the run\'s opening)". M4.3: "| opening | admin-done modern-refusal | recovery | ended | End(session-ended) — no era change (H12) |"',
  'ERA.frame': 'D6 G29: "A run\'s era is decided once, from the server\'s own refusal, and every request of that run is framed for it"',
  'ERA.initialized': 'M4.3: "| opening | admin-done modern-refusal | the run\'s opening (not recovery) | walking page 1, era modern |". D6 G15/H12: "a modern run builds `initialized`" (the mutation that must fail)',
  // admission
  'ADMIT.no-run': 'M4.1: "| stopped, failed | start / test | otherwise | run #n …". I10: "G27 (Test only from Stopped)"',
  'ADMIT.record': 'M4.1: "| stopped, failed | start / test | record missing, unreadable, removing, SSE, or `auto` and disabled | same | answer(refused or failed, its words) |"',
  'ADMIT.record-reply': 'M4.1: "| stopped, failed | start / test | record missing, unreadable, removing, SSE, or `auto` and disabled | same | answer(refused or failed, its words) |"',
  'ADMIT.fence-admit': 'M4.1: "| stopped, failed | start / test | an orphan of this setup still open (refused stop, no exit) | same | answer(failed, \\"may still be running\\" words) — I2 |"',
  'ADMIT.fence-reply': 'M4.1: "| stopped, failed | start / test | an orphan of this setup still open (refused stop, no exit) | same | answer(failed, \\"may still be running\\" words) — I2 |"',
  'ADMIT.owner-admit': 'M4.1: "| stopped, failed | start / test | `!ownerFree` | same | answer(refused, owner\'s words). The failure shown before stays (r33b #9) |"',
  'ADMIT.owner-reply': 'M4.1: "| stopped, failed | start / test | `!ownerFree` | same | answer(refused, owner\'s words). The failure shown before stays (r33b #9) |"',
  'ADMIT.must': 'M4.1: "| stopped, failed | start / test | otherwise | run #n: local → launching, remote → opening (want initialize); phase starting |"',
  'ADMIT.shape': 'M4.1: "… | owner-hold (local only); native-start (local); arm(start, startMs); waiter(start or test, bound to run #n) |". I10: "G3 (the launch read at admission)"',
  'ADMIT.fresh-id': 'M1: "nextRun: number // run ids are `${server}#${n}`, never reused"',
  'ADMIT.busy-reply': 'M4.1: "| starting, ready, stopping | start / test | — | same | answer(refused, \\"It is starting / already running / stopping\\") |"',
  'ADMIT.only': 'Appendix: "admission and owner-hold are one transition". M4.1/M4.3: a run is made only by an admitted start or by "readmit | ownerFree, setup unchanged … | new run #n+1"',
  'PERSON.unchanged': 'D5.4: "A refused Start or Test changes nothing: the failure shown before stays." M4.1: "| stopped, failed | start / test | record missing, unreadable, removing, SSE, or `auto` and disabled | same | answer(refused or failed, its words) |", "| stopped, failed | stop | no orphan | same | answer(stopped) |"',
  'HELD.words': 'M4.1: "| held | start, test, stop | — | held | answer(restart words) |". D5.4: "every action answers them until Familiar restarts"',
  // native, owner, orphans
  'I2.one': 'I2: "At most one process per setup: a pending `server_start` or a run\'s process, plus orphans, counts at most one not seen to exit"',
  'I2.stop-once': 'I2: "and `native-stop` at most once per run". M3: "`native-stop{run}` (the machine emits it at most once per run, I2)"',
  'I2.stop-target': 'D5.4: "each run is stopped natively once". M4.6: "| local, process alive | closing (stop pending), cause kept | end-live; native-stop (once; killed) |" (the run\'s own process)',
  'KILL.flag': 'M1: "killed: boolean // Familiar asked the exe to stop this process (watchdog, deadline, Stop, Test)"',
  'NAT.mirror': 'M1: "native?: { start: \'pending\' | \'ok\' | \'failed\'; stop: \'none\' | \'pending\' | \'ok\' | \'refused\'; exited: boolean } // local only"',
  'ORPH.mirror': 'M1: "orphans: Orphan[] // earlier local processes not yet seen to exit". M1: "Orphan … // a stop the exe refused, or an exit Stop\'s deadline outran"',
  'END.stop-owed': 'M4.6: "| local, process alive | closing (stop pending), cause kept | end-live; native-stop (once; killed); arm(stop, stopMs) |". M4.2: "| closing (start pending) | started ok(p) | — | closing (stop pending) | owner-release; native-stop; killed |"',
  'I6.owner': 'I6: "`owner = start` exactly while a native start (first or relaunch) is pending". M4.2: "The owner is never held past the native start\'s answer, on any path (r33b #5)."',
  'I6.effects': 'Appendix r30b #19: "admission and owner-hold are one transition; every terminal row releases (I6)"',
  'I6.pair': 'M4.1: "owner-hold (local only); native-start (local)". M4.3: "| ended (relaunch pending) | readmit | … | owner-hold; native-start; arm(start) |"',
  // deadlines and waiters
  'DL.fresh': 'M2: "Deadlines (each armed by an effect with a fresh id; a stale id is ignored)"',
  'DL.stale': 'M2: "Deadlines (each armed by an effect with a fresh id; a stale id is ignored)"',
  'DL.list-drained': 'M4.4: "arm(list, listMs) — **the list deadline starts when the carrying exchange has drained**"',
  'DL.start-once': 'M6b.1: "The start deadline is armed once, at a person\'s admission (start, auto or Test). … Nothing re-arms it or extends it."',
  'I5.launching': 'I5: "Every waiting step has a deadline armed." M4.1: "arm(start, startMs)"',
  'I5.opening': 'I5: "Every waiting step has a deadline armed." (start, or the refresh\'s list, or "arm(recovery, startMs)")',
  'I5.initialized': 'I5: "Every waiting step has a deadline armed." (start, list or recovery, by purpose)',
  'I5.walking': 'I5: "Every waiting step has a deadline armed." (start, list or recovery, by purpose)',
  'I5.settling': 'I5: "Every waiting step has a deadline armed." Rule 8: "it all runs inside the start\'s deadline"',
  'I5.grace': 'I5: "Every waiting step has a deadline armed." M4.3: "| walking | admin-done unanswered | … | grace | arm(grace, min(2 s, start left)) |"',
  'I5.relaunch': 'I5: "Every waiting step has a deadline armed." M4.3: "the start deadline armed at admission still runs"',
  'I5.closing': 'M6b.4: "Every closing step has a stop deadline armed once no native start is pending. A late `started(ok)` in closing arms it in that same transition."',
  'I9.admit': 'I3: "Every waiter is answered exactly once, by a transition". I9: "Every person action, from any phase …, is answered within its deadline"',
  'I9.bounded': 'I5: "no waiter is left unbounded, since the start deadline answers the start and the stop deadline answers a Stop"',
  'I9.disarm': 'M6b.1: "It stays armed until that action\'s waiter is answered: through the handshake, the walk, settling, the first catalog write, grace and a relaunch."',
  'I9.fire': 'I9: "Every person action, from any phase (Start and Test from Stopped included), is answered within its deadline"',
  'I8.bound': 'I8: "Every Stop is answered stopped, may-still-run, or the held words, within the stop deadline"',
  'I3.quiescent': 'I3: "at the end of each trace no waiter is left in a quiescent state"',
  'W.mirror': 'M1: "waiters: Waiter[] // person actions not yet answered"',
  'W.current': 'M4.6 End: "answer every waiter bound to this run in the cause\'s words". Appendix: "nothing waits on a promise"',
  // answers
  'I3.once': 'I3: "Every waiter is answered exactly once, by a transition"',
  'I3.known': 'I3: "Every waiter is answered exactly once, by a transition"',
  'I3.kind': 'M1: "Waiter = | { kind: \'start\' … } // answered: ready | failed(words) | stopped | refused | { kind: \'stop\' … } // answered: stopped | may-still-run | failed(held words) | refused | { kind: \'test\' … } // answered: ok(report) | failed(words)"',
  'I3.stopped-truth': 'I3: "`stopped` only after this run\'s exit was seen (local) or for a remote run"',
  'I3.msr-truth': 'I3: "`may-still-run` only with an orphan or an unanswered native start"',
  'I3.msr-owed': 'M4.6: "When the stop was refused or ran out of time, \\"It may still be running.\\" is added to whichever words the cause gives." (By 6b.2 and 6b.3 only a Test waiter still waits when a run leaves an orphan.)',
  'I3.ready': 'I3: "`ready` only from ready with its catalog write settled"',
  'I3.ready-owed': 'M4.4: "| ready (start waiter open) | catalog-saved saved / skipped | the save was this run\'s first | ready | answer start ready; a Test waiter: begin Test\'s stop (4.7) |"',
  'I3.kept': 'I3: "a start or Test waiter\'s words match the run\'s kept cause (the table in 4.6)". M6b.2: "It\'s answered in the kept cause\'s words; for a person\'s Stop, words saying it was stopped before it finished starting." M6b.11: "The start waiter is answered `stopped`: the first process\'s exit was seen, and nothing new runs."',
  'I8.kind': 'I8: "Every Stop is answered stopped, may-still-run, or the held words, within the stop deadline"',
  'I8.same': 'M4.6: "| closing | stop | — | closing | waiter(stop) — a second Stop gets the same answer as the first |"',
  // Test
  'TEST.tested-run': 'M4.7: "Test\'s waiter is bound to its run id, so no later start\'s outcome is ever Test\'s"',
  'TEST.tested-ended': 'M4.7: "Test answers **ok(report)** only when its run ended with its exit seen (local) or at once (remote)."',
  'TEST.tested-cause': 'M4.6: "| test-done | Test: ok(report) (4.7) |". M4.7: "If Test\'s stop is refused or outruns its deadline: Test answers **failed, \\"may still be running\\"**"',
  'TEST.no-stop': 'M4.7: "A Stop during Test: Test answers no success (H15)"',
  'TEST.tested-saved': 'M4.7: "On Ready its catalog write is awaited (catalog-saved), the report is built from what the walk published, and the machine begins Test\'s own stop"',
  // endings
  'END.unlisted': 'M4: "Each row is guarded; the first matching row applies; anything not listed is **ignored**"',
  'END.must': 'M4.6: "**End(cause, words)** — the one way a run ends" and the rows that end a run (e.g. "| any running step | exit(p) | this run\'s, not asked | ended |", "| any running step | write-bound | — | ended |")',
  'END.cause': 'M1: "cause?: Cause // why it ended, once it has (rule 5)". M4.6: "| local, process alive | closing (stop pending), cause kept |"',
  'END.cause-kept': 'M4.6: "A waiter\'s words come from the run\'s kept cause, never from how the run happened to end."',
  'END.live': 'M6b.5: "When a run\'s process exits, or a run ends or begins closing, any exchange of that run still live is ended (`end-live`) in that same transition. A relaunch is no exception." M6b.12: "When a run ends, any exchange of that run still live in the world is ended in that same transition (6b.5), even one taken after closing began."',
  'SLOT.world-idle': 'M6b.5: "Nothing new is admitted until the world\'s slot is idle."',
  'I9.start-at-once': 'M6b.2: "A Start waiter (mode start or auto) is answered at once when its run enters closing or ends. … It never waits on cleanup."',
  'I9.test-at-once': 'M6b.3: "A Test waiter is answered at once, like a Start, when its run enters closing for any cause but its own cleanup (test-done)."',
  'TEST.stop-cleanup': 'M6b.3: "A person\'s Stop during Test\'s cleanup answers Test at once, failed. There\'s still one native stop."',
  'SAVED.late': 'M6b.1: "If the deadline fires during the first catalog write, the run ends with cause deadline, in START_TIMEOUT\'s words, and a later `saved` for that run changes nothing more." (Bar the save bookkeeping, and the `written` of a run whose save that `saved` issues.)',
  'ORPH.words': 'M6b.8: "The orphan keeps its stop outcome (refused or unconfirmed). Later Stops, Starts and Tests use its own words."',
  'END.live-once': 'M3: "`end-live{run}` (Stop\'s fence: the live exchange of this run gets `terminal run-ended` in the same step)". M6b.12: "even one taken after closing began" (a second end-live only for an exchange live since the first)',
  'END.report': 'M4.6 End: "report-ended (if not person-asked)" M6b.11: "An automatic start\'s relaunch (mode auto) whose readmit finds the server turned off ends the run as the person\'s own choice."',
  'END.release': 'M3: "`release-writes{run}` (an exit seen: the exchange\'s writes for that process end)". Appendix: "writes end only at the exit"',
  'PHASE.after': 'M4.7: "the person\'s phase after Test is computed from the run\'s cause (`test-done` and a Test\'s own failure leave Stopped; a person\'s start that fails leaves Failed)". M4.6: "stop-answered refused | … phase failed", "deadline(stop) | … phase failed" M6b.11: "An automatic start\'s relaunch (mode auto) whose readmit finds the server turned off … The phase is Stopped, as after a person\'s Stop. The readmit\'s other refusals (the owner busy, the setup changed) end Failed, in the readmit\'s words."',
  'PHASE.after-words': 'M1: "failure?: Failure // what the person sees beside Failed (and Held)". D5.4: "the server goes to Failed with the reason and its last output"',
  'G18.call': 'I10: "G18 (a call\'s end ends that call only: call-ended rows never end the run except session and era)"',
  'G15.fence': 'I10: "G14 and G15 (no admit after the fence: no `admin` effect for a closing or ended run)"',
  'G26.notice': 'I10: "G26 (no call on a stale catalog: `callable` false from a notice)"',
  // relaunch
  'I7.grace': 'M4.3: "| walking | admin-done unanswered | modern, local, first launch, opening\'s refusal on this run, not killed | grace |". I7: "No relaunch after a Familiar-caused end … or after any answer to the list"',
  'I7.relaunch': 'M4.3: "| grace | exit(p) | not killed | ended → relaunch check |". M6b.9: "A relaunch may begin from an exit that arrives while the opening\'s list is still in flight: step walking, a local run, the modern opening\'s first list on this run, not killed, and nothing answered." I7: "No relaunch after a Familiar-caused end … or after any answer to the list"',
  'I7.check': 'M4.3: "| grace | exit(p) | not killed | ended → relaunch check | readmit facts requested |". M6b.9: "In the same transition: … the relaunch check is made"',
  'I7.same': 'M6b.9: "The world\'s two signals can come in either order: the list ending unanswered first (through grace), or the exit first. Both lead to the same relaunch."',
  'ERA.recovery': 'M6b.10: "A recovery\'s re-handshake answered in the other era ends the run with session-ended, as an opening refusal during recovery does. The era is decided once, at the run\'s opening (G29)."',
  'I7.go-on': 'M4.3: "| ended (relaunch pending) | readmit | ownerFree, setup unchanged, (auto ⇒ enabled) | new run #n+1, era modern, relaunched, launching |". M6b.11: "Turned off only gates automatic starts (4.1). The relaunch of a person\'s own Start or Test isn\'t gated by it: that readmit goes on, so long as the owner is free and the setup is unchanged."',
  'I7.readmit': 'M4.3: "| ended (relaunch pending) | readmit | ownerFree, setup unchanged, (auto ⇒ enabled) | new run #n+1, era modern, relaunched, launching | owner-hold; native-start; arm(start) |"',
  // held
  'EXH.answer': 'M4.6: "| any | exhausted | — | held; run ended | answer every waiter the restart words; failure = held words. A step waiting for the slot … is answered by this same transition |"',
  'EXH.held': 'M4.6: "| any | exhausted | — | held; run ended | … failure = held words |"',
  // old-run events
  'I4.old': 'I4: "An old-run event changes nothing but its own orphan record". M4.6: "| any | old-run event | — | unchanged | — (I4) |"',
  'I4.orphan': 'M4.6: "| any | exit(p) | p is an orphan\'s | — | release-writes(orphan); drop the orphan (the fence lifts; I4\'s one exception: an old run\'s exit updates only its orphan record) |"',
  // recovery
  'REC.once': 'I10: "G31 (one re-handshake per drop)". M4.5: "| ready / refreshing | call-ended session-ended, or admin-done session-ended | dropped = 0 | recovering …, dropped = 1, session+1 |"',
  'REC.session': 'M4.5: "recovering (want initialize, no session id), dropped = 1, session+1 | arm(recovery, startMs)"',
  'REC.reset': 'M4.5: "| recovering | the first page or call that completes without a 404 after recovery | — | — | dropped = 0 (the bound rearms; not on the recovery\'s own walk) |"',
  // walk, publish, notices
  'WALK.pages': 'D5.4: "walking | the tool list, page by page (at most 16)"',
  'WALK.attempts': 'M4.3: "the walk\'s own retry limit (three walks, then \\"kept changing\\")"',
  'WALK.started': 'M4.3: "| initialized | admin-done ok | — | walking page 1, attempt 0, `startedAt = changes` |", "walking page 1, attempt+1, `startedAt = changes`"',
  'PUB.fresh': 'Appendix: "4.3: publish only if `changes = startedAt`"',
  'PUB.must': 'M4.3: "| walking | admin-done page(tools, none) | `changes = startedAt`; the catalog builds | settling | publish; `published.changes = startedAt` |"',
  'PUB.mark': 'M4.3: "| walking | admin-done page(tools, none) | `changes = startedAt`; the catalog builds | settling | publish; `published.changes = startedAt` |"',
  'PUB.gen': 'M4.4: "the machine saves the newest published catalog again. So an older save can never land last."',
  'NOT.count': 'M4.3: "| settling | notice | — | settling, `changes+1` |". D5.4: "a notice during a walk is counted"',
  'NOT.only': 'M1: "changes: number // tools-changed notices read on this run"',
  // catalog writes
  'I11.one': 'M4.4: "At most one `save-catalog` is in flight (`catalog.saving`)."',
  'I11.newest': 'M7: "I11 as W checks it: at most one save in flight, and every save issued is for the newest catalog published"',
  'I11.mirror': 'M1: "catalog: { saving?: runId } // the catalog write in flight, if any". T LcState.saving: "The catalog write in flight: whose it is and its generation, fixed when it was issued."',
  'SAVE.retry': 'M6b.13: "A later catalog write that fails (a refresh\'s or a recovery\'s, not the first) keeps its generation and is tried once more, one save at a time (I11)." "A newer publication supersedes an older unsaved generation, and is saved in its turn."',
  'SAVE.unsaved': 'M6b.13: "A second failure leaves that generation marked unsaved". "`noteOf` returns \"Familiar couldn\'t save this server\'s latest tool list; it shows the list it saved before.\" while the run is current and its newest published generation is marked unsaved."',
  'SAVE.note-none': 'M6b.13: "`noteOf` … returns nothing otherwise: not after the first failure (the retry is still due)". (Nothing marked unsaved, no note.)',
  'SAVE.note-cleared': 'M6b.13: "`noteOf` returns … while the run is current and its newest published generation is marked unsaved. It returns nothing otherwise: … and not once a newer generation has saved."',
  'P.failure-note': 'M6b.13: "It\'s a note beside a Ready server, not a failure, so `failureOf` doesn\'t carry it."',
  'SAVE.turn': 'M6b.13: "\"In its turn\" is the newer generation\'s own save: at its settle, or in the failure\'s own transition if its save was already asked for while the failed one was in flight (I11\'s one-at-a-time rule)." "So a failure that lands after a newer generation is published retries nothing. Nothing more is due in that transition unless the newer generation\'s save was already asked for." T Run.queued: "This run asked for a write while another was in flight. When that one lands, the run\'s newest generation is written, if the run is still current and not closing."',
  'SAVE.whose': 'M6b.13: "Every write\'s identity is fixed when it is issued: whose it is, its generation, and whether it is the run\'s first." "A queued re-save belongs to the run that queued it. When that run leaves, its queue goes with it." "keeps its generation and is tried once more". T Run.queued: "the run\'s newest generation is written, if the run is still current and not closing."',
  'SAVE.closing': 'M6b.13: "Closing issues no new save, so it issues no retry."',
  'SAVE.own-queue': 'M6b.13: "A queued re-save belongs to the run that queued it. When that run leaves, its queue goes with it. … A write that lands late for a run that has left issues only a write the current run itself queued (its settle came while that write was in flight)."',
  'SAVE.once': 'M6b.13: "Each generation is written once, plus its one retry." "Once any write of a generation has been issued, landed, failed or still in flight, its settle writes nothing for it. The only further write of that generation is the one retry after its first failure."',
  'SAVE.goes-on': 'M6b.13: "The run goes on in both cases: only the first save\'s failure ends a run (catalog-failed)."',
  'I11.owed': 'I11: "Once quiescent (no event pending), the catalog last saved is the one published". M4.4: "when that save settles, the machine saves the newest published catalog again"',
};

// ---------------------------------------------------------------------------------------------------------
// The stub machine (controls only): section 1's definitions, read on the types.
// ---------------------------------------------------------------------------------------------------------

export const stubMachine: Machine = {
  callable: callableFormula,
  phaseOf: derivedPhase,
  fenced: (s) => s.orphans.length > 0,
  offering: (s) => !!s.run && !s.held && phaseReadyRun(s.run) && s.run.published !== undefined,
  failureOf: (s) => s.held ?? (s.run ? undefined : s.after?.failed ? s.after.failure : undefined),
  // The types show no state field for the mark, so the stub has none; controls set it by hand.
  noteOf: () => undefined,
};

// ---------------------------------------------------------------------------------------------------------
// Controls: one hand-built bad transition per clause, flagged by that clause alone, and its near-miss twin.
// ---------------------------------------------------------------------------------------------------------

export interface Tr { prev: LcState; e: LcEvent; next: LcState; effects: LcEffect[]; hist?: History; m?: Partial<Machine> }
export interface Control extends Tr { clause: string; good: boolean }

/** A world consistent with a hand-built state (for controls; a walk builds History with advance). */
export function histFromState(s: LcState, over: Partial<History> = {}, extraArmed: Armed[] = []): History {
  const r = s.run;
  const armed: Armed[] = [...extraArmed];
  if (r?.deadline) armed.push({ id: r.deadline.id, which: r.deadline.which, run: r.id });
  if (r && r.saveBy !== undefined && r.saveBy !== r.deadline?.id) armed.push({ id: r.saveBy, which: 'start', run: r.id });
  const startBound = !r ? undefined : r.saveBy ?? (r.deadline?.which === 'start' ? r.deadline.id
    : r.step === 'closing' && r.deadline?.which === 'stop' ? r.deadline.id : extraArmed.find((a) => a.which === 'start')?.id);
  const stopBound = r?.deadline?.which === 'stop' ? r.deadline.id : undefined;
  const alive: { process: string; run: string }[] = [];
  if (r?.native?.start === 'ok' && !r.native.exited && r.native.process) alive.push({ process: r.native.process, run: r.id });
  for (const o of s.orphans) alive.push({ process: o.process, run: o.run });
  const pub = !!r && r.published !== undefined;
  const closingFenced = !!r && ((r.step === 'closing' && r.native?.start !== 'pending') || r.step === 'relaunch');
  const h: History = {
    runs: r ? [r.id] : [],
    ids: Array.from({ length: s.nextDeadline }, (_, i) => i),
    armed,
    startPending: r?.native?.start === 'pending' ? [r.id] : [],
    stopPending: r?.native?.stop === 'pending' ? [r.id] : [],
    stopIssued: r?.native && r.native.stop !== 'none' ? [r.id] : [],
    alive,
    open: s.waiters.map((w) => ({ token: w.token, kind: w.kind, run: w.run ?? r?.id, bound: w.kind === 'stop' ? stopBound : startBound })),
    answered: [],
    stopReply: [],
    saving: s.saving?.gen,
    lastSave: s.saving?.gen ?? (pub && r!.firstSave === 'done' ? r!.gen : undefined),
    // 'owed' (5h): the settle asked for the first write, not yet issued, so no History firstSave and no write.
    lastPublish: pub ? r!.gen : undefined,
    runPublish: pub ? [{ run: r!.id, last: r!.gen }] : [],
    firstSave: r && (r.firstSave === 'pending' || r.firstSave === 'done') ? [{ run: r.id, gen: r.firstGen, outcome: r.firstSave === 'done' ? 'saved' : undefined }] : [],
    kept: r?.cause ? [{ run: r.id, cause: r.cause, words: r.failure?.words ?? '*' }] : [],
    fenced: closingFenced ? [r!.id] : [],
    exchange: r?.inFlight ? [{ run: r.id, kind: r.inFlight.kind, page: r.inFlight.kind === 'list' ? r.inFlight.page : undefined }] : [],
    slot: s.slot,
    live: s.slot === 'busy' && r && !closingFenced && r.step !== 'closing' ? r.id : undefined,
    remote: r?.where === 'remote' ? [r.id] : [],
    orphanWords: s.orphans.map((o) => ({ process: o.process, words: s.after?.failure && msrWords(s.after.failure.words) ? s.after.failure.words : '*' })),
    listAnswered: r?.walk?.answered ? [r.id] : [],
    stoppedBy: [],
    readmit: r?.step === 'relaunch' ? [r.id] : [],
    graceWords: r?.graceFailure ? [{ run: r.id, words: r.graceFailure.words }] : [],
    reported: [],
    savingRun: s.saving?.run,
    saveFails: [],
    writes: [
      ...(r && (r.firstSave === 'pending' || r.firstSave === 'done') && r.firstGen !== s.saving?.gen ? [{ run: r.id, gen: r.firstGen, count: 1 }] : []),
      ...(s.saving ? [{ run: s.saving.run, gen: s.saving.gen, count: 1 }] : []),
    ],
  };
  return normalize({ ...h, ...over });
}

const R0 = 'srv#0', R1 = 'srv#1', R2 = 'srv#2', P0 = 'srv#0:p', P1 = 'srv#1:p', P2 = 'srv#2:p';
const F = (words: string, kind: Failure['kind'] = 'failed'): Failure => ({ kind, words });
const failed = (f: Failure): Reply => ({ kind: 'failed', failure: f });
const ans = (token: string, reply: Reply): LcEffect => ({ t: 'answer', token, reply });
const Wt = (kind: Waiter['kind'], token: string, run = R1): Waiter => ({ kind, token, run });
const startEv = (token: string, mode: Mode = 'start', facts: Partial<StartFacts> = {}): LcEvent =>
  ({ t: 'start', token, mode, facts: { record: 'ok', ownerFree: true, where: 'local', ...facts } });
const NATIVE_OK = { start: 'ok', process: P1, stop: 'none', exited: false } as const;
const NATIVE_PENDING = { start: 'pending', stop: 'none', exited: false } as const;
const FRESH = { published: undefined, gen: 0, firstSave: 'none', firstGen: 0 } as const;
const REMOTE = { where: 'remote', native: undefined } as const;
const OTHER = F('Something else.');
const STOPPED_EARLY = F('The server was stopped before it finished starting.');

function mkRun(p: Partial<Run> = {}): Run {
  return {
    id: R1, where: 'local', era: 'legacy', mode: 'start', relaunched: false, purpose: 'start', step: 'ready', native: NATIVE_OK,
    changes: 0, published: 0, gen: 1, refreshOwed: false, dropped: 0, recovered: false, killed: false, modernOpening: false,
    firstSave: 'done', firstGen: 1, ...p,
  };
}
function mkSt(p: Partial<LcState> = {}): LcState {
  return { id: 'srv', nextRun: 2, nextDeadline: 10, nextGen: 2, orphans: [], waiters: [], owner: 'free', slot: 'idle', ...p };
}
const launching = (p: Partial<Run> = {}) => mkRun({ ...FRESH, step: 'launching', native: NATIVE_PENDING, deadline: { which: 'start', id: 10 }, ...p });
const walking = (p: Partial<Run> = {}) => mkRun({ ...FRESH, step: 'walking', walk: { attempt: 0, page: 1, startedAt: 0, answered: false }, inFlight: { kind: 'list', page: 1 }, deadline: { which: 'start', id: 10 }, ...p });
const settling = (p: Partial<Run> = {}) => mkRun({ step: 'settling', walk: { attempt: 0, page: 1, startedAt: 0, answered: true }, firstSave: 'none', firstGen: 0, deadline: { which: 'start', id: 10 }, ...p });
const readyFirst = (p: Partial<Run> = {}) => mkRun({ walk: { attempt: 0, page: 1, startedAt: 0, answered: true }, firstSave: 'pending', firstGen: 1, saveBy: 10, ...p });
const closingRun = (p: Partial<Run> = {}) => mkRun({ step: 'closing', cause: 'person-stop', killed: true, native: { ...NATIVE_OK, stop: 'pending' }, deadline: { which: 'stop', id: 10 }, ...p });
const A = Wt('start', 'a');

/** The same state with its run in another mode (a Test's start waiters become Test waiters). */
function inMode(s: LcState, mode: Mode): LcState {
  return { ...s, run: s.run && { ...s.run, mode }, waiters: s.waiters.map((w) => (mode === 'test' && w.kind === 'start' ? { ...w, kind: 'test' as const } : w)) };
}
/** Deep copy, then let `f` change it (the controls' mutation). */
function mod(t: Tr, f: (x: any) => void): Tr {
  const c: Tr = { ...JSON.parse(JSON.stringify({ ...t, m: undefined })), m: t.m };
  f(c);
  return c;
}

// ---- base transitions (each must pass every check) ----
const B = {
  admitLocal: (): Tr => ({
    prev: mkSt({ nextRun: 1 }), e: startEv('a'),
    next: mkSt({ nextDeadline: 11, owner: 'start', run: launching(), waiters: [A] }),
    effects: [{ t: 'owner-hold' }, { t: 'native-start', run: R1, era: 'legacy' }, { t: 'arm', id: 10, which: 'start' }],
  }),
  admitRemote: (id = R1, mode: Mode = 'start', prevP: Partial<LcState> = {}): Tr => {
    const k = Number(id.split('#')[1]);
    return {
      prev: mkSt({ nextRun: k, ...prevP }), e: startEv('a', mode, { where: 'remote' }),
      next: mkSt({ ...prevP, nextRun: k + 1, nextDeadline: 11, slot: 'busy', waiters: [Wt(mode === 'test' ? 'test' : 'start', 'a', id)],
        run: mkRun({ ...FRESH, ...REMOTE, id, mode, step: 'opening', inFlight: { kind: 'initialize' }, deadline: { which: 'start', id: 10 } }) }),
      effects: [{ t: 'arm', id: 10, which: 'start' }, { t: 'admin', run: id, want: { kind: 'initialize' }, era: 'legacy' }],
    };
  },
  startedOk: (): Tr => ({
    prev: B.admitLocal().next, e: { t: 'started', run: R1, ok: true, process: P1 },
    next: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: mkRun({ ...FRESH, step: 'opening', inFlight: { kind: 'initialize' }, deadline: { which: 'start', id: 10 } }) }),
    effects: [{ t: 'owner-release' }, { t: 'admin', run: R1, want: { kind: 'initialize' }, era: 'legacy' }],
  }),
  initialized: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: mkRun({ ...FRESH, step: 'initialized', want: { kind: 'initialized' }, deadline: { which: 'start', id: 10 } }) }),
    e: { t: 'slot', idle: true },
    next: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: mkRun({ ...FRESH, step: 'initialized', inFlight: { kind: 'initialized' }, deadline: { which: 'start', id: 10 } }) }),
    effects: [{ t: 'admin', run: R1, want: { kind: 'initialized' }, era: 'legacy' }],
  }),
  modernRefusal: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: mkRun({ ...FRESH, step: 'opening', inFlight: { kind: 'initialize' }, deadline: { which: 'start', id: 10 } }) }),
    e: { t: 'admin-done', run: R1, outcome: { k: 'modern-refusal' } },
    next: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: walking({ era: 'modern', modernOpening: true, inFlight: undefined, want: { kind: 'list', page: 1 } }) }),
    effects: [],
  }),
  walkLast: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, nextGen: 1, slot: 'busy', waiters: [A], run: walking() }),
    e: { t: 'admin-done', run: R1, outcome: { k: 'page', more: false, catalog: 'ok' } },
    next: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: settling() }),
    effects: [{ t: 'publish', run: R1, gen: 1 }],
  }),
  settleReady: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: settling() }),
    e: { t: 'slot', idle: true },
    next: mkSt({ nextDeadline: 11, saving: { run: R1, gen: 1 }, waiters: [A], run: readyFirst() }),
    effects: [{ t: 'save', run: R1, gen: 1 }],
  }),
  savedReady: (): Tr => ({
    prev: B.settleReady().next, e: { t: 'saved', gen: 1, outcome: 'saved' },
    next: mkSt({ nextDeadline: 11, run: readyFirst({ firstSave: 'done', saveBy: undefined }) }),
    effects: [{ t: 'disarm', id: 10 }, ans('a', { kind: 'ready' })],
  }),
  settleRewalk: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: settling({ changes: 1 }) }),
    e: { t: 'slot', idle: true },
    next: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: walking({ changes: 1, published: 0, gen: 1, walk: { attempt: 1, page: 1, startedAt: 1, answered: false } }) }),
    effects: [{ t: 'admin', run: R1, want: { kind: 'list', page: 1 }, era: 'legacy' }],
  }),
  noticeIdle: (): Tr => ({
    prev: mkSt({ run: mkRun() }), e: { t: 'notice', run: R1 },
    next: mkSt({ nextDeadline: 11, slot: 'busy', run: mkRun({ step: 'walking', purpose: 'refresh', changes: 1, walk: { attempt: 0, page: 1, startedAt: 1, answered: false }, inFlight: { kind: 'list', page: 1 }, deadline: { which: 'list', id: 10 } }) }),
    effects: [{ t: 'arm', id: 10, which: 'list' }, { t: 'admin', run: R1, want: { kind: 'list', page: 1 }, era: 'legacy' }],
  }),
  stopReady: (): Tr => ({
    prev: mkSt({ run: mkRun() }), e: { t: 'stop', token: 's' },
    next: mkSt({ nextDeadline: 11, run: closingRun(), waiters: [Wt('stop', 's')] }),
    effects: [{ t: 'end-live', run: R1 }, { t: 'native-stop', run: R1, process: P1 }, { t: 'arm', id: 10, which: 'stop' }],
  }),
  exitClosing: (): Tr => ({
    prev: B.stopReady().next, e: { t: 'exit', process: P1, failure: EXIT_FAILURE },
    next: mkSt({ nextDeadline: 11, after: { failed: false } }),
    effects: [{ t: 'release-writes', process: P1 }, { t: 'disarm', id: 10 }, ans('s', { kind: 'stopped' })],
  }),
  refusedStop: (): Tr => ({
    prev: B.stopReady().next, e: { t: 'stop-answered', run: R1, ok: false },
    next: mkSt({ nextDeadline: 11, orphans: [{ run: R1, process: P1 }], after: { failed: true, failure: STOP_REFUSED } }),
    effects: [{ t: 'disarm', id: 10 }, ans('s', failed(STOP_REFUSED))],
  }),
  stopRemote: (): Tr => ({
    prev: mkSt({ run: mkRun(REMOTE) }), e: { t: 'stop', token: 's' },
    next: mkSt({ after: { failed: false } }),
    effects: [{ t: 'end-live', run: R1 }, ans('s', { kind: 'stopped' })],
  }),
  launchingStop: (): Tr => ({
    prev: B.admitLocal().next, e: { t: 'stop', token: 's' },
    next: mkSt({ nextDeadline: 12, owner: 'start', waiters: [Wt('stop', 's')], run: launching({ step: 'closing', cause: 'person-stop', deadline: { which: 'stop', id: 11 } }) }),
    effects: [{ t: 'arm', id: 11, which: 'stop' }, { t: 'disarm', id: 10 }, ans('a', failed(STOPPED_EARLY))],
  }),
  closingStartedOk: (): Tr => ({
    prev: B.launchingStop().next, e: { t: 'started', run: R1, ok: true, process: P1 },
    next: mkSt({ nextDeadline: 12, waiters: [Wt('stop', 's')], run: launching({ step: 'closing', cause: 'person-stop', killed: true, native: { ...NATIVE_OK, stop: 'pending' }, deadline: { which: 'stop', id: 11 } }) }),
    effects: [{ t: 'owner-release' }, { t: 'native-stop', run: R1, process: P1 }],
  }),
  closingPendingDeadline: (): Tr => ({
    prev: B.launchingStop().next, e: { t: 'deadline', id: 11 },
    next: mkSt({ nextDeadline: 12, owner: 'start', run: launching({ step: 'closing', cause: 'person-stop', deadline: undefined }) }),
    effects: [ans('s', failed(START_UNANSWERED))],
  }),
  launchingDeadline: (): Tr => ({
    prev: B.admitLocal().next, e: { t: 'deadline', id: 10 },
    next: mkSt({ nextDeadline: 11, owner: 'start', run: launching({ step: 'closing', cause: 'deadline', deadline: undefined }) }),
    effects: [ans('a', failed(START_UNANSWERED))],
  }),
  stopJoinsPending: (): Tr => ({
    prev: B.launchingDeadline().next, e: { t: 'stop', token: 's' },
    next: mkSt({ nextDeadline: 12, owner: 'start', waiters: [Wt('stop', 's')], run: launching({ step: 'closing', cause: 'deadline', deadline: { which: 'stop', id: 11 } }) }),
    effects: [{ t: 'arm', id: 11, which: 'stop' }],
  }),
  testSaved: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, saving: { run: R1, gen: 1 }, waiters: [Wt('test', 't')], run: mkRun({ mode: 'test', firstSave: 'pending', saveBy: 10 }) }),
    e: { t: 'saved', gen: 1, outcome: 'saved' },
    next: mkSt({ nextDeadline: 12, waiters: [Wt('test', 't')], run: closingRun({ mode: 'test', cause: 'test-done', deadline: { which: 'stop', id: 11 } }) }),
    effects: [{ t: 'disarm', id: 10 }, { t: 'end-live', run: R1 }, { t: 'native-stop', run: R1, process: P1 }, { t: 'arm', id: 11, which: 'stop' }],
  }),
  testExit: (): Tr => ({
    prev: B.testSaved().next, e: { t: 'exit', process: P1, failure: EXIT_FAILURE },
    next: mkSt({ nextDeadline: 12, after: { failed: false } }),
    effects: [{ t: 'release-writes', process: P1 }, { t: 'disarm', id: 11 }, ans('t', { kind: 'tested', run: R1 })],
  }),
  sessionRecover: (): Tr => ({
    prev: mkSt({ slot: 'busy', run: mkRun(REMOTE) }), e: { t: 'call-ended', run: R1, end: 'session-ended' },
    next: mkSt({ nextDeadline: 11, slot: 'busy', run: mkRun({ ...REMOTE, step: 'opening', purpose: 'recovery', want: { kind: 'initialize' }, dropped: 1, deadline: { which: 'recovery', id: 10 } }) }),
    effects: [{ t: 'new-session', run: R1 }, { t: 'arm', id: 10, which: 'recovery' }],
  }),
  callDone: (): Tr => ({
    prev: mkSt({ slot: 'busy', run: mkRun({ ...REMOTE, dropped: 1 }) }), e: { t: 'call-ended', run: R1, end: 'done' },
    next: mkSt({ slot: 'busy', run: mkRun({ ...REMOTE, dropped: 0 }) }), effects: [],
  }),
  eraRefusal: (): Tr => ({
    prev: mkSt({ run: mkRun({ ...REMOTE, era: 'modern' }) }), e: { t: 'call-ended', run: R1, end: 'era-refusal', failure: ERA_F },
    next: mkSt({ after: { failed: true, failure: ERA_F } }),
    effects: [{ t: 'end-live', run: R1 }, { t: 'ended', run: R1, failure: ERA_F }],
  }),
  writeBound: (): Tr => ({
    prev: mkSt({ run: mkRun() }), e: { t: 'write-bound', run: R1 },
    next: mkSt({ nextDeadline: 11, run: closingRun({ cause: 'watchdog' }) }),
    effects: [{ t: 'end-live', run: R1 }, { t: 'native-stop', run: R1, process: P1 }, { t: 'arm', id: 10, which: 'stop' }],
  }),
  oldNotice: (): Tr => {
    const s = mkSt({ nextRun: 3, run: mkRun({ id: R2, native: { ...NATIVE_OK, process: P2 } }) });
    return { prev: s, e: { t: 'notice', run: R1 }, next: s, effects: [] };
  },
  staleDeadline: (): Tr => { const s = mkSt({ run: mkRun() }); return { prev: s, e: { t: 'deadline', id: 5 }, next: s, effects: [] }; },
  orphanExit: (): Tr => ({
    prev: mkSt({ orphans: [{ run: R1, process: P1 }], after: { failed: true, failure: STOP_REFUSED } }), e: { t: 'exit', process: P1, failure: EXIT_FAILURE },
    next: mkSt({ after: { failed: true, failure: STOP_REFUSED } }), effects: [{ t: 'release-writes', process: P1 }],
  }),
  fenceStart: (): Tr => { const s = B.orphanExit().prev; return { prev: s, e: startEv('b'), next: s, effects: [ans('b', failed(STOP_REFUSED))] }; },
  ownerBusy: (): Tr => { const s = mkSt(); return { prev: s, e: startEv('b', 'start', { ownerFree: false, ownerWords: OWNER_WORDS }), next: s, effects: [ans('b', { kind: 'refused', words: OWNER_WORDS })] }; },
  recordRefused: (): Tr => { const s = mkSt(); return { prev: s, e: startEv('b', 'start', { record: 'missing' }), next: s, effects: [ans('b', { kind: 'refused', words: "The server isn't saved." })] }; },
  busyStart: (): Tr => { const s = mkSt({ run: mkRun() }); return { prev: s, e: startEv('b'), next: s, effects: [ans('b', { kind: 'refused', words: 'It is already running.' })] }; },
  held: (): Tr => { const s = mkSt({ held: HELD_FAILURE }); return { prev: s, e: startEv('b'), next: s, effects: [ans('b', failed(HELD_FAILURE))] }; },
  // Ready on gen 2 with gen 1 in flight: gen 2 settled while gen 1 was in flight, so the run asked (queued) for its
  // write, which is what `advance` records at that settle (pass 5i: a newer write on a landing needs the ask).
  saveDirty: (): Tr => {
    const prev = mkSt({ saving: { run: R1, gen: 1 }, run: mkRun({ gen: 2, queued: true }) });
    return {
      prev, e: { t: 'saved', gen: 1, outcome: 'saved' },
      next: mkSt({ saving: { run: R1, gen: 2 }, run: mkRun({ gen: 2, written: 2 }) }), effects: [{ t: 'save', run: R1, gen: 2 }],
      hist: histFromState(prev, { askedFor: { run: R1, gen: 2 } }),
    };
  },
  exhausted: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: walking(REMOTE) }), e: { t: 'exhausted', failure: HELD_FAILURE },
    next: mkSt({ nextDeadline: 11, slot: 'busy', held: HELD_FAILURE }),
    effects: [{ t: 'end-live', run: R1 }, ans('a', failed(HELD_FAILURE))],
  }),
  graceEnter: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: walking({ era: 'modern', modernOpening: true }) }),
    e: { t: 'admin-done', run: R1, outcome: { k: 'unanswered', failure: NO_ANSWER_F } },
    next: mkSt({ nextDeadline: 12, slot: 'busy', waiters: [A], run: walking({ era: 'modern', modernOpening: true, step: 'grace', inFlight: undefined, deadline: { which: 'grace', id: 11 }, graceFailure: NO_ANSWER_F }) }),
    effects: [{ t: 'arm', id: 11, which: 'grace' }],
  }),
  graceExit: (): Tr => {
    const prev = B.graceEnter().next;
    return {
      prev, e: { t: 'exit', process: P1, failure: EXIT_FAILURE }, hist: histFromState(prev, {}, [{ id: 10, which: 'start', run: R1 }]),
      next: mkSt({ nextDeadline: 12, slot: 'busy', waiters: [A], run: walking({ era: 'modern', modernOpening: true, step: 'relaunch', inFlight: undefined, native: { ...NATIVE_OK, exited: true }, graceFailure: NO_ANSWER_F }) }),
      effects: [{ t: 'release-writes', process: P1 }, { t: 'end-live', run: R1 }, { t: 'disarm', id: 11 }, { t: 'readmit-check', run: R1 }],
    };
  },
  // 6b.9: the exit first, while the modern opening's first list is still in flight
  exitFirst: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: walking({ era: 'modern', modernOpening: true }) }),
    e: { t: 'exit', process: P1, failure: EXIT_FAILURE },
    next: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [A], run: walking({ era: 'modern', modernOpening: true, step: 'relaunch', inFlight: undefined, native: { ...NATIVE_OK, exited: true } }) }),
    effects: [{ t: 'release-writes', process: P1 }, { t: 'end-live', run: R1 }, { t: 'readmit-check', run: R1 }],
  }),
  // ...and the list's own outcome arriving afterwards, terminal since the end-live
  lateListInRelaunch: (): Tr => {
    const prev = B.exitFirst().next;
    return {
      prev, e: { t: 'admin-done', run: R1, outcome: { k: 'unanswered', failure: RUN_ENDED_F } }, next: prev, effects: [],
      hist: histFromState(prev, { exchange: [{ run: R1, kind: 'list', page: 1, ended: true }] }),
    };
  },
  // 6b.10: a modern run's recovery answered legacy
  recoveryOtherEra: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', run: mkRun({ ...REMOTE, era: 'modern', step: 'opening', purpose: 'recovery', inFlight: { kind: 'initialize' }, dropped: 1, deadline: { which: 'recovery', id: 10 } }) }),
    e: { t: 'admin-done', run: R1, outcome: { k: 'legacy' } },
    next: mkSt({ nextDeadline: 11, slot: 'busy', after: { failed: true, failure: SESSION_ENDED } }),
    effects: [{ t: 'end-live', run: R1 }, { t: 'ended', run: R1 }],
  }),
  // 6b.11: the readmit finds the server turned off (an automatic start), or another refusal
  readmitRefused: (off: boolean, mode: Mode = off ? 'auto' : 'start'): Tr => {
    const words = off ? 'The server was turned off.' : OWNER_WORDS;
    return {
      prev: inMode(B.graceExit().next, mode), e: { t: 'readmit', run: R1, ok: false, words, ...(off ? { off: true } : {}) },
      next: mkSt({ nextDeadline: 12, slot: 'busy', after: off ? { failed: false } : { failed: true, failure: F(words, 'busy') } }),
      effects: off ? [ans('a', { kind: 'stopped' })] : [ans('a', failed(F(words, 'busy'))), { t: 'ended', run: R1 }],
    };
  },
  readmitOk: (mode: Mode = 'start'): Tr => ({
    prev: inMode(B.graceExit().next, mode), e: { t: 'readmit', run: R1, ok: true },
    next: inMode(mkSt({ nextRun: 3, nextDeadline: 12, slot: 'busy', owner: 'start', waiters: [Wt('start', 'a', R2)], run: launching({ id: R2, era: 'modern', relaunched: true }) }), mode),
    effects: [{ t: 'owner-hold' }, { t: 'native-start', run: R2, era: 'modern' }],
  }),
  // 6b.11 (narrowed): a person's own Start or Test relaunch whose readmit finds the server turned off goes on
  readmitOffGoesOn: (mode: Mode): Tr => mod(B.readmitOk(mode), (t) => { t.e = { t: 'readmit', run: R1, ok: false, off: true, words: 'The server was turned off.' }; }),
  // 6b.12: a closing run (fenced at its Stop) whose slot a ping took after closing began, then its exit
  closingLiveExit: (endLive: boolean): Tr => {
    const t = mod(B.exitClosing(), (x) => { x.prev.slot = 'busy'; x.next.slot = 'busy'; if (endLive) x.effects.push({ t: 'end-live', run: R1 }); });
    return { ...t, hist: histFromState(t.prev, { live: R1, slot: 'busy' }) };
  },
  // 6b.12: a run ending while an admin exchange of it still awaits its outcome (hand-set world: no slot holder)
  writeBoundExchange: (endLive: boolean): Tr => {
    const t = mod(B.writeBound(), (x) => { if (!endLive) x.effects = x.effects.filter((f: LcEffect) => f.t !== 'end-live'); });
    return { ...t, hist: histFromState(t.prev, { exchange: [{ run: R1, kind: 'list', page: 1 }] }) };
  },
  relaunchStop: (): Tr => ({
    prev: B.graceExit().next, e: { t: 'stop', token: 's' },
    next: mkSt({ nextDeadline: 12, slot: 'busy', after: { failed: false } }),
    effects: [ans('s', { kind: 'stopped' }), ans('a', { kind: 'stopped' })],
  }),
  // Test's own cleanup refused: Test is answered as the run leaves an orphan
  testRefused: (f: Failure): Tr => ({
    prev: B.testSaved().next, e: { t: 'stop-answered', run: R1, ok: false },
    next: mkSt({ nextDeadline: 12, orphans: [{ run: R1, process: P1 }], after: { failed: true, failure: STOP_REFUSED } }),
    effects: [{ t: 'disarm', id: 11 }, ans('t', failed(f))],
  }),
  // a Stop while a Test is still starting
  testStop: (): Tr => ({
    prev: mkSt({ nextDeadline: 11, slot: 'busy', waiters: [Wt('test', 't')], run: walking({ mode: 'test' }) }), e: { t: 'stop', token: 's' },
    next: mkSt({ nextDeadline: 12, slot: 'busy', waiters: [Wt('stop', 's')], run: closingRun({ ...FRESH, mode: 'test', deadline: { which: 'stop', id: 11 } }) }),
    effects: [{ t: 'end-live', run: R1 }, { t: 'native-stop', run: R1, process: P1 }, { t: 'arm', id: 11, which: 'stop' }, ans('t', failed(STOPPED_EARLY))],
  }),
  // a Stop during Test's own cleanup
  testCleanupStop: (): Tr => ({
    prev: B.testSaved().next, e: { t: 'stop', token: 's' },
    next: mkSt({ nextDeadline: 12, waiters: [Wt('stop', 's')], run: closingRun({ mode: 'test', cause: 'test-done', deadline: { which: 'stop', id: 11 } }) }),
    effects: [ans('t', failed(STOPPED_EARLY))],
  }),
  // a deadline ended the run during its first catalog write; the save lands later
  lateSaved: (): Tr => {
    const r = (p: Partial<Run> = {}) => closingRun({ cause: 'deadline', failure: START_TIMEOUT, firstSave: 'pending', firstGen: 1, deadline: { which: 'stop', id: 11 }, ...p });
    return {
      prev: mkSt({ nextDeadline: 12, saving: { run: R1, gen: 1 }, run: r() }), e: { t: 'saved', gen: 1, outcome: 'saved' },
      next: mkSt({ nextDeadline: 12, run: r({ firstSave: 'done' }) }), effects: [],
    };
  },
  // 6b.13: a later catalog write (gen 2; the first was gen 1) fails, after `tries` earlier failures of it.
  // `newer`: gen 3 was published while it saved, and supersedes it.
  laterSaveFail: (tries: number, out: 'retry' | 'drop' | 'end', newer = false): Tr => {
    const gen = newer ? 3 : 2;
    // `newer`: the run is Ready on gen 3, so gen 3 settled while gen 2 was in flight and the run asked for its write
    // (pass 5i: what `advance` records at that settle).
    const prev = mkSt({ nextGen: 4, saving: { run: R1, gen: 2 }, run: mkRun({ gen, ...(newer ? { queued: true as const } : {}) }) });
    const next = out === 'retry' ? mkSt({ nextGen: 4, saving: { run: R1, gen }, run: mkRun({ gen }) })
      : out === 'drop' ? mkSt({ nextGen: 4, run: mkRun({ gen }) })
      : mkSt({ nextGen: 4, nextDeadline: 11, run: closingRun({ cause: 'catalog-failed', gen }) });
    const effects: LcEffect[] = out === 'retry' ? [{ t: 'save', run: R1, gen }]
      : out === 'drop' ? [] : [{ t: 'end-live', run: R1 }, { t: 'native-stop', run: R1, process: P1 }, { t: 'arm', id: 10, which: 'stop' }];
    return {
      prev, e: { t: 'saved', gen: 2, outcome: 'failed' }, next, effects,
      hist: histFromState(prev, { saveFails: tries ? [{ gen: 2, count: tries }] : [], lastSave: 2, ...(newer ? { askedFor: { run: R1, gen: 3 } } : {}) }),
    };
  },
  // 6b.13: gen 2 was marked unsaved; gen 3, published since, now saves
  newerSaved: (): Tr => ({
    prev: mkSt({ nextGen: 4, saving: { run: R1, gen: 3 }, run: mkRun({ gen: 3 }) }), e: { t: 'saved', gen: 3, outcome: 'saved' },
    next: mkSt({ nextGen: 4, run: mkRun({ gen: 3 }) }), effects: [],
    hist: histFromState(mkSt({ nextGen: 4, saving: { run: R1, gen: 3 }, run: mkRun({ gen: 3 }) }), { saveFails: [{ gen: 2, count: 2 }], unsaved: { run: R1, gen: 2 } }),
  }),
  // 6b.13, build9's trace 2: gen 2's first failure lands after gen 3 was published, while gen 3 is still settling
  // (a refresh: notice, page, slot idle, notice, page). Nothing is due in that transition; `retryOld` retries gen 2.
  supersededFail: (retryOld: boolean): Tr => {
    const run = mkRun({ step: 'settling', purpose: 'refresh', gen: 3, changes: 2, published: 2, walk: { attempt: 0, page: 1, startedAt: 2, answered: true }, deadline: { which: 'list', id: 10 } });
    const prev = mkSt({ nextDeadline: 11, nextGen: 4, slot: 'busy', saving: { run: R1, gen: 2 }, run });
    return {
      prev, e: { t: 'saved', gen: 2, outcome: 'failed' },
      next: mkSt({ nextDeadline: 11, nextGen: 4, slot: 'busy', run, ...(retryOld ? { saving: { run: R1, gen: 2 } } : {}) }),
      effects: retryOld ? [{ t: 'save', run: R1, gen: 2 }] : [],
    };
  },
  // 6b.13: gen 3 settled (Ready entered) while gen 2 was in flight, so its save was asked for; a notice has since
  // begun another refresh walk. Gen 2's first failure must save gen 3 in its turn (`save`), here.
  // Pass 5i: `outcome` 'saved' is the same ask met by a write that lands well: the run's newest is due there too.
  askedTurn: (save: boolean, outcome: 'saved' | 'failed' = 'failed'): Tr => {
    const run = mkRun({ step: 'walking', purpose: 'refresh', gen: 3, changes: 3, published: 2, walk: { attempt: 0, page: 1, startedAt: 3, answered: false }, inFlight: { kind: 'list', page: 1 }, deadline: { which: 'list', id: 10 } });
    const prev = mkSt({ nextDeadline: 11, nextGen: 4, slot: 'busy', saving: { run: R1, gen: 2 }, run });
    return {
      prev, e: { t: 'saved', gen: 2, outcome },
      next: mkSt({ nextDeadline: 11, nextGen: 4, slot: 'busy', run, ...(save ? { saving: { run: R1, gen: 3 } } : {}) }),
      effects: save ? [{ t: 'save', run: R1, gen: 3 }] : [],
      hist: histFromState(prev, { askedFor: { run: R1, gen: 3 } }),
    };
  },
  // 6b.13, build9's 23-event remote trace, its ending: gen 3 was written early by the queued re-save, failed, and
  // its retry landed; now gen 3's own settle enters Ready. Under the fix it writes nothing (`again`: it writes gen 3).
  settleAfterRetry: (again: boolean): Tr => {
    const run = mkRun({ ...REMOTE, step: 'settling', purpose: 'refresh', gen: 3, changes: 1, published: 1, walk: { attempt: 0, page: 1, startedAt: 1, answered: true }, deadline: { which: 'list', id: 10 } });
    const prev = mkSt({ nextDeadline: 11, nextGen: 4, slot: 'busy', run });
    return {
      prev, e: { t: 'slot', idle: true },
      next: mkSt({ nextDeadline: 11, nextGen: 4, run: { ...run, step: 'ready', deadline: undefined }, ...(again ? { saving: { run: R1, gen: 3 } } : {}) }),
      effects: [{ t: 'disarm', id: 10 }, ...(again ? [{ t: 'save', run: R1, gen: 3 } as LcEffect] : [])],
      hist: histFromState(prev, { writes: [{ run: R1, gen: 1, count: 1 }, { run: R1, gen: 3, count: 2 }], saveFails: [{ gen: 3, count: 1 }], lastSave: 3 }),
    };
  },
  // Pass 5f, the 12-event remote trace's last transition: s#1 ended (start deadline) with its first save (gen 1) in
  // flight; s#2 settled and its first save (gen 2) queued. gen 1's late `saved` issues s#2's save, which sets s#2's
  // `written: 2`. `marks` also changes s#2's retried or unsaved; `stray` sets written with no save behind it.
  lateSavedIssues: (bad?: 'retried' | 'unsaved' | 'stray'): Tr => {
    // 5h: s#2's first write is owed (queued) before the landing, and issued (pending, firstGen 2) by it.
    const run = readyFirst({ ...REMOTE, id: R2, gen: 2, firstSave: 'owed', firstGen: 0, queued: true, saveBy: 11 });
    const prev = mkSt({ nextRun: 3, nextDeadline: 12, nextGen: 3, saving: { run: R1, gen: 1 }, waiters: [Wt('start', 'b', R2)], run });
    const { queued: _q, ...issuedRun } = run;
    const nrun: Run = { ...issuedRun, firstSave: 'pending', firstGen: 2, written: bad === 'stray' ? 5 : 2, ...(bad === 'retried' ? { retried: 2 } : bad === 'unsaved' ? { unsaved: 2 } : {}) };
    return {
      prev, e: { t: 'saved', gen: 1, outcome: 'saved' },
      next: mkSt({ nextRun: 3, nextDeadline: 12, nextGen: 3, saving: { run: R2, gen: 2 }, waiters: [Wt('start', 'b', R2)], run: nrun }),
      effects: [{ t: 'save', run: R2, gen: 2 }],
      hist: histFromState(prev, {
        runs: [R1, R2], firstSave: [{ run: R1, gen: 1 }], kept: [{ run: R1, cause: 'deadline', words: START_TIMEOUT.words }],
        writes: [{ run: R1, gen: 1, count: 1 }], lastSave: 1, lastPublish: 2, runPublish: [{ run: R1, last: 1 }, { run: R2, last: 2 }],
        askedFor: { run: R2, gen: 2 },
      }),
    };
  },
  // Pass 5h, build9's persons-2 remote trace (I3.ready-owed): s#2's settle asked for gen 2, but gen 3 superseded it
  // in s#2's own queue, so the write issued as its first carries gen 3 (firstGen 3). That write lands: Ready.
  firstSuperseded: (): Tr => {
    const run = readyFirst({ ...REMOTE, id: R2, gen: 3, firstGen: 3, written: 3, saveBy: 11 });
    const prev = mkSt({ nextRun: 3, nextDeadline: 12, nextGen: 4, saving: { run: R2, gen: 3 }, waiters: [Wt('start', 'b', R2)], run });
    return {
      prev, e: { t: 'saved', gen: 3, outcome: 'saved' },
      next: mkSt({ nextRun: 3, nextDeadline: 12, nextGen: 4, run: { ...run, firstSave: 'done', saveBy: undefined } }),
      effects: [{ t: 'disarm', id: 11 }, ans('b', { kind: 'ready' })],
      hist: histFromState(prev, { runs: [R1, R2], runPublish: [{ run: R1, last: 1 }, { run: R2, last: 3 }] }),
    };
  },
  // Pass 5g, build9's persons-2 remote trace, step 4: s#1's gen 2 settled behind its gen 1 (queued), then s#1's
  // start deadline ended it; s#2 published gen 3 and is still settling. gen 1 lands late and writes s#2's gen 3
  // from s#1's leftover queue.
  lateSavedLeftover: (): Tr => {
    const run = settling({ ...REMOTE, id: R2, gen: 3 });
    const prev = mkSt({ nextRun: 3, nextDeadline: 11, nextGen: 4, slot: 'busy', saving: { run: R1, gen: 1 }, waiters: [Wt('start', 'b', R2)], run });
    return {
      prev, e: { t: 'saved', gen: 1, outcome: 'saved' },
      next: mkSt({ nextRun: 3, nextDeadline: 11, nextGen: 4, slot: 'busy', saving: { run: R2, gen: 3 }, waiters: [Wt('start', 'b', R2)], run: { ...run, written: 3 } }),
      effects: [{ t: 'save', run: R2, gen: 3 }],
      hist: histFromState(prev, {
        runs: [R1, R2], firstSave: [{ run: R1, gen: 1 }], kept: [{ run: R1, cause: 'deadline', words: START_TIMEOUT.words }],
        writes: [{ run: R1, gen: 1, count: 1 }], lastSave: 1, lastPublish: 3, runPublish: [{ run: R1, last: 2 }, { run: R2, last: 3 }],
        askedFor: { run: R1, gen: 2 },
      }),
    };
  },
  // 6b.13, build9's trace 1: the retry of gen 2 fails while the run is closing (a Stop came after the first failure).
  // The mark holds in every step: noteOf is due while the run is current. Closing issues no retry.
  closingSecondFail: (): Tr => {
    const prev = mkSt({ nextDeadline: 11, nextGen: 3, saving: { run: R1, gen: 2 }, waiters: [Wt('stop', 's')], run: closingRun({ gen: 2 }) });
    return {
      prev, e: { t: 'saved', gen: 2, outcome: 'failed' },
      next: mkSt({ nextDeadline: 11, nextGen: 3, waiters: [Wt('stop', 's')], run: closingRun({ gen: 2 }) }), effects: [],
      hist: histFromState(prev, { saveFails: [{ gen: 2, count: 1 }] }),
    };
  },
  // Pass 5i: a refresh walk's last page publishes gen 2 and enters settling; its save is due only at the settle.
  // `early`: the machine writes gen 2 at the publish instead.
  refreshPublish: (early: boolean): Tr => {
    const walk = { attempt: 0, page: 1, startedAt: 1, answered: false };
    const prev = mkSt({ nextDeadline: 11, nextGen: 2, slot: 'busy', run: mkRun({ step: 'walking', purpose: 'refresh', changes: 1, walk, inFlight: { kind: 'list', page: 1 }, deadline: { which: 'list', id: 10 } }) });
    return {
      prev, e: { t: 'admin-done', run: R1, outcome: { k: 'page', more: false, catalog: 'ok' } },
      next: mkSt({ nextDeadline: 11, nextGen: 3, slot: 'busy', ...(early ? { saving: { run: R1, gen: 2 } } : {}),
        run: mkRun({ step: 'settling', purpose: 'refresh', changes: 1, published: 1, gen: 2, walk: { ...walk, answered: true }, deadline: { which: 'list', id: 10 }, ...(early ? { written: 2 } : {}) }) }),
      effects: [{ t: 'publish', run: R1, gen: 2 }, ...(early ? [{ t: 'save', run: R1, gen: 2 } as LcEffect] : [])],
    };
  },
  // Pass 5i: s#1 published and saved gen 1, then left; s#2 is walking its first list and has published nothing.
  // `foreign`: s#2 issues a write of gen 1, s#1's catalog, under its own name.
  foreignGen: (foreign: boolean): Tr => {
    const prev = mkSt({ nextRun: 3, nextDeadline: 11, nextGen: 2, slot: 'busy', waiters: [Wt('start', 'b', R2)], run: walking({ ...REMOTE, id: R2 }) });
    return {
      prev, e: { t: 'slot', idle: false },
      next: foreign ? { ...prev, saving: { run: R2, gen: 1 }, run: { ...prev.run!, written: 1 } } : prev,
      effects: foreign ? [{ t: 'save', run: R2, gen: 1 }] : [],
      hist: histFromState(prev, { runs: [R1, R2], runPublish: [{ run: R1, last: 1 }], lastPublish: 1, lastSave: 1, firstSave: [{ run: R1, gen: 1, outcome: 'saved' }], writes: [{ run: R1, gen: 1, count: 1 }] }),
    };
  },
  // Pass 5i, task 2: a Start, auto start or Test from Stopped or Failed on a record 4.1 refuses: answered, and the
  // state the same (the failure shown before stays).
  recordRefusal: (record: StartFacts['record'], mode: Mode, fromFailed: boolean, kind: 'refused' | 'failed'): Tr => {
    const s = mkSt(fromFailed ? { after: { failed: true, failure: WIRE_F } } : {});
    const words = `Record ${record}: Familiar can't start this server.`;
    return { prev: s, e: startEv('b', mode, { record }), next: s, effects: [ans('b', kind === 'refused' ? { kind: 'refused', words } : failed(F(words)))] };
  },
  // Pass 5i, task 3: row 175's "setup changed" readmit refusal, in its own words; `answered` is what the waiter gets.
  readmitSetup: (answered: string): Tr => ({
    prev: B.graceExit().next, e: { t: 'readmit', run: R1, ok: false, words: SETUP_CHANGED.words },
    next: mkSt({ nextDeadline: 12, slot: 'busy', after: { failed: true, failure: SETUP_CHANGED } }),
    effects: [ans('a', failed(F(answered))), { t: 'ended', run: R1 }],
  }),
  // a Stop waiter on a Ready remote run, with a hand-set world (I8.bound, I3.quiescent)
  stopWaiterWorld: (armed: Armed[]): Tr => {
    const prev = mkSt({ waiters: [Wt('stop', 's')], run: mkRun({ ...REMOTE, dropped: 1 }) });
    return {
      prev, e: { t: 'call-ended', run: R1, end: 'done' },
      next: mkSt({ waiters: [Wt('stop', 's')], run: mkRun({ ...REMOTE, dropped: 0 }) }), effects: [],
      hist: histFromState(prev, { open: [{ token: 's', kind: 'stop', run: R1, bound: 10 }], armed }),
    };
  },
};

const ctl: Control[] = [];
const C = (clause: string, good: Tr, bad: Tr) => { ctl.push({ clause, good: true, ...good }, { clause, good: false, ...bad }); };
const withM = (t: Tr, m: Partial<Machine>): Tr => ({ ...t, m });

// old-run events
C('I4.old', B.oldNotice(), mod(B.oldNotice(), (t) => { t.effects = [{ t: 'disarm', id: 3 }]; }));
C('DL.stale', B.staleDeadline(), mod(B.staleDeadline(), (t) => { t.effects = [{ t: 'disarm', id: 5 }]; }));
C('I4.orphan', B.orphanExit(), mod(B.orphanExit(), (t) => { t.next.after = { failed: false }; }));
// person actions and admission
C('I9.admit', B.ownerBusy(), mod(B.ownerBusy(), (t) => { t.effects = []; }));
C('HELD.words', B.held(), mod(B.held(), (t) => { t.effects = [ans('b', { kind: 'refused', words: 'It is starting.' })]; }));
C('PERSON.unchanged', B.ownerBusy(), mod(B.ownerBusy(), (t) => { t.next.after = { failed: true, failure: WIRE_F }; }));
C('ADMIT.no-run', B.admitRemote(R1, 'test'), B.admitRemote(R2, 'test', { run: mkRun(REMOTE) }));
C('ADMIT.record', mod(B.admitLocal(), (t) => { t.e.facts.record = 'disabled'; }), mod(B.admitLocal(), (t) => { t.e.facts.record = 'disabled'; t.e.mode = 'auto'; t.next.run.mode = 'auto'; }));
C('ADMIT.fence-admit', B.admitRemote(R1), B.admitRemote(R2, 'start', { orphans: [{ run: R1, process: P1 }], after: { failed: true, failure: STOP_REFUSED } }));
C('ADMIT.owner-admit', B.admitLocal(), mod(B.admitLocal(), (t) => { t.e.facts.ownerFree = false; }));
C('ADMIT.shape', B.admitLocal(), mod(B.admitLocal(), (t) => { t.next.run.step = 'opening'; }));
C('ADMIT.fresh-id', B.admitLocal(), { ...B.admitLocal(), hist: histFromState(B.admitLocal().prev, { runs: [R1] }) });
C('ERA.new', B.admitLocal(), mod(B.admitLocal(), (t) => { t.next.run.era = 'modern'; t.effects[1].era = 'modern'; }));
C('ADMIT.busy-reply', B.busyStart(), mod(B.busyStart(), (t) => { t.effects = [ans('b', failed(WIRE_F))]; }));
C('ADMIT.record-reply', B.recordRefused(), mod(B.recordRefused(), (t) => { t.effects = [ans('b', { kind: 'ready' })]; }));
C('ADMIT.fence-reply', B.fenceStart(), mod(B.fenceStart(), (t) => { t.effects = [ans('b', { kind: 'refused', words: OWNER_WORDS })]; }));
C('ADMIT.owner-reply', B.ownerBusy(), mod(B.ownerBusy(), (t) => { t.effects = [ans('b', { kind: 'refused', words: 'Some other words.' })]; }));
C('ADMIT.must', B.admitLocal(), { prev: mkSt(), e: startEv('b'), next: mkSt(), effects: [ans('b', { kind: 'refused', words: 'No.' })] });
C('ADMIT.only', { prev: mkSt({ slot: 'busy' }), e: { t: 'slot', idle: true }, next: mkSt(), effects: [] }, {
  prev: mkSt({ slot: 'busy' }), e: { t: 'slot', idle: true },
  next: mkSt({ nextDeadline: 11, run: mkRun({ ...REMOTE, step: 'walking', purpose: 'refresh', walk: { attempt: 0, page: 1, startedAt: 0, answered: false }, deadline: { which: 'list', id: 10 } }) }),
  effects: [{ t: 'arm', id: 10, which: 'list' }],
});
// relaunch
C('I7.readmit', B.readmitOk(), mod(B.readmitOk(), (t) => { t.next.run.relaunched = false; }));
// 6b.11 (narrowed): a person's own Start or Test relaunch isn't gated by turned off. Bad: ended for turned-off
// as an automatic start's would be; ended failed; kept waiting in relaunch on a readmit that passes.
C('I7.go-on', B.readmitOffGoesOn('start'), B.readmitRefused(true, 'start'));
C('I7.go-on', B.readmitOffGoesOn('test'), mod(B.readmitRefused(true, 'test'), (t) => { t.effects = [ans('a', failed(F('The server was stopped before it finished starting.')))]; }));
C('I7.go-on', B.readmitOffGoesOn('start'), mod(B.readmitRefused(true, 'start'), (t) => { t.next.after = { failed: true, failure: F('The server was turned off.') }; t.effects = [ans('a', failed(F('The server was turned off.'))), { t: 'ended', run: R1 }]; }));
C('I7.go-on', B.readmitOk(), mod(B.readmitOk(), (t) => { t.next = JSON.parse(JSON.stringify(t.prev)); t.effects = []; }));
C('I7.grace', B.graceEnter(), mod(B.graceEnter(), (t) => { t.prev.run.walk.answered = true; }));
C('I7.relaunch', B.graceExit(), mod(B.graceEnter(), (t) => { t.next.run.step = 'relaunch'; t.next.run.deadline = { which: 'start', id: 10 }; t.next.nextDeadline = 11; t.effects = []; }));
C('I7.check', B.graceExit(), mod(B.graceExit(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'readmit-check'); }));
// 6b.9: a relaunch from walking, exit first. Bad: killed, an answer came, not the modern opening's list.
C('I7.relaunch', B.exitFirst(), mod(B.exitFirst(), (t) => { t.prev.run.killed = true; }));
C('I7.relaunch', B.exitFirst(), mod(B.exitFirst(), (t) => { t.prev.run.walk.answered = true; }));
C('I7.relaunch', B.exitFirst(), mod(B.exitFirst(), (t) => { t.prev.run.era = 'legacy'; t.prev.run.modernOpening = false; t.next.run.era = 'legacy'; t.next.run.modernOpening = false; }));
C('I7.check', B.exitFirst(), mod(B.exitFirst(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'readmit-check'); }));
C('I7.check', B.exitFirst(), mod(B.exitFirst(), (t) => {
  // an answer came: the exit ends the run (End(exit), the process exited), yet asks for the readmit facts
  t.prev.run.walk.answered = true; t.next = mkSt({ nextDeadline: 11, slot: 'busy', after: { failed: true, failure: EXIT_FAILURE } });
  t.effects.push({ t: 'ended', run: R1 }, ans('a', failed(EXIT_FAILURE)));
}));
C('END.must', B.exitFirst(), mod(B.exitFirst(), (t) => { t.prev.run.killed = true; t.next.run.killed = true; t.next.run.step = 'walking'; t.effects = t.effects.filter((f: LcEffect) => f.t !== 'readmit-check'); }));
C('END.live', B.exitFirst(), mod(B.exitFirst(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'end-live'); }));
C('I5.relaunch', B.exitFirst(), mod(B.exitFirst(), (t) => { t.next.run.deadline = undefined; }));
C('I7.same', B.lateListInRelaunch(), mod(B.lateListInRelaunch(), (t) => { t.next = JSON.parse(JSON.stringify(t.prev)); t.next.run.graceFailure = NO_ANSWER_F; }));
C('ERA.recovery', B.recoveryOtherEra(), mod(B.recoveryOtherEra(), (t) => {
  t.next = mkSt({ nextDeadline: 11, slot: 'busy', run: mkRun({ ...REMOTE, era: 'modern', step: 'initialized', purpose: 'recovery', want: { kind: 'initialized' }, dropped: 1, deadline: { which: 'recovery', id: 10 } }) });
  t.effects = [];
}));
// endings
C('END.unlisted', B.noticeIdle(), { prev: mkSt({ run: mkRun(REMOTE) }), e: { t: 'notice', run: R1 }, next: mkSt({ after: { failed: true, failure: WIRE_F } }), effects: [{ t: 'end-live', run: R1 }, { t: 'ended', run: R1 }] });
C('G18.call', B.callDone(), mod(B.callDone(), (t) => { t.next = mkSt({ slot: 'busy', after: { failed: true, failure: WIRE_F } }); t.effects = [{ t: 'end-live', run: R1 }, { t: 'ended', run: R1 }]; }));
C('END.must', B.writeBound(), mod(B.writeBound(), (t) => { t.next = t.prev; t.effects = []; }));
C('END.cause', B.writeBound(), mod(B.writeBound(), (t) => { t.next.run.cause = 'person-stop'; }));
C('END.cause-kept', B.closingStartedOk(), mod(B.closingStartedOk(), (t) => { t.next.run.cause = 'deadline'; }));
C('END.live', B.graceExit(), mod(B.graceExit(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'end-live'); }));
// 6b.12: the ending transition ends an exchange live in the world, even one taken after closing began
C('END.live', B.closingLiveExit(true), B.closingLiveExit(false));
C('END.live', B.writeBoundExchange(true), B.writeBoundExchange(false));
C('I9.start-at-once', B.launchingStop(), mod(B.launchingStop(), (t) => { t.effects = [t.effects[0]]; t.next.waiters = [A, Wt('stop', 's')]; }));
C('I9.test-at-once', B.testStop(), mod(B.testStop(), (t) => { t.effects.pop(); t.next.waiters = [Wt('test', 't'), Wt('stop', 's')]; }));
C('TEST.stop-cleanup', B.testCleanupStop(), mod(B.testCleanupStop(), (t) => { t.effects = []; t.next.waiters = [Wt('test', 't'), Wt('stop', 's')]; }));
C('SAVED.late', B.lateSaved(), mod(B.lateSaved(), (t) => { t.next.after = { failed: true, failure: OTHER }; }));
// Pass 5f: the late save may issue the next run's queued save, with its `written`; never touch its marks
C('SAVED.late', B.lateSavedIssues(), B.lateSavedIssues('retried'));
C('SAVED.late', B.lateSavedIssues(), B.lateSavedIssues('unsaved'));
C('SAVED.late', B.lateSavedIssues(), B.lateSavedIssues('stray'));
// 5h: firstGen may change only with the run's first write issued now; a run whose first write already landed keeps it
C('SAVED.late', B.lateSavedIssues(), mod(B.lateSavedIssues(), (t) => {
  t.prev.waiters = []; t.next.waiters = []; t.prev.run.firstSave = 'done'; t.prev.run.firstGen = 1; t.prev.run.saveBy = undefined;
  t.next.run.firstSave = 'done'; t.next.run.saveBy = undefined;
  t.hist = histFromState(t.prev, { runs: [R1, R2], firstSave: [{ run: R1, gen: 1 }], kept: [{ run: R1, cause: 'deadline', words: START_TIMEOUT.words }],
    writes: [{ run: R1, gen: 1, count: 1 }], lastSave: 1, lastPublish: 2, runPublish: [{ run: R1, last: 1 }, { run: R2, last: 2 }], askedFor: { run: R2, gen: 2 } });
}));
// Pass 5g: a queued re-save belongs to the run that queued it; the late landing writes only the current run's own ask
C('SAVE.own-queue', B.lateSavedIssues(), B.lateSavedLeftover());
C('ORPH.words', B.fenceStart(), mod(B.fenceStart(), (t) => { t.effects = [ans('b', failed(STOP_UNCONFIRMED))]; }));
C('SLOT.world-idle', B.startedOk(), { ...B.startedOk(), hist: histFromState(B.startedOk().prev, { slot: 'busy' }) });
C('END.live-once', B.callDone(), mod(B.callDone(), (t) => { t.effects = [{ t: 'end-live', run: R1 }]; }));
// 6b.12 allows a second end-live only for an exchange live since the first
C('END.live-once', B.exitClosing(), mod(B.exitClosing(), (t) => { t.effects.push({ t: 'end-live', run: R1 }); }));
C('END.report', B.eraRefusal(), mod(B.eraRefusal(), (t) => { t.effects = [{ t: 'end-live', run: R1 }]; }));
C('END.release', B.exitClosing(), mod(B.exitClosing(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'release-writes'); }));
C('PHASE.after', B.exitClosing(), mod(B.exitClosing(), (t) => { t.next.after = { failed: true, failure: WIRE_F }; }));
C('PHASE.after', B.readmitRefused(true), mod(B.readmitRefused(true), (t) => { t.next.after = { failed: true, failure: F('The server was turned off.') }; }));
C('PHASE.after', B.readmitRefused(false), mod(B.readmitRefused(false), (t) => { t.next.after = { failed: false }; }));
C('I3.kept', B.readmitRefused(true), mod(B.readmitRefused(true), (t) => { t.effects = [ans('a', failed(F('The server was turned off.')))]; }));
C('END.report', B.readmitRefused(true), mod(B.readmitRefused(true), (t) => { t.effects.push({ t: 'ended', run: R1 }); }));
C('PHASE.after-words', B.eraRefusal(), mod(B.eraRefusal(), (t) => { t.next.after.failure = OTHER; }));
// 6b.13: a later catalog write that fails
const NOTE = { noteOf: () => UNSAVED_NOTE };
C('SAVE.retry', B.laterSaveFail(0, 'retry'), B.laterSaveFail(0, 'drop'));
C('SAVE.retry', withM(B.laterSaveFail(1, 'drop'), NOTE), withM(B.laterSaveFail(1, 'retry'), NOTE));
C('SAVE.unsaved', withM(B.laterSaveFail(1, 'drop'), NOTE), B.laterSaveFail(1, 'drop'));
C('SAVE.unsaved', withM(B.laterSaveFail(1, 'drop'), NOTE), withM(B.laterSaveFail(1, 'drop'), { noteOf: () => "Familiar couldn't save this server's latest tool list." }));
C('SAVE.goes-on', B.laterSaveFail(0, 'retry'), B.laterSaveFail(0, 'end'));
C('SAVE.goes-on', withM(B.laterSaveFail(1, 'drop'), NOTE), withM(B.laterSaveFail(1, 'end'), NOTE));
// the note never shows with nothing marked: just after a first failure (retry due), or on a plain first save
C('SAVE.note-none', B.laterSaveFail(0, 'retry'), withM(B.laterSaveFail(0, 'retry'), NOTE));
C('SAVE.note-none', B.savedReady(), withM(B.savedReady(), NOTE));
// ...and is gone once a newer generation (published after the mark) has saved
C('SAVE.note-cleared', B.newerSaved(), withM(B.newerSaved(), NOTE));
// build9's trace 2: a failure after a newer publication retries nothing; retrying the older generation is I11.newest's
C('I11.newest', B.supersededFail(false), B.supersededFail(true));
// a newer generation's save asked for while the failed write was in flight comes in the failure's own transition
C('SAVE.turn', B.askedTurn(true), B.askedTurn(false));
// closing issues no new save (no retry): the write in flight just settles
C('SAVE.closing', withM(B.closingSecondFail(), NOTE), withM(mod(B.closingSecondFail(), (t) => { t.effects = [{ t: 'save', run: R1, gen: 2 }]; t.next.saving = { run: R1, gen: 2 }; }), NOTE));
// each generation is written once, plus its one retry: a settle writes nothing for a generation already written
C('SAVE.once', B.settleAfterRetry(false), B.settleAfterRetry(true));
// build9's trace 1: a second failure while closing still marks the generation unsaved
C('SAVE.unsaved', withM(B.closingSecondFail(), NOTE), B.closingSecondFail());
// failureOf never carries it
C('P.failure-note', withM(B.laterSaveFail(1, 'drop'), NOTE), withM(B.laterSaveFail(1, 'drop'), { ...NOTE, failureOf: () => F(UNSAVED_NOTE) }));
// a newer publication supersedes it: the retry saves the newer generation, and a second failure marks nothing
ctl.push({ clause: 'SAVE.retry', good: true, ...B.laterSaveFail(0, 'retry', true) });
ctl.push({ clause: 'SAVE.unsaved', good: true, ...B.laterSaveFail(1, 'retry', true) });
// Pass 5i (r35): a write is checked as its pair. The retry written under another run's name (the reviewer's
// mutation); a run writing an earlier run's catalog as its own.
C('SAVE.whose', B.laterSaveFail(0, 'retry'), mod(B.laterSaveFail(0, 'retry'), (t) => { t.effects = [{ t: 'save', run: R2, gen: 2 }]; t.next.saving = { run: R2, gen: 2 }; }));
C('SAVE.whose', B.foreignGen(false), B.foreignGen(true));
// ...and written only in its turn. Gen 2 fails while gen 3 is published but still settling, with no ask: writing
// gen 3 there is the reviewer's second case. The same on a landing that saved. A run that asked, met by a landing
// that saved, gets its newest written. A save at the publish, before the settle, is outside every turn.
C('SAVE.turn', B.supersededFail(false), mod(B.supersededFail(false), (t) => { t.effects = [{ t: 'save', run: R1, gen: 3 }]; t.next.saving = { run: R1, gen: 3 }; }));
C('SAVE.turn', B.saveDirty(), mod(B.saveDirty(), (t) => { delete t.prev.run.queued; t.hist = histFromState(t.prev); }));
C('SAVE.turn', B.askedTurn(true, 'saved'), B.askedTurn(false, 'saved'));
C('SAVE.turn', B.refreshPublish(false), B.refreshPublish(true));
C('I11.mirror', B.settleReady(), mod(B.settleReady(), (t) => { t.next.saving.run = R2; }));
// Pass 5i, task 2: every record refusal leaves the state the same, from Stopped and from Failed, answered refused or failed
C('PERSON.unchanged', B.recordRefusal('missing', 'start', true, 'failed'), mod(B.recordRefusal('missing', 'start', true, 'failed'), (t) => { t.next.after = { failed: true, failure: t.effects[0].reply.failure }; }));
C('PERSON.unchanged', B.recordRefusal('unreadable', 'test', false, 'refused'), mod(B.recordRefusal('unreadable', 'test', false, 'refused'), (t) => { t.next.after = { failed: true, failure: F(t.effects[0].reply.words) }; }));
C('PERSON.unchanged', B.recordRefusal('removing', 'auto', true, 'refused'), mod(B.recordRefusal('removing', 'auto', true, 'refused'), (t) => { t.next.after = { failed: false }; }));
C('PERSON.unchanged', B.recordRefusal('sse', 'test', true, 'failed'), mod(B.recordRefusal('sse', 'test', true, 'failed'), (t) => { t.next.after = { failed: true, failure: t.effects[0].reply.failure }; }));
C('PERSON.unchanged', B.recordRefusal('unlaunchable', 'start', false, 'failed'), mod(B.recordRefusal('unlaunchable', 'start', false, 'failed'), (t) => { t.next.nextRun = 3; }));
C('PERSON.unchanged', B.recordRefusal('disabled', 'auto', true, 'refused'), mod(B.recordRefusal('disabled', 'auto', true, 'refused'), (t) => { t.next.after = { failed: true, failure: F(t.effects[0].reply.words) }; }));
// Pass 5i, task 3: the setup-changed refusal is answered in its own words, not the owner's
C('I3.kept', B.readmitSetup(SETUP_CHANGED.words), B.readmitSetup(OWNER_WORDS));
// native, owner, orphans
C('I2.stop-once', B.writeBound(), { ...B.writeBound(), hist: histFromState(B.writeBound().prev, { stopIssued: [R1] }) });
C('I2.stop-target', B.writeBound(), mod(B.writeBound(), (t) => { t.effects[1].process = 'other:p'; }));
C('KILL.flag', B.writeBound(), mod(B.writeBound(), (t) => { t.next.run.killed = false; }));
C('I6.effects', B.startedOk(), mod(B.startedOk(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'owner-release'); }));
C('I6.pair', B.admitLocal(), (() => {
  const p = { ...B.admitLocal().next, owner: 'free' as const };
  return { prev: p, e: { t: 'slot', idle: false } as LcEvent, next: { ...p, owner: 'start' as const, slot: 'busy' as const }, effects: [{ t: 'owner-hold' } as LcEffect] };
})());
C('ERA.frame', B.admitLocal(), mod(B.admitLocal(), (t) => { t.effects[1].era = 'modern'; }));
C('I2.one', B.startedOk(), { ...mod(B.startedOk(), (t) => { t.next.orphans = [{ run: R0, process: P0 }]; }), hist: histFromState(B.startedOk().prev, { alive: [{ process: P0, run: R0 }] }) });
C('NAT.mirror', B.startedOk(), mod(B.startedOk(), (t) => { t.next.run.native.process = 'other:p'; }));
C('ORPH.mirror', withM(B.refusedStop(), { fenced: () => true }), withM(mod(B.refusedStop(), (t) => { t.next.orphans = []; }), { fenced: () => true }));
C('I6.owner', B.startedOk(), mod(B.startedOk(), (t) => { t.next.owner = 'start'; t.effects = t.effects.filter((f: LcEffect) => f.t !== 'owner-release'); }));
C('END.stop-owed', B.writeBound(), mod(B.writeBound(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'native-stop'); t.next.run.native.stop = 'none'; }));
// slot and admin exchanges
C('SLOT.busy', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.next.slot = 'idle'; }));
C('SLOT.idle-only', B.startedOk(), (() => { const t = mod(B.startedOk(), (x) => { x.prev.slot = 'busy'; }); return { ...t, hist: histFromState(B.startedOk().prev) }; })());
C('SLOT.mirror', B.callDone(), mod(B.callDone(), (t) => { t.next.slot = 'idle'; }));
C('SLOT.want-idle', B.modernRefusal(), mod(B.modernRefusal(), (t) => { t.prev.slot = 'idle'; t.next.slot = 'idle'; }));
C('SLOT.want-match', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.effects[1].want = { kind: 'initialize' }; }));
C('G15.fence', B.closingStartedOk(), mod(B.closingStartedOk(), (t) => { t.next.slot = 'busy'; t.effects.push({ t: 'admin', run: R1, want: { kind: 'initialize' }, era: 'legacy' }); }));
C('ERA.initialized', B.initialized(), mod(B.initialized(), (t) => { t.prev.run.era = 'modern'; t.next.run.era = 'modern'; t.effects[0].era = 'modern'; }));
C('ERA.once', B.modernRefusal(), mod(B.noticeIdle(), (t) => { t.next.run.era = 'modern'; t.effects[1].era = 'modern'; }));
C('WALK.pages', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.effects[1].want.page = 17; }));
C('WALK.attempts', B.settleRewalk(), mod(B.settleRewalk(), (t) => { t.next.run.walk.attempt = 3; }));
C('WALK.started', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.next.run.walk.startedAt = 0; }));
// deadlines
C('DL.fresh', B.stopReady(), mod(B.stopReady(), (t) => { t.effects[2].id = 5; t.next.run.deadline.id = 5; }));
C('DL.list-drained', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.prev.slot = 'busy'; t.effects = [t.effects[0]]; t.next.run.inFlight = undefined; t.next.run.want = { kind: 'list', page: 1 }; }));
C('DL.start-once', B.readmitOk(), mod(B.readmitOk(), (t) => { t.effects.push({ t: 'arm', id: 12, which: 'start' }); t.next.run.deadline = { which: 'start', id: 12 }; t.next.nextDeadline = 13; }));
C('I9.disarm', B.savedReady(), mod(B.settleReady(), (t) => { t.effects.push({ t: 'disarm', id: 10 }); }));
C('I9.fire', B.closingPendingDeadline(), mod(B.closingPendingDeadline(), (t) => { t.effects = [{ t: 'arm', id: 12, which: 'stop' }]; t.next.nextDeadline = 13; t.next.run.deadline = { which: 'stop', id: 12 }; t.next.waiters = [Wt('stop', 's')]; }));
C('I9.bounded', B.stopJoinsPending(), mod(B.stopJoinsPending(), (t) => { t.effects = []; t.next.run.deadline = undefined; t.next.nextDeadline = 11; }));
C('I8.bound', B.stopWaiterWorld([{ id: 10, which: 'stop', run: R1 }]), B.stopWaiterWorld([{ id: 10, which: 'start', run: R1 }]));
C('I3.quiescent', B.stopWaiterWorld([{ id: 10, which: 'stop', run: R1 }]), B.stopWaiterWorld([]));
C('I5.launching', B.admitLocal(), mod(B.admitLocal(), (t) => { t.next.run.deadline = undefined; }));
C('I5.opening', B.sessionRecover(), mod(B.sessionRecover(), (t) => { t.next.run.deadline.which = 'start'; }));
C('I5.initialized', B.initialized(), mod(B.initialized(), (t) => { t.next.run.deadline = undefined; }));
C('I5.walking', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.next.run.deadline = undefined; }));
C('I5.settling', B.walkLast(), mod(B.walkLast(), (t) => { t.next.run.deadline = undefined; }));
C('I5.grace', B.graceEnter(), mod(B.graceEnter(), (t) => { t.effects = []; }));
C('I5.relaunch', B.graceExit(), mod(B.graceExit(), (t) => { t.next.run.deadline = undefined; }));
C('I5.closing', B.writeBound(), mod(B.writeBound(), (t) => { t.effects = t.effects.filter((f: LcEffect) => f.t !== 'arm'); t.next.run.deadline = undefined; t.next.nextDeadline = 10; }));
// waiters and answers
C('W.mirror', B.savedReady(), mod(B.savedReady(), (t) => { t.next.waiters = [A]; }));
C('W.current', B.eraRefusal(), (() => {
  const t = mod(B.eraRefusal(), (x) => { x.prev.waiters = [Wt('stop', 's')]; x.next.waiters = [Wt('stop', 's')]; });
  return { ...t, hist: histFromState(t.prev, { open: [{ token: 's', kind: 'stop', run: R1, bound: 10 }], armed: [{ id: 10, which: 'stop', run: R1 }] }) };
})());
C('I3.once', B.savedReady(), { ...B.savedReady(), hist: histFromState(B.savedReady().prev, { answered: ['a'] }) });
C('I3.known', B.savedReady(), mod(B.savedReady(), (t) => { t.effects.push(ans('zz', { kind: 'ready' })); }));
C('I3.kind', B.testExit(), mod(B.testExit(), (t) => { t.effects[2].reply = { kind: 'stopped' }; }));
C('I3.stopped-truth', B.refusedStop(), mod(B.refusedStop(), (t) => { t.effects[1].reply = { kind: 'stopped' }; }));
C('I3.msr-truth', B.exitClosing(), mod(B.exitClosing(), (t) => { t.effects[2].reply = failed(STOP_UNCONFIRMED); }));
C('I3.msr-owed', B.testRefused(STOP_REFUSED), B.testRefused(OTHER));
C('I3.ready', B.savedReady(), mod(B.settleReady(), (t) => { t.prev = JSON.parse(JSON.stringify(t.next)); t.e = { t: 'slot', idle: false }; t.next.slot = 'busy'; t.next.waiters = []; t.effects = [ans('a', { kind: 'ready' })]; }));
C('I3.ready-owed', B.savedReady(), mod(B.savedReady(), (t) => { t.effects = []; t.next.waiters = [A]; t.next.run.saveBy = 10; }));
// 5h: the run's first write is the first issued for it, whatever generation it carries (gen 3, superseding gen 2)
C('I3.ready-owed', B.firstSuperseded(), mod(B.firstSuperseded(), (t) => { t.effects = []; t.next.waiters = [Wt('start', 'b', R2)]; t.next.run.saveBy = 11; t.next.run.firstSave = 'pending'; }));
C('I3.kept', B.relaunchStop(), mod(B.relaunchStop(), (t) => { t.effects[1].reply = failed(OTHER); }));
C('I8.kind', B.exitClosing(), mod(B.exitClosing(), (t) => { t.effects[2].reply = failed(F('Done.')); }));
C('I8.same', B.exitClosing(), { ...B.exitClosing(), hist: histFromState(B.exitClosing().prev, { stopReply: [{ run: R1, reply: canon(failed(START_UNANSWERED)) }] }) });
// Test
C('TEST.tested-run', B.testExit(), mod(B.testExit(), (t) => { t.effects[2].reply.run = 'srv#9'; }));
C('TEST.tested-ended', B.testSaved(), mod(B.testSaved(), (t) => { t.effects.push(ans('t', { kind: 'tested', run: R1 })); t.next.waiters = []; }));
C('TEST.tested-cause', mod(B.testExit(), (t) => { t.effects.push({ t: 'ended', run: R1 }); t.effects[2] = ans('t', failed(OTHER)); t.prev.run.cause = 'deadline'; t.prev.run.failure = OTHER; }),
  mod(B.testExit(), (t) => { t.effects.push({ t: 'ended', run: R1 }); t.prev.run.cause = 'deadline'; t.prev.run.failure = OTHER; }));
C('TEST.no-stop', B.testExit(), { ...B.testExit(), hist: histFromState(B.testExit().prev, { stoppedBy: [R1] }) });
C('TEST.tested-saved', B.testExit(), { ...B.testExit(), hist: histFromState(B.testExit().prev, { firstSave: [] }) });
// held
C('EXH.answer', B.exhausted(), mod(B.exhausted(), (t) => { t.effects[1].reply = failed(OTHER); }));
C('EXH.held', B.exhausted(), mod(B.exhausted(), (t) => { t.next.held = OTHER; }));
// recovery
C('REC.once', B.sessionRecover(), mod(B.sessionRecover(), (t) => { t.prev.run.dropped = 1; }));
C('REC.session', B.sessionRecover(), mod(B.sessionRecover(), (t) => { t.effects = [t.effects[1]]; }));
C('REC.reset', B.callDone(), mod(B.callDone(), (t) => { t.e = { t: 'slot', idle: true }; t.next.slot = 'idle'; }));
// publish and notices
C('PUB.fresh', B.walkLast(), mod(B.walkLast(), (t) => { t.prev.run.changes = 1; t.next.run.changes = 1; }));
C('PUB.gen', B.walkLast(), { ...B.walkLast(), hist: histFromState(B.walkLast().prev, { lastPublish: 5 }) });
C('PUB.must', B.walkLast(), mod(B.walkLast(), (t) => { t.effects = []; t.next.run.published = undefined; t.next.run.gen = 0; t.next.nextGen = 1; }));
C('PUB.mark', B.walkLast(), mod(B.walkLast(), (t) => { t.next.run.published = 1; }));
C('NOT.count', mod(B.walkLast(), (t) => { t.prev = t.next; t.e = { t: 'notice', run: R1 }; t.effects = []; t.next = { ...t.prev, run: { ...t.prev.run, changes: 1 } }; }),
  mod(B.walkLast(), (t) => { t.prev = t.next; t.e = { t: 'notice', run: R1 }; t.effects = []; }));
C('G26.notice', B.noticeIdle(), mod(B.noticeIdle(), (t) => { t.next = t.prev; t.effects = []; }));
C('NOT.only', B.callDone(), mod(B.callDone(), (t) => { t.next.run.changes = 1; t.next.run.refreshOwed = true; }));
C('I12.stranded', { prev: mkSt({ slot: 'busy', run: mkRun() }), e: { t: 'notice', run: R1 }, next: mkSt({ slot: 'busy', run: mkRun({ changes: 1, refreshOwed: true }) }), effects: [] },
  { prev: mkSt({ slot: 'busy', run: mkRun() }), e: { t: 'notice', run: R1 }, next: mkSt({ slot: 'busy', run: mkRun({ changes: 1 }) }), effects: [] });
C('I12.owed-idle', {
  prev: mkSt({ slot: 'busy', run: mkRun({ changes: 1, refreshOwed: true }) }), e: { t: 'slot', idle: true },
  next: mkSt({ nextDeadline: 11, slot: 'busy', run: mkRun({ step: 'walking', purpose: 'refresh', changes: 1, walk: { attempt: 0, page: 1, startedAt: 1, answered: false }, inFlight: { kind: 'list', page: 1 }, deadline: { which: 'list', id: 10 } }) }),
  effects: [{ t: 'arm', id: 10, which: 'list' }, { t: 'admin', run: R1, want: { kind: 'list', page: 1 }, era: 'legacy' }],
}, { prev: mkSt({ slot: 'busy', run: mkRun({ changes: 1, refreshOwed: true }) }), e: { t: 'slot', idle: true }, next: mkSt({ run: mkRun({ changes: 1, refreshOwed: true }) }), effects: [] });
C('I1.enter', B.settleReady(), mod(B.settleReady(), (t) => { t.next.run.published = undefined; }));
C('I1.at-idle', B.settleReady(), mod(B.walkLast(), (t) => {
  t.prev.slot = 'idle'; t.next = mkSt({ nextDeadline: 11, saving: { run: R1, gen: 1 }, waiters: [A], run: readyFirst() });
  t.effects.push({ t: 'save', run: R1, gen: 1 });
}));
// catalog writes
C('I11.one', B.settleReady(), { ...B.settleReady(), hist: histFromState(B.settleReady().prev, { saving: 0 }) });
C('I11.newest', B.saveDirty(), mod(B.saveDirty(), (t) => { t.effects[0].gen = 1; t.next.saving.gen = 1; }));
C('I11.mirror', B.settleReady(), mod(B.settleReady(), (t) => { t.next.saving = undefined; }));
C('I11.owed', B.saveDirty(), mod(B.saveDirty(), (t) => { t.effects = []; t.next.saving = undefined; }));
// predicates (the stub machine, with one answer bent)
C('P.phase', B.admitLocal(), withM(B.admitLocal(), { phaseOf: () => 'stopped' }));
C('I1.callable', B.admitLocal(), withM(B.admitLocal(), { callable: () => true }));
C('P.fenced', B.orphanExit(), withM(B.orphanExit(), { fenced: () => true }));
C('P.failure', B.exitClosing(), withM(B.exitClosing(), { failureOf: () => STOP_REFUSED }));
C('P.offering', B.admitLocal(), withM(B.admitLocal(), { offering: () => true }));

export const CONTROLS: readonly Control[] = ctl;
