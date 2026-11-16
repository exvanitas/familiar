// Picking fields out of parsed JSON one by one, each to its type and limit. Parsed objects are never
// spread or merged into ours: an own `__proto__` key would change a prototype. Opaque data
// (`extensions`) is copied key by key with the dangerous keys dropped.
import { MAX_EXTENSION_BYTES, MAX_EXTENSION_DEPTH, MAX_FIELD_CHARS, MAX_SHORT_CHARS } from './limits.ts';
import { cleanText, sliceText, utf8Length } from './text.ts';
import type { JsonObject, JsonValue, Warning } from './types.ts';

/** Collects warnings once per kind of problem and field, so a hostile card can't flood them. */
export class Notes {
  readonly warnings: Warning[] = [];
  private readonly seen = new Set<string>();
  add(code: Warning['code'], message: string): void {
    const key = `${code}:${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.warnings.push({ code, message });
  }
}

const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

export type Raw = { readonly [key: string]: unknown };

export function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An own property only, so nothing comes from a prototype. */
export function own(o: Raw, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** A text field: '' when absent, cut at `max` with a warning. `field` names it in warnings, never its text. */
export function text(o: Raw, key: string, notes: Notes, field: string, max = MAX_FIELD_CHARS): string {
  const v = own(o, key);
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') {
    notes.add('wrong-type', `${field} wasn't text and was left empty.`);
    return '';
  }
  return cut(cleanText(v), max, notes, field);
}

export function cut(v: string, max: number, notes: Notes, field: string): string {
  if (v.length <= max) return v;
  notes.add('cut', `${field} was longer than ${max.toLocaleString('en-US')} characters and was cut.`);
  return sliceText(v, max);
}

/** A list of text: non-strings are skipped, the list is cut at `maxItems`, each item at `maxChars`. */
export function textList(o: Raw, key: string, notes: Notes, field: string, maxItems: number, maxChars = MAX_FIELD_CHARS, dropLong = false): string[] {
  const v = own(o, key);
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    notes.add('wrong-type', `${field} wasn't a list and was left empty.`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') {
      notes.add('wrong-type', `An item in ${field} wasn't text and was skipped.`);
      continue;
    }
    if (out.length === maxItems) {
      notes.add('too-many', `${field} had more than ${maxItems} items; the rest were dropped.`);
      break;
    }
    const clean = cleanText(item);
    if (dropLong && clean.length > maxChars) {
      // Cutting a key (a regex above all) would change what it matches, so it goes whole.
      notes.add('cut', `An item in ${field} was longer than ${maxChars} characters and was dropped.`);
      continue;
    }
    out.push(cut(clean, maxChars, notes, field));
  }
  return out;
}

export function flag(o: Raw, key: string, fallback: boolean): boolean {
  const v = own(o, key);
  return typeof v === 'boolean' ? v : fallback;
}

/** A finite number, clamped, or `undefined`. Integers when `integer`. */
export function num(o: Raw, key: string, min: number, max: number, integer = true): number | undefined {
  const v = own(o, key);
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.min(max, Math.max(min, v));
  return integer ? Math.trunc(n) : n;
}

export function short(o: Raw, key: string, notes: Notes, field: string): string {
  return text(o, key, notes, field, MAX_SHORT_CHARS);
}

/**
 * `extensions`: each top-level key copied as plain JSON, dropped whole when it nests deeper than
 * MAX_EXTENSION_DEPTH or is bigger than MAX_EXTENSION_BYTES as JSON. Strings inside are cleaned too.
 */
export function extensions(o: Raw, key: string, notes: Notes, field: string): JsonObject {
  const v = own(o, key);
  const out: JsonObject = {};
  if (!isObject(v)) return out;
  for (const k of Object.keys(v)) {
    const name = cleanText(k);
    if (DANGEROUS.has(name)) {
      notes.add('dropped-key', `A "${name}" key in ${field} was dropped.`);
      continue;
    }
    const copied = copyJson(v[k], 1, notes, field);
    if (copied === undefined) {
      notes.add('extension-dropped', `An extension in ${field} nested too deep and was dropped.`);
      continue;
    }
    if (utf8Length(JSON.stringify(copied), MAX_EXTENSION_BYTES) > MAX_EXTENSION_BYTES) {
      notes.add('extension-dropped', `An extension in ${field} was over ${MAX_EXTENSION_BYTES / 1024} KB and was dropped.`);
      continue;
    }
    out[name] = copied;
  }
  return out;
}

/** A plain-JSON copy, or `undefined` past the depth limit. Objects get only safe keys. */
function copyJson(v: unknown, depth: number, notes: Notes, field: string): JsonValue | undefined {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return cleanText(v);
  if (depth > MAX_EXTENSION_DEPTH) return undefined;
  if (Array.isArray(v)) {
    const out: JsonValue[] = [];
    for (const item of v) {
      const c = copyJson(item, depth + 1, notes, field);
      if (c === undefined) return undefined;
      out.push(c);
    }
    return out;
  }
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v)) {
      const name = cleanText(k);
      if (DANGEROUS.has(name)) {
        notes.add('dropped-key', `A "${name}" key in ${field} was dropped.`);
        continue;
      }
      const c = copyJson(v[k], depth + 1, notes, field);
      if (c === undefined) return undefined;
      out[name] = c;
    }
    return out;
  }
  return null;
}

/** A string-to-string map (`creator_notes_multilingual`), with safe keys only. */
export function textMap(o: Raw, key: string, notes: Notes, field: string, maxKeys: number): { [k: string]: string } | undefined {
  const v = own(o, key);
  if (!isObject(v)) return undefined;
  const out: { [k: string]: string } = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    const name = cut(cleanText(k), MAX_SHORT_CHARS, notes, field);
    if (DANGEROUS.has(name)) {
      notes.add('dropped-key', `A "${name}" key in ${field} was dropped.`);
      continue;
    }
    if (typeof v[k] !== 'string') continue;
    if (n === maxKeys) {
      notes.add('too-many', `${field} had more than ${maxKeys} entries; the rest were dropped.`);
      break;
    }
    out[name] = cut(cleanText(v[k] as string), MAX_FIELD_CHARS, notes, field);
    n++;
  }
  return out;
}
