/* The checks for server starts, links, saving, system state, wake, notifications and autostart,
   run from core in phases of their own: proc-main, proc-recover, proc-kill and proc-wake. The
   driver's half is procs.ps1. See 5b, 5d and 6 in docs/shell-design.md. */
import type { CoreMessage, Info, ServerEvent, Setup } from '../src/shell.ts';
import { reason } from '../src/shell.ts';
import { check, fail, ok, raw, rand, say, shell, skip, sleep, step, until } from './common.ts';

/* The spike's ENV_ALLOWLIST, which is all a server inherits. */
const ALLOWLIST = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME'];

interface Paths {
  repo: string;
  mainTs: string;
  node: string;
  tmp: string;
  exeDir: string;
  smb: { unc: string; mapped: string; jShare: string; sShare: string; sMapped: string; jLocal: string; how: string };
}

interface Dialog { shown: boolean; text: string }

const START = ['Start it', "Don't start"] as const;
const OPEN = ['Open', "Don't open"] as const;

/* The confirm, answered by driver-net.ps1's dialog step: approve, refuse, or none (look for one,
   and refuse it if it came). What it showed, details included. */
async function dialog(act: 'approve' | 'refuse' | 'none', [approve, refuse]: readonly [string, string]): Promise<Dialog> {
  const r = await step<{ found: boolean; texts: string[]; details: string; answered: string }>('dialog', { act, approve, refuse, details: act !== 'none' }, 60000);
  if (act === 'none' && r.found) await step('dialog', { act: 'refuse', approve, refuse }, 60000);
  return { shown: r.found, text: [...(r.texts ?? []), r.details ?? ''].join('\n') };
}

const errKind = (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? String((e as { kind: unknown }).kind) : reason(e));

/* One running server, spoken to in newline-delimited JSON-RPC over the channel. */
class Mcp {
  run = '';
  out: string[] = [];
  err: string[] = [];
  exit: number | null | undefined = undefined;
  private next = 1;
  private waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();

  onEvent = (e: ServerEvent) => {
    if (e.t === 'exit') { this.exit = e.code; return; }
    if (e.t === 'err') { this.err.push(e.line); return; }
    this.out.push(e.line);
    try {
      const m = JSON.parse(e.line);
      const w = typeof m.id === 'number' ? this.waiting.get(m.id) : undefined;
      if (w) { this.waiting.delete(m.id); w(m); }
    } catch { /* not JSON-RPC */ }
  };

  start(setup: Setup): Promise<void> {
    return shell.serverStart(setup, this.onEvent).then(r => { this.run = r.run; });
  }

  send(o: object): Promise<void> {
    return shell.serverWrite(this.run, new TextEncoder().encode(JSON.stringify(o) + '\n'));
  }

  async request<T = Record<string, unknown>>(method: string, params: object, ms = 60000): Promise<T> {
    const id = this.next++;
    const answer = new Promise<{ result?: unknown; error?: { message: string } }>(done => this.waiting.set(id, done));
    await this.send({ jsonrpc: '2.0', id, method, params });
    const m = await Promise.race([answer, sleep(ms).then(() => null)]);
    if (!m) return fail(`no answer to ${method} within ${ms} ms (exit ${this.exit}, stderr ${this.err.slice(-3).join(' | ')})`);
    if (m.error) return fail(`${method}: ${m.error.message}`);
    return m.result as T;
  }

