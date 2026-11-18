// The model port: the one door between Familiar's core and any language model.
// Adapters (pi-ai in step 4, the fake model in tests) implement it. Nothing else in core talks to a provider.

/** A JSON Schema object describing a tool's input, as MCP servers and model APIs both use. */
export type JsonSchema = { readonly [key: string]: unknown };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolCall {
  /** Unique within one reply. The tool result must carry it back. */
  readonly id: string;
  readonly name: string;
  /** Parsed JSON arguments. Adapters parse, so core never sees a half-written string. */
  readonly arguments: unknown;
}

/** Plain JSON, so it can be stored as it came and sent back unchanged. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What an adapter needs back on the next turn and core can't read: signed thinking, and signatures on
 * tool calls. Anthropic refuses a turn that mixes thinking and tools unless its signed thinking comes
 * back. Core stores it with the assistant message and returns it untouched. `adapter` names who made
 * it, so another adapter can ignore it.
 */
export interface Replay {
  readonly adapter: string;
  readonly data: JsonValue;
}

export type ChatMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
      /** The `replay` of the `done` that ended this reply, if it had one. */
      readonly replay?: Replay;
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly toolName: string; readonly content: string; readonly isError?: boolean };

export interface ModelRequest {
  /** The model id as the endpoint knows it. */
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSpec[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Asks a model that can think to do so, at this effort. Left out, it doesn't ask. */
  readonly thinking?: 'low' | 'medium' | 'high';
}

export interface Usage {
  /** Every input token, cached ones included. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Of `inputTokens`, how many were read from the endpoint's prompt cache. Absent when it didn't say. */
  readonly cacheReadTokens?: number;
  /** Of `inputTokens`, how many were written to the prompt cache. Absent when it didn't say. */
  readonly cacheWriteTokens?: number;
}

export type StopReason = 'end' | 'tool-calls' | 'length';

export type ModelErrorKind =
  | 'auth' // bad or missing key
  | 'rate-limit'
  | 'network' // could not reach the endpoint
  | 'bad-request' // the endpoint refused the request as written
  | 'not-found' // the endpoint has no such model, or no such path (HTTP 404)
  | 'server' // the endpoint failed
  | 'filtered' // a content filter stopped the reply, or the model refused
  | 'invalid-tool-call' // the model called a tool with a malformed name or arguments that aren't a plain JSON object
  | 'paused' // a cap stopped the call before anything was sent (see caps.ts)
  | 'aborted' // the caller's signal fired
  | 'unknown';

export interface ModelError {
  readonly kind: ModelErrorKind;
  /** Plain words, safe to show. Never contains a key or an endpoint's own text. */
  readonly message: string;
  readonly retryAfterMs?: number;
  /**
   * Set only when the endpoint or the transport said the request was not acted on, so sending it again
   * can't do anything twice, and nothing was billed: an HTTP 429, a 503 or 529 that carries the
   * provider's own signal (`x-should-retry: true`, or Anthropic's `overloaded_error`), or a request
   * the transport refused before sending. Never after a redirect. Absent means it might have been
   * half done.
   */
  readonly notProcessed?: true;
  /** Why the transport failed, in its own word (for the guarded fetch: `no-key`, `not-saved`, `timeout`...). */
  readonly transport?: string;
  /** For `invalid-tool-call`: which tool the model tried to call, when it named one properly. */
  readonly toolName?: string;
  /** For `paused`: which cap. */
  readonly pause?: string;
}

/**
 * One reply arrives as a stream of events. Exactly one terminal event ('done' or 'error') ends it,
 * and nothing follows a terminal event.
 */
export type ModelEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'thinking'; readonly delta: string }
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  /**
   * `unreported`: the endpoint gave no usage for the call, so `usage` holds zeros that mean nothing.
   * Spend is then unknown, never zero. `request` is the journal's own: the key of the request's outside
   * record (docs/mcp-design.md 5.6), which the stored reply keeps for the gate. Adapters never set it.
   */
  | { readonly type: 'done'; readonly stopReason: StopReason; readonly usage: Usage; readonly replay?: Replay; readonly unreported?: true; readonly request?: string }
  /**
   * `usage` is what the endpoint had reported when the reply ended, so spend can still be counted.
   * `usageFinal` says it is the endpoint's final count for the call; without it, it may be partial.
   */
  | { readonly type: 'error'; readonly error: ModelError; readonly usage?: Usage; readonly usageFinal?: true };

export interface ModelPort {
  /**
   * Streams one reply. Never throws: failures arrive as an 'error' event.
   * When `signal` fires, the stream ends promptly with an 'aborted' error.
   */
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

export function isTerminal(event: ModelEvent): event is Extract<ModelEvent, { type: 'done' | 'error' }> {
  return event.type === 'done' || event.type === 'error';
}
