// The wire harness (docs/mcp-design.md 7.2): the real client (McpClient, its links and the exchange machine)
// against a scripted fake server, through an unkind fake exe, every native answer an event the seeded
// scheduler picks. The fake exe keeps its own log of every native request; the driver keeps the evidence
// log of what the person did. The checks (checks.ts) read only those two logs.

import { mutant, mutations } from '../../src/mutations.ts';
import { McpClient } from '../../src/mcp/client.ts';
import { mintDecision } from '../../src/mcp/decision.ts';
import type { NetHead, NetPort, NetSpec } from '../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../../src/mcp/process.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import type { CallOutcome } from '../../src/mcp/types.ts';
import { Scheduler } from './sched.ts';

const enc = new TextEncoder();
const MODERN = '2026-07-28';
/** The exe's admission (4.1): 32 open requests in all, server requests at most 24 in the pass build. */
export const EXE_TOTAL = 32;
export const EXE_SERVER_CAP = 24;
/** The pass build's detach bound for a held helper, and how long the harness holds one. */
export const DETACH_MS = 2_000;
export const HELPER_HELD_MS = 120_000;

/* ---------- the server's script, per seed ---------- */

export interface Mode {
  readonly where: 'remote' | 'local';
  readonly era: 'legacy' | 'modern' | 'both';
  readonly sse: number;
  /** Pings on a call's stream: none, a few, or a flood. */
  readonly pings: 0 | 1 | 2 | 40;
  readonly earlyEnd: number;
  readonly staleId: number;
  readonly listChanged: number;
  readonly pages: number;
  readonly session404: 'none' | 'once' | 'twice' | 'again' | 'always';
  readonly redirect: number;
  readonly idlePings: number;
  readonly stopReading: number;
  readonly inputRequired: number;
  /** Ping in the same chunk ahead of the final reply (S2). */
  readonly pingWithFinal: number;
  /** A legacy server whose initialize fails for another reason (H12's control). */
  readonly initError: number;
  /** A slow call's stream opens and then says nothing more (S8, S10, S13). */
  readonly hold: boolean;
  /** Each answer in one chunk (S2: a ping in the same chunk as the final reply). */
  readonly oneChunk: boolean;
  /** A list_changed ahead of the first tools/list answer of each session, its variant flipped (S14). */
  readonly changeOnList: boolean;
  /** How often a cancelled request's helper is held, for any time (H4). */
  readonly holdHelpers: number;
  /** Which requests' helpers may be held: any, or only calls (S8, S10). */
  readonly holdWhich: 'any' | 'calls';
}

export function modeOf(r: () => number, over: Partial<Mode> = {}): Mode {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const where = pick(['remote', 'remote', 'local'] as const);
  return {
    where,
    era: pick(['legacy', 'legacy', 'legacy', 'modern', 'both'] as const),
    sse: r(),
    pings: pick([0, 0, 1, 2, 2, 40] as const),
    earlyEnd: r() < 0.15 ? 0.3 : 0,
    staleId: r() < 0.2 ? 0.5 : 0,
    listChanged: r() < 0.2 ? 0.4 : 0,
    pages: 1 + Math.floor(r() * 2),
    session404: where === 'remote' ? pick(['none', 'none', 'once', 'twice', 'always'] as const) : 'none',
    redirect: where === 'remote' && r() < 0.15 ? 0.4 : 0,
    idlePings: where === 'local' && r() < 0.3 ? 0.3 : 0,
    stopReading: where === 'local' && r() < 0.1 ? 1 : 0,
    inputRequired: r() < 0.15 ? 0.5 : 0,
    pingWithFinal: r() < 0.3 ? 0.6 : 0,
    initError: 0,
    hold: false,
    oneChunk: false,
    changeOnList: false,
    holdHelpers: r() < 0.2 ? 0.5 : 0,
    holdWhich: 'any',
    ...over
  };
}

type Msg = Record<string, any>;

/** What the server says to one request: messages in order, the final one last (or none: an early end). */
export interface Plan {
  readonly status: number;
  readonly sse: boolean;
  readonly messages: Msg[];
  readonly session?: string;
  /** The index of the final response among `messages`, or -1. */
  readonly final: number;
  readonly location?: string;
}

