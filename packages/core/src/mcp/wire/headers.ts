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
  // A declaration may not be a `$ref` target, nor inside one: another part of the schema could then carry
  // the same argument under another path.
  const refs = localRefs(schema);
  for (const d of out) {
    const pointer = `#${d.path.map((k) => `/properties/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')}`;
    if (refs.some((r) => pointer === r || pointer.startsWith(`${r}/`))) return { ok: false, reason: `${where(d.path)}: x-mcp-header may not sit on a $ref target` };
  }
  return { ok: true, declarations: out };
}

/** Every local `$ref` (`#…`) anywhere in a schema, bounded by the schema's own bounds checked earlier. */
function localRefs(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#')) out.push(v === '#' ? '' : v);
      else walk(v);
    }
  };
  walk(schema);
  return out.map((r) => (r === '' ? '#' : r));
}

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
    if (new TextEncoder().encode(`${name}: ${value}`).length > MAX_HEADER_BYTES) {
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
