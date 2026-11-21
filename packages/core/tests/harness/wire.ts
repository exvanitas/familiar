// The wire harness (docs/mcp-design.md 7.2): the real client (McpClient, its links and the exchange machine)
// against a scripted fake server, through an unkind fake exe, every native answer an event the seeded
// scheduler picks. The fake exe keeps its own log of every native request; the driver keeps the evidence
// log of what the person did. The checks (checks.ts) read only those two logs.

import { mutant, mutations } from '../../src/mutations.ts';
import { evidenceControls } from './evidence-controls.ts';
import { McpClient } from '../../src/mcp/client.ts';
import { mintDecision } from '../../src/mcp/decision.ts';
import type { NetHead, NetPort, NetSpec } from '../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../../src/mcp/process.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import type { CallOutcome } from '../../src/mcp/types.ts';
import type { LcEvent, LcState } from '../../src/mcp/wire/lifecycle.ts';
import { Scheduler } from './sched.ts';

const enc = new TextEncoder();
/** The byte offsets by which each event can be dispatched: with CRLF line ends, the blank line's CR
    already ends it, so its LF needn't have arrived. */
const dispatchable = (events: readonly Uint8Array[], nl: string): number[] => {
  let at = 0;
  return events.map((e) => {
    at += e.length;
    return nl === '\r\n' ? at - 1 : at;
  });
};
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const MODERN = '2026-07-28';
/** H11's fixed values for a mirrored string: plain, non-ASCII, empty, edge whitespace, sentinel-shaped, a
    lone surrogate (refused), one past 8 KiB once encoded (refused), and the two at the bound of the whole
    line `Mcp-Param-Region: value`: 8,192 bytes (sent) and one more (refused, though the value alone fits). */
export const MIRROR_VECTORS = ['eu-1', 'café', '', ' edge ', '=?base64?eHk=?=', '\uD800x', 'é'.repeat(4000), 'b'.repeat(8192 - 'Mcp-Param-Region: '.length), 'b'.repeat(8193 - 'Mcp-Param-Region: '.length)];

