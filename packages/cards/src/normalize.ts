// Parsed JSON to the one Card shape: V1 (flat), V2 (`chara_card_v2`) and V3 (`chara_card_v3`).
import { decoratorNames } from './decorators.ts';
import { extensions, flag, isObject, Notes, num, own, short, text, textList, textMap, type Raw } from './fields.ts';
import { MAX_ASSETS, MAX_FIELD_CHARS, MAX_GREETINGS, MAX_KEY_CHARS, MAX_KEYS_PER_ENTRY, MAX_LANGUAGES, MAX_LORE_ENTRIES, MAX_SCAN_DEPTH, MAX_SHORT_CHARS, MAX_TAGS } from './limits.ts';
import type { Card, CardAsset, CardFormat, LoreEntry, Lorebook, ReadError } from './types.ts';

export type Normalized = { ok: true; card: Card; format: CardFormat } | { ok: false; error: ReadError };

const MAX_ORDER = 1_000_000_000;

/** Which spec a parsed value is written to, if any. */
export function formatOf(v: unknown): CardFormat | undefined {
  if (!isObject(v)) return undefined;
  const spec = own(v, 'spec');
  if (spec === 'chara_card_v3' && isObject(own(v, 'data'))) return 'v3';
  if (spec === 'chara_card_v2' && isObject(own(v, 'data'))) return 'v2';
  if (spec === undefined && typeof own(v, 'name') === 'string') return 'v1';
  return undefined;
}

export function normalize(value: unknown, notes: Notes): Normalized {
  const format = formatOf(value);
  if (!format) return { ok: false, error: { kind: 'not-a-card', message: "This isn't a V1, V2 or V3 character card." } };
  const top = value as Raw;
  const d = format === 'v1' ? top : (own(top, 'data') as Raw);
  if (format !== 'v1') {
    const version = own(top, 'spec_version');
    const major = format === 'v3' ? '3' : '2';
    if (typeof version !== 'string' || version.split('.')[0] !== major) {
      notes.add('spec-version', `The card's spec_version isn't a ${major}.x version; it was read as ${format.toUpperCase()}.`);
    }
  }
  const name = short(d, 'name', notes, 'The name').trim();
  if (!name) return { ok: false, error: { kind: 'not-a-card', message: 'The card has no name.' } };

  const card: Card = {
    name,
    description: text(d, 'description', notes, 'The description'),
    personality: text(d, 'personality', notes, 'The personality'),
    scenario: text(d, 'scenario', notes, 'The scenario'),
    first_mes: text(d, 'first_mes', notes, 'The first message'),
    mes_example: text(d, 'mes_example', notes, 'The example messages'),
    alternate_greetings: format === 'v1' ? [] : textList(d, 'alternate_greetings', notes, 'The alternate greetings', MAX_GREETINGS),
    group_only_greetings: format === 'v3' ? textList(d, 'group_only_greetings', notes, 'The group greetings', MAX_GREETINGS) : [],
    system_prompt: format === 'v1' ? '' : text(d, 'system_prompt', notes, 'The system prompt'),
    post_history_instructions: format === 'v1' ? '' : text(d, 'post_history_instructions', notes, 'The post-history instructions'),
    creator_notes: format === 'v1' ? '' : text(d, 'creator_notes', notes, 'The creator notes'),
    creator: format === 'v1' ? '' : short(d, 'creator', notes, 'The creator'),
    character_version: format === 'v1' ? '' : short(d, 'character_version', notes, 'The character version'),
    tags: format === 'v1' ? [] : textList(d, 'tags', notes, 'The tags', MAX_TAGS, MAX_SHORT_CHARS),
    extensions: format === 'v1' ? {} : extensions(d, 'extensions', notes, 'The extensions')
  };
  if (format === 'v3') {
    const nickname = short(d, 'nickname', notes, 'The nickname').trim();
    if (nickname) card.nickname = nickname;
    const multi = textMap(d, 'creator_notes_multilingual', notes, 'The multilingual creator notes', MAX_LANGUAGES);
    if (multi) card.creator_notes_multilingual = multi;
    if (Array.isArray(own(d, 'source'))) card.source = textList(d, 'source', notes, 'The sources', MAX_TAGS, MAX_FIELD_CHARS);
    const created = num(d, 'creation_date', 0, 1e12);
    if (created !== undefined) card.creation_date = created;
    const modified = num(d, 'modification_date', 0, 1e12);
    if (modified !== undefined) card.modification_date = modified;
    const assets = assetList(own(d, 'assets'), notes);
    if (assets) card.assets = assets;
  }
  if (format !== 'v1') {
    const book = own(d, 'character_book');
    if (isObject(book)) card.character_book = lorebook(book, notes);
    else if (book !== undefined && book !== null) notes.add('wrong-type', "The lorebook wasn't an object and was left out.");
  }
  return { ok: true, card, format };
}

