/* The hostile page: every way out a page could try, aimed at the driver's listeners on 127.0.0.1
   (TCP and UDP, with a STUN responder), at a LAN-looking address, and at unique random names that
   only a DNS lookup would reveal. It runs in core, in a view, in a view without Trusted Types, and
   once in a headless Edge with no sink proxy, where the fixtures must see it (the positive
   control). It has no Tauri in it.

   Each route gets its own label, `<run><ctx><nn>`, in every path and name it uses, and its own LAN
   port, so the driver can tell which route got out, from which page. */

/* `driver` is the driver's own sends, the other half of the positive control. `probe` is the
   WebRTC measurement runs, judged apart from the egress checks. */
export type Ctx = 'core' | 'view' | 'bare' | 'edge' | 'driver' | 'probe';
export const CTX_CODE: Record<Ctx, string> = { core: 'c', view: 'v', bare: 'b', edge: 'e', driver: 'd', probe: 'p' };
const CTX_INDEX: Record<Ctx, number> = { core: 0, view: 1, bare: 2, edge: 3, driver: 4, probe: 5 };
export const NAME_SUFFIX = 'familiar-check.test';

export interface HostileFixtures {
  run: string;
  tcp: number;
  lan: string;
  udp: Record<string, number>;
  turnTcp: Record<string, number>;
}

interface Where { label: string; loop: string; lan: string; name: string; host: string; lanPort: number }
type Out = Partial<Record<'loop' | 'lan' | 'name', string>>;
interface Route { id: string; nav?: boolean; go(w: Where, ctx: Ctx, fx: HostileFixtures): Promise<Out> }

export const label = (fx: { run: string }, ctx: Ctx, i: number) => `${fx.run}${CTX_CODE[ctx]}${String(i).padStart(2, '0')}`;
export const lanPort = (ctx: Ctx, i: number) => 20000 + CTX_INDEX[ctx] * 100 + i;

function where(fx: HostileFixtures, ctx: Ctx, i: number): Where {
  const l = label(fx, ctx, i), host = `${l}.${NAME_SUFFIX}`, lp = lanPort(ctx, i);
  return {
    label: l, host, lanPort: lp,
    loop: `http://127.0.0.1:${fx.tcp}/h/${l}/loop`,
    lan: `http://${fx.lan}:${lp}/h/${l}/lan`,
    name: `http://${host}:${fx.tcp}/h/${l}/name`
  };
}

const name = (e: unknown) => e instanceof DOMException || e instanceof Error ? e.name : typeof e;

/* One attempt, as a word: what the page saw. A timeout is `pending`, not a pass or a fail: the
   listeners and the capture decide whether anything got out. */
function attempt(f: () => Promise<string> | string, ms = 2500): Promise<string> {
  return new Promise<string>(done => {
    const t = setTimeout(() => done('pending'), ms);
    try {
      Promise.resolve(f()).then(v => { clearTimeout(t); done(v); }, e => { clearTimeout(t); done('rejected:' + name(e)); });
    } catch (e) {
      clearTimeout(t);
      done('threw:' + name(e));
    }
  });
}

const three = async (w: Where, f: (url: string, which: 'loop' | 'lan' | 'name') => Promise<string> | string): Promise<Out> => {
  const [loop, lan, nm] = await Promise.all((['loop', 'lan', 'name'] as const).map(k => attempt(() => f(w[k], k))));
  return { loop, lan, name: nm };
};

const events = (el: HTMLElement | XMLHttpRequest | EventSource | WebSocket | Worker, ok: string[], bad: string[]) =>
  new Promise<string>(done => {
    for (const e of ok) el.addEventListener(e, () => done(e));
    for (const e of bad) el.addEventListener(e, () => done(e));
  });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, set: (e: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  set(e);
  (document.body ?? document.documentElement).append(e);
  return e;
}

function link(rel: string, url: string, as?: string): Promise<string> {
  const l = document.createElement('link');
  l.rel = rel;
  if (as) l.setAttribute('as', as);
  const p = events(l, ['load'], ['error']);
  l.href = url;
  document.head.append(l);
  return Promise.race([p, new Promise<string>(r => setTimeout(() => r('added'), 1500))]);
}

let styleN = 0;
function style(css: (cls: string) => string): Promise<string> {
  const cls = `h${++styleN}`;
  const s = document.createElement('style');
  s.textContent = css(cls);
  document.head.append(s);
  element('div', d => { d.className = cls; d.textContent = 'x'; });
  return new Promise(r => setTimeout(() => r('added'), 1200));
}

