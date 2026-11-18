// The registry of turns: every turn's own state, keyed by its id, in one journal document.
//
// A turn starts with a message you send and goes on across every "go on", "Do it now?" and Run again.
// Whether a turn can still resume is read live, never from here: an open question (pi-durable's
// runFailure, journal/view.ts), a parked consent card, a queued submission (read with tx.submission), or
// a run in flight. The `open` mark below is only a hint, for display and for the 64-turn cap, and a turn
// something can still resume is never forgotten (journal.ts reads the live facts in the commit that
// would forget it). Kept here per turn:
//   - its tool-call budget (bounds.ts), so another turn can't reset it
//   - which turn each submission belongs to, written in the submission's own admission commit
// Its token extensions and spend history live in the caps ledger, keyed by the same id.

import { emptyBudget, type Budget } from './bounds.ts';
import { defineJournalDoc } from './tools.ts';

export interface TurnRecord {
  open: boolean;
  startedAt: number;
  finishedAt?: number;
  /** Its tool calls: admitted and refused, by step id. */
  budget: Budget;
}

export interface TurnRegistry {
  turns: Record<string, TurnRecord>;
  /** Which turn each submission belongs to. */
  of: Record<string, string>;
  /**
   * Submissions not yet seen settled. It can only lag the safe way: an id still listed after it settled
   * is read again with tx.submission, and dropped then.
   */
  pending?: string[];
  /** The turn of the last message you sent. */
  current: string;
}

export const TurnsDoc = defineJournalDoc<TurnRegistry>('familiar.turns', () => ({ turns: {}, of: {}, current: '' }));

/** Finished turns kept, newest first, for their answers' lookups. Open turns are always kept. */
export const KEEP_FINISHED_TURNS = 64;

/**
 * The turn a run belongs to: the turn of the first input it placed (the oldest queued item is placed
 * first), else the current turn. A run's later inputs (steers) join it and don't move it.
 */
export function turnKeyOf(live: any, registry: Partial<TurnRegistry> | undefined): string {
  return turnOfInputs(live?.run?.inputs ?? [], registry);
}

/** The turn of the first of `inputs` that belongs to one, else the current turn. */
export function turnOfInputs(inputs: readonly unknown[], registry: Partial<TurnRegistry> | undefined): string {
  return inputs.map((i) => registry?.of?.[String(i)]).find((k) => k !== undefined) ?? (registry?.current || 'turn');
}

/** Notes a submission's turn and lists it as not yet settled. In the submission's admission commit. */
export function recordSubmission(registry: TurnRegistry, sid: string, turn: string, now: number): void {
  if (registry.of[sid] === undefined) registry.of[sid] = turn;
  registry.pending ??= [];
  if (!registry.pending.includes(sid)) registry.pending.push(sid);
  openTurn(registry, turn, now);
}

/** The turn's record, made open if it has none. */
export function openTurn(registry: TurnRegistry, turn: string, now: number): TurnRecord {
  const found = registry.turns[turn];
  if (found) return found;
  const made: TurnRecord = { open: true, startedAt: now, budget: emptyBudget(turn) };
  registry.turns[turn] = made;
  return made;
}

/**
 * Marks a turn finished (a hint), and forgets the oldest finished turns past KEEP_FINISHED_TURNS, never
 * one in `live`: the turns something can still resume, read live in the same commit.
 */
export function finishTurn(registry: TurnRegistry, turn: string, now: number, live: ReadonlySet<string> = new Set()): void {
  const record = registry.turns[turn];
  if (!record || !record.open) return;
  registry.turns[turn] = { ...record, open: false, finishedAt: now };
  const finished = Object.entries(registry.turns)
    .filter(([t, r]) => !r.open && !live.has(t))
    .sort((a, b) => (b[1].finishedAt ?? 0) - (a[1].finishedAt ?? 0));
  for (const [gone] of finished.slice(KEEP_FINISHED_TURNS)) {
    delete registry.turns[gone];
    for (const [sid, t] of Object.entries(registry.of)) if (t === gone) delete registry.of[sid];
  }
}

/** The turns not marked finished: the fallback when no live read is given (a ledger outside a journal). */
export function resumableTurns(registry: Partial<TurnRegistry> | undefined): string[] {
  return Object.entries(registry?.turns ?? {})
    .filter(([, r]) => r.open)
    .map(([t]) => t);
}
