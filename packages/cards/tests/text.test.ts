// Cleaning and measuring text: idempotent, and the byte count matches an encoder's.
import { describe, expect, it } from 'vitest';
import { readCard, toV3Json } from '../src/index.ts';
import { cleanText, utf8Length } from '../src/text.ts';
import { seeded } from './helpers.ts';

const PIECES = ['\u0000', '﻿', '\ud83d', '\ude00', '😀', 'a', ' ', 'é', '界'];
const randomText = (rand: () => number) => Array.from({ length: Math.floor(rand() * 12) }, () => PIECES[Math.floor(rand() * PIECES.length)]).join('');

describe('cleanText', () => {
  it('is idempotent: clean(clean(x)) is clean(x)', () => {
    const rand = seeded(8);
    for (let i = 0; i < 5000; i++) {
      const x = randomText(rand);
      expect(cleanText(cleanText(x)), JSON.stringify(x)).toBe(cleanText(x));
    }
  });

  it.each([
    ['﻿﻿hello', 'hello'],
    ['\u0000﻿hello', 'hello'],
    ['\ud83d\u0000\ude00', '😀']
  ])('%j cleans to %j, and the card round-trips', (raw, clean) => {
    expect(cleanText(raw)).toBe(clean);
    const first = readCard(JSON.stringify({ name: 'C', description: raw }));
    expect(first.ok && first.card.description).toBe(clean);
    const again = first.ok ? readCard(toV3Json(first.card)) : first;
    expect(again.ok && first.ok && again.card).toEqual(first.ok && first.card);
  });
});

describe('utf8Length', () => {
  it('matches TextEncoder, lone surrogates (written as U+FFFD) included', () => {
    const rand = seeded(9);
    for (let i = 0; i < 2000; i++) {
      const x = randomText(rand);
      expect(utf8Length(x), JSON.stringify(x)).toBe(new TextEncoder().encode(x).length);
    }
  });

  it('stops once past the limit it is checking', () => {
    expect(utf8Length('a'.repeat(1000), 10)).toBe(11);
  });
});
