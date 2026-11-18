// Remote servers' headers. The key never passes through core: a key-holding server gets the placeholder in
// its key header, and the exe's guarded fetch swaps it for the stored key, for that saved address only.

/** What a key-holding server gets in its key header: the exe swaps it for the stored key. Must equal
    PLACEHOLDER in apps/desktop/src/net.ts (a test there checks). */
export const KEY_PLACEHOLDER = 'familiar-stored-key';

/** The headers the exe swaps the placeholder in. A key anywhere else would go out as the placeholder. */
export const KEY_HEADERS: readonly string[] = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];

export interface RemoteTarget {
  readonly url: string;
  readonly transport: 'http' | 'sse';
  /** Plain headers, sent as they are. */
  readonly headers: readonly (readonly [string, string])[];
  /** Where the key goes, if the server has one: the header, and what comes before the key in it. */
  readonly key?: { readonly header: string; readonly prefix: string };
}

export function remoteHeaders(target: RemoteTarget): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of target.headers) h[k] = v;
  if (target.key) h[target.key.header] = `${target.key.prefix}${KEY_PLACEHOLDER}`;
  return h;
}
