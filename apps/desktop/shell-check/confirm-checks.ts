/* The native confirms, checked through saved addresses, their first caller. The driver reads each
   dialog through UI Automation and answers it as told (`dialog` steps in driver-net.ps1). See
   "The native confirms" in docs/shell-design.md. */
import { reason, type Address } from '../src/shell.ts';
import { check, ok, shell, step } from './common.ts';

/* What the driver read from a dialog. */
export interface Dialog {
  found: boolean;
  title: string;
  texts: string[];
  details: string;
  buttons: { name: string; enabled: boolean }[];
  approveAtStart: boolean;
  approveLater: boolean;
  invokedEarly: string;
  owner: string;
  topmost: boolean;
  answered: string;
  /* For 'enter': the approve button sampled every 40 ms, in ms from the dialog's creation. */
  timing?: { created: number; firstSample: number; lastOff: number; firstOn: number; samples: number; maxGap: number };
}
type WinState = Record<string, { found: boolean; topmost: boolean; enabled: boolean }>;

const APPROVE = 'Allow', REFUSE = "Don't allow";
const add = (port: number, path: string, label: string, owner?: string) =>
  shell.addressAdd({ kind: 'server', url: `http://127.0.0.1:${port}/${path}`, label, owner });
/* An ask's outcome, or 'no answer' if the dialog was never answered: the check fails, but goes on. */
const outcome = (p: Promise<Address>) =>
  Promise.race([p.then(a => 'saved:' + a.url, e => 'refused:' + reason(e)), new Promise<string>(r => setTimeout(() => r('no answer'), 45000))]);