  async initialize(): Promise<string> {
    const r = await this.request<{ serverInfo: { name: string } }>('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'familiar-check', version: '1' } });
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r.serverInfo.name;
  }

  async tool(name: string, args: object = {}, ms = 60000): Promise<string> {
    const r = await this.request<{ content: { text: string }[] }>('tools/call', { name, arguments: args }, ms);
    return r.content.map(c => c.text).join('');
  }

  exited(ms: number) {
    return until(() => this.exit !== undefined, ms, 'the server to exit');
  }
}

/* Starts a setup while the driver answers its dialog. What the dialog said, and the start's outcome. */
async function startWith(m: Mcp, setup: Setup, press: 'yes' | 'no' | 'none'): Promise<{ dialog: Dialog; started: string }> {
  const started = m.start(setup).then(() => 'started', e => errKind(e));
  const d = await dialog(press === 'yes' ? 'approve' : press === 'no' ? 'refuse' : 'none', START);
  return { dialog: d, started: await started };
}

const fakeSetup = (p: Paths, id: string, extra: Partial<Setup> = {}): Setup => ({
  id, label: `Fake server ${id}`, program: 'node', args: [p.mainTs, '--variant', 'a'], cwd: p.repo, env: [['CHECK_SETTING', 'plain-value']], secrets: [], ...extra
});

/* A start that must be refused before any dialog, with this kind. */
async function refusedBefore(setup: Setup, kind: string): Promise<string | null> {
  const m = new Mcp();
  const r = await startWith(m, setup, 'none');
  if (r.dialog.shown) return `${setup.id}: a dialog appeared`;
  if (r.started !== kind) return `${setup.id}: ${r.started}, not ${kind}`;
  return null;
}

/* What core.ts hands over: asking another check page, and waiting for one to load. */
export interface Ctx {
  ask<T = unknown>(to: string, cmd: string, args?: unknown, ms?: number): Promise<T>;
  up(role: string): Promise<unknown>;
}

async function main(info: Info, ctx: Ctx) {
  const p = await step<Paths>('proc-paths', {}, 120000);
  const bad = (problems: (string | null)[]) => problems.filter(Boolean) as string[];
  // Every attempt that could reach a share, the direct UNC ones in server.paths included, falls
  // between this sample and the next.
  await step('smb-save', { name: 'servers-before' });

  await check('security.server.settings', async () => {
    const s = (extra: Partial<Setup>) => fakeSetup(p, 'set-' + rand(4), extra);
    const problems = bad([
      await refusedBefore(s({ env: [['node_options', '--x'], ['NODE_OPTIONS', '--y']] }), 'duplicate-setting'),
      await refusedBefore(s({ secrets: ['NODE_OPTIONS'] }), 'unsafe-secret'),
      await refusedBefore(s({ secrets: ['npm_config_registry'] }), 'unsafe-secret'),
      await refusedBefore(s({ args: [p.mainTs, 'a\nb'] }), 'unsafe-argument'),
      await refusedBefore(s({ args: [p.mainTs, 'a\0b'] }), 'unsafe-argument'),
      await refusedBefore(s({ env: [['A=B', 'x']] }), 'invalid'),
      await refusedBefore(s({ env: [['\u1f80', 'x']] }), 'invalid')
    ]);
    ok(problems.length === 0, problems.join('; '));
    return 'duplicate names, unsafe secrets, NUL CR LF arguments and bad names refused before any dialog';
  });

  await check('security.server.paths', async () => {
    const s = (program: string, cwd = p.repo) => fakeSetup(p, 'path-' + rand(4), { program, cwd, args: [] });
    const problems = bad([
      await refusedBefore(s(`${p.smb.unc}\\familiar-fx\\tool.exe`), 'unsafe-path'),
      await refusedBefore(s('node', `${p.smb.unc}\\familiar-fx`), 'unsafe-path'),
      await refusedBefore(s('\\\\?\\C:\\Windows\\System32\\whoami.exe'), 'unsafe-path'),
      await refusedBefore(s('\\\\.\\C:\\Windows\\System32\\whoami.exe'), 'unsafe-path'),
      await refusedBefore(s('C:Windows\\System32\\whoami.exe'), 'unsafe-path'),
      await refusedBefore(s('C:\\Windows\\System32\\whoami.exe:stream'), 'unsafe-path'),
      await refusedBefore(s('C:\\Windows\\..\\Windows\\System32\\whoami.exe'), 'unsafe-path'),
      await refusedBefore(s('C:\\Windows\\System32\\who\u200bami.exe'), 'unsafe-path'),
      await refusedBefore(s('C:\\COM1\\x.exe'), 'unsafe-path'),
      await refusedBefore(s('familiar-no-such-program'), 'not-found')
    ]);
    ok(problems.length === 0, problems.join('; '));
    return 'UNC program and folder, \\\\?\\, \\\\.\\, drive-relative, a stream, .., an invisible character and a device name refused before any dialog';
  });

  // More paths that would reach the share, still inside the samples begun above.
  const viaDrive = bad([
    await refusedBefore(fakeSetup(p, 'z-prog', { program: `${p.smb.mapped}:\\familiar-fx\\tool.exe`, args: [] }), 'unsafe-path'),
    await refusedBefore(fakeSetup(p, 'z-dir', { cwd: `${p.smb.mapped}:\\familiar-fx` }), 'unsafe-path')
  ]);
  const viaLinks = bad([
    await refusedBefore(fakeSetup(p, 'l-junction', { cwd: `${p.smb.jShare}\\familiar-fx` }), 'unsafe-path'),
    await refusedBefore(fakeSetup(p, 'l-symlink', { cwd: `${p.smb.sShare}\\familiar-fx` }), 'unsafe-path'),
    await refusedBefore(fakeSetup(p, 'l-mapped', { program: `${p.smb.sMapped}\\familiar-fx\\tool.exe`, args: [] }), 'unsafe-path')
  ]);
  const smb = await step<{ opens: number; new: string[] }>('smb-compare', { before: 'servers-before', after: 'servers-after' });
  const control = await step<{ opens: number; new: string[] }>('smb-control', {});
  const quiet = smb.opens === 0 && smb.new.length === 0;
  const moved = control.opens > 0 && control.new.length > 0;
  const counts = `SMB from the first UNC attempt to the last link: ${smb.opens} server opens, ${smb.new.length} new connections; control: ${control.opens} opens, ${control.new.length} new (${p.smb.how})`;
  await check('security.server.unc-measured', async () => {
    ok(quiet, counts);
    ok(moved, 'the control moved nothing, so the counts prove nothing: ' + counts);
    return 'the direct UNC program and folder of server.paths were inside the SMB samples: ' + counts;
  });
  await check('security.server.remote-drive', async () => {
    ok(viaDrive.length === 0, viaDrive.join('; '));
    ok(quiet, counts);
    ok(moved, 'the control moved nothing, so the counts prove nothing: ' + counts);
    return `a program and a folder on the mapped drive refused; ${counts}`;
  });
  await check('security.server.links', async () => {
    ok(viaLinks.length === 0, viaLinks.join('; '));
    ok(quiet, counts);
    ok(moved, 'the control moved nothing: ' + counts);
    // A junction to a local folder passes, and the dialog shows where it leads.
    const m = new Mcp();
    const r = await startWith(m, fakeSetup(p, 'l-local', { cwd: p.smb.jLocal }), 'yes');
    ok(r.dialog.shown && r.started === 'started', `a local junction as the folder: dialog ${r.dialog.shown}, ${r.started}`);
    ok(r.dialog.text.includes('Which leads to'), 'the dialog does not show where the folder leads');
    const name = await m.initialize();
    await shell.serverStop(m.run);
    await m.exited(5000);
    return `a junction and a directory link to the share and a link to the mapped drive refused; a local junction passes and starts ${name}; ${counts}`;
  });

  const a = fakeSetup(p, 'fake-a');
  const ma = new Mcp();
  await check('security.server.approve', async () => {
    const r = await startWith(ma, a, 'yes');
    ok(r.dialog.shown, 'no dialog for a new setup');
    ok(r.started === 'started', 'the start: ' + r.started);
    const t = r.dialog.text;
    // The program shows as it is; arguments show escaped, with each backslash doubled.
    const wanted = [p.node, p.mainTs.replace(/\\/g, '\\\\'), '"--variant"', '"a"', 'CHECK_SETTING=plain-value'];
    const missing = wanted.filter(w => !t.includes(w));
    ok(missing.length === 0, `the dialog lacks: ${missing.join(' | ')}; it said: ${t.slice(0, 600)}`);
    const name = await ma.initialize();
    const tools = await ma.request<{ tools: { name: string }[] }>('tools/list', {});
    ok(tools.tools.length >= 8, `tools/list gave ${tools.tools.length}`);
    return `the dialog named ${p.node} and every argument, Yes started it, initialize answered as ${name}, tools/list gave ${tools.tools.length} tools`;
  });

  await check('security.server.env', async () => {
    ok(ma.run, 'no server from the approve check');
    const names = (await ma.tool('list_env')).split('\n').filter(Boolean);
    const allowed = new Set([...ALLOWLIST, 'CHECK_SETTING'].map(n => n.toUpperCase()));
    const extra = names.filter(n => !allowed.has(n.toUpperCase()));
    ok(extra.length === 0, 'names outside the allowlist and the setup: ' + extra.join(' '));
    ok(names.includes('CHECK_SETTING'), 'the setup\'s own setting is missing');
    ok(!names.some(n => n.toUpperCase() === 'FAMILIAR_CHECK_PARENT_ONLY'), 'a variable only Familiar had reached the server');
    return `${names.length} variables: only allowlisted names and the setup's own`;
  });

  await check('security.server.reask', async () => {
    await shell.serverStop(ma.run);
    await ma.exited(5000);
    const again = new Mcp();
    const r = await startWith(again, a, 'none');
    ok(!r.dialog.shown && r.started === 'started', `the same setup again: dialog ${r.dialog.shown}, ${r.started}`);
    await again.initialize();
    // Stop while a call runs.
    const slow = again.tool('slow', { ms: 30000 }, 40000).catch(() => 'cut off');
    await sleep(300);
    const t0 = Date.now();
    await shell.serverStop(again.run);
    await again.exited(5000);
    const stopMs = Date.now() - t0;
    void slow;
    const b = new Mcp();
    const rb = await startWith(b, { ...a, args: [p.mainTs, '--variant', 'b'] }, 'no');
    ok(rb.dialog.shown && rb.started === 'declined', `a changed argument: dialog ${rb.dialog.shown}, ${rb.started}`);
    // Forget while a call runs: it stops, and the next start asks again.
    const c = new Mcp();
    const rc = await startWith(c, a, 'none');
    ok(!rc.dialog.shown && rc.started === 'started', 'the approved setup asked again: ' + rc.started);
    await c.initialize();
    void c.tool('slow', { ms: 30000 }, 40000).catch(() => 'cut off');
    await sleep(300);
    await shell.serverForget(a.id);
    await c.exited(5000);
    const d = new Mcp();
    const rd = await startWith(d, a, 'no');
    ok(rd.dialog.shown && rd.started === 'declined', `after forget: dialog ${rd.dialog.shown}, ${rd.started}`);
    const left = await step<{ count: number }>('node-children');
    ok(left.count === 0, `${left.count} node processes of Familiar's are left`);
    return `no dialog the second time; stop during a call ended it in ${stopMs} ms; --variant b asked and No gave declined; forget during a call stopped it and the next start asked; no node left`;
  });

  await check('check.system.idle', async () => {
    const s0 = await shell.system();
    await sleep(3000);
    const s1 = await shell.system();
    ok(s1.idleMs >= s0.idleMs + 2500, `idle ${s0.idleMs} then ${s1.idleMs} ms`);
    return `userState ${s1.userState}, idle ${s0.idleMs} then ${s1.idleMs} ms with no input`;
  });

  await check('check.autostart', async () => {
    const before = await shell.autostart();
    const on = await shell.autostart(true);
    const reg = await step<{ value: string }>('run-entry');
    const off = await shell.autostart(false);
    const reg2 = await step<{ value: string }>('run-entry');
    ok(on && reg.value.endsWith('" --autostart') && reg.value.toLowerCase().includes('familiar.exe'), `on: ${on}, the Run entry ${reg.value}`);
    ok(!off && reg2.value === '', `off: ${off}, the Run entry ${reg2.value}`);
    return `was ${before}; on wrote ${reg.value.replace(/^.*\\/, '…\\')}; off removed it`;
  });

  await check('check.toast.app-id', async () => {
    const r = await step<{ setting: string; key: string }>('toast-setting', {}, 90000);
    return `INFO CreateToastNotifier('dev.exvanitas.familiar').Setting = ${r.setting}; key ${r.key}`;
  });

  await check('check.persist.notified', async () => {
    const shown = await raw('plugin:notification|notify', { options: { title: 'Familiar check', body: 'A notification before persist()' } }).then(() => 'shown', e => 'failed: ' + reason(e));
    const before = await navigator.storage.persisted();
    const granted = before || await navigator.storage.persist();
    return `INFO notification ${shown}; persisted=${before} granted=${granted}`;
  });

  // Last in this phase, since the driver's job stops the exe making any process after it.
  await check('security.server.stop-blocked-write', async () => {
    // A server that never reads its stdin: writes fill the pipe and block. Stop must still end it.
    const s = fakeSetup(p, 'fake-deaf', { args: ['-e', 'setInterval(() => {}, 1000)'] });
    const m = new Mcp();
    const r = await startWith(m, s, 'yes');
    ok(r.started === 'started', 'the start: ' + r.started);
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    const writes = [1, 2].map(() => shell.serverWrite(m.run, big).then(() => 'written', e => errKind(e)));
    await sleep(1000);
    const t0 = Date.now();
    const stopped = await Promise.race([shell.serverStop(m.run).then(() => 'stopped', e => errKind(e)), sleep(10000).then(() => 'hung')]);
    const ms = Date.now() - t0;
    ok(stopped === 'stopped' && ms < 3000, `stop with writes blocked: ${stopped} after ${ms} ms`);
    await m.exited(5000);
    const outcomes = await Promise.race([Promise.all(writes), sleep(5000).then(() => ['hung'])]);
    ok(!outcomes.includes('hung') && !outcomes.every(o => o === 'written'), 'the blocked writes: ' + outcomes.join(' '));
    return `two 4 MiB writes blocked on a server that never reads; stop ended it in ${ms} ms, and the writes ended ${outcomes.join(', ')}`;
  });

  await check('security.server.exit-drains', async () => {
    // The program exits, but a grandchild it started holds its stdout open. The exit must still
    // come, and the grandchild go with the job.
    const grand = "console.log('GRANDCHILD ' + process.pid); setInterval(() => {}, 1000)";
    const main = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'inherit' }); setTimeout(() => process.exit(0), 1500)`;
    const m = new Mcp();
    const r = await startWith(m, fakeSetup(p, 'fake-heir', { args: ['-e', main] }), 'yes');
    ok(r.started === 'started', 'the start: ' + r.started);
    const t0 = Date.now();
    const exited = await m.exited(8000).then(() => true, () => false);
    const ms = Date.now() - t0;
    const pid = Number((m.out.find(l => l.startsWith('GRANDCHILD ')) ?? '').split(' ')[1]);
    ok(exited, 'no exit event while a grandchild held the output open');
    ok(pid > 0, 'the grandchild never said its id');
    const alive = await step<{ alive: number[] }>('pids-alive', { pids: [pid] });
    ok(alive.alive.length === 0, `the grandchild ${pid} outlived the job`);
    return `the exit came ${ms} ms after the start's wait began, with grandchild ${pid} holding stdout; it was ended with the job`;
  });

  await check('security.server.blank', async () => {
    // A key typed into Settings by real key presses, stored as the setup's secret. The page never
    // learns it: the driver keeps it, and says only its first and last characters.
    await shell.viewOpen({ label: 'settings', title: 'Familiar check settings', width: 420, height: 300 });
    await ctx.up('settings');
    await ctx.ask('settings', 'paste-ready');
    const typed = await step<{ head: string; tail: string; length: number }>('type-key', { title: 'Familiar check settings', long: false });
    const id = 'fake-s';
    const saved = await ctx.ask<string>('settings', 'save-key', `server:${id}:FAKE_SECRET`);
    ok(saved === 'ok', 'Settings could not save the secret: ' + saved);
    await shell.windowCtl('settings', 'close');
    const m = new Mcp();
    const r = await startWith(m, fakeSetup(p, id, { secrets: ['FAKE_SECRET'] }), 'yes');
    ok(r.started === 'started', 'the start: ' + r.started);
    ok(r.dialog.text.includes('FAKE_SECRET (kept in Credential Manager)'), 'the dialog does not name the secret');
    await m.initialize();
    const reply = await m.tool('print_secret');
    await sleep(500);
    const all = [reply, ...m.out, ...m.err];
    const leaked = all.filter(t => t.includes(typed.head) || t.includes(typed.tail));
    ok(reply.includes('[hidden]'), 'the reply: ' + reply.slice(0, 80));
    ok(m.err.some(l => l.includes('the secret is [hidden]')), 'stderr: ' + m.err.slice(-3).join(' | '));
    ok(leaked.length === 0, `${leaked.length} lines carry the secret`);
    await shell.serverStop(m.run);
    await m.exited(5000);
    // The driver searches every file for the key once this run has ended (procs.ps1).
    return `a ${typed.length}-character secret from Credential Manager came back [hidden] on stdout and stderr; the file search follows the run`;
  });

  await check('security.server.start-failed', async () => {
    const s = fakeSetup(p, 'fake-c');
    const m = new Mcp();
    const r = await startWith(m, s, 'yes');
    ok(r.started === 'started', 'the approval start: ' + r.started);
    await shell.serverStop(m.run);
    await m.exited(5000);
    const limit = await step<{ done: boolean; why?: string }>('job-limit');
    if (!limit.done) skip('the driver could not limit the exe: ' + (limit.why ?? ''));
    const m2 = new Mcp();
    const r2 = await startWith(m2, s, 'none');
    ok(!r2.dialog.shown && r2.started === 'start-failed', `under a job that allows no new process: ${r2.started}`);
    const left = await step<{ count: number; suspended: number }>('node-children');
    ok(left.count === 0, `${left.count} node processes left, ${left.suspended} suspended`);
    return 'start-failed when no process could be made, and nothing left';
  });
}

