// The app build carries no named mutation switch (docs/mcp-design.md 7.2): every call site is guarded by
// a constant the app build folds to false, so the branches, the mutations' names, `mutant` and the
// `mutations` controls are all dropped, and so is the state kept only for mutations (`lastCall`, `atEnd`). The control builds the same pages with the constant true and
// finds them, so the scan can see.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { APP_BUILD } from '../scripts/define.ts';
import { nodeStub } from '../scripts/node-stub.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const coreSrc = join(root, '..', '..', 'packages', 'core', 'src');
const coreIndex = join(coreSrc, 'index.ts');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Every named mutation in core's sources. */
const NAMES = [...new Set(files(coreSrc).filter((f) => !f.endsWith('mutations.ts')).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bmutant\('([a-z0-9-]+)'\)/g)].map((m) => m[1]!)))];

/** The app's pages, built as scripts/build.ts builds them, with the given define. */
async function pages(define: Record<string, string>, minifySyntax = true): Promise<string> {
  const r = await build({
    // The app's pages, and core's whole index beside them, so the journal (which no page opens yet) is in the
    // scan too, and both sentinels can be found in the test build.
    entryPoints: { core: `${root}src/app/core.ts`, chat: `${root}src/app/chat.ts`, settings: `${root}src/app/settings.ts`, index: coreIndex },
    outdir: `${root}dist/probe-mutations`,
    bundle: true, format: 'esm', target: 'chrome120', legalComments: 'none', logLevel: 'silent', write: false, define, minifySyntax, plugins: [nodeStub]
  });
  return r.outputFiles.map((f) => f.text).join('\n');
}

const found = (text: string) => [...NAMES.filter((n) => text.includes(`"${n}"`) || text.includes(`'${n}'`)), ...['__FAMILIAR_MUTATIONS__', 'function mutant(', 'mutations = {', 'hits.set(', 'lastCall', 'atEnd'].filter((s) => text.includes(s))];

describe('the app build and the named mutations', () => {
  it('drops every switch, its name and the controls from the pages', async () => {
    expect(NAMES.length).toBeGreaterThan(30);
    expect(found(await pages(APP_BUILD.define, APP_BUILD.minifySyntax))).toEqual([]);
  }, 60_000);

  it('the control: the same pages with the constant true carry them, so the scan can see', async () => {
    const text = await pages({ __FAMILIAR_MUTATIONS__: 'true' });
    // Each sentinel by name, so the scan is shown to see the mutation-only state, not only some names.
    expect(text).toContain('lastCall');
    expect(text).toContain('atEnd');
    expect(found(text).length).toBeGreaterThan(NAMES.length / 2);
  }, 60_000);
});
