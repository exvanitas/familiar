// A pi-ai provider built from Familiar's own ModelPort. This is the only place pi-ai's message types meet
// Familiar's: pi-durable calls a pi-ai `Models`, the provider turns each request into a `ModelRequest`, and
// the port's events back into pi-ai's assistant message stream. No pi-ai network provider is imported.
//
// Errors cross as a hex-coded `ModelError`. pi-ai decides whether to send a failed request again from its
// error text, and Familiar's own retries (model/retry.ts) already ran below this point, so the text must
// never read as retryable: hex holds no word and no status code its patterns look for. A request cut off
// by a crash is still sent again, since pi-durable counts that as a failed attempt whatever the text.

import { createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { ChatMessage, ModelError, ModelPort, ModelRequest, ToolSpec } from '../model/port.ts';
import { mutant } from '../mutations.ts';
import { SOURCES_FIELD } from './provenance.ts';

const API = 'familiar-port';
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

const ERROR_PREFIX = 'familiar.model-error:';
/**
 * Where a reply's `replay` (signed thinking and the like, model/port.ts) rides on pi-ai's assistant
 * message. pi-durable stores the message as JSON in the transcript, so it survives a restart, and
 * `toModelRequest` hands it back on the next turn exactly as it came.
 */
export const REPLAY_FIELD = 'familiarReplay';

function hex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A model error as pi-ai's error text. */
export function encodeModelError(error: ModelError): string {
  const { kind, message, pause } = error;
  return ERROR_PREFIX + hex(JSON.stringify({ kind, message, ...(pause ? { pause } : {}) }));
}

/** Reads back an error `encodeModelError` wrote, or undefined for any other text. */
export function decodeModelError(text: string | undefined): Pick<ModelError, 'kind' | 'message' | 'pause'> | undefined {
  if (!text?.startsWith(ERROR_PREFIX)) return undefined;
  const body = text.slice(ERROR_PREFIX.length);
  if (!/^(?:[0-9a-f]{2})*$/.test(body)) return undefined;
  try {
    const bytes = new Uint8Array(body.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value?.kind === 'string' && typeof value?.message === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : '')).join('');
}

/** pi-ai's request context as a Familiar `ModelRequest`. */
export function toModelRequest(model: { id: string }, context: any, options: any): ModelRequest {
  const messages: ChatMessage[] = [];
  for (const m of context.messages as any[]) {
    if (m.role === 'user') messages.push({ role: 'user', content: text(m.content) });
    else if (m.role === 'assistant') {
      // An attempt a crash or a stop cut off is kept in the transcript as an aborted entry. It was never a
      // reply, so it isn't sent back.
      if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
      const calls = m.content.filter((b: any) => b.type === 'toolCall').map((b: any) => ({ id: b.id, name: b.name, arguments: b.arguments }));
      // The adapter's opaque replay state, stored with the entry and given back unchanged.
      const replay = m[REPLAY_FIELD];
      messages.push({ role: 'assistant', content: text(m.content), ...(calls.length ? { toolCalls: calls } : {}), ...(replay ? { replay } : {}) });
    } else if (m.role === 'toolResult') {
      messages.push({ role: 'tool', toolCallId: m.toolCallId, toolName: m.toolName, content: text(m.content), ...(m.isError ? { isError: true } : {}) });
    }
  }
  const tools: ToolSpec[] = getCurrentTools(context.messages).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
  return {
    model: model.id,
    system: getCurrentSystemPrompt(context.messages) ?? '',
    messages: alternate(messages),
    tools,
    ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {})
  };
}

/**
 * Merges consecutive messages of one role into one, so every endpoint sees alternating roles. Some chat
 * templates (local models) refuse anything else, and pi-ai passes messages through as they are (B3).
 * Her remark is a user-role note, so a note and your next message become one user message. Two
 * assistant messages merge only when neither carries tool calls or replay state; tool results never merge.
 */
export function alternate(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last?.role === 'user' && m.role === 'user') {
      out[out.length - 1] = { role: 'user', content: `${last.content}\n\n${m.content}` };
      continue;
    }
    if (last?.role === 'assistant' && m.role === 'assistant' && !last.toolCalls && !m.toolCalls && !last.replay && !m.replay) {
      out[out.length - 1] = { role: 'assistant', content: `${last.content}\n\n${m.content}` };
      continue;
    }
    out.push(m);
  }
  return out;
}

