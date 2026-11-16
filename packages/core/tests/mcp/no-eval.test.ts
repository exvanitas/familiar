// The MCP client with code generation from strings off, as under the app's CSP: the SDK's schema checker
// (Ajv) is replaced, and zod's probe for eval must fall back. A child Node runs no-eval-run.ts with
// --disallow-code-generation-from-strings. The runner's proc-mcp checks run the same client in the real
// core page under the real CSP.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('the MCP client with eval off', () => {
  it('initializes, lists, calls and reports an error', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--disallow-code-generation-from-strings', join(import.meta.dirname, 'no-eval-run.ts')], { timeout: 60_000 });
    const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
    const r = JSON.parse(line!.slice(7));
    expect(r.codegen).toBe('refused');
    expect(r.error).toBeUndefined();
    expect(r.start).toBe('ready');
    expect(r.tools).toContain('echo');
    expect(r.tools).toHaveLength(9);
    expect(r.echo).toEqual({ kind: 'result', text: 'no eval', isError: false });
    expect(r.fail).toMatchObject({ kind: 'result', isError: true });
    expect(r.unknown).toMatchObject({ kind: 'error', reason: 'protocol' });
    // A tool with an output schema lists and answers: nothing compiles code from its schema.
    expect(r.structured).toEqual(['count', JSON.stringify({ kind: 'result', text: '{"n":3}', isError: false })]);
  });
});
