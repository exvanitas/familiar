// Writes tiny PNG cards in memory: a 1x1 image with text chunks before its end. For the tests only:
// no PNG is committed, since a card PNG is an image carrying metadata. Card export comes later.
import { crc32, PNG_SIGNATURE } from '../src/png.ts';

/** A valid 1x1 transparent PNG's IHDR and IDAT, so the fixtures open in any viewer. */
const IHDR = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const IDAT = Uint8Array.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01]);

export interface RawChunk {
  readonly type: string;
  readonly data: Uint8Array;
  /** Writes this CRC instead of the right one. */
  readonly crc?: number;
}

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const ascii = latin1;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function textChunk(keyword: string, text: string): RawChunk {
  return { type: 'tEXt', data: concat(latin1(keyword), Uint8Array.of(0), latin1(text)) };
}

/** iTXt: keyword, NUL, compression flag, method, language NUL, translated keyword NUL, text. */
export function itxtChunk(keyword: string, text: string, compressed = false): RawChunk {
  return { type: 'iTXt', data: concat(latin1(keyword), Uint8Array.of(0, compressed ? 1 : 0, 0, 0, 0), new TextEncoder().encode(text)) };
}

export function ztxtChunk(keyword: string, deflated: Uint8Array): RawChunk {
  return { type: 'zTXt', data: concat(latin1(keyword), Uint8Array.of(0, 0), deflated) };
}

export function chunkBytes(c: RawChunk): Uint8Array {
  const out = new Uint8Array(12 + c.data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, c.data.length);
  out.set(latin1(c.type), 4);
  out.set(c.data, 8);
  view.setUint32(8 + c.data.length, c.crc ?? crc32(out, 4, 8 + c.data.length));
  return out;
}

/** A PNG: signature, IHDR, the given chunks, IDAT, IEND. `end: false` leaves IEND off. */
export function writePng(chunks: readonly RawChunk[], options: { end?: boolean } = {}): Uint8Array {
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunkBytes({ type: 'IHDR', data: IHDR }),
    ...chunks.map(chunkBytes),
    chunkBytes({ type: 'IDAT', data: IDAT }),
    ...(options.end === false ? [] : [chunkBytes({ type: 'IEND', data: new Uint8Array(0) })])
  ];
  return concat(...parts);
}

export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
