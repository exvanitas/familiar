// The regex matcher: it agrees with JavaScript on ordinary keys, refuses what's outside its subset by
// reason alone, and never takes more than states x characters, checked under a watchdog.
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  compileKey, MAX_BOOK_REGEX_KEYS, MAX_BOOK_REGEX_STATES, MAX_REGEX_REPEAT, MAX_REGEX_STATES, MAX_SCAN_CHARS, matchLore, prepareLorebook, type LoreEntry
} from '../src/index.ts';

const ours = (pattern: string, flags: string, text: string) => {
  const c = compileKey(`/${pattern}/${flags}`, true);
  if (!c.ok) throw new Error(`refused: ${c.why}`);
  return c.regex.test(text);
};

// Patterns of the kind lore keys use, and texts around them. Each must give what JavaScript gives.
const AGREE: readonly [pattern: string, flags: string][] = [
  ['fox', ''], ['fox', 'i'], ['\\bfox(es)?\\b', 'i'], ['^moon', ''], ['moon$', ''], ['^moon$', 'm'], ['(cat|dog)s?', ''], ['colou?r', ''],
  ['gr[ae]y', 'i'], ['[^a-z ]', ''], ['\\d{3}-\\d{4}', ''], ['\\w+%\\w+\\.com', ''], ['a.c', ''], ['a.c', 's'], ['\\s{2,}', ''], ['x{2}', ''],
  ['x{2,3}y', ''], ['(?:mira|tam)\\b', 'i'], ['\\Bend', ''], ['[\\d\\s]+', ''], ['[a\\-z]', ''], ['\\x41', ''], ['\\u00e9t\\u00e9', ''],
  ['caf[eé]', 'i'], ['\\.\\*', ''], ['^$', ''], ['', ''], ['[]', ''], ['[^]', ''], ['a{', ''], ['(a|b|c)*d', ''], ['\\W', ''], ['\\S\\D', ''],
  ['(a+)+$', ''], ['((a|aa))+$', ''], ['ÉTÉ', 'i'], ['[A-Z]{2,}', ''], ['ab*?c', ''], ['\\[note\\]', ''], ['\\t', ''], ['(?:)', '']
];
const TEXTS = [
  '', 'a', 'fox', 'Foxes ran', 'the firefox', 'moon', 'honeymoon', 'a\nmoon\nb', 'cats and dogs', 'color', 'colour', 'GREY', 'gray',
  'lower only', 'Upper!', '555-1234', 'me%home.com', 'abc', 'a\nc', 'two  spaces', 'xxy', 'xxxy', 'Tam waved', 'mira', 'the end', 'bend',
  '1 2', '-', 'A', 'été', 'Café', 'a.*b', 'aaaa', 'aaaa!', '[note]', 'tab\there', 'abbbc', 'ÉTÉ'
];

describe('agrees with JavaScript on ordinary keys', () => {
  for (const [pattern, flags] of AGREE) {
    it(`/${pattern}/${flags}`, () => {
      const js = new RegExp(pattern, flags);
      for (const text of TEXTS) expect(ours(pattern, flags, text), JSON.stringify(text)).toBe(js.test(text));
    });
  }
});

describe('case folding under i is ECMAScript\'s, without u', () => {
  const EDGE = ['k', 'K', '\u212a', 's', 'S', '\u017f', 'σ', 'ς', 'Σ', 'i', 'I', '\u0131', '\u0130', '\u00b5', 'μ', 'Μ', 'å', 'Å', '\u212b', 'ß', 'ẞ', 'ǅ', 'ǆ', 'Ǆ'];
  const PATTERNS = [
    'k', 'K', '\u212a', 's', '\u017f', 'σ', 'ς', 'Σ', 'i', '\u0131', '\u0130', '\u00b5', 'μ', 'å', '\u212b', 'ß', 'ǅ',
    '[k]', '[a-z]', '[^k]', '[^a-z]', '[α-ω]', '[^σ]', '[r-t]', '[\u0100-\u0200]', '[\u2100-\u2200]', '\w', '\W', '[\w]', '[^\w]', '.'
  ];
  it.each(PATTERNS)('/%s/i agrees with RegExp on every edge character', (pattern) => {
    const js = new RegExp(pattern, 'i');
    for (const ch of EDGE) expect(ours(pattern, 'i', ch), `${pattern} on ${ch}`).toBe(js.test(ch));
  });

  it('the two the review found: /k/i misses the Kelvin sign, /σ/i finds final sigma', () => {
    expect(ours('k', 'i', '\u212a')).toBe(false);
    expect(ours('σ', 'i', 'ς')).toBe(true);
  });
});

