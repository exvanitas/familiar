// Round-trip: read, normalize, write canonical V3, read again gives the same card, for every fixture
// that reads. Every fixture is accounted for: it reads, or it's on the list of refusals.
import { describe, expect, it } from 'vitest';
import { readCard, toV3Json } from '../src/index.ts';
import { pngFixtures } from './png-fixtures.ts';
import { allFixtures, readFixture } from './helpers.ts';

/** Fixtures that are refused on purpose, by the error they get (read.test.ts checks each). */
const REFUSED: Record<string, string> = {
  'hostile/bad-utf8.json': 'bad-utf8',
  'hostile/deep.json': 'too-deep',
  'hostile/no-name.json': 'not-a-card',
  'hostile/not-a-card.json': 'not-a-card',
  'png/hostile/bad-base64.png': 'bad-base64',
  'png/hostile/bad-crc.png': 'bad-png',
  'png/hostile/bad-json.png': 'bad-json',
  'png/hostile/bad-utf8.png': 'bad-utf8',
  'png/hostile/charx.charx': 'charx',
  'png/hostile/itxt-compressed.png': 'compressed',
  'png/hostile/no-card.png': 'no-card',
  'png/hostile/no-end.png': 'bad-png',
  'png/hostile/truncated.png': 'bad-png',
  'png/hostile/ztxt.png': 'compressed'
};

const fixtures = allFixtures();

describe('every fixture', () => {
  it('there are fixtures of every kind', () => {
    for (const dir of ['cards/', 'lore/', 'hostile/', 'trait-styles/', 'png/']) expect(fixtures.some((f) => f.startsWith(dir)), dir).toBe(true);
  });

  for (const path of fixtures) {
    if (REFUSED[path]) {
      it(`${path} is refused as ${REFUSED[path]}`, () => {
        const r = readFixture(path);
        expect(!r.ok && r.error.kind).toBe(REFUSED[path]);
      });
      continue;
    }
    it(`${path} round-trips`, () => {
      const first = readFixture(path);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const written = toV3Json(first.card);
      const second = readCard(written);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.format).toBe('v3');
      expect(second.card).toEqual(first.card);
      // Canonical: writing the read-back card gives the same text.
      expect(toV3Json(second.card)).toBe(written);
    });
  }
});

describe('the built fixtures', () => {
  it('two builds of the same input are identical, byte for byte', () => {
    const a = pngFixtures(), b = pngFixtures();
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [path, bytes] of a) expect(Buffer.from(bytes).equals(Buffer.from(b.get(path)!)), path).toBe(true);
  });

  it('none is committed: there is no image under fixtures/', () => {
    const committed = allFixtures().filter((f) => !pngFixtures().has(f));
    expect(committed.filter((f) => /\.(png|apng|jpe?g|webp|gif|charx)$/i.test(f))).toEqual([]);
  });
});

describe('canonical JSON', () => {
  it('sorts extension keys at every depth, so key order in the file never changes the text', () => {
    const a = readCard(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'K', extensions: { b: 1, a: { d: 1, c: 2 } } } }));
    const b = readCard(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'K', extensions: { a: { c: 2, d: 1 }, b: 1 } } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(toV3Json(a.card)).toBe(toV3Json(b.card));
  });
});
