// One lazy loader per API, so a bundler splits each provider's SDK into its own chunk.
import type { PiAiApi, PiAiApiModule } from './pi-ai-model-port.ts';

export const loaders: Record<PiAiApi, () => Promise<PiAiApiModule>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions') as Promise<PiAiApiModule>,
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages') as Promise<PiAiApiModule>,
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai') as Promise<PiAiApiModule>
};
