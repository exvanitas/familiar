// The MCP client bundles for the browser with no Node built-in: the SDK's client parts it imports, and
// everything they pull in. The app's own build stubs `node:` imports for pi-ai, so this bundles without
// that stub, and a Node import anywhere fails it.
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('the MCP client in a page', () => {
  it('bundles for the browser with no Node built-in and no stub', async () => {
    const r = await build({
      entryPoints: [join(import.meta.dirname, '..', '..', 'src', 'mcp', 'index.ts')],
      bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent'
    });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.filter(i => i.startsWith('node:') || /(^|\/)node_modules\/(fs|path|child_process|os|crypto)\//.test(i))).toEqual([]);
    expect(inputs.some(i => i.includes('@modelcontextprotocol/sdk/dist/esm/client/index.js'))).toBe(true);
    // The SDK's stdio transport, which needs Node, never comes in.
    expect(inputs.some(i => i.includes('client/stdio'))).toBe(false);
    expect(Object.values(r.metafile.outputs)[0]!.imports).toEqual([]);
  });
});