/** The exe's admission (4.1): 32 open requests in all, server requests at most 24 in the pass build. */
export const EXE_TOTAL = 32;
export const EXE_SERVER_CAP = 24;
/** The pass build's detach bound for a held helper, and how long the harness holds one. */
export const DETACH_MS = 1_000;
/** Past this many detached server helpers, the pass build refuses new server fetches busy. */
export const EXE_DETACHED_SERVER_HELPERS = 8;
/** The page's interim bound on a local write (4.3), as the contract gives it. */
export const INTERIM_WRITE_MS = 10_000;
/** The exe's own write bound in the pass build, and how long it drains a process's output at its exit. */
export const EXE_WRITE_BOUND_MS = 10_000;
export const EXE_EXIT_DRAIN_MS = 2_000;
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
  readonly session404: 'none' | 'once' | 'twice' | 'again' | 'always' | 'calls' | 'refresh' | 'retry';
  /** After a session drop, the server has turned modern-only: its re-handshake is refused -32022 (S15). */
  readonly modernAfterDrop: boolean;
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
  /** A call's answer begins with a message the client's parser rejects, then its pings: by default one with
      no `jsonrpc`, or another of 3.10's rejections by name (INVALID). */
  readonly invalidFirst?: boolean | keyof typeof INVALID;
  /** A list_changed ahead of the first tools/list answer of each session, its variant flipped (S14). */
  readonly changeOnList: boolean;
  /** How often a cancelled request's helper is held, for any time (H4). */
  readonly holdHelpers: number;
  /** How often the exe refuses a net_cancel once, keeping the request alive. */
  readonly refuseCancel: number;
  /** The exe refuses every net_cancel of a call, keeping it alive (cleanup exhausted). */
  readonly refuseCancelAlways: boolean;
  /** Which request's net_cancels refuseCancelAlways refuses: a call's by default, or the handshake's
      `initialize` (S24, a start parked between its handshake's steps). */
  readonly refuseCancelOf?: 'tools/call' | 'initialize';
  /** How often an answer comes with a media type other than the two exact ones: lookalike or oversized. */
  readonly oddMedia: number;
  /** A local modern-only server answers its list -32022, then exits. */
  readonly modernListExit: boolean;
  /** Relisting gives the same tools with their properties in another order, after a list_changed that
      changes nothing else. */
  readonly reorder: boolean;
  /** With changeOnList: which first page of a session carries the list_changed (1, the initial walk's;
      2, the first refresh's). */
  readonly changeOnListAt?: number;
  /** Which requests' helpers may be held: any, or only calls (S8, S10). */
  readonly holdWhich: 'any' | 'calls';
  /** Local: the exe acknowledges each write only after the server's answer to it has reached the client
      (S27: a Start answers Ready while its last write is still unacknowledged). */
  readonly lateAcks?: boolean;
  /** Local, with lateAcks: an idle ping delivered the moment a call's write is acknowledged, in the very
      window between its exchange's drain and anything waiting on that drain (S30). */
  readonly pingAtDrain?: boolean;
  /** Local, with lateAcks: a list_changed written right after the first tools/list answer, before its write
      is acknowledged (a notice during Start's final drain). */
  readonly noticeAtDrain?: boolean;
  /** Local: the exe refuses every server_stop, and the process doesn't exit. */
  readonly refuseStop?: boolean;
  /** With more than one page: the echo tool (the one a list_changed changes) on the walk's last page, the
      rest on its first, so a catalog read from first pages alone never sees it. */
  readonly echoLast?: boolean;
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
    modernAfterDrop: false,
    refuseCancel: r() < 0.1 ? 0.3 : 0,
    refuseCancelAlways: false,
    oddMedia: 0,
    modernListExit: false,
    reorder: false,
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
  ...(era !== 'legacy'
    ? [
        { name: 'mirror', description: 'Mirror.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, region: { type: 'string', 'x-mcp-header': 'Region' } } } },
        { name: 'mirror3', description: 'Mirror, with a $ref in its data.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, region: { type: 'string', 'x-mcp-header': 'Region' }, opts: { type: 'object', default: { $ref: '#/properties/region' }, examples: [{ $ref: '#/properties/region' }] } } } },
        { name: 'mirror2', description: 'Mirror, typed.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, count: { type: 'integer', 'x-mcp-header': 'Count' }, flag: { type: 'boolean', 'x-mcp-header': 'Flag' } } } }
      ]
    : [])
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
  private changedSince = false;
  private readonly firstPages = new Map<number, number>();
  /** Set once the server has answered in a way after which it exits (modernListExit). */
  exitAfter = false;
  private lists: number | undefined;
  /** Its tools' variant: a list_changed it sends changes the echo tool's description (S1). */
  variant = 'a';

  constructor(mode: Mode, r: () => number) {
    this.mode = mode;
    this.r = r;
  }

  /** The tools on one page of a walk: all on the first, unless echoLast puts echo on the last. */
  private onPage(page: number): Msg[] {
    const all = tools(this.mode.era, this.variant);
    if (!this.mode.echoLast || this.mode.pages < 2) return page === 0 ? all : [];
    return page === this.mode.pages - 1 ? all.filter((t) => t.name === 'echo') : page === 0 ? all.filter((t) => t.name !== 'echo') : [];
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
      if (m.modernAfterDrop && this.drops > 0) return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [MODERN] } } }], 400);
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
        // Every call drops the session; pages never do (S17).
        (m.session404 === 'calls' && body.method === 'tools/call') ||
        // The first page after the initial walk (a refresh) drops it (S16).
        (m.session404 === 'refresh' && this.drops === 0 && body.method === 'tools/list' && (this.lists ?? 0) >= 1 && body.params?.cursor === undefined) ||
        // The first page of the walk a list_changed made the client start again (a 404 on its retry).
        (m.session404 === 'retry' && this.drops === 0 && body.method === 'tools/list' && this.changedSince && body.params?.cursor === undefined) ||
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
    if (body.method === 'tools/list' && body.params?.cursor === undefined) this.firstPages.set(this.session, (this.firstPages.get(this.session) ?? 0) + 1);
    if (body.method === 'tools/list' && m.changeOnList && !modernReq && this.changedThisSession !== this.session && (this.firstPages.get(this.session) ?? 0) >= (m.changeOnListAt ?? 1)) {
      this.changedThisSession = this.session;
      this.changedSince = true;
      const page = Number(body.params?.cursor ?? 0);
      const next = page + 1 < m.pages ? { nextCursor: String(page + 1) } : {};
      const listed = { jsonrpc: '2.0', id: body.id, result: { tools: this.onPage(page), ...next } };
      this.variant = this.variant === 'a' ? 'b' : 'a';
      return { status: 200, sse: true, messages: [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, listed], final: 1 };
    }
    if (body.method === 'tools/list' && m.modernListExit && modernReq) {
      this.exitAfter = true;
      return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2030-01-01'] } } }]);
    }
    if (body.method === 'tools/list') {
      if (body.params?.cursor === undefined) this.lists = (this.lists ?? 0) + 1;
      const page = Number(body.params?.cursor ?? 0);
      const next = page + 1 < m.pages ? { nextCursor: String(page + 1) } : {};
      const listed = this.onPage(page);
      return json([{ jsonrpc: '2.0', id: body.id, result: { tools: m.reorder ? listed.map((t) => shuffled(t, this.r)) : listed, ...next, ...complete } }]);
    }
    if (body.method === 'tools/call') {
      const msgs: Msg[] = [];
      if (this.lastId !== undefined && this.lastId !== body.id && this.r() < m.staleId) msgs.push({ jsonrpc: '2.0', id: this.lastId, result: { content: [{ type: 'text', text: 'stale' }], ...complete } });
      this.lastId = body.id;
      const n = m.pings === 40 ? 40 : m.pings;
      // A message the client's parser rejects, ahead of the pings (S37): the exchange ends there.
      if (m.invalidFirst && !modernReq) msgs.push(structuredClone(INVALID[m.invalidFirst === true ? 'no-jsonrpc' : m.invalidFirst]) as Msg);
      if (!modernReq) for (let i = 0; i < n; i++) msgs.push(this.ping(on));
      if (!modernReq && this.r() < m.listChanged) {
        if (!m.reorder) this.variant = this.variant === 'a' ? 'b' : 'a';
        msgs.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
      if (modernReq && this.r() < 0.2) msgs.push({ jsonrpc: '2.0', id: 'stray', method: 'ping' }, { jsonrpc: '2.0', id: 'ask', method: 'sampling/createMessage', params: {} });
      if (!modernReq && this.r() < m.pingWithFinal) msgs.push(this.ping(on));
      const text = String(body.params?.arguments?.text ?? '');
      // A modern server checks each mirrored header against the body (-32020 on a mismatch).
      if (modernReq && m.where === 'remote' && headerMismatch(body, headers, tools(m.era, this.variant))) return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'header mismatch' } }]);
      const result = modernReq && this.r() < m.inputRequired ? { resultType: 'input_required', inputRequests: {} } : { content: [{ type: 'text', text: `ran ${body.params?.name} ${text} — café ✓ 𝄞` }], ...complete };
      if (this.r() >= m.earlyEnd) msgs.push({ jsonrpc: '2.0', id: body.id, result });
      if (!modernReq && this.r() < 0.1) msgs.push(this.ping(on, true));
      if (m.where === 'remote' && this.r() < m.redirect) return { status: this.r() < 0.5 ? 307 : 303, sse: false, messages: [], final: -1, location: '/elsewhere' };
      return { ...json(msgs), sse: m.where === 'local' ? false : msgs.length > 1 || this.r() < m.sse };
    }
    if (body.method === 'ping') return json([{ jsonrpc: '2.0', id: body.id, result: {} }]);
    return json([{ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }]);
  }
}

