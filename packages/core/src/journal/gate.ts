// The consent gate: the one place that decides whether a tool call runs, asks first, or never runs. Every
// execution passes through it, as pi-durable's `beforeTool` hook: a fresh call, one asked again after a
// restart, a "Do it now?" Yes, a Run again, and a call the model makes again on its own.
//
// It fails closed:
//   - only the built-in tools on RUN_WITHOUT_ASKING run without asking: they're visible and undoable
//   - anything else asks: every MCP tool, every other built-in, and a tool nobody knows
//   - deny wins over everything
//   - a tool's own `asks` can only make it stricter, never looser
// Step 8's Settings put a per-tool allow, ask or deny on top, through `GatePolicy.perTool`.

import type { FamiliarTool } from './tools.ts';

export type ToolPolicy = 'allow' | 'ask' | 'deny';

/** Built-in tools that run without asking: adding a note, setting or cancelling a reminder. */
export const RUN_WITHOUT_ASKING: readonly string[] = ['note_add', 'reminder_set', 'reminder_cancel'];

export interface GatePolicy {
  /** The person's own choice per tool, from Settings. */
  readonly perTool?: Readonly<Record<string, ToolPolicy>>;
}

/** What the gate does with one call of `name`. `tool` is undefined for a tool nobody knows. */
export function gateFor(name: string, tool: FamiliarTool | undefined, policy: GatePolicy = {}): ToolPolicy {
  const chosen = policy.perTool?.[name];
  if (chosen === 'deny') return 'deny';
  const listed = tool !== undefined && tool.kind !== 'server' && RUN_WITHOUT_ASKING.includes(name);
  let p: ToolPolicy = chosen ?? (listed ? 'allow' : 'ask');
  if (tool?.asks && p === 'allow') p = 'ask';
  return p;
}
