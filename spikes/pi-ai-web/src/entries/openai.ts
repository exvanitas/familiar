// Bundle entry: the adapter with only the OpenAI chat completions API, loaded eagerly.
import * as api from '@earendil-works/pi-ai/api/openai-completions';
import { createPiAiModelPort, type PiAiApiModule } from '../pi-ai-model-port.ts';

(globalThis as Record<string, unknown>).__familiarSpike = {
  createPiAiModelPort,
  loaders: { 'openai-completions': async () => api as PiAiApiModule }
};