function rtc(servers: RTCIceServer[], PC: typeof RTCPeerConnection): Promise<string> {
  return new Promise<string>(done => {
    let pc: RTCPeerConnection;
    try {
      pc = new PC({ iceServers: servers, iceTransportPolicy: 'all' });
    } catch (e) { done('threw:' + name(e)); return; }
    const seen = new Set<string>();
    pc.onicecandidate = e => { if (e.candidate) seen.add(e.candidate.type ?? '?'); };
    pc.createDataChannel('x');
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => done('rejected:' + name(e)));
    setTimeout(() => { done(`gathered:${[...seen].sort().join('+') || 'none'}`); pc.close(); }, 5000);
  });
}

type PCtor = typeof RTCPeerConnection;
const pcOf = (w: unknown): PCtor | undefined => {
  try { return (w as { RTCPeerConnection?: PCtor } | null | undefined)?.RTCPeerConnection; } catch { return undefined; }
};
const stun = (w: Where, ctx: Ctx, fx: HostileFixtures): RTCIceServer[] => [
  { urls: `stun:127.0.0.1:${fx.udp[`${ctx}-stun`]}` }, { urls: `stun:${fx.lan}:${w.lanPort}` }, { urls: `stun:${w.host}:${fx.udp[`${ctx}-stun`]}` }
];
/* What a found constructor gathers, tagged with where it came from, or that there was none. */
function rtcVia(PC: PCtor | undefined, tag: string, servers: RTCIceServer[]): Promise<string> {
  return PC ? rtc(servers, PC).then(r => `${tag}-${r}`) : Promise.resolve(`${tag}-none`);
}
const rtcRoute = (f: () => Promise<string> | string) => attempt(f, 8000).then(r => ({ loop: r, lan: r, name: r }));

function worker(code: string): Promise<string> {
  return new Promise<string>((done, no) => {
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    w.onmessage = e => done('worker:' + String(e.data));
    w.onerror = () => no(new Error('worker error'));
  });
}