/* Links and saving, in a run of their own: the confirms stop after three refusals in a run. */
async function filesAndLinks(info: Info) {
  const p = await step<Paths>('proc-paths', {}, 120000);
  await check('security.link.confirm', async () => {
    for (const url of ['http://example.com/', 'javascript:alert(1)', 'file:///C:/Windows/win.ini', `https://${'a'.repeat(2050)}.example`]) {
      const r = shell.openUrl(url).then(() => 'opened', e => errKind(e));
      const d = await dialog('none', OPEN);
      ok(!d.shown, `a dialog for ${url.slice(0, 40)}`);
      ok(await r === 'invalid', `${url.slice(0, 40)}: ${await r}`);
    }
    // The current user's https handler is a recorder for this check, so what the browser would
    // get is read back exactly.
    const rec = await step<{ on: boolean; how: string }>('url-recorder-on');
    ok(rec.on, 'the https recorder could not be set: ' + rec.how);
    const url = `https://familiar-check.test/p/${rand(8)}?q=a&r=b`;
    const no = shell.openUrl(url).then(() => 'opened', e => errKind(e));
    const d1 = await dialog('refuse', OPEN);
    ok(d1.shown && await no === 'declined', `Don't open: dialog ${d1.shown}, ${await no}`);
    ok(d1.text.includes('familiar-check.test'), 'the dialog does not show the host');
    const none = await step<{ urls: string[] }>('url-recorded', { ms: 4000 });
    ok(none.urls.length === 0, `the handler got ${none.urls.length} URLs after Don't open`);
    const yes = shell.openUrl(url).then(() => 'opened', e => errKind(e));
    const d2 = await dialog('approve', OPEN);
    ok(d2.shown && await yes === 'opened', `Open: dialog ${d2.shown}, ${await yes}`);
    const seen = await step<{ urls: string[] }>('url-recorded', { ms: 20000, until: 1 });
    await step('url-recorder-off');
    ok(seen.urls.length === 1 && seen.urls[0] === url, `the handler got: ${JSON.stringify(seen.urls)}, not exactly ${url}`);
    return `http, javascript, file and too long refused with no dialog; Don't open: the handler got nothing; Open: it got exactly the approved URL (${rec.how})`;
  });

  await check('security.files.save-refused', async () => {
    const bytes = new TextEncoder().encode('familiar check ' + rand(8));
    // `watch` is the folder as this PC sees it, watched for any change to the chosen name while
    // the dialog is open and until the save returns: a test file made before the exe judged the
    // folder would show there.
    const save = async (dir: string, watch = dir) => {
      const name = `familiar-check-${rand(6)}.txt`;
      await step('save-watch-start', { dir: watch, name });
      const r = shell.saveAs({ name, filters: [{ name: 'Text', extensions: ['txt'] }] }, bytes).then(v => (v ? 'saved' : 'cancelled'), e => errKind(e));
      const d = await step<{ shown: boolean; why?: string; typed?: string }>('save-dialog', { path: `${dir}\\${name}` });
      ok(d.shown, `no save dialog: ${d.why ?? ''}`);
      const outcome = await r;
      const events = await step<{ events: string[] }>('save-watch-stop');
      const there = await step<{ length: number; found: string[] }>('file-length', { path: `${watch}\\${name}`, find: name });
      if (outcome === 'saved' && there.length < 0) fail(`saved, but not at ${dir}: found at ${there.found.join(' | ') || 'nowhere looked'}; the box read ${d.typed}`);
      return { outcome, length: there.length, events: events.events };
    };
    const normal = await save(p.tmp);
    ok(normal.outcome === 'saved' && normal.length === bytes.length, `a normal folder: ${normal.outcome}, ${normal.length} bytes`);
    ok(normal.events.length > 0, 'the watch saw nothing of a real save, so it proves nothing');
    const refusedAt: [string, string, string?][] = [
      ['the data folder', info.dataDir],
      ['the WebView2 folder', info.webviewDir],
      ["the exe's folder", p.exeDir],
      ['the mapped drive', `${p.smb.mapped}:\\familiar-fx`, 'C:\\familiar-fx'],
      ['a UNC path', `${p.smb.unc}\\familiar-fx`, 'C:\\familiar-fx']
    ];
    for (const [what, dir, local] of refusedAt) {
      const r = await save(dir, local ?? dir);
      ok(r.outcome === 'refused' && r.length < 0, `${what}: ${r.outcome}, ${r.length}`);
      ok(r.events.length === 0, `${what}: the folder changed during the dialog: ${r.events.join(' ')}`);
    }
    return `a normal folder saved whole (the watch saw ${normal.events.length} changes); the data, WebView2 and exe folders, a mapped drive and a UNC path refused, with no change at the chosen name in any of them`;
  });

}

