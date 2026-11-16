// Familiar's tools, as pi-durable tools. Each tool says what kind it is, and the kind alone decides what a
// restart does with a call that had started:
//
//   read    a pure read                          run again
//   write   a built-in write, through step.write run again; the write finds its receipt and isn't made twice
//   effect  a built-in tool with an outside effect not run; a question in chat: "Do it now?"
//   server  an MCP server's tool, whatever it says not run; reported as interrupted, with Run again
//
// pi-durable reruns only tools marked `replay: "safe"`, so only reads and built-in writes are. Every server
// tool is unsafe, read-only hints included: a server's word isn't proof.

import type { Context } from '@earendil-works/chord/context';
import { defineDoc, defineTool } from '@earendil-works/pi-durable';
import type { JsonValue } from '../model/port.ts';
import type { JsonSchema } from '../model/port.ts';

export type ToolKind = 'read' | 'write' | 'effect' | 'server';

/** What a built-in write can change: Familiar's own documents, in the commit that keeps its receipt. */
export interface WriteTx {
  /** A Session document, as a draft to change. Use documents made with `defineJournalDoc`. */
  doc<T extends Record<string, any>>(token: JournalDocToken<T>): Promise<T>;
}

export interface JournalDocToken<T> {
  readonly definition: { readonly kind: string };
  readonly __type?: T;
}

/** A Session document for Familiar's own state: latest value only, stored whole. */
export function defineJournalDoc<T extends Record<string, any>>(kind: string, initial: () => T): JournalDocToken<T> {
  return defineDoc<T>({ kind, version: 1, scope: 'session', initial, checkpointWhen: () => true }) as unknown as JournalDocToken<T>;
}

export interface ToolStep {
  /** The step's id: the same on every run of this call, a rerun after a restart included. */
  readonly id: string;
  readonly signal?: AbortSignal;
  /**
   * How the consent gate let this call through: by the person's standing "always" (`always`), or because
   * they said yes to this call (`asked`). A server tool checks it again when the call is sent.
   */
  readonly allowedBy?: AllowedBy;
  /**
   * A built-in write. `change` runs in one commit with the step's receipt, so the write is all made or
   * not made, and a rerun of the step gets the first run's value back without changing anything. Writes
   * are matched by their order within the step, so a rerun must make them in the same order.
   */
  write<T extends JsonValue>(change: (tx: WriteTx) => T | Promise<T>): Promise<T>;
}

export interface FamiliarTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly kind: ToolKind;
  /** Asks first: a consent card, with the exact call, before it runs. */
  readonly asks?: boolean;
  /**
   * A server's own word that its tool only reads (MCP's `readOnlyHint`). Shown to the person, never
   * trusted: a server tool still asks, and is never run again on its own.
   */
  readonly readOnlyHint?: boolean;
  /** What it does, in a few plain words for the question after a restart: "saving a note". */
  doing(args: unknown): string;
  /** The text the model gets back. A throw becomes an error result. */
  run(args: unknown, step: ToolStep): Promise<string>;
}

/** Whether pi-durable may run a started call again after a restart. */
export function replayOf(kind: ToolKind): 'safe' | 'unsafe' {
  return kind === 'read' || kind === 'write' ? 'safe' : 'unsafe';
}

/** The receipts of one step's writes, kept with its task until the task ends. */
const ReceiptDoc = defineDoc<{ writes: any[] }>({
  kind: 'familiar.step-receipts',
  version: 1,
  scope: 'task',
  initial: () => ({ writes: [] }),
  checkpointWhen: () => true
});

export type AllowedBy = 'always' | 'asked';

/** The consent gate, as the tool's own execute sees it: a reason not to run, or how the call was allowed. */
export type Gate = (call: { readonly name: string; readonly arguments: unknown }, api: any, context: Context) => Promise<{ refused: string } | { allowedBy: AllowedBy }>;

export function toDurableTool(tool: FamiliarTool, gate?: Gate) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as any,
    replay: replayOf(tool.kind),
    execute: async (args: unknown, api: any, context: Context) => {
      // The gate again, inside the tool: a call pi-durable recovers after a crash (a read or a built-in
      // write, run again) never passes `beforeTool`, so it's checked here against today's policy.
      const verdict = await gate?.({ name: tool.name, arguments: args }, api, context);
      if (verdict && 'refused' in verdict) return { isError: true, output: [{ type: 'text', text: verdict.refused }] };
      let writes = 0;
      const step: ToolStep = {
        id: String(api.taskId),
        signal: context?.abortSignal,
        ...(verdict ? { allowedBy: verdict.allowedBy } : {}),
        write: async (change) => {
          if (tool.kind !== 'write') throw new Error(`${tool.name} is not a built-in write, so it can't write.`);
          const index = writes++;
          return api.commit(async (tx: any) => {
            const receipts = await tx.doc(ReceiptDoc, api.taskId);
            if (index < receipts.writes.length) return JSON.parse(JSON.stringify(receipts.writes[index]));
            const value = await change({ doc: (token) => tx.doc(token) });
            receipts.writes.push(value ?? null);
            return value;
          }, context);
        }
      };
      const out = await tool.run(args, step);
      return { output: [{ type: 'text', text: out }] };
    }
  } as any);
}