const tools = (era: Mode['era'], variant: string) => [
  { name: 'echo', description: variant === 'a' ? 'Echo.' : 'Echo, changed.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'Slow.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ...(era !== 'legacy' ? [{ name: 'mirror', description: 'Mirror.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, region: { type: 'string', 'x-mcp-header': 'Region' } } } }] : [])
];

export class ScriptedServer {
  readonly mode: Mode;
  private readonly r: () => number;
  private session = 0;
  private sessionIdNow: string | undefined;
  private drops = 0;
  private pingN = 0;
  /** Every ping id it sent, with where. */
  readonly pings: { id: string; on: string; afterFinal: boolean }[] = [];
  /** Every request that reached it, in order. `followed`: the exe's own redirect follow, not the client's. */
  readonly arrivals: { body: Msg; headers: Record<string, string>; method: string; step: number; followed?: boolean }[] = [];
  private lastId: unknown;
  private changedThisSession = -1;
  /** Its tools' variant: a list_changed it sends changes the echo tool's description (S1). */
  variant = 'a';

  constructor(mode: Mode, r: () => number) {
    this.mode = mode;
    this.r = r;
  }

  private ping(on: string, afterFinal = false): Msg {
    const id = `p${++this.pingN}`;
    this.pings.push({ id, on, afterFinal });
    return { jsonrpc: '2.0', id, method: 'ping' };
  }

  /** One request's answer. `on` names the stream (for the ping log). */
  answer(body: Msg, headers: Record<string, string>, on: string): Plan {
    const m = this.mode;
    const modernReq = body.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === MODERN;
    const json = (messages: Msg[], status = 200, extra: Partial<Plan> = {}): Plan => ({ status, sse: messages.length > 1 || this.r() < m.sse, messages, final: messages.findIndex((x) => x.id === body.id && ('result' in x || 'error' in x)), ...extra });
    if (body.method === 'initialize') {
      if (m.era === 'legacy' && this.r() < m.initError) return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'internal error' } }]);
      if (m.era === 'modern') {
        const refusal = { jsonrpc: '2.0', id: body.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [MODERN], requested: body.params?.protocolVersion } } };
        return json([refusal], this.r() < 0.5 ? 400 : 200, { session: this.r() < 0.5 ? 'dead' : undefined } as Partial<Plan>);
      }
      this.session++;
      this.sessionIdNow = m.where === 'remote' && m.era === 'legacy' ? `S${this.session}` : undefined;
      return json([{ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'scripted' } } }], 200, this.sessionIdNow ? { session: this.sessionIdNow } : {});
    }
    // A legacy session that ends: a 404 on a request carrying the old id.
    if (m.where === 'remote' && this.sessionIdNow && headers['mcp-session-id'] !== undefined) {
      const drop =
        m.session404 === 'always' ||
        (m.session404 === 'once' && this.drops === 0 && body.method === 'tools/call') ||
        (m.session404 === 'twice' && this.drops < 2 && body.method !== 'notifications/initialized') ||
        // A call drops the session, then the first page after the re-handshake drops it again.
        (m.session404 === 'again' && ((this.drops === 0 && body.method === 'tools/call') || (this.drops === 1 && body.method === 'tools/list')));
      if (drop && headers['mcp-session-id'] === this.sessionIdNow) {
        this.drops++;
        this.sessionIdNow = `S${++this.session}x`;
        return { status: 404, sse: false, messages: [], final: -1 };
      }
    }
    if (body.method === 'notifications/initialized' || (body.id === undefined && body.method)) return { status: 202, sse: false, messages: [], final: -1 };
    if (!body.method) return { status: 202, sse: false, messages: [], final: -1 };
    if (m.era === 'modern' && !modernReq) return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32022, message: 'no', data: { supported: [MODERN] } } }]);
    const complete = modernReq ? { resultType: 'complete' } : {};
    if (body.method === 'tools/list' && m.changeOnList && !modernReq && this.changedThisSession !== this.session) {
      this.changedThisSession = this.session;
      const page = Number(body.params?.cursor ?? 0);
      const next = page + 1 < m.pages ? { nextCursor: String(page + 1) } : {};
      const listed = { jsonrpc: '2.0', id: body.id, result: { tools: page === 0 ? tools(m.era, this.variant) : [], ...next } };
      this.variant = this.variant === 'a' ? 'b' : 'a';
      return { status: 200, sse: true, messages: [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, listed], final: 1 };
    }
    if (body.method === 'tools/list') {
      const page = Number(body.params?.cursor ?? 0);
      const next = page + 1 < m.pages ? { nextCursor: String(page + 1) } : {};
      return json([{ jsonrpc: '2.0', id: body.id, result: { tools: page === 0 ? tools(m.era, this.variant) : [], ...next, ...complete } }]);
    }
    if (body.method === 'tools/call') {
      const msgs: Msg[] = [];
      if (this.lastId !== undefined && this.lastId !== body.id && this.r() < m.staleId) msgs.push({ jsonrpc: '2.0', id: this.lastId, result: { content: [{ type: 'text', text: 'stale' }], ...complete } });
      this.lastId = body.id;
      const n = m.pings === 40 ? 40 : m.pings;
      if (!modernReq) for (let i = 0; i < n; i++) msgs.push(this.ping(on));
      if (!modernReq && this.r() < m.listChanged) {
        this.variant = this.variant === 'a' ? 'b' : 'a';
        msgs.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
      if (modernReq && this.r() < 0.2) msgs.push({ jsonrpc: '2.0', id: 'stray', method: 'ping' }, { jsonrpc: '2.0', id: 'ask', method: 'sampling/createMessage', params: {} });
      if (!modernReq && this.r() < m.pingWithFinal) msgs.push(this.ping(on));
      const text = String(body.params?.arguments?.text ?? '');
      const result = modernReq && this.r() < m.inputRequired ? { resultType: 'input_required', inputRequests: {} } : { content: [{ type: 'text', text: `ran ${body.params?.name} ${text}` }], ...complete };
      if (this.r() >= m.earlyEnd) msgs.push({ jsonrpc: '2.0', id: body.id, result });
      if (!modernReq && this.r() < 0.1) msgs.push(this.ping(on, true));
      if (m.where === 'remote' && this.r() < m.redirect) return { status: this.r() < 0.5 ? 307 : 303, sse: false, messages: [], final: -1, location: '/elsewhere' };
      return { ...json(msgs), sse: m.where === 'local' ? false : msgs.length > 1 || this.r() < m.sse };
    }
    if (body.method === 'ping') return json([{ jsonrpc: '2.0', id: body.id, result: {} }]);
    return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }]);
  }
}

