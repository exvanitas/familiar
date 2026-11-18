// The MCP client with code generation from strings off, as under the app's CSP. With the SDK gone nothing
// compiles a schema; this keeps the client honest about that. A child Node runs no-eval-run.ts with
// --disallow-code-generation-from-strings. The runner's proc-mcp checks run the same client in the real
// core page under the real CSP.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('the MCP client with eval off', () => {
  it('initializes, lists, calls and reports an error', async () => {
    // Plain Node runs core's sources unbundled, so the app build's constant is set as a global first.
    const define = 'data:text/javascript,globalThis.__FAMILIAR_MUTATIONS__=false';
    const { stdout } = await promisify(execFile)(process.execPath, ['--disallow-code-generation-from-strings', '--import', define, join(import.meta.dirname, 'no-eval-run.ts')], { timeout: 60_000 });
    const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
    const r = JSON.parse(line!.slice(7));
    expect(r.codegen).toBe('refused');
    expect(r.error).toBeUndefined();
    expect(r.start).toBe('ready');
    expect(r.tools).toContain('echo');
    expect(r.tools).toHaveLength(10);
    expect(r.echo).toEqual({ kind: 'result', text: 'no eval', isError: false });
    expect(r.fail).toMatchObject({ kind: 'result', isError: true });
    // A tool the server doesn't offer is never sent.
    expect(r.unknown).toMatchObject({ kind: 'error' });
  });
});