/* In a run of its own, so the refusals are counted from none: after three, an approved setup
   still starts, and a changed one is asks-stopped with no dialog. */
async function stoppedAsks() {
  const p = await step<Paths>('proc-paths', {}, 120000);
  await check('security.server.stopped-asks', async () => {
    const a = fakeSetup(p, 'fake-st');
    const changed = (n: number): Setup => ({ ...a, env: [['CHECK_SETTING', `changed-${n}`]] });
    const m = new Mcp();
    const r = await startWith(m, a, 'yes');
    ok(r.started === 'started', 'the first start: ' + r.started);
    await shell.serverStop(m.run);
    await m.exited(5000);
    for (const n of [1, 2, 3]) {
      const rn = await startWith(new Mcp(), changed(n), 'no');
      ok(rn.dialog.shown && rn.started === 'declined', `refusal ${n}: dialog ${rn.dialog.shown}, ${rn.started}`);
    }
    const again = new Mcp();
    const r2 = await startWith(again, a, 'none');
    ok(!r2.dialog.shown && r2.started === 'started', `the approved setup after three refusals: dialog ${r2.dialog.shown}, ${r2.started}`);
    const name = await again.initialize();
    await shell.serverStop(again.run);
    await again.exited(5000);
    const r3 = await startWith(new Mcp(), changed(4), 'none');
    ok(!r3.dialog.shown && r3.started === 'asks-stopped', `a changed setup after three refusals: dialog ${r3.dialog.shown}, ${r3.started}`);
    return `after three refusals the approved setup started with no dialog (${name}), and a changed one was asks-stopped with no dialog`;
  });
}