describe('quantifiers are read whole', () => {
  it('leading zeros are fine: the value counts, however long the digits', () => {
    expect(ours('^a{000000000000001}$', '', 'a')).toBe(true);
    expect(ours('^a{000000000000001}$', '', 'a{000000000000001}')).toBe(false);
    expect(ours('^a{0002,00000003}$', '', 'aaa')).toBe(new RegExp('^a{0002,00000003}$').test('aaa'));
    expect(compileKey(`/a{${'0'.repeat(20)}${MAX_REGEX_REPEAT + 1}}/`, true)).toEqual({ ok: false, why: 'bound-too-large' });
    expect(compileKey(`/a{1,${'0'.repeat(20)}${MAX_REGEX_REPEAT + 1}}/`, true)).toEqual({ ok: false, why: 'bound-too-large' });
    expect(compileKey('/a{99999999999999999999999}/', true)).toEqual({ ok: false, why: 'bound-too-large' });
  });

  it('a second quantifier is refused however long its digits, as RegExp refuses it', () => {
    expect(() => new RegExp('a{1}{000000000000002}')).toThrow();
    expect(compileKey('/a{1}{000000000000002}/', true)).toEqual({ ok: false, why: 'does-not-compile' });
  });
});

describe('refused, by reason alone', () => {
  it.each([
    ['(\\w+)\\s\\1', 'backreference'],
    ['(?<n>a)\\k<n>', 'named-group'],
    ['\\k<n>', 'backreference'],
    ['a(?=b)', 'lookaround'],
    ['a(?!b)', 'lookaround'],
    ['(?<=a)b', 'lookaround'],
    ['(?<!a)b', 'lookaround'],
    ['\\p{L}', 'unicode-property'],
    ['\\cA', 'unsupported-escape'],
    ['\\xZZ', 'unsupported-escape'],
    [`a{${MAX_REGEX_REPEAT + 1}}`, 'bound-too-large'],
    [`a{1,${MAX_REGEX_REPEAT + 1}}`, 'bound-too-large'],
    ['(((a{9}){9}){9})', 'too-many-states'],
    ['[unclosed', 'does-not-compile'],
    ['(open', 'does-not-compile'],
    ['close)', 'does-not-compile'],
    ['*a', 'does-not-compile'],
    ['a**', 'does-not-compile'],
    ['^*', 'does-not-compile'],
    ['[z-a]', 'does-not-compile'],
    ['a{3,2}', 'does-not-compile']
  ])('/%s/ is refused as %s', (pattern, why) => {
    expect(compileKey(`/${pattern}/`, false)).toEqual({ ok: false, why });
  });

  it('flags: i, m and s are kept, g and y dropped, others refused', () => {
    expect(compileKey('/Owl/gy', true).ok).toBe(true);
    expect(compileKey('/owl/u', true)).toEqual({ ok: false, why: 'bad-flags' });
    expect(compileKey('/owl/d', true)).toEqual({ ok: false, why: 'bad-flags' });
    const k = compileKey('/OWL/', false);
    expect(k.ok && k.regex.test('an owl')).toBe(true);
    const s = compileKey('/OWL/', true);
    expect(s.ok && s.regex.test('an owl')).toBe(false);
  });

  it('a pattern too complex for one key is refused: MAX_REGEX_STATES', () => {
    // A bounded repeat is expanded: (a{100}){5} is 500 character states, (a{100}){6} is 600.
    const fits = compileKey('/(a{100}){5}/', true);
    expect(fits.ok && fits.regex.states).toBeLessThanOrEqual(MAX_REGEX_STATES);
    expect(compileKey('/(a{100}){6}/', true)).toEqual({ ok: false, why: 'too-many-states' });
  });
});

