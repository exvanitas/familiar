// The strict check on what the reader's model answered. Anything off makes that trait neutral; an
// answer that isn't an object at all is a failed reading.
import { isObject, own } from '../fields.ts';
import { NEUTRAL, TRAIT_NAMES, VALUES, type TraitName, type TraitReading, type TraitValues } from './types.ts';

export const MAX_INTERESTS = 5;
export const MAX_INTEREST_CHARS = 32;
export const MAX_QUOTE_CHARS = 120;

const FIELDS = new Set(['sociability', 'closeness', 'lively', 'interests', 'evidence']);
const INTEREST = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;

const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * `raw` is the tool call's arguments (or the one JSON object in the text). `quotable` is the card text
 * that was sent, field by field: a quote is kept only if it's found inside one field, whitespace
 * collapsed in both, never across two fields and never in a label.
 * - A trait whose value is missing, not a string, `unsure` or not one of its three is neutral.
 * - A field the schema doesn't have makes all three neutral and drops the interests: the answer
 *   wasn't to the question asked.
 * - Interests: strings only, trimmed and lowercased, inner spaces collapsed, letters, digits, spaces
 *   and hyphens, at most 32 characters (longer ones are dropped, not cut), no repeats, the first 5.
 * - Evidence: only for traits that aren't neutral, strings of at most 120 characters after collapsing,
 *   found inside one field of `quotable`.
 * Returns undefined when `raw` isn't a plain object: a failed reading.
 */
export function checkAnswer(raw: unknown, quotable: readonly string[]): TraitReading | undefined {
  if (!isObject(raw)) return undefined;
  const extra = Object.keys(raw).some((k) => !FIELDS.has(k));
  const pick = <T extends TraitName>(name: T): TraitValues[T] => {
    const v = own(raw, name);
    if (extra || typeof v !== 'string' || !VALUES[name].includes(v)) return NEUTRAL[name];
    return v as TraitValues[T];
  };
  const values = { sociability: pick('sociability'), closeness: pick('closeness'), lively: pick('lively') };
  const interests = extra ? [] : checkInterests(own(raw, 'interests'));
  const evidence: { [T in TraitName]?: string } = {};
  const given = own(raw, 'evidence');
  if (isObject(given)) {
    const fields = quotable.map(collapse);
    for (const name of TRAIT_NAMES) {
      if (values[name] === NEUTRAL[name]) continue;
      const q = own(given, name);
      if (typeof q !== 'string') continue;
      const quote = collapse(q);
      if (quote && quote.length <= MAX_QUOTE_CHARS && fields.some((f) => f.includes(quote))) evidence[name] = quote;
    }
  }
  return { ...values, interests, evidence };
}

function checkInterests(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const clean = collapse(item).toLowerCase();
    if (!clean || clean.length > MAX_INTEREST_CHARS || !INTEREST.test(clean) || out.includes(clean)) continue;
    out.push(clean);
    if (out.length === MAX_INTERESTS) break;
  }
  return out;
}
