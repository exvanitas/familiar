// The registry of turns: every turn's own state, keyed by its id, in one journal document.
//
// A turn starts with a message you send and goes on across every "go on", "Do it now?" and Run again.
// It stays open while anything durable can resume it: an open question, a parked consent card, a queued
// message, or calls in flight. It's finished only explicitly, when its run ends with nothing left to
// resume it, or when you say no to going on. Until then nothing of it is dropped or folded:
//   - its tool-call budget (bounds.ts) lives here, per turn, so another turn can't reset it
//   - its token extensions and spend history live in the caps ledger, keyed by the same id, and the
//     ledger reads this registry in the same commit to know which turns to keep whole (ledger.ts)
//   - its open questions carry its id (journal.ts)

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
  /** The turn of the last message you sent. */
  current: string;
}

export const TurnsDoc = defineJournalDoc<TurnRegistry>('familiar.turns', () => ({ turns: {}, of: {}, current: '' }));

/** Finished turns kept, newest first, for their answers' lookups. Open turns are always kept. */
export const KEEP_FINISHED_TURNS = 64;

/** The turn a run belongs to: the newest of its inputs that belongs to one, else the current turn. */
export function turnKeyOf(live: any, registry: Partial<TurnRegistry> | undefined): string {
  const inputs: string[] = (live?.run?.inputs ?? []).map(String);
  return [...inputs].reverse().map((i) => registry?.of?.[i]).find((k) => k !== undefined) ?? (registry?.current || 'turn');
}

/** The turn's record, made open if it has none. */
export function openTurn(registry: TurnRegistry, turn: string, now: number): TurnRecord {
  const found = registry.turns[turn];
  if (found) return found;
  const made: TurnRecord = { open: true, startedAt: now, budget: emptyBudget(turn) };
  registry.turns[turn] = made;
  return made;
}

/** Marks a turn finished, and forgets the oldest finished turns past KEEP_FINISHED_TURNS. */
export function finishTurn(registry: TurnRegistry, turn: string, now: number): void {
  const record = registry.turns[turn];
  if (!record || !record.open) return;
  registry.turns[turn] = { ...record, open: false, finishedAt: now };
  const finished = Object.entries(registry.turns)
    .filter(([, r]) => !r.open)
    .sort((a, b) => (b[1].finishedAt ?? 0) - (a[1].finishedAt ?? 0));
  for (const [gone] of finished.slice(KEEP_FINISHED_TURNS)) {
    delete registry.turns[gone];
    for (const [sid, t] of Object.entries(registry.of)) if (t === gone) delete registry.of[sid];
  }
}

/** The turns something durable can still resume. */
export function resumableTurns(registry: Partial<TurnRegistry> | undefined): string[] {
  return Object.entries(registry?.turns ?? {})
    .filter(([, r]) => r.open)
    .map(([t]) => t);
}
