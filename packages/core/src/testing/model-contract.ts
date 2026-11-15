// The model port's contract. Every adapter runs these cases: the fake model now, the pi-ai adapter
// (over recorded responses) from step 4. Plain async checks, so any test runner can drive them.

import type { ChatMessage, ModelEvent, ModelPort, ModelRequest } from '../model/port.ts';

/** What the harness must prime a port to do for each case. */
export type ContractScenario =
  | 'text' // replies with CONTRACT_TEXT and stops
  | 'tool-call' // calls CONTRACT_TOOL_CALL's tool with its arguments
  | 'auth-error' // the endpoint refuses the key
  | 'slow' // a reply long enough to stop part way: at least two events before its end
  // Signed thinking (as CONTRACT_THINKING, where the API shows it), then CONTRACT_TOOL_CALL. The signature
  // is wherever the API puts it: Anthropic's on the thinking block, OpenRouter's in reasoning details,
  // Gemini's on the tool call.
  | 'thinking-tool-call'
  // Answers CONTRACT_TEXT only if the request carries back, at messages[1], what 'thinking-tool-call'
  // gave to replay. Without it, refuses the request as written (bad-request), as Anthropic does when
  // signed thinking is missing.
  | 'replay-check'
  | 'bad-tool-arguments' // calls CONTRACT_TOOL_CALL's tool with arguments that aren't valid JSON
  | 'cache' // CONTRACT_TEXT, with usage that has CONTRACT_CACHE's input and cache reads
  | 'length' // some text, then it stops because it reached its length limit
  | 'filtered' // a content filter stops it
  | 'rate-limit' // HTTP 429 with Retry-After: 2
  | 'overloaded' // the endpoint says it's overloaded and didn't take the request (503, or Anthropic's 529)
  | 'server-error'; // HTTP 500: the endpoint failed, and the request might have been half done

export interface ModelPortHarness {
  forScenario(scenario: ContractScenario): ModelPort;
}

export interface ContractCase {
  readonly name: string;
  run(harness: ModelPortHarness): Promise<void>;
}

export const CONTRACT_TEXT = 'Hello there. This is the contract reply.';
export const CONTRACT_TOOL_CALL = { name: 'get_time', arguments: { zone: 'UTC' } } as const;

export const CONTRACT_REQUEST: ModelRequest = {
  model: 'contract-model',
  system: 'You are a test persona.',
  messages: [{ role: 'user', content: 'Say hello, or tell me the time.' }],
  tools: [
    {
      name: 'get_time',
      description: 'The current time in a time zone.',
      inputSchema: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] }
    }
  ]
};

export const CONTRACT_THINKING = 'They want the time. Use get_time.';
/** Usage in the 'cache' scenario: input counts every input token, cached ones included. */
export const CONTRACT_CACHE = { inputTokens: 1300, cacheReadTokens: 1200 } as const;
export const CONTRACT_TOOL_RESULT = '12:00 UTC';
/** Every recorded error body holds this, so the contract can tell when an adapter repeats one. */
export const ENDPOINT_WORDS = 'endpoint-words';

/** The turn after 'thinking-tool-call': its call, and the call's result. */
export function followUp(call: Extract<ChatMessage, { role: 'assistant' }>): ModelRequest {
  return {
    ...CONTRACT_REQUEST,
    messages: [
      CONTRACT_REQUEST.messages[0]!,
      call,
      { role: 'tool', toolCallId: call.toolCalls![0]!.id, toolName: CONTRACT_TOOL_CALL.name, content: CONTRACT_TOOL_RESULT }
    ]
  };
}

/** How long a stream may take to end after an abort before it counts as hung. */
export const ABORT_DEADLINE_MS = 2000;

