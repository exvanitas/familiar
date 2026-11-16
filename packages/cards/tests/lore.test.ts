// The lorebook as a person sees it: which entries recent messages call up, in what order, and what a
// budget drops.
import { describe, expect, it } from 'vitest';
import { fitLore, matchLore, prepareLorebook, type PreparedEntry, type PreparedLorebook } from '../src/index.ts';
import { card } from './helpers.ts';

const book = (path: string): PreparedLorebook => prepareLorebook(card(path).character_book!);
const said = (...messages: string[]) => messages.map((content) => ({ content }));
const hit = (b: PreparedLorebook, ...messages: string[]) => matchLore(b, said(...messages)).map((e) => e.index);

describe('matching', () => {
  it('constant entries are always in; disabled ones never, constant or not', () => {
    const b = book('lore/constant.json');
    expect(hit(b)).toEqual([0]);
    expect(hit(b, 'put the kettle on')).toEqual([0, 1]);
  });

  it('selective entries need a secondary key too; selective with none acts plain', () => {
    const b = book('lore/selective.json');
    expect(hit(b, 'a bell rang')).toEqual([1, 2]);
    expect(hit(b, 'the bell in the steeple')).toEqual([0, 1, 2]);
    expect(hit(b, 'the steeple, no ringing')).toEqual([]);
  });

  it('case: insensitive by default, exact when case_sensitive', () => {
    const b = book('lore/case.json');
    expect(hit(b, 'a rook landed')).toEqual([1]);
    expect(hit(b, 'Rook landed')).toEqual([0, 1, 2]);
  });

  it('scan depth: only the newest scan_depth messages are read', () => {
    const b = book('lore/scan-depth.json');
    expect(b.scanDepth).toBe(2);
    expect(hit(b, 'a lantern', 'nothing', 'nothing')).toEqual([]);
    expect(hit(b, 'a lantern', 'a compass', 'nothing')).toEqual([1]);
    expect(hit(b, 'nothing', 'a lantern', 'a compass')).toEqual([0, 1]);
  });

  it('a book with scan_depth 0 matches only constant entries', () => {
    const c = card('cards/v3-tamsin.json');
    const b = prepareLorebook({ ...c.character_book!, scan_depth: 0 });
    expect(hit(b, 'Tam spilled the ink on the scrolls')).toEqual([0]);
  });

  it('the v3 card: constant, nickname key, regex key and selective entries together', () => {
    const b = prepareLorebook(card('cards/v3-tamsin.json').character_book!);
    expect(hit(b, 'hello')).toEqual([0]);
    expect(hit(b, 'hi tam')).toEqual([0, 1]);
    expect(hit(b, 'the old SCROLL')).toEqual([0, 2]);
    expect(hit(b, 'scrollwork')).toEqual([0]);
    expect(hit(b, 'ink everywhere')).toEqual([0]);
    expect(hit(b, 'I spilled ink')).toEqual([0, 3]);
  });
});

describe('regex keys', () => {
  it('good ones match; refused ones skip their entry, each with a warning by its place and reason, never the pattern', () => {
    const b = book('lore/regex.json');
    expect(b.entries.map((e) => e.index)).toEqual([0, 1, 2, 4, 7, 9]);
    expect(b.warnings.map((w) => w.message)).toEqual([
      'Lore entry 4 was skipped: a regex key uses a backreference.',
      "Lore entry 6 was skipped: a regex key isn't a valid regex.",
      'Lore entry 7 was skipped: a regex key is too long.',
      'Lore entry 9 was skipped: a regex key has flags other than i, m and s.',
      'Lore entry 11 was skipped: a regex key uses a lookahead or lookbehind.',
      'Lore entry 12 was skipped: a regex key uses a Unicode property escape.'
    ]);
    expect(hit(b, 'two FOXES ran')).toEqual([0, 4, 9]);
    expect(hit(b, 'moonrise')).toEqual([1, 4]);
    expect(hit(b, 'Moonrise')).toEqual([4]);
    expect(hit(b, 'a fox')).toEqual([0, 4, 9]);
    // (a+)+$ matches as JavaScript would: text ending in a.
    expect(hit(b, 'banana')).toEqual([2, 4]);
    for (const w of b.warnings) expect(w.message).not.toMatch(/\(|\\|\//);
  });

  it('a g flag is dropped, so the same entry matches every time', () => {
    const b = book('lore/regex.json');
    for (let i = 0; i < 3; i++) expect(hit(b, 'owl')).toContain(7);
  });
});

describe('the budget', () => {
  // The budget fixture: five entries keyed "rain", with these orders and priorities.
  // 0: order 5, priority 1   1: order 10   2: order 1   3: order 5, priority 9   4: order 0 (short)
  const b = book('lore/budget.json');
  const matched = matchLore(b, said('rain again'));
  const cost = (e: PreparedEntry) => e.content.length;

  it('everything fits: kept in insertion order, lowest first', () => {
    const r = fitLore({ ...b, tokenBudget: undefined } as PreparedLorebook, matched, 1000, cost);
    expect(r.kept.map((e) => e.index)).toEqual([4, 2, 0, 3, 1]);
    expect(r.dropped).toEqual([]);
    expect(r.tokens).toBe(126);
  });

  it("over the book's token_budget: the lowest order goes first, and priority breaks a tie", () => {
    // token_budget 100: room for three 30s, then the 6 fits too.
    const r = fitLore(b, matched, 1000, cost);
    expect(r.kept.map((e) => e.index)).toEqual([4, 0, 3, 1]);
    expect(r.dropped.map((e) => e.index)).toEqual([2]);
    expect(r.tokens).toBe(96);
  });

  it('the prompt budget binds when it is lower than the book\'s', () => {
    const r = fitLore(b, matched, 61, cost);
    expect(r.kept.map((e) => e.index)).toEqual([3, 1]);
    expect(r.dropped.map((e) => e.index)).toEqual([0, 2, 4]);
  });

  it('a higher entry that fits is never dropped to make room for a lower one', () => {
    for (let budget = 0; budget <= 130; budget++) {
      const r = fitLore({ ...b, tokenBudget: undefined } as PreparedLorebook, matched, budget, cost);
      expect(r.tokens).toBeLessThanOrEqual(budget);
      const rank = (e: PreparedEntry) => [e.entry.insertion_order, e.entry.priority];
      for (const d of r.dropped) {
        // Every kept entry ranked below a dropped one is smaller than what was left when the dropped one was tried.
        const higherKept = r.kept.filter((k) => rank(k)[0]! > rank(d)[0]! || (rank(k)[0] === rank(d)[0] && rank(k)[1]! > rank(d)[1]!));
        expect(higherKept.reduce((n, k) => n + cost(k), 0) + cost(d)).toBeGreaterThan(budget);
      }
    }
  });

  it('a budget of 0 keeps nothing and drops everything matched', () => {
    const r = fitLore(b, matched, 0, cost);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(5);
  });
});

describe('decorators', () => {
  it('their lines are left out of the content used, the rest kept', () => {
    const b = book('lore/decorators.json');
    expect(b.entries.map((e) => e.content)).toEqual(['The harbor freezes in winter.', 'Plain line kept.']);
  });
});
