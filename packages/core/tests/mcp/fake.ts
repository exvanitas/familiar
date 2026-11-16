// Where the fake MCP server is, and setups that start it, for core's MCP tests.
import { join } from 'node:path';
import type { ProcessSetup } from '../../src/mcp/process.ts';
import { posixPaths, windowsPaths } from '../../src/mcp/native-rules.ts';

export const REPO = join(import.meta.dirname, '..', '..', '..', '..');
export const FAKE_MAIN = join(REPO, 'tools', 'fake-mcp-server', 'src', 'main.ts');
/** An invented value for the setup's FAKE_SECRET, long enough to be blanked. */
export const BLANKED_VALUE = 'blank-me-0123456789';

let n = 0;
export function fakeSetup(extra: Partial<ProcessSetup> = {}): ProcessSetup {
  return { id: `fake-${++n}`, label: 'Fake server', program: process.execPath, args: [FAKE_MAIN], cwd: REPO, env: [], secrets: [], ...extra };
}

/** The path rules for this machine's paths: the fake server and Node live at Windows paths on the Windows
    runner and POSIX ones on Linux. The app always uses windowsPaths. */
export const testPaths = process.platform === 'win32' ? windowsPaths : posixPaths;