/* ---------- the unkind fake exe ---------- */

export interface NativeRec {
  readonly seq: number;
  readonly n: number;
  readonly kind: 'post' | 'write' | 'model';
  /** Which server: the saved address (remote) or the process run (local). */
  readonly server: string;
  /** What the server answered (remote), for the harness's own reading of catalogs. */
  plan?: Plan;
  /** Fake-clock times: the cancel asked, the cancel returned (H4). */
  cancelAt?: number;
  endAt?: number;
  /** A helper held at cancel; detached by the pass build; when the helper itself ended. */
  held?: boolean;
  detached?: boolean;
  terminated?: number;
  /** Refused by the exe before it started. */
  refused?: 'busy';
  readonly method: string;
  readonly body: Msg | undefined;
  readonly headers: Record<string, string>;
  readonly start: number;
  /** Arrived at the server (remote), or the write was taken (local). */
  arrived?: number;
  head?: number;
  cancelAsked?: number;
  end?: number;
  /** Remote: the step each ping id on this stream was delivered, and when its final response was. */
  readonly delivered: Map<string, number>;
  final?: number;
  /** Remote epoch (a new one at each initialize), for H12 and H14. */
  epoch: number;
  status?: number;
  redirected?: boolean;
}

export class FakeExe {
  readonly log: NativeRec[] = [];
  private seq = 0;
  private epoch = 0;
  private readonly sched: Scheduler;
  private readonly server: ScriptedServer;
  readonly redirectMode: boolean;
  readonly build: 'prepass' | 'pass';
  /** Local: when each response line reached the client, by epoch and request id. */
  readonly responded = new Map<string, number>();
  /** Local: when each process run exited, by epoch. */
  readonly exits: { epoch: number; step: number }[] = [];
  /** Local: when each ping line reached the client. */
  readonly pingDelivered = new Map<string, number>();
  /** The highest count of server requests open at once, detached helpers included (H5's witness). */
  peakServer = 0;
  /** Global sequence shared with the evidence log, for order within a step. */
  readonly tick: () => number;

  constructor(sched: Scheduler, server: ScriptedServer, tick: () => number, build: 'prepass' | 'pass' = 'prepass') {
    this.sched = sched;
    this.server = server;
    this.tick = tick;
    this.build = build;
    // The pre-pass build follows redirects as today's contract does (4.3); the pass build never does (4.4).
    this.redirectMode = build === 'prepass';
  }

  /** Requests open in the exe: started and their task and helpers not yet terminated. */
  private open(kind?: NativeRec['kind']): number {
    return this.log.filter((x) => x.kind !== 'write' && !x.refused && x.terminated === undefined && (kind === undefined || x.kind === kind)).length;
  }

  /** Admission (4.1): 32 in all; in the pass build, server requests at most 24 of them. */
  private admits(kind: 'post' | 'model'): boolean {
    if (this.open() >= EXE_TOTAL) return false;
    if (kind === 'post' && this.build === 'pass' && !mutant('no-server-cap') && this.open('post') >= EXE_SERVER_CAP) return false;
    return true;
  }

