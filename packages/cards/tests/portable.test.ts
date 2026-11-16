// Cards must run in the app's webview now and could be lifted into a shared package later, so it never
// imports Tauri, Node built-ins, the app or core. It has no dependencies at all. This keeps that true.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', 'src');

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

describe('cards stays portable', () => {
  const found = files(src);

  it('has source files to check', () => {
    expect(found.length).toBeGreaterThan(5);
  });

  it('imports only its own files', () => {
    const bad: string[] = [];
    for (const file of found) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (!(spec.startsWith('./') || spec.startsWith('../'))) bad.push(`${relative(src, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('has no dependencies, and reaches for no global the webview lacks', () => {
    const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const file of found) expect(readFileSync(file, 'utf8'), file).not.toMatch(/\b(?:process|Buffer|require|__dirname)\b[.(]/);
  });
});
