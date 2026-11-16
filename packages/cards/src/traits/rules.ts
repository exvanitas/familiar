// The rules reader: no model, only what a card states in structure. Archetype tags, W++ and PList
// words from a short list (reader-text.json, "rules"), and `extensions.talkativeness`. Two signals
// that disagree mean neutral.
import { isObject, own } from '../fields.ts';
import type { Card } from '../types.ts';
import TEXT from './reader-text.json' with { type: 'json' };
import { NEUTRAL, type Closeness, type Lively, type Sociability, type TraitReading } from './types.ts';

export const TALKATIVE_BELOW = 0.35;
export const TALKATIVE_ABOVE = 0.65;

const RULES: ReadonlyArray<readonly [word: string, trait: 'sociability' | 'closeness' | 'lively', value: string]> = [
  ...TEXT.rules.reserved.map((w) => [w, 'sociability', 'reserved'] as const),
  ...TEXT.rules.outgoing.map((w) => [w, 'sociability', 'outgoing'] as const),
  ...TEXT.rules.aloof.map((w) => [w, 'closeness', 'aloof'] as const),
  ...TEXT.rules.clingy.map((w) => [w, 'closeness', 'clingy'] as const),
  ...TEXT.rules.night.map((w) => [w, 'lively', 'night'] as const),
  ...TEXT.rules.morning.map((w) => [w, 'lively', 'morning'] as const)
];

const norm = (t: string) => t.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** W++ values: every quoted string inside `Name(...)`. Linear: each `(` is looked at once, a bounded way. */
export function wppWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<=[\p{L}\p{N}_])\(([^()]{0,4000})\)/gu)) {
    for (const q of m[1]!.matchAll(/"([^"]{1,64})"/g)) out.push(norm(q[1]!));
  }
  return out;
}

/** PList values: in `[...]`, each `;` part's list after its first colon, split on commas. */
export function plistWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^[\]]{1,4000})\]/g)) {
    for (const segment of m[1]!.split(';')) {
      const colon = segment.indexOf(':');
      if (colon < 0) continue;
      for (const item of segment.slice(colon + 1).split(',')) {
        const w = norm(item);
        if (w && w.length <= 64) out.push(w);
      }
    }
  }
  return out;
}

export function readByRules(card: Card): TraitReading {
  const words = new Set<string>([
    ...card.tags.map(norm),
    ...[card.description, card.personality].flatMap((t) => [...wppWords(t), ...plistWords(t)])
  ]);
  const votes = { sociability: new Set<string>(), closeness: new Set<string>(), lively: new Set<string>() };
  for (const [word, trait, value] of RULES) if (words.has(word)) votes[trait].add(value);
  const talk = isObject(card.extensions) ? own(card.extensions, 'talkativeness') : undefined;
  const t = typeof talk === 'number' ? talk : typeof talk === 'string' && talk.trim() !== '' ? Number(talk) : NaN;
  if (Number.isFinite(t) && t < TALKATIVE_BELOW) votes.sociability.add('reserved');
  if (Number.isFinite(t) && t > TALKATIVE_ABOVE) votes.sociability.add('outgoing');
  const one = <V extends string>(set: Set<string>, neutral: V): V => (set.size === 1 ? ([...set][0] as V) : neutral);
  return {
    sociability: one<Sociability>(votes.sociability, NEUTRAL.sociability),
    closeness: one<Closeness>(votes.closeness, NEUTRAL.closeness),
    lively: one<Lively>(votes.lively, NEUTRAL.lively),
    interests: [],
    evidence: {}
  };
}