export interface PortProviderOptions {
  readonly id: string;
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /**
   * The request's outside sources (docs/mcp-design.md 5.6), from pi-durable's own context for it and the
   * request as built: stamped on the reply, which carries them for good. Without it a reply has none
   * recorded, and counts as outside.
   */
  readonly sources?: (messages: readonly unknown[], request: ModelRequest) => Promise<readonly string[]>;
}

/** `port` is asked for at each request, so the journal can put caps around it once its store is open. */
export function portProvider(port: () => ModelPort | Promise<ModelPort>, options: PortProviderOptions) {
  const model = {
    id: options.modelId,
    name: options.modelId,
    api: API,
    provider: options.id,
    baseUrl: 'port://familiar',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? 32000,
    maxTokens: options.maxTokens ?? 4096
  };

  const stream = (requestModel: any, context: any, streamOptions: any) => {
    const out = createAssistantMessageEventStream();
    const partial: any = {
      role: 'assistant',
      content: [],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage: ZERO_USAGE,
      stopReason: 'pending',
      timestamp: Date.now()
    };
    const snap = () => ({ ...partial, content: partial.content.map((b: any) => ({ ...b })) });
    let open: { kind: 'text' | 'thinking'; index: number } | undefined;
    let ended = false;
    const closeOpen = () => {
      if (!open) return;
      const block = partial.content[open.index];
      if (open.kind === 'text') out.push({ type: 'text_end', contentIndex: open.index, content: block.text, partial: snap() });
      else out.push({ type: 'thinking_end', contentIndex: open.index, content: block.thinking, partial: snap() });
      open = undefined;
    };
    const fail = (error: ModelError) => {
      if (ended) return;
      ended = true;
      closeOpen();
      const reason = error.kind === 'aborted' ? 'aborted' : 'error';
      const message = { ...snap(), stopReason: reason, errorMessage: encodeModelError(error) };
      out.push({ type: 'error', reason, error: message });
      out.end(message);
    };
    void (async () => {
      out.push({ type: 'start', partial: snap() });
      const request = toModelRequest(requestModel, context, streamOptions);
      // Worked out before the request is sent, from exactly what it sends.
      const sources = options.sources ? [...(await options.sources(context.messages, request))] : undefined;
      const model = await port();
      for await (const event of model.stream(request, streamOptions?.signal)) {
        if (event.type === 'text' || event.type === 'thinking') {
          if (open?.kind !== event.type) {
            closeOpen();
            partial.content.push(event.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
            open = { kind: event.type, index: partial.content.length - 1 };
            out.push({ type: event.type === 'text' ? 'text_start' : 'thinking_start', contentIndex: open.index, partial: snap() });
          }
          const block = partial.content[open.index];
          if (event.type === 'text') block.text += event.delta;
          else block.thinking += event.delta;
          out.push({ type: event.type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: open.index, delta: event.delta, partial: snap() });
        } else if (event.type === 'tool-call') {
          closeOpen();
          const call = { type: 'toolCall', id: event.call.id, name: event.call.name, arguments: event.call.arguments as any };
          partial.content.push(call);
          const index = partial.content.length - 1;
          out.push({ type: 'toolcall_start', contentIndex: index, partial: snap() });
          out.push({ type: 'toolcall_end', contentIndex: index, toolCall: call as any, partial: snap() });
        } else if (event.type === 'done') {
          closeOpen();
          ended = true;
          const reason = event.stopReason === 'tool-calls' ? 'toolUse' : event.stopReason === 'length' ? 'length' : 'stop';
          const input = event.usage.inputTokens;
          const output = event.usage.outputTokens;
          const message = {
            ...snap(),
            stopReason: reason,
            usage: { ...ZERO_USAGE, input, output, totalTokens: input + output },
            ...(event.replay ? { [REPLAY_FIELD]: event.replay } : {}),
            ...(sources ? { [SOURCES_FIELD]: __FAMILIAR_MUTATIONS__ && mutant('reply-sources-empty') ? [] : sources } : {})
          };
          out.push({ type: 'done', reason, message });
          out.end(message);
          return;
        } else if (event.type === 'error') {
          fail(event.error);
          return;
        }
      }
      fail({ kind: 'unknown', message: 'The model stream ended without a last event.' });
    })().catch(() => fail({ kind: 'unknown', message: 'The model stream failed.' }));
    return out;
  };

  const provider = createProvider({
    id: options.id,
    auth: { apiKey: { name: 'Familiar', resolve: async () => ({ auth: {} }) } } as any,
    models: [model] as any,
    api: { stream, streamSimple: stream } as any
  });
  return { provider, model };
}
