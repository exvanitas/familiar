// A badly behaved server: it writes lines that aren't JSON-RPC to stdout.
//   node junk-stdout.js then-valid   junk first, then it answers like a tiny MCP server
//   node junk-stdout.js junk-only    junk only, and it never answers
const mode = process.argv[2] ?? 'then-valid';
process.stdout.write('Starting up, version 1.2.3\n');
process.stdout.write('{"not":"json-rpc"}\n');
process.stdout.write('\u001b[32mready\u001b[0m\n');
if (mode === 'junk-only') {
  setInterval(() => process.stdout.write('still not json\n'), 1000);
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue;
      process.stdout.write('log line between replies\n');
      let result = {};
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'junk', version: '0' }
        };
      } else if (msg.method === 'tools/list') {
        result = { tools: [] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
