import { describe, it } from 'vitest';
import { CONTRACT_TEXT, CONTRACT_TOOL_CALL, createFakeModel, modelPortContract } from '../src/testing/index.ts';
import type { ContractScenario, FakeReply, ModelPortHarness } from '../src/testing/index.ts';

const scenarios: Record<ContractScenario, FakeReply> = {
  text: { text: CONTRACT_TEXT, chunkSize: 5 },
  'tool-call': { text: 'Let me look.', toolCalls: [{ id: 'call_1', ...CONTRACT_TOOL_CALL }] },
  'auth-error': { error: { kind: 'auth', message: 'The key was refused.' } },
  slow: { text: 'A long reply that arrives one character at a time.', chunkSize: 1 }
};

const fakeHarness: ModelPortHarness = {
  forScenario: (scenario) => createFakeModel(() => scenarios[scenario])
};

describe('the fake model keeps the model port contract', () => {
  for (const c of modelPortContract) it(c.name, () => c.run(fakeHarness));
});
