// The MCP client bundles for the browser with no Node built-in and no SDK: Familiar's own client is the
// only code that speaks MCP (docs/mcp-design.md, P3).
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('the MCP client in a page', () => {
  it('bundles for the browser with no Node built-in, no stub and no MCP SDK', async () => {
    const r = await build({
      entryPoints: [join(import.meta.dirname, '..', '..', 'src', 'mcp', 'index.ts')],
      bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent'
    });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.filter(i => i.startsWith('node:') || /(^|\/)node_modules\/(fs|path|child_process|os|crypto)\//.test(i))).toEqual([]);
    expect(inputs.filter(i => i.includes('@modelcontextprotocol'))).toEqual([]);
    expect(inputs.some(i => i.includes('src/mcp/wire/link.ts'))).toBe(true);
    expect(Object.values(r.metafile.outputs)[0]!.imports).toEqual([]);
  });
});
