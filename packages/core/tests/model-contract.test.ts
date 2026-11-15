import { describe, it } from 'vitest';
import {
  CONTRACT_CACHE,
  CONTRACT_TEXT,
  CONTRACT_THINKING,
  CONTRACT_TOOL_CALL,
  createFakeModel,
  modelPortContract
} from '../src/testing/index.ts';
import type { ContractScenario, FakeReply, ModelPortHarness } from '../src/testing/index.ts';
import type { ChatMessage, Replay } from '../src/index.ts';

const REPLAY: Replay = { adapter: 'fake', data: { signature: 'fake-signature' } };
const carriesReplay = (m: ChatMessage | undefined) =>
  m?.role === 'assistant' && JSON.stringify(m.replay) === JSON.stringify(REPLAY);

const scenarios: Record<Exclude<ContractScenario, 'replay-check'>, FakeReply> = {
  text: { text: CONTRACT_TEXT, chunkSize: 5 },
  'tool-call': { text: 'Let me look.', toolCalls: [{ id: 'call_1', ...CONTRACT_TOOL_CALL }] },
  'auth-error': { error: { kind: 'auth', message: 'The key was refused.' } },
  slow: { text: 'A long reply that arrives one character at a time.', chunkSize: 1 },
  'thinking-tool-call': { thinking: CONTRACT_THINKING, toolCalls: [{ id: 'call_2', ...CONTRACT_TOOL_CALL }], replay: REPLAY },
  'bad-tool-arguments': { error: { kind: 'invalid-tool-call', message: 'The model called get_time wrongly.', toolName: 'get_time' } },
  cache: { text: CONTRACT_TEXT, usage: { inputTokens: CONTRACT_CACHE.inputTokens, outputTokens: 9, cacheReadTokens: CONTRACT_CACHE.cacheReadTokens } },
  length: { text: 'Cut off', stopReason: 'length' },
  filtered: { text: 'Some', error: { kind: 'filtered', message: 'Filtered.' } },
  'rate-limit': { error: { kind: 'rate-limit', message: 'Slow down.', retryAfterMs: 2000, notProcessed: true } },
  overloaded: { error: { kind: 'server', message: 'Busy.', notProcessed: true } },
  'server-error': { error: { kind: 'server', message: 'It failed.' } }
};

const fakeHarness: ModelPortHarness = {
  forScenario: (scenario) =>
    createFakeModel((request) =>
      scenario !== 'replay-check'
        ? scenarios[scenario]
        : carriesReplay(request.messages[1])
          ? { text: CONTRACT_TEXT }
          : { error: { kind: 'bad-request', message: 'The thinking was missing.' } }
    )
};

describe('the fake model keeps the model port contract', () => {
  for (const c of modelPortContract) it(c.name, () => c.run(fakeHarness));
});
