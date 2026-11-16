// What a person gets from each kind of card file: the fields read, the avatar, the warnings, and a
// clear error for what can't be read.
import { describe, expect, it } from 'vitest';
import { readCard } from '../src/index.ts';
import { base64, latin1, textChunk, writePng } from './png-write.ts';
import { card, fixtureBytes, readFixture } from './helpers.ts';

describe('JSON cards', () => {
  it('V1: the flat fields, everything else empty', () => {
    const r = readFixture('cards/v1-orrin.json');
    expect(r.ok && r.format).toBe('v1');
    const c = card('cards/v1-orrin.json');
    expect(c.name).toBe('Orrin Vale');
    expect(c.first_mes).toContain('<USER>');
    expect(c.alternate_greetings).toEqual([]);
    expect(c.character_book).toBeUndefined();
    expect(c.extensions).toEqual({});
  });

  it('V2: data fields, greetings, tags, the book and extensions', () => {
    const r = readFixture('cards/v2-pell.json');
    expect(r.ok && r.format).toBe('v2');
    const c = card('cards/v2-pell.json');
    expect(c.name).toBe('Pell Mossbright');
    expect(c.alternate_greetings).toHaveLength(2);
    expect(c.system_prompt).toContain('playful');
    expect(c.post_history_instructions).toContain('Stay in character');
    expect(c.tags).toEqual(['fantasy', 'sprite', 'cheerful']);
    expect(c.character_book?.scan_depth).toBe(3);
    expect(c.character_book?.token_budget).toBe(300);
    expect(c.character_book?.entries.map((e) => e.enabled)).toEqual([true, true, false]);
    expect(c.character_book?.entries[1]?.position).toBe('after_char');
    expect(c.extensions['depth_prompt']).toEqual({ prompt: "{{char}} hums when she's happy.", depth: 4, role: 'system' });
    expect(c.nickname).toBeUndefined();
  });

  it('V3: nickname, multilingual notes, sources, dates, assets, group greetings and regex lore', () => {
    const r = readFixture('cards/v3-tamsin.json');
    expect(r.ok && r.format).toBe('v3');
    const c = card('cards/v3-tamsin.json');
    expect(c.nickname).toBe('Tam');
    expect(c.creator_notes_multilingual).toEqual({ en: "Invented for Familiar's tests.", fr: 'Inventée pour les tests de Familiar.' });
    expect(c.source).toEqual(['https://example.invalid/tamsin']);
    expect([c.creation_date, c.modification_date]).toEqual([1731571200, 1731657600]);
    expect(c.assets).toEqual([{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }]);
    expect(c.group_only_greetings).toHaveLength(1);
    expect(c.character_book?.entries[2]?.use_regex).toBe(true);
    // The decorator stays in the card as written; it's left out where the content is used.
    expect(c.character_book?.entries[2]?.content.startsWith('@@depth 2\n')).toBe(true);
  });

  it('a V3 card with decorators says which, and never quotes the card', () => {
    const r = readFixture('lore/decorators.json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.warnings.find((x) => x.code === 'decorators');
    expect(w?.message).toContain('(activate_only_after, depth, dont_activate, unknown)');
    expect(w?.message).not.toContain('ignore');
  });

  it('a decorator name the spec does not define is reported as unknown, never by its own text', () => {
    for (const name of ['privatecustomername', 'private_customer_name', 'Depthx', 'depth_of_secrets']) {
      const r = readCard(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'D', character_book: { entries: [{ keys: ['k'], content: `@@${name} 3\nx` }] } } }));
      expect(r.ok && r.warnings.map((w) => w.message)).toEqual([expect.stringContaining('(unknown)')]);
      expect(JSON.stringify(r.ok && r.warnings).toLowerCase()).not.toContain(name.toLowerCase());
    }
  });

  it('JSON as text reads the same as JSON as bytes, and a leading BOM is dropped', () => {
    const bytes = fixtureBytes('cards/v2-pell.json');
    const text = new TextDecoder().decode(bytes);
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
    const a = readCard(text), b = readCard(withBom), c = readCard(`\ufeff${text}`);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(b.card).toEqual(a.card);
      expect(c.card).toEqual(a.card);
    }
  });

  it('NULs in text are dropped and lone surrogates replaced', () => {
    const r = readCard(JSON.stringify({ name: 'Nul\u0000Name', description: 'a\u0000b \ud800 c' }));
    expect(r.ok && [r.card.name, r.card.description]).toEqual(['NulName', 'ab \ufffd c']);
  });

  it('an unknown spec_version is read as its spec, with a warning', () => {
    const r = readCard(JSON.stringify({ spec: 'chara_card_v2', spec_version: '9.9', data: { name: 'Ver' } }));
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['spec-version']);
  });
});

