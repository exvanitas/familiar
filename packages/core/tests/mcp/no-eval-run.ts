// Run by no-eval.test.ts in a Node started with --disallow-code-generation-from-strings, as the app's CSP
// forbids eval and new Function in every page. Familiar's own MCP client against the fake server:
// initialize, list the tools, one call, and one error. Prints one JSON line for the test to read.
import { McpClient } from '../../src/mcp/client.ts';
import { callWithYes } from '../../src/testing/consent.ts';
import { nodeNetPort } from './node-net.ts';
import { parsePaste } from '../../src/mcp/paste.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import { FAKE_MAIN, REPO, testPaths } from './fake.ts';
import { nodeProcessPort } from './node-process.ts';

const out: Record<string, unknown> = {};
// The flag really is on: code from a string must throw.
try {
  new Function('return 1');
  out.codegen = 'allowed';
} catch (e) {
  out.codegen = e instanceof EvalError ? 'refused' : String(e);
}
const port = nodeProcessPort();
try {
  const client = await McpClient.open({
    paths: testPaths,
    store: memorySettingsStore(),
    processes: port,
    net: nodeNetPort(),
    addresses: { add: async () => ({ id: 'a' }), remove: async () => {} },
    secrets: { delete: async () => {} },
    clock: { now: () => Date.now(), setTimer: (f, ms) => { const t = setTimeout(f, ms); return () => clearTimeout(t); } }
  });
  const { drafts } = parsePaste(JSON.stringify({ mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN] } } }), { newId: () => 'no-eval', defaultCwd: REPO, paths: testPaths });
  const { id } = await client.add(drafts[0]!);
  out.start = (await client.start(id)).kind;
  out.tools = client.tools().map(t => t.serverName);
  out.echo = await callWithYes(client, id, 'echo', { text: 'no eval' });
  out.fail = await callWithYes(client, id, 'fail', {});
  out.unknown = await callWithYes(client, id, 'no_such_tool', {});
  await client.stop(id);
} catch (e) {
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
} finally {
  await port.closeAll();
}
process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
