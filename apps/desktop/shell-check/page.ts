/* The check's view and Settings pages: chat.html (view-chat and view-closer), bare.html (view-bare,
   a view with no Trusted Types of its own, to test the exe's CSP alone) and settings.html. Each
   answers what core asks over the check channel and reports back. Core writes the CHECK lines. */
import { bus, fixtures, gate, internals, rand, said, shell, sleep, stepBase, violations } from './common.ts';
import { hostile, type Ctx } from './hostile.ts';
import type { Call } from './lists.ts';
import { trySinks } from './tt.ts';

const role = location.pathname.replace(/^\//, '').replace(/\.html$/, '');
const token = rand(8);
stepBase({ chat: 10000, bare: 30000, settings: 20000, download: 50000 }[role] ?? 40000);
const heard: Record<string, number> = {};
let clip = '';

async function refusals(calls: Call[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [cmd, args] of calls) out[cmd] = await gate(cmd, args);
  return out;
}

function timed<T>(p: Promise<T>, ms: number): Promise<string> {
  const t0 = performance.now();
  return new Promise<string>(done => {
    const timer = setTimeout(() => done(`pending>${ms}ms`), ms);
    p.then(
      v => { clearTimeout(timer); done(`resolved:${typeof v === 'string' ? (v.length > 20 ? 'text' : v) : typeof v}@${Math.round(performance.now() - t0)}ms`); },
      e => { clearTimeout(timer); done(`rejected:${said(e)}@${Math.round(performance.now() - t0)}ms`); }
    );
  });
}

/* Every web permission a page could ask for. Each must be refused at once, with no prompt. */
async function permissions(): Promise<Record<string, string>> {
  const geo = new Promise<string>((done, no) => navigator.geolocation.getCurrentPosition(() => done('position'), e => no(new DOMException(e.message, `geo-${e.code}`))));
  const notify = typeof Notification === 'undefined' ? Promise.resolve('absent') : Notification.requestPermission();
  const midi = 'requestMIDIAccess' in navigator ? (navigator as unknown as { requestMIDIAccess(o: object): Promise<unknown> }).requestMIDIAccess({ sysex: true }) : Promise.resolve('absent');
  const [clipboard, mic, camera, location, notification, sysex] = await Promise.all([
    timed(navigator.clipboard.readText(), 5000),
    timed(navigator.mediaDevices.getUserMedia({ audio: true }), 5000),
    timed(navigator.mediaDevices.getUserMedia({ video: true }), 5000),
    timed(geo, 5000),
    timed(notify, 5000),
    timed(midi, 5000)
  ]);
  return { clipboard, mic, camera, location, notification, sysex };
}

async function serviceWorkers(): Promise<Record<string, string>> {
  const blob = URL.createObjectURL(new Blob(['self.onfetch = () => {}'], { type: 'text/javascript' }));
  return {
    file: await timed(navigator.serviceWorker.register('sw.js'), 5000),
    blob: await timed(navigator.serviceWorker.register(blob), 5000),
    registrations: String((await navigator.serviceWorker.getRegistrations().catch(() => [])).length)
  };
}

async function listen(names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const handler = internals.transformCallback(() => { heard[name] = (heard[name] ?? 0) + 1; });
    out[name] = await internals.invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler }).then(() => 'listening', e => 'refused:' + String(e));
  }
  return out;
}

async function egress(ctx: Ctx): Promise<{ routes: number; ipcAfter: string; violations: number }> {
  const fx = await fixtures();
  const out = await hostile(ctx, fx, { nav: true });
  for (const [route, o] of Object.entries(out)) await shell.log(`EGRESS ${ctx} ${route} ${JSON.stringify(o)}`);
  // IPC must still work after all of it.
  const ipcAfter = await shell.log(`EGRESS-DONE ${ctx}`).then(() => 'ok', e => 'failed:' + String(e));
  return { routes: Object.keys(out).length, ipcAfter, violations: violations.length };
}

