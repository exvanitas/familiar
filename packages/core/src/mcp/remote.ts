// Remote servers: the SDK's Streamable HTTP and legacy SSE client transports, each with the fetch passed
// in. In the app that fetch is the guarded fetch for the server's saved address, which reaches only that
// address and swaps the key placeholder for the stored key. Core never sees a key.

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { RunTransport } from './process-transport.ts';
import type { Failure } from './types.ts';
import { exitFailure, remoteFailure } from './words.ts';

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

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export function remoteHeaders(target: RemoteTarget): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of target.headers) h[k] = v;
  if (target.key) h[target.key.header] = `${target.key.prefix}${KEY_PLACEHOLDER}`;
  return h;
}

/** A remote server's transport. It closes only when the SDK's transport does. */
export class RemoteTransport implements RunTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly inner: Transport;
  private started: Promise<void> | undefined;

  constructor(target: RemoteTarget, fetch: FetchLike) {
    const url = new URL(target.url);
    const requestInit: RequestInit = { headers: remoteHeaders(target) };
    this.inner = target.transport === 'sse'
      ? new SSEClientTransport(url, { fetch, requestInit })
      : new StreamableHTTPClientTransport(url, { fetch, requestInit });
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = e => this.onerror?.(e);
    this.inner.onmessage = m => this.onmessage?.(m);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    this.started ??= this.inner.start();
    return this.started;
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  failure(error?: unknown): Failure {
    return error === undefined ? exitFailure(undefined, undefined) : remoteFailure(error);
  }

  lastOutput(): string | undefined {
    return undefined;
  }
}
