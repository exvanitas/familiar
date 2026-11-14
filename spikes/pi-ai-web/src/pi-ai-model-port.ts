// Draft: Familiar's ModelPort over pi-ai's per-API stream functions.
// It skips pi-ai's Models/provider catalog layer and builds one Model object per endpoint the person entered,
// because Familiar's endpoints are user-supplied (any base URL, any model id).

import type {
  ChatMessage,
  ModelError,
  ModelErrorKind,
  ModelEvent,
  ModelPort,
  ModelRequest,
  StopReason
} from '@familiar/core';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StreamOptions,
  TranscriptContext,
  Usage as PiUsage
} from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';

export type PiAiApi = 'openai-completions' | 'anthropic-messages' | 'google-generative-ai';

/** The shape every pi-ai `api/<id>` module exports. */
export interface PiAiApiModule {
  stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AsyncIterable<AssistantMessageEvent>;
}

export interface PiAiEndpoint {
  readonly api: PiAiApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Loads the API module, so a bundler can keep each provider's SDK in its own chunk. */
  readonly load: () => Promise<PiAiApiModule>;
  /** Familiar's guarded fetch (Tauri's HTTP plugin fetch in the app). Google's adapter refuses it, see RESULT.md. */
  readonly fetch?: typeof globalThis.fetch;
  readonly userAgent?: string;
}

interface Seen {
  status?: number;
  retryAfter?: string | null;
  body?: string;
  networkError?: boolean;
}

export function createPiAiModelPort(endpoint: PiAiEndpoint): ModelPort {
  return {
    stream(request, signal) {
      return run(endpoint, request, signal);
    }
  };
}

async function* run(endpoint: PiAiEndpoint, request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
  if (signal?.aborted) {
    yield aborted();
    return;
  }
  const seen: Seen = {};
  const fetchImpl = endpoint.fetch ? observingFetch(endpoint.fetch, seen) : undefined;

  let source: AsyncIterator<AssistantMessageEvent>;
  try {
    const mod = await endpoint.load();
    const model = toModel(endpoint, request);
    const context = normalizeContext(toContext(endpoint, request));
    const options: StreamOptions = {
      apiKey: endpoint.apiKey,
      signal,
      maxRetries: 0,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(endpoint.userAgent ? { identity: { userAgent: { custom: endpoint.userAgent } } } : {})
    };
    source = mod.stream(model, context, options)[Symbol.asyncIterator]();
  } catch (error) {
    yield { type: 'error', error: toError(undefined, seen, signal, error) };
    return;
  }

  // Race every read against the signal, so a stop ends the stream even if the SDK is slow to notice.
  const stopped = signal ? abortPromise(signal) : undefined;
  try {
    for (;;) {
      const next = source.next();
      const result = stopped ? await Promise.race([next, stopped.promise]) : await next;
      if (result === STOPPED) {
        yield aborted();
        return;
      }
      if (result.done) {
        yield { type: 'error', error: { kind: 'unknown', message: 'The reply ended without finishing.' } };
        return;
      }
      const event = result.value;
      switch (event.type) {
        case 'text_delta':
          if (event.delta) yield { type: 'text', delta: event.delta };
          break;
        case 'thinking_delta':
          if (event.delta) yield { type: 'thinking', delta: event.delta };
          break;
        case 'toolcall_end':
          yield {
            type: 'tool-call',
            call: { id: event.toolCall.id, name: event.toolCall.name, arguments: event.toolCall.arguments }
          };
          break;
        case 'done':
          yield { type: 'done', stopReason: toStopReason(event.reason), usage: toUsage(event.message.usage) };
          return;
        case 'error':
          yield { type: 'error', error: toError(event.error, seen, signal) };
          return;
        default:
          break;
      }
    }
  } finally {
    stopped?.dispose();
    void source.return?.();
  }
}

// ---- requests ----

function toModel(endpoint: PiAiEndpoint, request: ModelRequest): Model<Api> {
  return {
    id: request.model,
    name: request.model,
    api: endpoint.api,
    provider: providerFor(endpoint.api),
    baseUrl: endpoint.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128000,
    maxTokens: request.maxOutputTokens ?? 4096
  };
}

function providerFor(api: PiAiApi): string {
  // Only used for labels and pi-ai's per-provider quirks. A neutral name keeps quirks keyed off the base URL.
  return api === 'anthropic-messages' ? 'anthropic' : api === 'google-generative-ai' ? 'google' : 'openai-compatible';
}

