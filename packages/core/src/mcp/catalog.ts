// A server's tool list, checked before anything hashes it or shows it: bounded in count, depth, nodes and
// bytes, every name once. The walk is iterative and stops at the first bound, so a list built to exhaust
// the stack or the CPU fails as a plain failure instead. Then each tool gets its fingerprint.

import { canonicalJson, sha256 } from './hash.ts';
import type { Failure, ListedTool } from './types.ts';
import type { HeaderDeclaration } from './wire/headers.ts';

export const MAX_TOOLS = 128;
export const MAX_SCHEMA_DEPTH = 32;
export const MAX_SCHEMA_NODES = 4000;
export const MAX_TOOL_BYTES = 64 * 1024;
export const MAX_CATALOG_BYTES = 1024 * 1024;
export const MAX_TOOL_NAME = 128;

/** A tool list that broke a bound, with the plain words. */
export class CatalogError extends Error {
  readonly failure: Failure;
  constructor(words: string) {
    super(words);
    this.failure = { kind: 'protocol', words };
  }
}

/** What the model and the person see as a tool's description: its description, else its title. */
export function effectiveDescription(t: { description?: string; title?: string }): string {
  return t.description ?? t.title ?? '';
}

/**
 * A tool's fingerprint: SHA-256 of its name, title, effective description and input schema, in canonical
 * JSON, plus, on a modern remote run, its header declarations (5.11): the arguments that run mirrors into
 * headers. The same tool from a legacy run and from a modern one, or with other declarations, is another
 * tool. A new or changed fingerprint is a new tool. Call it only on a tool `checkTools` passed.
 */
export function toolFingerprint(t: { name: string; title?: string; description?: string; inputSchema: unknown }, declarations?: readonly HeaderDeclaration[]): string {
  return sha256(canonicalJson({ name: t.name, title: t.title ?? '', description: effectiveDescription(t), inputSchema: t.inputSchema, ...(declarations ? { modern: { headers: declarations } } : {}) }));
}

export interface CatalogOptions {
  /** A modern remote run's header declarations, by tool name: given, every tool's fingerprint covers its own
      (none declared is an empty list, still unlike a legacy run's). */
  readonly declarations?: ReadonlyMap<string, readonly HeaderDeclaration[]>;
}

/** Walks a value without recursion, counting nodes and depth, and stops at the first bound. */
function boundedShape(value: unknown): 'ok' | 'depth' | 'nodes' {
  const stack: [unknown, number][] = [[value, 1]];
  let nodes = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++nodes > MAX_SCHEMA_NODES) return 'nodes';
    if (v === null || typeof v !== 'object') continue;
    if (depth > MAX_SCHEMA_DEPTH) return 'depth';
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    if (nodes + children.length > MAX_SCHEMA_NODES) return 'nodes';
    for (const c of children) stack.push([c, depth + 1]);
  }
  return 'ok';
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The whole list, checked and fingerprinted, or a CatalogError. */
/** A tool as a server's list gives it, unchecked. */
const readOnly = (a: unknown) => (a !== null && typeof a === 'object' ? (a as { readOnlyHint?: unknown }).readOnlyHint : undefined);

export type RawTool = Readonly<Record<string, unknown>> & { readonly name?: unknown };

export function checkTools(raw: readonly RawTool[], options: CatalogOptions = {}): ListedTool[] {
  if (raw.length > MAX_TOOLS) throw new CatalogError(`The server lists ${raw.length} tools. Familiar takes at most ${MAX_TOOLS}.`);
  const seen = new Set<string>();
  let total = 0;
  const out: ListedTool[] = [];
  for (const t of raw) {
    if (typeof t.name !== 'string' || t.name.length === 0 || t.name.length > MAX_TOOL_NAME) throw new CatalogError(`The server lists a tool with a name Familiar can't use.`);
    if (seen.has(t.name)) throw new CatalogError(`The server lists two tools named ${t.name.slice(0, 64)}, so Familiar can't tell them apart.`);
    seen.add(t.name);
    if (t.inputSchema === null || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema)) throw new CatalogError(`The tool ${t.name.slice(0, 64)} has no input schema object.`);
    const shape = boundedShape(t.inputSchema);
    if (shape !== 'ok') throw new CatalogError(`The tool ${t.name.slice(0, 64)} has inputs ${shape === 'depth' ? `nested deeper than ${MAX_SCHEMA_DEPTH} levels` : `with more than ${MAX_SCHEMA_NODES} parts`}, more than Familiar takes.`);
    const tool: Omit<ListedTool, 'fingerprint'> = {
      name: t.name,
      ...(typeof t.title === 'string' ? { title: t.title } : {}),
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      ...(readOnly(t.annotations) !== undefined ? { readOnlyHint: readOnly(t.annotations) === true } : {})
    };
    const size = bytes(canonicalJson(tool));
    if (size > MAX_TOOL_BYTES) throw new CatalogError(`The tool ${t.name.slice(0, 64)} is described in ${size} bytes. Familiar takes at most ${MAX_TOOL_BYTES} for one tool.`);
    total += size;
    if (total > MAX_CATALOG_BYTES) throw new CatalogError(`The server's tools are described in more than ${MAX_CATALOG_BYTES} bytes, more than Familiar takes.`);
    out.push({ ...tool, fingerprint: toolFingerprint(tool, options.declarations ? (options.declarations.get(tool.name) ?? []) : undefined) });
  }
  return out;
}
