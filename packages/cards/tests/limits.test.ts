// Each limit in src/limits.ts, at its edge: at the limit is kept, one past is cut, dropped or refused.
import { describe, expect, it } from 'vitest';
import {
  compileKey, DEFAULT_SCAN_DEPTH, MAX_ASSETS, MAX_CARD_CHUNK_BYTES, MAX_EXTENSION_BYTES, MAX_EXTENSION_DEPTH, MAX_FIELD_CHARS, MAX_FILE_BYTES,
  MAX_GREETINGS, MAX_JSON_BYTES, MAX_KEY_CHARS, MAX_JSON_DEPTH, MAX_KEYS_PER_ENTRY, MAX_LANGUAGES, MAX_LORE_ENTRIES, MAX_REGEX_CHARS, MAX_SCAN_CHARS,
  MAX_SCAN_DEPTH, MAX_SHORT_CHARS, MAX_TAGS, prepareLorebook, readCard, scanText, toV3Json, type ReadResult
} from '../src/index.ts';
import { textChunk, writePng } from './png-write.ts';

const v2 = (data: Record<string, unknown>) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Limit', ...data } });
const v3 = (data: Record<string, unknown>) => JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Limit', ...data } });
const ok = (r: ReadResult) => {
  if (!r.ok) throw new Error(`refused: ${r.error.kind}`);
  return r;
};
const codes = (r: ReadResult) => (r.ok ? r.warnings.map((w) => w.code) : []);
const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);

describe('sizes', () => {
  it('MAX_FILE_BYTES: a bigger file is refused before anything is read', () => {
    const r = readCard(new Uint8Array(MAX_FILE_BYTES + 1));
    expect(!r.ok && r.error.kind).toBe('too-large');
  });

  it('MAX_JSON_BYTES: JSON over it is refused, as bytes or as text', () => {
    const big = v2({ description: 'x'.repeat(MAX_JSON_BYTES) });
    expect(!readCard(big).ok && (readCard(big) as { error: { kind: string } }).error.kind).toBe('too-large');
    const r = readCard(new TextEncoder().encode(big));
    expect(!r.ok && r.error.kind).toBe('too-large');
  });

  it('MAX_JSON_BYTES holds for the card as written too: a card whose canonical JSON would not read back is refused', () => {
    // 2,000 entries of 4,000 characters: under the limit as written (no defaults), over it once every field is filled in.
    const entries = (n: number, size: number) => Array.from({ length: n }, () => ({ content: 'a'.repeat(size) }));
    const over = v3({ character_book: { entries: entries(2000, 4000) } });
    expect(new TextEncoder().encode(over).length).toBeLessThan(MAX_JSON_BYTES);
    const r = readCard(over);
    expect(!r.ok && r.error).toEqual({ kind: 'too-large', message: expect.stringContaining('Written out in full') });
    // Near the limit and accepted: it round-trips, and its written form is inside the limit.
    const near = ok(readCard(v3({ character_book: { entries: entries(2000, 3950) } })));
    const written = toV3Json(near.card);
    expect(new TextEncoder().encode(written).length).toBeLessThanOrEqual(MAX_JSON_BYTES);
    expect(new TextEncoder().encode(written).length).toBeGreaterThan(MAX_JSON_BYTES - 200_000);
    expect(ok(readCard(written)).card).toEqual(near.card);
  });

  it('MAX_CARD_CHUNK_BYTES: a bigger card chunk is refused', () => {
    const png = writePng([textChunk('chara', 'A'.repeat(MAX_CARD_CHUNK_BYTES + 1))]);
    const r = readCard(png);
    expect(!r.ok && r.error.kind).toBe('too-large');
  });

  it('MAX_JSON_DEPTH: at the limit reads, one deeper is refused', () => {
    // The card itself takes 3 levels (top, data, extensions).
    const at = v2({ extensions: { x: nest(MAX_JSON_DEPTH - 3) } });
    const past = v2({ extensions: { x: nest(MAX_JSON_DEPTH - 2) } });
    expect(readCard(at).ok).toBe(true);
    const r = readCard(past);
    expect(!r.ok && r.error.kind).toBe('too-deep');
  });
});

