/* The MCP client through the real exe, in a phase of its own (proc-mcp): core's McpClient over the
   desktop ports (src/mcp.ts), against tools/fake-mcp-server started as `node main.ts`, with the driver
   answering the exe's dialog. The checks run in order on one server, each building on the last:

   - security.mcp.add: a pasted setup, its secret's key typed into Settings by the driver (the page never
     learns it), Test asks once and lists the tools, the saved setup holds no secret value, and the
     second start asks nothing.
   - security.mcp.call: a call and its outside-content mark, Stop and a deadline answered at once with
     the cancellation sent, and the server still answering after.
   - security.mcp.crash-mid-call: a call that crashes the server is answered interrupted and was sent
     once; the approved setup restarts with no dialog.
   - security.mcp.changed-tool: the same server with --variant b: the exe asks again, Test shows echo as
     the one changed tool, and no "always" holds for the new setup.
   - security.mcp.secret-blanked: print_secret, from the key typed into Settings, comes back [hidden]
     in the reply, the model's text and every line core saw, and nothing core keeps holds it.
   - security.mcp.remove: a call in flight is interrupted, the secret, the saved setup and every node
     process go, and the approval with them: the same setup asks again. */
import { McpClient, openSettingsStore, parsePaste, systemClock, toolPolicies, type ProcessEvent, type ServerTool, type ToolStep } from '@familiar/core';
import { desktopMcpPorts } from '../src/mcp.ts';
import { check, fail, ok, rand, shell, sleep, step, until } from './common.ts';
import { dialog, START, type Ctx, type Paths } from './procs.ts';

interface Typed { head: string; tail: string; length: number }

const noWrites: ToolStep = { id: 'mcp-check', write: async () => fail('a server tool made a built-in write') };
const run = (t: ServerTool | undefined, args: object) => (t ? t.run(args, noWrites) : Promise.reject(new Error('no such tool')));

