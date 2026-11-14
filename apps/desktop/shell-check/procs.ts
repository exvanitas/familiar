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

async function main(info: Info) {
  const p = await step<Paths>('proc-paths', {}, 120000);
  const bad = (problems: (string | null)[]) => problems.filter(Boolean) as string[];

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

  // Paths that would reach the share, between two samples of the SMB counts and their control.
  await step('smb-save', { name: 'servers-before' });
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
  const counts = `SMB during the starts: ${smb.opens} server opens, ${smb.new.length} new connections; control: ${control.opens} opens, ${control.new.length} new (${p.smb.how})`;
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
    const { port } = await step<{ port: number }>('listen-start');
    const url = `https://127.0.0.1:${port}/familiar-check-${rand(6)}`;
    const no = shell.openUrl(url).then(() => 'opened', e => errKind(e));
    const d1 = await dialog('refuse', OPEN);
    ok(d1.shown && await no === 'declined', `Don't open: dialog ${d1.shown}, ${await no}`);
    ok(d1.text.includes('127.0.0.1'), 'the dialog does not show the host');
    const none = await step<{ count: number }>('listen-count', { ms: 4000 });
    ok(none.count === 0, `the listener saw ${none.count} connections after Don't open`);
    const yes = shell.openUrl(url).then(() => 'opened', e => errKind(e));
    const d2 = await dialog('approve', OPEN);
    ok(d2.shown && await yes === 'opened', `Open: dialog ${d2.shown}, ${await yes}`);
    const seen = await step<{ count: number }>('listen-count', { ms: 30000, until: 1 });
    await step('listen-stop');
    ok(seen.count > 0, 'the listener saw no connection after Open');
    return `http, javascript, file and too long refused with no dialog; Don't open: no connection; Open: ${seen.count} connections`;
  });

  await check('security.files.save-refused', async () => {
    const bytes = new TextEncoder().encode('familiar check ' + rand(8));
    const save = async (dir: string) => {
      const name = `familiar-check-${rand(6)}.txt`;
      const r = shell.saveAs({ name, filters: [{ name: 'Text', extensions: ['txt'] }] }, bytes).then(v => (v ? 'saved' : 'cancelled'), e => errKind(e));
      const d = await step<{ shown: boolean; why?: string; typed?: string }>('save-dialog', { path: `${dir}\\${name}` });
      ok(d.shown, `no save dialog: ${d.why ?? ''}`);
      const outcome = await r;
      const there = await step<{ length: number; found: string[] }>('file-length', { path: `${dir}\\${name}`, find: name });
      if (outcome === 'saved' && there.length < 0) fail(`saved, but not at ${dir}: found at ${there.found.join(' | ') || 'nowhere looked'}; the box read ${d.typed}`);
      return { outcome, length: there.length };
    };
    const normal = await save(p.tmp);
    ok(normal.outcome === 'saved' && normal.length === bytes.length, `a normal folder: ${normal.outcome}, ${normal.length} bytes`);
    const data = await save(info.dataDir);
    ok(data.outcome === 'refused' && data.length < 0, `the data folder: ${data.outcome}, ${data.length}`);
    const webview = await save(info.webviewDir);
    ok(webview.outcome === 'refused' && webview.length < 0, `the WebView2 folder: ${webview.outcome}, ${webview.length}`);
    const exe = await save(p.exeDir);
    ok(exe.outcome === 'refused' && exe.length < 0, `beside the exe: ${exe.outcome}, ${exe.length}`);
    return 'a normal folder saved whole; the data folder, the WebView2 folder and the exe\'s folder refused, nothing written';
  });

}

async function recover(info: Info) {
  const p = await step<Paths>('proc-paths', {}, 120000);
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
  void m.tool('slow', { ms: 60000 }, 70000).catch(() => '');
  await sleep(500);
  // The driver kills the exe hard and reports what's left 2 s later. Nothing here runs after.
  await say('INFO kill ready');
  await step('kill-tree', {}, 120000);
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

export async function procPhase(phase: string, info: Info, messages: CoreMessage[]) {
  if (phase === 'proc-main') await main(info);
  else if (phase === 'proc-files') await filesAndLinks(info);
  else if (phase === 'proc-recover') await recover(info);
  else if (phase === 'proc-kill') await kill();
  else if (phase === 'proc-wake') await wake(messages);
}
