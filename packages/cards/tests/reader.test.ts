// The trait reader's question: only the documented fields, in order, within the budgets, macros
// filled, and never what's kept back. docs/persona-traits.md, "How it's tested", "The reader".
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  READER_DEPTH_PROMPT_CHARS, READER_EXAMPLE_CHARS, READER_LORE_CHARS, READER_TEXT, READER_TOTAL_CHARS, READER_VERSION, readerPrompt, readCard,
  sentCardText, SET_TRAITS_TOOL, type Card
} from '../src/index.ts';
import { card, makeCard } from './helpers.ts';

const user = { userName: 'Sam' };

/** A card with every field set, each holding a word that says which field it is. */
const full: Card = makeCard({
  name: 'Mira',
  nickname: 'Mimi',
  description: 'DESCRIPTION {{char}} meets {{user}}.',
  personality: 'PERSONALITY',
  scenario: 'SCENARIO',
  first_mes: 'FIRSTMES',
  alternate_greetings: ['GREETING-ONE', 'GREETING-TWO', 'GREETING-THREE'],
  group_only_greetings: ['GROUPGREETING'],
  mes_example: 'EXAMPLES',
  system_prompt: 'SYSTEMPROMPT',
  post_history_instructions: 'POSTHISTORY',
  creator_notes: 'CREATORNOTES',
  creator_notes_multilingual: { fr: 'MULTILINGUAL' },
  creator: 'CREATOR',
  tags: ['TAGWORD'],
  assets: [{ type: 'emotion', uri: 'ASSETURI', name: 'ASSETNAME', ext: 'png' }],
  extensions: { depth_prompt: { prompt: 'DEPTHPROMPT', depth: 4, role: 'system' }, talkativeness: 0.1, other: 'OTHEREXTENSION' },
  character_book: {
    name: 'BOOKNAME', description: 'BOOKDESCRIPTION', recursive_scanning: false, extensions: {},
    entries: [
      { keys: ['mira'], secondary_keys: [], content: 'LORE-BY-NAME', enabled: true, insertion_order: 3, priority: 0, case_sensitive: false, selective: false, constant: false, use_regex: false, position: 'before_char', name: 'LORENAME', comment: 'LORECOMMENT', extensions: {} },
      { keys: [], secondary_keys: [], content: '@@depth 2\nLORE-CONSTANT', enabled: true, insertion_order: 1, priority: 0, case_sensitive: false, selective: false, constant: true, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} },
      { keys: ['Mimi '], secondary_keys: [], content: 'LORE-BY-NICKNAME', enabled: true, insertion_order: 2, priority: 0, case_sensitive: false, selective: false, constant: false, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} },
      { keys: ['castle'], secondary_keys: [], content: 'LORE-WORLD', enabled: true, insertion_order: 0, priority: 0, case_sensitive: false, selective: false, constant: false, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} },
      { keys: ['mira'], secondary_keys: [], content: 'LORE-DISABLED', enabled: false, insertion_order: 0, priority: 0, case_sensitive: false, selective: false, constant: true, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} },
      { keys: ['Mira the bold'], secondary_keys: [], content: 'LORE-KEY-CONTAINS-NAME', enabled: true, insertion_order: 0, priority: 0, case_sensitive: false, selective: false, constant: false, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} }
    ]
  }
});

describe('what the reader sends', () => {
  const p = readerPrompt(full, user);

  it('the documented fields, in the documented order', () => {
    expect(p.parts.map((x) => x.field)).toEqual([
      'description', 'personality', 'first_mes', 'alternate_greetings', 'alternate_greetings', 'mes_example', 'scenario', 'lore', 'depth_prompt'
    ]);
    expect(p.parts.map((x) => x.text)).toEqual([
      'DESCRIPTION Mira meets Sam.', 'PERSONALITY', 'FIRSTMES', 'GREETING-ONE', 'GREETING-TWO', 'EXAMPLES', 'SCENARIO',
      'LORE-CONSTANT\n\nLORE-BY-NICKNAME\n\nLORE-BY-NAME', 'DEPTHPROMPT'
    ]);
  });

  it('never tags, creator notes, the card\'s own instructions, assets, other extensions, other lore, or a third greeting', () => {
    const everything = `${p.system}\n${p.user}`;
    for (const kept of [
      'TAGWORD', 'CREATORNOTES', 'MULTILINGUAL', 'CREATOR', 'SYSTEMPROMPT', 'POSTHISTORY', 'ASSETURI', 'ASSETNAME', 'OTHEREXTENSION', 'GROUPGREETING',
      'GREETING-THREE', 'LORE-WORLD', 'LORE-DISABLED', 'LORE-KEY-CONTAINS-NAME', 'LORENAME', 'LORECOMMENT', 'BOOKNAME', 'BOOKDESCRIPTION', '@@depth', '0.1'
    ]) expect(everything, kept).not.toContain(kept);
  });

  it('{{char}} and {{user}} are filled, in the intro too', () => {
    expect(p.user.startsWith('The card for Mira:\n\nDescription:\nDESCRIPTION Mira meets Sam.')).toBe(true);
    expect(p.user).not.toMatch(/\{\{(char|user)\}\}/i);
  });

  it('the user message is the intro and the labelled parts; quotes come only from the parts', () => {
    expect(p.user).toBe(`The card for Mira:\n\n${sentCardText(p)}`);
    // Each part on its own, and her lore entry by entry.
    expect(p.quotable).toEqual([
      'DESCRIPTION Mira meets Sam.', 'PERSONALITY', 'FIRSTMES', 'GREETING-ONE', 'GREETING-TWO', 'EXAMPLES', 'SCENARIO',
      'LORE-CONSTANT', 'LORE-BY-NICKNAME', 'LORE-BY-NAME', 'DEPTHPROMPT'
    ]);
    expect(p.quotable.join('\n')).not.toContain('Description:');
  });

  it('the system prompt is the fixed text, anchors included', () => {
    expect(p.system).toBe(READER_TEXT.system.join('\n'));
    expect(p.system).toContain('a tsundere is aloof');
  });
});