async function recover(info: Info) {
  const p = await step<Paths>('proc-paths', {}, 120000);
  await check('security.server.forget-pending', async () => {
    // A forget while the start is under way, here while its dialog is open: approving after it
    // must not start anything, nor store the approval.
    const s = fakeSetup(p, 'fake-fp');
    const m = new Mcp();
    const started = m.start(s).then(() => 'started', e => errKind(e));
    const held = await step<{ found: boolean }>('dialog', { act: 'hold', approve: START[0], refuse: START[1] }, 60000);
    ok(held.found, 'no dialog to hold');
    await shell.serverForget(s.id);
    const approved = await step<{ answered: string }>('dialog', { act: 'approve', approve: START[0], refuse: START[1] }, 60000);
    const outcome = await started;
    ok(outcome === 'revoked', `approved after the forget (${approved.answered}): ${outcome}`);
    const left = await step<{ count: number }>('node-children');
    ok(left.count === 0, 'a node process started');
    const again = await startWith(new Mcp(), s, 'no');
    ok(again.dialog.shown && again.started === 'declined', `the next start: dialog ${again.dialog.shown}, ${again.started}: the approval was stored`);
    return 'forgotten while its dialog was open: approving gave revoked, nothing ran, and the next start asked again';
  });
  await check('security.server.store-recovery', async () => {
    const s = fakeSetup(p, 'fake-c');
    const m = new Mcp();
    const r = await startWith(m, s, 'no');
    ok(r.dialog.shown, 'an approved setup started unasked with servers.json unreadable');
    ok(r.started === 'declined', 'the start: ' + r.started);
    const aside = await step<{ length: number }>('file-length', { path: `${info.dataDir}\\shell\\servers.json.unreadable` });
    ok(aside.length > 0, 'the unreadable file was not kept aside');
    const left = await step<{ count: number }>('node-children');
    ok(left.count === 0, 'a node process started');
    return 'garbage in servers.json: the approved setup asked again, No left nothing running, the file was renamed aside';
  });
}

