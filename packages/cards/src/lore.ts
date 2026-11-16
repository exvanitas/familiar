// The lorebook: which entries the recent messages call up, and which fit the budget.
//
// - An entry is in when it's enabled and constant, or when one of its keys appears in the newest
//   `scan_depth` messages (case-insensitive unless `case_sensitive`). A `selective` entry with
//   secondary keys also needs one of those to appear.
// - Keys are plain text, matched anywhere in the text, or regexes when `use_regex`, run by regex.ts's
//   own linear-time matcher, never the JavaScript engine.
// - The ones that are in are ranked by `insertion_order`, then `priority`, highest kept first. Each is
//   added if it fits what's left of the budget, and dropped if not, so a lower one is never kept in
//   place of a higher one that fits. The kept ones go into the prompt by `insertion_order`, lowest first.
// - Recursive scanning (entries that call up other entries) and decorators come later.
import { stripDecorators } from './decorators.ts';
import { DEFAULT_SCAN_DEPTH, MAX_BOOK_REGEX_KEYS, MAX_BOOK_REGEX_STATES, MAX_SCAN_CHARS } from './limits.ts';
import { compileKey, type KeyMatcher, type RefusedWhy } from './regex.ts';
import type { LoreEntry, Lorebook, Warning } from './types.ts';

export interface PreparedEntry {
  /** Its place in the book, for reports. Never its name: warnings and reports don't quote the card. */
  readonly index: number;
  readonly entry: LoreEntry;
  /** The content as it goes into a prompt: decorator lines left out. */
  readonly content: string;
  /** Regexes for a `use_regex` entry, compiled once. Empty for a plain one. */
  readonly regexes: readonly KeyMatcher[];
  readonly secondaryRegexes: readonly KeyMatcher[];
}

export interface PreparedLorebook {
  readonly scanDepth: number;
  readonly tokenBudget?: number;
  readonly entries: readonly PreparedEntry[];
  readonly warnings: readonly Warning[];
}

const WHY: Record<RefusedWhy, string> = {
  'too-long': 'is too long',
  'bad-flags': 'has flags other than i, m and s',
  backreference: 'uses a backreference',
  lookaround: 'uses a lookahead or lookbehind',
  'named-group': 'uses a named group',
  'unicode-property': 'uses a Unicode property escape',
  'unsupported-escape': 'uses an escape Familiar does not support',
  'bound-too-large': 'repeats more times than Familiar allows',
  'too-many-states': 'is too complex',
  'does-not-compile': "isn't a valid regex",
  'over-book-budget': 'would take the book past its regex budget'
};

/**
 * Compiles a book's regex keys once. An entry with a refused key is skipped, with a warning that gives
 * its place and the reason, never the pattern. Disabled entries are left out. Past MAX_BOOK_REGEX_KEYS
 * keys or MAX_BOOK_REGEX_STATES states in all, further regex entries are skipped the same way.
 */
export function prepareLorebook(book: Lorebook): PreparedLorebook {
  const warnings: Warning[] = [];
  const entries: PreparedEntry[] = [];
  let keys = 0, states = 0;
  book.entries.forEach((entry, index) => {
    if (!entry.enabled) return;
    let regexes: KeyMatcher[] = [], secondaryRegexes: KeyMatcher[] = [];
    if (entry.use_regex) {
      // An empty key would match everything, so it's skipped, as a plain empty key is.
      const primary = entry.keys.filter((k) => k.length > 0), secondary = entry.secondary_keys.filter((k) => k.length > 0);
      const compiled = [...primary, ...secondary].map((k) => compileKey(k, entry.case_sensitive));
      const refused = compiled.find((c) => !c.ok);
      const all = compiled.flatMap((c) => (c.ok ? [c.regex] : []));
      const cost = all.reduce((n, r) => n + r.states, 0);
      const why = refused && !refused.ok ? refused.why : keys + all.length > MAX_BOOK_REGEX_KEYS || states + cost > MAX_BOOK_REGEX_STATES ? 'over-book-budget' : undefined;
      if (why) {
        warnings.push({ code: 'regex-refused', message: `Lore entry ${index + 1} was skipped: a regex key ${WHY[why]}.` });
        return;
      }
      keys += all.length;
      states += cost;
      regexes = all.slice(0, primary.length);
      secondaryRegexes = all.slice(primary.length);
    }
    entries.push({ index, entry, content: stripDecorators(entry.content), regexes, secondaryRegexes });
  });
  return {
    scanDepth: book.scan_depth ?? DEFAULT_SCAN_DEPTH,
    ...(book.token_budget !== undefined ? { tokenBudget: book.token_budget } : {}),
    entries,
    warnings
  };
}

