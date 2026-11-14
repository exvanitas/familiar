// Bundle entry: the adapter with only the native Gemini API (@google/genai), loaded eagerly.
import * as api from '@earendil-works/pi-ai/api/google-generative-ai';
import { createPiAiModelPort, type PiAiApiModule } from '../pi-ai-model-port.ts';

(globalThis as Record<string, unknown>).__familiarSpike = {
  createPiAiModelPort,
  loaders: { 'google-generative-ai': async () => api as PiAiApiModule }
};
