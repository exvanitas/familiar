// The engine path Familiar would use: Harness, registry, one extension with Familiar-style tools, a consent hook,
// a reminder task that parks on a durable sleep, and a model reached only through Familiar's ModelPort.
// It imports only pi-durable's root, its browser storages, pi-ai's `models` and two small utils, and chord's context.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  Harness,
  LiveDoc,
  ToolTask,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  hook
} from '@earendil-works/pi-durable';
import type { ModelPort } from '@familiar/core';
import { portProvider } from './port-provider.ts';

export const ctx = BACKGROUND_CONTEXT;
export const PROVIDER = 'familiar';
export const MODEL_ID = 'fake-1';

export interface EngineHooks {
  /** Runs when the tool body starts; the spike counts executions across reloads with it. */
  onToolStart?(name: string, args: unknown): void;
  /** Never resolves when the spike wants the tool in flight at the reload. */
  toolBody?(name: string, args: unknown, signal: AbortSignal | undefined): Promise<string>;
  /** Consent before a tool runs. Resolves true to allow. Asked again after a restart if it never answered. */
  consent?(name: string, args: unknown): Promise<boolean>;
  /** A reminder fired. */
  onReminder?(text: string, at: number, firedAt: number): void;
  onReport?(report: unknown): void;
}

export interface EngineOptions {
  readonly storage: any;
  readonly port: ModelPort;
  readonly replay: 'safe' | 'unsafe';
  readonly hooks: EngineHooks;
  readonly maxTurns?: number;
}

const noteSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false
} as const;

export const Reminder = defineTask<{ text: string; at: number }, { phase: 'wait' } | { phase: 'deliver' }, null>({
  name: 'familiar.reminder',
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    wait: (task: any, runtime: any, context: any) => runtime.sleepUntil(task.input.at, { phase: 'deliver' }, context),
    deliver: async (task: any, runtime: any, context: any) => {
      currentHooks?.onReminder?.(task.input.text, task.input.at, Date.now());
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    }
  },
  abort: (_task: any, runtime: any, context: any) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
} as any);

// Tasks resolve their code from the registry, not a closure per open, so the reminder reads the hooks of the
// engine this page opened.
let currentHooks: EngineHooks | undefined;

export async function openEngine(options: EngineOptions) {
  currentHooks = options.hooks;
  const { provider } = portProvider(options.port, { id: PROVIDER, modelId: MODEL_ID });
  const models = createModels();
  models.setProvider(provider);

  const saveNote = defineTool({
    name: 'save_note',
    description: 'Save a note for the user. Writes, so it asks first and must never run twice.',
    parameters: noteSchema as any,
    replay: options.replay,
    execute: async (args: any, _api: any, context: any) => {
      options.hooks.onToolStart?.('save_note', args);
      const out = options.hooks.toolBody
        ? await options.hooks.toolBody('save_note', args, context?.signal)
        : `saved: ${args.text}`;
      return { output: [{ type: 'text', text: out }] };
    }
  } as any);

  const consent = hook(ToolTask, {
    beforeTool: async (call: any) => {
      if (!options.hooks.consent) return undefined;
      const ok = await options.hooks.consent(call.name, call.arguments);
      return ok ? undefined : { block: 'The user said no.' };
    }
  } as any);

  const familiar = defineExtension({
    name: 'familiar',
    tools: [saveNote],
    hooks: [consent],
    tasks: [Reminder]
  } as any);

  const registry = createRegistry();
  registry.install(familiar);

  const harness: any = await Harness.open(
    options.storage,
    {
      models,
      registry,
      identity: { attribution: null },
      settings: { retry: { maxRetries: 2 } },
      onReport: (report: unknown) => options.hooks.onReport?.(report)
    } as any,
    ctx
  );
  const root: any = await harness.root(ctx, {
    agent: {
      model: { provider: PROVIDER, modelId: MODEL_ID },
      instructions: 'You are Familiar.',
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {})
    }
  });
  return { harness, root, registry };
}

/** Familiar's three states, read from committed state only. */
export function familiarState(view: any): 'idle' | 'thinking' | 'working' | 'waiting' {
  const live = view?.docs?.['pi.live'];
  if (!live?.run) return 'idle';
  const tools = live.tools ?? live.round?.tools;
  if (tools && Object.values(tools).some((t: any) => t.status !== 'done')) return 'working';
  if (live.generation) return 'thinking';
  return 'waiting';
}

export { LiveDoc };