function assetList(v: unknown, notes: Notes): CardAsset[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CardAsset[] = [];
  for (const a of v) {
    if (!isObject(a)) continue;
    if (out.length === MAX_ASSETS) {
      notes.add('too-many', `The card had more than ${MAX_ASSETS} assets; the rest were dropped.`);
      break;
    }
    out.push({
      type: short(a, 'type', notes, 'An asset type'),
      uri: text(a, 'uri', notes, 'An asset address'),
      name: short(a, 'name', notes, 'An asset name'),
      ext: short(a, 'ext', notes, 'An asset extension')
    });
  }
  return out;
}

export function lorebook(b: Raw, notes: Notes): Lorebook {
  const book: Lorebook = {
    name: short(b, 'name', notes, "The lorebook's name"),
    description: text(b, 'description', notes, "The lorebook's description"),
    recursive_scanning: flag(b, 'recursive_scanning', false),
    extensions: extensions(b, 'extensions', notes, "The lorebook's extensions"),
    entries: []
  };
  const depth = num(b, 'scan_depth', 0, MAX_SCAN_DEPTH);
  if (depth !== undefined) book.scan_depth = depth;
  const budget = num(b, 'token_budget', 0, 1_000_000);
  if (budget !== undefined) book.token_budget = budget;
  const entries = own(b, 'entries');
  if (!Array.isArray(entries)) {
    if (entries !== undefined) notes.add('wrong-type', "The lorebook's entries weren't a list and were left out.");
    return book;
  }
  const decorators = new Set<string>();
  for (const e of entries) {
    if (!isObject(e)) continue;
    if (book.entries.length === MAX_LORE_ENTRIES) {
      notes.add('too-many', `The lorebook had more than ${MAX_LORE_ENTRIES} entries; the rest were dropped.`);
      break;
    }
    const entry = loreEntry(e, notes);
    for (const d of decoratorNames(entry.content)) decorators.add(d);
    book.entries.push(entry);
  }
  if (decorators.size > 0) {
    notes.add('decorators', `The lorebook uses V3 decorators (${[...decorators].sort().join(', ')}), which Familiar doesn't follow yet; their lines are left out of the prompt.`);
  }
  return book;
}

function loreEntry(e: Raw, notes: Notes): LoreEntry {
  const position = own(e, 'position');
  const entry: LoreEntry = {
    keys: textList(e, 'keys', notes, "A lore entry's keys", MAX_KEYS_PER_ENTRY, MAX_KEY_CHARS, true),
    secondary_keys: textList(e, 'secondary_keys', notes, "A lore entry's secondary keys", MAX_KEYS_PER_ENTRY, MAX_KEY_CHARS, true),
    content: text(e, 'content', notes, "A lore entry's content"),
    enabled: flag(e, 'enabled', true),
    insertion_order: num(e, 'insertion_order', -MAX_ORDER, MAX_ORDER) ?? 0,
    priority: num(e, 'priority', -MAX_ORDER, MAX_ORDER) ?? 0,
    case_sensitive: flag(e, 'case_sensitive', false),
    selective: flag(e, 'selective', false),
    constant: flag(e, 'constant', false),
    use_regex: flag(e, 'use_regex', false),
    position: position === 'after_char' ? 'after_char' : 'before_char',
    name: short(e, 'name', notes, "A lore entry's name"),
    comment: text(e, 'comment', notes, "A lore entry's comment"),
    extensions: extensions(e, 'extensions', notes, "A lore entry's extensions")
  };
  const id = own(e, 'id');
  if (typeof id === 'number' && Number.isFinite(id)) entry.id = Math.trunc(id);
  else if (typeof id === 'string') entry.id = short(e, 'id', notes, "A lore entry's id");
  return entry;
}
