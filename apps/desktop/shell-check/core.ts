/* The contract check's core page: the hub. It runs in the core window, says ready, opens the other
   check pages, and runs every check through the app's real client, writing a CHECK line for each.
   The driver starts the exe once per phase, with `--phase <name>`. */
import type { CoreMessage, Info } from '../src/shell.ts';
import { reason } from '../src/shell.ts';
import { bus, check, fail, fixtures, gate, ok, rand, raw, say, shell, skip, sleep, step, until, violations } from './common.ts';
import { hostile } from './hostile.ts';
import { CORE_EVENT_NAMES, CORE_ONLY, EVENTS, NOT_YET, PLUGINS } from './lists.ts';
import { allowed, trySinks } from './tt.ts';

const messages: CoreMessage[] = [];
let onQuitting: () => void = () => {};

/* ---------- talking to the other pages ---------- */

const hello = new Map<string, string>(), replies = new Map<number, { value?: unknown; error?: string }>();
bus.onmessage = ({ data: m }) => {
  if (m?.hello) hello.set(m.hello, m.token);
  if (m?.reply) replies.set(m.reply, m);
};
let askN = 0;
async function ask<T = unknown>(to: string, cmd: string, args?: unknown, ms = 30000): Promise<T> {
  const id = ++askN;
  bus.postMessage({ to, cmd, args, id });
  const r = await until(() => replies.get(id), ms, `${to} ${cmd}`);
  if (r.error) fail(`${to} ${cmd}: ${r.error}`);
  return r.value as T;
}
const up = (role: string) => until(() => hello.get(role), 20000, role + ' to load');

/* ---------- small things ---------- */

