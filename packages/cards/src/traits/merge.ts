// Which reading wins, kept as a persona's trait state. Pure: a state and an event in, a new state out.
// The traits always describe the persona's current card. What counts is the card's hash, the part of
// the cache key after the reader version.
//
// - A new card (the first import, a replacement, or an edited card: any other hash) starts over. What
//   was read of the old card goes. The rules reader runs at once, so traits exist before the model
//   answers. A model reading that succeeds replaces the rules'. A failed one leaves the rules' values.
// - The same card read again (a new READER_VERSION, or "Read her card again"): a success replaces the
//   last reading, and a failure keeps the last good reading for that card, saying the reading failed.
//   The rules reader doesn't replace a model reading of the same card.
// - A trait the person set is never replaced by any reading. "Use her card's" removes their choice,
//   and the reading shows again.
import { NEUTRAL, TRAIT_NAMES, type Chattiness, type Sociability, type TraitName, type TraitReading, type TraitSource, type TraitValues } from './types.ts';

export interface TraitState {
  /** The last reading that counts: the model's last success, else the rules', else the neutral default. */
  readonly reading: TraitReading;
  readonly readBy: 'model' | 'rules' | 'default';
  /** The cache key of the card that reading was of: `traits-v<version>:<card hash>`. */
  readonly cardKey?: string;
  /** How the last model reading went, for Settings ("the reading failed"). */
  readonly lastModelReading?: 'ok' | 'failed';
  /** The person's own choices. Each wins over any reading. */
  readonly yours: Partial<TraitValues> & { readonly interests?: readonly string[] };
  /** Chattiness, once the person picked one. Never changed by a reading. */
  readonly chattiness?: Chattiness;
}

export type ReadingEvent =
  | { readonly kind: 'rules'; readonly cardKey: string; readonly reading: TraitReading }
  | { readonly kind: 'model-ok'; readonly cardKey: string; readonly reading: TraitReading }
  | { readonly kind: 'model-failed'; readonly cardKey: string };

const EMPTY_READING: TraitReading = { ...NEUTRAL, interests: [], evidence: {} };

/** The plain helper's, and any persona's before a reading: even, warm, any, no interests. */
export const NEUTRAL_STATE: TraitState = { reading: EMPTY_READING, readBy: 'default', yours: {} };

/** The card's hash in a cache key: what's after the reader version. */
export function cardHashOf(cardKey: string): string {
  const i = cardKey.indexOf(':');
  return i < 0 ? cardKey : cardKey.slice(i + 1);
}

/**
 * For a new card, the caller applies the rules reading first, then the model's result. A model result
 * for a new card with no rules reading before it starts from neutral.
 */
export function applyReading(state: TraitState | undefined, event: ReadingEvent): TraitState {
  const before = state ?? NEUTRAL_STATE;
  const sameCard = before.cardKey !== undefined && cardHashOf(before.cardKey) === cardHashOf(event.cardKey);
  // A new card keeps only what's the person's: their choices and their chattiness.
  const s: TraitState = sameCard
    ? before
    : { reading: EMPTY_READING, readBy: 'default', cardKey: event.cardKey, yours: before.yours, ...(before.chattiness ? { chattiness: before.chattiness } : {}) };
  switch (event.kind) {
    case 'rules':
      // The rules never replace a model reading of the same card.
      if (s.readBy === 'model') return s;
      return { ...s, reading: event.reading, readBy: 'rules', cardKey: event.cardKey };
    case 'model-ok':
      return { ...s, reading: event.reading, readBy: 'model', cardKey: event.cardKey, lastModelReading: 'ok' };
    case 'model-failed':
      return { ...s, lastModelReading: 'failed' };
  }
}

/** The person sets traits, or their interests. */
export function setYours(state: TraitState, choice: TraitState['yours']): TraitState {
  const yours: Record<string, unknown> = { ...state.yours };
  for (const name of [...TRAIT_NAMES, 'interests'] as const) if (choice[name] !== undefined) yours[name] = choice[name];
  return { ...state, yours: yours as TraitState['yours'] };
}

/** The person picks a chattiness. No reading changes it after. */
export function setChattiness(state: TraitState, chattiness: Chattiness): TraitState {
  return { ...state, chattiness };
}

/** "Use her card's": the person's choice for that row goes, and the reading shows again. */
export function useCards(state: TraitState, name: TraitName | 'interests'): TraitState {
  const yours: Record<string, unknown> = {};
  for (const k of Object.keys(state.yours) as (keyof TraitState['yours'])[]) if (k !== name) yours[k] = state.yours[k];
  return { ...state, yours: yours as TraitState['yours'] };
}

export interface ShownTrait<V> {
  readonly value: V;
  readonly source: TraitSource;
  readonly quote?: string;
}

export interface ShownTraits {
  readonly sociability: ShownTrait<TraitValues['sociability']>;
  readonly closeness: ShownTrait<TraitValues['closeness']>;
  readonly lively: ShownTrait<TraitValues['lively']>;
  readonly interests: { readonly value: readonly string[]; readonly source: TraitSource };
}

/**
 * What the persona has, with where each came from: `you` for the person's choice, `card` for a model
 * reading that isn't neutral, `tags` for the rules reader's, and `default` for a neutral value.
 */
export function shownTraits(state: TraitState): ShownTraits {
  const from = (neutral: boolean): TraitSource => (neutral ? 'default' : state.readBy === 'model' ? 'card' : state.readBy === 'rules' ? 'tags' : 'default');
  const row = <T extends TraitName>(name: T): ShownTrait<TraitValues[T]> => {
    const mine = state.yours[name];
    if (mine !== undefined) return { value: mine as TraitValues[T], source: 'you' };
    const value = state.reading[name];
    const quote = state.reading.evidence[name];
    return { value, source: from(value === NEUTRAL[name]), ...(quote ? { quote } : {}) };
  };
  const interests = state.yours.interests !== undefined
    ? { value: state.yours.interests, source: 'you' as const }
    : { value: state.reading.interests, source: from(state.reading.interests.length === 0) };
  return { sociability: row('sociability'), closeness: row('closeness'), lively: row('lively'), interests };
}

/** The three values the decider gets: the person's choices, else the reading. */
export function effectiveTraits(state: TraitState): TraitValues {
  const shown = shownTraits(state);
  const out = {} as { -readonly [T in TraitName]: TraitValues[T] };
  for (const name of TRAIT_NAMES) (out as Record<string, string>)[name] = shown[name].value;
  return out;
}

const SUGGESTED: Record<Sociability, Chattiness> = { reserved: 'low', even: 'medium', outgoing: 'high' };

/** Her sociability only suggests where chattiness starts: reserved low, even medium, outgoing high. */
export function suggestChattiness(sociability: Sociability): Chattiness {
  return SUGGESTED[sociability];
}

/** The person's chattiness once they picked one, else the suggestion from her (effective) sociability. */
export function chattinessOf(state: TraitState): { readonly value: Chattiness; readonly suggested: boolean } {
  if (state.chattiness) return { value: state.chattiness, suggested: false };
  return { value: suggestChattiness(effectiveTraits(state).sociability), suggested: true };
}