function toContext(endpoint: PiAiEndpoint, request: ModelRequest): Context {
  const provider = providerFor(endpoint.api);
  const now = Date.now();
  return {
    systemPrompt: request.system,
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: { ...t.inputSchema } })),
    messages: request.messages.map((m): Message => toMessage(m, endpoint.api, provider, request.model, now))
  };
}

function toMessage(m: ChatMessage, api: PiAiApi, provider: string, model: string, timestamp: number): Message {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content, timestamp };
    case 'assistant': {
      const content: AssistantMessage['content'] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments as never });
      }
      return {
        role: 'assistant',
        content,
        api,
        provider,
        model,
        usage: zeroUsage(),
        stopReason: m.toolCalls?.length ? 'toolUse' : 'stop',
        timestamp
      };
    }
    case 'tool':
      return {
        role: 'toolResult',
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: [{ type: 'text', text: m.content }],
        isError: m.isError ?? false,
        timestamp
      };
  }
}

function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

// ---- replies ----

function toStopReason(reason: 'stop' | 'length' | 'toolUse' | 'deferred'): StopReason {
  return reason === 'toolUse' ? 'tool-calls' : reason === 'length' ? 'length' : 'end';
}

function toUsage(u: PiUsage): { inputTokens: number; outputTokens: number } {
  const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  return { inputTokens: whole(u.input + u.cacheRead + u.cacheWrite), outputTokens: whole(u.output) };
}

const MESSAGES: Record<ModelErrorKind, string> = {
  auth: 'The endpoint refused the key.',
  'rate-limit': 'The endpoint is rate limiting requests. Try again shortly.',
  network: 'Could not reach the endpoint.',
  'bad-request': 'The endpoint refused the request as written.',
  server: 'The endpoint failed to answer.',
  aborted: 'Stopped.',
  unknown: 'The model call failed.'
};

function toError(message: AssistantMessage | undefined, seen: Seen, signal?: AbortSignal, thrown?: unknown): ModelError {
  if (signal?.aborted || message?.stopReason === 'aborted') return aborted().error;
  const text = message?.errorMessage ?? (thrown instanceof Error ? thrown.message : '');
  // With an injected fetch, the status and body come from the response itself.
  // Without one (Google's adapter), they are read back out of pi-ai's error text.
  const status = seen.status ?? statusFromText(text);
  const body = seen.body ?? text;
  let kind: ModelErrorKind = 'unknown';
  if (seen.networkError) kind = 'network';
  else if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|authentication_error/.test(body)) kind = 'auth';
  else if (status === 429) kind = 'rate-limit';
  else if (status !== undefined && status >= 500) kind = 'server';
  else if (status !== undefined && status >= 400) kind = 'bad-request';
  else if (/fetch failed|ECONNREFUSED|Connection error/i.test(text)) kind = 'network';
  const retryAfterMs = kind === 'rate-limit' ? retryAfter(seen.retryAfter) : undefined;
  return {
    kind,
    message: status ? `${MESSAGES[kind]} (HTTP ${status})` : MESSAGES[kind],
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

function statusFromText(text: string): number | undefined {
  const m = /^(\d{3})\b/.exec(text) ?? /"code"\s*:\s*(\d{3})/.exec(text) ?? /\bstatus(?: code)?:? (\d{3})\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

function retryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function aborted(): Extract<ModelEvent, { type: 'error' }> {
  return { type: 'error', error: { kind: 'aborted', message: MESSAGES.aborted } };
}

// ---- plumbing ----

/** Wraps the injected fetch to keep the HTTP status, Retry-After and an error body, which pi-ai flattens to text. */
function observingFetch(inner: typeof globalThis.fetch, seen: Seen): typeof globalThis.fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      if (!init?.signal?.aborted) seen.networkError = true;
      throw error;
    }
    seen.status = response.status;
    seen.retryAfter = response.headers.get('retry-after');
    if (!response.ok) seen.body = await response.clone().text().catch(() => '');
    return response;
  };
}

const STOPPED: unique symbol = Symbol('stopped');

function abortPromise(signal: AbortSignal): { promise: Promise<typeof STOPPED>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<typeof STOPPED>((resolve) => {
    onAbort = () => resolve(STOPPED);
    if (signal.aborted) resolve(STOPPED);
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => onAbort && signal.removeEventListener('abort', onAbort) };
}
