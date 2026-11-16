// Her traits, as docs/persona-traits.md defines them. Each has three values; the middle one is neutral.

export const SOCIABILITY = ['reserved', 'even', 'outgoing'] as const;
export const CLOSENESS = ['aloof', 'warm', 'clingy'] as const;
export const LIVELY = ['morning', 'any', 'night'] as const;

export type Sociability = (typeof SOCIABILITY)[number];
export type Closeness = (typeof CLOSENESS)[number];
export type Lively = (typeof LIVELY)[number];
export type TraitName = 'sociability' | 'closeness' | 'lively';
export const TRAIT_NAMES: readonly TraitName[] = ['sociability', 'closeness', 'lively'];

export interface TraitValues {
  readonly sociability: Sociability;
  readonly closeness: Closeness;
  readonly lively: Lively;
}

export const NEUTRAL: TraitValues = { sociability: 'even', closeness: 'warm', lively: 'any' };

export const VALUES: { readonly [T in TraitName]: readonly string[] } = { sociability: SOCIABILITY, closeness: CLOSENESS, lively: LIVELY };

/** One reading of a card, by the model or the rules, after the checks. */
export interface TraitReading extends TraitValues {
  /** At most 5, each lowercase, at most 32 characters. */
  readonly interests: readonly string[];
  /** For each trait that isn't neutral, the card's own words, when the reader gave some that check out. */
  readonly evidence: { readonly [T in TraitName]?: string };
}

/** Where a trait's value came from, as Settings shows it. */
export type TraitSource = 'card' | 'tags' | 'default' | 'you';

export type Chattiness = 'low' | 'medium' | 'high';
