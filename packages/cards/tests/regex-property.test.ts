// A seeded property test: random patterns from the matcher's safe subset, random short texts over a
// small alphabet, and the matcher's answer must equal JavaScript's RegExp for every pair. Patterns
// nest at most two deep and texts are at most 8 characters, so RegExp itself stays fast on them.
import { describe, expect, it } from 'vitest';
import { compileKey } from '../src/index.ts';
import { seeded } from './helpers.ts';

// The case-fold edges: K and the Kelvin sign, the sigmas, long s, dotless and dotted i, micro and mu,
// the Angstrom sign, sharp s.
const FOLD_EDGES = ['K', 'k', '\u212a', 'σ', 'ς', 'Σ', '\u017f', 's', 'S', '\u0131', '\u0130', 'i', 'I', '\u00b5', 'μ', 'Å', 'å', '\u212b', 'ß'];
const ALPHABET = ['a', 'b', 'A', 'B', '1', '_', ' ', '\n', '.', 'é', 'É', ...FOLD_EDGES];
const LITERALS = ['a', 'b', 'A', 'B', '1', '_', ' ', 'é', '\\.', '\\n', '\\x61', '\\u00e9', ...FOLD_EDGES, '\\u212a', '\\u017f'];
const CLASS_ITEMS = ['a', 'b', 'B', '1', '_', ' ', 'é', '\\d', '\\w', '\\s', '\\.', '-', ...FOLD_EDGES];
const RANGES = ['a-b', 'A-B', '0-9', 'a-z', 'A-Z', '\\u00c0-\\u00ff', 'r-t', 'J-L', 'h-j', 'ο-τ', 'Ρ-Τ', '\\u0100-\\u0200', '\\u2100-\\u2200', '\\u00b0-\\u00c0'];
const SHORTHANDS = ['.', '\\d', '\\w', '\\s', '\\D', '\\W', '\\S'];
const ANCHORS = ['^', '$', '\\b', '\\B'];

function patterns(rand: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const quantifier = (): string => {
    const r = rand();
    if (r < 0.45) return '';
    const n = Math.floor(rand() * 3), m = n + Math.floor(rand() * 3);
    // Zero-padded and long-digit bounds too: the value counts, not how it's written.
    const pad = (v: number) => (rand() < 0.3 ? '0'.repeat(1 + Math.floor(rand() * 20)) : '') + v;
    const q = pick(['*', '+', '?', `{${pad(n)}}`, `{${pad(n)},}`, `{${pad(n)},${pad(m)}}`]);
    return q + (rand() < 0.2 ? '?' : '');
  };
  const charClass = (): string => {
    const items = Array.from({ length: Math.floor(rand() * 3) + 1 }, () => (rand() < 0.3 ? pick(RANGES) : pick(CLASS_ITEMS)));
    return `[${rand() < 0.3 ? '^' : ''}${items.join('')}]`;
  };
  const atom = (depth: number): string => {
    const r = rand();
    if (r < 0.35) return pick(LITERALS) + quantifier();
    if (r < 0.5) return charClass() + quantifier();
    if (r < 0.62) return pick(SHORTHANDS) + quantifier();
    if (r < 0.72) return pick(ANCHORS); // never quantified
    if (depth >= 2) return pick(LITERALS);
    return `(${rand() < 0.5 ? '?:' : ''}${alternation(depth + 1)})${quantifier()}`;
  };
  const sequence = (depth: number) => Array.from({ length: Math.floor(rand() * 3) + 1 }, () => atom(depth)).join('');
  const alternation = (depth: number): string =>
    rand() < 0.25 ? `${sequence(depth)}|${sequence(depth)}` : sequence(depth);
  return {
    pattern: () => alternation(0),
    flags: () => pick(['', 'i', 'i', 'm', 's', 'im', 'is']),
    text: () => Array.from({ length: Math.floor(rand() * 9) }, () => pick(ALPHABET)).join('')
  };
}

describe('the matcher against RegExp, on random patterns from its subset', () => {
  it('gives the same match or no match on every pair, over thousands of seeded cases', () => {
    const rand = seeded(17);
    const gen = patterns(rand);
    const mismatches: string[] = [];
    let compared = 0, refused = 0, invalid = 0;
    for (let i = 0; i < 4_000; i++) {
      const pattern = gen.pattern(), flags = gen.flags();
      const ours = compileKey(`/${pattern}/${flags}`, true);
      let js: RegExp;
      try {
        js = new RegExp(pattern, flags);
      } catch {
        // The generator can make a pattern JavaScript refuses too (a class range out of order): so must we.
        expect(ours, pattern).toEqual({ ok: false, why: 'does-not-compile' });
        invalid++;
        continue;
      }
      if (!ours.ok) {
        // Only a size cap may refuse a pattern from the subset: its states, or its length as written.
        expect(['too-many-states', 'too-long'], pattern).toContain(ours.why);
        refused++;
        continue;
      }
      for (let k = 0; k < 6; k++) {
        const text = gen.text();
        compared++;
        if (ours.regex.test(text) !== js.test(text)) mismatches.push(`/${pattern}/${flags} on ${JSON.stringify(text)}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(20_000);
    expect(refused).toBeLessThan(40);
    expect(invalid).toBeLessThan(400);
  }, 30_000);
});
