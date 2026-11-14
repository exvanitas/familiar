// Bundle entry: the adapter with all three APIs behind dynamic imports, so each SDK lands in its own chunk.
import { loaders } from '../loaders.ts';
import { createPiAiModelPort } from '../pi-ai-model-port.ts';

(globalThis as Record<string, unknown>).__familiarSpike = { createPiAiModelPort, loaders };
