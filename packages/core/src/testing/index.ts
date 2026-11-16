// Test helpers other packages use: the fake model and the model port contract.
export { createFakeModel } from './fake-model.ts';
export type { FakeModel, FakeReply, FakeScript } from './fake-model.ts';
export {
  ABORT_DEADLINE_MS,
  CONTRACT_CACHE,
  CONTRACT_REQUEST,
  CONTRACT_TEXT,
  CONTRACT_THINKING,
  CONTRACT_TOOL_CALL,
  CONTRACT_TOOL_RESULT,
  ENDPOINT_WORDS,
  followUp,
  modelPortContract
} from './model-contract.ts';
export type { ContractCase, ContractScenario, ModelPortHarness } from './model-contract.ts';
export { CONTRACT_READING, traitCacheContract } from './trait-cache-contract.ts';
export type { TraitCacheCase } from './trait-cache-contract.ts';
export { processPortContract } from './process-contract.ts';
export type { ProcessContractCase, ProcessPortHarness } from './process-contract.ts';
export { settingsStoreContract } from './settings-contract.ts';
export type { SettingsContractCase, SettingsStoreHarness } from './settings-contract.ts';
