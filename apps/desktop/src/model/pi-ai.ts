/* Familiar's model port over pi-ai's per-API stream functions (docs/model-design.md). Built from the
   step 2 spike's draft (spikes/pi-ai-web). It skips pi-ai's model catalog: an endpoint is whatever the
   person typed, so one pi-ai Model is built per call.

   - The fetch is always passed in, and is the guarded fetch in the app. This file never touches
     `globalThis.fetch`, and pi-ai is never handed anything else.
   - A keyed endpoint gets PLACEHOLDER as its key, which the exe swaps for the stored key. No real key
     exists in page code.
   - Error kinds come from what the injected fetch saw: the HTTP status, Retry-After, and Anthropic's
     x-should-retry. pi-ai flattens errors to text, and an endpoint's text can echo a key, so messages
     here are Familiar's own and never repeat it. */
import type { ChatMessage, JsonValue, ModelError, ModelErrorKind, ModelEvent, ModelPort, ModelRequest, Replay, StopReason, Usage } from '@familiar/core';
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  OpenAICompletionsCompat,
  StreamOptions,
  ThinkingContent,
  TranscriptContext,
  Usage as PiUsage
} from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';

export type WireApi = 'openai-completions' | 'anthropic-messages';

/** What every pi-ai `api/<id>` module exports. */
export interface PiAiModule {
  stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions & Record<string, unknown>): AsyncIterable<AssistantMessageEvent>;
}

/* One dynamic import per API, so a bundler can give each SDK its own chunk, loaded on first use. Only
   these two: Gemini goes through its OpenAI-compatible endpoint (spikes.md). */
export const loaders: Record<WireApi, () => Promise<PiAiModule>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions') as Promise<PiAiModule>,
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages') as Promise<PiAiModule>
};

export interface AdapterOptions {
  readonly api: WireApi;
  readonly baseUrl: string;
  /** PLACEHOLDER for an endpoint with a saved key; any other non-empty text for one without. */
  readonly apiKey: string;
  /** In the app, always `guardedFetch(address)`. */
  readonly fetch: typeof globalThis.fetch;
  /** pi-ai's provider name, which picks its quirks: 'openai', 'openrouter', 'anthropic', 'google' and so on. */
  readonly provider: string;
  readonly compat?: OpenAICompletionsCompat | AnthropicMessagesCompat;
  /** Prompt caching. pi-ai's default is 'short'. */
  readonly cacheRetention?: 'none' | 'short' | 'long';
  readonly userAgent: string;
  readonly headers?: Readonly<Record<string, string | null>>;
  /** Defaults to `loaders[api]`. */
  readonly load?: () => Promise<PiAiModule>;
}

/* The SDKs name the OS, CPU and runtime in these. Nobody needs them, so they're removed. */
const QUIET: Record<string, null> = Object.fromEntries(
  ['x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-lang', 'x-stainless-package-version'].map(h => [h, null])
);

const ADAPTER = 'pi-ai';
const BUDGET = { low: 1024, medium: 4096, high: 16384 } as const;

/* What a reply leaves to carry back. Plain JSON, kept by core as it came. */
interface ReplayData {
  api: WireApi;
  provider: string;
  model: string;
  thinking: { thinking: string; signature?: string; redacted?: boolean }[];
  textSignature?: string;
  /* pi-ai's own signature on a tool call, by call id. */
  toolSignatures: Record<string, string>;
  /* Gemini's thought signature on a tool call, by call id, which pi-ai doesn't keep (see onPayload). */
  google: Record<string, string>;
}

interface Seen {
  status?: number;
  retryAfter?: string | null;
  shouldRetry?: string | null;
  body?: string;
  transport?: string;
}

export function createPiAiPort(options: AdapterOptions): ModelPort {
  return { stream: (request, signal) => run(options, request, signal) };
}

