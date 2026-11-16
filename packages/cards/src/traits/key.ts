// The reader's cache key: the reader's version and the SHA-256 of the card's canonical V3 JSON. The
// digest is injected (the webview's crypto.subtle, Node's in tests), so this package stays plain.
import type { Card } from '../types.ts';
import { toV3Json } from '../write.ts';
import { READER_VERSION } from './reader.ts';

/** SHA-256 of the bytes. `crypto.subtle.digest('SHA-256', bytes)` fits. */
export type Digest = (bytes: Uint8Array) => Promise<ArrayBuffer | Uint8Array>;

export async function traitCacheKey(card: Card, digest: Digest): Promise<string> {
  const hash = new Uint8Array(await digest(new TextEncoder().encode(toV3Json(card))));
  return `traits-v${READER_VERSION}:${[...hash].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