export async function mcpChecks(ctx: Ctx): Promise<void> {
  const p = await step<Paths>('proc-paths', {}, 120000);
  const store = await openSettingsStore(indexedDB, 'familiar-check-mcp');
  // Every line core wrote to a server and every event core heard, to count and to search.
  const written: string[] = [];
  const heard: string[] = [];
  const ports = desktopMcpPorts(shell);
  const processes = {
    ...ports.processes,
    start: (setup: Parameters<typeof ports.processes.start>[0], onEvent: (e: ProcessEvent) => void) =>
      ports.processes.start(setup, e => { if (e.t !== 'exit') heard.push(e.line); onEvent(e); }),
    write: (r: string, bytes: Uint8Array) => { written.push(new TextDecoder().decode(bytes)); return ports.processes.write(r, bytes); }
  };
  const client = await McpClient.open({ store, ...ports, processes, clock: systemClock, limits: { backoffMs: 200 } });
  const sent = (tool: string) => written.filter(l => l.includes('"tools/call"') && l.includes(`"name":"${tool}"`)).length;
  const cancels = () => written.filter(l => l.includes('notifications/cancelled')).length;
  const tool = (name: string) => client.tools().find(t => t.serverName === name);
  const fake = (args: string[] = []) => JSON.stringify({ mcpServers: { 'Fake server': { command: 'node', args: [p.mainTs, ...args], env: { FAKE_SECRET: 'typed-later' } } } });
  let id = '';
  let typed: Typed | undefined;
  const leaks = (texts: string[]) => (typed ? texts.filter(t => t.includes(typed!.head) || t.includes(typed!.tail)).length : 0);
  const need = () => { if (!id) fail('the server was never added'); };

  await check('security.mcp.add', async () => {
    const { drafts, problems } = parsePaste(fake(), { newId: () => 'mcp-' + rand(8), defaultCwd: p.repo });
    const draft = drafts[0];
    ok(problems.length === 0 && draft && draft.problems.length === 0, 'the paste: ' + [...problems, ...(draft?.problems ?? [])].join('; '));
    const added = await client.add(draft!);
    ok(added.secretRefs.length === 1 && added.secretRefs[0] === `server:${added.id}:FAKE_SECRET`, 'secret refs: ' + added.secretRefs.join());
    // The key goes in through Settings, typed by the driver: the page never learns it.
    await shell.viewOpen({ label: 'settings', title: 'Familiar check settings', width: 420, height: 300 });
    await ctx.up('settings');
    await ctx.ask('settings', 'paste-ready');
    typed = await step<Typed>('type-key', { title: 'Familiar check settings', long: false });
    const saved = await ctx.ask<string>('settings', 'save-key', added.secretRefs[0]);
    ok(saved === 'ok', 'Settings could not save the key: ' + saved);
    await shell.windowCtl('settings', 'close');
    id = added.id;

    const testing = client.test(id);
    const d = await dialog('approve', START);
    const report = await testing;
    ok(d.shown, 'Test of a new setup showed no dialog');
    ok(d.text.includes('FAKE_SECRET (kept in Credential Manager)'), 'the dialog does not name the secret as kept in Credential Manager');
    if (!report.ok) return fail('Test: ' + report.failure.words);
    ok(report.tools.length === 9 && report.tools.every(t => t.fresh), `Test listed ${report.tools.length} tools, ${report.tools.filter(t => t.fresh).length} fresh`);
    ok(client.get(id)?.phase === 'stopped', 'Test left the server running: ' + client.get(id)?.phase);
    const record = JSON.stringify(await store.get(`mcp.server.${id}`));
    ok(record.includes('FAKE_SECRET') && !record.includes('typed-later') && leaks([record]) === 0, 'the saved setup holds a secret value');
    await client.markReviewed(id, report.tools.map(t => t.name));
    // Looked for while the start is under way; one that came would be refused.
    const starting = client.start(id);
    const again = await dialog('none', START);
    const started = await starting;
    ok(!again.shown, 'the approved setup asked again');
    ok(started.kind === 'ready', 'the second start: ' + JSON.stringify(started));
    return `pasted, the ${typed.length}-character key typed into Settings, Test asked once (the dialog named FAKE_SECRET as kept in Credential Manager) and listed ${report.tools.length} tools, the saved setup holds no secret value, the second start asked nothing`;
  });

  await check('security.mcp.call', async () => {
    need();
    const text = await run(tool('echo'), { text: 'hello' });
    ok(text.startsWith('[Outside content: what the MCP server "Fake server" returned from echo.') && text.endsWith('\nhello'), 'echo: ' + text.slice(0, 120));
    const stop = new AbortController();
    const slow = client.call(id, 'slow', { ms: 30_000 }, { signal: stop.signal });
    await until(() => sent('slow') === 1, 10_000, 'the slow call to be sent');
    const t0 = Date.now();
    stop.abort();
    const stopped = await slow;
    const stopMs = Date.now() - t0;
    ok(stopped.kind === 'stopped' && stopMs < 500, `Stop: ${stopped.kind} in ${stopMs} ms`);
    await until(() => cancels() === 1, 5000, 'the cancellation after Stop');
    const t1 = Date.now();
    const late = await client.call(id, 'slow', { ms: 30_000 }, { ms: 1000 });
    const lateMs = Date.now() - t1;
    ok(late.kind === 'timed-out' && lateMs < 2500, `a 1 s deadline: ${late.kind} in ${lateMs} ms`);
    await until(() => cancels() === 2, 5000, 'the cancellation after the deadline');
    const after = await client.call(id, 'echo', { text: 'still here' });
    ok(after.kind === 'result' && after.text === 'still here', 'after: ' + JSON.stringify(after));
    return `echo marked as outside content; Stop answered in ${stopMs} ms and a 1 s deadline in ${lateMs} ms, each sending notifications/cancelled; the server answered after`;
  });

  await check('security.mcp.crash-mid-call', async () => {
    need();
    const crashed = await client.call(id, 'crash', {});
    ok(crashed.kind === 'interrupted', 'the crash: ' + JSON.stringify(crashed));
    // Approved, so the restart needs no dialog: an open one would hold it in Starting.
    await until(() => client.get(id)?.phase === 'ready', 20_000, 'the restart');
    const d = await dialog('none', START);
    ok(!d.shown, 'the restart asked');
    const after = await client.call(id, 'echo', { text: 'after the crash' });
    ok(after.kind === 'result' && after.text === 'after the crash', 'after: ' + JSON.stringify(after));
    ok(sent('crash') === 1, `crash was sent ${sent('crash')} times`);
    const words = await run(tool('crash'), {}).then(() => 'ran', (e: Error) => e.message);
    ok(/may have partly run\. Familiar did not send it again/.test(words), 'the model would read: ' + words);
    await until(() => client.get(id)?.phase === 'ready', 20_000, 'the second restart');
    return 'the crash was answered interrupted and sent once; the approved setup restarted with no dialog and answered';
  });

  await check('security.mcp.changed-tool', async () => {
    need();
    const before = client.tools();
    const always = Object.fromEntries(before.map(t => [t.name, { policy: 'allow' as const, fingerprint: t.fingerprint, setupFingerprint: t.setupFingerprint }]));
    ok(Object.keys(toolPolicies(before, always)).length === before.length, '"always" did not hold before the change');
    await client.stop(id);
    const { drafts } = parsePaste(fake(['--variant', 'b']), { newId: () => 'unused', defaultCwd: p.repo });
    await client.edit(id, drafts[0]!);
    const testing = client.test(id);
    const d = await dialog('approve', START);
    const report = await testing;
    ok(d.shown, 'the changed arguments did not ask again');
    if (!report.ok) return fail('Test: ' + report.failure.words);
    ok(JSON.stringify(report.changes.changed) === '["echo"]', 'changed: ' + report.changes.changed.join());
    ok(JSON.stringify(report.tools.filter(t => t.fresh).map(t => t.name)) === '["echo"]', 'fresh: ' + report.tools.filter(t => t.fresh).map(t => t.name).join());
    ok((await client.start(id)).kind === 'ready', 'the start after the change');
    const after = client.tools();
    ok(Object.keys(toolPolicies(after, always)).length === 0, 'an "always" still held for the new setup');
    const echo = await client.call(id, 'echo', { text: 'quiet' });
    ok(echo.kind === 'result' && echo.text === 'QUIET', 'variant b echo: ' + JSON.stringify(echo));
    return '--variant b asked again; Test showed echo as the one changed tool; no "always" held for the new setup';
  });

  await check('security.mcp.secret-blanked', async () => {
    need();
    const r = await client.call(id, 'print_secret', {});
    ok(r.kind === 'result' && r.text === 'The secret is [hidden].', 'the reply: ' + JSON.stringify(r).slice(0, 120));
    const model = await run(tool('print_secret'), {});
    await sleep(500);
    ok(heard.some(l => l.includes('the secret is [hidden]')), "the server's log line never came back blanked");
    const kept = [JSON.stringify(client.list()), JSON.stringify(await store.get(`mcp.server.${id}`))];
    const n = leaks([...heard, model, ...kept]);
    ok(n === 0, `${n} texts carry the key`);
    return `the key typed into Settings came back [hidden] in the reply, the model's text and all ${heard.length} lines core heard; nothing core keeps holds it`;
  });

  await check('security.mcp.remove', async () => {
    need();
    const slowBefore = sent('slow');
    const slow = client.call(id, 'slow', { ms: 30_000 });
    await until(() => sent('slow') === slowBefore + 1, 10_000, 'the slow call to be sent');
    const removed = await client.remove(id);
    ok(removed.kind === 'removed', 'remove: ' + JSON.stringify(removed));
    const answer = await slow;
    ok(answer.kind === 'interrupted', 'the call in flight: ' + JSON.stringify(answer));
    const status = await shell.secretStatus(`server:${id}:FAKE_SECRET`);
    ok(!status.present, 'the secret is still in Credential Manager');
    ok((await store.get(`mcp.server.${id}`)) === undefined, 'the saved setup is still there');
    ok(client.list().length === 0, 'the client still lists it');
    await sleep(1000);
    const left = await step<{ count: number }>('node-children');
    ok(left.count === 0, `${left.count} node processes left`);
    // The approval went too: the same setup id, added again without its secret (now gone), asks.
    const plain = JSON.stringify({ mcpServers: { 'Fake server': { command: 'node', args: [p.mainTs, '--variant', 'b'] } } });
    const { drafts } = parsePaste(plain, { newId: () => id, defaultCwd: p.repo });
    await client.add(drafts[0]!);
    const testing = client.test(id);
    const d = await dialog('refuse', START);
    const report = await testing;
    ok(d.shown && !report.ok && report.failure.kind === 'declined', `after removal: dialog ${d.shown}, ${JSON.stringify(report)}`);
    await client.remove(id);
    return 'the call in flight was interrupted; the secret, the saved setup and every node process went; the same setup asked again';
  });
}
