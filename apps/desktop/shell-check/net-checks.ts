/* The guarded fetch and keys, checked from core with the fake server in net-server.mjs. Every
   address is added through the native confirm, which the driver answers. A key is typed into
   Settings' password field by the driver with real key presses; core never sees it, only a
   probe of its first and last characters to check that nothing it reads holds the key. See
   5a and 5c in docs/shell-design.md. */
import { guardedFetch, PLACEHOLDER } from '../src/net.ts';
import { reason, type Address } from '../src/shell.ts';
import { check, fail, ok, rand, say, shell, sleep, step } from './common.ts';

interface Net { http: number; tls: number; proxy: number; control: number }
interface Typed { sha: string; head: string; tail: string; length: number; last4: string }
type Ctx = { ask: <T>(to: string, cmd: string, args?: unknown) => Promise<T>; up: (role: string) => Promise<unknown> };

const APPROVE = 'Allow', REFUSE = "Don't allow";
const dialog = (act: string) => step<{ found: boolean; answered: string }>('dialog', { act, approve: APPROVE, refuse: REFUSE }, 60000);
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
    const name = () => `${rand(14)}.familiar-check.test`;
    const [n1, n2, n3, n4] = [name(), name(), name(), name()];
    const r1 = await added({ kind: 'model', url: `https://${n1}/v1`, label: 'never 1' }, 'refuse');
    const r2 = await added({ kind: 'model', url: `https://${n2}/v1`, label: 'never 2' }, 'refuse');
    const r3 = await added({ kind: 'model', url: `https://${n3}/v1`, label: 'never 3' }, 'none');
    const tray = await step<{ done: boolean; how: string }>('tray-ask-again');
    const r4 = await added({ kind: 'model', url: `https://${n4}/v1`, label: 'after' });
    for (const n of [n1, n2, n3]) await say(`NETLOOKUP never ${n.split('.')[0]}`);
    await say(`NETLOOKUP after ${n4.split('.')[0]}`);
    ok(String(r1).startsWith('declined') && String(r2).startsWith('declined'), `refused: ${r1}, ${r2}`);
    ok(String(r3).startsWith('asks-stopped'), 'the fourth ask: ' + r3);
    ok(tray.done, 'the tray item: ' + tray.how);
    ok(String(r4).startsWith('blocked-address'), 'after Allow, a name with no answers: ' + JSON.stringify(r4));
    await say('NETLOOKUP flow ok');
    return 'two refused and one stopped ask, then one allowed; the capture decides security.fetch.no-lookup-before-allow';
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
    seen.push(b200, b401, big, split);
    const redirect = await outcome(f(`${base}/api/echo/redirect`, { headers: AUTH }));
    const toKey = await step<{ count: number }>('net-requests', { path: `/api/${typed!.head}` });
    ok(probeClean(seen), 'a response field held the key');
    ok((value.headers.get('x-echo') ?? '').includes('[key]'), 'header value: ' + value.headers.get('x-echo'));
    ok(!names.some(n => n.startsWith('x-k-')), 'a header named with the key reached the page');
    ok(b200 === 'before [key] after' && b401 === 'denied [key]' && r401.status === 401, `bodies: ${b200} / ${b401}`);
    ok(big.split('[key]').length === 5 && big.length > 300 * 1024, 'the 300 KB body: ' + big.split('[key]').length);
    ok(split === 'a [key] b', 'split across chunks: ' + split);
    ok(redirect === 'redirect-refused' && toKey.count === 0, `redirect to the key's path: ${redirect}, server saw ${toKey.count}`);
    return `the key came back as [key] in a header value, both bodies, 300 KB and split across chunks; a header named with it was dropped; the status line shows ${JSON.stringify(status.statusText)}; a redirect to it was refused and never followed`;
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
    ok(whole === 40, `${whole} of 40 chunks`);
    ok(stopped === 'AbortError' && ms <= 100, `a stop after chunk 3: ${stopped} in ${ms} ms`);
    ok(beforeHead === 'AbortError', 'a stop before the head: ' + beforeHead);
    ok(openAfterStop === 0 && openAfterEarly === 0, `the server still had ${openAfterStop} and ${openAfterEarly} open`);
    return `40 chunks whole; a stop after chunk 3 rejected in ${ms} ms; a stop before the head rejected; the server saw both connections close`;
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
    ok(after === 'revoked', 'a read after removal: ' + after);
    ok(next === 'not-saved', 'a fetch after removal: ' + next);
    ok(open === 0, `the server still had ${open} open`);
    return 'removing an address mid-stream ended the read as revoked, closed the connection, and the next fetch is not-saved';
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
    await step('hosts', { name: 'rebind.familiar-check.test', ip: '8.8.8.8' });
    const r = await saved({ kind: 'model', url: 'https://rebind.familiar-check.test', label: 'rebinding' });
    await step('hosts', { name: 'rebind.familiar-check.test', ip: '127.0.0.1' });
    const after = await outcome(guardedFetch(r.id)('https://rebind.familiar-check.test/v1'));
    await step('hosts', { name: 'rebind.familiar-check.test', ip: null });
    ok(r.reach === 'public', 'saved as ' + r.reach);
    ok(after === 'blocked-address', 'after it moved to 127.0.0.1: ' + after);
    return 'saved while it resolved publicly; once it resolved to 127.0.0.1 the fetch was blocked-address';
  });

  await check('security.fetch.proxy', async () => {
    if (!publicSite || !A) fail('no addresses');
    const lan = await saved({ kind: 'server', url: 'http://10.255.255.1:9/x', label: 'a lan address' });
    await step('proxy', { on: true });
    const pub = await outcome(guardedFetch(publicSite!.id, { headersMs: 15000 })('https://example.com/'));
    const loop = await outcome(guardedFetch(A!.id)(`${base}/api/ok`));
    const lanR = await outcome(guardedFetch(lan.id, { headersMs: 2000 })('http://10.255.255.1:9/x'));
    const seen = await step<{ targets: string[] }>('proxy', { on: false });
    ok(seen.targets.some(t => t.startsWith('example.com:')), 'the public address did not use the proxy: ' + seen.targets.join(' '));
    ok(!seen.targets.some(t => t.startsWith('127.0.0.1') || t.startsWith('10.')), 'a local address went through the proxy: ' + seen.targets.join(' '));
    ok(pub === 'ok' && loop === 'ok', `public ${pub}, loopback ${loop}`);
    return `public through the system proxy (${seen.targets.join(' ')}); loopback direct (${loop}); lan direct (${lanR})`;
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

  await check('security.key.write-only', async () => {
    const view = await ctx.ask<Record<string, string>>('chat', 'refusals', [['secret_status', { id: 'addr:x' }], ['secret_set', { id: 'addr:x', value: 'x'.repeat(12) }], ['secret_delete', { id: 'addr:x' }], ['secret_get', { id: 'addr:x' }]]);
    const settings = await ctx.ask<Record<string, string>>('settings', 'refusals', [['secret_get', { id: 'addr:x' }], ['secret_delete', { id: 'addr:x' }]]);
    const core = await shell.secretStatus(`addr:${A2!.id}`);
    ok(Object.values(view).every(v => v === 'acl') && Object.values(settings).every(v => v === 'acl'), JSON.stringify({ view, settings }));
    ok(Object.keys(core).sort().join() === 'boundTo,hint,present' && core.hint === null, 'status: ' + JSON.stringify(core));
    return 'no command reads a key; a view reaches no key command; Settings can\'t delete; status shows present, binding and a hint only';
  });
  await say('NETKEYS done');
}