async function kill() {
  const p = await step<Paths>('proc-paths', {}, 120000);
  const m = new Mcp();
  const r = await startWith(m, fakeSetup(p, 'fake-k'), 'yes');
  if (r.started !== 'started') {
    await say(`CHECK FAIL security.server.kill the start: ${r.started}`);
    return;
  }
  await m.initialize();
  const tree = JSON.parse(await m.tool('spawn_tree')) as { server: number; child: number; grandchild: number };
  void m.tool('slow', { ms: 60000 }, 70000).catch(() => '');
  await sleep(500);
  // The driver checks the server, its child and its grandchild are alive, kills the exe hard, and
  // reports what's left 2 s later. Nothing here runs after.
  await say('INFO kill ready');
  await step('kill-tree', { pids: [tree.server, tree.child, tree.grandchild] }, 120000);
}

async function wake(messages: CoreMessage[]) {
  await check('check.wake.hidden', async () => {
    const at = Date.now() + 10 * 60 * 1000;
    await shell.wakeAt(Date.now() + 3_600_000);
    await shell.wakeAt(at);
    // A hidden page's timers are throttled to about once a minute, so the wake is caught as its
    // message arrives, not by polling.
    let arrived = 0;
    const heard = new Promise<void>(done => {
      const push = messages.push.bind(messages);
      messages.push = (...m: CoreMessage[]) => {
        const n = push(...m);
        if (m.some(x => x.t === 'wake')) { arrived = Date.now(); done(); }
        return n;
      };
    });
    const timedOut = await Promise.race([heard.then(() => false), sleep(11 * 60 * 1000).then(() => true)]);
    ok(!timedOut, 'no wake within 11 minutes');
    const got = messages.find(m => m.t === 'wake') as { at: number; now: number };
    const late = arrived - at;
    ok(got.at === at, 'the wake was for another deadline');
    ok(got.now - at < 1000 && late < 1500, `the wake came ${got.now - at} ms late by the exe, ${late} ms by the page`);
    const twice = messages.filter(m => m.t === 'wake').length;
    ok(twice === 1, `${twice} wakes for one deadline`);
    return `core hidden, no views, 10 minutes: the wake came ${got.now - at} ms after its deadline (${late} ms at the page)`;
  });
}

export async function procPhase(phase: string, info: Info, messages: CoreMessage[], ctx: Ctx) {
  if (phase === 'proc-main') await main(info, ctx);
  else if (phase === 'proc-files') await filesAndLinks(info);
  else if (phase === 'proc-recover') await recover(info);
  else if (phase === 'proc-stopped') await stoppedAsks();
  else if (phase === 'proc-kill') await kill();
  else if (phase === 'proc-wake') await wake(messages);
}
