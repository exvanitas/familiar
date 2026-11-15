/* The model layer: the pi-ai adapter, the presets, the model list and Settings' Test. Settings and
   the first-run screens (step 11) and the turn loop (step 5) build on these. */
export { createPiAiPort, loaders, retryAfterMs } from './pi-ai.ts';
export type { AdapterOptions, PiAiModule, WireApi } from './pi-ai.ts';
export { adapterOptions, NO_KEY, preset, PRESETS, priceFor } from './presets.ts';
export type { EndpointSetup, Preset, PresetId } from './presets.ts';
export { authHeaders, listModels, NO_TOOLS_NOTE } from './models.ts';
export type { ListedModel, ListProblem, ModelList } from './models.ts';
export { TEST_TOOL, testEndpoint } from './endpoint-test.ts';
export type { TestInput, TestProblem, TestResult } from './endpoint-test.ts';