async function* run(o: AdapterOptions, request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
  if (signal?.aborted) {
    yield aborted();
    return;
  }
  const seen: Seen = {};
  const google: Record<string, string> = {};
  const indexIds = new Map<number, string>();
  let source: AsyncIterator<AssistantMessageEvent>;
  try {
    const mod = await (o.load ?? loaders[o.api])();
    const model = toModel(o, request);
    const context = normalizeContext(toContext(o, request));
    const outgoing = googleSignatures(o, request);
    const stream: StreamOptions & Record<string, unknown> = {
      apiKey: o.apiKey,
      signal,
      maxRetries: 0,
      fetch: observing(o.fetch, seen),
      headers: { ...QUIET, ...o.headers },
      identity: { userAgent: { custom: o.userAgent } },
      ...(o.cacheRetention ? { cacheRetention: o.cacheRetention } : {}),
      ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...thinkingOptions(o.api, request),
      // Gemini's signatures ride on tool calls as `extra_content`, which pi-ai neither reads nor writes.
      onProviderStreamEvent: (chunk: unknown) => noteGoogle(chunk, google, indexIds),
      ...(outgoing.size ? { onPayload: (payload: unknown) => addGoogle(payload, outgoing) } : {})
    };
    source = mod.stream(model, context, stream)[Symbol.asyncIterator]();
  } catch (e) {
    yield { type: 'error', error: toError(undefined, seen, signal, e) };
    return;
  }

  // Every read is raced against the signal, so a stop ends the stream even if an SDK is slow to.
  const stopped = signal ? stopPromise(signal) : undefined;
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
          if (event.toolCall.argumentsError !== undefined) {
            const name = event.toolCall.name;
            yield { type: 'error', error: { kind: 'invalid-tool-call', message: `The model called ${name} with arguments that aren't valid.`, toolName: name } };
            return;
          }
          yield { type: 'tool-call', call: { id: event.toolCall.id, name: event.toolCall.name, arguments: event.toolCall.arguments } };
          break;
        case 'done': {
          const replay = toReplay(o, request, event.message, google);
          yield { type: 'done', stopReason: toStopReason(event.reason), usage: toUsage(event.message.usage), ...(replay ? { replay } : {}) };
          return;
        }
        case 'error': {
          const usage = toUsage(event.error.usage);
          yield { type: 'error', error: toError(event.error, seen, signal), ...(usage.inputTokens || usage.outputTokens ? { usage } : {}) };
          return;
        }
        default:
          break;
      }
    }
  } finally {
    stopped?.dispose();
    void source.return?.();
  }
}

/* ---------- requests ---------- */

function toModel(o: AdapterOptions, request: ModelRequest): Model<Api> {
  return {
    id: request.model,
    name: request.model,
    api: o.api,
    provider: o.provider,
    baseUrl: o.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: request.thinking !== undefined,
    contextWindow: 128000,
    maxTokens: request.maxOutputTokens ?? 4096,
    ...(o.compat ? { compat: o.compat as never } : {})
  };
}

function thinkingOptions(api: WireApi, request: ModelRequest): Record<string, unknown> {
  const level = request.thinking;
  if (!level) return {};
  if (api === 'openai-completions') return { reasoningEffort: level };
  return { thinkingEnabled: true, thinkingBudgetTokens: BUDGET[level], effort: level };
}

function toContext(o: AdapterOptions, request: ModelRequest): Context {
  const now = Date.now();
  return {
    systemPrompt: request.system,
    tools: request.tools.map(t => ({ name: t.name, description: t.description, parameters: { ...t.inputSchema } as never })),
    messages: request.messages.map((m): Message => toMessage(o, m, request.model, now))
  };
}

function ownReplay(o: AdapterOptions, m: ChatMessage): ReplayData | undefined {
  if (m.role !== 'assistant' || m.replay?.adapter !== ADAPTER) return undefined;
  const d = m.replay.data as unknown as ReplayData;
  return d && d.api === o.api ? d : undefined;
}

function toMessage(o: AdapterOptions, m: ChatMessage, model: string, timestamp: number): Message {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content, timestamp };
    case 'assistant': {
      // With its own replay, the message is rebuilt as the model that wrote it: pi-ai then sends signed
      // thinking back to that model, and drops it for any other.
      const r = ownReplay(o, m);
      const content: AssistantMessage['content'] = [];
      for (const t of r?.thinking ?? []) {
        const block: ThinkingContent = { type: 'thinking', thinking: t.thinking };
        if (t.signature !== undefined) block.thinkingSignature = t.signature;
        if (t.redacted) block.redacted = true;
        content.push(block);
      }
      if (m.content) content.push({ type: 'text', text: m.content, ...(r?.textSignature ? { textSignature: r.textSignature } : {}) });
      for (const call of m.toolCalls ?? []) {
        const sig = r?.toolSignatures[call.id];
        content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments as never, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      return {
        role: 'assistant',
        content,
        api: o.api,
        provider: r?.provider ?? o.provider,
        model: r?.model ?? model,
        usage: zeroUsage(),
        stopReason: m.toolCalls?.length ? 'toolUse' : 'stop',
        timestamp
      };
    }
    case 'tool':
      return { role: 'toolResult', toolCallId: m.toolCallId, toolName: m.toolName, content: [{ type: 'text', text: m.content }], isError: m.isError ?? false, timestamp };
  }
}

