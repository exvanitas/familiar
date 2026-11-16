// Fixture loading for the tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readCard, type Card, type ReadResult } from '../src/index.ts';
import { pngFixtures } from './png-fixtures.ts';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

let built: Map<string, Uint8Array> | undefined;
/** The PNG fixtures, built in memory once per test file (none is committed). */
export function builtFixtures(): Map<string, Uint8Array> {
  built ??= pngFixtures();
  return built;
}

/** A fixture's bytes: a built one by its name, else the committed file. */
export function fixtureBytes(path: string): Uint8Array {
  const b = builtFixtures().get(path);
  return b ? b.slice() : new Uint8Array(readFileSync(join(FIXTURES, path)));
}

export function readFixture(path: string): ReadResult {
  return readCard(fixtureBytes(path));
}

/** A fixture that must read: its card. */
export function card(path: string): Card {
  const r = readFixture(path);
  if (!r.ok) throw new Error(`${path}: ${r.error.kind}`);
  return r.card;
}

/** A relative path with `/` between its names, whatever the OS gave. Fixture names are keyed that way. */
export function posixPath(path: string, separator: string = sep): string {
  return separator === '/' ? path : path.split(separator).join('/');
}

/** Every fixture: the committed files, relative to fixtures/ with `/` separators, and the built ones. */
export function allFixtures(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  const files = walk(FIXTURES).map((f) => posixPath(relative(FIXTURES, f))).filter((f) => !f.endsWith('.md'));
  return [...files, ...builtFixtures().keys()].sort();
}

/** A V3 card with only what a test sets. */
export function makeCard(fields: Partial<Card> = {}): Card {
  return {
    name: 'Test', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], group_only_greetings: [],
    system_prompt: '', post_history_instructions: '', creator_notes: '', creator: '', character_version: '', tags: [], extensions: {}, ...fields
  };
}

/** A small seeded PRNG (mulberry32), so the fuzz cases are the same every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
