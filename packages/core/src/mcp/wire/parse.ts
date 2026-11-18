// A server's answers are untrusted (docs/mcp-design.md 3.10). Everything it sends is checked here before
// it reaches the exchange, the journal or a card: valid JSON, nesting depth at most 64, JSON-RPC 2.0, and
// one shape contract per message kind. Results get their own contracts below. Unknown fields are ignored,
// never trusted, and nothing from a server becomes a header, a URL or a request id (the validated
// session id aside, remote.ts).

import type { RpcId } from './framing.ts';
import { mutant } from '../../mutations.ts';
import { legacyVersion } from './framing.ts';

export const MAX_DEPTH = 64;
export const MAX_METHOD_BYTES = 128;
export const MAX_ID_BYTES = 128;
export const MAX_ERROR_MESSAGE = 1024;
export const MAX_CURSOR_BYTES = 1024;
/** One response or event, for a call or a page. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** The initialize answer. */
export const MAX_HANDSHAKE_BYTES = 64 * 1024;
/** Every event of one exchange, notifications included. */
export const MAX_EXCHANGE_BYTES = 8 * 1024 * 1024;

export type Inbound =
  | { readonly t: 'response'; readonly id: RpcId; readonly result?: Record<string, unknown>; readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown } }
  | { readonly t: 'request'; readonly id: RpcId; readonly method: string; readonly params?: Record<string, unknown> }
  | { readonly t: 'notification'; readonly method: string; readonly params?: Record<string, unknown> };

export class Invalid extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'Invalid';
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v);

function depthOk(v: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => depthOk(x, depth + 1));
  if (isObject(v)) return Object.values(v).every((x) => depthOk(x, depth + 1));
  return true;
}

/** One JSON-RPC message from its text, or a throw of `Invalid`. */
/** At most `n` code units, never ending in half a surrogate pair. */
export function cutText(text: string, n: number): string {
  const s = text.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

export function parseMessage(text: string, maxBytes = MAX_MESSAGE_BYTES): Inbound {
  if (text.length > maxBytes || bytes(text) > maxBytes) throw new Invalid('a message past its size bound');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Invalid('not JSON');
  }
  if (!isObject(v) || !depthOk(v, 1)) throw new Invalid('not a JSON-RPC object within depth 64');
  if (v.jsonrpc !== '2.0') throw new Invalid('not JSON-RPC 2.0');
  const hasId = 'id' in v;
  if (typeof v.method === 'string' || 'method' in v) {
    if (typeof v.method !== 'string' || bytes(v.method) > MAX_METHOD_BYTES) throw new Invalid('a bad method');
    if (v.params !== undefined && !isObject(v.params)) throw new Invalid('params that are not an object');
    if (!hasId) return { t: 'notification', method: v.method, ...(v.params ? { params: v.params } : {}) };
    if (!(typeof v.id === 'string' ? bytes(v.id) <= MAX_ID_BYTES : safeInt(v.id))) throw new Invalid('a bad request id');
    return { t: 'request', id: v.id as RpcId, method: v.method, ...(v.params ? { params: v.params } : {}) };
  }
  if (!hasId || !(typeof v.id === 'string' ? bytes(v.id) <= MAX_ID_BYTES : safeInt(v.id))) throw new Invalid('a response with a bad id');
  const hasResult = 'result' in v;
  const hasError = 'error' in v;
  if (hasResult === hasError) throw new Invalid('a response without exactly one of result and error');
  if (hasResult) {
    if (!isObject(v.result)) throw new Invalid('a result that is not an object');
    return { t: 'response', id: v.id as RpcId, result: v.result };
  }
  const e = v.error;
  if (!isObject(e) || !Number.isInteger(e.code) || typeof e.message !== 'string') throw new Invalid('a bad error object');
  return { t: 'response', id: v.id as RpcId, error: { code: e.code as number, message: e.message.slice(0, MAX_ERROR_MESSAGE), ...('data' in e ? { data: e.data } : {}) } };
}

/* ---------- the event stream ---------- */

