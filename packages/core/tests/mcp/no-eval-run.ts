// Run by no-eval.test.ts in a Node started with --disallow-code-generation-from-strings, as the app's CSP
// forbids eval and new Function in every page. The MCP client against the fake server: initialize, list
// the tools, one call, and one error. Prints one JSON line for the test to read.
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../../src/mcp/client.ts';
import { openSession } from '../../src/mcp/session.ts';
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
    fetchFor: () => fetch,
    addresses: { add: async () => ({ id: 'a' }), remove: async () => {} },
    secrets: { delete: async () => {} },
    clock: { now: () => Date.now(), setTimer: (f, ms) => { const t = setTimeout(f, ms); return () => clearTimeout(t); } }
  });
  const { drafts } = parsePaste(JSON.stringify({ mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN] } } }), { newId: () => 'no-eval', defaultCwd: REPO, paths: testPaths });
  const { id } = await client.add(drafts[0]!);
  out.start = (await client.start(id)).kind;
  out.tools = client.tools().map(t => t.serverName);
  out.echo = await client.call(id, 'echo', { text: 'no eval' });
  out.fail = await client.call(id, 'fail', {});
  out.unknown = await client.call(id, 'no_such_tool', {});
  await client.stop(id);
  out.structured = await structured();
} catch (e) {
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
} finally {
  await port.closeAll();
}
/** A tool with an output schema, which is where the SDK's own checker (Ajv) would compile code: an
    in-process server over the SDK's in-memory transport, and core's session. */
async function structured(): Promise<unknown> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'structured', version: '1' }, { capabilities: { tools: {} } });
  const outputSchema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } as const;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'count', inputSchema: { type: 'object' }, outputSchema }] }));
  server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: '{"n":3}' }], structuredContent: { n: 3 } }));
  await server.connect(serverSide);
  const transport = Object.assign(clientSide, { failure: () => ({ kind: 'exited' as const, words: 'closed' }), lastOutput: () => undefined });
  const ready = new Promise<string[]>((resolve, reject) => {
    const session = openSession(transport, {
      launched: () => {},
      ready: async tools => {
        const r = await session.call('count', {}, new AbortController().signal);
        resolve([...tools.map(t => t.name), JSON.stringify(r)]);
        session.close();
      },
      closed: f => reject(new Error(f?.words ?? 'closed')),
      toolsChanged: () => {}
    }, { initMs: 10_000 });
  });
  return ready;
}

process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
