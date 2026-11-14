// Bundle entry: OpenAI chat completions and Anthropic messages only (Gemini through its OpenAI-compatible endpoint).
import * as anthropic from '@earendil-works/pi-ai/api/anthropic-messages';
import * as openai from '@earendil-works/pi-ai/api/openai-completions';
import { createPiAiModelPort, type PiAiApiModule } from '../pi-ai-model-port.ts';

(globalThis as Record<string, unknown>).__familiarSpike = {
  createPiAiModelPort,
  loaders: {
    'openai-completions': async () => openai as PiAiApiModule,
    'anthropic-messages': async () => anthropic as PiAiApiModule
  }
};