/**
 * `text/event-stream`, assembled across reads. An event's `data:` lines are joined with newlines; a
 * comment, or an event with empty data (a priming event), is skipped; `id`, `event` and `retry` are
 * ignored. An event past 4 MiB, or the exchange's events past 8 MiB, throw `Invalid`.
 */
export class EventStream {
  private readonly decoder = new TextDecoder();
  private afterCr = false;
  private pending = '';
  private data: string[] = [];
  private eventBytes = 0;
  private total = 0;

  private readonly maxEvent: number;
  private readonly maxTotal: number;

  constructor(maxEvent = MAX_MESSAGE_BYTES, maxTotal = MAX_EXCHANGE_BYTES) {
    this.maxEvent = maxEvent;
    this.maxTotal = maxTotal;
  }

  /** The data of every event a chunk completes, in order. */
  push(chunk: Uint8Array): string[] {
    this.total += chunk.length;
    if (this.total > this.maxTotal) throw new Invalid('an exchange past 8 MiB');
    this.pending += this.decoder.decode(chunk, { stream: true });
    // A CR that ended the last chunk was a line end at once; an LF that starts this one is its pair.
    if (this.afterCr && this.pending.startsWith('\n')) this.pending = this.pending.slice(1);
    this.afterCr = false;
    return this.lines();
  }

  /** At the stream's end: a last event without its blank line still counts. */
  end(): string[] {
    this.pending += this.decoder.decode();
    if (this.afterCr && this.pending.startsWith('\n')) this.pending = this.pending.slice(1);
    this.afterCr = false;
    const out = this.lines();
    if (this.pending) out.push(...this.line(this.pending));
    this.pending = '';
    out.push(...this.dispatch());
    return out;
  }

  private lines(): string[] {
    const out: string[] = [];
    for (;;) {
      const i = this.pending.search(/\r\n|\r|\n/);
      if (i < 0) break;
      const line = this.pending.slice(0, i);
      const crlf = this.pending[i] === '\r' && this.pending[i + 1] === '\n';
      // A CR at the very end of what's come so far is a line end now, and remembered: an LF opening the
      // next chunk is its pair, not an empty line.
      if (this.pending[i] === '\r' && i === this.pending.length - 1 && !(__FAMILIAR_MUTATIONS__ && mutant('cr-forgets-pair'))) this.afterCr = true;
      this.pending = this.pending.slice(crlf ? i + 2 : i + 1);
      out.push(...this.line(line));
    }
    if (this.eventBytes + this.pending.length > this.maxEvent) throw new Invalid('an event past 4 MiB');
    return out;
  }

  private line(line: string): string[] {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return [];
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.eventBytes += value.length + 1;
      if (this.eventBytes > this.maxEvent) throw new Invalid('an event past 4 MiB');
      this.data.push(value);
    }
    return [];
  }

  private dispatch(): string[] {
    const data = this.data.join('\n');
    this.data = [];
    this.eventBytes = 0;
    return data === '' ? [] : [data];
  }
}

/* ---------- result contracts ---------- */

export interface InitializeResult {
  readonly protocolVersion: string;
  readonly serverName: string;
}

/** The initialize answer: a supported version, tools among the capabilities, and the server's name. */
export function initializeResult(r: Record<string, unknown>): InitializeResult {
  if (!legacyVersion(r.protocolVersion)) throw new Invalid(`a protocol version Familiar doesn't speak: ${cutText(String(r.protocolVersion), 40)}`);
  if (!isObject(r.capabilities) || !isObject(r.capabilities.tools)) throw new Invalid('no tools capability');
  if (!isObject(r.serverInfo) || typeof r.serverInfo.name !== 'string') throw new Invalid('no server name');
  return { protocolVersion: r.protocolVersion, serverName: cutText(r.serverInfo.name, 200) };
}

export interface ListPage {
  readonly tools: readonly Record<string, unknown>[];
  readonly nextCursor?: string;
}