export const ROUTES: Route[] = [
  { id: 'fetch', go: w => three(w, u => fetch(u, { mode: 'no-cors' }).then(r => 'resolved:' + r.type)) },
  { id: 'fetch-keepalive', go: w => three(w, u => fetch(u, { method: 'POST', body: 'x', keepalive: true, mode: 'no-cors' }).then(() => 'resolved')) },
  { id: 'xhr', go: w => three(w, u => { const x = new XMLHttpRequest(); const p = events(x, ['load'], ['error']); x.open('GET', u); x.send(); return p; }) },
  { id: 'websocket', go: w => three(w, u => { const s = new WebSocket(u.replace('http:', 'ws:')); return events(s, ['open'], ['error']); }) },
  { id: 'eventsource', go: w => three(w, u => { const s = new EventSource(u); const p = events(s, ['open'], ['error']); p.then(() => s.close()); return p; }) },
  { id: 'beacon', go: w => three(w, u => 'returned:' + navigator.sendBeacon(u, 'x')) },
  { id: 'img', go: w => three(w, u => { const i = new Image(); const p = events(i, ['load'], ['error']); i.src = u; return p; }) },
  { id: 'svg-image', go: w => three(w, u => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const i = document.createElementNS('http://www.w3.org/2000/svg', 'image'); i.setAttribute('href', u); s.append(i); document.body.append(s); return new Promise(r => setTimeout(() => r('added'), 1200)); }) },
  { id: 'css-url', go: w => three(w, u => style(c => `.${c}{background-image:url("${u}")}`)) },
  { id: 'css-import', go: w => three(w, u => style(() => `@import url("${u}");`)) },
  { id: 'font-face', go: w => three(w, u => new FontFace('f' + Math.random().toString(36).slice(2), `url("${u}")`).load().then(() => 'loaded')) },
  { id: 'stylesheet', go: w => three(w, u => link('stylesheet', u)) },
  { id: 'link-prefetch', go: w => three(w, u => link('prefetch', u)) },
  { id: 'link-preconnect', go: w => three(w, u => link('preconnect', u)) },
  { id: 'link-dns-prefetch', go: w => three(w, u => link('dns-prefetch', u)) },
  { id: 'link-preload', go: w => three(w, u => link('preload', u, 'fetch')) },
  { id: 'link-modulepreload', go: w => three(w, u => link('modulepreload', u)) },
  { id: 'favicon', go: w => three(w, u => link('icon', u)) },
  { id: 'manifest', go: w => three(w, u => link('manifest', u)) },
  {
    id: 'anchor-dns', go: w => three(w, u => {
      const m = document.createElement('meta');
      m.httpEquiv = 'x-dns-prefetch-control'; m.content = 'on';
      document.head.append(m);
      element('a', a => { a.href = u; a.textContent = 'x'; });
      return new Promise(r => setTimeout(() => r('added'), 1200));
    })
  },
  { id: 'script', go: w => three(w, u => { const s = document.createElement('script'); const p = events(s, ['load'], ['error']); s.src = u; document.head.append(s); return p; }) },
  { id: 'import', go: w => three(w, u => import(/* @vite-ignore */ u).then(() => 'imported')) },
  { id: 'iframe', go: w => three(w, u => { const f = element('iframe', f => { f.src = u; }); return events(f, ['load'], ['error']); }) },
  { id: 'object', go: w => three(w, u => { element('object', o => { o.data = u; }); return new Promise(r => setTimeout(() => r('added'), 1200)); }) },
  { id: 'media', go: w => three(w, u => { const v = element('video', v => { v.src = u; }); return events(v, ['loadeddata'], ['error']); }) },
  { id: 'worker', go: w => three(w, u => { const x = new Worker(u); return events(x, ['message'], ['error']); }) },
  { id: 'blob-worker', go: w => three(w, u => worker(`fetch(${JSON.stringify(u)},{mode:'no-cors'}).then(()=>postMessage('fetched'),e=>postMessage('rejected:'+e.name))`)) },
  { id: 'blob-worker-import', go: w => three(w, u => worker(`try{importScripts(${JSON.stringify(u)});postMessage('imported')}catch(e){postMessage('threw:'+e.name)}`)) },
  { id: 'service-worker', go: w => three(w, u => navigator.serviceWorker.register(u).then(() => 'registered')) },
  { id: 'notification', go: w => three(w, u => { const n = new Notification('x', { icon: u }); return events(n as unknown as HTMLElement, ['show'], ['error']); }) },
  { id: 'webtransport', go: w => three(w, u => { const T = (window as unknown as { WebTransport?: new (u: string) => { ready: Promise<void> } }).WebTransport; if (!T) return 'absent'; return new T(u.replace('http:', 'https:')).ready.then(() => 'ready'); }) },
  {
    id: 'speculation', go: w => three(w, u => {
      const s = document.createElement('script');
      s.type = 'speculationrules';
      s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: [u] }] });
      document.head.append(s);
      return new Promise(r => setTimeout(() => r('added'), 1200));
    })
  },
  /* WebRTC: the page's own constructor, then every way a page might find another one if the
     exe's script took the page's away: frames made by script (read before any await, nested,
     read later through a saved reference, by srcdoc), object and embed and frame elements, and
     whatever RTC-looking globals are left. Each gathers against the route's own STUN names. */
  { id: 'webrtc-stun', go: (w, ctx, fx) => rtcRoute(() => rtcVia(pcOf(globalThis), 'page', stun(w, ctx, fx))) },
  {
    id: 'webrtc-turn', go: (w, ctx, fx) => rtcRoute(() => rtcVia(pcOf(globalThis), 'page', [
      { urls: [`turn:127.0.0.1:${fx.udp[`${ctx}-turn`]}?transport=udp`, `turn:127.0.0.1:${fx.turnTcp[ctx]}?transport=tcp`], username: 'u', credential: 'p' },
      { urls: [`turn:${fx.lan}:${w.lanPort}?transport=udp`, `turn:${fx.lan}:${w.lanPort}?transport=tcp`], username: 'u', credential: 'p' },
      { urls: [`turn:${w.host}:${fx.turnTcp[ctx]}?transport=tcp`, `turn:${w.host}:${fx.udp[`${ctx}-turn`]}?transport=udp`], username: 'u', credential: 'p' }
    ]))
  },
  {
    id: 'webrtc-frame', go: (w, ctx, fx) => rtcRoute(() => {
      const f = document.createElement('iframe');
      document.body.appendChild(f);
      const PC = pcOf(f.contentWindow); // straight after appendChild, before any await
      return rtcVia(PC, 'frame', stun(w, ctx, fx));
    })
  },
  {
    id: 'webrtc-frame-nested', go: (w, ctx, fx) => rtcRoute(() => {
      const f = element('iframe', () => {});
      const doc = f.contentDocument;
      if (!doc) return 'no-inner-document';
      const inner = doc.createElement('iframe');
      (doc.body ?? doc.documentElement).appendChild(inner);
      return rtcVia(pcOf(inner.contentWindow), 'nested', stun(w, ctx, fx));
    })
  },
  {
    id: 'webrtc-frame-later', go: (w, ctx, fx) => rtcRoute(async () => {
      const f = element('iframe', () => {});
      const win = f.contentWindow;
      await new Promise(r => setTimeout(r, 1500));
      return rtcVia(pcOf(win), 'later', stun(w, ctx, fx));
    })
  },
  {
    id: 'webrtc-srcdoc', go: (w, ctx, fx) => rtcRoute(async () => {
      const f = document.createElement('iframe');
      f.srcdoc = '<p>x</p>';
      document.body.appendChild(f);
      await new Promise(r => setTimeout(r, 1200));
      return rtcVia(pcOf(f.contentWindow), 'srcdoc', stun(w, ctx, fx));
    })
  },
  {
    id: 'webrtc-object', go: (w, ctx, fx) => rtcRoute(async () => {
      const o = document.createElement('object');
      o.type = 'text/html';
      o.data = 'about:blank';
      document.body.appendChild(o);
      await new Promise(r => setTimeout(r, 1200));
      return rtcVia(pcOf(o.contentWindow), 'object', stun(w, ctx, fx));
    })
  },
  {
    id: 'webrtc-frame-embed', go: (w, ctx, fx) => rtcRoute(async () => {
      const fr = document.createElement('frame');
      document.body.appendChild(fr);
      const e = document.createElement('embed');
      e.type = 'text/html';
      e.src = 'about:blank';
      document.body.appendChild(e);
      await new Promise(r => setTimeout(r, 1200));
      const fromFrame = pcOf(fr.contentWindow);
      const fromEmbed = pcOf(e.getSVGDocument?.()?.defaultView);
      if (fromFrame) return rtcVia(fromFrame, 'frame-element', stun(w, ctx, fx));
      return rtcVia(fromEmbed, 'embed', stun(w, ctx, fx));
    })
  },
  {
    id: 'webrtc-leftovers', go: (w, ctx, fx) => rtcRoute(() => {
      const g = globalThis as unknown as Record<string, unknown>;
      const names = Object.getOwnPropertyNames(globalThis).filter(n => /rtc|peerconnection/i.test(n));
      for (const n of names) {
        const v = g[n] as ((...a: unknown[]) => unknown) & { prototype?: object };
        if (typeof v === 'function' && v.prototype && 'createOffer' in v.prototype) return rtcVia(v as unknown as typeof RTCPeerConnection, 'left-' + n, stun(w, ctx, fx));
      }
      // An event's prototype chain leads to Event, not to a peer connection, but say what's left.
      return `none-of:${names.slice(0, 12).join('+') || 'nothing'}`;
    })
  },
  { id: 'window-open', go: w => three(w, u => 'returned:' + (window.open(u) === null ? 'null' : 'window')) },
  { id: 'blank-link', go: w => three(w, u => { element('a', a => { a.href = u; a.target = '_blank'; a.rel = 'noopener'; }).click(); return 'clicked'; }) },
  { id: 'blank-form', go: w => three(w, u => { const f = element('form', f => { f.action = u; f.method = 'post'; f.target = '_blank'; }); f.submit(); return 'submitted'; }) },
  /* These would take the page away if they weren't refused, so they run last, one at a time. */
  { id: 'a-ping', nav: true, go: w => attempt(() => { element('a', a => { a.href = w.name; a.ping = `${w.loop} ${w.lan}`; }).click(); return new Promise(r => setTimeout(() => r('clicked'), 800)); }).then(r => ({ loop: r, lan: r, name: r })) },
  { id: 'form-post', nav: true, go: w => attempt(() => { const f = element('form', f => { f.action = w.lan; f.method = 'post'; }); f.submit(); return new Promise(r => setTimeout(() => r('submitted'), 800)); }).then(r => ({ lan: r })) },
  { id: 'meta-refresh', nav: true, go: w => attempt(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = `0;url=${w.loop}`; document.head.append(m); return new Promise(r => setTimeout(() => r('added'), 1500)); }).then(r => ({ loop: r })) },
  { id: 'a-download', nav: true, go: w => attempt(() => { element('a', a => { a.href = w.loop; a.download = 'x.bin'; }).click(); return new Promise(r => setTimeout(() => r('clicked'), 800)); }).then(r => ({ loop: r })) },
  { id: 'location-assign', nav: true, go: w => attempt(() => { location.assign(w.name); return new Promise(r => setTimeout(() => r('assigned'), 1500)); }).then(r => ({ name: r })) }
];

/* Runs every route once, all at the same time except the navigations, and says what the page saw. */
export async function hostile(ctx: Ctx, fx: HostileFixtures, opts: { nav: boolean; only?: string[] }): Promise<Record<string, Out>> {
  const out: Record<string, Out> = {};
  const skip = (r: Route) => opts.only !== undefined && !opts.only.includes(r.id);
  const run = async (r: Route, i: number) => {
    try { out[r.id] = await r.go(where(fx, ctx, i), ctx, fx); } catch (e) { out[r.id] = { loop: 'threw:' + name(e) }; }
  };
  await Promise.all(ROUTES.map((r, i) => (r.nav || skip(r) ? null : run(r, i))));
  if (opts.nav) {
    for (const [i, r] of ROUTES.entries()) if (r.nav && !skip(r)) await run(r, i);
  }
  return out;
}