describe('the budgets', () => {
  it(`mes_example: the first ${READER_EXAMPLE_CHARS}; lore: ${READER_LORE_CHARS}; depth_prompt: ${READER_DEPTH_PROMPT_CHARS}`, () => {
    const c = { ...full, mes_example: 'e'.repeat(5000), extensions: { depth_prompt: { prompt: 'p'.repeat(5000) } } };
    c.character_book = { ...full.character_book!, entries: [{ ...full.character_book!.entries[1]!, content: 'l'.repeat(9000) }] };
    const p = readerPrompt(c, user);
    const len = (f: string) => p.parts.find((x) => x.field === f)!.text.length;
    expect([len('mes_example'), len('lore'), len('depth_prompt')]).toEqual([READER_EXAMPLE_CHARS, READER_LORE_CHARS, READER_DEPTH_PROMPT_CHARS]);
  });

  it(`${READER_TOTAL_CHARS} in all, the description first: a huge description leaves no room for the rest`, () => {
    const p = readerPrompt({ ...full, description: 'd'.repeat(1024 * 1024) }, user);
    expect(sentCardText(p).length).toBeLessThanOrEqual(READER_TOTAL_CHARS);
    expect(sentCardText(p).length).toBeGreaterThan(READER_TOTAL_CHARS - 20);
    expect(p.parts.map((x) => x.field)).toEqual(['description']);
  });

  it('the personality comes before everything after it when the room runs short', () => {
    const p = readerPrompt({ ...full, description: 'd'.repeat(READER_TOTAL_CHARS - 200), personality: 'q'.repeat(400) }, user);
    expect(p.parts.map((x) => x.field)).toEqual(['description', 'personality']);
    expect(sentCardText(p).length).toBeLessThanOrEqual(READER_TOTAL_CHARS);
  });

  it('every fixture card stays inside the budget', () => {
    for (const path of ['cards/v1-orrin.json', 'cards/v2-pell.json', 'cards/v3-tamsin.json', 'hostile/injection.json', 'trait-styles/wpp.json']) {
      expect(sentCardText(readerPrompt(card(path), user)).length, path).toBeLessThanOrEqual(READER_TOTAL_CHARS);
    }
  });

  it('a string depth_prompt is read too', () => {
    const p = readerPrompt({ ...full, extensions: { depth_prompt: 'NOTE' } }, user);
    expect(p.parts.at(-1)).toEqual({ field: 'depth_prompt', text: 'NOTE' });
  });
});

describe('the tool', () => {
  it('is set_traits, with the five fields and nothing else allowed', () => {
    expect(SET_TRAITS_TOOL.name).toBe('set_traits');
    const schema = SET_TRAITS_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(['sociability', 'closeness', 'lively', 'interests', 'evidence']);
    expect(schema.required).toEqual(['sociability', 'closeness', 'lively', 'interests', 'evidence']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties['sociability']!.enum).toEqual(['reserved', 'even', 'outgoing', 'unsure']);
    expect(schema.properties['closeness']!.enum).toEqual(['aloof', 'warm', 'clingy', 'unsure']);
    expect(schema.properties['lively']!.enum).toEqual(['morning', 'any', 'night', 'unsure']);
  });
});

describe('the reader text and its version', () => {
  it('a change to reader-text.json comes with a new READER_VERSION', () => {
    // When this fails: bump READER_VERSION in src/traits/reader.ts, then put the new hash and version here.
    // Line ends normalized, so a Windows checkout hashes the same.
    const text = readFileSync(join(import.meta.dirname, '..', 'src', 'traits', 'reader-text.json'), 'utf8').replaceAll('\r\n', '\n');
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    expect({ version: READER_VERSION, hash }).toEqual({ version: 1, hash: PINNED_HASH });
  });

  it('a card with no fields to send still makes a question', () => {
    const r = readCard(JSON.stringify({ name: 'Empty' }));
    const p = readerPrompt(r.ok ? r.card : makeCard(), user);
    expect(p.parts).toEqual([]);
    expect(p.user).toBe('The card for Empty:\n\n');
  });
});

const PINNED_HASH = '4f21a71f588d345d';
