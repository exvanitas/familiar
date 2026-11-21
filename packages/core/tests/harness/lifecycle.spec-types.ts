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

// Failure is the client-wide failure type (packages/core/src/mcp/types.ts):

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
  /** The start's own deadline, still running for its answer while its first catalog write saves (the step
      itself may meanwhile hold a refresh's list deadline). */
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
}
export interface Waiter {
  readonly kind: 'start' | 'test' | 'stop';
  readonly token: string;
  readonly run?: string;
}
export interface Orphan {
  readonly run: string;
  readonly process: string;
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
  | { readonly t: 'readmit'; readonly run: string; readonly ok: boolean; readonly words?: string; readonly off?: boolean };

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
export const LIST_TIMEOUT: Failure = { kind: 'timed-out', words: "The server's tool list didn't arrive in time." };
export const SESSION_ENDED: Failure = { kind: 'http', words: 'The server ended its session.' };
export const KEPT_CHANGING: Failure = { kind: 'protocol', words: "The server's tools kept changing while Familiar listed them." };
export const TOO_MANY_PAGES: Failure = { kind: 'protocol', words: "The server's tool list ran past 16 pages." };
export const WATCHDOG: Failure = { kind: 'protocol', words: 'The server stopped reading what Familiar sent, so it was stopped.' };
export const CATALOG_FAILED: Failure = { kind: 'failed', words: "Familiar couldn't save the server's tool list, so it was stopped. Try again." };
export const BUSY_SLOT = 'The server is still finishing its last request. Try again in a moment.';
export const MAX_PAGES = 16;
export type FailureKind =
  /** The program wasn't found (Node.js, uv or Docker may be missing). */
  | 'not-found'
  /** The person said no in the exe's dialog, or the exe stopped asking after three refusals. */
  | 'declined'
  /** The exe refused the setup: a path, argument, setting or secret it doesn't allow. */
  | 'refused'
  /** The exe or the guarded fetch was busy. */
  | 'busy'
  /** The program exited, or the remote connection closed. */
  | 'exited'
  | 'timed-out'
  /** A remote server answered with an HTTP error, or its address isn't saved or has no key. */
  | 'http'
  | 'network'
  /** It isn't an MCP server, or it broke the protocol. */
  | 'protocol'
  | 'failed';

export interface Failure {
  readonly kind: FailureKind;
  readonly words: string;
  /** The server's last output, already blanked of its secrets, bounded. */
  readonly lastOutput?: string;
}

// ---- The machine's functions: signatures only. Their bodies are deliberately withheld from you. ----
export declare function initialState(id: string): LcState;
/** The phase Settings shows, derived from the state. */
export declare function phaseOf(s: LcState): 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed' | 'held';
/** Whether a call may be handed off now (send()/handoff() read it synchronously). */
export declare function callable(s: LcState): boolean;
/** Whether the server offers its tools to the model now. */
export declare function offering(s: LcState): boolean;
/** Whether a Start is fenced by a process that may still run. */
export declare function fenced(s: LcState): boolean;
/** The failure Settings shows beside Failed or Held, if any. */
export declare function failureOf(s: LcState): Failure | undefined;
/** The note Settings shows beside a running server, if any (6b.13): today only the unsaved latest tool list. Not a failure. */
export declare function noteOf(s: LcState): string | undefined;
/** The one transition function. */
export declare function next(state: LcState, e: LcEvent): { readonly state: LcState; readonly effects: readonly LcEffect[] };
