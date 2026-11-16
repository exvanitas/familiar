// buildPrompt: the plan's order, the switches, what's dropped over budget and the arithmetic.
import { describe, expect, it } from 'vitest';
import {
  buildPrompt, DEFAULT_PERSONA_SETTINGS, estimateTokens, pickGreeting, prepareLorebook, PROMPT_LABELS, UTC_FORMAT, type PromptInput
} from '../src/index.ts';
import { card, makeCard } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 16, 9, 30);
/** One token a character, so the arithmetic is plain. */
const chars = (t: string) => t.length;

const pell = card('cards/v2-pell.json');
const base: PromptInput = {
  card: pell,
  settings: DEFAULT_PERSONA_SETTINGS,
  userName: 'Sam',
  frame: 'You are {{char}}, also {{user}}\'s desktop helper. Short replies.',
  memory: { facts: '', story: '' },
  recent: [{ content: 'how is the greenhouse?' }, { content: 'and the snails' }],
  now: NOW,
  format: UTC_FORMAT,
  reminders: [],
  budget: 4000,
  estimate: chars
};

describe('order and contents', () => {
  it('frame, card, memory, lore, examples, now: in that order, macros filled', () => {
    const p = buildPrompt({ ...base, memory: { facts: '{{user}} likes tea.', story: 'They met in spring.' }, reminders: ['Water the ferns at 10:00'] });
    expect(p.sections.map((s) => s.name)).toEqual(['frame', 'card', 'memory', 'lore', 'examples', 'now']);
    expect(p.instructions).toBe(p.sections.map((s) => s.text).join('\n\n'));
    expect(p.instructions).not.toMatch(/\{\{(char|user)\}\}/i);
    expect(p.sections[0]!.text).toBe("You are Pell Mossbright, also Sam's desktop helper. Short replies.");
    expect(p.sections[1]!.text).toBe([
      'Pell Mossbright is a garden sprite about the size of a teacup, with leaf-green hair and muddy boots.',
      "Pell Mossbright's personality: cheerful, chatty, easily distracted",
      "Scenario: Pell Mossbright has moved into a flowerpot on Sam's windowsill."
    ].join('\n\n'));
    expect(p.sections[2]!.text).toBe('What you remember about Sam:\nSam likes tea.\n\nThe story so far:\nThey met in spring.');
    expect(p.sections[3]!.text).toBe('The greenhouse has a cracked pane that Pell Mossbright keeps meaning to fix.\n\nPell Mossbright names every snail after a weather pattern.');
    expect(p.loreEntries).toEqual([0, 1]);
    expect(p.sections[4]!.text.startsWith("Examples of how Pell Mossbright talks:\n<START>\nSam: Are you a plant?")).toBe(true);
    expect(p.sections[5]!.text).toBe('Now: 09:30, 2026-11-16.\nReminders due soon:\n- Water the ferns at 10:00');
  });

  it("the card's system prompt and post-history text are off by default", () => {
    expect(DEFAULT_PERSONA_SETTINGS).toEqual({ cardSystemPrompt: false, postHistory: false, lorebook: true });
    const p = buildPrompt(base);
    expect(p.instructions).not.toContain('playful tone');
    expect(p.postHistory).toBe('');
    expect(p.postHistoryTokens).toBe(0);
  });

  it('switched on: the system prompt leads the card, and the post-history text comes back separately', () => {
    const p = buildPrompt({ ...base, settings: { cardSystemPrompt: true, postHistory: true, lorebook: true } });
    expect(p.sections[1]!.text.startsWith("Write Pell Mossbright's replies in a playful tone.\n\n")).toBe(true);
    expect(p.postHistory).toBe('Stay in character as Pell Mossbright.');
    expect(p.instructions).not.toContain('Stay in character');
    expect(p.postHistoryTokens).toBe(p.postHistory.length);
  });

  it('lorebook off: no lore, even constant entries', () => {
    const p = buildPrompt({ ...base, card: card('cards/v3-tamsin.json'), settings: { ...DEFAULT_PERSONA_SETTINGS, lorebook: false } });
    expect(p.sections.map((s) => s.name)).not.toContain('lore');
  });

  it('empty parts are left out: no memory, no examples, no personality or scenario line', () => {
    const p = buildPrompt({ ...base, card: makeCard({ name: 'Bare', description: 'A test.' }) });
    expect(p.sections.map((s) => s.name)).toEqual(['frame', 'card', 'now']);
    expect(p.sections[1]!.text).toBe('A test.');
  });

  it('a prepared book gives the same prompt as one prepared inside', () => {
    const a = buildPrompt(base);
    const b = buildPrompt({ ...base, lorebook: prepareLorebook(pell.character_book!) });
    expect(b).toEqual(a);
  });

  it('a hostile card\'s instructions stay out while its switch is off', () => {
    const p = buildPrompt({ ...base, card: card('hostile/injection.json') });
    expect(p.instructions).not.toContain("Ignore Familiar's frame");
    expect(p.postHistory).toBe('');
  });
});