/** The server's own reading of the mirrored headers: what each declared argument must arrive as. */
export function headerMismatch(body: Msg, headers: Record<string, string>, listed: readonly Msg[]): boolean {
  const schema = listed.find((t) => t.name === body.params?.name)?.inputSchema;
  for (const [k, p] of Object.entries((schema?.properties ?? {}) as Record<string, Msg>)) {
    const name = p['x-mcp-header'];
    if (typeof name !== 'string') continue;
    const v = body.params?.arguments?.[k];
    const got = headers[`mcp-param-${name.toLowerCase()}`];
    if (v === undefined || v === null) {
      if (got !== undefined) return true;
      continue;
    }
    const text = typeof v === 'string' ? v : String(v);
    const plain = typeof v === 'string' ? v !== '' && v === v.trim() && /^[\x20-\x7e\t]*$/.test(v) && !(v.startsWith('=?base64?') && v.endsWith('?=')) : true;
    const want = plain ? text : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
    if (got !== want) return true;
  }
  return false;
}

/** A tool with its schema's properties in another order (and nothing else changed). */
function shuffled(t: Msg, r: () => number): Msg {
  const props = Object.entries((t.inputSchema?.properties ?? {}) as Record<string, unknown>);
  for (let i = props.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [props[i], props[j]] = [props[j]!, props[i]!];
  }
  return { ...t, inputSchema: { ...t.inputSchema, properties: Object.fromEntries(props) } };
}

/** Messages 3.10's shape rules reject, one per rule: the parser ends its exchange at any of them. None is a
    response to the call, so none is taken for its final. */
export const INVALID = {
  'no-jsonrpc': { method: 'notes/garbage', params: { note: 'no jsonrpc member' } },
  'wrong-version': { jsonrpc: '1.0', method: 'notes/garbage', params: {} },
  'array-params': { jsonrpc: '2.0', method: 'notes/garbage', params: [1, 2] },
  'long-method': { jsonrpc: '2.0', method: 'm'.repeat(129) },
  'bad-request-id': { jsonrpc: '2.0', id: { not: 'an id' }, method: 'ping' },
  'both-members': { jsonrpc: '2.0', id: 'zz', result: {}, error: { code: 1, message: 'both' } },
  'bad-error': { jsonrpc: '2.0', id: 'zz', error: { code: 1.5, message: 'not an integer code' } },
  'too-deep': { jsonrpc: '2.0', method: 'notes/garbage', params: { deep: JSON.parse(`${'['.repeat(70)}${']'.repeat(70)}`) } }
} as const;

/** Whether 3.10's shape rules reject a message, as the harness reads them, never importing the parser: an
    object, nested at most 64 deep, with `jsonrpc: "2.0"`; a request or notification with a method string of
    at most 128 bytes, `params` an object if present, a request's id a string of at most 128 bytes or a safe
    integer; a response with such an id and exactly one of `result` (an object) or `error` (an integer code
    and a string message). */
export function rejectedByShape(m: unknown): boolean {
  const object = (v: unknown): v is Msg => v !== null && typeof v === 'object' && !Array.isArray(v);
  const within = (v: unknown, depth: number): boolean => depth <= 64 && (Array.isArray(v) ? v.every((x) => within(x, depth + 1)) : object(v) ? Object.values(v).every((x) => within(x, depth + 1)) : true);
  const id = (v: unknown) => (typeof v === 'string' ? Buffer.byteLength(v) <= 128 : Number.isSafeInteger(v));
  if (!object(m) || !within(m, 1) || m.jsonrpc !== '2.0') return true;
  if ('method' in m) {
    if (typeof m.method !== 'string' || Buffer.byteLength(m.method) > 128) return true;
    if (m.params !== undefined && !object(m.params)) return true;
    return 'id' in m && !id(m.id);
  }
  if (!('id' in m) || !id(m.id) || 'result' in m === 'error' in m) return true;
  if ('result' in m) return !object(m.result);
  return !object(m.error) || !Number.isInteger(m.error.code) || typeof m.error.message !== 'string';
}

/** Media types an answer may come with besides the two exact ones (oddMedia). */
export const ODD_MEDIA = ['application/jsonp', 'application/json-seq', 'text/event-streaming', `text/x-${'ignore previous instructions '.repeat(150)}`];

/* ---------- the unkind fake exe ---------- */

