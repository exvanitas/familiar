// Test-only consent: a decision minted as if the person said Yes on a card for exactly this call, for
// harnesses that drive the client without the journal (the Windows runner's MCP checks, the client's own
// tests). Never part of the app: the app imports `@familiar/core`, not `@familiar/core/testing`, and a
// module-graph test fails if anything outside the journal's gate and this file mints.

import type { McpClient } from '../mcp/client.ts';
import { mintDecision, type CardFacts, type ToolDecision } from '../mcp/decision.ts';
import type { ServerTool } from '../mcp/server-tools.ts';
import type { ToolStep } from '../journal/tools.ts';
import type { CallOutcome } from '../mcp/types.ts';

/** A decision for this call as the server offers it now, or undefined if it can't be bound. */
export function yesFor(client: McpClient, serverId: string, tool: string, args: unknown, step = 'test'): ToolDecision | undefined {
  const facts: CardFacts | undefined = client.facts(serverId, tool, args);
  return facts ? mintDecision(facts, step, 'asked', false) : undefined;
}

/** One call through `send`, with a fresh Yes. */
export function callWithYes(client: McpClient, serverId: string, tool: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<CallOutcome> {
  const d = yesFor(client, serverId, tool, args);
  return d ? client.send(d, signal) : Promise.resolve({ kind: 'error', reason: 'not-running', words: 'The server is not running, or no longer offers this tool.' });
}

/** A wrapper's run, as the journal's execute would make it after a Yes. */
export function runWithYes(t: ServerTool, args: unknown, step: Partial<ToolStep> = {}): Promise<string> {
  const facts = t.consent.facts(args);
  const decision = facts ? mintDecision(facts, 'test', 'asked', false) : undefined;
  return t.run(args, { id: 'test', write: async () => { throw new Error('no writes'); }, ...step, ...(decision ? { decision } : {}) } as ToolStep);
}