  /** A model fetch, as chat makes one: refused busy only if the exe is full. Held open till the run ends. */
  modelFetch(): boolean {
    const rec: NativeRec = { seq: this.tick(), n: this.log.length, kind: 'model', server: 'model', method: 'POST', body: undefined, headers: {}, start: this.sched.step, delivered: new Map(), epoch: 0 };
    if (!this.admits('model')) rec.refused = 'busy';
    this.log.push(rec);
    return !rec.refused;
  }

  /* ---------- net ---------- */

  net(): NetPort {
    const streams = new Map<string, { rec: NativeRec; chunks: string[]; waiting?: { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void } ; plan?: Plan }>();
    const fetch = (spec: NetSpec, body: Uint8Array): Promise<NetHead> =>
      new Promise((resolve, reject) => {
        const text = new TextDecoder().decode(body);
        let parsed: Msg | undefined;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of spec.headers) headers[k.toLowerCase()] = v;
        if (parsed?.method === 'initialize') this.epoch++;
        const rec: NativeRec = { seq: this.tick(), n: this.log.length, kind: 'post', server: spec.address, method: spec.method, body: parsed, headers, start: this.sched.step, delivered: new Map(), epoch: this.epoch };
        if (!this.admits('post')) {
          rec.refused = 'busy';
          rec.end = rec.terminated = this.sched.step;
          this.log.push(rec);
          return reject(Object.assign(new Error('busy'), { kind: 'busy' }));
        }
        rec.held = this.sched.random() < this.server.mode.holdHelpers && (this.server.mode.holdWhich === 'any' || parsed?.method === 'tools/call');
        this.log.push(rec);
        this.peakServer = Math.max(this.peakServer, this.open('post'));
        const st = { rec, chunks: [] as string[] } as { rec: NativeRec; chunks: string[]; waiting?: { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }; plan?: Plan };
        streams.set(spec.id, st);
        (st as any).fail = reject;
        this.sched.add({
          label: `arrive:${rec.n}`,
          fire: () => {
            if (rec.cancelAsked !== undefined) return;
            rec.arrived = this.sched.step;
            this.server.arrivals.push({ body: parsed ?? {}, headers, method: spec.method, step: this.sched.step });
            let plan: Plan = spec.method !== 'POST' ? { status: 405, sse: false, messages: [], final: -1 } : this.server.answer(parsed ?? {}, headers, String(rec.n));
            let redirected = false;
            if (plan.status >= 300 && plan.status < 400 && this.redirectMode) {
              // Today's contract: a 307 re-POSTs the body, a 303 becomes a GET.
              this.server.arrivals.push({ body: plan.status === 307 ? (parsed ?? {}) : {}, headers, method: plan.status === 307 ? 'POST' : 'GET', step: this.sched.step, followed: true });
              redirected = true;
              plan = plan.status === 307 && parsed ? this.server.answer(parsed, headers, String(rec.n)) : { status: 405, sse: false, messages: [], final: -1 };
            }
            st.plan = plan;
            rec.plan = plan;
            const lines = plan.sse ? plan.messages.map((m) => `data: ${JSON.stringify(m)}\n\n`) : plan.messages.length ? [JSON.stringify(plan.messages[0])] : [];
            const full = lines.join('');
            // Chunk boundaries anywhere (one chunk in S2's mode); a held call's stream says nothing.
            let i = 0;
            if (this.server.mode.hold && parsed?.method === 'tools/call' && parsed.params?.name === 'slow') {
              // A held call: its pings, if any, then nothing more.
              const pings = plan.messages.filter((m) => m.method === 'ping').map((m) => `data: ${JSON.stringify(m)}\n\n`);
              if (pings.length && plan.sse) st.chunks.push(pings.join(''));
              (st as any).bounds = pings.reduce<number[]>((acc, l) => [...acc, (acc.at(-1) ?? 0) + l.length], []);
              (st as any).sent = 0;
              (st as any).holdMsgs = plan.messages.filter((m) => m.method === 'ping');
              i = full.length;
            }
            if (this.server.mode.oneChunk && i < full.length) {
              st.chunks.push(full);
              i = full.length;
            }
            while (i < full.length) {
              const len = 1 + Math.floor(this.sched.random() * Math.max(1, full.length / 2));
              st.chunks.push(full.slice(i, i + len));
              i += len;
            }
            if (!(st as any).holdMsgs) {
              (st as any).bounds = lines.reduce<number[]>((acc, l) => [...acc, (acc.at(-1) ?? 0) + l.length], []);
              (st as any).sent = 0;
            }
            this.sched.add({
              label: `head:${rec.n}`,
              fire: () => {
                if (rec.cancelAsked !== undefined) return;
                rec.head = this.sched.step;
                rec.status = plan.status;
                rec.redirected = redirected;
                const h: [string, string][] = [['content-type', plan.sse ? 'text/event-stream' : 'application/json']];
                if (plan.session) h.push(['mcp-session-id', plan.session]);
                resolve({ status: plan.status, statusText: '', headers: h, url: '', redirected });
              }
            });
          }
        });
      });
    return {
      fetch,
      read: (id: string) =>
        new Promise<Uint8Array>((resolve, reject) => {
          const st = streams.get(id);
          if (!st || st.rec.cancelAsked !== undefined) return reject(Object.assign(new Error('cancelled'), { kind: 'cancelled' }));
          st.waiting = { resolve, reject };
          this.sched.add({
            label: `chunk:${st.rec.n}`,
            fire: () => {
              if (st.rec.cancelAsked !== undefined || !st.waiting) return;
              const w = st.waiting;
              st.waiting = undefined;
              const next = st.chunks.shift();
              if (next === undefined) {
                if (this.server.mode.hold && st.rec.body?.method === 'tools/call' && st.rec.body.params?.name === 'slow') return void (st.waiting = w); // never ends
                // A JSON body's one message reaches the client only at the body's end.
                const plan = st.plan;
                if (plan && !plan.sse && plan.messages[0]) {
                  const m = plan.messages[0];
                  if (m.method === 'ping' && !st.rec.delivered.has(m.id)) st.rec.delivered.set(m.id, this.sched.step * 1000);
                  if (plan.final === 0 && st.rec.final === undefined) st.rec.final = this.sched.step * 1000;
                }
                return w.resolve(new Uint8Array(0));
              }
              (st as any).sent += next.length;
              // Which whole messages this chunk completes: their pings are delivered now.
              const bounds: number[] = (st as any).bounds;
              const plan = st.plan!;
              bounds.forEach((b, k) => {
                if (b <= (st as any).sent && (plan.sse || (st as any).holdMsgs)) {
                  const held: Msg[] | undefined = (st as any).holdMsgs;
                  const m = held ? held[k] : plan.sse ? plan.messages[k] : plan.messages[0];
                  if (m?.method === 'ping' && !st.rec.delivered.has(m.id)) st.rec.delivered.set(m.id, this.sched.step * 1000 + k);
                  if (!held && k === plan.final && st.rec.final === undefined) st.rec.final = this.sched.step * 1000 + k;
                }
              });
              w.resolve(enc.encode(next));
            }
          });
        }),
      cancel: (id: string) =>
        new Promise<void>((resolve) => {
          const st = streams.get(id);
          if (!st) return resolve();
          const rec = st.rec;
          if (rec.cancelAsked === undefined) {
            rec.cancelAsked = this.sched.step;
            rec.cancelAt = this.sched.now;
          }
          st.waiting?.reject(Object.assign(new Error('cancelled'), { kind: 'cancelled' }));
          st.waiting = undefined;
          if (rec.head === undefined) (st as any).fail(Object.assign(new Error('cancelled'), { kind: 'cancelled' }));
          const returned = () => {
            if (rec.end !== undefined) return;
            rec.end = this.sched.step;
            rec.endAt = this.sched.now;
            resolve();
          };
          if (!rec.held) {
            this.sched.add({ label: `cancel-done:${rec.n}`, fire: () => {
              rec.terminated ??= this.sched.step;
              returned();
            } });
            return;
          }
          // A held helper: net_cancel waits for it, for any time, unless the pass build detaches it at its
          // bound; a detached helper still counts as open until it ends (4.1).
          this.sched.timer(() => {
            rec.terminated ??= this.sched.step;
            returned();
          }, HELPER_HELD_MS);
          if (this.build === 'pass' && !mutant('no-detach')) this.sched.timer(() => {
            rec.detached = rec.end === undefined;
            returned();
          }, DETACH_MS);
        })
    };
  }

  /* ---------- processes ---------- */

  processes(): ProcessPort {
    let runs = 0;
    const live = new Map<string, { emit: (e: ProcessEvent) => void; out: string[]; flushing: boolean; exited: boolean; writes: { rec: NativeRec; done: () => void; fail: (e: unknown) => void }[]; reading: boolean; taken: number; epoch: number }>();
    const flush = (run: string) => {
      const p = live.get(run)!;
      if (p.flushing || !p.out.length) return;
      p.flushing = true;
      this.sched.add({ label: `line:${run}`, fire: () => {
        p.flushing = false;
        if (p.exited) return;
        const line = p.out.shift()!;
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined && ('result' in m || 'error' in m)) this.responded.set(`${this.epoch}:${m.id}`, this.sched.step);
          if (m.method === 'ping') this.pingDelivered.set(String(m.id), this.sched.step);
        } catch {
          /* not JSON */
        }
        p.emit({ t: 'out', line });
        flush(run);
      } });
    };
    const exit = (run: string, code: number | null) => {
      const p = live.get(run);
      if (!p || p.exited) return;
      p.exited = true;
      this.exits.push({ epoch: p.epoch, step: this.sched.step });
      for (const w of p.writes.splice(0)) {
        w.rec.end ??= this.sched.step;
        w.fail(Object.assign(new Error('gone'), { kind: 'not-running' }));
      }
      p.emit({ t: 'exit', code });
    };
    const take = (run: string, w: { rec: NativeRec; done: () => void; fail: (e: unknown) => void }) => {
      const p = live.get(run)!;
      this.sched.add({ label: `write-done:${w.rec.n}`, fire: () => {
        if (p.exited || !p.writes.includes(w)) return;
        if (this.server.mode.stopReading && p.taken >= 4) return; // it stopped reading: the write never ends
        p.writes.splice(p.writes.indexOf(w), 1);
        p.taken++;
        w.rec.arrived = this.sched.step;
        w.rec.end = this.sched.step;
        w.done();
        const body = w.rec.body ?? {};
        this.server.arrivals.push({ body, headers: {}, method: 'POST', step: this.sched.step });
        if (body.method === 'notifications/cancelled' || ('result' in body && body.method === undefined)) return;
        if (body.method === 'tools/call' && body.params?.name === 'crash') return exit(run, 3);
        // A held slow call: the server takes it and says nothing more.
        if (this.server.mode.hold && body.method === 'tools/call' && body.params?.name === 'slow') return;
        const plan = this.server.answer(body, {}, `w${w.rec.n}`);
        w.rec.plan = plan;
        for (const m of plan.messages) p.out.push(JSON.stringify(m));
        if (this.server.mode.idlePings && this.sched.random() < this.server.mode.idlePings) {
          this.server.pings.push({ id: `i${w.rec.n}`, on: `w${w.rec.n}`, afterFinal: false });
          p.out.push(JSON.stringify({ jsonrpc: '2.0', id: `i${w.rec.n}`, method: 'ping' }));
        }
        flush(run);
      } });
    };
    return {
      start: (_setup: ProcessSetup, onEvent) =>
        new Promise((resolve) => {
          const run = `p${++runs}`;
          this.epoch++;
          live.set(run, { emit: onEvent, out: [], flushing: false, exited: false, writes: [], reading: true, taken: 0, epoch: this.epoch });
          this.sched.add({ label: `started:${run}`, fire: () => resolve({ run }) });
        }),
      write: (run, bytes) =>
        new Promise<void>((resolve, reject) => {
          const p = live.get(run);
          const text = new TextDecoder().decode(bytes).trim();
          let body: Msg | undefined;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          const rec: NativeRec = { seq: this.tick(), n: this.log.length, kind: 'write', server: 'local', method: 'WRITE', body, headers: {}, start: this.sched.step, delivered: new Map(), epoch: this.epoch };
          this.log.push(rec);
          if (!p || p.exited) {
            rec.end = this.sched.step;
            return reject(Object.assign(new Error('gone'), { kind: 'not-running' }));
          }
          const w = { rec, done: resolve, fail: reject };
          p.writes.push(w);
          take(run, w);
        }),
      stop: async (run) => {
        this.sched.add({ label: `exit:${run}`, fire: () => exit(run, 0) });
      },
      forget: async () => {}
    };
  }
}

