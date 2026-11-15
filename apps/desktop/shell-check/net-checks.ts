/* The guarded fetch and keys, checked from core with the fake server in net-server.mjs. Every
   address is added through the native confirm, which the driver answers. A key is typed into
   Settings' password field by the driver with real key presses; core never sees it, only a
   probe of its first and last characters to check that nothing it reads holds the key. See
   5a and 5c in docs/shell-design.md. */
import { guardedFetch, PLACEHOLDER } from '../src/net.ts';
import { reason, type Address } from '../src/shell.ts';
import { check, fail, ok, rand, say, shell, sleep, step } from './common.ts';

interface Net { http: number; tls: number; proxy: number; control: number; lanIp: string; lan: number }
interface Typed { sha: string; head: string; tail: string; length: number; last4: string }
type Ctx = { ask: <T>(to: string, cmd: string, args?: unknown) => Promise<T>; up: (role: string) => Promise<unknown> };

const APPROVE = 'Allow', REFUSE = "Don't allow";
const dialog = (act: string) => step<{ found: boolean; answered: string; answeredAt?: number }>('dialog', { act, approve: APPROVE, refuse: REFUSE }, 60000);
/* A public address for planned names. Nothing is ever sent to it: each check moves the name
   before a connection could be made. */
const PUB = '8.8.8.8';
const plan = (name: string, answers: string[][], delay: number[] = []) => step('dns-plan', { name, answers, delay });
const conns = (kind: string, since: number) => step<{ count: number }>('conns', { kind, since }).then(r => r.count);
/* The host a proxy log line names: an absolute URL's, or a CONNECT authority's. */
export function proxyHost(target: string): string {
  if (target.includes('://')) {
    try { return new URL(target).hostname.replace(/^\[|\]$/g, ''); } catch { return target; }
  }
  return target.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}
/* What the logging proxy saw while it was on. */
const proxyOff = () => step<{ targets: string[]; entries: { target: string; at: number }[] }>('proxy', { on: false });
/* shell_info, an async command like every other, timed every 50 ms for `ms`: the longest it took. */
export async function probe(ms: number): Promise<number> {
  const times: number[] = [];
  for (const end = performance.now() + ms; performance.now() < end;) {
    const t = performance.now();
    await shell.info();
    times.push(performance.now() - t);
    await sleep(50);
  }
  return Math.round(Math.max(...times));
}

/* 128 random bits as hex: a request id of the exe's form. */
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const AUTH = { authorization: `Bearer ${PLACEHOLDER}` };
const kindOf = (e: unknown) => (e instanceof Error && typeof e.cause === 'object' && e.cause && 'kind' in e.cause ? String((e.cause as { kind: string }).kind) : e instanceof Error ? e.name : String(e));
const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms} ms`)), ms))]);

/* Adds an address, answering its dialog as told. */
async function added(spec: Parameters<typeof shell.addressAdd>[0], act: 'approve' | 'refuse' | 'none' = 'approve'): Promise<Address | string> {
  const p = shell.addressAdd(spec).then(a => a, e => reason(e));
  const d = await dialog(act);
  const r = await within(p, 45000, 'address_add');
  if (act !== 'none' && !d.found) fail('no dialog for ' + spec.url);
  return r;
}
async function saved(spec: Parameters<typeof shell.addressAdd>[0]): Promise<Address> {
  const r = await added(spec);
  if (typeof r === 'string') fail(`${spec.url} wasn't saved: ${r}`);
  return r as Address;
}

