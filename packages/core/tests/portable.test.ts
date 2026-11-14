// Core must run in the app's webview now and could run on a server or phone later,
// so it never imports Tauri, Node built-ins or the app. This keeps that true.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', 'src');
const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'crypto', 'dgram', 'dns', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'module', 'net', 'os', 'path', 'process', 'readline', 'stream', 'timers', 'tls', 'url', 'util', 'vm',
  'worker_threads', 'zlib'
];

// A package goes here only once it's checked to run without Node or Tauri (the MCP SDK's client parts, in step 7).
const ALLOWED_PACKAGES: readonly string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []
  );
}

function specifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  return out;
}

describe('core stays portable', () => {
  const found = files(src);

  it('has source files to check', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('imports only its own files and allowed packages', () => {
    const bad: string[] = [];
    for (const file of found) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const isNode = spec.startsWith('node:') || NODE_BUILTINS.includes(spec);
        const isTauri = spec.startsWith('@tauri-apps/');
        const isRelative = spec.startsWith('./') || spec.startsWith('../');
        const isAllowed = ALLOWED_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
        if (isNode || isTauri || !(isRelative || isAllowed)) bad.push(`${relative(src, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