/* ---------- the driver and its evidence ---------- */

export interface Evidence {
  readonly seq: number;
  readonly step: number;
  readonly what: 'card' | 'yes' | 'call' | 'outcome' | 'stop-call' | 'revoke' | 'stop' | 'start' | 'started' | 'model';
  readonly failure?: string;
  readonly server?: string;
  readonly ok?: boolean;
  readonly token?: string;
  readonly tool?: string;
  readonly body?: string;
  readonly outcome?: CallOutcome;
}

export interface WireRun {
  readonly sched: Scheduler;
  readonly exe: FakeExe;
  readonly server: ScriptedServer;
  readonly evidence: Evidence[];
  /** The step where each mutation first changed behaviour. */
  readonly firstHit: number | undefined;
}

/** One seeded run: add the server, start it, then person actions among the native events. */
export interface WireOptions {
  readonly mode?: Partial<Mode>;
  readonly mutation?: string;
  readonly steps?: number;
  /** A named schedule in place of the random actions. */
  readonly schedule?: (d: Driver) => void;
  readonly build?: 'prepass' | 'pass';
  /** How many servers, s1 to sN, all speaking the same script (S10). */
  readonly servers?: number;
}

export async function wireRun(seed: number, options: WireOptions = {}): Promise<WireRun> {
  mutations.set(options.mutation ? [options.mutation] : []);
  const sched = new Scheduler(seed);
  const mode = modeOf(sched.random, options.mode);
  const server = new ScriptedServer(mode, sched.random);
  let tick = 0;
  const next = () => ++tick;
  const exe = new FakeExe(sched, server, next, options.build ?? 'prepass');
  const evidence: Evidence[] = [];
  let firstHit: number | undefined;
  sched.onStep((step) => {
    if (firstHit === undefined && options.mutation && mutations.hits(options.mutation) > 0) firstHit = step;
  });
  let addresses = 0;
  const client = await McpClient.open({
    store: memorySettingsStore(),
    processes: exe.processes(),
    net: exe.net(),
    addresses: { add: async () => ({ id: `addr-${++addresses}` }), remove: async () => {} },
    secrets: { delete: async () => {} },
    clock: sched.clock(),
    paths: { program: () => undefined, folder: () => undefined } as any,
    limits: { startMs: 60_000, listMs: 30_000 }
  });
  const ids = Array.from({ length: options.servers ?? 1 }, (_, i) => `s${i + 1}`);
  for (const id of ids) {
    const setup = mode.where === 'remote' ? { kind: 'remote' as const, id, label: `Scripted ${id}`, url: `https://${id}.example/mcp`, transport: 'http' as const, headers: [] } : { kind: 'local' as const, id, label: `Scripted ${id}`, program: 'node', args: [], cwd: '/', env: [], secrets: [] };
    await client.add({ setup, problems: [] });
  }
  const d = new Driver(sched, client, evidence, next, exe, server);
  for (const id of ids) sched.add({ label: `start:${id}`, fire: () => d.start(id) });
  if (options.schedule) options.schedule(d);
  else d.random(10);
  await sched.run(options.steps ?? 1500);
  if (options.mutation && firstHit === undefined && mutations.hits(options.mutation) > 0) firstHit = sched.step;
  mutations.clear();
  return { sched, exe, server, evidence, firstHit };
}

