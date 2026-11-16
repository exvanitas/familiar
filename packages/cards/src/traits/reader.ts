// The trait reader's question: which parts of a card go to the model, in what order and how much of
// each, and the one tool it may answer with. docs/persona-traits.md, "Reading traits from a card".
// Never sent: tags, creator notes, the card's system prompt and post-history instructions, assets,
// or any extension but `depth_prompt`.
import { stripDecorators } from '../decorators.ts';
import { isObject, own } from '../fields.ts';
import { fillMacros } from '../macros.ts';
import { sliceText } from '../text.ts';
import type { Card } from '../types.ts';
import TEXT from './reader-text.json' with { type: 'json' };

/** Bump when anything the reader sends or checks changes, so cards are read again (cache key). */
export const READER_VERSION = 1;

export const READER_TOTAL_CHARS = 24_000;
export const READER_GREETINGS = 2;
export const READER_EXAMPLE_CHARS = 2_000;
export const READER_LORE_CHARS = 4_000;
export const READER_DEPTH_PROMPT_CHARS = 1_000;

export const READER_TEXT = TEXT;

/** The tool's shape, the same as core's ToolSpec. */
export interface ReaderTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly [key: string]: unknown };
}

const trait = (values: readonly string[], description: string) => ({ type: 'string', enum: [...values, 'unsure'], description });
const quote = { type: 'string', maxLength: 120 };

export const SET_TRAITS_TOOL: ReaderTool = {
  name: TEXT.tool.name,
  description: TEXT.tool.description,
  inputSchema: {
    type: 'object',
    properties: {
      sociability: trait(['reserved', 'even', 'outgoing'], TEXT.tool.sociability),
      closeness: trait(['aloof', 'warm', 'clingy'], TEXT.tool.closeness),
      lively: trait(['morning', 'any', 'night'], TEXT.tool.lively),
      interests: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 5, description: TEXT.tool.interests },
      evidence: {
        type: 'object',
        properties: { sociability: quote, closeness: quote, lively: quote },
        additionalProperties: false,
        description: TEXT.tool.evidence
      }
    },
    required: ['sociability', 'closeness', 'lively', 'interests', 'evidence'],
    additionalProperties: false
  }
};

type Field = keyof typeof TEXT.labels;

export interface ReaderPart {
  readonly field: Field;
  readonly text: string;
}

export interface ReaderPrompt {
  readonly system: string;
  /** The one user message: the intro, then each part under its label. */
  readonly user: string;
  /** The card's text as sent, field by field, in order, after every cut. */
  readonly parts: readonly ReaderPart[];
  /**
   * Each part's text alone, and her lore entry by entry: a quote must come from one of them, never
   * across two fields or two lore entries, never from a label.
   */
  readonly quotable: readonly string[];
}

const SEP = '\n\n';

/** The fields in the documented order, each already cut to its own limit, `{{char}}` and `{{user}}` filled. */
function fields(card: Card, user: string): ReaderPart[] {
  const fill = (t: string) => fillMacros(t, { char: card.name, user });
  const out: ReaderPart[] = [];
  const add = (field: Field, text: string, max = Infinity) => {
    const filled = fill(text).trim();
    if (filled) out.push({ field, text: sliceText(filled, max).trim() });
  };
  add('description', card.description);
  add('personality', card.personality);
  add('first_mes', card.first_mes);
  for (const g of card.alternate_greetings.slice(0, READER_GREETINGS)) add('alternate_greetings', g);
  add('mes_example', card.mes_example, READER_EXAMPLE_CHARS);
  add('scenario', card.scenario);
  // Each lore entry filled on its own, so no macro spans two of them.
  const lore = herLoreEntries(card).map((e) => fill(e).trim()).filter((e) => e).join(SEP);
  if (lore) out.push({ field: 'lore', text: sliceText(lore, READER_LORE_CHARS).trim() });
  add('depth_prompt', depthPrompt(card), READER_DEPTH_PROMPT_CHARS);
  return out;
}

/** Lore that's about her, as sent: her entries joined. */
export function herLore(card: Card): string {
  return herLoreEntries(card).join(SEP);
}

/** Her lore entries: enabled ones that are constant, or have a key equal to her name or nickname, in order. */
export function herLoreEntries(card: Card): string[] {
  const book = card.character_book;
  if (!book) return [];
  const names = [card.name, card.nickname ?? ''].map((n) => n.trim().toLowerCase()).filter((n) => n);
  return book.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.enabled && (entry.constant || entry.keys.some((k) => names.includes(k.trim().toLowerCase()))))
    .sort((a, b) => a.entry.insertion_order - b.entry.insertion_order || a.index - b.index)
    .map(({ entry }) => stripDecorators(entry.content).trim())
    .filter((c) => c);
}

/** `extensions.depth_prompt`, as SillyTavern writes it (`{ prompt, depth, role }`), or a plain string. */
function depthPrompt(card: Card): string {
  const v = card.extensions['depth_prompt'];
  if (typeof v === 'string') return v;
  if (isObject(v)) {
    const p = own(v, 'prompt');
    if (typeof p === 'string') return p;
  }
  return '';
}

export function readerPrompt(card: Card, options: { readonly userName: string }): ReaderPrompt {
  const intro = fillMacros(TEXT.intro, { char: card.name, user: options.userName });
  const parts: ReaderPart[] = [];
  let used = 0;
  // In order, so the description and the personality get the room first.
  for (const part of fields(card, options.userName)) {
    const label = `${TEXT.labels[part.field]}:\n`;
    const room = READER_TOTAL_CHARS - used - (parts.length ? SEP.length : 0) - label.length;
    if (room <= 0) break;
    const text = sliceText(part.text, room).trim();
    if (!text) break;
    parts.push({ field: part.field, text });
    used += (parts.length > 1 ? SEP.length : 0) + label.length + text.length;
    if (text.length < part.text.length) break;
  }
  return {
    system: TEXT.system.join('\n'),
    user: `${intro}${SEP}${parts.map((p) => `${TEXT.labels[p.field]}:\n${p.text}`).join(SEP)}`,
    parts,
    quotable: parts.flatMap((p) => (p.field === 'lore' ? loreEntriesIn(p.text, card, options.userName) : [p.text]))
  };
}

/** The lore text as sent, cut or not, back into its entries. A cut entry is the part of it that was sent. */
function loreEntriesIn(sent: string, card: Card, user: string): string[] {
  const entries = herLoreEntries(card).map((e) => fillMacros(e, { char: card.name, user }).trim()).filter((e) => e);
  const out: string[] = [];
  let at = 0;
  for (const e of entries) {
    if (at >= sent.length) break;
    const piece = sent.slice(at, at + e.length);
    out.push(piece);
    if (piece !== e) break;
    at += e.length + SEP.length;
  }
  return out;
}

/** The card's text as the reader sends it, labels included: what READER_TOTAL_CHARS bounds. */
export function sentCardText(prompt: ReaderPrompt): string {
  return prompt.parts.map((p) => `${TEXT.labels[p.field]}:\n${p.text}`).join(SEP);
}