function zeroUsage(): PiUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/* Gemini thought signatures to send back, by call id, from this model's own earlier replies. */
function googleSignatures(o: AdapterOptions, request: ModelRequest): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of request.messages) {
    const r = ownReplay(o, m);
    if (r && r.model === request.model) for (const [id, sig] of Object.entries(r.google ?? {})) out.set(id, sig);
  }
  return out;
}

/* Puts each signature back on its tool call, as Google's OpenAI-compatible endpoint expects. */
function addGoogle(payload: unknown, sigs: Map<string, string>): unknown {
  const messages = (payload as { messages?: { role?: string; tool_calls?: { id?: string; extra_content?: unknown }[] }[] }).messages;
  for (const m of messages ?? []) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      const sig = call.id ? sigs.get(call.id) : undefined;
      if (sig) call.extra_content = { google: { thought_signature: sig } };
    }
  }
  return payload;
}

/* Notes a tool call's Gemini signature from a raw chunk. Ids come once, on the call's first chunk. */
function noteGoogle(chunk: unknown, out: Record<string, string>, ids: Map<number, string>): void {
  const calls = (chunk as { choices?: { delta?: { tool_calls?: { index?: number; id?: string; extra_content?: { google?: { thought_signature?: unknown } } }[] } }[] })?.choices?.[0]?.delta?.tool_calls;
  for (const call of calls ?? []) {
    const index = call.index ?? 0;
    if (call.id) ids.set(index, call.id);
    const sig = call.extra_content?.google?.thought_signature;
    const id = ids.get(index);
    if (typeof sig === 'string' && id) out[id] = sig;
  }
}

/* ---------- replies ---------- */

function toReplay(o: AdapterOptions, request: ModelRequest, message: AssistantMessage, google: Record<string, string>): Replay | undefined {
  const thinking: ReplayData['thinking'] = [];
  const toolSignatures: Record<string, string> = {};
  let textSignature: string | undefined;
  for (const block of message.content) {
    if (block.type === 'thinking' && (block.thinkingSignature || block.redacted)) {
      thinking.push({ thinking: block.thinking, ...(block.thinkingSignature !== undefined ? { signature: block.thinkingSignature } : {}), ...(block.redacted ? { redacted: true } : {}) });
    } else if (block.type === 'text' && block.textSignature) {
      textSignature = block.textSignature;
    } else if (block.type === 'toolCall' && block.thoughtSignature) {
      toolSignatures[block.id] = block.thoughtSignature;
    }
  }
  if (!thinking.length && !textSignature && !Object.keys(toolSignatures).length && !Object.keys(google).length) return undefined;
  const data: ReplayData = { api: o.api, provider: o.provider, model: request.model, thinking, ...(textSignature ? { textSignature } : {}), toolSignatures, google };
  return { adapter: ADAPTER, data: data as unknown as JsonValue };
}

function toStopReason(reason: 'stop' | 'length' | 'toolUse' | 'deferred'): StopReason {
  return reason === 'toolUse' ? 'tool-calls' : reason === 'length' ? 'length' : 'end';
}

const whole = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/* pi-ai's `input` leaves cached tokens out; the port's counts them in. */
function toUsage(u: PiUsage): Usage {
  const read = whole(u.cacheRead), write = whole(u.cacheWrite);
  return {
    inputTokens: whole(u.input) + read + write,
    outputTokens: whole(u.output),
    ...(read ? { cacheReadTokens: read } : {}),
    ...(write ? { cacheWriteTokens: write } : {})
  };
}

const MESSAGES: Record<ModelErrorKind, string> = {
  auth: 'The endpoint refused the key.',
  'rate-limit': 'The endpoint is limiting requests. Try again shortly.',
  network: 'Could not reach the endpoint.',
  'bad-request': 'The endpoint refused the request as written.',
  'not-found': "The endpoint doesn't have that model.",
  server: 'The endpoint failed to answer.',
  filtered: "The endpoint's content filter stopped the reply.",
  'invalid-tool-call': 'The model called a tool with arguments that aren\'t valid.',
  aborted: 'Stopped.',
  unknown: 'The model call failed.'
};

