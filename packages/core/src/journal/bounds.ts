// Bounds on tool calls. Consent alone doesn't bound a reply: with a tool always allowed, one reply could
// call it any number of times. So at most TOOL_CALLS_PER_REPLY calls of one model reply run, and at most
// TOOL_CALLS_PER_TURN calls in one turn, whatever the step cap's "go on" says. A call past either bound
// is never run: the model gets a tool error with the reason, and the person a line in chat.
//
// The count lives in the journal, in one document changed in one commit per call, so a restart, a
// resume, a "go on" or a "Do it now?" can't reset it. Only a message you send starts a new turn.

/** Tool calls that may run from one model reply. */
export const TOOL_CALLS_PER_REPLY = 8;
/** Tool calls that may run in one turn, across every reply and every "go on". */
export const TOOL_CALLS_PER_TURN = 32;

export type Bound = 'reply' | 'turn';

export interface Budget {
  /** The turn this budget counts: the submission of the message that started it. */
  turn: string;
  /** Calls let through in this turn, by step id. */
  admitted: string[];
  /** Calls refused in this turn, by step id, and which bound refused them. */
  refused: Record<string, Bound>;
}

export function emptyBudget(turn = ''): Budget {
  return { turn, admitted: [], refused: {} };
}

/** Plain words for a refusal: the model's tool error, and the line in chat. */
export function boundWords(bound: Bound): string {
  return bound === 'reply'
    ? `Familiar stopped after ${TOOL_CALLS_PER_REPLY} tool calls in one reply.`
    : `Familiar stopped after ${TOOL_CALLS_PER_TURN} tool calls in this turn.`;
}

/**
 * Whether a call may run. `index` is its place among its reply's calls, from 0. A call already admitted
 * stays admitted (it's asked again after a restart); a call once refused stays refused. Changes `budget`.
 */
export function admit(budget: Budget, step: string, index: number): { ok: true } | { ok: false; bound: Bound } {
  if (budget.admitted.includes(step)) return { ok: true };
  const refused = budget.refused[step];
  if (refused) return { ok: false, bound: refused };
  const bound: Bound | undefined = index >= TOOL_CALLS_PER_REPLY ? 'reply' : budget.admitted.length >= TOOL_CALLS_PER_TURN ? 'turn' : undefined;
  if (bound) {
    budget.refused[step] = bound;
    return { ok: false, bound };
  }
  budget.admitted.push(step);
  return { ok: true };
}
