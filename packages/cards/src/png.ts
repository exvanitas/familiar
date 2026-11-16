// Finds a card's JSON inside a PNG: a walk over the chunks, nothing more. The image itself is never
// decoded. `ccv3` is preferred over `chara`; both hold base64 JSON in a tEXt chunk, or in an
// uncompressed iTXt chunk. zTXt and compressed iTXt are refused: inflating them would need a zlib
// implementation here and a bound on what it expands to, and no card tool writes them.
import { MAX_CARD_CHUNK_BYTES } from './limits.ts';
import { decodeUtf8 } from './text.ts';
import type { ReadError, Warning } from './types.ts';

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CARD_KEYWORDS = ['ccv3', 'chara'] as const;
export type CardKeyword = (typeof CARD_KEYWORDS)[number];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** The text of one card chunk, as found: still base64. */
export interface CardChunk {
  readonly keyword: CardKeyword;
  readonly text: string;
}

export type ChunkResult =
  | { ok: true; chunks: CardChunk[]; warnings: Warning[] }
  | { ok: false; error: ReadError };

const fail = (kind: ReadError['kind'], message: string): { ok: false; error: ReadError } => ({ ok: false, error: { kind, message } });

/** The card chunks, `ccv3` first, at most one of each keyword. */
export function cardChunks(bytes: Uint8Array): ChunkResult {
  if (!isPng(bytes)) return fail('bad-png', "This isn't a PNG.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = new Map<CardKeyword, string>();
  const warnings: Warning[] = [];
  let compressed = false, tooLarge = false, sawEnd = false;
  let at = 8;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) return fail('bad-png', 'The PNG ends inside a chunk.');
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const start = at + 8, end = start + length;
    if (length > 0x7fffffff || end + 4 > bytes.length) return fail('bad-png', 'The PNG ends inside a chunk.');
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const keyword = keywordOf(bytes, start, end);
      if (keyword) {
        if (length > MAX_CARD_CHUNK_BYTES) tooLarge = true;
        else if (crc32(bytes, at + 4, end) !== view.getUint32(end)) return fail('bad-png', "A card chunk's checksum is wrong.");
        else {
          const text = chunkText(type, bytes, start + keyword.length + 1, end);
          if (text === 'compressed') compressed = true;
          else if (text === 'bad-utf8') return fail('bad-utf8', "A card chunk's text isn't valid UTF-8.");
          else if (text === undefined) return fail('bad-png', 'A card chunk is malformed.');
          else if (found.has(keyword)) warnings.push({ code: 'duplicate-chunk', message: `The PNG has more than one ${keyword} chunk; the first was used.` });
          else found.set(keyword, text);
        }
      }
    }
    at = end + 4;
  }
  if (!sawEnd) return fail('bad-png', 'The PNG has no end chunk.');
  const chunks = CARD_KEYWORDS.flatMap((keyword) => (found.has(keyword) ? [{ keyword, text: found.get(keyword)! }] : []));
  if (chunks.length > 0) return { ok: true, chunks, warnings };
  if (tooLarge) return fail('too-large', `The PNG's card chunk is over ${Math.round(MAX_CARD_CHUNK_BYTES / (1024 * 1024))} MB.`);
  if (compressed) return fail('compressed', "The PNG's card is stored compressed (zTXt or compressed iTXt), which Familiar doesn't read yet.");
  return fail('no-card', 'The PNG has no character card in it.');
}

/** The chunk's keyword when it's one a card uses. */
function keywordOf(bytes: Uint8Array, start: number, end: number): CardKeyword | undefined {
  const nul = bytes.subarray(start, Math.min(end, start + 80)).indexOf(0);
  if (nul < 1) return undefined;
  const word = String.fromCharCode(...bytes.subarray(start, start + nul));
  return (CARD_KEYWORDS as readonly string[]).includes(word) ? (word as CardKeyword) : undefined;
}

/**
 * A text chunk's text after its keyword, decoded as PNG says: Latin-1 for tEXt, strict UTF-8 for iTXt
 * (invalid bytes are refused, not read as Latin-1). The card in it is base64, so it should be ASCII.
 */
function chunkText(type: string, bytes: Uint8Array, from: number, end: number): string | 'compressed' | 'bad-utf8' | undefined {
  if (type === 'zTXt') return 'compressed';
  if (type === 'tEXt') return latin1(bytes.subarray(from, end));
  // iTXt: compression flag, method, language tag NUL, translated keyword NUL, text.
  if (from + 2 > end) return undefined;
  if (bytes[from] !== 0) return 'compressed';
  const rest = bytes.subarray(from + 2, end);
  const lang = rest.indexOf(0);
  if (lang < 0) return undefined;
  const translated = rest.indexOf(0, lang + 1);
  if (translated < 0) return undefined;
  const text = decodeUtf8(rest.subarray(translated + 1));
  return text.ok ? text.value : 'bad-utf8';
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

let table: Uint32Array | undefined;

/** CRC-32 as PNG uses it, over bytes[from, to). */
export function crc32(bytes: Uint8Array, from = 0, to = bytes.length): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = from; i < to; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
