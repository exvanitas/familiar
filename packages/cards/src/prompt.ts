// Building the persona's instructions from a card, in the plan's order:
//   1 the app frame, 2 the card, 3 memory, 4 lorebook entries that matched, 5 example messages,
//   (6 the recent messages: the turn loop places them), 7 now: time, date, reminders due soon.
// The card's post-history instructions belong after the history, so they come back separately.
//
// The budget: the frame, the card, memory, now and the post-history text are never dropped. What's
// left, less `reserveForHistory`, goes to the lorebook, then to the examples if they fit whole. So
// over budget, the examples go first, then lore entries from the lowest order up. A card that alone
// doesn't fit is cut, with a marker the model sees and a warning.
import type { DateFormat } from './macros.ts';
import { fillMacros, type MacroContext } from './macros.ts';
import { fitLore, matchLore, prepareLorebook, type PreparedLorebook, type ScanMessage } from './lore.ts';
import { sliceText } from './text.ts';
import { estimateTokens, type TokenEstimator } from './tokens.ts';
import type { Card, Warning } from './types.ts';

/** The switches a persona has. The card's own system prompt and post-history text are off by default. */
export interface PersonaSettings {
  readonly cardSystemPrompt: boolean;
  readonly postHistory: boolean;
  readonly lorebook: boolean;
}

export const DEFAULT_PERSONA_SETTINGS: PersonaSettings = { cardSystemPrompt: false, postHistory: false, lorebook: true };

export interface MemorySections {
  /** What she keeps about the person. Empty until step 10. */
  readonly facts: string;
  /** The story so far. Empty until step 10. */
  readonly story: string;
}

export interface PromptInput {
  readonly card: Card;
  readonly settings: PersonaSettings;
  readonly userName: string;
  /** The fixed app frame (who she is here, short replies, her tools). Macros are filled in it too. */
  readonly frame: string;
  readonly memory: MemorySections;
  /** Oldest first. Only scanned for lore here; the turn loop places them. */
  readonly recent: readonly ScanMessage[];
  readonly now: number;
  readonly format: DateFormat;
  /** Reminders due soon, as lines. */
  readonly reminders: readonly string[];
  /** Tokens for everything the model gets: these instructions, the history and the post-history text. */
  readonly budget: number;
  /** Kept free for the history: lore and examples never take it. Default 0. */
  readonly reserveForHistory?: number;
  readonly estimate?: TokenEstimator;
  /** The card's book, prepared once (regexes compiled). Prepared here when left out. */
  readonly lorebook?: PreparedLorebook;
}

export type SectionName = 'frame' | 'card' | 'memory' | 'lore' | 'examples' | 'now';

export interface Section {
  readonly name: SectionName;
  readonly text: string;
  /** Its estimate, the blank line that separates it included. */
  readonly tokens: number;
}

export type Dropped = { readonly section: 'examples' } | { readonly section: 'lore'; readonly entry: number };

export interface Prompt {
  readonly instructions: string;
  readonly postHistory: string;
  readonly postHistoryTokens: number;
  /** The sections in the instructions, in order. Empty ones are left out. */
  readonly sections: readonly Section[];
  readonly dropped: readonly Dropped[];
  /** Lore entries that went in, by their place in the book. */
  readonly loreEntries: readonly number[];
  /** The sections and the post-history text. */
  readonly tokens: number;
  /** `budget` less `tokens`, never below 0. */
  readonly historyBudget: number;
  readonly warnings: readonly Warning[];
}

/** The fixed words around the card's text. */
export const PROMPT_LABELS = {
  personality: "{{char}}'s personality:",
  scenario: 'Scenario:',
  facts: 'What you remember about {{user}}:',
  story: 'The story so far:',
  examples: 'Examples of how {{char}} talks:',
  now: 'Now:',
  reminders: 'Reminders due soon:',
  cut: '[Familiar cut the card here: it is longer than the prompt allows.]'
} as const;

const SEP = '\n\n';

