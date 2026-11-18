// Named mutations: switches in the code under test that put back a known defect, so the harness can show
// each of its checks fails on the defect it exists for (docs/mcp-design.md 7.2). Every switch is off unless
// a test turns it on; each time a switch changes behaviour it's counted, so a mutant that never changed
// anything is caught as a broken control. Nothing in the app turns one on.

const on = new Set<string>();
const hits = new Map<string, number>();

/** True only when the test turned this mutation on; counted when it is. */
export function mutant(name: string): boolean {
  if (on.size === 0 || !on.has(name)) return false;
  hits.set(name, (hits.get(name) ?? 0) + 1);
  return true;
}

/** For the harness: turn mutations on (all others off), read their counts, and reset. */
export const mutations = {
  set(names: readonly string[]): void {
    on.clear();
    hits.clear();
    for (const n of names) on.add(n);
  },
  hits(name: string): number {
    return hits.get(name) ?? 0;
  },
  clear(): void {
    on.clear();
    hits.clear();
  }
};