describe('PNG cards', () => {
  it('chara (V2): the card, and the file itself as the avatar, untouched', () => {
    const bytes = fixtureBytes('png/chara-v2.png');
    const r = readCard(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe('v2');
    expect(r.card).toEqual(card('cards/v2-pell.json'));
    expect(r.avatar).toBe(bytes);
  });

  it('ccv3 (V3)', () => {
    const r = readFixture('png/ccv3-v3.png');
    expect(r.ok && r.format).toBe('v3');
    expect(r.ok && r.card).toEqual(card('cards/v3-tamsin.json'));
  });

  it('both: ccv3 wins, wherever it is in the file', () => {
    const r = readFixture('png/both.png');
    expect(r.ok && r.card.name).toBe('Tamsin Quill');
    expect(r.ok && r.format).toBe('v3');
  });

  it('chara in an uncompressed iTXt chunk', () => {
    const r = readFixture('png/itxt-chara.png');
    expect(r.ok && r.card).toEqual(card('cards/v2-pell.json'));
  });

  it("an unreadable ccv3 chunk falls back to chara, and says so", () => {
    const r = readFixture('png/ccv3-broken-chara-good.png');
    expect(r.ok && r.card.name).toBe('Pell Mossbright');
    expect(r.ok && r.warnings.map((w) => w.code)).toContain('fell-back');
  });

  it('iTXt text is strict UTF-8: a stray byte is refused, not read as Latin-1 and dropped as whitespace', () => {
    const b64 = base64(JSON.stringify({ name: 'M' }));
    const chunk = (type: 'iTXt' | 'tEXt', text: Uint8Array) => ({
      type, data: Uint8Array.from([...latin1('chara'), 0, ...(type === 'iTXt' ? [0, 0, 0, 0] : []), ...text])
    });
    const stray = Uint8Array.from([0xa0, ...latin1(b64)]);
    expect(readCard(writePng([chunk('iTXt', latin1(b64))])).ok).toBe(true);
    const r = readCard(writePng([chunk('iTXt', stray)]));
    expect(!r.ok && r.error.kind).toBe('bad-utf8');
    // tEXt stays Latin-1, where A0 is a no-break space: not base64 whitespace either, so refused.
    const t = readCard(writePng([chunk('tEXt', stray)]));
    expect(!t.ok && t.error.kind).toBe('bad-base64');
    // Valid UTF-8 that isn't ASCII in an iTXt chunk decodes, then fails as base64.
    const u = readCard(writePng([chunk('iTXt', new TextEncoder().encode(`é${b64}`))]));
    expect(!u.ok && u.error.kind).toBe('bad-base64');
  });

  it('two chara chunks: the first is used, with a warning', () => {
    const png = writePng([textChunk('chara', base64(JSON.stringify({ name: 'First' }))), textChunk('chara', base64(JSON.stringify({ name: 'Second' })))]);
    const r = readCard(png);
    expect(r.ok && r.card.name).toBe('First');
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['duplicate-chunk']);
  });

  it.each([
    ['png/hostile/no-card.png', 'no-card'],
    ['png/hostile/bad-base64.png', 'bad-base64'],
    ['png/hostile/bad-utf8.png', 'bad-utf8'],
    ['png/hostile/bad-json.png', 'bad-json'],
    ['png/hostile/ztxt.png', 'compressed'],
    ['png/hostile/itxt-compressed.png', 'compressed'],
    ['png/hostile/bad-crc.png', 'bad-png'],
    ['png/hostile/no-end.png', 'bad-png'],
    ['png/hostile/truncated.png', 'bad-png'],
    ['png/hostile/charx.charx', 'charx']
  ])('%s is refused as %s, with plain words', (path, kind) => {
    const r = readFixture(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe(kind);
    expect(r.error.message.length).toBeGreaterThan(10);
  });

  it('a chunk that claims more bytes than the file has is refused, not read past the end', () => {
    const png = writePng([textChunk('chara', base64(JSON.stringify({ name: 'X' })))]);
    const view = new DataView(png.buffer);
    view.setUint32(33, 0x7ffffff0); // the tEXt chunk's length, right after the signature and IHDR
    const r = readCard(png);
    expect(!r.ok && r.error.kind).toBe('bad-png');
  });
});

describe('JSON that is not a card', () => {
  it.each([
    ['hostile/not-a-card.json', 'not-a-card'],
    ['hostile/no-name.json', 'not-a-card'],
    ['hostile/deep.json', 'too-deep'],
    ['hostile/bad-utf8.json', 'bad-utf8']
  ])('%s is refused as %s', (path, kind) => {
    const r = readFixture(path);
    expect(!r.ok && r.error.kind).toBe(kind);
  });

  it.each(['', 'null', '[]', '"a string"', '42', '{', 'not json at all'])('%j is refused, not thrown', (text) => {
    const r = readCard(text);
    expect(r.ok).toBe(false);
  });
});
