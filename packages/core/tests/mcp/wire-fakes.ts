// Fakes for the wire tests: a net port that plays a scripted remote server, and a process port that plays
// a scripted local one. Both record every native request with its body, its cancel and its end, as the
// harness's fake exe will (phase 5 grows them unkind).

import type { NetHead, NetPort, NetSpec } from '../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../../src/mcp/process.ts';

export interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: readonly (readonly [string, string])[];
  /** Body chunks, as strings. */
  readonly chunks?: readonly string[];
  readonly redirected?: boolean;
  /** Rejects the fetch with this exe kind instead. */
  readonly fail?: string;
}

export interface NetRecord {
  readonly id: string;
  readonly body: any;
  readonly headers: Record<string, string>;
  ended: boolean;
  cancelled: boolean;
}

/** A remote server: `answer` sees each POST's parsed body and headers and returns its response. */
export function fakeNet(answer: (body: any, headers: Record<string, string>, n: number) => ScriptedResponse) {
  const log: NetRecord[] = [];
  const open = new Map<string, { chunks: string[]; rec: NetRecord }>();
  const enc = new TextEncoder();
  const port: NetPort = {
    async fetch(spec: NetSpec, body: Uint8Array): Promise<NetHead> {
      const headers: Record<string, string> = {};
      for (const [k, v] of spec.headers) headers[k.toLowerCase()] = v;
      const parsed = JSON.parse(new TextDecoder().decode(body));
      const rec: NetRecord = { id: spec.id, body: parsed, headers, ended: false, cancelled: false };
      log.push(rec);
      const r = answer(parsed, headers, log.length);
      await Promise.resolve();
      if (r.fail) {
        rec.ended = true;
        throw Object.assign(new Error(r.fail), { kind: r.fail });
      }
      open.set(spec.id, { chunks: [...(r.chunks ?? [])], rec });
      return { status: r.status ?? 200, statusText: '', headers: r.headers ?? [['content-type', 'application/json']], url: 'https://h.example/mcp', redirected: r.redirected ?? false };
    },
    async read(id: string): Promise<Uint8Array> {
      await Promise.resolve();
      const o = open.get(id);
      if (!o || o.rec.cancelled) throw Object.assign(new Error('cancelled'), { kind: 'cancelled' });
      const next = o.chunks.shift();
      if (next === undefined) return new Uint8Array(0);
      return enc.encode(next);
    },
    async cancel(id: string): Promise<void> {
      await Promise.resolve();
      const o = open.get(id);
      const rec = o?.rec ?? log.find((r) => r.id === id);
      if (rec) {
        rec.cancelled = true;
        rec.ended = true;
      }
    }
  };
  return { port, log };
}

export const json = (v: unknown): ScriptedResponse => ({ status: 200, headers: [['content-type', 'application/json']], chunks: [JSON.stringify(v)] });
export const sse = (...events: unknown[]): ScriptedResponse => ({ status: 200, headers: [['content-type', 'text/event-stream']], chunks: events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)) });
export const initResult = (id: number, version = '2025-11-25') => ({ jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'fake' } } });
export const listResult = (id: number, names: string[], nextCursor?: string) => ({ jsonrpc: '2.0', id, result: { tools: names.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: {} } })), ...(nextCursor ? { nextCursor } : {}) } });
export const textResult = (id: number, text: string) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

/** A local server: `answer` sees each line written and returns lines to emit on stdout. */
export function fakeProcess(answer: (msg: any, write: number) => (string | ProcessEvent)[] | 'hold') {
  const writes: any[] = [];
  let emit: ((e: ProcessEvent) => void) | undefined;
  let exited = false;
  const held: (() => void)[] = [];
  const port: ProcessPort = {
    async start(_setup: ProcessSetup, onEvent) {
      emit = onEvent;
      return { run: 'p1' };
    },
    async write(_run, bytes) {
      if (exited) throw Object.assign(new Error('gone'), { kind: 'not-running' });
      const msg = JSON.parse(new TextDecoder().decode(bytes));
      writes.push(msg);
      const out = answer(msg, writes.length);
      if (out === 'hold') {
        await new Promise<void>((r) => held.push(r));
        return;
      }
      queueMicrotask(() => {
        for (const o of out) emit?.(typeof o === 'string' ? { t: 'out', line: o } : o);
      });
    },
    async stop() {
      queueMicrotask(() => exit(0));
    },
    async forget() {}
  };
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const r of held.splice(0)) r();
    emit?.({ t: 'exit', code });
  };
  return { port, writes, emit: (e: ProcessEvent) => emit?.(e), exit, release: () => held.splice(0).forEach((r) => r()) };
}

export const realClock = {
  now: () => Date.now(),
  setTimer: (cb: () => void, ms: number) => {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  }
};