export class Driver {
  private n = 0;
  private readonly calls = new Map<string, AbortController>();
  readonly sched: Scheduler;
  readonly client: McpClient;
  readonly evidence: Evidence[];
  private readonly tick: () => number;
  readonly exe: FakeExe;
  readonly server: ScriptedServer;

  constructor(sched: Scheduler, client: McpClient, evidence: Evidence[], tick: () => number, exe: FakeExe, server: ScriptedServer) {
    this.sched = sched;
    this.client = client;
    this.evidence = evidence;
    this.tick = tick;
    this.exe = exe;
    this.server = server;
  }

  ready(id = 's1'): boolean {
    return this.client.get(id)?.phase === 'ready';
  }

  /** Ready, and (by the exe's own log) nothing of that server's still open: a call now would go out. */
  idle(id = 's1'): boolean {
    // Addresses are issued in the order the servers were added: s1 has addr-1.
    const mine = (x: NativeRec) => x.kind === 'write' || x.server === `addr-${id.slice(1)}`;
    return this.ready(id) && this.exe.log.every((x) => !mine(x) || x.end !== undefined || x.refused !== undefined);
  }

  /** Does `act` as an action of its own once `cond` holds after some step (a person waiting for what the
      screen shows). The waiting is no event, so it never holds back a timer. */
  when(label: string, cond: () => boolean, act: () => void, _tries?: number): void {
    let done = false;
    const check = (): void => {
      if (done || !cond()) return;
      done = true;
      this.sched.add({ label: `act:${label}`, rank: 0, fire: act });
    };
    this.sched.onStep(check);
    check();
  }