const handlers: Record<string, (args: never) => unknown> = {
  where: () => ({ path: location.pathname, token, role }),
  refusals: (calls: Call[]) => refusals(calls),
  tt: async () => {
    const before = violations.length;
    const sinks = trySinks();
    const ipc = await shell.log(`TT ${role} tried ${Object.keys(sinks).length} sinks`).then(() => 'ok', e => 'failed:' + String(e));
    return { sinks, ipc, violations: violations.slice(before), earlier: violations.slice(0, before) };
  },
  egress: (ctx: Ctx) => egress(ctx),
  listen: (names: string[]) => listen(names),
  heard: () => ({ ...heard }),
  'close-self': () => { setTimeout(() => shell.windowSelf('close').catch(() => {}), 100); return 'closing'; },
  'self-op': (op: 'minimize') => shell.windowSelf(op).then(() => 'ok', e => 'failed:' + JSON.stringify(e)),
  navigate: (to: string) => { setTimeout(() => { location.href = to; }, 100); return 'navigating'; },
  permissions: () => permissions(),
  'service-workers': () => serviceWorkers(),
  'paste-ready': () => { const i = document.getElementById('paste') as HTMLInputElement; i.value = ''; i.focus(); return document.hasFocus(); },
  'paste-value': () => (document.getElementById('paste') as HTMLInputElement).value,
  /* Settings saves what the driver typed into its password field, then clears it. The page never
     returns the value. */
  'save-key': async (ref: string) => {
    const i = document.getElementById('paste') as HTMLInputElement;
    const value = i.value;
    i.value = '';
    return shell.secretSet(ref, value).then(() => 'ok', e => 'failed:' + JSON.stringify(e));
  },
  /* A key made here and written at once, for the removal checks; never returned. */
  'make-key': (ref: string) => shell.secretSet(ref, 'fk' + rand(30)).then(() => 'ok', e => 'failed:' + JSON.stringify(e)),
  /* A key holding a quote, which JSON escapes as \" (step 7's known gap): stored, and only its last ten
     characters returned, so core can search for them without ever holding the key. */
  'make-quoted-key': (ref: string) => {
    const tail = rand(10);
    return shell.secretSet(ref, `fk"${rand(12)}${tail}`).then(() => ({ tail }), e => ({ error: JSON.stringify(e) }));
  },
  'clip-ready': (text: string) => { clip = text; return 'ready'; },
  'clip-result': () => (document.getElementById('clip') as HTMLElement).dataset.result ?? 'no click',
  violations: () => [...violations],
  /* A link the driver clicks for real: the same origin's file, or a blob, each with download set. */
  'dl-ready': (kind: 'same' | 'blob') => {
    const a = document.getElementById('dl') as HTMLAnchorElement;
    a.href = kind === 'same' ? 'tray.png' : URL.createObjectURL(new Blob(['not to be saved'], { type: 'text/plain' }));
    a.download = kind === 'same' ? 'familiar-check-same.png' : 'familiar-check-blob.txt';
    return a.href.slice(0, 5);
  }
};

document.getElementById('clip')?.addEventListener('click', e => {
  const b = e.currentTarget as HTMLElement;
  navigator.clipboard.writeText(clip).then(() => { b.dataset.result = 'written'; }, err => { b.dataset.result = 'rejected:' + said(err); });
});

bus.onmessage = async ({ data: m }) => {
  if (!m || m.to !== role || typeof m.cmd !== 'string') return;
  const h = handlers[m.cmd];
  try {
    if (!h) throw new Error('no such ask: ' + m.cmd);
    bus.postMessage({ reply: m.id, from: role, value: await h(m.args as never) });
  } catch (e) {
    bus.postMessage({ reply: m.id, from: role, error: e instanceof Error ? e.message : String(e) });
  }
};

(async () => {
  for (;;) {
    bus.postMessage({ hello: role, token });
    await sleep(500);
  }
})();
