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

// A package goes here only once it's checked to run without Node or Tauri.
// @familiar/cards has its own portability test: no imports but its own files.
const ALLOWED_PACKAGES: readonly string[] = ['@familiar/cards'];
// Exact entry points only. The pi-durable spike bundled each of these for the browser with no Node
// built-ins (spikes/pi-durable-web/RESULT.md); their /node entries and pi-ai's root reach Node.
const ALLOWED_ENTRIES: readonly string[] = [
  '@earendil-works/pi-durable',
  '@earendil-works/pi-durable/storage/indexeddb',
  '@earendil-works/chord/context',
  '@earendil-works/pi-ai/models',
  '@earendil-works/pi-ai/utils/event-stream',
  '@earendil-works/pi-ai/utils/transcript',
  // The MCP SDK's client parts. tests/mcp/bundle.test.ts bundles them for the browser and finds no Node.
  '@modelcontextprotocol/sdk/client/index.js',
  '@modelcontextprotocol/sdk/client/streamableHttp.js',
  '@modelcontextprotocol/sdk/shared/transport.js',
  '@modelcontextprotocol/sdk/types.js',
  '@modelcontextprotocol/sdk/validation/types.js'
];
// Pinned exactly: pi-durable calls itself experimental, with API changes between releases, and the MCP SDK
// is what speaks to every server.
const PINNED = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord', '@modelcontextprotocol/sdk'];

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
        const isAllowed = ALLOWED_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`)) || ALLOWED_ENTRIES.includes(spec);
        if (isNode || isTauri || !(isRelative || isAllowed)) bad.push(`${relative(src, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('pins pi-durable and what it stands on to one exact version', () => {
    const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'));
    for (const name of PINNED) expect(pkg.dependencies?.[name], name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
