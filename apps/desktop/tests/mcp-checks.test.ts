/* The runner's MCP checks, read as source: every id they report is in the security inventory, so the
   gate requires each, and the phase that runs them is wired in core and in the driver. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../shell-check/${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('the MCP checks on the runner', () => {
  const src = read('mcp-checks.ts');
  const ids = [...src.matchAll(/check\('(security|check)\.([a-z0-9.-]+)'/g)].map(m => `${m[1]}.${m[2]}`);
  const inventory = (JSON.parse(read('security-inventory.json')) as { ids: string[] }).ids;

  it('reports nine security ids, each in the inventory, the escaped-key one marked as a known gap', () => {
    expect(ids).toEqual(['security.mcp.add', 'security.mcp.call', 'security.mcp.crash-mid-call', 'security.mcp.changed-tool', 'security.mcp.secret-blanked', 'security.mcp.remove', 'security.mcp.legacy-transport', 'security.mcp.modern-transport', 'security.mcp.secret-json-escaped']);
    for (const id of ids) expect(inventory).toContain(id.replace(/^security\./, ''));
    const marks = (JSON.parse(read('security-inventory.json')) as { knownGaps: Record<string, { expect: string }> }).knownGaps;
    expect(Object.keys(marks)).toEqual(['mcp.secret-json-escaped']);
    // The check fails with exactly the detail the mark expects, and with other words when it can't measure.
    const escaped = read('escaped.ts');
    expect(escaped).toContain(`export const ESCAPED_GAP = '${marks['mcp.secret-json-escaped']!.expect}';`);
    expect(escaped).toMatch(/if \(leaked\) failWith\(`\$\{ESCAPED_GAP\}: /);
    expect(src).toMatch(/return await escapedCopyCheck\(client, heardBy, writtenBy, added\.id, k, sleep\)/);
    expect((JSON.parse(read('checks.json')) as { ids: string[] }).ids).not.toContain('mcp.secret-json-escaped');
    // It passes only if no copy of the key, escaped or not, came back; the driver typed it with a quote.
    expect(src).toMatch(/enterKey\(added\.secretRefs\[0\]!, true\)/);
    expect(read('driver-net.ps1')).toMatch(/if \(\$a\.quote\) \{ \$key = 'fk' \+ \(Random-Text 12\) \+ '"' \+ \(Random-Text 12\) \}/);
  });

  it('runs in the proc-mcp phase, which the driver starts', () => {
    expect(read('core.ts')).toMatch(/phase === 'proc-mcp'\) \{\n\s+await mcpChecks\(\{ ask, up, closed \}\);/);
    expect(read('procs.ps1')).toMatch(/Run-Phase 'proc-mcp' \$log @\(.*'--phase', 'proc-mcp'\)/);
    expect(read('procs.ps1')).toMatch(/No-Strays 'proc-mcp'/);
  });

  it('goes through the real desktop ports, not a fake', () => {
    expect(src).toMatch(/import \{ desktopMcpPorts \} from '\.\.\/src\/mcp\.ts';/);
    expect(src).toMatch(/const ports = desktopMcpPorts\(shell\);/);
  });

  it('Settings is reopened for a fresh page, and closed whatever happens', () => {
    // up() after a close must wait for the new page's hello, so core forgets the closed window's.
    expect(read('core.ts')).toMatch(/const closed = \(role: string\) => \{ hello\.delete\(role\); \};/);
    expect(read('core.ts')).toMatch(/await mcpChecks\(\{ ask, up, closed \}\);/);
    const enter = src.slice(src.indexOf('async function enterKey'), src.indexOf('/** Test, with the driver approving the dialog. */'));
    expect(enter.indexOf("ctx.closed?.('settings')")).toBeLessThan(enter.indexOf('shell.viewOpen'));
    expect(enter).toMatch(/\} finally \{\n\s+\/\/ Closed whatever happened[^\n]*\n\s+await shell\.windowCtl\('settings', 'close'\)/);
    expect(enter).toMatch(/until\(\(\) => shell\.windowCtl\('settings', 'get-bounds'\)/);
  });
});
