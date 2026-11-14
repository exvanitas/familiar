// Bundle entry: the adapter with all three APIs, loaded eagerly into one file.
import * as anthropic from '@earendil-works/pi-ai/api/anthropic-messages';
import * as google from '@earendil-works/pi-ai/api/google-generative-ai';
import * as openai from '@earendil-works/pi-ai/api/openai-completions';
import { createPiAiModelPort, type PiAiApiModule } from '../pi-ai-model-port.ts';

(globalThis as Record<string, unknown>).__familiarSpike = {
  createPiAiModelPort,
  loaders: {
    'openai-completions': async () => openai as PiAiApiModule,
    'anthropic-messages': async () => anthropic as PiAiApiModule,
    'google-generative-ai': async () => google as PiAiApiModule
  }
};
