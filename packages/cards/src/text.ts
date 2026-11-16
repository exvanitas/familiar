// Bytes to text and text to JSON, with the reader's limits. Nothing here throws to its caller.
import { MAX_JSON_BYTES, MAX_JSON_DEPTH } from './limits.ts';
import type { ReadError } from './types.ts';

export type Decoded<T> = { ok: true; value: T } | { ok: false; error: ReadError };

const fail = (kind: ReadError['kind'], message: string): { ok: false; error: ReadError } => ({ ok: false, error: { kind, message } });

/** Strict UTF-8: invalid bytes are refused, not replaced. A leading BOM is dropped. */
export function decodeUtf8(bytes: Uint8Array): Decoded<string> {
  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return fail('bad-utf8', "The card's text isn't valid UTF-8.");
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * What every string from a card goes through: NULs dropped, then every leading BOM, then each lone
 * surrogate replaced. In that order it's idempotent: cleaning a cleaned string changes nothing.
 */
export function cleanText(text: string): string {
  return text.replaceAll('\u0000', '').replace(/^\ufeff+/, '').replace(LONE_SURROGATE, '\ufffd');
}

/**
 * How many bytes `text` takes as UTF-8, counted without encoding it. Stops once past `stopAfter`, so
 * the work is bounded by the limit being checked, not the text.
 */
export function utf8Length(text: string, stopAfter = Infinity): number {
  let n = 0;
  for (let i = 0; i < text.length && n <= stopAfter; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3; // the rest of the BMP, and a lone surrogate (written as U+FFFD, also 3)
  }
  return n;
}

/** The first `max` UTF-16 units, one fewer if that would split a surrogate pair. */
export function sliceText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && /[\ud800-\udbff]/.test(text[max - 1]!) ? max - 1 : max;
  return text.slice(0, Math.max(0, end));
}

/** Base64 (standard alphabet) to bytes. Only ASCII whitespace is allowed between its characters, as atob allows. */
export function decodeBase64(text: string): Decoded<Uint8Array> {
  let binary: string;
  try {
    binary = atob(text.replace(/[\t\n\f\r ]+/g, ''));
  } catch {
    return fail('bad-base64', "The card's data isn't valid base64.");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return { ok: true, value: out };
}

/** How deep a JSON text nests, read without parsing it, stopping once it's past `limit`. */
export function jsonDepth(text: string, limit: number): number {
  let depth = 0, max = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip what it escapes
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth++;
      if (depth > max) max = depth;
      if (max > limit) return max;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return max;
}

/** JSON text to a value, after the size and depth limits. */
export function parseJson(text: string): Decoded<unknown> {
  const clean = text.replace(/^\ufeff/, '');
  // UTF-16 length is at most the UTF-8 byte count, so this bounds the work before encoding.
  if (clean.length > MAX_JSON_BYTES || utf8Length(clean, MAX_JSON_BYTES) > MAX_JSON_BYTES) {
    return fail('too-large', `The card's JSON is over ${MAX_JSON_BYTES / (1024 * 1024)} MB.`);
  }
  if (jsonDepth(clean, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) return fail('too-deep', `The card's JSON nests deeper than ${MAX_JSON_DEPTH} levels.`);
  try {
    return { ok: true, value: JSON.parse(clean) };
  } catch {
    return fail('bad-json', "The card's JSON can't be read.");
  }
}
