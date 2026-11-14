// pi-durable's own storage conformance cases, run in the page without a test runner. The assertions follow
// Vitest's toEqual and toMatchObject closely enough for these cases. The Vitest run in tests/ is the cross-check.

import { createStorageConformance } from '@earendil-works/pi-durable/testing';

function fail(message: string): never {
  throw new Error(message);
}
const show = (v: unknown) => {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))?.slice(0, 200);
  } catch {
    return String(v);
  }
};

function equal(a: any, b: any, partial: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i], partial));
  const keys = (o: any) => Object.keys(o).filter((k) => o[k] !== undefined);
  const kb = keys(b);
  if (!partial && keys(a).length !== kb.length) return false;
  return kb.every((k) => equal(a[k], b[k], partial));
}

export const assertions = {
  ok(value: unknown, message?: string) {
    if (!value) fail(message ?? `expected truthy, got ${show(value)}`);
  },
  strictEqual(actual: unknown, expected: unknown) {
    if (!Object.is(actual, expected)) fail(`expected ${show(expected)}, got ${show(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown) {
    if (!equal(actual, expected, false)) fail(`expected ${show(expected)}, got ${show(actual)}`);
  },
  partialDeepEqual(actual: unknown, expected: unknown) {
    if (!equal(actual, expected, true)) fail(`expected to match ${show(expected)}, got ${show(actual)}`);
  },
  greaterThan(actual: number, expected: number) {
    if (!(actual > expected)) fail(`expected ${actual} > ${expected}`);
  },
  async rejects(operation: Promise<unknown>, messageIncludes: string) {
    try {
      await operation;
    } catch (error: any) {
      if (!String(error?.message ?? error).includes(messageIncludes)) fail(`rejected with "${error?.message}", wanted "${messageIncludes}"`);
      return;
    }
    fail(`expected a rejection including "${messageIncludes}"`);
  }
};

export async function runConformance(withStorage: (use: (storage: any) => Promise<void>) => Promise<void>) {
  const cases = createStorageConformance({ assertions, withStorage } as any);
  const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
  for (const c of cases) {
    const t = performance.now();
    try {
      await c.run();
      results.push({ name: c.name, ok: true, ms: Math.round(performance.now() - t) });
    } catch (error: any) {
      results.push({ name: c.name, ok: false, error: String(error?.message ?? error).slice(0, 300), ms: Math.round(performance.now() - t) });
    }
  }
  return { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
}
