/* The runner's MCP checks, read as source: every id they report is in the security inventory, so the
   gate requires each, and the phase that runs them is wired in core and in the driver. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../shell-check/${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('the MCP checks on the runner', () => {
  const src = read('mcp-checks.ts');
  const ids = [...src.matchAll(/check\('(security|check)\.([a-z0-9.-]+)'/g)].map(m => `${m[1]}.${m[2]}`);
  const inventory = (JSON.parse(read('security-inventory.json')) as { ids: string[] }).ids;

  it('reports six security ids, each in the inventory', () => {
    expect(ids).toEqual(['security.mcp.add', 'security.mcp.call', 'security.mcp.crash-mid-call', 'security.mcp.changed-tool', 'security.mcp.secret-blanked', 'security.mcp.remove']);
    for (const id of ids) expect(inventory).toContain(id.replace(/^security\./, ''));
  });

  it('runs in the proc-mcp phase, which the driver starts', () => {
    expect(read('core.ts')).toMatch(/phase === 'proc-mcp'\) \{\n\s+await mcpChecks\(\{ ask, up \}\);/);
    expect(read('procs.ps1')).toMatch(/Run-Phase 'proc-mcp' \$log @\(.*'--phase', 'proc-mcp'\)/);
    expect(read('procs.ps1')).toMatch(/No-Strays 'proc-mcp'/);
  });

  it('goes through the real desktop ports, not a fake', () => {
    expect(src).toMatch(/import \{ desktopMcpPorts \} from '\.\.\/src\/mcp\.ts';/);
    expect(src).toMatch(/const ports = desktopMcpPorts\(shell\);/);
  });
});