  /** A card shown now: its facts, kept for a Yes that may come later (S1). */
  card(tool: string, extra: Record<string, unknown> = {}, id = 's1'): { token: string; facts: NonNullable<ReturnType<McpClient['facts']>> } | undefined {
    const token = `t${++this.n}`;
    const facts = this.client.facts(id, tool, { text: token, ...extra });
    if (!facts) return undefined;
    this.note({ what: 'card', token, tool, body: facts.canonical, server: id });
    return { token, facts };
  }

  /** The Yes on a card shown earlier, and the call it allows. */
  yes(card: { token: string; facts: NonNullable<ReturnType<McpClient['facts']>> }, id = 's1'): void {
    const decision = mintDecision(card.facts, card.token, 'asked', false)!;
    this.note({ what: 'yes', token: card.token, tool: card.facts.tool, body: card.facts.canonical, server: id });
    const stop = new AbortController();
    this.calls.set(card.token, stop);
    this.note({ what: 'call', token: card.token, tool: card.facts.tool, server: id });
    const out = this.client.send(decision, stop.signal);
    void out.then((outcome) => this.note({ what: 'outcome', token: card.token, tool: card.facts.tool, outcome, server: id }));
  }

  stopAll(): void {
    for (const [token, c] of this.calls) {
      if (this.evidence.some((e) => e.what === 'outcome' && e.token === token)) continue;
      this.note({ what: 'stop-call', token });
      c.abort();
    }
  }

