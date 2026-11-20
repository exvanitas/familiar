// The modern era's custom headers (docs/mcp-design.md 3.5 and 3.6): a tool's `inputSchema` may declare,
// with `x-mcp-header`, that an argument is mirrored into an `Mcp-Param-{Name}` header on its tools/call.
// The scan and the codec follow the TS SDK's reading of the 2026-07-28 spec rule for rule (studied, not
// copied): where a declaration may sit, what its name and type may be, and how a value is written. Where
// the reference omits a header for a bad value, Familiar refuses the call instead, so the server never
// meets a body without its header.

/** A declaration found in a tool's schema: the argument's path, the header's name, its type. */
export interface HeaderDeclaration {
  readonly path: readonly string[];
  readonly name: string;
  readonly type: 'string' | 'integer' | 'boolean';
}

export type ScanResult = { readonly ok: true; readonly declarations: readonly HeaderDeclaration[] } | { readonly ok: false; readonly reason: string };

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TYPES = new Set(['string', 'integer', 'boolean']);
/** Keywords a declaration's path may not pass through; one found under them makes the tool invalid. */
const UNREACHABLE = ['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions'];
const NAMED = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_HEADERS = 64;

import { mutant } from '../../mutations.ts';

const where = (path: readonly string[]) => (path.length ? path.join('.') : 'the root');

/** Scans a tool's input schema. Invalid: not offered, and Test lists the reason. */
export function scanDeclarations(schema: unknown): ScanResult {
  const out: HeaderDeclaration[] = [];
  const names = new Map<string, string>();
  let numberFault: string | undefined;
  const visit = (node: unknown, path: readonly string[], reachable: boolean): string | undefined => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    const s = node as Record<string, unknown>;
    if ('x-mcp-header' in s) {
      if (!reachable || path.length === 0) return `${where(path)}: x-mcp-header may sit only on a property reached through "properties"`;
      const name = s['x-mcp-header'];
      if (typeof name !== 'string' || name === '') return `${where(path)}: x-mcp-header must be a non-empty string`;
      if (!TOKEN.test(name)) return `${where(path)}: x-mcp-header "${name.slice(0, 40)}" isn't a valid header name`;
      const type = typeof s.type === 'string' ? s.type : undefined;
      if (!type || !TYPES.has(type)) {
        const fault = `${where(path)}: x-mcp-header is allowed only on a string, integer or boolean property, not ${type ?? 'one with no type'}`;
        if (type !== 'number') return fault;
        numberFault ??= fault;
      }
      const lower = name.toLowerCase();
      if (names.has(lower)) return `x-mcp-header "${name}" is declared twice (also as "${names.get(lower)}")`;
      names.set(lower, name);
      if (type && TYPES.has(type)) out.push({ path, name, type: type as HeaderDeclaration['type'] });
    }
    const props = s.properties;
    if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
      for (const [k, child] of Object.entries(props as Record<string, unknown>)) {
        const f = visit(child, [...path, k], reachable);
        if (f) return f;
      }
    }
    for (const k of UNREACHABLE) {
      const sub = s[k];
      if (sub === undefined) continue;
      const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === 'object' && NAMED.has(k) ? Object.values(sub as Record<string, unknown>) : [sub];
      for (const b of branches) {
        const f = visit(b, [...path, `<${k}>`], false);
        if (f) return f;
      }
    }
    return undefined;
  };
  const fault = visit(schema, [], true);
  if (fault) return { ok: false, reason: numberFault ?? fault };
  if (numberFault) return { ok: false, reason: numberFault };
  if (out.length === 0) return { ok: true, declarations: out };
  // A declaration may not be a `$ref` target, nor inside one: another part of the schema could then carry
  // the same argument under another path. Each ref is resolved to the node it names; one Familiar can't
  // resolve fails the tool, closed. Linear: the targets go in a set, and each declaration looks up its own
  // node and its ancestors.
  const targets = refTargets(schema);
  if (typeof targets === 'string') return { ok: false, reason: targets };
  // A named mutation: the old product loop, every declaration against every target.
  if (__FAMILIAR_MUTATIONS__ && mutant('quadratic-ref-scan')) {
    const list = [...targets];
    for (const d of out) {
      const pointer = pointerOf(d.path.flatMap((k) => ['properties', k]));
      if (list.some((t) => pointer === t || pointer.startsWith(`${t}/`) || t === '')) return { ok: false, reason: `${where(d.path)}: x-mcp-header may not sit on a $ref target` };
    }
    return { ok: true, declarations: out };
  }
  for (const d of out) {
    const node = d.path.flatMap((k) => ['properties', k]);
    for (let i = 0; i <= node.length; i++) {
      if (i % 2 === 1) continue;
      if (targets.has(pointerOf(node.slice(0, i)))) return { ok: false, reason: `${where(d.path)}: x-mcp-header may not sit on a $ref target` };
    }
  }
  return { ok: true, declarations: out };
}

