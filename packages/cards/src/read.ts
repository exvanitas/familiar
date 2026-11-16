// The one door in: a card file's bytes (PNG or JSON), or JSON text, to a typed result. Never throws.
import { Notes } from './fields.ts';
import { MAX_CARD_CHUNK_BYTES, MAX_FILE_BYTES, MAX_JSON_BYTES } from './limits.ts';
import { normalize } from './normalize.ts';
import { cardChunks, isPng, type CardChunk } from './png.ts';
import { decodeBase64, decodeUtf8, parseJson, utf8Length } from './text.ts';
import { toV3Json } from './write.ts';
import type { ReadError, ReadResult } from './types.ts';

const fail = (kind: ReadError['kind'], message: string): ReadResult => ({ ok: false, error: { kind, message } });

export function readCard(input: Uint8Array | string): ReadResult {
  try {
    return typeof input === 'string' ? fromJsonText(input, new Notes()) : fromBytes(input);
  } catch {
    // Nothing above is known to throw; this keeps the promise if something does.
    return fail('not-a-card', "The card couldn't be read.");
  }
}

function fromBytes(bytes: Uint8Array): ReadResult {
  if (bytes.length > MAX_FILE_BYTES) return fail('too-large', `The file is over ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return fail('charx', "This looks like a CHARX file (a zip), which Familiar doesn't read yet. A PNG or JSON card works.");
  }
  if (!isPng(bytes)) {
    if (bytes.length > MAX_JSON_BYTES) return fail('too-large', `The card's JSON is over ${MAX_JSON_BYTES / (1024 * 1024)} MB.`);
    const decoded = decodeUtf8(bytes);
    if (!decoded.ok) return decoded;
    return fromJsonText(decoded.value, new Notes());
  }
  const found = cardChunks(bytes);
  if (!found.ok) return found;
  let firstError: ReadResult | undefined;
  for (const chunk of found.chunks) {
    const notes = new Notes();
    for (const w of found.warnings) notes.add(w.code, w.message);
    const r = fromChunk(chunk, notes);
    if (r.ok) {
      if (firstError) notes.add('fell-back', "The PNG's ccv3 chunk couldn't be read, so its chara chunk was used.");
      return { ...r, avatar: bytes, warnings: notes.warnings };
    }
    firstError ??= r;
  }
  return firstError!;
}

function fromChunk(chunk: CardChunk, notes: Notes): ReadResult {
  if (chunk.text.length > MAX_CARD_CHUNK_BYTES) return fail('too-large', "The PNG's card chunk is too large.");
  const bytes = decodeBase64(chunk.text);
  if (!bytes.ok) return bytes;
  if (bytes.value.length > MAX_JSON_BYTES) return fail('too-large', `The card's JSON is over ${MAX_JSON_BYTES / (1024 * 1024)} MB.`);
  const decoded = decodeUtf8(bytes.value);
  if (!decoded.ok) return decoded;
  return fromJsonText(decoded.value, notes);
}

function fromJsonText(text: string, notes: Notes): ReadResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const n = normalize(parsed.value, notes);
  if (!n.ok) return n;
  // Reading fills in every field, so the canonical form can be bigger than the file. A card is only
  // accepted if what toV3Json writes for it would be read back: anything accepted round-trips.
  if (utf8Length(toV3Json(n.card), MAX_JSON_BYTES) > MAX_JSON_BYTES) {
    return fail('too-large', `Written out in full, the card would be over ${MAX_JSON_BYTES / (1024 * 1024)} MB.`);
  }
  return { ok: true, card: n.card, format: n.format, warnings: notes.warnings };
}