export async function netChecks(ctx: Ctx) {
  const net = (await (await fetch('net.json', { cache: 'no-store' })).json()) as Net;
  const base = `http://127.0.0.1:${net.http}`;
  const text = async (r: Response) => r.text();
  const outcome = (p: Promise<unknown>) => within(p.then(() => 'ok', e => kindOf(e)), 60000, 'fetch');
  /* Reads a body through its stream, which keeps the exe's kind on the error: a stream error seen
     through text() or json() reaches the page as a plain TypeError, without its cause. */
  const drain = async (r: Response) => {
    const reader = r.body!.getReader();
    for (;;) if ((await reader.read()).done) return;
  };

  /* ---------- saved addresses only ---------- */
  let A: Address | undefined;
  await check('security.fetch.saved-only', async () => {
    const unknown = await outcome(guardedFetch('f'.repeat(32))(`${base}/api/ok`));
    A = await saved({ kind: 'server', url: `${base}/api`, label: 'key holder' });
    const f = guardedFetch(A.id);
    const okBody = await text(await f(`${base}/api/ok`));
    const outside = await outcome(f(`${base}/other/ok`));
    const dots = await outcome(f(`${base}/api/%2e%2e/other`));
    const declined = await added({ kind: 'server', url: `${base}/declined`, label: 'declined' }, 'refuse');
    const list = (await shell.addressList()).map(a => a.url);
    // A peer's identity is its whole range: a wider range asks again and gets its own id.
    const p1 = await saved({ kind: 'peer', url: 'ws://127.0.0.1', label: 'A check peer', ports: [47110, 47114] });
    const p1again = await shell.addressAdd({ kind: 'peer', url: 'ws://127.0.0.1', label: 'A check peer', ports: [47110, 47114] });
    const p2 = await saved({ kind: 'peer', url: 'ws://127.0.0.1', label: 'A check peer', ports: [47110, 47115] });
    const peerFetch = await outcome(guardedFetch(p1.id)('ws://127.0.0.1:47110/x'));
    ok(unknown === 'not-saved', 'an unknown address: ' + unknown);
    ok(okBody === 'ok', 'the saved address: ' + okBody);
    ok(outside === 'not-saved' && dots === 'not-saved', `outside ${outside}, encoded dots ${dots}`);
    ok(typeof declined === 'string' && declined.startsWith('declined') && !list.includes(`${base}/declined`), 'declined: ' + declined);
    ok(p1again.id === p1.id && p2.id !== p1.id, 'peer ranges: same range same id, wider range new id');
    ok(peerFetch === 'not-saved', 'a peer through the fetch: ' + peerFetch);
    return 'unknown and outside addresses not-saved; Allow saves, Don\'t allow doesn\'t; a peer\'s wider range is a new address';
  });

  /* ---------- no lookup before Allow ---------- */
  await check('check.fetch.no-lookup-flow', async () => {
    const label = () => rand(14);
    const url = (l: string) => `https://${l}.familiar-check.test/v1`;
    // A lookup the driver makes, just before and just after: both must be seen, or the witnesses
    // didn't cover the window.
    const canary = async () => {
      const l = 'c' + rand(13);
      await step('dns-canary', { label: l });
      await say(`NETLOOKUP canary ${l}`);
    };
    const [l1, l2, l3, l4] = [label(), label(), label(), label()];
    await canary();
    // One over TCP, which the capture must see reassembled.
    const tcp = 't' + rand(13);
    await step('dns-canary', { label: tcp, tcp: true });
    await say(`NETLOOKUP tcp-canary ${tcp}`);
    const from = Date.now();
    const r1 = await added({ kind: 'model', url: url(l1), label: 'never 1' }, 'refuse');
    const r2 = await added({ kind: 'model', url: url(l2), label: 'never 2' }, 'refuse');
    const r3 = await added({ kind: 'model', url: url(l3), label: 'never 3' }, 'none');
    const tray = await step<{ done: boolean; how: string }>('tray-ask-again');
    // The allowed name's dialog is held open 3 s before Allow, so a lookup made while it shows
    // would be seen before the moment the driver pressed it.
    const p4 = shell.addressAdd({ kind: 'model', url: url(l4), label: 'after' }).then(a => a, e => reason(e));
    const held = await dialog('hold');
    await sleep(3000);
    const allowed = await dialog('approve');
    const r4 = await within(p4, 45000, 'address_add');
    const to = Date.now();
    await canary();
    for (const l of [l1, l2, l3]) await say(`NETLOOKUP never ${l}`);
    // The boundary is the exe's own log line for when its dialog returned, before this one.
    await say(`NETLOOKUP after ${l4}`);
    await say(`NETLOOKUP window ${from} ${to}`);
    ok(String(r1).startsWith('declined') && String(r2).startsWith('declined'), `refused: ${r1}, ${r2}`);
    ok(String(r3).startsWith('asks-stopped'), 'the fourth ask: ' + r3);
    ok(tray.done, 'the tray item: ' + tray.how);
    ok(held.found && allowed.found && (allowed.answeredAt ?? 0) > from, 'the allowed dialog: ' + JSON.stringify({ held, allowed }));
    ok(String(r4).startsWith('blocked-address'), 'after Allow, a name with no answers: ' + JSON.stringify(r4));
    await say('NETLOOKUP flow ok');
    return 'two refused and one stopped ask, then one held open 3 s and allowed, between two canaries and with one over TCP; the capture decides security.fetch.no-lookup-before-allow';
  });

  /* ---------- keys ---------- */
  let typed: Typed | undefined;
  const probeClean = (texts: string[]) => texts.every(t => !t.includes(typed!.head) && !t.includes(typed!.tail));
  async function typeKey(ref: string, long: boolean): Promise<Typed> {
    await ctx.ask('settings', 'paste-ready');
    const t = await step<Typed>('type-key', { title: 'Familiar check settings', long, ref });
    const saidSettings = await ctx.ask<string>('settings', 'save-key', ref);
    ok(saidSettings === 'ok', 'Settings could not save the key: ' + saidSettings);
    return t;
  }
  let A2: Address | undefined;
  await check('security.key.roundtrip', async () => {
    if (!A) fail('no saved address');
    typed = await typeKey(`addr:${A!.id}`, true);
    const st = await shell.secretStatus(`addr:${A!.id}`);
    const cm = await step<{ found: boolean }>('cmdkey', { target: `addr:${A!.id}` });
    const hash = await text(await guardedFetch(A!.id)(`${base}/api/key-hash`, { headers: AUTH }));
    A2 = await saved({ kind: 'server', url: `${base}/api2`, label: 'short key' });
    const short = await typeKey(`addr:${A2.id}`, false);
    const st2 = await shell.secretStatus(`addr:${A2.id}`);
    ok(st.present && st.boundTo === A!.id && st.hint === `…${typed.last4}`, 'status: ' + JSON.stringify(st));
    ok(Object.keys(st).sort().join() === 'boundTo,hint,present', 'secret_status says more than it should: ' + Object.keys(st).join());
    ok(cm.found, 'the credential is not in cmdkey /list');
    ok(hash === typed.sha, 'the fake server got another authorization header');
    ok(st2.present && st2.hint === null && short.length < 20, 'a short key: ' + JSON.stringify(st2));
    return `typed into Settings by real key presses, stored, bound to its address, hint for ${typed.length} chars and none for ${short.length}; the server got exactly the key`;
  });

  await check('security.key.bound', async () => {
    if (!A || !A2) fail('no saved addresses');
    const hashA2 = await text(await guardedFetch(A2!.id)(`${base}/api2/key-hash`, { headers: AUTH }));
    const A3 = await saved({ kind: 'server', url: `${base}/api3`, label: 'no key' });
    const none = await outcome(guardedFetch(A3.id)(`${base}/api3/key-hash`, { headers: AUTH }));
    const st3 = await shell.secretStatus(`addr:${A3.id}`);
    const elsewhere = await outcome(guardedFetch(A!.id)(`${base}/api3/key-hash`, { headers: AUTH }));
    ok(hashA2 !== typed!.sha, "A2's request carried A's key");
    ok(none === 'no-key' && !st3.present, `an address with no key: ${none}, ${JSON.stringify(st3)}`);
    ok(elsewhere === 'not-saved', "A's key toward another address: " + elsewhere);
    return 'each address gets only its own key; no key is no-key; a key never goes outside its address';
  });

  await check('security.key.echo', async () => {
    if (!A) fail('no saved address');
    const f = guardedFetch(A!.id);
    const seen: string[] = [];
    const value = await f(`${base}/api/echo/header-value`, { headers: AUTH });
    seen.push(value.headers.get('x-echo') ?? '', await value.text());
    const name = await f(`${base}/api/echo/header-name`, { headers: AUTH });
    const names = [...name.headers.keys()];
    seen.push(...names, await name.text());
    const status = await f(`${base}/api/echo/status`, { headers: AUTH });
    seen.push(status.statusText, await status.text());
    const b200 = await text(await f(`${base}/api/echo/body200`, { headers: AUTH }));
    const r401 = await f(`${base}/api/echo/body401`, { headers: AUTH });
    const b401 = await r401.text();
    const big = await text(await f(`${base}/api/echo/big`, { headers: AUTH }));
    const split = await text(await f(`${base}/api/echo/split`, { headers: AUTH }));
    // The server answers with the key the address's last request carried; this one carries none.
    const remembered = await text(await f(`${base}/api/echo/remembered`));
    seen.push(b200, b401, big, split, remembered);
    const redirect = await outcome(f(`${base}/api/echo/redirect`, { headers: AUTH }));
    const toKey = await step<{ count: number }>('net-requests', { path: `/api/${typed!.head}` });
    ok(probeClean(seen), 'a response field held the key');
    ok((value.headers.get('x-echo') ?? '').includes('[key]'), 'header value: ' + value.headers.get('x-echo'));
    ok(!names.some(n => n.startsWith('x-k-')), 'a header named with the key reached the page');
    ok(b200 === 'before [key] after' && b401 === 'denied [key]' && r401.status === 401, `bodies: ${b200} / ${b401}`);
    ok(big.split('[key]').length === 5 && big.length > 300 * 1024, 'the 300 KB body: ' + big.split('[key]').length);
    ok(split === 'a [key] b', 'split across chunks: ' + split);
    ok(remembered === 'remembered [key]', 'a request without the key, answered with it: ' + (probeClean([remembered]) ? remembered : 'the key itself'));
    ok(redirect === 'redirect-refused' && toKey.count === 0, `redirect to the key's path: ${redirect}, server saw ${toKey.count}`);
    return `the key came back as [key] in a header value, both bodies, 300 KB and split across chunks, and in a reply to a request that didn't carry it; a header named with it was dropped; the status line shows ${JSON.stringify(status.statusText)}; a redirect to it was refused and never followed`;
  });

  /* ---------- streams, stops, limits, redirects ---------- */
  const openNow = () => step<{ open: number }>('net-open').then(r => r.open);
  await check('security.fetch.stream-stop', async () => {
    const f = guardedFetch(A!.id);
    const whole = (await text(await f(`${base}/api/stream40`))).split('\n').filter(Boolean).length;
    const c = new AbortController();
    const r = await f(`${base}/api/stream40`, { signal: c.signal });
    const reader = r.body!.getReader();
    for (let i = 0; i < 3; i++) await reader.read();
    const t0 = performance.now();
    c.abort();
    const stopped = await reader.read().then(() => 'read on', e => (e as Error).name);
    const ms = Math.round(performance.now() - t0);
    await sleep(1000);
    const openAfterStop = await openNow();
    const c2 = new AbortController();
    const early = guardedFetch(A!.id)(`${base}/api/slow-head`, { signal: c2.signal });
    await sleep(300);
    c2.abort();
    const beforeHead = await early.then(() => 'answered', e => (e as Error).name);
    await sleep(1000);
    const openAfterEarly = await openNow();
    // A stop while the exe is still looking the name up, before anything is sent. The logging
    // proxy is on, so a request that went on after its lookup would show there.
    const slow = `slow${rand(10)}.familiar-check.test`;
    await plan(slow, [[PUB]], [0, 4000]);
    const S = await saved({ kind: 'model', url: `https://${slow}`, label: 'a slow name' });
    await step('proxy', { on: true });
    const c3 = new AbortController();
    const preparing = guardedFetch(S.id)(`https://${slow}/v1`, { signal: c3.signal });
    await sleep(500);
    c3.abort();
    const duringLookup = await preparing.then(() => 'answered', e => (e as Error).name);
    await sleep(5000);
    const sent = (await proxyOff()).targets.filter(t => proxyHost(t) === slow).length;
    ok(whole === 40, `${whole} of 40 chunks`);
    ok(duringLookup === 'AbortError' && sent === 0, `a stop during the lookup: ${duringLookup}, and the proxy saw ${sent} requests for the name`);
    ok(stopped === 'AbortError' && ms <= 100, `a stop after chunk 3: ${stopped} in ${ms} ms`);
    ok(beforeHead === 'AbortError', 'a stop before the head: ' + beforeHead);
    ok(openAfterStop === 0 && openAfterEarly === 0, `the server still had ${openAfterStop} and ${openAfterEarly} open`);
    return `40 chunks whole; a stop after chunk 3 rejected in ${ms} ms; a stop before the head rejected; the server saw both connections close; a stop during a 4 s lookup rejected and nothing was sent once the lookup ended`;
  });

  await check('security.fetch.revoke', async () => {
    const B = await saved({ kind: 'server', url: `${base}/rv`, label: 'revoked' });
    const r = await guardedFetch(B.id)(`${base}/rv/stream40`);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.read();
    await shell.addressRemove(B.id);
    const after = await reader.read().then(x => (x.done ? 'ended' : 'read on'), e => kindOf(e));
    const next = await outcome(guardedFetch(B.id)(`${base}/rv/ok`));
    await sleep(1000);
    const open = await openNow();
    // A removal while the exe is still looking the name up, through the logging proxy.
    const slow = `slow${rand(10)}.familiar-check.test`;
    await plan(slow, [[PUB]], [0, 4000]);
    const R = await saved({ kind: 'model', url: `https://${slow}`, label: 'removed while looking up' });
    await step('proxy', { on: true });
    const preparing = outcome(guardedFetch(R.id)(`https://${slow}/v1`));
    await sleep(500);
    const t0 = performance.now();
    await shell.addressRemove(R.id);
    const duringLookup = await preparing;
    const ms = Math.round(performance.now() - t0);
    await sleep(5000);
    const sent = (await proxyOff()).targets.filter(t => proxyHost(t) === slow).length;
    ok(duringLookup === 'revoked' && ms < 1500 && sent === 0, `a removal during the lookup: ${duringLookup} in ${ms} ms, and the proxy saw ${sent} requests for the name`);
    ok(after === 'revoked', 'a read after removal: ' + after);
    ok(next === 'not-saved', 'a fetch after removal: ' + next);
    ok(open === 0, `the server still had ${open} open`);
    return `removing an address mid-stream ended the read as revoked, closed the connection, and the next fetch is not-saved; a removal during a 4 s lookup ended the fetch as revoked in ${ms} ms and nothing was sent`;
  });

  await check('security.fetch.live-stream', async () => {
    const c = new AbortController();
    const r = await guardedFetch(A!.id)(`${base}/api/sse`, { signal: c.signal });
    const t0 = performance.now();
    const reader = r.body!.getReader();
    const first = await reader.read();
    const ms = Math.round(performance.now() - t0);
    const quiet = await Promise.race([reader.read().then(x => (x.done ? 'ended early' : 'more came')), sleep(30000).then(() => 'still open')]);
    c.abort();
    const event = new TextDecoder().decode(first.value);
    ok(event === 'data: hello\n\n', 'the event: ' + JSON.stringify(event));
    ok(ms <= 100, `the event took ${ms} ms after the head`);
    ok(quiet === 'still open', 'over 30 quiet seconds the read ' + quiet);
    return `one SSE event in ${ms} ms, then the read stayed open through 30 quiet seconds`;
  });

  await check('security.exec.responsive', async () => {
    // shell_info is async, so it's answered where every command runs; it's timed while each kind
    // of flood is really held. A control build whose helpers block those threads must fail this
    // (check.exec.responsive-control, in its own phase).
    // Open fetches at their limit, each waiting 5 s for its head, all open at the server.
    const cs = Array.from({ length: 32 }, () => new AbortController());
    const open = cs.map(c => guardedFetch(A!.id)(`${base}/api/slow-head`, { signal: c.signal }).catch(() => {}));
    await sleep(500);
    const inFlight = await openNow();
    const over = await outcome(guardedFetch(A!.id)(`${base}/api/ok`));
    const atLimit = await probe(2000);
    cs.forEach(c => c.abort());
    await Promise.all(open);
    // A lookup that stalls for 8 s.
    const n = `st${rand(10)}.familiar-check.test`;
    await plan(n, [[PUB]], [0, 8000]);
    const S = await saved({ kind: 'model', url: `https://${n}`, label: 'a stalled lookup' });
    const c2 = new AbortController();
    const stalled = guardedFetch(S.id)(`https://${n}/v1`, { signal: c2.signal }).catch(() => {});
    await sleep(500);
    const asking = (await step<{ count: number }>('dns-queries', { name: n })).count;
    const inLookup = await probe(2000);
    c2.abort();
    await stalled;
    // An open confirm dialog.
    const asked = shell.addressAdd({ kind: 'server', url: `${base}/held-open`, label: 'held open' }).then(() => 'saved', reason);
    const [held, inDialog] = await Promise.all([dialog('hold'), sleep(400).then(() => probe(1200))]);
    await dialog('approve');
    const saidYes = await within(asked, 45000, 'address_add');
    ok(over === 'busy' && inFlight >= 32, `a fetch past the limit: ${over}; the server held ${inFlight} open`);
    ok(asking >= 2, `the stalled lookup had reached the DNS server ${asking} times`);
    ok(held.found && saidYes === 'saved', `the dialog: ${held.found}, ${saidYes}`);
    ok(atLimit < 100 && inLookup < 100 && inDialog < 100, `shell_info took up to ${atLimit} ms with 32 fetches open, ${inLookup} ms in a stalled lookup, ${inDialog} ms behind a dialog`);
    return `shell_info answered in at most ${atLimit} ms with 32 fetches open (the 33rd busy), ${inLookup} ms during an 8 s lookup, ${inDialog} ms behind an open dialog`;
  });

  await check('security.fetch.limits', async () => {
    const head = await outcome(guardedFetch(A!.id, { headersMs: 1000 })(`${base}/api/slow-head`));
    const idle = await outcome(guardedFetch(A!.id, { idleMs: 1000 })(`${base}/api/slow-body`).then(drain));
    const big = await outcome(guardedFetch(A!.id, { maxBytes: 1024 * 1024 })(`${base}/api/big`).then(drain));
    const bomb = await outcome(guardedFetch(A!.id)(`${base}/api/gzip-bomb`).then(drain));
    const viaText = await outcome(guardedFetch(A!.id, { maxBytes: 1024 * 1024 })(`${base}/api/big`).then(text));
    ok(head === 'timeout' && idle === 'timeout' && big === 'too-large' && bomb === 'too-large', JSON.stringify({ head, idle, big, bomb }));
    return `headersMs and idleMs time out; a body past maxBytes and a gzip bomb are too-large (through text() the same error reads as ${viaText})`;
  });

  await check('security.fetch.redirects', async () => {
    const f = guardedFetch(A!.id);
    const r = await f(`${base}/api/redir-in`);
    const inside = `${r.redirected} ${await r.text()}`;
    const path = await outcome(f(`${base}/api/redir-path`));
    const host = await outcome(f(`${base}/api/redir-host`));
    const https = await outcome(f(`${base}/api/redir-https`));
    ok(inside === 'true ok', 'inside: ' + inside);
    ok(path === 'redirect-refused' && host === 'redirect-refused' && https === 'redirect-refused', JSON.stringify({ path, host, https }));
    return 'a redirect inside the address followed; to another path, another host and https refused';
  });

  await check('security.fetch.literal', async () => {
    const mapped = await saved({ kind: 'server', url: `http://[::ffff:127.0.0.1]:${net.http}/lit`, label: 'mapped' });
    const insecure = await shell.addressAdd({ kind: 'server', url: 'http://8.8.8.8/x', label: 'x' }).then(() => 'saved', reason);
    const metadata = await shell.addressAdd({ kind: 'server', url: 'http://169.254.169.254/latest', label: 'x' }).then(() => 'saved', reason);
    ok(mapped.reach === 'loopback', 'the mapped address: ' + JSON.stringify(mapped));
    ok(insecure.startsWith('insecure') && metadata.startsWith('blocked-address'), `${insecure}; ${metadata}`);
    return `[::ffff:127.0.0.1] saved as loopback (${mapped.url}); http to a public IP insecure; 169.254.169.254 never saved`;
  });

  /* ---------- names, DNS, the proxy and TLS ---------- */
  let publicSite: Address | undefined;
  await check('check.tls.roots', async () => {
    publicSite = await saved({ kind: 'model', url: 'https://example.com', label: 'a public host' });
    const pub = await outcome(guardedFetch(publicSite.id, { headersMs: 15000 })('https://example.com/'));
    const self = await saved({ kind: 'server', url: `https://127.0.0.1:${net.tls}/api`, label: 'self-signed' });
    const local = await outcome(guardedFetch(self.id)(`https://127.0.0.1:${net.tls}/api/ok`));
    ok(pub === 'ok', 'a public https host: ' + pub);
    ok(local === 'tls', 'a self-signed local https server: ' + local);
    return `a public https host works through the platform verifier; a self-signed local one is refused as tls`;
  });

  await check('security.fetch.rebinding', async () => {
    const { lanIp, lan: port } = net;
    if (!lanIp || !port) fail('no lan fixture');
    // The check's DNS server answers each name's nth lookup as planned. The lan fixture listens on
    // the runner's own private address, and on the same port on 127.0.0.1 a listener nothing may
    // reach.
    const name = (p: string) => `${p}${rand(10)}.familiar-check.test`;
    const queries = (n: string) => step<{ count: number; queries: { n: number; answered: string }[] }>('dns-queries', { name: n });
    const mark = Date.now();
    // The fixture is reachable by name, so a refusal below is the resolver's and not a dead port.
    const n0 = name('rbok');
    await plan(n0, [[lanIp]]);
    const s0 = await saved({ kind: 'server', url: `http://${n0}:${port}/v1`, label: 'the lan fixture by name' });
    const r0 = await outcome(guardedFetch(s0.id)(`http://${n0}:${port}/v1/ok`));
    const lan0 = await conns('lan', mark);
    // Public when saved and when checked before sending, loopback when connecting.
    const n1 = name('rbpub');
    await plan(n1, [[PUB], [PUB], ['127.0.0.1']]);
    const s1 = await saved({ kind: 'model', url: `https://${n1}:${port}`, label: 'public, then loopback' });
    const r1 = await outcome(guardedFetch(s1.id, { headersMs: 5000 })(`https://${n1}:${port}/v1`));
    const q1 = await queries(n1);
    // Lan when saved, loopback when connecting.
    const n2 = name('rblan');
    await plan(n2, [[lanIp], ['127.0.0.1']]);
    const s2 = await saved({ kind: 'server', url: `http://${n2}:${port}/v1`, label: 'lan, then loopback' });
    const m2 = Date.now();
    const r2 = await outcome(guardedFetch(s2.id)(`http://${n2}:${port}/v1/ok`));
    const lan2 = await conns('lan', m2);
    // Lan for the first hop, loopback after a redirect on a connection that closed.
    const n3 = name('rbhop');
    await plan(n3, [[lanIp], [lanIp], ['127.0.0.1']]);
    const s3 = await saved({ kind: 'server', url: `http://${n3}:${port}/v1`, label: 'lan, then loopback after a redirect' });
    const m3 = Date.now();
    const r3 = await outcome(guardedFetch(s3.id)(`http://${n3}:${port}/v1/redir-close`));
    const lan3 = await conns('lan', m3);
    // Lan and loopback in one answer: the whole answer is refused, not filtered.
    const n4 = name('rbmix');
    await plan(n4, [[lanIp], [lanIp, '127.0.0.1']]);
    const s4 = await saved({ kind: 'server', url: `http://${n4}:${port}/v1`, label: 'lan and loopback at once' });
    const m4 = Date.now();
    const r4 = await outcome(guardedFetch(s4.id)(`http://${n4}:${port}/v1/ok`));
    const lan4 = await conns('lan', m4);
    const forbidden = await conns('forbidden', mark);
    const third = q1.queries.find(q => q.n === 3)?.answered;
    ok(r0 === 'ok' && lan0 >= 1, `the lan fixture by name: ${r0}, ${lan0} connections`);
    ok(s1.reach === 'public' && [s2, s3, s4].every(x => x.reach === 'lan'), 'saved as ' + [s1, s2, s3, s4].map(x => x.reach).join(' '));
    ok(r1 === 'blocked-address' && third === '127.0.0.1', `public then loopback at connect: ${r1}; lookups ${q1.queries.map(q => `${q.n}:${q.answered}`).join(' ')}`);
    ok(r2 === 'blocked-address' && lan2 === 0, `lan then loopback at connect: ${r2}, ${lan2} lan connections`);
    ok(r3 === 'blocked-address' && lan3 === 1, `loopback after a redirect: ${r3}, ${lan3} lan connections`);
    ok(r4 === 'blocked-address' && lan4 === 0, `a mixed answer: ${r4}, ${lan4} lan connections`);
    ok(forbidden === 0, `the loopback listener saw ${forbidden} connections`);
    return `planned answers from the check's DNS server: public then loopback at connect (lookups ${q1.queries.map(q => `${q.n}:${q.answered}`).join(' ')}), lan then loopback, loopback after a redirect, and a lan+loopback answer were all blocked-address; the loopback listener on the same port saw nothing; the lan fixture by name answered`;
  });

  await check('security.fetch.proxy', async () => {
    if (!publicSite || !A) fail('no addresses');
    const lan = await saved({ kind: 'server', url: `http://${net.lanIp}:${net.lan}/pl`, label: 'the lan fixture' });
    const offBefore = await shell.netProxy();
    const runner = await step<{ kind: string }>('proxy-kind');
    await step('proxy', { on: true });
    const on = await shell.netProxy();
    const mark = Date.now();
    const pub = await outcome(guardedFetch(publicSite!.id, { headersMs: 15000 })('https://example.com/'));
    const loop = await outcome(guardedFetch(A!.id)(`${base}/api/ok`));
    const lanR = await outcome(guardedFetch(lan.id)(`http://${net.lanIp}:${net.lan}/pl/ok`));
    const lanConns = await conns('lan', mark);
    const seen = await proxyOff();
    const off = await shell.netProxy();
    const hosts = seen.targets.map(proxyHost);
    const local = hosts.filter(h => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === net.lanIp);
    ok(hosts.includes('example.com'), 'the public address did not use the proxy: ' + seen.targets.join(' '));
    ok(local.length === 0, 'a local address went through the proxy: ' + seen.targets.join(' '));
    ok(pub === 'ok' && loop === 'ok' && lanR === 'ok' && lanConns >= 1, `public ${pub}, loopback ${loop}, lan ${lanR} with ${lanConns} connections at the fixture`);
    ok(on.kind === 'manual' && on.inUse, 'net_proxy with the proxy set: ' + JSON.stringify(on));
    ok(off.kind === runner.kind && offBefore.kind === runner.kind && !off.inUse && off.kind !== 'manual', `net_proxy without it: ${JSON.stringify(off)}, the registry says ${runner.kind}`);
    return `public through the system proxy (${seen.targets.join(' ')}); loopback and the lan fixture direct, the fixture saw ${lanConns} connections; net_proxy ${JSON.stringify(on)} with it set, ${JSON.stringify(off)} without (the runner's own setting: ${runner.kind})`;
  });

  await check('security.fetch.cancel-race', async () => {
    // A cancel sent at many points around registration: from 5 ms before the fetch to 14 ms
    // after. With the logging proxy on, nothing may reach it once a cancel has returned.
    const n = `cr${rand(10)}.familiar-check.test`;
    await plan(n, [[PUB]]);
    const C = await saved({ kind: 'model', url: `https://${n}`, label: 'cancel race' });
    await step('proxy', { on: true });
    const tries: { offset: number; outcome: string; cancelled: number; next: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const offset = i - 5;
      const id = requestId();
      const fetchIt = () => shell.netFetch({ id, address: C.id, url: `https://${n}/v1`, method: 'GET', headers: [] }, new Uint8Array(0)).then(() => 'answered', e => (e as { kind?: string }).kind ?? reason(e));
      let fetched: Promise<string>;
      let cancel: Promise<void>;
      if (offset < 0) {
        cancel = shell.netCancel(id);
        await sleep(-offset);
        fetched = fetchIt();
      } else {
        fetched = fetchIt();
        if (offset) await sleep(offset);
        cancel = shell.netCancel(id);
      }
      await cancel;
      const cancelled = Date.now();
      const outcome = await within(fetched, 30000, 'net_fetch');
      await sleep(300);
      tries.push({ offset, outcome, cancelled, next: Date.now() });
    }
    // Five more held just before sending: their lookup answers 1.5 s late, and each is cancelled
    // while it waits. Nothing of them may reach the proxy, then or once the lookup has answered.
    const h = `ch${rand(10)}.familiar-check.test`;
    await plan(h, [[PUB]], [0, 1500]);
    const H = await saved({ kind: 'model', url: `https://${h}`, label: 'held before sending' });
    const heldOutcomes: string[] = [];
    const heldWindows: [number, number][] = [];
    for (let i = 0; i < 5; i++) {
      const id = requestId();
      const fetched = shell.netFetch({ id, address: H.id, url: `https://${h}/v1`, method: 'GET', headers: [] }, new Uint8Array(0)).then(() => 'answered', e => (e as { kind?: string }).kind ?? reason(e));
      await sleep(300);
      await shell.netCancel(id);
      const returned = Date.now();
      heldOutcomes.push(await within(fetched, 30000, 'net_fetch'));
      await sleep(1500);
      heldWindows.push([returned, Date.now()]);
    }
    // The lookup was under way when each cancel came: the cancel returns only once it's over, so
    // the check's DNS server sees no query for the name after a cancel returned.
    const hq = (await step<{ queries: { at: number }[] }>('dns-queries', { name: h, all: true })).queries;
    const lateLookups = hq.filter(q => heldWindows.some(([from, to]) => q.at > from && q.at <= to)).length;
    await sleep(1000);
    const seen = await proxyOff();
    const mine = seen.entries.filter(e => proxyHost(e.target) === n);
    const heldSeen = seen.entries.filter(e => proxyHost(e.target) === h).length;
    const late = tries.filter(t => mine.some(e => e.at > t.cancelled && e.at <= t.next));
    const counts = Object.entries(tries.reduce<Record<string, number>>((m, t) => ({ ...m, [t.outcome]: (m[t.outcome] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');
    ok(late.length === 0, `the proxy saw a request after its cancel returned, at offsets ${late.map(t => t.offset).join(' ')}`);
    ok(tries.filter(t => t.offset < 0).every(t => t.outcome === 'cancelled'), 'a cancel before the fetch: ' + tries.filter(t => t.offset < 0).map(t => t.outcome).join(' '));
    ok(tries.every(t => t.outcome !== 'answered'), 'a cancelled fetch answered');
    ok(heldSeen === 0 && heldOutcomes.every(o => o === 'cancelled'), `held before sending: ${heldOutcomes.join(' ')}, and the proxy saw ${heldSeen}`);
    ok(lateLookups === 0, `the DNS server saw ${lateLookups} queries for the held name after a cancel returned`);
    return `20 cancels from 5 ms before the fetch to 14 ms after: ${counts}; the proxy saw ${mine.length} requests for the name, none after its cancel returned; 5 requests held in their lookup and cancelled ended cancelled with nothing reaching the proxy, before or after the lookup answered, and no query at the DNS server after their cancels returned (${hq.length} in all)`;
  });

  /* ---------- the key goes with its address ---------- */
  await check('security.key.rebind', async () => {
    if (!A) fail('no saved address');
    const before = await step<{ found: boolean }>('cmdkey', { target: `addr:${A!.id}` });
    const mark = Date.now();
    await shell.addressRemove(A!.id);
    const gone = await step<{ found: boolean }>('cmdkey', { target: `addr:${A!.id}` });
    const moved = await saved({ kind: 'server', url: `${base}/api-v2`, label: 'key holder, moved' });
    const st = await shell.secretStatus(`addr:${moved.id}`);
    const r = await outcome(guardedFetch(moved.id)(`${base}/api-v2/key-hash`, { headers: AUTH }));
    const old = await step<{ count: number }>('net-requests', { path: '/api/', since: mark });
    ok(before.found && !gone.found, `the credential before ${before.found}, after removal ${gone.found}`);
    ok(!st.present && r === 'no-key', `the new address: ${JSON.stringify(st)}, fetch ${r}`);
    ok(old.count === 0, `the old address got ${old.count} requests after removal`);
    return 'removing the address deleted its credential; the new base URL has no key and its fetch is no-key; the old address got nothing more';
  });

  await check('security.key.remove-failed', async () => {
    const info = await shell.info();
    const data = info.args[info.args.indexOf('--data-dir') + 1];
    const R = await saved({ kind: 'server', url: `${base}/rr`, label: 'a removal that fails' });
    const made = await ctx.ask<string>('settings', 'make-key', `addr:${R.id}`);
    // The server now holds the key, and answers /echo/remembered with it.
    const sent = await outcome(guardedFetch(R.id)(`${base}/rr/key-hash`, { headers: AUTH }));
    // The shell folder can't be written, so the list without the address can't be saved.
    await step('shell-lock', { data, on: true });
    const first = await shell.addressRemove(R.id).then(() => 'removed', reason);
    const listed = (await shell.addressList()).some(a => a.id === R.id);
    const remembered = await outcome(guardedFetch(R.id)(`${base}/rr/echo/remembered`));
    const withKey = await outcome(guardedFetch(R.id)(`${base}/rr/key-hash`, { headers: AUTH }));
    const write = await ctx.ask<string>('settings', 'make-key', `addr:${R.id}`);
    const st = await shell.secretStatus(`addr:${R.id}`);
    const cm = await step<{ found: boolean }>('cmdkey', { target: `addr:${R.id}` });
    await step('shell-lock', { data, on: false });
    const second = await shell.addressRemove(R.id).then(() => 'removed', reason);
    const after = (await shell.addressList()).some(a => a.id === R.id);
    const gone = await outcome(guardedFetch(R.id)(`${base}/rr/ok`));
    ok(made === 'ok' && sent === 'ok', `the key: ${made}, sent ${sent}`);
    ok(first.startsWith('failed') && listed, `a removal that couldn't save: ${first}, still listed ${listed}`);
    ok(remembered === 'revoked' && withKey === 'revoked', `while it's failed: a keyless request answered with the old key ${remembered}, one with the key ${withKey}`);
    ok(write.includes('revoked'), 'a key write while it failed: ' + write);
    // Nothing irreversible came before the durable mark, so the key is still there.
    ok(st.present && cm.found, `its key, before anything was marked: status ${JSON.stringify(st)}, cmdkey ${cm.found}`);
    const cmAfter = await step<{ found: boolean }>('cmdkey', { target: `addr:${R.id}` });
    ok(second === 'removed' && !after && gone === 'not-saved' && !cmAfter.found, `the retry: ${second}, still listed ${after}, a fetch after it ${gone}, key left ${cmAfter.found}`);
    return `with the list unwritable the removal failed before anything irreversible (${first}): the address stayed listed with its key, refusing everything (a keyless request to the endpoint holding the key ${remembered}, with the key ${withKey}, a key write refused); the retry removed it and its key, and the next fetch is ${gone}`;
  });

  await check('check.key.remove-race', async () => {
    // A key written from Settings while core removes the address, ten times, the removal sent from
    // 4 ms before the write to 5 ms after: the key must never outlive its address.
    const seen: string[] = [];
    let orphans = 0;
    for (let i = 0; i < 10; i++) {
      const K = await saved({ kind: 'server', url: `${base}/race${i}`, label: 'key race' });
      const offset = i - 4;
      const write = () => ctx.ask<string>('settings', 'make-key', `addr:${K.id}`);
      const remove = () => shell.addressRemove(K.id).then(() => 'removed', reason);
      let set: Promise<string>, removal: Promise<string>;
      if (offset < 0) {
        removal = remove();
        await sleep(-offset);
        set = write();
      } else {
        set = write();
        if (offset) await sleep(offset);
        removal = remove();
      }
      const [s, rm] = await Promise.all([set, removal]);
      const cm = await step<{ found: boolean }>('cmdkey', { target: `addr:${K.id}` });
      if (cm.found) orphans++;
      seen.push(`${s === 'ok' ? 'written' : 'refused'}+${rm === 'removed' ? 'removed' : rm}`);
    }
    const counts = Object.entries(seen.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');
    ok(orphans === 0, `${orphans} keys outlived their address (${counts})`);
    ok(seen.every(x => x.endsWith('+removed')), 'a removal failed: ' + seen.join(' '));
    return `ten races of a key write against its address's removal: ${counts}; no key left behind`;
  });

  await check('security.key.write-only', async () => {
    const view = await ctx.ask<Record<string, string>>('chat', 'refusals', [['secret_status', { id: 'addr:x' }], ['secret_set', { id: 'addr:x', value: 'x'.repeat(12) }], ['secret_delete', { id: 'addr:x' }], ['secret_get', { id: 'addr:x' }]]);
    const settings = await ctx.ask<Record<string, string>>('settings', 'refusals', [['secret_get', { id: 'addr:x' }], ['secret_delete', { id: 'addr:x' }]]);
    const core = await shell.secretStatus(`addr:${A2!.id}`);
    ok(Object.values(view).every(v => v === 'acl') && Object.values(settings).every(v => v === 'acl'), JSON.stringify({ view, settings }));
    ok(Object.keys(core).sort().join() === 'boundTo,hint,present' && core.hint === null, 'status: ' + JSON.stringify(core));
    return 'no command reads a key; a view reaches no key command; Settings can\'t delete; status shows present, binding and a hint only';
  });
  // An address whose removal is cut short between its durable mark and its end, for the restart
  // phase: the driver marks it in the list and deletes its key, as a crash there would leave it.
  const Rr = await saved({ kind: 'server', url: `${base}/rr2`, label: 'removed across a restart' });
  await ctx.ask<string>('settings', 'make-key', `addr:${Rr.id}`);
  await outcome(guardedFetch(Rr.id)(`${base}/rr2/key-hash`, { headers: AUTH }));
  await say(`NETRESTART ${Rr.id}`);
  await say('NETKEYS done');
}

/* The phase started with the system proxy already set: public through it, loopback and lan direct. */
export async function proxyStartChecks() {
  const net = (await (await fetch('net.json', { cache: 'no-store' })).json()) as Net;
  const base = `http://127.0.0.1:${net.http}`;
  const outcome = (p: Promise<unknown>) => within(p.then(() => 'ok', e => kindOf(e)), 60000, 'fetch');
  await check('security.fetch.proxy-cold', async () => {
    const kind = await shell.netProxy();
    const site = await saved({ kind: 'model', url: 'https://example.com', label: 'a public host' });
    const local = await saved({ kind: 'server', url: `${base}/ps`, label: 'loopback' });
    const lan = await saved({ kind: 'server', url: `http://${net.lanIp}:${net.lan}/pc`, label: 'the lan fixture' });
    const mark = Date.now();
    const pub = await outcome(guardedFetch(site.id, { headersMs: 15000 })('https://example.com/'));
    const loop = await outcome(guardedFetch(local.id)(`${base}/ps/ok`));
    const lanR = await outcome(guardedFetch(lan.id)(`http://${net.lanIp}:${net.lan}/pc/ok`));
    const lanConns = await conns('lan', mark);
    const seen = await proxyOff();
    const hosts = seen.targets.map(proxyHost);
    ok(kind.kind === 'manual' && kind.inUse, 'net_proxy at start: ' + JSON.stringify(kind));
    ok(pub === 'ok' && loop === 'ok' && lanR === 'ok' && lanConns >= 1, `public ${pub}, loopback ${loop}, lan ${lanR} with ${lanConns} connections at the fixture`);
    ok(hosts.includes('example.com'), 'the public address did not use the proxy: ' + seen.targets.join(' '));
    ok(!hosts.some(h => h === '127.0.0.1' || h === 'localhost' || h === net.lanIp), 'a local address went through the proxy: ' + seen.targets.join(' '));
    return `started with the proxy already set: net_proxy ${JSON.stringify(kind)}; public through it (${seen.targets.join(' ')}), loopback direct, the lan fixture direct with ${lanConns} connections`;
  });
}

/* The phase after the driver cut a removal short: the list holds the address as being removed
   and its key is gone, as a crash after the durable mark leaves it. The shell folder is still
   locked, so the start can't finish the removal either. */
export async function removeRestartChecks(id: string, data: string) {
  const net = (await (await fetch('net.json', { cache: 'no-store' })).json()) as Net;
  const base = `http://127.0.0.1:${net.http}`;
  const outcome = (p: Promise<unknown>) => within(p.then(() => 'ok', e => kindOf(e)), 60000, 'fetch');
  await check('security.key.remove-restart', async () => {
    const listed = (await shell.addressList()).find(a => a.id === id);
    // The server answers this with the key the address's last request carried, before the restart.
    const remembered = await outcome(guardedFetch(id)(`${base}/rr2/echo/remembered`));
    const withKey = await outcome(guardedFetch(id)(`${base}/rr2/key-hash`, { headers: AUTH }));
    const cm = await step<{ found: boolean }>('cmdkey', { target: `addr:${id}` });
    await step('shell-lock', { data, on: false });
    const retry = await shell.addressRemove(id).then(() => 'removed', reason);
    const after = (await shell.addressList()).some(a => a.id === id);
    ok(!!listed && listed.removing === true, 'loaded as: ' + JSON.stringify(listed));
    ok(remembered === 'revoked' && withKey === 'revoked', `after the restart: a keyless request to the endpoint holding the old key ${remembered}, one with the key ${withKey}`);
    ok(!cm.found, 'the key is back: ' + cm.found);
    ok(retry === 'removed' && !after, `the retry: ${retry}, still listed ${after}`);
    return `loaded as being removed with its key already gone; a keyless request to the endpoint holding the old key was ${remembered}, one with the key ${withKey}; once the folder could be written the retry finished it`;
  });
}

/* The control, run with a check build whose request helpers block the async workers on purpose:
   the same flood and probe, which must now be slow. The driver judges the number. */
export async function responsiveControl() {
  const net = (await (await fetch('net.json', { cache: 'no-store' })).json()) as Net;
  const base = `http://127.0.0.1:${net.http}`;
  const A = await saved({ kind: 'server', url: `${base}/ctl`, label: 'the control' });
  const cs = Array.from({ length: 32 }, () => new AbortController());
  const open = cs.map(c => guardedFetch(A.id)(`${base}/ctl/slow-head`, { signal: c.signal }).catch(() => {}));
  await sleep(500);
  const ms = await probe(3000);
  cs.forEach(c => c.abort());
  await Promise.all(open);
  await say(`INFO responsive-control ${ms}`);
}