/* What the guarded fetch's refusals mean, in plain words. Each was refused before anything was sent. */
const TRANSPORT: Record<string, [ModelErrorKind, string]> = {
  'no-key': ['auth', 'No key is saved for this endpoint.'],
  'not-saved': ['network', "Familiar isn't allowed to reach this address yet."],
  insecure: ['network', 'This address needs https.'],
  'blocked-address': ['network', 'The address led somewhere Familiar may not go.'],
  busy: ['network', 'Too many requests are open. Try again shortly.'],
  invalid: ['bad-request', 'The request was malformed.']
};
/* Refused or failed before a connection: sending again can't do anything twice. */
const UNSENT = new Set([...Object.keys(TRANSPORT), 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const AFTER: Record<string, string> = {
  timeout: "The endpoint didn't answer in time.",
  tls: "The endpoint's secure connection couldn't be checked.",
  revoked: 'The address was removed.',
  'redirect-refused': 'The endpoint sent Familiar somewhere else, and Familiar didn\'t follow.',
  'too-large': 'The reply was too large.'
};
const FILTERED = /content_filter|refusal|sensitive|SAFETY|PROHIBITED_CONTENT|BLOCKLIST/;

function toError(message: AssistantMessage | undefined, seen: Seen, signal?: AbortSignal, thrown?: unknown): ModelError {
  if (signal?.aborted || message?.stopReason === 'aborted') return aborted().error;
  if (seen.transport !== undefined) {
    const t = seen.transport;
    const [kind, text] = TRANSPORT[t] ?? ['network', AFTER[t] ?? MESSAGES.network];
    return { kind, message: text, transport: t, ...(UNSENT.has(t) ? { notProcessed: true as const } : {}) };
  }
  const status = seen.status !== undefined && seen.status >= 400 ? seen.status : undefined;
  if (status === undefined) {
    // The head was fine, so the stream itself ended badly: a filter, a stop reason, or a failure part way.
    const raw = `${message?.rawStopReason ?? ''} ${message?.errorMessage ?? ''}`;
    if (FILTERED.test(raw)) return { kind: 'filtered', message: MESSAGES.filtered };
    if (/overloaded|api_error|server_error/i.test(raw)) return { kind: 'server', message: MESSAGES.server };
    void thrown;
    return { kind: 'unknown', message: MESSAGES.unknown };
  }
  const body = seen.body ?? '';
  let kind: ModelErrorKind;
  if (status === 401 || status === 403 || /API_KEY_INVALID/.test(body)) kind = 'auth';
  else if (status === 404) kind = 'not-found';
  else if (status === 429) kind = 'rate-limit';
  else if (status >= 500) kind = 'server';
  else kind = 'bad-request';
  const said = seen.shouldRetry?.trim().toLowerCase();
  const notProcessed = said === 'false' ? false : said === 'true' || status === 429 || status === 503 || status === 529;
  const wait = kind === 'rate-limit' || kind === 'server' ? retryAfterMs(seen.retryAfter) : undefined;
  return {
    kind,
    message: `${MESSAGES[kind]} (HTTP ${status})`,
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    ...(notProcessed ? { notProcessed: true as const } : {})
  };
}

/* Seconds or an HTTP date. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function aborted(): Extract<ModelEvent, { type: 'error' }> {
  return { type: 'error', error: { kind: 'aborted', message: MESSAGES.aborted } };
}

/* ---------- plumbing ---------- */

/* Keeps what pi-ai flattens away: the status, Retry-After, x-should-retry, an error body (only to
   classify it, never shown), and why the transport failed. */
function observing(inner: typeof globalThis.fetch, seen: Seen): typeof globalThis.fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (e) {
      if (!init?.signal?.aborted) seen.transport = transportKind(e);
      throw e;
    }
    seen.status = response.status;
    seen.retryAfter = response.headers.get('retry-after');
    seen.shouldRetry = response.headers.get('x-should-retry');
    if (!response.ok) seen.body = await response.clone().text().catch(() => '');
    return response;
  };
}

/* The guarded fetch puts its kind in `cause.kind`; Node's fetch puts a code in `cause.code`. */
function transportKind(e: unknown): string {
  const cause = e instanceof Error ? (e.cause as { kind?: unknown; code?: unknown } | undefined) : undefined;
  if (typeof cause?.kind === 'string') return cause.kind;
  if (typeof cause?.code === 'string') return cause.code;
  return 'network';
}

const STOPPED: unique symbol = Symbol('stopped');

function stopPromise(signal: AbortSignal): { promise: Promise<typeof STOPPED>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<typeof STOPPED>(resolve => {
    onAbort = () => resolve(STOPPED);
    if (signal.aborted) resolve(STOPPED);
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => onAbort && signal.removeEventListener('abort', onAbort) };
}