describe('fields', () => {
  it('MAX_FIELD_CHARS: a field at the limit is whole, one longer is cut, with a warning that names the field', () => {
    const at = ok(readCard(v2({ description: 'd'.repeat(MAX_FIELD_CHARS) })));
    expect(at.card.description).toHaveLength(MAX_FIELD_CHARS);
    expect(codes(at)).toEqual([]);
    const past = ok(readCard(v2({ description: 'd'.repeat(MAX_FIELD_CHARS + 1) })));
    expect(past.card.description).toHaveLength(MAX_FIELD_CHARS);
    expect(past.warnings).toEqual([{ code: 'cut', message: expect.stringContaining('The description') }]);
  });

  it('a cut never splits a surrogate pair, so a cut card still round-trips', () => {
    const r = ok(readCard(v2({ description: `${'d'.repeat(MAX_FIELD_CHARS - 1)}\u{1F600}tail` })));
    expect(r.card.description).toHaveLength(MAX_FIELD_CHARS - 1);
    const again = ok(readCard(toV3Json(r.card)));
    expect(again.card).toEqual(r.card);
  });

  it('MAX_SHORT_CHARS: names, tags and the like', () => {
    const r = ok(readCard(v2({ name: 'n'.repeat(MAX_SHORT_CHARS + 1), tags: ['t'.repeat(MAX_SHORT_CHARS + 1)] })));
    expect(r.card.name).toHaveLength(MAX_SHORT_CHARS);
    expect(r.card.tags[0]).toHaveLength(MAX_SHORT_CHARS);
  });

  it.each([
    ['MAX_GREETINGS', 'alternate_greetings', MAX_GREETINGS, 'v2'],
    ['MAX_GREETINGS (group)', 'group_only_greetings', MAX_GREETINGS, 'v3'],
    ['MAX_TAGS', 'tags', MAX_TAGS, 'v2']
  ] as const)('%s: a longer list is cut, with a warning', (_, field, max, spec) => {
    const make = spec === 'v2' ? v2 : v3;
    const at = ok(readCard(make({ [field]: Array.from({ length: max }, (_, i) => `g${i}`) })));
    expect(at.card[field]).toHaveLength(max);
    const past = ok(readCard(make({ [field]: Array.from({ length: max + 1 }, (_, i) => `g${i}`) })));
    expect(past.card[field]).toHaveLength(max);
    expect(codes(past)).toEqual(['too-many']);
  });

  it('MAX_ASSETS and MAX_LANGUAGES', () => {
    const r = ok(readCard(v3({
      assets: Array.from({ length: MAX_ASSETS + 1 }, (_, i) => ({ type: 'icon', uri: 'ccdefault:', name: `a${i}`, ext: 'png' })),
      creator_notes_multilingual: Object.fromEntries(Array.from({ length: MAX_LANGUAGES + 1 }, (_, i) => [`l${i}`, 'note']))
    })));
    expect(r.card.assets).toHaveLength(MAX_ASSETS);
    expect(Object.keys(r.card.creator_notes_multilingual!)).toHaveLength(MAX_LANGUAGES);
    expect(codes(r)).toEqual(['too-many', 'too-many']);
  });
});

