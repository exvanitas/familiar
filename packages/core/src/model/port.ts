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

export type ChatMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly toolName: string; readonly content: string; readonly isError?: boolean };

export interface ModelRequest {
  /** The model id as the endpoint knows it. */
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSpec[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type StopReason = 'end' | 'tool-calls' | 'length';

export type ModelErrorKind =
  | 'auth' // bad or missing key
  | 'rate-limit'
  | 'network' // could not reach the endpoint
  | 'bad-request' // the endpoint refused the request as written
  | 'server' // the endpoint failed
  | 'aborted' // the caller's signal fired
  | 'unknown';

export interface ModelError {
  readonly kind: ModelErrorKind;
  /** Plain words, safe to show. Never contains a key. */
  readonly message: string;
  readonly retryAfterMs?: number;
}

/**
 * One reply arrives as a stream of events. Exactly one terminal event ('done' or 'error') ends it,
 * and nothing follows a terminal event.
 */
export type ModelEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'thinking'; readonly delta: string }
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  | { readonly type: 'done'; readonly stopReason: StopReason; readonly usage: Usage }
  | { readonly type: 'error'; readonly error: ModelError };

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