/** One tools/list page: `tools` an array of objects, `nextCursor` a short string. The catalog checks the rest. */
export function listResult(r: Record<string, unknown>, era: 'legacy' | 'modern' = 'legacy'): ListPage {
  if (era === 'modern') modernComplete(r);
  if (!Array.isArray(r.tools) || !r.tools.every(isObject)) throw new Invalid('tools that are not a list of objects');
  if (r.nextCursor !== undefined && (typeof r.nextCursor !== 'string' || bytes(r.nextCursor) > MAX_CURSOR_BYTES)) throw new Invalid('a bad cursor');
  return { tools: r.tools as Record<string, unknown>[], ...(typeof r.nextCursor === 'string' && r.nextCursor !== '' ? { nextCursor: r.nextCursor } : {}) };
}

export type ContentItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image' | 'audio'; readonly mimeType: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string }
  | { readonly type: 'resource'; readonly uri: string; readonly text?: string }
  | { readonly type: 'unsupported' };

export interface CallResult {
  readonly content: readonly ContentItem[];
  readonly isError: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

// Whole quads, with the padding the length requires.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A tools/call result: content items each checked by their own kind, unknown kinds kept as "unsupported". */
export function callResult(r: Record<string, unknown>, era: 'legacy' | 'modern' = 'legacy'): CallResult {
  if (era === 'modern') modernComplete(r);
  if (!Array.isArray(r.content)) throw new Invalid('content that is not a list');
  const content: ContentItem[] = r.content.map((c): ContentItem => {
    if (!isObject(c)) throw new Invalid('a content item that is not an object');
    switch (c.type) {
      case 'text':
        if (typeof c.text !== 'string') throw new Invalid('a text item without text');
        return { type: 'text', text: c.text };
      case 'image':
      case 'audio':
        if (typeof c.data !== 'string' || !BASE64.test(c.data) || typeof c.mimeType !== 'string') throw new Invalid(`a bad ${c.type} item`);
        return { type: c.type, mimeType: cutText(c.mimeType, 100) };
      case 'resource_link':
        if (typeof c.uri !== 'string' || typeof c.name !== 'string') throw new Invalid('a bad resource link');
        return { type: 'resource_link', uri: c.uri, name: c.name };
      case 'resource': {
        const res = c.resource;
        if (!isObject(res) || typeof res.uri !== 'string') throw new Invalid('a bad resource');
        if (typeof res.text === 'string') return { type: 'resource', uri: res.uri, text: res.text };
        if (typeof res.blob === 'string' && BASE64.test(res.blob)) return { type: 'resource', uri: res.uri };
        throw new Invalid('a resource with neither text nor a base64 blob');
      }
      default:
        return { type: 'unsupported' };
    }
  });
  if (r.isError !== undefined && typeof r.isError !== 'boolean') throw new Invalid('isError that is not a boolean');
  if (r.structuredContent !== undefined && !isObject(r.structuredContent)) throw new Invalid('structuredContent that is not an object');
  return { content, isError: r.isError === true, ...(isObject(r.structuredContent) ? { structuredContent: r.structuredContent } : {}) };
}

/** A modern result must say it's complete (phase 4 turns other values into tool errors before this). */
function modernComplete(r: Record<string, unknown>): void {
  if (r.resultType !== 'complete') throw new Invalid(`resultType ${JSON.stringify(r.resultType ?? null).slice(0, 40)}`);
}

/** How much of a result's text the model gets. */
export const MAX_RESULT_CHARS = 32_000;

/** The text the model gets back from a result: its text parts, with a plain note for anything else. */
export function resultText(result: CallResult): string {
  const parts: string[] = [];
  for (const c of result.content) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push('[an image, not shown]');
    else if (c.type === 'audio') parts.push('[a sound, not played]');
    else if (c.type === 'resource') parts.push(c.text ?? `[a file: ${c.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[a link: ${c.uri}]`);
    else parts.push('[unsupported content]');
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n');
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[cut: the server sent ${text.length} characters, the first ${MAX_RESULT_CHARS} are above]` : text;
}
