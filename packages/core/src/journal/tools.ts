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
import { mintDecision, type CardFacts } from '../mcp/decision.ts';
import type { JsonValue } from '../model/port.ts';
import type { JsonSchema } from '../model/port.ts';
import { UNRECORDED } from './provenance.ts';

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
  /** For a tool bound to consent (a server's tool): the decision the gate minted for this call. */
  readonly decision?: unknown;
  /**
   * A built-in write. `change` runs in one commit with the step's receipt, so the write is all made or
   * not made, and a rerun of the step gets the first run's value back without changing anything. Writes
   * are matched by their order within the step, so a rerun must make them in the same order.
   */
  write<T extends JsonValue>(change: (tx: WriteTx) => T | Promise<T>): Promise<T>;
  /**
   * The outside sources of the request that made this call (5.6), for a write to keep with what it stores,
   * so a later read of it carries them on.
   */
  readonly sources: readonly string[];
  /**
   * Names the sources of stored data this run read (5.6): its result carries them, so the request that
   * reads the result is outside if they are. A built-in read that never says counts as outside.
   */
  readFrom(sources: readonly string[]): void;
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
  /**
   * A server's tool the person hasn't reviewed as it is now (5.6): its name and description are the
   * server's word, so a request that offers it is outside, and "always" doesn't apply to any call it makes.
   */
  readonly fresh?: boolean;
  /** Bound to consent at the call (a server's tool): the facts a card shows and a decision binds to,
      read now. Undefined: the call can't be bound (not running, not offered, not plain JSON). */
  readonly consent?: { facts(args: unknown): CardFacts | undefined };
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
/** How the gate let a call through: by "always" or the person's Yes, with the card's facts for a tool
    bound to consent, and whether the request carried outside content. */
export interface Allowed {
  readonly allowedBy: AllowedBy;
  /** The outside sources of the request that made the call: what its reply carries (5.6). */
  readonly sources?: readonly string[];
  readonly facts?: CardFacts;
  readonly outside?: boolean;
}

/** `id` is the model's id for the call, which finds the reply that made it, and that reply's request. */
export type Gate = (call: { readonly name: string; readonly arguments: unknown; readonly id?: string }, api: any, context: Context) => Promise<{ refused: string } | Allowed>;

export function toDurableTool(tool: FamiliarTool, gate?: Gate) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as any,
    replay: replayOf(tool.kind),
    execute: async (args: unknown, api: any, context: Context) => {
      // The gate again, inside the tool: a call pi-durable recovers after a crash (a read or a built-in
      // write, run again) never passes `beforeTool`, so it's checked here against today's policy.
      const verdict = await gate?.({ name: tool.name, arguments: args, ...(typeof api?.callId === 'string' ? { id: api.callId } : {}) }, api, context);
      if (verdict && 'refused' in verdict) return { isError: true, output: [{ type: 'text', text: verdict.refused }], details: { sources: [] } };
      // The gate mints here, inside the execute, from the facts it checked: a tool bound to consent gets
      // its one-use decision, or nothing runs.
      let decision: unknown;
      if (tool.consent) {
        const facts = verdict?.facts;
        decision = facts && verdict ? mintDecision(facts, String(api.taskId), verdict.allowedBy, verdict.outside ?? true) : undefined;
        if (!decision) return { isError: true, output: [{ type: 'text', text: 'Familiar had no consent it could bind to this exact call, so it was not sent.' }], details: { sources: [] } };
      }
      let writes = 0;
      // A read says what it read; anything else reads nothing stored, so its words are the person's, the
      // model's (whose sources are already in the request), or the tool's own.
      const read = new Set<string>();
      let said = false;
      const step: ToolStep = {
        sources: verdict?.sources ?? [UNRECORDED],
        readFrom: (sources) => {
          said = true;
          for (const s of sources) read.add(String(s));
        },
        id: String(api.taskId),
        signal: context?.abortSignal,
        ...(verdict ? { allowedBy: verdict.allowedBy } : {}),
        ...(decision ? { decision } : {}),
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
      if (tool.kind === 'read' && !said) read.add(UNRECORDED);
      return { output: [{ type: 'text', text: out }], details: { sources: [...read].sort() } };
    }
  } as any);
}