const arg = (info: Info, name: string) => { const i = info.args.indexOf(name); return i >= 0 ? info.args[i + 1] : undefined; };
const nonAcl = (r: Record<string, string>) => Object.entries(r).filter(([, v]) => v !== 'acl').map(([k]) => k);
const aclOnly = (r: Record<string, string>) => Object.entries(r).filter(([, v]) => v === 'acl').map(([k]) => k);
const brief = (o: unknown) => JSON.stringify(o).replace(/"/g, '').slice(0, 900);

async function persist(when: string) {
  await check(`check.persist.${when}`, async () => {
    const before = await navigator.storage.persisted();
    await say('INFO persist asking');
    const granted = before || await navigator.storage.persist();
    await say('INFO persist answered');
    const { quota, usage } = await navigator.storage.estimate();
    return `persisted=${before} granted=${granted} quota=${quota} usage=${usage}`;
  });
}

/* IndexedDB with strict durability, as the app will use it. */
function db(): Promise<IDBDatabase> {
  return new Promise((done, no) => {
    const r = indexedDB.open('familiar-check', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => done(r.result);
    r.onerror = () => no(r.error);
  });
}
async function put(key: string, value: string) {
  const d = await db();
  await new Promise<void>((done, no) => {
    const t = d.transaction('kv', 'readwrite', { durability: 'strict' });
    t.objectStore('kv').put(value, key);
    t.oncomplete = () => done();
    t.onerror = () => no(t.error);
  });
  d.close();
}
async function get(key: string): Promise<unknown> {
  const d = await db();
  const v = await new Promise((done, no) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => done(r.result);
    r.onerror = () => no(r.error);
  });
  d.close();
  return v;
}

/* Whether Tauri's IPC went over its own protocol, or fell back to postMessage. */
function ipcRoute(): string {
  const entries = performance.getEntriesByType('resource').filter(e => e.name.startsWith('http://ipc.localhost/')) as PerformanceResourceTiming[];
  const okCount = entries.filter(e => e.responseStatus === 200).length;
  return `ipc.localhost requests ${entries.length}, ok ${okCount}`;
}

/* ---------- the main phase ---------- */

async function main(info: Info) {
  await check('security.pin.origin', async () => {
    ok(location.origin === 'http://tauri.localhost', `location.origin is ${location.origin}`);
    ok(info.origin === location.origin, `shell_info says ${info.origin}`);
    return location.origin;
  });
  await check('check.info', async () => {
    const dataDir = arg(info, '--data-dir');
    ok(info.api === 1, `api ${info.api}`);
    ok(dataDir && info.dataDir === dataDir, 'dataDir is not --data-dir');
    ok(info.webviewDir === `${info.dataDir}\\webview`, `webviewDir ${info.webviewDir}`);
    ok(info.autostarted === false, 'autostarted without --autostart');
    return `api ${info.api} version ${info.version} args ${info.args.length}`;
  });
  await persist('main');

  await check('security.caps.core-reaches', async () => {
    // The same commands the views are refused, with arguments the command itself turns away, so
    // nothing opens or quits here. Reaching the command is what counts.
    const r: Record<string, string> = {};
    r.shell_info = await gate('shell_info');
    r.shell_ready = await gate('shell_ready', { channel: '__CHANNEL__:1' });
    r.quit_ready = await gate('quit_ready');
    r.tray_set = await gate('tray_set', { spec: { tooltip: 'Familiar check' } });
    r.view_open = await gate('view_open', { spec: { label: 'view-', page: 'chat.html' } });
    r.window_ctl = await gate('window_ctl', { label: 'view-none', op: 'get-bounds' });
    r.log_line = await gate('log_line', { line: 'reaches' });
    ok(Object.keys(r).length === CORE_ONLY.length, 'the list and CORE_ONLY differ');
    const notReached = aclOnly(r);
    ok(notReached.length === 0, 'refused by the gate: ' + notReached.join(' '));
    // A real tray menu, through the typed client.
    await shell.traySet({ tooltip: 'Familiar check', icon: 'tray.png', items: [{ id: 'check', label: 'Check item' }] });
    return `${Object.keys(r).length} commands reached, quit is reached by the run's end`;
  });

  // The other pages.
  await shell.viewOpen({ label: 'settings', title: 'Familiar check settings', width: 420, height: 300 });
  await shell.viewOpen({ label: 'view-chat', page: 'chat.html', title: 'Familiar check chat', width: 420, height: 300 });
  await shell.viewOpen({ label: 'view-bare', page: 'bare.html', title: 'Familiar check bare', width: 300, height: 200 });
  await shell.viewOpen({ label: 'view-closer', page: 'closer.html', title: 'Familiar check closer', width: 300, height: 200 });
  for (const role of ['settings', 'chat', 'bare', 'closer']) await up(role);

  await check('security.caps.view-refused', async () => {
    const bad: string[] = [];
    for (const role of ['chat', 'bare', 'closer']) {
      const r = await ask<Record<string, string>>(role, 'refusals', [...CORE_ONLY, ...NOT_YET, ...PLUGINS]);
      bad.push(...nonAcl(r).map(c => `${role}:${c}`));
    }
    const s = await ask<Record<string, string>>('settings', 'refusals', [...CORE_ONLY, ...PLUGINS, ...EVENTS]);
    bad.push(...nonAcl(s).map(c => `settings:${c}`));
    ok(bad.length === 0, 'not refused: ' + bad.join(' '));
    // And what they are allowed still reaches its command, so the refusals above mean something.
    const allowedView = await ask<Record<string, string>>('chat', 'refusals', [['log_line', { line: 'allowed' }], ['window_self', { op: 'nope' }]]);
    const allowedSettings = await ask<Record<string, string>>('settings', 'refusals', [['log_line', { line: 'allowed' }], ['window_self', { op: 'nope' }]]);
    ok(aclOnly(allowedView).length === 0 && aclOnly(allowedSettings).length === 0, `allowed calls refused: ${brief({ allowedView, allowedSettings })}`);
    const n = CORE_ONLY.length + NOT_YET.length + PLUGINS.length;
    return `views refused ${n} calls each, settings ${CORE_ONLY.length + PLUGINS.length + EVENTS.length}, allowed calls reached`;
  });

  await check('security.caps.forged-event', async () => {
    const listening = await ask<Record<string, string>>('chat', 'listen', CORE_EVENT_NAMES);
    ok(Object.values(listening).every(v => v === 'listening'), 'a view could not listen: ' + brief(listening));
    const emit = await gate('plugin:event|emit', { event: 'second-launch', payload: { args: ['forged'] } });
    ok(emit === 'acl', 'core could emit');
    const big = 'x'.repeat(10000);
    const second = await step<{ exit: number; ms: number }>('second-launch', { args: ['--hello', 'small'] });
    // A page line is cut at 4 KiB, so the driver makes the long argument itself.
    const second2 = await step<{ exit: number; ms: number }>('second-launch', { args: ['--hello'], long: big.length });
    const tray = await step<{ done: boolean; how: string }>('tray-click', {});
    await sleep(1500);
    const got = messages.filter(m => m.t === 'second-launch') as { args: string[] }[];
    ok(got.some(m => m.args.includes('small')), 'core never heard the second launch');
    ok(got.some(m => m.args.includes(big)), 'core never heard the large second launch');
    // The tray click is a bonus: the runner's shell may not report the icon's place, and then
    // tray-icon sends nothing. The second launches are what core must hear.
    const clicks = messages.filter(m => m.t === 'tray-click').length;
    const heard = await ask<Record<string, number>>('chat', 'heard');
    ok(Object.keys(heard).length === 0, 'the view heard: ' + brief(heard));
    return `view heard nothing; core heard ${got.length} second launches (exit ${second.exit} in ${second.ms} ms, ${second2.ms} ms) and ${clicks} tray clicks (${tray.how})`;
  });

  await check('security.csp.trusted-types', async () => {
    const mine = trySinks();
    const leftCore = allowed(mine);
    const ipcCore = await shell.info().then(() => 'ok', e => 'failed:' + reason(e));
    const chat = await ask<{ sinks: Record<string, string>; ipc: string; violations: string[]; earlier: string[] }>('chat', 'tt');
    const leftChat = allowed(chat.sinks);
    ok(leftCore.length === 0, 'core allowed: ' + leftCore.join(' '));
    ok(leftChat.length === 0, 'chat allowed: ' + leftChat.join(' '));
    ok(ipcCore === 'ok' && chat.ipc === 'ok', `IPC after: core ${ipcCore}, chat ${chat.ipc}`);
    // Tauri's own script delivered channel messages both ways it has: by script for small ones,
    // and by its fetch command for big ones. Both were heard in the check above.
    const small = messages.some(m => m.t === 'second-launch' && m.args.includes('small'));
    const large = messages.some(m => m.t === 'second-launch' && m.args.some(a => a.length >= 10000));
    ok(small && large, `channel: small ${small}, large ${large}`);
    // A violation from anything but the check's own scripts would be Tauri's injected script
    // tripping over Trusted Types.
    const foreign = [...violations, ...chat.violations, ...chat.earlier].filter(v => !/@\/(core|page)\.js:/.test(v));
    ok(foreign.length === 0, 'violations from other scripts: ' + foreign.slice(0, 8).join(' '));
    return `every sink threw in core and chat, IPC ok, channel small+large ok, ${ipcRoute()}, violations core ${violations.length} chat ${chat.violations.length + chat.earlier.length}, none from Tauri's scripts`;
  });

  await check('security.csp.no-service-worker', async () => {
    const bare = await ask<Record<string, string>>('bare', 'service-workers');
    const chat = await ask<Record<string, string>>('chat', 'service-workers');
    const core = await navigator.serviceWorker.register('sw.js').then(() => 'registered', e => 'rejected:' + (e as Error).name);
    for (const [who, r] of [['bare', bare], ['chat', chat]] as const) {
      ok(r.file.startsWith('rejected') && r.blob.startsWith('rejected') && r.registrations === '0', `${who}: ${brief(r)}`);
    }
    ok(core.startsWith('rejected'), 'core: ' + core);
    return `bare (exe CSP alone) ${brief(bare)}; chat ${brief(chat)}; core ${core}`;
  });

  // Permissions, with the clipboard holding something a page must not read.
  const clipText = 'clip-' + rand(16);
  let pasteWorks = 'not tried';
  await check('security.perm.denied', async () => {
    await step('clipboard-set', { text: clipText });
    const before = await step<{ windows: string[] }>('windows');
    // A page must be focused, or Chromium refuses a clipboard read before asking for permission,
    // and the exe's handler would never be tested.
    const focusS = await step<{ focused: boolean }>('focus', { title: 'Familiar check settings' });
    const settings = await ask<Record<string, string>>('settings', 'permissions');
    const focusC = await step<{ focused: boolean }>('focus', { title: 'Familiar check chat' });
    const chat = await ask<Record<string, string>>('chat', 'permissions');
    await sleep(1000);
    const after = await step<{ windows: string[] }>('windows');
    const fresh = after.windows.filter(w => !before.windows.includes(w));
    const denied = await step<{ count: number; lines: string[] }>('log-grep', { pattern: 'permission denied in ' });
    const bad: string[] = [];
    for (const [who, r] of [['settings', settings], ['chat', chat]] as const) {
      if (!r.clipboard.startsWith('rejected')) bad.push(`${who} clipboard ${r.clipboard}`);
      for (const k of ['mic', 'camera', 'location', 'sysex']) if (!r[k].startsWith('rejected') && !r[k].startsWith('resolved:absent')) bad.push(`${who} ${k} ${r[k]}`);
      if (!/^resolved:(denied|absent)/.test(r.notification)) bad.push(`${who} notification ${r.notification}`);
      for (const v of Object.values(r)) if (v.startsWith('pending')) bad.push(`${who} waited: a prompt?`);
    }
    ok(fresh.length === 0, 'new windows appeared: ' + fresh.join(' | '));
    ok(bad.length === 0, bad.join('; '));
    const kinds = [...new Set(denied.lines.map(l => l.replace(/^.*permission denied in /, '')))];
    ok(kinds.some(k => k.startsWith('settings: clipboard-read')), `the exe never saw Settings ask for the clipboard (focused ${focusS.focused}): ${kinds.join(', ')}; settings ${brief(settings)}`);
    return `no prompt; settings ${brief(settings)}; chat ${brief(chat)} (focused ${focusS.focused}/${focusC.focused}); the exe denied: ${kinds.join(', ')}`;
  });
  await check('check.perm.paste', async () => {
    const focused = await ask<boolean>('settings', 'paste-ready');
    const sent = await step<{ sent: boolean; why?: string }>('paste', { title: 'Familiar check settings' });
    if (!sent.sent) skip('the driver could not type here: ' + (sent.why ?? ''));
    const value = await until(async () => (await ask<string>('settings', 'paste-value')) || null, 5000, 'the paste').catch(() => '');
    pasteWorks = value === clipText ? 'yes' : `no (${value.length} chars)`;
    ok(value === clipText, `Settings' text box has ${value.length} chars, focused ${focused}`);
    return 'Ctrl+V into Settings worked';
  });
  await check('check.clipboard.write', async () => {
    const text = 'write-' + rand(12);
    await ask('chat', 'clip-ready', text);
    const click = await step<{ clicked: boolean; why?: string }>('click', { title: 'Familiar check chat' });
    if (!click.clicked) skip('the driver could not click here: ' + (click.why ?? ''));
    const result = await until(async () => { const r = await ask<string>('chat', 'clip-result'); return r === 'no click' ? null : r; }, 5000, 'the write').catch(() => 'no click');
    const back = await step<{ text: string }>('clipboard-get');
    ok(result === 'written' && back.text === text, `page said ${result}, clipboard ${back.text === text ? 'matches' : 'differs'}`);
    return 'navigator.clipboard.writeText after a real click works in a view';
  });
  await say(`INFO paste ${pasteWorks}`);

  await check('security.caps.page-binding', async () => {
    const s0 = await ask<{ token: string }>('settings', 'where');
    const c0 = await ask<{ token: string }>('chat', 'where');
    await ask('settings', 'navigate', 'chat.html');
    await ask('chat', 'navigate', 'settings.html');
    await sleep(2000);
    const s1 = await ask<{ token: string; path: string }>('settings', 'where');
    const c1 = await ask<{ token: string; path: string }>('chat', 'where');
    ok(s1.token === s0.token && s1.path === '/settings.html', 'settings left its page');
    ok(c1.token === c0.token && c1.path === '/chat.html', 'chat left its page');
    const tries: [string, string | undefined][] = [
      ['view-x', 'settings.html'], ['view-x', 'SETTINGS.HTML'], ['view-x', '%73ettings.html'], ['view-x', 'core.html'],
      ['view-x', 'sub/../settings.html'], ['settings', 'chat.html'], ['core', 'core.html'], ['view-x', 'missing.html']
    ];
    const opened: string[] = [];
    for (const [label, page] of tries) {
      const r = await shell.viewOpen({ label, page }).then(() => 'opened', e => reason(e));
      if (r === 'opened') opened.push(`${label}:${page}`);
    }
    ok(opened.length === 0, 'opened: ' + opened.join(' '));
    const refusedNav = await step<{ count: number }>('log-grep', { pattern: 'navigation refused in (settings|view-chat)' });
    ok(refusedNav.count >= 2, `the exe logged ${refusedNav.count} refused navigations`);
    return `settings and chat stayed on their pages, ${tries.length} bad view_open calls refused`;
  });

  // Egress: core, a view, and a view without Trusted Types, one after another.
  const fx = await fixtures();
  await step('mark', { name: 'egress-start' });
  await step('mark', { name: 'core-start' });
  const coreOut = await hostile('core', fx, { nav: true });
  for (const [route, o] of Object.entries(coreOut)) await say(`EGRESS core ${route} ${JSON.stringify(o)}`);
  await say('EGRESS-DONE core');
  await step('mark', { name: 'core-end' });
  for (const [role, ctx] of [['chat', 'view'], ['bare', 'bare']] as const) {
    await step('mark', { name: `${ctx}-start` });
    const r = await ask<{ routes: number; ipcAfter: string }>(role, 'egress', ctx, 120000).catch(e => ({ routes: 0, ipcAfter: 'failed: ' + e.message }));
    await say(`INFO egress ${ctx} routes ${r.routes} ipc-after ${r.ipcAfter}`);
    await step('mark', { name: `${ctx}-end` });
  }
  await step('mark', { name: 'egress-end' });
  await check('check.egress.pages-alive', async () => {
    for (const role of ['chat', 'bare']) await ask(role, 'where');
    return 'core, chat and bare all still on their pages after every navigation route';
  });

  await check('security.nav.refused', async () => {
    const lines = await step<{ count: number; lines: string[] }>('log-grep', { pattern: '(navigation|new window) refused in ' });
    const urls = lines.lines.filter(l => l.includes('://') || l.includes('familiar-check'));
    ok(lines.count >= 6, `only ${lines.count} refusals logged`);
    ok(urls.length === 0, 'a refusal line carries a URL');
    const s = await ask<{ path: string }>('settings', 'where');
    ok(s.path === '/settings.html', 'settings moved');
    // WebRTC isn't navigation and is judged in the egress checks: only http requests count here.
    const hits = await step<{ hits: number }>('hits', { prefix: fx.run });
    ok(hits.hits === 0, `the listener saw ${hits.hits} http requests from Familiar`);
    return `${lines.count} refusals logged by scheme only, every page stayed, the listener saw nothing`;
  });

  await check('security.caps.cross-window', async () => {
    ok(await gate('window_self', { op: 'minimize' }) === 'acl', 'core may call window_self');
    const coreCtl = await shell.windowCtl('core', 'hide').then(() => 'done', e => reason(e));
    ok(coreCtl.startsWith('refused'), 'window_ctl on core: ' + coreCtl);
    const viaPlugin = await ask<Record<string, string>>('chat', 'refusals', [['plugin:window|close', { label: 'core' }], ['plugin:window|close', { label: 'settings' }]]);
    ok(nonAcl(viaPlugin).length === 0, 'a view reached plugin:window|close');
    await ask('closer', 'close-self');
    await sleep(1500);
    const closer = await shell.windowCtl('view-closer', 'get-bounds').then(() => 'there', e => reason(e));
    ok(closer.startsWith('missing'), 'view-closer is still there: ' + closer);
    const chat = await shell.windowCtl('view-chat', 'get-bounds');
    const settings = await shell.windowCtl('settings', 'get-bounds');
    ok(chat && settings, 'another window went with it');
    await ask('chat', 'where');
    // window_ctl's own ops, on Settings.
    await shell.windowCtl('settings', 'set-bounds', { x: 40, y: 40, width: 500, height: 320 });
    const moved = await shell.windowCtl('settings', 'get-bounds');
    ok(moved && moved.width === 500 && moved.height === 320, 'set-bounds: ' + brief(moved));
    for (const op of ['hide', 'show', 'focus'] as const) await shell.windowCtl('settings', op);
    return 'view-closer closed itself and nothing else; core is out of window_ctl and window_self; plugin:window refused';
  });

  await say(`INFO violations core ${brief(violations)}`);
  await say(`INFO ${ipcRoute()}`);
  // Last: quit through the real client, with a write to finish while quitting.
  onQuitting = async () => {
    await put('quit-main', 'written while quitting');
    await say('INFO quit write finished');
    await shell.quitReady();
  };
  await say('DONE');
  await shell.quit();
}

/* ---------- the pin phases, on the default data folder ---------- */

async function pinWrite(info: Info, value: string) {
  await check('check.pin.origin-default', async () => {
    ok(location.origin === 'http://tauri.localhost', location.origin);
    ok(!arg(info, '--data-dir'), 'this phase must use the default data folder');
    return `${location.origin} data ...\\${info.dataDir.split('\\').slice(-2).join('\\')}`;
  });
  await persist('fresh');
  await put('pin', value);
  await say('INFO pin written');
  onQuitting = async () => {
    await put('quit', 'q-' + value);
    await say('INFO quit write finished');
    await shell.quitReady();
  };
  await say('DONE');
  await shell.quit();
}

async function pinRead(info: Info, value: string, id: string) {
  await persist(id === 'security.pin.moved-install' ? 'moved' : 'second');
  await check(id, async () => {
    const got = await get('pin');
    ok(got === value, `read back ${typeof got === 'string' ? got.length + ' chars, different' : String(got)}`);
    return `the value written by the first run is here, data ${info.dataDir.split('\\').slice(-2).join('\\')}`;
  });
  if (id === 'security.pin.restart') {
    await check('check.quit.write-landed', async () => {
      ok(await get('quit') === 'q-' + value, 'the write core made while quitting is missing');
      return 'the write core finished after quitting is there';
    });
  }
  onQuitting = () => { shell.quitReady().catch(() => {}); };
  await say('DONE');
  await shell.quit();
}

/* ---------- start ---------- */

(async () => {
  const info = await shell.info();
  await shell.ready(m => {
    messages.push(m);
    if (m.t === 'quitting') onQuitting();
  });
  const phase = arg(info, '--phase') ?? 'main';
  const value = arg(info, '--value') ?? '';
  await say(`INFO phase ${phase} api ${info.api}`);
  try {
    if (phase === 'main') await main(info);
    else if (phase === 'pin-write') await pinWrite(info, value);
    else if (phase === 'pin-read') await pinRead(info, value, 'security.pin.restart');
    else if (phase === 'pin-moved') await pinRead(info, value, 'security.pin.moved-install');
    else if (phase === 'webrtc') {
      // A measurement: only the WebRTC routes, under whatever browser arguments the driver chose.
      await step('mark', { name: 'webrtc-' + arg(info, '--variant') });
      const out = await hostile('probe', await fixtures(), { nav: false, only: ['webrtc-stun', 'webrtc-turn'] });
      await say(`INFO webrtc ${arg(info, '--variant')} ${JSON.stringify(out)}`);
      onQuitting = () => { shell.quitReady().catch(() => {}); };
      await say('DONE');
      await shell.quit();
    } else if (phase === 'hung-quit') {
      onQuitting = () => { void say('INFO hung core ignores quitting'); };
      await say('DONE');
    } else await say(`CHECK FAIL check.phase unknown phase ${phase}`);
  } catch (e) {
    await say(`CHECK FAIL check.core-page ${e instanceof Error ? e.message : reason(e)}`);
    await shell.quit();
  }
})();