/** Keywords whose value is a map of schemas by name: its keys are names, never keywords. */
const MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions', 'dependencies']);
/** Keywords whose value is data, never a schema: a `$ref` inside them is data. */
const DATA = new Set(['default', 'examples', 'const', 'enum']);

const pointerOf = (keys: readonly string[]) => keys.map((k) => `/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/**
 * The node each `$ref` in a schema names, as a JSON Pointer from the root (`''` is the root). The walk is
 * generic: every keyword's value is walked as a schema position (an object a schema, an array a list of
 * them, a boolean a schema too), whatever the keyword, except the data keywords (`default`, `examples`,
 * `const`, `enum`); the known maps (`properties` and the like) are walked by name, so a property called
 * `default` is still a schema. A pointer fragment is percent-decoded and unescaped; a plain-name fragment
 * is looked up among the `$anchor`s. Anything Familiar can't scope is a reason, not a set, so the tool fails
 * closed: another document, an unknown anchor, a pointer to no schema, a dynamic ref, a `$ref` that isn't a
 * string, and a nested `$id` (or draft-04 `id`), which opens a resource of its own.
 */
function refTargets(schema: unknown): Set<string> | string {
  const refs: string[] = [];
  const anchors = new Map<string, string>();
  const nodes = new Set<string>();
  // [value, its keys from the root]
  const stack: [unknown, string[]][] = [[schema, []]];
  while (stack.length) {
    const [n, keys] = stack.pop()!;
    if (typeof n === 'boolean') {
      nodes.add(pointerOf(keys));
      continue;
    }
    if (Array.isArray(n)) {
      n.forEach((c, i) => stack.push([c, [...keys, String(i)]]));
      continue;
    }
    if (n === null || typeof n !== 'object') continue;
    const s = n as Record<string, unknown>;
    nodes.add(pointerOf(keys));
    if (typeof s.$ref === 'string') refs.push(s.$ref);
    else if (s.$ref !== undefined) return 'a $ref that is not a string';
    if (keys.length > 0 && (typeof s.$id === 'string' || typeof s.id === 'string')) return 'a nested $id, a resource of its own, which Familiar does not scope';
    if (typeof s.$anchor === 'string') anchors.set(s.$anchor, pointerOf(keys));
    if (s.$dynamicRef !== undefined || s.$dynamicAnchor !== undefined || s.$recursiveRef !== undefined) return 'a dynamic $ref, which Familiar does not resolve';
    for (const [k, v] of Object.entries(s)) {
      if (DATA.has(k)) continue;
      if (k === '$ref' || k === '$id' || k === '$anchor' || k === '$schema' || k === '$comment') continue;
      if (MAPS.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        for (const [name, c] of Object.entries(v as Record<string, unknown>)) stack.push([c, [...keys, k, name]]);
        continue;
      }
      stack.push([v, [...keys, k]]);
    }
  }
  const out = new Set<string>();
  for (const ref of refs) {
    if (!ref.startsWith('#')) return `a $ref to another document (${cutRef(ref)}), which Familiar does not resolve`;
    let fragment: string;
    try {
      fragment = decodeURIComponent(ref.slice(1));
    } catch {
      return `a $ref Familiar can't read (${cutRef(ref)})`;
    }
    if (fragment === '' || fragment.startsWith('/')) {
      const target = pointerOf(fragment.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~')));
      if (!nodes.has(target)) return `a $ref to no schema in it (${cutRef(ref)})`;
      out.add(target);
    } else {
      const target = anchors.get(fragment);
      if (target === undefined) return `a $ref to an anchor it doesn't have (${cutRef(ref)})`;
      out.add(target);
    }
  }
  return out;
}

