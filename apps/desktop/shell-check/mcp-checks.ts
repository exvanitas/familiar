/* The MCP client through the real exe, in a phase of its own (proc-mcp): core's McpClient over the
   desktop ports (src/mcp.ts), against tools/fake-mcp-server started as `node main.ts`, with the driver
   answering the exe's dialog. It runs in the real core page under the real CSP, so anything in the client
   that still needs eval fails here too. The checks run in order on one server, each building on the last:

   - security.mcp.add: a pasted setup, its secret's key typed into Settings by the driver (the page never
     learns it), Test asks once and lists the tools, the saved setup holds no secret value, and the
     second start asks nothing.
   - security.mcp.call: a call and its outside-content mark, Stop and a deadline answered at once with
     the cancellation sent, a call already stopped writing nothing, and the server still answering after.
   - security.mcp.crash-mid-call: a call that crashes the server is answered interrupted and was sent
     once; the approved setup restarts with no dialog.
   - security.mcp.changed-tool: the running server changes echo (set_variant) and says its tools changed.
     Through the gate, echo goes back to ask and the other tools keep their "always"; the wrapper made
     before the change can't send; the new one can.
   - security.mcp.secret-blanked: print_secret, from the key typed into Settings, comes back [hidden]
     in the reply, the model's text and every line core saw, and nothing core keeps holds it.
   - security.mcp.remove: a call in flight is interrupted, the secret, the saved setup and every node
     process go. The old id is refused for good, in the tombstone's words; the exe asks again for the old
     id's exact launch (its approval went with server_forget), and the same launch under a fresh id asks
     too (approvals are per id, so that part shows only that content carries nothing across ids).
   - security.mcp.secret-json-escaped, a known gap: the driver types a key holding a quote into Settings,
     the fake server prints it, and it passes only if the JSON-escaped form (\") is blanked too. The
     exe blanks literal copies only, so it fails until the pre-release native pass, with exactly the
     detail its mark in security-inventory.json expects. The gate reports that as KNOWN GAP in everyday
     runs and fails a release; any other failure of this check fails every run. */
import { gateFor, McpClient, openSettingsStore, parsePaste, processSetupOf, REMOVED_ID_WORDS, systemClock, toolPolicies, choiceKey, type LocalSetup, type ProcessEvent, type ServerTool, type ToolStep } from '@familiar/core';
import { callWithYes, runWithYes, yesFor } from '@familiar/core/testing';
import { desktopMcpPorts } from '../src/mcp.ts';
import { reason } from '../src/shell.ts';
import { check, fail, ok, rand, shell, sleep, step, until } from './common.ts';
import { dialog, START, type Ctx, type Paths } from './procs.ts';

interface Typed { head: string; tail: string; length: number }

const noWrites: ToolStep = { id: 'mcp-check', write: async () => fail('a server tool made a built-in write') };
// Each call goes through `send` with a decision, as the journal's gate would mint after a Yes.
const run = (t: ServerTool | undefined, args: object) => (t ? runWithYes(t, args, noWrites) : Promise.reject(new Error('no such tool')));
const TOOLS = 10;
/** The detail security.mcp.secret-json-escaped fails with while its known gap is open, as its mark in
    security-inventory.json expects. */
