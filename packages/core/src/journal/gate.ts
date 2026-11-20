// The consent gate: the one place that decides whether a tool call runs, asks first, or never runs. Every
// execution passes through it, as pi-durable's `beforeTool` hook: a fresh call, one asked again after a
// restart, a "Do it now?" Yes, a Run again, and a call the model makes again on its own.
//
// The rule (docs/mcp-design.md 5.6): no server tool runs without your Yes to that call, and no built-in
// runs unasked unless it's on Familiar's fixed notes-and-reminders list. It fails closed:
//   - only the built-in tools on RUN_WITHOUT_ASKING, and the built-in pure reads on BUILT_IN_READS, run
//     without asking: they're Familiar's own notes and reminders, visible and undoable, and the reads
//     write, open and send nothing
//   - every other built-in asks every time, whatever a choice says: a person's Allow for one is refused
//     when it's saved, and one found anyway is read as ask
//   - every server tool asks every time (whatever its read-only hint says), unless the person marked that
//     one tool "may run on its own" for exactly its version and setup (`own`, checked by its wrapper's
//     identity in server-tools.ts and again at the handoff); there's no "always" for a server's tool
//   - a tool nobody knows asks
//   - deny wins over everything
//   - a tool's own `asks` can only make it stricter, never looser

import { mutant } from '../mutations.ts';
import type { FamiliarTool } from './tools.ts';

export type ToolPolicy = 'allow' | 'ask' | 'deny';
/** What the gate does: run without asking (`allow`, a listed built-in), run because the person let this
    server tool run on its own (`own`), ask, or never run. */
export type GateVerdict = ToolPolicy | 'own';

/** Built-in tools that run without asking: adding a note, setting or cancelling a reminder. */
export const RUN_WITHOUT_ASKING: readonly string[] = ['note_add', 'reminder_set', 'reminder_cancel'];
/** Built-in pure reads, which run without asking too: searching and listing notes, listing reminders. */
export const BUILT_IN_READS: readonly string[] = ['note_search', 'note_list', 'reminder_list'];

/** Whether a built-in's name is on Familiar's fixed list of tools that may run unasked. */
export const unaskedBuiltIn = (name: string): boolean => RUN_WITHOUT_ASKING.includes(name) || BUILT_IN_READS.includes(name);

export interface GatePolicy {
  /** The person's own choice per tool, from Settings: `own` only for a server tool marked "may run on its
      own" whose grant matches it now; `allow` means anything only for a built-in on the fixed list. */
  readonly perTool?: Readonly<Record<string, GateVerdict>>;
  /** The person's saved choices couldn't be read at all: nothing runs without asking, built-ins included.
      A "never" still denies. */
  readonly askAll?: boolean;
}

/** What the gate does with one call of `name`. `tool` is undefined for a tool nobody knows. */
export function gateFor(name: string, tool: FamiliarTool | undefined, policy: GatePolicy = {}): GateVerdict {
  const chosen = policy.perTool?.[name];
  if (chosen === 'deny') return 'deny';
  let p: GateVerdict;
  if (tool?.kind === 'server') {
    // A server's tool: never "always". It runs unasked only on the person's "may run on its own".
    // (A named mutation puts the old "always" back: a plain allow for a server tool runs it unasked.)
    p = chosen === 'own' || (chosen === 'allow' && (__FAMILIAR_MUTATIONS__ && mutant('server-always'))) ? 'own' : 'ask';
  } else if (tool !== undefined) {
    const listed = RUN_WITHOUT_ASKING.includes(name) || (tool.kind === 'read' && BUILT_IN_READS.includes(name));
    p = listed && chosen !== 'ask' ? 'allow' : 'ask';
  } else p = 'ask';
  if ((tool?.asks || policy.askAll) && (p === 'allow' || p === 'own')) p = 'ask';
  return p;
}