describe('the lorebook', () => {
  it('MAX_LORE_ENTRIES: more entries are dropped, with a warning', () => {
    const entries = Array.from({ length: MAX_LORE_ENTRIES + 1 }, (_, i) => ({ keys: [`k${i}`], content: 'c', enabled: true, insertion_order: i }));
    const r = ok(readCard(v2({ character_book: { entries } })));
    expect(r.card.character_book!.entries).toHaveLength(MAX_LORE_ENTRIES);
    expect(codes(r)).toEqual(['too-many']);
  });

  it('MAX_KEYS_PER_ENTRY', () => {
    const keys = Array.from({ length: MAX_KEYS_PER_ENTRY + 1 }, (_, i) => `k${i}`);
    const r = ok(readCard(v2({ character_book: { entries: [{ keys, secondary_keys: keys, content: 'c', enabled: true, insertion_order: 0 }] } })));
    expect(r.card.character_book!.entries[0]!.keys).toHaveLength(MAX_KEYS_PER_ENTRY);
    expect(r.card.character_book!.entries[0]!.secondary_keys).toHaveLength(MAX_KEYS_PER_ENTRY);
  });

  it('MAX_KEY_CHARS: a longer key is dropped whole, never cut into another pattern', () => {
    const keys = ['k'.repeat(MAX_KEY_CHARS), 'k'.repeat(MAX_KEY_CHARS + 1), 'short'];
    const r = ok(readCard(v2({ character_book: { entries: [{ keys, content: 'c', enabled: true, insertion_order: 0 }] } })));
    expect(r.card.character_book!.entries[0]!.keys.map((k) => k.length)).toEqual([MAX_KEY_CHARS, 5]);
    expect(codes(r)).toEqual(['cut']);
  });

  it('MAX_SCAN_DEPTH clamps scan_depth, and DEFAULT_SCAN_DEPTH is used when a book has none', () => {
    const deep = ok(readCard(v2({ character_book: { scan_depth: 500, entries: [] } })));
    expect(deep.card.character_book!.scan_depth).toBe(MAX_SCAN_DEPTH);
    const none = ok(readCard(v2({ character_book: { entries: [] } })));
    expect(prepareLorebook(none.card.character_book!).scanDepth).toBe(DEFAULT_SCAN_DEPTH);
  });

  it('MAX_SCAN_CHARS: the scanned text is the newest characters, at most this many', () => {
    const old = 'o'.repeat(MAX_SCAN_CHARS);
    const text = scanText([{ content: old }, { content: 'newest' }], 2);
    expect(text).toHaveLength(MAX_SCAN_CHARS);
    expect(text.endsWith('\nnewest')).toBe(true);
  });

  it('MAX_REGEX_CHARS: a longer key is refused', () => {
    expect(compileKey(`/${'a'.repeat(MAX_REGEX_CHARS - 2)}/`, false).ok).toBe(true);
    expect(compileKey(`/${'a'.repeat(MAX_REGEX_CHARS - 1)}/`, false)).toEqual({ ok: false, why: 'too-long' });
  });
});

describe('extensions', () => {
  it('MAX_EXTENSION_DEPTH: an extension nested deeper is dropped alone; the rest are kept', () => {
    const r = ok(readCard(v2({ extensions: { keep: nest(MAX_EXTENSION_DEPTH), drop: nest(MAX_EXTENSION_DEPTH + 1), other: 1 } })));
    expect(Object.keys(r.card.extensions).sort()).toEqual(['keep', 'other']);
    expect(codes(r)).toEqual(['extension-dropped']);
  });

  it('MAX_EXTENSION_BYTES counts UTF-8 bytes, not characters', () => {
    // As JSON a string is its quotes and its bytes: three bytes for each 界.
    const at = '界'.repeat(Math.floor((MAX_EXTENSION_BYTES - 2) / 3)) + 'a'.repeat((MAX_EXTENSION_BYTES - 2) % 3);
    expect(new TextEncoder().encode(JSON.stringify(at)).length).toBe(MAX_EXTENSION_BYTES);
    expect(ok(readCard(v2({ extensions: { at } }))).card.extensions).toEqual({ at });
    const past = ok(readCard(v2({ extensions: { past: `${at}a`, other: 1 } })));
    expect(past.card.extensions).toEqual({ other: 1 });
    expect(codes(past)).toEqual(['extension-dropped']);
    expect(ok(readCard(v2({ extensions: { big: '界'.repeat(100_000) } }))).card.extensions).toEqual({});
  });

  it('MAX_EXTENSION_BYTES: an extension bigger as JSON is dropped alone', () => {
    const r = ok(readCard(v2({ extensions: { big: 'x'.repeat(MAX_EXTENSION_BYTES), small: 'y' } })));
    expect(r.card.extensions).toEqual({ small: 'y' });
    expect(codes(r)).toEqual(['extension-dropped']);
  });
});