export interface NativeRec {
  readonly seq: number;
  readonly n: number;
  readonly kind: 'post' | 'write' | 'model';
  /** Which server: the saved address (remote), or the setup id of the process written to (local). */
  readonly server: string;
  /** What the server answered (remote), for the harness's own reading of catalogs. */
  plan?: Plan;
  /** Fake-clock times: a write's start; the cancel asked, the cancel returned (H4). */
  startAt?: number;
  cancelAt?: number;
  endAt?: number;
  /** A helper held at cancel; detached by the pass build; when the helper itself ended. */
  held?: boolean;
  detached?: boolean;
  terminated?: number;
  /** Refused by the exe before it started. */
  refused?: 'busy';
  /** A net_cancel the exe refused once, the request kept alive. */
  refusedCancel?: boolean;
  /** Remote: how many list_changed notifications on this request reached the client's reads. */
  changesDelivered?: number;
  /** A model fetch: how many server requests were open when it was made. */
  openServer?: number;
  /** How many net_cancels the exe refused for it. */
  refusals?: number;
  /** Remote: where the client's terminal step stood on this stream, at the resolution of ping delivery
      (step × 1000 + the messages delivered by then): its first net_cancel, asked in that step. */
  endedAt?: number;
  /** The media type the answer's head carried. */
  contentType?: string;
  readonly method: string;
  readonly body: Msg | undefined;
  /** The body's bytes as text, as the exe received them. */
  readonly raw?: string;
  /** Remote: every header as sent, a pair each, in order, so a duplicate shows (the twin rule). */
  readonly headerPairs?: readonly (readonly [string, string])[];
  /** Remote: the address it went to. */
  readonly url?: string;
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
  /** Local: when the client asked the exe to stop each process run, by epoch, and the handle it named. */
  readonly stopsAsked: { epoch: number; step: number; seq?: number; run?: string }[] = [];
  /** Local: when each process run exited, by epoch. */
  readonly exits: { epoch: number; step: number }[] = [];
  /** Local: each process start the exe admitted, by epoch, whether or not any write followed (H2), and the
      handle the exe gave it. */
  readonly processStarts: { epoch: number; seq: number; step: number; server: string; run: string; answered?: number }[] = [];
  /** Holds the next process start's answer until `releaseStart()` (S11, Stop during a pending start). */
  holdNextStart = false;
  releaseStart?: () => void;
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
    if (kind === 'post' && this.build === 'pass' && this.log.filter((x) => x.kind === 'post' && x.detached && x.terminated === undefined).length >= EXE_DETACHED_SERVER_HELPERS) return false;
    return true;
  }

  /** A model fetch, as chat makes one: refused busy only if the exe is full. Held open till the run ends. */
  modelFetch(): boolean {
    const rec: NativeRec = { seq: this.tick(), n: this.log.length, kind: 'model', server: 'model', method: 'POST', body: undefined, headers: {}, start: this.sched.step, delivered: new Map(), epoch: 0 };
    if (!this.admits('model')) rec.refused = 'busy';
    rec.openServer = this.open('post');
    this.log.push(rec);
    return !rec.refused;
  }

  /* ---------- net ---------- */

  net(): NetPort {
    const streams = new Map<string, { rec: NativeRec; chunks: Uint8Array[]; waiting?: { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void } ; plan?: Plan }>();
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
        const rec: NativeRec = { seq: this.tick(), n: this.log.length, kind: 'post', server: spec.address, url: spec.url, method: spec.method, body: parsed, raw: text, headers, headerPairs: spec.headers.map(([k, v]) => [k, v] as const), start: this.sched.step, delivered: new Map(), epoch: this.epoch };
        if (!this.admits('post')) {
          rec.refused = 'busy';
          rec.end = rec.terminated = this.sched.step;
          this.log.push(rec);
          return reject(Object.assign(new Error('busy'), { kind: 'busy' }));
        }
        rec.held = this.sched.random() < this.server.mode.holdHelpers && (this.server.mode.holdWhich === 'any' || parsed?.method === 'tools/call');
        this.log.push(rec);
        this.peakServer = Math.max(this.peakServer, this.open('post'));
        const st = { rec, chunks: [] as Uint8Array[] } as { rec: NativeRec; chunks: Uint8Array[]; waiting?: { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }; plan?: Plan };
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
            // Bytes, as the exe hands them over: line ends CR, LF or CRLF (as a server may write them), and
            // chunk boundaries anywhere, through a multibyte character or between a CR and its LF.
            const nl = ['\n', '\r', '\r\n'][Math.floor(this.sched.random() * 3)]!;
            // An event's data over two lines (JSON may break between tokens), so a line end split badly shows.
            const event = (m: Msg) => {
              const text = JSON.stringify(m);
              const at = text.indexOf(',"');
              return at < 0 ? `data: ${text}${nl}${nl}` : `data: ${text.slice(0, at + 1)}${nl}data: ${text.slice(at + 1)}${nl}${nl}`;
            };
            const lines = (plan.sse ? plan.messages.map(event) : plan.messages.length ? [JSON.stringify(plan.messages[0])] : []).map((l) => enc.encode(l));
            const full = concat(lines);
            // Chunk boundaries anywhere (one chunk in S2's mode); a held call's stream says nothing.
            let i = 0;
            if (this.server.mode.hold && parsed?.method === 'tools/call' && parsed.params?.name === 'slow') {
              // A held call: its pings, if any, then nothing more.
              const pings = plan.messages.filter((m) => m.method === 'ping').map((m) => enc.encode(event(m)));
              if (pings.length && plan.sse) st.chunks.push(concat(pings));
              (st as any).bounds = dispatchable(pings, nl);
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
              (st as any).bounds = plan.sse ? dispatchable(lines, nl) : lines.reduce<number[]>((acc, l) => [...acc, (acc.at(-1) ?? 0) + l.length], []);
              (st as any).sent = 0;
            }
            this.sched.add({
              label: `head:${rec.n}`,
              fire: () => {
                if (rec.cancelAsked !== undefined) return;
                rec.head = this.sched.step;
                rec.status = plan.status;
                rec.redirected = redirected;
                // An answer of another media type, now and then: a lookalike, or one oversized.
                const odd = this.server.mode.oddMedia && plan.messages.length && this.sched.random() < this.server.mode.oddMedia ? ODD_MEDIA[Math.floor(this.sched.random() * ODD_MEDIA.length)] : undefined;
                rec.contentType = odd ?? (plan.sse ? 'text/event-stream' : 'application/json');
                const h: [string, string][] = [['content-type', rec.contentType]];
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
                  if (m.method === 'notifications/tools/list_changed') st.rec.changesDelivered = (st.rec.changesDelivered ?? 0) + 1;
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
                  if (m?.method === 'notifications/tools/list_changed' && !((st as any).changesSeen ??= new Set<number>()).has(k)) {
                    (st as any).changesSeen.add(k);
                    st.rec.changesDelivered = (st.rec.changesDelivered ?? 0) + 1;
                  }
                  if (!held && k === plan.final && st.rec.final === undefined) st.rec.final = this.sched.step * 1000 + k;
                }
              });
              w.resolve(next);
            }
          });
        }),
      cancel: (id: string) =>
        new Promise<void>((resolve, refuse) => {
          const st = streams.get(id);
          if (!st) return resolve();
          const rec = st.rec;
          // The client's terminal position, first asked: every message this stream delivered by then counts as
          // before it, whatever the cancel's fate.
          if (rec.endedAt === undefined) {
            const plan = st.plan;
            const bounds: number[] | undefined = (st as any).bounds;
            const sent: number = (st as any).sent ?? 0;
            const whole = plan && (plan.sse || (st as any).holdMsgs) && bounds ? bounds.filter((b) => b <= sent).length : 0;
            // Never past the stream's own terminal message: one delivered after it in the same chunk came after
            // the client's end, not before it. A stream with no final response (`final` -1) has no such bound.
            // The client's actual terminal position: the final response, or the first message its parser
            // rejects (by 3.10's shape rules, read here on their own), whichever comes first.
            const rejected = plan && !(st as any).holdMsgs && !evidenceControls.finalOnly ? plan.messages.findIndex(rejectedByShape) : -1;
            const final = plan && !(st as any).holdMsgs && plan.final !== undefined && (plan.final >= 0 || evidenceControls.finalSentinel) ? plan.final : Infinity;
            const terminal = rejected >= 0 ? Math.min(rejected, final) : final;
            rec.endedAt = this.sched.step * 1000 + Math.min(whole, terminal);
          }
          // The exe may refuse a net_cancel and keep the request alive: once per request, as a passing fault.
          // A refused request stays alive as it was, delivering what it would: refused isn't cancelled.
          if ((this.server.mode.refuseCancelAlways && rec.body?.method === (this.server.mode.refuseCancelOf ?? 'tools/call')) || (!rec.refusedCancel && this.server.mode.refuseCancel && this.sched.random() < this.server.mode.refuseCancel)) {
            rec.refusedCancel = true;
            rec.refusals = (rec.refusals ?? 0) + 1;
            return void this.sched.add({ label: `cancel-refused:${rec.n}`, fire: () => refuse(Object.assign(new Error('refused'), { kind: 'failed' })) });
          }
          // The client's next try is a net_cancel of its own: its bound runs from now.
          if (rec.refusedCancel) rec.cancelAt = this.sched.now;
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
          }, mutant('late-detach') ? DETACH_MS * 1.5 : DETACH_MS);
        })
    };
  }

  /* ---------- processes ---------- */

  processes(): ProcessPort {
    let runs = 0;
    const live = new Map<string, { emit: (e: ProcessEvent) => void; out: string[]; flushing: boolean; exited: boolean; exiting?: boolean; writes: { rec: NativeRec; done: () => void; fail: (e: unknown) => void }[]; reading: boolean; taken: number; epoch: number; server: string; noticed?: boolean }>();
    const flush = (run: string) => {
      const p = live.get(run)!;
      if (p.flushing || !p.out.length) return;
      p.flushing = true;
      this.sched.add({ label: `line:${run}`, fire: () => {
        p.flushing = false;
        if (p.exited || !p.out.length) return;
        deliver(run, p.out.shift()!);
        flush(run);
      } });
    };
    const deliver = (run: string, line: string) => {
      const p = live.get(run)!;
      try {
        const m = JSON.parse(line);
        // Keyed by the process that sent it, never by whichever process started last.
        if (m.id !== undefined && ('result' in m || 'error' in m)) this.responded.set(`${p.epoch}:${m.id}`, this.sched.step);
        if (m.method === 'ping') this.pingDelivered.set(String(m.id), this.sched.step);
      } catch {
        /* not JSON */
      }
      p.emit({ t: 'out', line });
    };
    const exit = (run: string, code: number | null) => {
      const p = live.get(run);
      if (!p || p.exited || p.exiting) return;
      // As the exe does: the output already written drains before the exit is reported, for at most 2 s;
      // what's left then is dropped.
      if (p.out.length) {
        p.exiting = true;
        let cut = false;
        const cancel = this.sched.timer(() => {
          cut = true;
          p.out.length = 0;
          finish(run, code);
        }, EXE_EXIT_DRAIN_MS);
        const drain = (): void => void this.sched.add({ label: `drain:${run}`, fire: () => {
          if (cut) return;
          if (p.out.length) deliver(run, p.out.shift()!);
          if (p.out.length) return drain();
          cancel();
          finish(run, code);
        } });
        return drain();
      }
      finish(run, code);
    };
    const finish = (run: string, code: number | null) => {
      const p = live.get(run)!;
      if (p.exited) return;
      p.exited = true;
      this.exits.push({ epoch: p.epoch, step: this.sched.step });
      for (const w of p.writes.splice(0)) {
        w.rec.end ??= this.sched.step;
        w.rec.endAt ??= this.sched.now;
        w.fail(Object.assign(new Error('gone'), { kind: 'not-running' }));
      }
      p.emit({ t: 'exit', code });
    };
    const take = (run: string, w: { rec: NativeRec; done: () => void; fail: (e: unknown) => void }) => {
      const p = live.get(run)!;
      this.sched.add({ label: `write-done:${w.rec.n}`, fire: () => {
        // A process the exe is ending reads nothing more.
        if (p.exited || p.exiting || !p.writes.includes(w)) return;
        if (this.server.mode.stopReading && p.taken >= 4) {
          // It stopped reading: the write never ends. In the pass build the exe's own write bound, armed at
          // the write's start, ends the run (the process killed); in the pre-pass build only the page's does.
          return;
        }
        p.taken++;
        w.rec.arrived = this.sched.step;
        const ack = () => {
          if (p.exited || !p.writes.includes(w)) return;
          p.writes.splice(p.writes.indexOf(w), 1);
          w.rec.end = this.sched.step;
          w.rec.endAt = this.sched.now;
          w.done();
          if (this.server.mode.pingAtDrain && w.rec.body?.method === 'tools/call') {
            const id = `i${w.rec.n}d`;
            this.server.pings.push({ id, on: `w${w.rec.n}`, afterFinal: false });
            // After the write's own release (queued first, when it resolved), before what that release wakes.
            queueMicrotask(() => !p.exited && deliver(run, JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })));
          }
        };
        // Late acknowledgements: the write ends only once everything the server wrote back has been read.
        if (this.server.mode.lateAcks) {
          const notice = this.server.mode.noticeAtDrain && w.rec.body?.method === 'tools/list' && !p.noticed;
          const late = (): void =>
            void this.sched.add({
              label: `ack:${w.rec.n}`,
              fire: () => {
                if (p.out.length || p.flushing) return late();
                // A notice of changed tools, written after the list's answer and before its write is acknowledged.
                if (notice && !p.noticed) {
                  p.noticed = true;
                  this.server.variant = this.server.variant === 'a' ? 'b' : 'a';
                  p.out.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
                  flush(run);
                  return late();
                }
                ack();
              }
            });
          late();
        } else ack();
        const body = w.rec.body ?? {};
        this.server.arrivals.push({ body, headers: {}, method: 'POST', step: this.sched.step });
        if (body.method === 'notifications/cancelled' || ('result' in body && body.method === undefined)) return;
        if (body.method === 'tools/call' && body.params?.name === 'crash') return exit(run, 3);
        // A held slow call: the server takes it and says nothing more.
        if (this.server.mode.hold && body.method === 'tools/call' && body.params?.name === 'slow') return;
        const plan = this.server.answer(body, {}, `w${w.rec.n}`);
        w.rec.plan = plan;
        // A server that answers and then exits (modernListExit): the exit comes a little after its line.
        if (this.server.exitAfter) {
          this.server.exitAfter = false;
          for (const m of plan.messages) p.out.push(JSON.stringify(m));
          flush(run);
          this.sched.add({ label: `exit-after:${run}`, fire: () => this.sched.add({ label: `exit:${run}`, fire: () => exit(run, 0) }) });
          return;
        }
        for (const m of plan.messages) p.out.push(JSON.stringify(m));
        if (this.server.mode.idlePings && this.sched.random() < this.server.mode.idlePings) {
          this.server.pings.push({ id: `i${w.rec.n}`, on: `w${w.rec.n}`, afterFinal: false });
          p.out.push(JSON.stringify({ jsonrpc: '2.0', id: `i${w.rec.n}`, method: 'ping' }));
        }
        flush(run);
      } });
    };
    return {
      start: (setup: ProcessSetup, onEvent) =>
        new Promise((resolve) => {
          const run = `p${++runs}`;
          this.epoch++;
          const admitted: { epoch: number; seq: number; step: number; server: string; run: string; answered?: number } = { epoch: this.epoch, seq: this.tick(), step: this.sched.step, server: setup.id, run };
          this.processStarts.push(admitted);
          live.set(run, { emit: onEvent, out: [], flushing: false, exited: false, writes: [], reading: true, taken: 0, epoch: this.epoch, server: setup.id });
          const answer = () => this.sched.add({ label: `started:${run}`, fire: () => {
            admitted.answered = this.sched.step;
            resolve({ run });
          } });
          if (!this.holdNextStart) return answer();
          this.holdNextStart = false;
          this.releaseStart = () => {
            this.releaseStart = undefined;
            answer();
          };
        }),
      write: (run, bytes) =>
        new Promise<void>((resolve, reject) => {
          const p = live.get(run);
          // The bytes whole, line end included: a write missing its newline must show.
          const text = new TextDecoder().decode(bytes);
          let body: Msg | undefined;
          try {
            body = JSON.parse(text.trim());
          } catch {
            body = undefined;
          }
          // The process written to, by its epoch and its setup's id, never the newest one's.
          const rec: NativeRec = { seq: this.tick(), n: this.log.length, kind: 'write', server: p?.server ?? 'local', method: 'WRITE', body, raw: text, headers: {}, start: this.sched.step, startAt: this.sched.now, delivered: new Map(), epoch: p?.epoch ?? this.epoch };
          this.log.push(rec);
          if (!p || p.exited) {
            rec.end = this.sched.step;
            return reject(Object.assign(new Error('gone'), { kind: 'not-running' }));
          }
          const w = { rec, done: resolve, fail: reject };
          p.writes.push(w);
          take(run, w);
          // The pass build's native write bound (4.1), from the write's own start: a write still pending 10 s
          // later kills the process. Armed where a server can stop reading.
          if (this.build === 'pass' && this.server.mode.stopReading) this.sched.timer(() => {
            if (!p.exited && p.writes.includes(w)) exit(run, null);
          }, EXE_WRITE_BOUND_MS);
        }),
      stop: async (run) => {
        const asked = live.get(run);
        if (asked) this.stopsAsked.push({ epoch: asked.epoch, step: this.sched.step, seq: this.tick(), run });
        if (this.server.mode.refuseStop) throw Object.assign(new Error('refused'), { kind: 'failed' });
        this.sched.add({ label: `exit:${run}`, fire: () => exit(run, 0) });
      },
      forget: async () => {}
    };
  }
}

