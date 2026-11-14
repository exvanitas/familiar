// A pi-ai Provider built from Familiar's own ModelPort. This is the only place pi-ai's message types meet
// Familiar's: pi-durable calls a pi-ai `Models`, the provider turns each request into a `ModelRequest`, and the
// port's events back into pi-ai's assistant message stream. No pi-ai network provider is imported.

import { createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { ChatMessage, ModelPort, ModelRequest, ToolSpec } from '@familiar/core';

const API = 'familiar-port';
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''))
    .join('');
}

export function toModelRequest(model: { id: string; maxTokens?: number }, context: any, options: any): ModelRequest {
  const messages: ChatMessage[] = [];
  for (const m of context.messages as any[]) {
    if (m.role === 'user') messages.push({ role: 'user', content: text(m.content) });
    else if (m.role === 'assistant') {
      const calls = m.content
        .filter((b: any) => b.type === 'toolCall')
        .map((b: any) => ({ id: b.id, name: b.name, arguments: b.arguments }));
      messages.push({ role: 'assistant', content: text(m.content), ...(calls.length ? { toolCalls: calls } : {}) });
    } else if (m.role === 'toolResult') {
      messages.push({ role: 'tool', toolCallId: m.toolCallId, toolName: m.toolName, content: text(m.content), isError: m.isError });
    }
  }
  const tools: ToolSpec[] = getCurrentTools(context.messages).map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters
  }));
  return {
    model: model.id,
    system: getCurrentSystemPrompt(context.messages),
    messages,
    tools,
    ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {})
  };
}

export interface PortProviderOptions {
  readonly id: string;
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export function portProvider(port: ModelPort, options: PortProviderOptions) {
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
    const closeOpen = () => {
      if (!open) return;
      const block = partial.content[open.index];
      if (open.kind === 'text') out.push({ type: 'text_end', contentIndex: open.index, content: block.text, partial: snap() });
      else out.push({ type: 'thinking_end', contentIndex: open.index, content: block.thinking, partial: snap() });
      open = undefined;
    };
    const fail = (reason: 'error' | 'aborted', message: string) => {
      closeOpen();
      const error = { ...snap(), stopReason: reason, errorMessage: message };
      out.push({ type: 'error', reason, error });
      out.end(error);
    };
    void (async () => {
      out.push({ type: 'start', partial: snap() });
      const request = toModelRequest(requestModel, context, streamOptions);
      for await (const event of port.stream(request, streamOptions?.signal)) {
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
          const reason = event.stopReason === 'tool-calls' ? 'toolUse' : event.stopReason === 'length' ? 'length' : 'stop';
          const input = event.usage.inputTokens;
          const output = event.usage.outputTokens;
          const message = {
            ...snap(),
            stopReason: reason,
            usage: { ...ZERO_USAGE, input, output, totalTokens: input + output }
          };
          out.push({ type: 'done', reason, message });
          out.end(message);
          return;
        } else if (event.type === 'error') {
          // pi-ai decides retries from the error text, so a retryable kind has to say so in words it knows.
          const words =
            event.error.kind === 'rate-limit' ? 'rate limit: ' : event.error.kind === 'server' ? 'server error 503: ' : event.error.kind === 'network' ? 'network error: ' : '';
          fail(event.error.kind === 'aborted' ? 'aborted' : 'error', words + event.error.message);
          return;
        }
      }
      fail('error', 'model port stream ended without a terminal event');
    })().catch((error) => fail('error', String(error)));
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