const dialog = (act: string, extra: object = {}) => step<Dialog>('dialog', { act, approve: APPROVE, refuse: REFUSE, ...extra }, 60000);
const TITLES = ['Familiar check top', 'Familiar check settings', 'Familiar check chat'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function confirmChecks(ctx: { ask: <T>(to: string, cmd: string, args?: unknown) => Promise<T>; up: (role: string) => Promise<unknown> }) {
  await shell.viewOpen({ label: 'view-top', page: 'top.html', title: 'Familiar check top', width: 300, height: 200, alwaysOnTop: true });
  await ctx.up('top');

  // Hidden characters, a backslash and a newline in the label; the details hold the whole operation.
  await check('security.confirm.escaping', async () => {
    const label = 'evil‮exe​\nline\\x';
    const p = outcome(add(47001, 'escape', label));
    const d = await dialog('approve', { details: true });
    const r = await p;
    ok(d.found, 'no dialog appeared');
    const shown = [...d.texts, d.details].join('\n');
    ok(!/[‮​]/.test(shown), 'a hidden character was shown as itself');
    for (const e of ['\\u{202e}', '\\u{200b}', '\\u{a}', '\\\\x']) ok(shown.includes(e), `${e} is not in the dialog`);
    ok(d.details.includes('url: http://127.0.0.1:47001/escape') && d.details.includes('kind: server'), 'the details lack the operation: ' + d.details.slice(0, 200));
    ok(r === 'saved:http://127.0.0.1:47001/escape', r);
    return `hidden and control characters escaped, backslash doubled, details hold kind, url, reach and label; approved: ${r}`;
  });

  // Nothing changes behind an open dialog, and every window's state comes back.
  await check('security.confirm.frozen', async () => {
    const before = await step<WinState>('winstate', { titles: TITLES });
    ok(before['Familiar check top']?.topmost, 'view-top is not always-on-top to start with: ' + JSON.stringify(before));
    const p = outcome(add(47002, 'frozen-a', 'frozen', 'settings'));
    const held = await dialog('hold');
    ok(held.found, 'no dialog appeared');
    const during = await step<WinState>('winstate', { titles: TITLES });
    const windows0 = await step<{ windows: string[] }>('windows');
    const calls = {
      viewOpen: await shell.viewOpen({ label: 'view-extra', page: 'chat.html' }).then(() => 'opened', reason),
      closeOwner: await shell.windowCtl('settings', 'close').then(() => 'closed', reason),
      addChanged: await outcome(add(47002, 'frozen-b', 'changed', 'settings')),
      selfOp: await ctx.ask<string>('top', 'self-op', 'minimize')
    };
    const windows1 = await step<{ windows: string[] }>('windows');
    await dialog('approve');
    const r = await p;
    const after = await step<WinState>('winstate', { titles: TITLES });
    const list = (await shell.addressList()).map(a => a.url);
    ok(calls.viewOpen.startsWith('busy') && calls.closeOwner.startsWith('busy') && calls.addChanged === 'refused:busy: not asked' && calls.selfOp.includes('busy'), 'not busy: ' + JSON.stringify(calls));
    ok(windows1.windows.length === windows0.windows.length, 'a window appeared or went behind the dialog');
    ok(held.owner === 'Familiar check settings', 'owner: ' + held.owner);
    ok(Object.values(during).every(w => !w.found || (!w.topmost && !w.enabled)), 'not frozen: ' + JSON.stringify(during));
    ok(same(after, before), `not restored: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    ok(r === 'saved:http://127.0.0.1:47002/frozen-a' && list.includes('http://127.0.0.1:47002/frozen-a') && !list.includes('http://127.0.0.1:47002/frozen-b'), `stored ${r}, list ${list.join(' ')}`);
    return `busy for view_open, window_ctl on the owner, a changed address_add and window_self; always-on-top dropped and windows disabled while open, all restored; the shown operation stored`;
  });

  // A window opened at the moment an ask begins: either it's refused as busy, or it opened first
  // and is frozen with the rest. It never shows enabled or on top behind the dialog.
  await check('check.confirm.race', async () => {
    const seen: string[] = [];
    const bad: string[] = [];
    for (let i = 0; i < 4; i++) {
      const title = `Familiar check race ${i}`;
      // Sent in both orders, so both outcomes come up.
      const open = () => shell.viewOpen({ label: `view-race${i}`, page: 'download.html', title, width: 300, height: 200, alwaysOnTop: true }).then(() => 'opened', reason);
      const v = i % 2 ? open() : null;
      const p = outcome(add(47010 + i, 'race', 'race'));
      const v2 = v ?? open();
      const held = await dialog('hold');
      const opened = await v2;
      const during = await step<WinState>('winstate', { titles: [...TITLES, title] });
      await dialog('approve');
      const r = await p;
      const after = await step<WinState>('winstate', { titles: [title] });
      if (!held.found || !r.startsWith('saved:')) bad.push(`${i}: dialog ${held.found}, ${r}`);
      for (const [t, w] of Object.entries(during)) if (w.found && (w.topmost || w.enabled)) bad.push(`${i}: ${t} not frozen`);
      if (opened === 'opened') {
        if (!during[title]?.found) bad.push(`${i}: opened but not there`);
        if (!after[title]?.topmost || !after[title]?.enabled) bad.push(`${i}: not restored ${JSON.stringify(after[title])}`);
      } else if (!opened.startsWith('busy')) bad.push(`${i}: view_open ${opened}`);
      seen.push(opened === 'opened' ? 'opened first, then frozen' : 'busy');
      await shell.windowCtl(`view-race${i}`, 'close').catch(() => {});
    }
    ok(bad.length === 0, bad.join('; '));
    return `four view_open calls with always-on-top sent with an address_add, before and after it: ${seen.join(', ')}; none showed on top or enabled behind the dialog`;
  });

  // Defaults, then three refusals of three kinds, then the stop and the tray item.
  let defaults = 'not reached';
  let timingOk = false;
  await check('security.confirm.throttle', async () => {
    const before = await step<WinState>('winstate', { titles: TITLES });
    const p1 = outcome(add(47003, 'enter', 'reflex'));
    const d1 = await dialog('enter');
    const r1 = await p1;
    const t = d1.timing;
    const timing = t ? `sampled ${t.samples} times from ${t.firstSample} ms, at most ${t.maxGap} ms apart: last disabled at ${t.lastOff} ms, first enabled at ${t.firstOn} ms` : 'not sampled';
    timingOk = !!t && t.created > 0 && t.firstSample <= 400 && t.maxGap <= 150 && t.lastOff >= 900 && t.firstOn >= 1000 && t.firstOn <= 1400;
    defaults = `approve enabled at first ${d1.approveAtStart}, after a second ${d1.approveLater}, an early click ${d1.invokedEarly}, Enter gave ${r1}, top-most with no owner ${d1.topmost}; ${timing}`;
    ok(r1 === 'refused:declined: the person didn\'t allow it', 'Enter: ' + r1);
    const p2 = outcome(add(47004, 'close', 'closed'));
    await dialog('close');
    const r2 = await p2;
    const afterClose = await step<WinState>('winstate', { titles: TITLES });
    const p3 = outcome(add(47005, 'refuse', 'refused'));
    await dialog('refuse');
    const r3 = await p3;
    ok(r2.startsWith('refused:declined') && r3.startsWith('refused:declined'), `close ${r2}, refuse ${r3}`);
    ok(same(afterClose, before), 'not restored after a close: ' + JSON.stringify(afterClose));
    const r4 = await outcome(add(47006, 'fourth', 'fourth'));
    const none = await dialog('none');
    ok(r4.startsWith('refused:asks-stopped') && !none.found, `fourth ask: ${r4}, dialog ${none.found}`);
    const tray = await step<{ done: boolean; how: string }>('tray-ask-again');
    ok(tray.done, 'the tray item: ' + tray.how);
    const p5 = outcome(add(47007, 'again', 'again'));
    const d5 = await dialog('approve');
    const r5 = await p5;
    ok(d5.found && r5 === 'saved:http://127.0.0.1:47007/again', 'after the tray item: ' + r5);
    return `Enter, a close and Don't allow refused; the fourth ask was asks-stopped with no dialog; after "Let Familiar ask again" (${tray.how}) a dialog came and approved`;
  });
  await check('security.confirm.defaults', async () => {
    ok(defaults !== 'not reached', 'the throttle check never got there');
    ok(/enabled at first false, after a second true, an early click no effect, Enter gave refused:declined/.test(defaults), defaults);
    ok(timingOk, 'the first second: ' + defaults);
    return defaults;
  });
  await shell.windowCtl('view-top', 'close');
}