/** Runs the cases in a worker and stops it after `ms`, so a hang fails the test instead of the run. */
function watched(cases: { key: string; text: string }[], ms: number): Promise<{ key: string; ok: boolean; matched: boolean | null; ms: number }[]> {
  return new Promise((done, fail) => {
    const worker = new Worker(new URL('./regex-worker.ts', import.meta.url), { workerData: cases });
    const timer = setTimeout(() => {
      void worker.terminate();
      fail(new Error(`the matcher ran past the ${ms} ms watchdog`));
    }, ms);
    worker.once('message', (m) => {
      clearTimeout(timer);
      void worker.terminate();
      done(m);
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
  });
}

describe('never backtracks', () => {
  const a = (n: number, tail = '!') => 'a'.repeat(n) + tail;
  // The classic ReDoS shapes, and the three that got past the old shape check, on texts that make a
  // backtracking engine take exponential time. Each runs on the full scan length.
  const REDOS = [
    '^((a|aa))+$', '[]|(a+)+$', '(a+)+$', '(a*)*$', '(a|a)*$', '(a|aa)+$', '(.*a){12}$', '(a+){10}y', '^(a|a?)+$', '(\\w+\\s?)+$',
    '^(([a-z])+.)+[A-Z]([a-z])+$', '(x+x+)+y', 'a*a*a*a*a*a*a*b', '(a?){30}a{30}', '^(a+)+b', '(ab|a)*c', '^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|([a-z]{2,3}[.]{1}[a-z]{2,3}))$'
  ];

  it('the ReDoS list, each on a long hostile text, finishes under the watchdog', async () => {
    const cases = REDOS.map((p) => ({ key: `/${p}/`, text: a(MAX_SCAN_CHARS - 1) }));
    const results = await watched(cases, 20_000);
    for (const r of results) {
      expect(r.ok, r.key).toBe(true);
      expect(r.ms, r.key).toBeLessThan(1_000);
    }
    // And they still give the right answer, as JavaScript does on a short text.
    for (const p of REDOS) expect(ours(p, '', a(12)), p).toBe(new RegExp(p).test(a(12)));
  });

  it('a whole book at its regex budget scans the longest text in a fraction of a second', async () => {
    // Every key at its state cap, up to the book's state budget: the worst a card can ask for.
    const key = `/(?:${'[a-z]'.repeat(20)}){${Math.floor(MAX_REGEX_STATES / 21)}}!/`;
    const per = compileKey(key, false);
    expect(per.ok).toBe(true);
    if (!per.ok) return;
    const count = Math.min(MAX_BOOK_REGEX_KEYS, Math.floor(MAX_BOOK_REGEX_STATES / per.regex.states));
    const entry = (i: number): LoreEntry => ({
      keys: [key], secondary_keys: [], content: `e${i}`, enabled: true, insertion_order: i, priority: 0, case_sensitive: false, selective: false,
      constant: false, use_regex: true, position: 'before_char', name: '', comment: '', extensions: {}
    });
    const book = prepareLorebook({ name: '', description: '', recursive_scanning: false, extensions: {}, entries: Array.from({ length: count + 1 }, (_, i) => entry(i)) });
    expect(book.entries).toHaveLength(count);
    expect(book.warnings.map((w) => w.message)).toEqual([`Lore entry ${count + 1} was skipped: a regex key would take the book past its regex budget.`]);
    const started = performance.now();
    matchLore(book, [{ content: 'abcdefghij'.repeat(MAX_SCAN_CHARS / 10) }]);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('no more than MAX_BOOK_REGEX_KEYS keys in a book', () => {
    const entries: LoreEntry[] = Array.from({ length: MAX_BOOK_REGEX_KEYS + 1 }, (_, i) => ({
      keys: ['/x/'], secondary_keys: [], content: 'c', enabled: true, insertion_order: i, priority: 0, case_sensitive: false, selective: false,
      constant: false, use_regex: true, position: 'before_char', name: '', comment: '', extensions: {}
    }));
    const book = prepareLorebook({ name: '', description: '', recursive_scanning: false, extensions: {}, entries });
    expect(book.entries).toHaveLength(MAX_BOOK_REGEX_KEYS);
    expect(book.warnings).toHaveLength(1);
  });
});