  /** A model fetch, as chat makes one (H5). */
  model(): void {
    const ok = this.exe.modelFetch();
    this.note({ what: 'model', ok });
  }

  private note(e: Omit<Evidence, 'seq' | 'step'>): void {
    this.evidence.push({ seq: this.tick(), step: this.sched.step, ...e });
  }

  start(id = 's1'): void {
    this.note({ what: 'start', server: id });
    void this.client.start(id).then((reply) => this.note({ what: 'started', server: id, ...(reply.kind === 'failed' ? { failure: reply.failure.kind } : {}), ok: reply.kind === 'ready' }));
  }

  stop(id = 's1'): void {
    this.note({ what: 'stop', server: id });
    void this.client.stop(id);
  }

  /** A call with a fresh Yes: a unique token in its arguments, so every handoff names its decision. */
  call(tool = 'echo', extra: Record<string, unknown> = {}, revokeRightAfter = false, id = 's1'): void {
    const token = `t${++this.n}`;
    const args = { text: token, ...extra };
    const facts = this.client.facts(id, tool, args);
    if (!facts) return;
    const decision = mintDecision(facts, token, 'asked', false)!;
    this.note({ what: 'card', token, tool, body: facts.canonical, server: id });
    this.note({ what: 'yes', token, tool, body: facts.canonical, server: id });
    const stop = new AbortController();
    this.calls.set(token, stop);
    this.note({ what: 'call', token, tool, server: id });
    // The model's own arguments as the journal would pass them along: here they differ from the Yes, so a
    // body built from them (a named mutation) shows.
    const out = this.client.send(decision, stop.signal, { ...args, model: 'unchecked' });
    // A revoke landing right after the call, in the same task (H3's schedule for a gap before the handoff).
    if (revokeRightAfter) {
      this.client.revoke(id, tool, 'never');
      this.note({ what: 'revoke', tool, server: id });
    }
    void out.then((outcome) => this.note({ what: 'outcome', token, tool, outcome, server: id }));
  }

  stopCall(): void {
    const live = [...this.calls].filter(([t]) => !this.evidence.some((e) => e.what === 'outcome' && e.token === t));
    if (!live.length) return;
    const [token, c] = live[Math.floor(this.sched.random() * live.length)]!;
    this.note({ what: 'stop-call', token });
    c.abort();
  }

  /** `k` random actions spread among the native events. */
  random(k: number): void {
    for (let i = 0; i < k; i++) {
      const x = this.sched.random();
      const action = x < 0.55 ? 'call' : x < 0.7 ? 'stop-call' : x < 0.78 ? 'mirror' : x < 0.84 ? 'stop-start' : x < 0.87 ? 'revoke' : 'call';
      let tries = 0;
      const fire = (): void => {
        // An action waits for the server to be Ready, as a person would see it, a few times.
        if (this.client.get('s1')?.phase !== 'ready' && tries++ < 30 && action !== 'stop-call') return void this.sched.addLater({ label: `act:${action}`, rank: 0, fire }, 3 + Math.floor(this.sched.random() * 8));
        if (action === 'call') this.call(this.sched.random() < 0.3 ? 'slow' : 'echo');
        else if (action === 'stop-call') this.stopCall();
        else if (action === 'mirror') this.call('mirror', { region: this.sched.random() < 0.3 ? 'café' : 'eu-1' });
        else if (action === 'revoke') this.call('echo', {}, true);
        else {
          this.stop();
          this.sched.add({ label: 'act:restart', fire: () => this.start() });
        }
      };
      this.sched.addLater({ label: `act:${action}`, rank: 0, fire }, 5 + Math.floor(this.sched.random() * 120));
    }
  }
}