/* ---------- a store whose next write can be held ---------- */

export type HoldableStore = ReturnType<typeof memorySettingsStore> & { holdNext: boolean; release?: () => void };

function holdable(inner: ReturnType<typeof memorySettingsStore>): HoldableStore {
  const store = { ...inner, holdNext: false } as HoldableStore;
  const gate = async () => {
    if (!store.holdNext) return;
    store.holdNext = false;
    await new Promise<void>((r) => (store.release = () => {
      store.release = undefined;
      r();
    }));
  };
  store.put = async (k, r) => (await gate(), inner.put(k, r));
  store.putIf = async (k, r, g) => (await gate(), inner.putIf(k, r, g));
  return store;
}

/* ---------- the driver and its evidence ---------- */

export interface Evidence {
  readonly seq: number;
  readonly step: number;
  /** The scheduler's clock when it was noted, in ms. */
  readonly at?: number;
  readonly what: 'card' | 'yes' | 'call' | 'outcome' | 'stop-call' | 'revoke' | 'stop' | 'stopped' | 'start' | 'started' | 'model' | 'test' | 'tested' | 'not-offered' | 'grant';
  /** On a `stopped`: how the Stop ended, as its reply says. */
  readonly stopOutcome?: 'stopped' | 'may-still-run' | 'refused' | 'failed';
  /** On a `test`: whether it reached the machine (Test from Stopped or Failed). */
  readonly reaches?: boolean;
  /** On a `yes` minted from a saved grant: the fingerprint it was given on (H3 holds the call to it). */
  readonly grant?: string;
  /** Test's report: whether it listed, and the tool names it showed. */
  readonly report?: { readonly ok: boolean; readonly tools: readonly string[] };
  /** The reply's own words (a refused Start's, say). */
  readonly words?: string;
  readonly failure?: string;
  /** The arguments the person's Yes was for, as the driver made them (H3 builds its own canonical form). */
  readonly args?: unknown;
  readonly server?: string;
  readonly ok?: boolean;
  readonly token?: string;
  readonly tool?: string;
  readonly body?: string;
  readonly outcome?: CallOutcome;
  /** A Start or Test: whether the client admitted it (its server went to Starting in the same step), read
      from the server's state, never from the reply. */
  readonly admitted?: boolean;
}

