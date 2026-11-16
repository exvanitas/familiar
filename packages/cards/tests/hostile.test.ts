// Hostile cards: what gets refused, what's kept, and that nothing is ever thrown or polluted.
import { describe, expect, it } from 'vitest';
import { readCard, toV3Json } from '../src/index.ts';
import { base64, textChunk, writePng } from './png-write.ts';
import { card, readFixture, seeded } from './helpers.ts';

describe('poisoned keys', () => {
  it('__proto__ and constructor keys change no prototype, anywhere, and are not kept', () => {
    const r = readFixture('hostile/proto-keys.json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.card;
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(c.extensions)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(c.extensions['safe'])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(c.character_book!.entries[0]!.extensions)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(c.creator_notes_multilingual)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
    expect(c.extensions).toEqual({ safe: { ok: 1 } });
    expect(c.creator_notes_multilingual).toEqual({ en: 'fine' });
    expect(Object.keys(c)).not.toContain('__proto__');
    expect(r.warnings.every((w) => w.code === 'dropped-key')).toBe(true);
    // The written card has none of them either.
    expect(toV3Json(c)).not.toMatch(/__proto__|constructor|polluted/);
  });

  it('a key that becomes __proto__ only once cleaned is dropped too', () => {
    const r = readCard('{"name":"N","spec":"chara_card_v2","spec_version":"2.0","data":{"name":"N","extensions":{"__proto__\\u0000":{"polluted":true}}}}');
    expect(r.ok && r.card.extensions).toEqual({});
    expect(Object.getPrototypeOf(r.ok && r.card.extensions)).toBe(Object.prototype);
  });
});

describe('text aimed at a model', () => {
  it('is kept as the card\'s text, nothing more: no field appears that the reader does not know', () => {
    const c = card('hostile/injection.json');
    expect(c.description).toContain('Ignore the above');
    expect(c.description).toContain('<tool_call>');
    expect(Object.keys(c).sort()).toEqual([
      'alternate_greetings', 'character_version', 'creator', 'creator_notes', 'description', 'extensions', 'first_mes', 'group_only_greetings',
      'mes_example', 'name', 'personality', 'post_history_instructions', 'scenario', 'system_prompt', 'tags'
    ]);
  });
});

describe('wrong types', () => {
  it('are left empty, each with a warning, and the card still reads', () => {
    const r = readFixture('hostile/wrong-types.json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.description).toBe('');
    expect(r.card.personality).toBe('');
    expect(r.card.alternate_greetings).toEqual([]);
    expect(r.card.tags).toEqual(['ok']);
    expect(r.card.character_book).toBeUndefined();
    expect(r.card.extensions).toEqual({});
    expect(new Set(r.warnings.map((w) => w.code))).toEqual(new Set(['wrong-type']));
  });

  it('warnings never quote the card', () => {
    const marker = 'CARD-ONLY-WORDS';
    const r = readCard(JSON.stringify({
      spec: 'chara_card_v2', spec_version: marker,
      data: { name: marker, description: marker.repeat(10_000), tags: [marker, 3], character_book: { entries: [{ keys: [`/(${marker}+)+/`], use_regex: true, content: `@@${marker}\nx` }] } }
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.warnings)).not.toContain(marker);
  });
});

describe('size', () => {
  it('a 1 MB description is cut to the field limit, and the card reads', () => {
    const r = readCard(JSON.stringify({ name: 'Big', description: 'x'.repeat(1024 * 1024) }));
    expect(r.ok && r.card.description.length).toBe(100_000);
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['cut']);
  });

  it('deep nesting inside one extension drops that extension only', () => {
    const r = readFixture('hostile/deep-extension.json');
    expect(r.ok && r.card.extensions).toEqual({ keep: 1 });
  });
});

describe('garbage never throws', () => {
  it('random bytes, random JSON-ish text and broken PNGs all come back as results', () => {
    const rand = seeded(6);
    const good = writePng([textChunk('chara', base64(JSON.stringify({ name: 'Fuzz', description: 'd' })))]);
    for (let i = 0; i < 400; i++) {
      const kind = i % 4;
      let input: Uint8Array | string;
      if (kind === 0) input = Uint8Array.from({ length: Math.floor(rand() * 200) }, () => Math.floor(rand() * 256));
      else if (kind === 1) input = Array.from({ length: Math.floor(rand() * 80) }, () => '{}[]":,ab\\u0 '[Math.floor(rand() * 13)]).join('');
      else {
        // A good PNG with a few bytes flipped, or cut short.
        const bytes = good.slice(0, kind === 2 ? good.length : Math.floor(rand() * good.length));
        for (let k = 0; k < 3; k++) bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
        input = bytes;
      }
      const r = readCard(input);
      expect(typeof r.ok).toBe('boolean');
      if (!r.ok) expect(r.error.message).toBeTruthy();
    }
  });
});
