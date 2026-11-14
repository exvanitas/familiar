// Bundle entry: the adapter with only the Anthropic messages API, loaded eagerly.
import * as api from '@earendil-works/pi-ai/api/anthropic-messages';
import { createPiAiModelPort, type PiAiApiModule } from '../pi-ai-model-port.ts';

(globalThis as Record<string, unknown>).__familiarSpike = {
  createPiAiModelPort,
  loaders: { 'anthropic-messages': async () => api as PiAiApiModule }
};
