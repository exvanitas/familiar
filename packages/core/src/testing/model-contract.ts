// The model port's contract. Every adapter runs these cases: the fake model now, the pi-ai adapter
// (over recorded responses) from step 4. Plain async checks, so any test runner can drive them.

import type { ModelEvent, ModelPort, ModelRequest } from '../model/port.ts';

/** What the harness must prime a port to do for each case. */
export type ContractScenario =
  | 'text' // replies with CONTRACT_TEXT and stops
  | 'tool-call' // calls CONTRACT_TOOL_CALL's tool with its arguments
  | 'auth-error' // the endpoint refuses the key
  | 'slow'; // a reply long enough to stop part way: at least two events before its end

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