const cutRef = (ref: string) => (ref.length > 40 ? `${ref.slice(0, 40)}…` : ref).replace(/[\u0000-\u001f\u007f\ud800-\udfff]/g, '?');

/** Whether a string is well-formed UTF-16: a lone surrogate would turn into U+FFFD on the wire. */
export function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const SENTINEL_HEAD = '=?base64?';
const SENTINEL_TAIL = '?=';

function plainSafe(s: string): boolean {
  if (s === '' || s !== s.trim()) return false;
  if (s.startsWith(SENTINEL_HEAD) && s.endsWith(SENTINEL_TAIL)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(c === 0x09 || (c >= 0x20 && c <= 0x7e))) return false;
  }
  return true;
}

function base64Utf8(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A header value: plain when it's safe visible ASCII, else the base64 sentinel over its UTF-8. */
export function encodeValue(s: string): string {
  return plainSafe(s) ? s : `${SENTINEL_HEAD}${base64Utf8(s)}${SENTINEL_TAIL}`;
}

function at(root: unknown, path: readonly string[]): unknown {
  let n = root;
  for (const k of path) {
    if (n === null || typeof n !== 'object' || Array.isArray(n)) return undefined;
    // Own properties only: an omitted `constructor` mustn't resolve to an inherited function.
    if (!Object.hasOwn(n as object, k)) return undefined;
    n = (n as Record<string, unknown>)[k];
  }
  return n;
}

/**
 * The `Mcp-Param-*` headers for one call, from the decision's own arguments, or the reason to refuse the
 * call before anything is sent: a value that isn't a primitive of its declared type, a non-finite number
 * or an unsafe integer, a string that isn't well-formed, a header past 8 KiB, or too many headers.
 */
export function paramHeaders(declarations: readonly HeaderDeclaration[], args: unknown, others: number): { readonly ok: true; readonly headers: readonly (readonly [string, string])[] } | { readonly ok: false } {
  const out: [string, string][] = [];
  for (const d of declarations) {
    const v = at(args, d.path);
    if (v === undefined || v === null) continue;
    let text: string;
    if (d.type === 'string') {
      if (typeof v !== 'string' || !wellFormed(v)) return { ok: false };
      text = v;
    } else if (d.type === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false };
      text = v ? 'true' : 'false';
    } else {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false };
      text = String(v);
    }
    const name = `Mcp-Param-${d.name}`;
    const value = encodeValue(text);
    if (new TextEncoder().encode((__FAMILIAR_MUTATIONS__ && mutant('measure-value-only')) ? value : `${name}: ${value}`).length > MAX_HEADER_BYTES) {
      if (!(__FAMILIAR_MUTATIONS__ && mutant('truncate-header'))) return { ok: false };
      out.push([name, value.slice(0, MAX_HEADER_BYTES - name.length - 2)]);
      continue;
    }
    out.push([name, value]);
  }
  if (out.length + others > MAX_HEADERS) return { ok: false };
  return { ok: true, headers: out };
}

export const HEADER_WORDS = "This call's arguments can't be sent to this server's headers.";
