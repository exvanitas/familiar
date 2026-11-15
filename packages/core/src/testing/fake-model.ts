// A scripted model for dev and tests. No network, no keys, no clock: it streams exactly what the script says.

import type {
  ModelError,
  ModelEvent,
  ModelPort,
  ModelRequest,
  Replay,
  StopReason,
  ToolCall,
  Usage
} from '../model/port.ts';

export interface FakeReply {
  /** Streamed as text events of `chunkSize` characters. */
  readonly text?: string;
  /** Streamed before the text, as thinking events. */
  readonly thinking?: string;
  readonly toolCalls?: readonly ToolCall[];
  /** Defaults to 'tool-calls' when there are tool calls, else 'end'. */
  readonly stopReason?: StopReason;
  /** Ends the reply with this error instead of 'done', after any text already streamed. */
  readonly error?: ModelError;
  /** Characters per text event. Default 8. */
  readonly chunkSize?: number;
  /** Holds the stream after this many events until `until` settles, so a test can act mid-reply. */
  readonly pause?: { readonly afterEvents: number; readonly until: Promise<void> };
  /** Defaults to a rough count from the request and reply sizes. With `error`, sent on the error event. */
  readonly usage?: Usage;
  /** Sent on the 'done' event, as an adapter sends signed thinking to carry back next turn. */
  readonly replay?: Replay;
}

/** Either a fixed list of replies, used in order, or a function of the request. */
export type FakeScript = readonly FakeReply[] | ((request: ModelRequest, index: number) => FakeReply);

export interface FakeModel extends ModelPort {
  /** Every request, copied at the moment it was made. */
  readonly requests: readonly ModelRequest[];
}

export function createFakeModel(script: FakeScript): FakeModel {
  const requests: ModelRequest[] = [];
  return {
    requests,
    stream(request, signal) {
      const index = requests.length;
      requests.push(structuredClone(request));
      return replyEvents(pickReply(script, request, index), request, signal);
    }
  };
}

function pickReply(script: FakeScript, request: ModelRequest, index: number): FakeReply {
  if (typeof script === 'function') return script(request, index);
  const reply = script[index];
  if (reply) return reply;
  return {
    error: { kind: 'unknown', message: `fake model: the script has ${script.length} replies and request ${index + 1} asked for another` }
  };
}

const aborted: ModelEvent = { type: 'error', error: { kind: 'aborted', message: 'Stopped.' } };

async function* replyEvents(reply: FakeReply, request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
  const events = bodyEvents(reply);
  let sent = 0;
  for (const event of events) {
    if (reply.pause && sent === reply.pause.afterEvents) {
      if ((await settleOrAbort(reply.pause.until, signal)) === 'aborted') {
        yield aborted;
        return;
      }
    }
    // A turn of the microtask queue between events, so an abort from the consumer lands before the next one.
    await Promise.resolve();
    if (signal?.aborted) {
      yield aborted;
      return;
    }
    yield event;
    sent++;
  }
  await Promise.resolve();
  if (signal?.aborted) {
    yield aborted;
    return;
  }
  if (reply.error) {
    yield { type: 'error', error: reply.error, ...(reply.usage ? { usage: reply.usage } : {}) };
    return;
  }
  const stopReason = reply.stopReason ?? (reply.toolCalls?.length ? 'tool-calls' : 'end');
  const usage = reply.usage ?? roughUsage(request, reply);
  yield { type: 'done', stopReason, usage, ...(reply.replay ? { replay: structuredClone(reply.replay) } : {}) };
}

function bodyEvents(reply: FakeReply): ModelEvent[] {
  const size = Math.max(1, reply.chunkSize ?? 8);
  const out: ModelEvent[] = [];
  for (const delta of chunks(reply.thinking ?? '', size)) out.push({ type: 'thinking', delta });
  for (const delta of chunks(reply.text ?? '', size)) out.push({ type: 'text', delta });
  for (const call of reply.toolCalls ?? []) out.push({ type: 'tool-call', call: structuredClone(call) });
  return out;
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function settleOrAbort(until: Promise<void>, signal?: AbortSignal): Promise<'settled' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const onAbort = () => resolve('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    until.then(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve('settled');
      },
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve('settled');
      }
    );
  });
}

/** About four characters a token. Only for tests that want non-zero numbers. */
function roughUsage(request: ModelRequest, reply: FakeReply): Usage {
  const inChars =
    request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(request.tools).length;
  const outChars = (reply.thinking ?? '').length + (reply.text ?? '').length + JSON.stringify(reply.toolCalls ?? []).length;
  return { inputTokens: Math.ceil(inChars / 4), outputTokens: Math.ceil(outChars / 4) };
}