export function buildPrompt(input: PromptInput): Prompt {
  const estimate = input.estimate ?? estimateTokens;
  const ctx: MacroContext = { char: input.card.name, user: input.userName, now: input.now, format: input.format };
  const fill = (t: string) => fillMacros(t, ctx);
  const sep = estimate(SEP);
  const cost = (t: string) => (t ? estimate(t) + sep : 0);
  const warnings: Warning[] = [];

  const frame = fill(input.frame);
  const memory = join([labelled(PROMPT_LABELS.facts, input.memory.facts), labelled(PROMPT_LABELS.story, input.memory.story)].map(fill));
  const now = fill(nowText(input));
  const postHistory = input.settings.postHistory ? fill(input.card.post_history_instructions) : '';
  const postHistoryTokens = postHistory ? estimate(postHistory) : 0;
  const fixed = cost(frame) + cost(memory) + cost(now) + postHistoryTokens;

  let card = fill(cardText(input.card, input.settings));
  if (fixed + cost(card) > input.budget) {
    card = cutToFit(card, input.budget - fixed - sep, estimate);
    warnings.push({ code: 'card-cut', message: "The card is longer than the prompt's budget allows, so it was cut." });
    if (fixed + cost(card) > input.budget) warnings.push({ code: 'over-budget', message: 'The frame, memory and the card already fill the budget; nothing is left for the history.' });
  }
  let room = input.budget - (input.reserveForHistory ?? 0) - fixed - cost(card);

  const dropped: Dropped[] = [];
  let lore = '', loreTokens = 0, loreEntries: number[] = [];
  if (input.settings.lorebook && input.card.character_book) {
    const book = input.lorebook ?? prepareLorebook(input.card.character_book);
    warnings.push(...book.warnings);
    const matched = matchLore(book, input.recent).filter((e) => e.content.trim().length > 0);
    const filled = new Map(matched.map((e) => [e.index, fill(e.content)]));
    const choice = fitLore(book, matched, room, (e) => estimate(filled.get(e.index)!) + sep);
    lore = choice.kept.map((e) => filled.get(e.index)!).join(SEP);
    loreTokens = choice.tokens;
    loreEntries = choice.kept.map((e) => e.index);
    for (const e of choice.dropped) dropped.push({ section: 'lore', entry: e.index });
    room -= loreTokens;
  }

  let examples = input.card.mes_example.trim() ? fill(`${PROMPT_LABELS.examples}\n${input.card.mes_example}`) : '';
  if (examples && cost(examples) > room) {
    dropped.unshift({ section: 'examples' });
    examples = '';
  }

  const sections: Section[] = [];
  const add = (name: SectionName, text: string, tokens = cost(text)) => {
    if (text) sections.push({ name, text, tokens });
  };
  add('frame', frame);
  add('card', card);
  add('memory', memory);
  add('lore', lore, loreTokens);
  add('examples', examples);
  add('now', now);
  const tokens = sections.reduce((n, s) => n + s.tokens, 0) + postHistoryTokens;
  return {
    instructions: sections.map((s) => s.text).join(SEP),
    postHistory,
    postHistoryTokens,
    sections,
    dropped,
    loreEntries,
    tokens,
    historyBudget: Math.max(0, input.budget - tokens),
    warnings
  };
}

function labelled(label: string, body: string): string {
  return body.trim() ? `${label}\n${body}` : '';
}

function join(parts: readonly string[]): string {
  return parts.filter((p) => p).join(SEP);
}

function cardText(card: Card, settings: PersonaSettings): string {
  return join([
    settings.cardSystemPrompt ? card.system_prompt : '',
    card.description,
    card.personality.trim() ? `${PROMPT_LABELS.personality} ${card.personality}` : '',
    card.scenario.trim() ? `${PROMPT_LABELS.scenario} ${card.scenario}` : ''
  ]);
}

function nowText(input: PromptInput): string {
  const line = `${PROMPT_LABELS.now} ${input.format.time(input.now)}, ${input.format.date(input.now)}.`;
  const due = input.reminders.filter((r) => r.trim());
  return due.length ? `${line}\n${PROMPT_LABELS.reminders}\n${due.map((r) => `- ${r}`).join('\n')}` : line;
}

/** The longest start of `text` that, with the cut marker, fits `tokens`. Just the marker when nothing does. */
function cutToFit(text: string, tokens: number, estimate: TokenEstimator): string {
  const marked = (n: number) => `${sliceText(text, n).trimEnd()}\n${PROMPT_LABELS.cut}`;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimate(marked(mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? PROMPT_LABELS.cut : marked(lo);
}

/** The opening message: `first_mes` or one of the alternates, by an injected choice of index. '' when the card has none. */
export function pickGreeting(card: Card, choose: (count: number) => number, ctx: MacroContext): string {
  const all = [card.first_mes, ...card.alternate_greetings].filter((g) => g.trim());
  if (all.length === 0) return '';
  const i = Math.trunc(choose(all.length));
  return fillMacros(all[Number.isFinite(i) ? Math.min(all.length - 1, Math.max(0, i)) : 0]!, ctx);
}
