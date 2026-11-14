// Test helpers other packages use: the fake model and the model port contract.
export { createFakeModel } from './fake-model.ts';
export type { FakeModel, FakeReply, FakeScript } from './fake-model.ts';
export {
  ABORT_DEADLINE_MS,
  CONTRACT_REQUEST,
  CONTRACT_TEXT,
  CONTRACT_TOOL_CALL,
  modelPortContract
} from './model-contract.ts';
export type { ContractCase, ContractScenario, ModelPortHarness } from './model-contract.ts';