export const ESCAPED_GAP = 'an escaped copy came back';

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
  const client = await McpClient.open({ store, ...ports, processes, clock: systemClock });
  const sent = (tool: string) => written.filter(l => l.includes('"tools/call"') && l.includes(`"name":"${tool}"`)).length;
  const cancels = () => written.filter(l => l.includes('notifications/cancelled')).length;
  const tool = (name: string) => client.tools().find(t => t.serverName === name);
  const fake = (args: string[] = []) => JSON.stringify({ mcpServers: { 'Fake server': { command: 'node', args: [p.mainTs, ...args], env: { FAKE_SECRET: 'typed-later' } } } });
  let id = '';
  const typed: Typed[] = [];
  const leaks = (texts: string[]) => texts.filter(t => typed.some(k => t.includes(k.head) || t.includes(k.tail))).length;
  const need = () => { if (!id) fail('the server was never added'); };

  /** Settings stores a key the driver types for `ref`: the page never learns it. */
  async function enterKey(ref: string, quote = false): Promise<Typed> {
    // A Settings window opened before said hello then: forget it, so this waits for the new page.
    ctx.closed?.('settings');
    await shell.viewOpen({ label: 'settings', title: 'Familiar check settings', width: 420, height: 300 });
    try {
      await ctx.up('settings');
      await ctx.ask('settings', 'paste-ready');
      const k = await step<Typed>('type-key', { title: 'Familiar check settings', long: false, quote });
      const saved = await ctx.ask<string>('settings', 'save-key', ref);
      if (saved !== 'ok') fail('Settings could not save the key: ' + saved);
      typed.push(k);
      return k;
    } finally {
      // Closed whatever happened, and gone before the next check opens it again.
      await shell.windowCtl('settings', 'close').catch(() => {});
      ctx.closed?.('settings');
      await until(() => shell.windowCtl('settings', 'get-bounds').then(() => false, (e: unknown) => /missing/.test(reason(e))), 10_000, 'Settings to close');
    }
  }

  /** Test, with the driver approving the dialog. */
  async function testApproved(sid: string) {
    const testing = client.test(sid);
    const d = await dialog('approve', START);
    return { d, report: await testing };
  }

  await check('security.mcp.add', async () => {
    const { drafts, problems } = parsePaste(fake(), { newId: () => 'mcp-' + rand(8), defaultCwd: p.repo });
    const draft = drafts[0];
    ok(problems.length === 0 && draft && draft.problems.length === 0, 'the paste: ' + [...problems, ...(draft?.problems ?? [])].join('; '));
    const added = await client.add(draft!);
    ok(added.secretRefs.length === 1 && added.secretRefs[0] === `server:${added.id}:FAKE_SECRET`, 'secret refs: ' + added.secretRefs.join());
    const k = await enterKey(added.secretRefs[0]!);
    id = added.id;

    const { d, report } = await testApproved(id);
    ok(d.shown, 'Test of a new setup showed no dialog');
    ok(d.text.includes('FAKE_SECRET (kept in Credential Manager)'), 'the dialog does not name the secret as kept in Credential Manager');
    if (!report.ok) return fail('Test: ' + report.failure.words);
    ok(report.tools.length === TOOLS && report.tools.every(t => t.fresh), `Test listed ${report.tools.length} tools, ${report.tools.filter(t => t.fresh).length} fresh`);
    ok(client.get(id)?.phase === 'stopped', 'Test left the server running: ' + client.get(id)?.phase);
    const record = JSON.stringify(((await store.get('mcp.owner'))?.value as any)?.servers?.[id]);
    ok(record.includes('FAKE_SECRET') && !record.includes('typed-later') && leaks([record]) === 0, 'the saved setup holds a secret value');
    await client.markReviewed(id, report.tools.map(t => t.name));
    // Looked for while the start is under way; one that came would be refused.
    const starting = client.start(id);
    const again = await dialog('none', START);
    const started = await starting;
    ok(!again.shown, 'the approved setup asked again');
    ok(started.kind === 'ready', 'the second start: ' + JSON.stringify(started));
    return `pasted, the ${k.length}-character key typed into Settings, Test asked once (the dialog named FAKE_SECRET as kept in Credential Manager) and listed ${report.tools.length} tools, the saved setup holds no secret value, the second start asked nothing`;
  });

  await check('security.mcp.call', async () => {
    need();
    const text = await run(tool('echo'), { text: 'hello' });
    ok(text.startsWith('[Outside content: what the MCP server "Fake server" returned from echo.') && text.endsWith('\nhello'), 'echo: ' + text.slice(0, 120));
    const stop = new AbortController();
    const slow = callWithYes(client, id, 'slow', { ms: 30_000 }, stop.signal);
    await until(() => sent('slow') === 1, 10_000, 'the slow call to be sent');
    const t0 = Date.now();
    stop.abort();
    const stopped = await slow;
    const stopMs = Date.now() - t0;
    ok(stopped.kind === 'stopped' && stopMs < 500, `Stop: ${stopped.kind} in ${stopMs} ms`);
    await until(() => cancels() === 1, 5000, 'the cancellation after Stop');
    const t1 = Date.now();
    await client.setLimits(id, { callMs: 1000 });
    const late = await callWithYes(client, id, 'slow', { ms: 30_000 });
    const lateMs = Date.now() - t1;
    await client.setLimits(id, {});
    ok(late.kind === 'timed-out' && lateMs < 2500, `a 1 s deadline: ${late.kind} in ${lateMs} ms`);
    await until(() => cancels() === 2, 5000, 'the cancellation after the deadline');
    // A call stopped before it was made writes nothing at all.
    const before = written.length;
    const already = new AbortController();
    already.abort();
    const never = await callWithYes(client, id, 'add_note', { text: 'never' }, already.signal);
    await sleep(300);
    ok(never.kind === 'stopped' && written.length === before, `a call already stopped: ${never.kind}, ${written.length - before} lines written`);
    const after = await callWithYes(client, id, 'echo', { text: 'still here' });
    ok(after.kind === 'result' && after.text === 'still here', 'after: ' + JSON.stringify(after));
    return `echo marked as outside content; Stop answered in ${stopMs} ms and a 1 s deadline in ${lateMs} ms, each sending notifications/cancelled; a call already stopped wrote nothing; the server answered after`;
  });

  await check('security.mcp.crash-mid-call', async () => {
    need();
    const crashed = await callWithYes(client, id, 'crash', {});
    ok(crashed.kind === 'interrupted', 'the crash: ' + JSON.stringify(crashed));
    // No automatic restart: Failed, with its last output, until the person presses Start. Approved, so the
    // start needs no dialog: an open one would hold it in Starting.
    await until(() => client.get(id)?.phase === 'failed', 20_000, 'Failed after the crash');
    const restarted = client.start(id);
    const d = await dialog('none', START);
    ok(!d.shown, 'the start after the crash asked');
    ok((await restarted).kind === 'ready', 'the start after the crash');
    const after = await callWithYes(client, id, 'echo', { text: 'after the crash' });
    ok(after.kind === 'result' && after.text === 'after the crash', 'after: ' + JSON.stringify(after));
    ok(sent('crash') === 1, `crash was sent ${sent('crash')} times`);
    const words = await run(tool('crash'), {}).then(() => 'ran', (e: Error) => e.message);
    ok(/may have partly run\. Familiar did not send it again/.test(words), 'the model would read: ' + words);
    await until(() => client.get(id)?.phase === 'failed', 20_000, 'Failed after the second crash');
    ok((await client.start(id)).kind === 'ready', 'the start after the second crash');
    return 'the crash was answered interrupted and sent once; the server stayed Failed until Start, which asked nothing, and answered';
  });

  await check('security.mcp.changed-tool', async () => {
    need();
    const before = client.tools();
    const always = Object.fromEntries(before.map(t => [choiceKey(t.server.id, t.serverName), { policy: 'allow' as const, fingerprint: t.fingerprint, setupFingerprint: t.setupFingerprint }]));
    const gate = (tools: ServerTool[], t: ServerTool) => gateFor(t.name, t, { perTool: toolPolicies(tools, always) });
    ok(before.every(t => gate(before, t) === 'allow'), '"always" did not hold before the change');
    const oldEcho = before.find(t => t.serverName === 'echo')!;
    // A Yes given before the change, sent after it.
    const oldYes = yesFor(client, id, 'echo', { text: 'old' })!;
    // The running server changes echo, and says its tools changed. Same setup, no new start.
    const switched = await callWithYes(client, id, 'set_variant', { variant: 'b' });
    ok(switched.kind === 'result', 'set_variant: ' + JSON.stringify(switched));
    await until(() => tool('echo')?.fingerprint !== oldEcho.fingerprint, 10_000, 'the new tool list');
    const after = client.tools();
    const newEcho = after.find(t => t.serverName === 'echo')!;
    ok(newEcho.setupFingerprint === oldEcho.setupFingerprint, 'the setup changed too, so this would prove nothing about tools');
    ok(gate(after, newEcho) === 'ask', 'the changed echo did not go back to ask: ' + gate(after, newEcho));
    const others = after.filter(t => t.serverName !== 'echo');
    ok(others.every(t => gate(after, t) === 'allow'), 'another tool lost its "always"');
    // The Yes given before the change can't send; a new one can.
    const echoes = sent('echo');
    const old = await client.send(oldYes, new AbortController().signal);
    ok(old.kind === 'error' && /tool changed since it was allowed/.test(old.words) && sent('echo') === echoes, `the old Yes: ${JSON.stringify(old)}; echo sent ${sent('echo') - echoes} more times`);
    const fresh = await run(newEcho, { text: 'quiet' });
    ok(fresh.endsWith('\nQUIET'), 'the new wrapper: ' + fresh.slice(-40));
    return `echo changed on the running server: through the gate it asks again while the other ${others.length} tools keep "always"; a Yes given before the change was refused before sending; a new one answered`;
  });

  await check('security.mcp.secret-blanked', async () => {
    need();
    const r = await callWithYes(client, id, 'print_secret', {});
    ok(r.kind === 'result' && r.text === 'The secret is [hidden].', 'the reply: ' + JSON.stringify(r).slice(0, 120));
    const model = await run(tool('print_secret'), {});
    await sleep(500);
    ok(heard.some(l => l.includes('the secret is [hidden]')), "the server's log line never came back blanked");
    const kept = [JSON.stringify(client.list()), JSON.stringify(await store.get('mcp.owner'))];
    const n = leaks([...heard, model, ...kept]);
    ok(n === 0, `${n} texts carry the key`);
    return `the key typed into Settings came back [hidden] in the reply, the model's text and all ${heard.length} lines core heard; nothing core keeps holds it. Literal copies only: see security.mcp.secret-json-escaped`;
  });

  await check('security.mcp.remove', async () => {
    need();
    const slowBefore = sent('slow');
    const old = client.owner.server(id)?.setup;
    ok(old?.kind === 'local', 'the saved setup before removal');
    const slow = callWithYes(client, id, 'slow', { ms: 30_000 });
    await until(() => sent('slow') === slowBefore + 1, 10_000, 'the slow call to be sent');
    const removed = await client.remove(id);
    ok(removed.kind === 'removed', 'remove: ' + JSON.stringify(removed));
    const answer = await slow;
    ok(answer.kind === 'interrupted', 'the call in flight: ' + JSON.stringify(answer));
    const status = await shell.secretStatus(`server:${id}:FAKE_SECRET`);
    ok(!status.present, 'the secret is still in Credential Manager');
    ok(client.owner.server(id) === undefined && ((await store.get('mcp.owner'))?.value as any)?.servers?.[id] === undefined, 'the saved setup is still there');
    ok(client.list().length === 0, 'the client still lists it');
    await sleep(1000);
    const left = await step<{ count: number }>('node-children');
    ok(left.count === 0, `${left.count} node processes left`);
    // The id is its tombstone's for good: the same paste under the old id is refused, in its words.
    const reused = parsePaste(fake(), { newId: () => id, defaultCwd: p.repo }).drafts[0]!;
    const refused = await client.add(reused).then(() => 'added', (e: unknown) => reason(e));
    ok(refused === REMOVED_ID_WORDS, 'the old id again: ' + refused);
    // The old id's native approval went (server_forget): the exe asked again for its exact launch, started
    // straight through the process port as no saved server can be now. Refused at the dialog, so nothing
    // is approved or spawned. Had the approval survived, the exe would have gone on to the spawn unasked.
    const asking = ports.processes.start(processSetupOf(old as LocalSetup), () => {}).then(() => 'started', (e: unknown) => reason(e));
    const forgot = await dialog('refuse', START);
    const outcome = await asking;
    ok(forgot.shown, `the old id's exact launch started without asking (${outcome}): its approval survived the removal`);
    // The same launch under a fresh id asks too. The exe keys approvals by setup id, so a fresh id would ask
    // whatever had happened to the old one's: this shows only that a launch's content carries no approval
    // from one id to another, not that the removal forgot anything (the step above shows that).
    const fresh = parsePaste(fake(), { newId: () => 'mcp-' + rand(8), defaultCwd: p.repo }).drafts[0]!;
    const again = await client.add(fresh);
    await enterKey(again.secretRefs[0]!);
    const { d, report } = await testApproved(again.id);
    ok(d.shown && report.ok, `the same launch under a fresh id: dialog ${d.shown}, ${report.ok ? 'started' : report.failure.words}`);
    ok((await client.remove(again.id)).kind === 'removed', 'the fresh id\'s removal');
    return "the call in flight was interrupted; the secret, the saved setup and every node process went; the old id is refused for good; the exe asked again for the old id's exact launch (its approval was forgotten); the same launch under a fresh id asked too (approvals are per id)";
  });

  await check('security.mcp.secret-json-escaped', async () => {
    // A second server, whose key, typed by the driver, holds a quote. The page learns only its first and
    // last ten characters, which JSON leaves as they are.
    const { drafts } = parsePaste(fake(), { newId: () => 'mcp-q-' + rand(6), defaultCwd: p.repo });
    const added = await client.add(drafts[0]!);
    const k = await enterKey(added.secretRefs[0]!, true);
    const { d, report } = await testApproved(added.id);
    ok(d.shown && report.ok, 'the quoted-key server did not start');
    await client.start(added.id);
    const from = heard.length;
    const r = await callWithYes(client, added.id, 'print_secret', {});
    await sleep(300);
    const texts = [JSON.stringify(r), ...heard.slice(from)];
    await client.remove(added.id);
    const leaked = texts.filter(t => t.includes(k.head) || t.includes(k.tail)).length;
    // Exactly the known gap's expected words when the escaped copy comes back; anything else that fails
    // here (the server didn't start, Settings couldn't store the key) has other words, and fails the gate.
    if (leaked) fail(`${ESCAPED_GAP}: in ${leaked} texts, unblanked; the pre-release native pass blanks escaped forms`);
    return 'a key holding a quote came back blanked in its JSON-escaped form too';
  });
}