export interface ScanMessage {
  readonly content: string;
}

/** The text a book scans: the newest `depth` messages, newest characters first kept, at most MAX_SCAN_CHARS. */
export function scanText(messages: readonly ScanMessage[], depth: number): string {
  const recent = depth <= 0 ? [] : messages.slice(-depth);
  const joined = recent.map((m) => m.content).join('\n');
  return joined.length > MAX_SCAN_CHARS ? joined.slice(joined.length - MAX_SCAN_CHARS) : joined;
}

function plainHit(keys: readonly string[], text: string, lowered: string, caseSensitive: boolean): boolean {
  return keys.some((k) => k.length > 0 && (caseSensitive ? text.includes(k) : lowered.includes(k.toLowerCase())));
}

function hits(e: PreparedEntry, text: string, lowered: string): boolean {
  const { entry } = e;
  if (entry.constant) return true;
  const primary = entry.use_regex ? e.regexes.some((r) => r.test(text)) : plainHit(entry.keys, text, lowered, entry.case_sensitive);
  if (!primary) return false;
  if (!entry.selective || !entry.secondary_keys.some((k) => k.length > 0)) return true;
  return entry.use_regex ? e.secondaryRegexes.some((r) => r.test(text)) : plainHit(entry.secondary_keys, text, lowered, entry.case_sensitive);
}

/** The entries the messages call up, constant ones included, before any budget. */
export function matchLore(book: PreparedLorebook, messages: readonly ScanMessage[]): PreparedEntry[] {
  const text = scanText(messages, book.scanDepth);
  const lowered = text.toLowerCase();
  return book.entries.filter((e) => hits(e, text, lowered));
}

export interface LoreChoice {
  /** Kept, in prompt order: `insertion_order` lowest first, then the book's own order. */
  readonly kept: readonly PreparedEntry[];
  /** Matched but over the budget. */
  readonly dropped: readonly PreparedEntry[];
  readonly tokens: number;
}

/** Highest kept first: `insertion_order`, then `priority`, then later in the book. */
function keepRank(a: PreparedEntry, b: PreparedEntry): number {
  return b.entry.insertion_order - a.entry.insertion_order || b.entry.priority - a.entry.priority || b.index - a.index;
}

/**
 * Fits matched entries into `budget` tokens. `cost` is what one entry adds to the prompt, separator
 * included. A book's own `token_budget` lowers the budget further.
 */
export function fitLore(book: PreparedLorebook, matched: readonly PreparedEntry[], budget: number, cost: (e: PreparedEntry) => number): LoreChoice {
  const limit = Math.max(0, Math.min(budget, book.tokenBudget ?? Infinity));
  const kept: PreparedEntry[] = [], dropped: PreparedEntry[] = [];
  let tokens = 0;
  for (const e of [...matched].sort(keepRank)) {
    const c = cost(e);
    if (tokens + c <= limit) {
      kept.push(e);
      tokens += c;
    } else dropped.push(e);
  }
  kept.sort((a, b) => a.entry.insertion_order - b.entry.insertion_order || a.index - b.index);
  dropped.sort((a, b) => a.index - b.index);
  return { kept, dropped, tokens };
}
