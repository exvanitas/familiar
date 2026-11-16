// The PNG fixtures, built in memory from the JSON ones each time the tests run. None is committed:
// a character-card PNG is an image with metadata (its text chunks), which the repo's privacy scan refuses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ascii, base64, itxtChunk, textChunk, writePng, ztxtChunk, type RawChunk } from './png-write.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const json = (path: string) => readFileSync(join(fixtures, path), 'utf8');

/** The same card as V2, for the `chara` chunk next to a `ccv3` one. */
function asV2(v3text: string): string {
  const card = JSON.parse(v3text) as { data: Record<string, unknown> };
  return JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { ...card.data, name: `${card.data['name'] as string} (V2 copy)` } });
}

/** Every built fixture, by the path the tests name it with (as if under fixtures/). */
export function pngFixtures(): Map<string, Uint8Array> {
  const pell = json('cards/v2-pell.json');
  const tamsin = json('cards/v3-tamsin.json');
  const out = new Map<string, Uint8Array>();
  const png = (path: string, chunks: RawChunk[], options?: { end?: boolean }) => out.set(path, writePng(chunks, options));
  png('png/chara-v2.png', [textChunk('chara', base64(pell))]);
  png('png/ccv3-v3.png', [textChunk('ccv3', base64(tamsin))]);
  // Both: ccv3 is read. The chara chunk comes first in the file, as some tools write it.
  png('png/both.png', [textChunk('chara', base64(asV2(tamsin))), textChunk('ccv3', base64(tamsin))]);
  png('png/itxt-chara.png', [itxtChunk('chara', base64(pell))]);
  // A ccv3 chunk that's broken, beside a good chara chunk: the chara one is used, with a warning.
  png('png/ccv3-broken-chara-good.png', [textChunk('ccv3', '%%% not base64 %%%'), textChunk('chara', base64(pell))]);
  png('png/hostile/no-card.png', [textChunk('Comment', 'just a picture')]);
  png('png/hostile/bad-base64.png', [textChunk('chara', '%%% not base64 %%%')]);
  png('png/hostile/bad-utf8.png', [textChunk('chara', btoa(String.fromCharCode(0x7b, 0x22, 0x6e, 0xff, 0xfe, 0x22, 0x7d)))]);
  png('png/hostile/bad-json.png', [textChunk('chara', base64('{"spec": "chara_card_v2", "data": {'))]);
  png('png/hostile/ztxt.png', [ztxtChunk('chara', Uint8Array.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]))]);
  png('png/hostile/itxt-compressed.png', [itxtChunk('chara', 'eJwDAAAAAAE=', true)]);
  png('png/hostile/bad-crc.png', [{ ...textChunk('chara', base64(pell)), crc: 0x12345678 }]);
  png('png/hostile/no-end.png', [textChunk('chara', base64(pell))], { end: false });
  // Truncated: a good card PNG cut part way through its card chunk.
  const whole = writePng([textChunk('chara', base64(pell))]);
  out.set('png/hostile/truncated.png', whole.subarray(0, 60));
  // Not a PNG and not JSON: a zip's signature, as a CHARX file starts.
  out.set('png/hostile/charx.charx', Uint8Array.from([...ascii('PK'), 3, 4, 20, 0, 0, 0]));
  return out;
}