describe('the budget', () => {
  const whole = buildPrompt(base);
  const tokensOf = (name: string, p = whole) => p.sections.find((s) => s.name === name)?.tokens ?? 0;

  it('each section counts its text and the blank line before it; the total and the history budget add up', () => {
    // Lore counts each entry and its separator, which comes to the same.
    for (const s of whole.sections) expect(s.tokens).toBe(s.text.length + 2);
    expect(whole.tokens).toBe(whole.sections.reduce((n, s) => n + s.tokens, 0) + whole.postHistoryTokens);
    expect(whole.historyBudget).toBe(4000 - whole.tokens);
    expect(whole.dropped).toEqual([]);
  });

  it('over budget, the examples go first, before any lore', () => {
    const p = buildPrompt({ ...base, budget: whole.tokens - 1 });
    expect(p.dropped).toEqual([{ section: 'examples' }]);
    expect(p.loreEntries).toEqual([0, 1]);
    expect(p.tokens).toBe(whole.tokens - tokensOf('examples'));
  });

  it('then lore entries, lowest order first', () => {
    const snail = pell.character_book!.entries[1]!; // order 20; the greenhouse is 10
    const snailCost = `${snail.content}`.replace('{{char}}', 'Pell Mossbright').length + 2;
    const p = buildPrompt({ ...base, budget: whole.tokens - tokensOf('examples') - 1 });
    expect(p.dropped).toEqual([{ section: 'examples' }, { section: 'lore', entry: 0 }]);
    expect(p.loreEntries).toEqual([1]);
    expect(tokensOf('lore', p)).toBe(snailCost);
  });

  it("reserveForHistory: lore and examples never take it", () => {
    const reserve = tokensOf('examples') + tokensOf('lore');
    const p = buildPrompt({ ...base, budget: whole.tokens, reserveForHistory: reserve });
    expect(p.dropped.map((d) => d.section)).toEqual(['examples', 'lore', 'lore']);
    expect(p.historyBudget).toBe(reserve);
  });

  it('the frame and the card are never dropped; a card over the budget is cut with a marker and a warning', () => {
    const big = makeCard({ name: 'Long', description: 'word '.repeat(2000) });
    const p = buildPrompt({ ...base, card: big, budget: 1000 });
    expect(p.sections.map((s) => s.name)).toEqual(['frame', 'card', 'now']);
    expect(p.sections[1]!.text.endsWith(`\n${PROMPT_LABELS.cut}`)).toBe(true);
    expect(p.warnings.map((w) => w.code)).toEqual(['card-cut']);
    expect(p.tokens).toBeLessThanOrEqual(1000);
    expect(p.tokens).toBeGreaterThan(990);
    expect(p.historyBudget).toBe(1000 - p.tokens);
  });

  it('a budget the frame alone fills: the card is just the marker, and the history gets nothing', () => {
    const p = buildPrompt({ ...base, budget: 30 });
    expect(p.sections.map((s) => s.name)).toEqual(['frame', 'card', 'now']);
    expect(p.sections[1]!.text).toBe(PROMPT_LABELS.cut);
    expect(p.warnings.map((w) => w.code)).toEqual(['card-cut', 'over-budget']);
    expect(p.historyBudget).toBe(0);
  });

  it('a cut never splits a surrogate pair', () => {
    const p = buildPrompt({ ...base, card: makeCard({ name: 'E', description: '😀'.repeat(500) }), budget: 300 });
    expect(p.sections[1]!.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('with the default estimator, the counted tokens are never below an estimate of the whole text', () => {
    const p = buildPrompt({ ...base, estimate: undefined, settings: { cardSystemPrompt: true, postHistory: true, lorebook: true } });
    expect(estimateTokens(p.instructions) + estimateTokens(p.postHistory)).toBeLessThanOrEqual(p.tokens);
  });
});

describe('the default estimator', () => {
  it('errs high: three ASCII characters a token, one for anything else', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('日本語')).toBe(3);
    expect(estimateTokens('😀')).toBe(1);
    // English is near four characters a token, so this is above the real count.
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBeGreaterThan(11);
  });
});

describe('greetings', () => {
  const ctx = { char: 'Pell', user: 'Sam' };
  it('first_mes or an alternate, by the injected choice, macros filled', () => {
    expect(pickGreeting(pell, () => 0, ctx)).toBe('Oh! Hello, Sam! Mind the soil, I just watered.');
    expect(pickGreeting(pell, (n) => n - 1, ctx)).toBe('*Pell waves a tiny trowel.*');
    let offered = 0;
    pickGreeting(pell, (n) => (offered = n), ctx);
    expect(offered).toBe(3);
  });

  it('a choice out of range is clamped; a card with no greeting gives none', () => {
    expect(pickGreeting(pell, () => 99, ctx)).toBe('*Pell waves a tiny trowel.*');
    expect(pickGreeting(pell, () => Number.NaN, ctx)).toBe('Oh! Hello, Sam! Mind the soil, I just watered.');
    expect(pickGreeting(makeCard(), () => 0, ctx)).toBe('');
  });
});