/** One lifecycle transition as the driver made it: the event, the state it then held, and the exchange slot. */
export interface LcRecord {
  readonly seq?: number;
  readonly event: LcEvent;
  readonly state: LcState;
  readonly busy: boolean;
  readonly quiet: boolean;
}

/** The exchange machine's own outputs, as the driver reported them: each exchange admitted and ended. */
export interface ExchangeRecord {
  readonly t: 'admit' | 'ended';
  readonly n: number;
  readonly run: string;
  readonly kind: string;
  readonly end?: string;
  readonly seq: number;
}

/** The owner's reservations, recorded at the owner itself: what each was for, and when it was released. */
export interface Reservation {
  readonly what: string;
  readonly seq: number;
  released?: number;
}

export interface WireRun {
  /** Each server's lifecycle record, in order (the conformance check replays it through next()). */
  readonly lifecycle: ReadonlyMap<string, readonly LcRecord[]>;
  /** Each server's exchanges, admitted and ended (HC's independent record). */
  readonly exchanges: ReadonlyMap<string, readonly ExchangeRecord[]>;
  /** Every owner reservation (HC's independent record). */
  readonly reservations: readonly Reservation[];
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
  const store = holdable(memorySettingsStore());
  const lifecycle = new Map<string, LcRecord[]>();
  const exchanges = new Map<string, ExchangeRecord[]>();
  const reservations: Reservation[] = [];
  const client = await McpClient.open({
    transition: (id, event, state, slot) => lifecycle.set(id, [...(lifecycle.get(id) ?? []), { event, state, ...slot, seq: next() }]),
    exchange: (id, e) => exchanges.set(id, [...(exchanges.get(id) ?? []), { ...e, seq: next() }]),
    store,
    processes: exe.processes(),
    net: exe.net(),
    addresses: { add: async () => ({ id: `addr-${++addresses}` }), remove: async () => {} },
    secrets: { delete: async () => {} },
    clock: sched.clock(),
    paths: { program: () => undefined, folder: () => undefined } as any,
    limits: { startMs: 60_000, listMs: 30_000 }
  });
  // Every reservation, recorded at the owner itself, with its release.
  const owner = client.owner;
  const admit = owner.admit.bind(owner);
  owner.admit = ((what: string, o?: { readonly start?: boolean }) => {
    const a = admit(what, o);
    if (!('release' in a)) return a;
    const rec: Reservation = { what, seq: next() };
    reservations.push(rec);
    const release = a.release;
    return { ...a, release: () => {
      rec.released ??= next();
      release();
    } };
  }) as typeof owner.admit;
  const ids = Array.from({ length: options.servers ?? 1 }, (_, i) => `s${i + 1}`);
  for (const id of ids) {
    const setup = mode.where === 'remote' ? { kind: 'remote' as const, id, label: `Scripted ${id}`, url: `https://${id}.example/mcp`, transport: 'http' as const, headers: [] } : { kind: 'local' as const, id, label: `Scripted ${id}`, program: 'node', args: [], cwd: '/', env: [], secrets: [] };
    await client.add({ setup, problems: [] });
  }
  const d = new Driver(sched, client, evidence, next, exe, server, store);
  for (const id of ids) sched.add({ label: `start:${id}`, fire: () => d.start(id) });
  if (options.schedule) options.schedule(d);
  else d.random(10);
  await sched.run(options.steps ?? 1500);
  if (options.mutation && firstHit === undefined && mutations.hits(options.mutation) > 0) firstHit = sched.step;
  mutations.clear();
  return { sched, exe, server, evidence, firstHit, lifecycle, exchanges, reservations };
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