export const modelPortContract: readonly ContractCase[] = [
  {
    name: 'a text reply streams deltas that join to the reply, then one done with stop reason end',
    async run(h) {
      const events = await collect(h.forScenario('text').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
      check(text === CONTRACT_TEXT, `text was ${JSON.stringify(text)}`);
      const last = events.at(-1);
      check(last?.type === 'done' && last.stopReason === 'end', `ended with ${JSON.stringify(last)}`);
    }
  },
  {
    name: 'a tool call arrives parsed, with an id, and the reply stops for tool calls',
    async run(h) {
      const events = await collect(h.forScenario('tool-call').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      const calls = events.flatMap((e) => (e.type === 'tool-call' ? [e.call] : []));
      check(calls.length === 1, `expected one tool call, got ${calls.length}`);
      const call = calls[0]!;
      check(typeof call.id === 'string' && call.id.length > 0, 'tool call has no id');
      check(call.name === CONTRACT_TOOL_CALL.name, `tool name was ${call.name}`);
      check(sameJson(call.arguments, CONTRACT_TOOL_CALL.arguments), `arguments were ${JSON.stringify(call.arguments)}`);
      const last = events.at(-1);
      check(last?.type === 'done' && last.stopReason === 'tool-calls', `ended with ${JSON.stringify(last)}`);
    }
  },
  {
    name: 'a refused key ends in one auth error, with no done and no exception',
    async run(h) {
      const events = await collect(h.forScenario('auth-error').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      const last = events.at(-1);
      check(last?.type === 'error' && last.error.kind === 'auth', `ended with ${JSON.stringify(last)}`);
      check(last.error.message.length > 0, 'the error has no message');
    }
  },
  {
    name: 'stopping part way ends the stream promptly with an aborted error',
    async run(h) {
      const controller = new AbortController();
      const events = await collect(h.forScenario('slow').stream(CONTRACT_REQUEST, controller.signal), () => controller.abort());
      checkOneTerminalLast(events);
      const last = events.at(-1);
      check(last?.type === 'error' && last.error.kind === 'aborted', `ended with ${JSON.stringify(last)}`);
    }
  },
  {
    name: 'an already stopped signal gives only an aborted error',
    async run(h) {
      const controller = new AbortController();
      controller.abort();
      const events = await collect(h.forScenario('text').stream(CONTRACT_REQUEST, controller.signal));
      check(events.length === 1, `expected one event, got ${JSON.stringify(events)}`);
      const only = events[0];
      check(only?.type === 'error' && only.error.kind === 'aborted', `got ${JSON.stringify(only)}`);
    }
  },
  {
    name: 'usage is whole, non-negative numbers',
    async run(h) {
      const events = await collect(h.forScenario('text').stream(CONTRACT_REQUEST));
      const last = events.at(-1);
      check(last?.type === 'done', `ended with ${JSON.stringify(last)}`);
      for (const n of [last.usage.inputTokens, last.usage.outputTokens]) {
        check(Number.isInteger(n) && n >= 0, `usage ${JSON.stringify(last.usage)}`);
      }
    }
  },
  {
    name: 'signed thinking comes back on the next turn: the reply gives replay state that survives JSON, and the endpoint takes it',
    async run(h) {
      const events = await collect(h.forScenario('thinking-tool-call').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      const thinking = events.flatMap((e) => (e.type === 'thinking' ? [e.delta] : [])).join('');
      check(thinking === '' || thinking === CONTRACT_THINKING, `thinking was ${JSON.stringify(thinking)}`);
      const calls = events.flatMap((e) => (e.type === 'tool-call' ? [e.call] : []));
      check(calls.length === 1 && calls[0]!.name === CONTRACT_TOOL_CALL.name, `calls were ${JSON.stringify(calls)}`);
      const last = events.at(-1);
      check(last?.type === 'done' && last.stopReason === 'tool-calls', `ended with ${JSON.stringify(last)}`);
      check(last.replay !== undefined && typeof last.replay.adapter === 'string', 'the reply gave nothing to replay');
      // Stored as JSON, the way the journal keeps it.
      const replay = JSON.parse(JSON.stringify(last.replay)) as typeof last.replay;
      const assistant = { role: 'assistant', content: '', toolCalls: calls } as const;
      const withIt = await collect(h.forScenario('replay-check').stream(followUp({ ...assistant, replay })));
      checkOneTerminalLast(withIt);
      const text = withIt.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
      const end = withIt.at(-1);
      check(end?.type === 'done' && end.stopReason === 'end' && text === CONTRACT_TEXT, `with the replay it ended with ${JSON.stringify(end)}`);
      // The control: without it the same turn is refused, so the pass above means it was carried back.
      const without = await collect(h.forScenario('replay-check').stream(followUp(assistant)));
      const refused = without.at(-1);
      check(refused?.type === 'error' && refused.error.kind === 'bad-request', `without the replay it ended with ${JSON.stringify(refused)}`);
    }
  },
  {
    name: 'a tool call whose arguments are not valid JSON ends in an invalid-tool-call error, and is never passed on',
    async run(h) {
      const events = await collect(h.forScenario('bad-tool-arguments').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      check(!events.some((e) => e.type === 'tool-call'), 'a tool call with bad arguments was passed on');
      const last = events.at(-1);
      check(last?.type === 'error' && last.error.kind === 'invalid-tool-call', `ended with ${JSON.stringify(last)}`);
      check(last.error.toolName === CONTRACT_TOOL_CALL.name, `the error names ${JSON.stringify(last.error.toolName)}`);
    }
  },
  {
    name: 'cache usage is reported as part of the input',
    async run(h) {
      const events = await collect(h.forScenario('cache').stream(CONTRACT_REQUEST));
      const last = events.at(-1);
      check(last?.type === 'done', `ended with ${JSON.stringify(last)}`);
      const u = last.usage;
      check(u.inputTokens === CONTRACT_CACHE.inputTokens && u.cacheReadTokens === CONTRACT_CACHE.cacheReadTokens, `usage ${JSON.stringify(u)}`);
      const write = u.cacheWriteTokens ?? 0;
      check(Number.isInteger(write) && write >= 0 && u.cacheReadTokens + write <= u.inputTokens, `cache writes ${JSON.stringify(u)}`);
    }
  },
  {
    name: 'a reply cut off at its length limit ends in done with stop reason length',
    async run(h) {
      const events = await collect(h.forScenario('length').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      check(events.some((e) => e.type === 'text'), 'no text before the stop');
      const last = events.at(-1);
      check(last?.type === 'done' && last.stopReason === 'length', `ended with ${JSON.stringify(last)}`);
    }
  },
  {
    name: 'a content filter ends the reply in a filtered error',
    async run(h) {
      const events = await collect(h.forScenario('filtered').stream(CONTRACT_REQUEST));
      checkOneTerminalLast(events);
      const last = events.at(-1);
      check(last?.type === 'error' && last.error.kind === 'filtered', `ended with ${JSON.stringify(last)}`);
    }
  },
  {
    name: 'HTTP 429 is a rate-limit error with its Retry-After, marked as not processed',
    async run(h) {
      const events = await collect(h.forScenario('rate-limit').stream(CONTRACT_REQUEST));
      check(events.length === 1, `expected only the error, got ${JSON.stringify(events)}`);
      const e = events[0];
      check(e?.type === 'error' && e.error.kind === 'rate-limit', `got ${JSON.stringify(e)}`);
      check(e.error.retryAfterMs === 2000 && e.error.notProcessed === true, `got ${JSON.stringify(e.error)}`);
    }
  },
  {
    name: 'an overloaded endpoint is a server error marked as not processed',
    async run(h) {
      const events = await collect(h.forScenario('overloaded').stream(CONTRACT_REQUEST));
      check(events.length === 1, `expected only the error, got ${JSON.stringify(events)}`);
      const e = events[0];
      check(e?.type === 'error' && e.error.kind === 'server' && e.error.notProcessed === true, `got ${JSON.stringify(e)}`);
    }
  },
  {
    name: 'HTTP 500 is a server error that might have been half done',
    async run(h) {
      const events = await collect(h.forScenario('server-error').stream(CONTRACT_REQUEST));
      check(events.length === 1, `expected only the error, got ${JSON.stringify(events)}`);
      const e = events[0];
      check(e?.type === 'error' && e.error.kind === 'server' && e.error.notProcessed === undefined, `got ${JSON.stringify(e)}`);
    }
  },
  {
    name: "no error repeats the endpoint's own words",
    async run(h) {
      for (const s of ['auth-error', 'rate-limit', 'overloaded', 'server-error', 'filtered', 'bad-tool-arguments'] as const) {
        const last = (await collect(h.forScenario(s).stream(CONTRACT_REQUEST))).at(-1);
        check(last?.type === 'error', `${s} ended with ${JSON.stringify(last)}`);
        // A message that passes on an endpoint's text could pass on a key it echoed.
        check(!JSON.stringify(last).includes(ENDPOINT_WORDS), `${s}: the error repeats the endpoint's text: ${JSON.stringify(last)}`);
      }
    }
  }
];

/**
 * Reads a stream to its end. `afterFirst` runs once, right after the first event (used to stop part way).
 * Fails if the stream throws or doesn't end within the abort deadline after `afterFirst`.
 */
async function collect(stream: AsyncIterable<ModelEvent>, afterFirst?: () => void): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  let deadline: Promise<never> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const next = iterator.next();
      const result = deadline ? await Promise.race([next, deadline]) : await next;
      if (result.done) return events;
      events.push(result.value);
      if (afterFirst && events.length === 1) {
        afterFirst();
        deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the stream didn't end within ${ABORT_DEADLINE_MS} ms of stopping`)), ABORT_DEADLINE_MS);
        });
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function checkOneTerminalLast(events: readonly ModelEvent[]): void {
  const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
  check(terminals.length === 1, `expected exactly one done or error, got ${terminals.length}`);
  check(events.at(-1) === terminals[0], 'something followed the done or error event');
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