  readonly store: HoldableStore;

  constructor(sched: Scheduler, client: McpClient, evidence: Evidence[], tick: () => number, exe: FakeExe, server: ScriptedServer, store: HoldableStore) {
    this.store = store;
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
  card(tool: string, extra: Record<string, unknown> = {}, id = 's1'): { token: string; facts: NonNullable<ReturnType<McpClient['facts']>>; args: Record<string, unknown> } | undefined {
    const token = `t${++this.n}`;
    const args = { text: token, ...extra };
    const facts = this.client.facts(id, tool, args);
    if (!facts) return undefined;
    this.note({ what: 'card', token, tool, body: facts.canonical, args, server: id });
    return { token, facts, args };
  }

  /** The Yes on a card shown earlier, and the call it allows. */
  yes(card: { token: string; facts: NonNullable<ReturnType<McpClient['facts']>>; args: Record<string, unknown> }, id = 's1'): void {
    const decision = mintDecision(card.facts, card.token, 'asked');
    this.note({ what: 'yes', token: card.token, tool: card.facts.tool, body: card.facts.canonical, args: card.args, server: id });
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

  /** The person's "may run on its own" for a tool as it is listed now; H3 dates the grant by this step. */
  grantOwn(tool: string, id = 's1'): Promise<unknown> | undefined {
    const t = this.client.tools().find((x) => x.serverName === tool && x.server.id === id);
    if (!t) return undefined;
    // Noted once saved: a grant refused is no grant.
    const step = this.sched.step;
    return this.client.choose(id, tool, { policy: 'own', fingerprint: t.fingerprint, setupFingerprint: t.setupFingerprint }).then(
      () => {
        const e = this.note({ what: 'grant', tool, server: id, grant: t.fingerprint });
        (e as { step: number }).step = step;
      },
      () => undefined
    );
  }

  /** A call under a saved "may run on its own", as the journal's gate would mint it. */
  own(tool: string, extra: Record<string, unknown> = {}, id = 's1'): void {
    const token = `t${++this.n}`;
    const args = { text: token, ...extra };
    const facts = this.client.facts(id, tool, args);
    if (!facts) return void this.note({ what: 'not-offered', tool, server: id });
    const decision = mintDecision(facts, token, 'own');
    // A grant, not a Yes: H3 holds it to the grant's own fingerprint, not to a card.
    this.note({ what: 'yes', token, tool, body: facts.canonical, args, server: id, grant: facts.fingerprint });
    this.note({ what: 'call', token, tool, server: id });
    void this.client.send(decision, new AbortController().signal).then((outcome) => this.note({ what: 'outcome', token, tool, outcome, server: id }));
  }

  /** A model fetch, as chat makes one (H5). */
  model(): void {
    const ok = this.exe.modelFetch();
    this.note({ what: 'model', ok });
  }

  private note(e: Omit<Evidence, 'seq' | 'step' | 'at'>): Evidence {
    const rec = { seq: this.tick(), step: this.sched.step, at: this.sched.now, ...e };
    this.evidence.push(rec);
    return rec;
  }

  /** Start; with `then`, an action in the same step as its answer (a call made the moment it says Ready). */
  private starts = 0;
  start(id = 's1', then?: (ready: boolean) => void): void {
    const before = this.client.get(id)?.phase;
    // Noted before the call (its sequence precedes anything the start sends), its admission read after. Its
    // reply carries the same token: two Starts' replies are never confused.
    const token = `start-${++this.starts}`;
    const e = this.note({ what: 'start', server: id, token });
    const starting = this.client.start(id);
    (e as { admitted?: boolean }).admitted = before !== 'starting' && this.client.get(id)?.phase === 'starting';
    void starting.then((reply) => {
      this.note({ what: 'started', server: id, token, ...(reply.kind === 'failed' ? { failure: reply.failure.kind, words: reply.failure.words } : reply.kind === 'refused' ? { failure: 'refused', words: reply.words } : {}), ok: reply.kind === 'ready' });
      then?.(reply.kind === 'ready');
    });
  }

  /** Stop, and when it answered: a local Stop answers only after the process has exited. */
  private stops = 0;
  stop(id = 's1'): void {
    // Each Stop and its own answer share a token: a second Stop refused while the first is under way
    // answers at once, and is no answer to the first.
    const token = `stop-${++this.stops}`;
    this.note({ what: 'stop', server: id, token });
    void this.client.stop(id).then((reply) =>
      this.note({ what: 'stopped', server: id, token, stopOutcome: reply.kind === 'stopped' ? 'stopped' : reply.kind === 'refused' ? 'refused' : reply.kind === 'failed' && /may still be (running|starting)/.test(reply.failure.words) ? 'may-still-run' : 'failed', ...(reply.kind === 'failed' ? { failure: reply.failure.kind, words: reply.failure.words } : reply.kind === 'refused' ? { failure: 'refused', words: reply.words } : {}) })
    );
  }

  /** Test, as Settings runs it: its report, with the tools it showed (and a failed one's words). Its report
      carries the Test's own token, as a Start's reply does. */
  private tests = 0;
  test(id = 's1'): void {
    const before = this.client.get(id)?.phase;
    const token = `test-${++this.tests}`;
    // Whether Test reaches the machine: only from Stopped or Failed (otherwise the client answers at once).
    const e = this.note({ what: 'test', server: id, token, reaches: before === 'stopped' || before === 'failed' || before === undefined });
    const testing = this.client.test(id);
    (e as { admitted?: boolean }).admitted = before !== 'starting' && this.client.get(id)?.phase === 'starting';
    void testing.then(
      (report) => this.note({ what: 'tested', server: id, token, report: { ok: report.ok, tools: report.ok ? report.tools.map((t) => t.name) : [] }, ...(report.ok ? {} : { words: report.failure.words }) }),
      (e: unknown) => this.note({ what: 'tested', server: id, token, failure: 'threw', words: String(e).slice(0, 80) })
    );
  }

  /** The store's next write waits until `release()` (a catalog write held, say). */
  holdNextWrite(): void {
    this.store.holdNext = true;
  }
  releaseWrite(): void {
    this.store.release?.();
  }

  /** `act` in the same synchronous step as the owner's next release (a listener on its notice, as Settings
      could be): the window between a held effect's end and its caller's continuation. */
  whenOwnerFree(act: () => void): void {
    let done = false;
    const off = this.client.owner.onChange(() => {
      if (done || this.client.owner.busy) return;
      done = true;
      off();
      act();
    });
  }

  /** A call with a fresh Yes: a unique token in its arguments, so every handoff names its decision. */
  call(tool = 'echo', extra: Record<string, unknown> = {}, revokeRightAfter = false, id = 's1'): void {
    const token = `t${++this.n}`;
    const args = { text: token, ...extra };
    const facts = this.client.facts(id, tool, args);
    if (!facts) {
      // No card can be shown: on a Ready, settled run, the tool isn't offered.
      if (this.idle(id) && this.client.tools().some((t) => t.server.id === id)) this.note({ what: 'not-offered', tool, server: id });
      return;
    }
    const decision = mintDecision(facts, token, 'asked');
    this.note({ what: 'card', token, tool, body: facts.canonical, server: id });
    this.note({ what: 'yes', token, tool, body: facts.canonical, args, server: id });
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
        else if (action === 'mirror') {
          const y = this.sched.random();
          if (y < 0.6) this.call('mirror', { region: MIRROR_VECTORS[Math.floor(this.sched.random() * MIRROR_VECTORS.length)] });
          else if (y < 0.8) this.call('mirror2', { count: [0, 7, -12, 2 ** 31][Math.floor(this.sched.random() * 4)], flag: this.sched.random() < 0.5 });
          else this.call('mirror3', { region: 'eu-2' });
        }
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
