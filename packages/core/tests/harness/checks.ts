// The independent checks (docs/mcp-design.md 7.2). Each reads only the fake exe's log, the fake server's
// own record and the driver's evidence log, never the client's state.

import type { Evidence, NativeRec, WireRun } from './wire.ts';

export type Check = (r: WireRun) => string[];

const isPong = (b: any): boolean => !!b && b.method === undefined && 'result' in b && b.id !== undefined;
const isCall = (b: any) => b?.method === 'tools/call';
const tokenOf = (b: any) => String(b?.params?.arguments?.text ?? '');

/** The exchange a native request belongs to, as the wire shows it. */
function exchangeKey(r: WireRun, rec: NativeRec): string {
  const b: any = rec.body;
  if (isPong(b)) {
    // A pong belongs to the exchange whose stream (remote) or whose live request (local) carried its ping.
    if (rec.kind === 'post') {
      const carrier = r.exe.log.find((x) => x.delivered.has(String(b.id)));
      return carrier ? exchangeKey(r, carrier) : `orphan-pong:${b.id}`;
    }
    // Local: a request whose write is still in flight, else the request written before it whose response
    // hadn't reached the client yet, else none (an idle ping's own exchange).
    const inFlight = [...r.exe.log].reverse().find((x) => x.kind === 'write' && x.epoch === rec.epoch && x.seq < rec.seq && x.body !== undefined && x.body.method !== 'notifications/cancelled' && (x.end ?? Infinity) > rec.start);
    if (inFlight) return exchangeKey(r, inFlight);
    const outstanding = [...r.exe.log].filter((x) => x.kind === 'write' && x.epoch === rec.epoch && x.seq < rec.seq && x.body?.id !== undefined && x.body?.method);
    const cancelEnded = (id: unknown) => r.exe.log.some((y) => y.kind === 'write' && y.epoch === rec.epoch && y.body?.method === 'notifications/cancelled' && y.body.params?.requestId === id && (y.end ?? Infinity) <= rec.start);
    const open = outstanding.reverse().find((x) => (r.exe.responded.get(`${x.epoch}:${x.body!.id}`) ?? Infinity) > rec.start && !cancelEnded(x.body!.id));
    return open ? `${rec.epoch}:${open.body!.id}` : `idle:${b.id}`;
  }
  if (b?.method === 'notifications/cancelled') return `${rec.epoch}:${b.params?.requestId}`;
  if (b?.id !== undefined) return `${rec.epoch}:${b.id}`;
  return `${rec.epoch}:note:${rec.n}`;
}

/** H1: per server, the native requests of two different exchanges are never open at once, and at most 3. */
export const H1: Check = (r) => {
  const problems: string[] = [];
  const open = (x: NativeRec) => [x.start, x.end ?? Infinity] as const;
  const recs = r.exe.log;
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const [a0, a1] = open(recs[i]!);
      const [b0, b1] = open(recs[j]!);
      // Open in the same step counts only if both were open across a step boundary.
      if (a0 < b1 && b0 < a1 && exchangeKey(r, recs[i]!) !== exchangeKey(r, recs[j]!)) {
        problems.push(`H1: ${recs[i]!.n} (${exchangeKey(r, recs[i]!)}) and ${recs[j]!.n} (${exchangeKey(r, recs[j]!)}) open at once`);
      }
    }
  }
  for (let s = 0; s <= r.sched.step; s++) {
    const n = recs.filter((x) => x.start <= s && (x.end ?? Infinity) > s).length;
    if (n > 3) problems.push(`H1: ${n} native requests open at step ${s}`);
  }
  // Nothing waits in line: a call goes out in the step it's made, or is answered in that step (a queue
  // would hand it off later, and never overlap, so overlap alone can't catch it).
  for (const e of r.evidence) {
    if (e.what !== 'call') continue;
    const out = recs.find((x) => isCall(x.body) && tokenOf(x.body) === e.token);
    const answered = r.evidence.find((o) => o.what === 'outcome' && o.token === e.token);
    if (out && out.start !== e.step) problems.push(`H1: ${e.token} made at step ${e.step}, handed off at ${out.start}`);
    if (!out && answered && answered.step !== e.step && answered.outcome?.kind === 'error') problems.push(`H1: ${e.token} refused only at step ${answered.step}, made at ${e.step}`);
  }
  // A call refused busy never goes out afterwards.
  for (const e of r.evidence) {
    if (e.what !== 'outcome' || e.outcome?.kind !== 'error' || e.outcome.reason !== 'busy') continue;
    if (recs.some((x) => isCall(x.body) && tokenOf(x.body) === e.token)) problems.push(`H1: ${e.token} was refused busy, then sent`);
  }
  return problems.slice(0, 3);
};

/** H2: only Familiar's own message kinds; no GET or DELETE; no error replies; no remote cancel; a pong
    only for a ping on its own stream, once; nothing after its exchange's terminal event. */
export const H2: Check = (r) => {
  const problems: string[] = [];
  const kinds = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'notifications/cancelled']);
  const pongs = new Map<string, number>();
  for (const x of r.exe.log) {
    if (x.kind === 'post' && x.method !== 'POST') problems.push(`H2: a ${x.method}`);
    const b = x.body;
    if (!b) continue;
    if (b.error !== undefined) problems.push(`H2: an error reply ${JSON.stringify(b).slice(0, 80)}`);
    if (isPong(b)) {
      pongs.set(String(b.id), (pongs.get(String(b.id)) ?? 0) + 1);
      if (x.kind === 'post') {
        const carrier = r.exe.log.find((y) => y.delivered.has(String(b.id)));
        if (!carrier) problems.push(`H2: a pong for ${b.id}, a ping no stream carried`);
        else if (carrier.final !== undefined && carrier.delivered.get(String(b.id))! > carrier.final) problems.push(`H2: a pong for ${b.id}, which came after its stream's final response`);
      } else {
        if (!r.server.pings.some((p) => p.id === String(b.id)) && !String(b.id).startsWith('i')) problems.push(`H2: a pong for ${b.id}, never pinged`);
        // Locally, a pong goes out only while its exchange's request is live: not after its response, and
        // not after its cancel (the exchange sealed: departure 2).
        const key = exchangeKey(r, x);
        const m = /^(\d+):(.+)$/.exec(key);
        if (m) {
          const responded = r.exe.responded.get(key);
          if (responded !== undefined && responded < x.start) problems.push(`H2: a pong for ${b.id} after its exchange's response`);
          if (r.exe.log.some((y) => y.kind === 'write' && y.epoch === x.epoch && y.body?.method === 'notifications/cancelled' && String(y.body.params?.requestId) === m[2] && y.seq < x.seq)) problems.push(`H2: a pong for ${b.id} after its exchange's cancel`);
        }
      }
      continue;
    }
    if (!kinds.has(b.method)) problems.push(`H2: a message of kind ${b.method}`);
    if (b.method === 'notifications/cancelled') {
      if (x.kind === 'post') problems.push('H2: notifications/cancelled to a remote server');
      else {
        // The local cancel is the terminal step's last send: made in the step that stopped the call.
        const label = r.sched.log[x.start - 1] ?? '';
        if (!/^(act:stop-call|timer:|exit:)/.test(label) && !label.startsWith('act:')) problems.push(`H2: the cancel for ${b.params?.requestId} written at "${label}", after its exchange ended`);
      }
    }
  }
  for (const [id, n] of pongs) if (n > 1) problems.push(`H2: ${n} pongs for ${id}`);
  return problems.slice(0, 3);
};

/** H3: every call's body is one the person's Yes allowed, used once, and none goes out after a revoke
    that the log shows before its handoff. */
export const H3: Check = (r) => {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const x of r.exe.log) {
    if (!isCall(x.body)) continue;
    const t = tokenOf(x.body);
    const yes = r.evidence.find((e) => e.what === 'yes' && e.token === t);
    const args = JSON.stringify(x.body!.params?.arguments ?? {});
    if (!yes) {
      problems.push(`H3: a call with no Yes: ${args.slice(0, 60)}`);
      continue;
    }
    if (canonical(x.body!.params?.arguments) !== yes.body || x.body!.params?.name !== yes.tool) problems.push(`H3: the call for ${t} isn't what its Yes showed: ${args.slice(0, 60)}`);
    if (used.has(t)) problems.push(`H3: the Yes for ${t} used twice`);
    used.add(t);
    const revoked = r.evidence.find((e) => e.what === 'revoke' && e.tool === yes.tool && e.seq < x.seq);
    if (revoked) problems.push(`H3: ${t} went out after a revoke of ${yes.tool}`);
  }
  return problems.slice(0, 3);
};

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** H10: a late or stale response never reaches a caller: a call's result names its own token. */
export const H10: Check = (r) =>
  r.evidence
    .filter((e) => e.what === 'outcome' && e.outcome?.kind === 'result' && !e.outcome.isError)
    .filter((e) => !(e.outcome as { text: string }).text.includes(e.token!))
    .map((e) => `H10: ${e.token} answered with another call's result: ${(e.outcome as { text: string }).text.slice(0, 40)}`)
    .slice(0, 3);

/** The harness's own scan of a listed schema, for H11: declarations reached through properties only. */
function declared(schema: any, path: string[] = []): { path: string[]; name: string }[] {
  if (!schema || typeof schema !== 'object') return [];
  const here = path.length && typeof schema['x-mcp-header'] === 'string' ? [{ path, name: schema['x-mcp-header'] as string }] : [];
  return [...here, ...Object.entries(schema.properties ?? {}).flatMap(([k, v]) => declared(v, [...path, k]))];
}

/** H11: a modern remote call's standard and mirrored headers match its own body and the listed schema. */
export const H11: Check = (r) => {
  const problems: string[] = [];
  for (const x of r.exe.log) {
    if (x.kind !== 'post' || !isCall(x.body) || x.headers['mcp-protocol-version'] !== '2026-07-28') continue;
    const b = x.body!;
    if (x.headers['mcp-method'] !== 'tools/call') problems.push('H11: Mcp-Method missing on a call');
    if (x.headers['mcp-name'] !== b.params?.name) problems.push('H11: Mcp-Name differs from the body');
    const schema = b.params?.name === 'mirror' ? { properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } : {};
    for (const d of declared(schema)) {
      let v: any = b.params?.arguments;
      for (const k of d.path) v = v?.[k];
      const header = x.headers[`mcp-param-${d.name.toLowerCase()}`];
      if (v === undefined || v === null) {
        if (header !== undefined) problems.push(`H11: a header for an absent ${d.name}`);
        continue;
      }
      const plain = typeof v === 'string' && v !== '' && v === v.trim() && /^[\x20-\x7e\t]*$/.test(v) && !(v.startsWith('=?base64?') && v.endsWith('?='));
      const expected = plain ? String(v) : `=?base64?${Buffer.from(String(v), 'utf8').toString('base64')}?=`;
      if (header !== expected) problems.push(`H11: Mcp-Param-${d.name} is "${String(header).slice(0, 30)}", the body says "${String(v).slice(0, 30)}"`);
    }
  }
  return problems.slice(0, 3);
};

/** H12: a run's requests all have one era's framing, and modern only after a modern refusal. */
export const H12: Check = (r) => {
  const problems: string[] = [];
  const byEpoch = new Map<number, NativeRec[]>();
  for (const x of r.exe.log) byEpoch.set(x.epoch, [...(byEpoch.get(x.epoch) ?? []), x]);
  for (const [, recs] of byEpoch) {
    const modern = recs.filter((x) => x.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' || x.headers['mcp-protocol-version'] === '2026-07-28');
    if (!modern.length) {
      if (recs.some((x) => x.headers['mcp-method'] !== undefined || x.headers['mcp-name'] !== undefined)) problems.push('H12: a legacy run sent a modern header');
      continue;
    }
    if (r.server.mode.era !== 'modern') problems.push('H12: a run turned modern though the server never refused the legacy opening');
    const first = Math.min(...modern.map((x) => x.seq));
    const opening = Math.min(...recs.map((x) => x.seq));
    for (const x of recs) {
      if (x.body?.method === 'notifications/initialized') problems.push('H12: initialized on a modern run');
      if (x.body?.method === 'initialize' && x.seq !== opening) problems.push('H12: initialize after a modern opening');
      if (x.seq <= first) continue;
      if (isPong(x.body)) problems.push('H12: a pong on a modern run');
      if (x.headers['mcp-session-id'] !== undefined) problems.push('H12: a session id on a modern run');
      if (x.kind === 'post' && x.body?.method === 'notifications/cancelled') problems.push('H12: a remote cancel on a modern run');
    }
  }
  // No request follows an input_required answer for the same call.
  for (const e of r.evidence) {
    if (e.what !== 'outcome' || !(e.outcome?.kind === 'result' && /asked for input/.test(e.outcome.text))) continue;
    if (r.exe.log.filter((x) => isCall(x.body) && tokenOf(x.body) === e.token).length > 1) problems.push(`H12: ${e.token} sent again after input_required`);
  }
  return problems.slice(0, 3);
};

/** H13: every ping the server sent has one disposition: a pong that reached the server, or a named
    departure whose condition holds (1 a flood, 2 a local drain or blocked write, 6 after the final). */
export const H13: Check = (r) => {
  const problems: string[] = [];
  const answered = new Set(r.server.arrivals.filter((a) => isPong(a.body)).map((a) => String(a.body.id)));
  const flooded = new Set(r.evidence.filter((e) => e.what === 'outcome' && e.outcome?.kind === 'error' && /too many pings/.test(e.outcome.words)).map((e) => e.token));
  for (const p of r.server.pings) {
    if (answered.has(p.id) || p.afterFinal) continue;
    const carrier = r.exe.log.find((x) => x.delivered.has(p.id)) ?? r.exe.log.find((x) => `w${x.n}` === p.on || String(x.n) === p.on);
    if (!carrier) continue; // never reached the client
    if (carrier.kind === 'post' && !carrier.delivered.has(p.id)) continue; // the stream ended or was cancelled first
    if (carrier.kind === 'post' && carrier.final !== undefined && carrier.delivered.get(p.id)! > carrier.final) continue; // departure 6
    const token = tokenOf(carrier.body);
    if (flooded.has(token)) continue; // departure 1
    if (r.server.mode.pings === 40) continue; // a flood ends the exchange at its third or 33rd ping
    if (carrier.kind === 'write') continue; // departure 2 (a local drain or blocked write) is judged by W and T14
    const outcome = r.evidence.find((e) => e.what === 'outcome' && e.token === token)?.outcome;
    if (outcome && outcome.kind !== 'result') continue; // the exchange ended before the ping was read
    problems.push(`H13: ping ${p.id} on request ${carrier.n} got no pong and no departure`);
  }
  return problems.slice(0, 3);
};

/** H14: no call reaches the server twice; after a 404, initialize with no session id, then the new one. */
export const H14: Check = (r) => {
  const problems: string[] = [];
  // The exe's own redirect follow (the pre-pass contract, 4.3) is the exe's, not the client's.
  const calls = r.server.arrivals.filter((a) => isCall(a.body) && !a.followed);
  const seen = new Map<string, number>();
  for (const a of calls) seen.set(tokenOf(a.body), (seen.get(tokenOf(a.body)) ?? 0) + 1);
  for (const [t, n] of seen) if (n > 1) problems.push(`H14: ${t} reached the server ${n} times`);
  if (r.server.arrivals.some((a) => a.method === 'GET' && !a.followed)) problems.push('H14: a GET reached the server');
  // A redirected head is refused: the call it carried never comes back as a result.
  for (const x of r.exe.log) {
    if (!x.redirected || !isCall(x.body)) continue;
    const out = r.evidence.find((e) => e.what === 'outcome' && e.token === tokenOf(x.body))?.outcome;
    if (out?.kind === 'result') problems.push(`H14: ${tokenOf(x.body)} came back as a result through a redirect`);
  }
  const recs = r.exe.log.filter((x) => x.kind === 'post');
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]!.status !== 404) continue;
    const after = recs.slice(i + 1).filter((x) => x.body && !isPong(x.body));
    const next = after[0];
    if (!next) continue;
    if (next.body?.method !== 'initialize') {
      if (next.body?.method === 'tools/call' && next.seq > recs[i]!.seq) problems.push(`H14: after a 404, ${next.body.method} before a fresh initialize`);
      continue;
    }
    if (next.headers['mcp-session-id'] !== undefined) problems.push('H14: the re-handshake carried the old session id');
  }
  // A 404 before any page or call has completed since the last re-handshake ends the run: nothing more is
  // sent until the person starts it again.
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]!.status !== 404) continue;
    const prior = recs.slice(0, i).reverse().find((x) => x.status === 404);
    if (!prior) continue;
    const between = recs.filter((x) => x.seq > prior.seq && x.seq < recs[i]!.seq);
    const completed = between.some((x) => (x.body?.method === 'tools/list' || x.body?.method === 'tools/call') && x.status === 200 && x.final !== undefined);
    if (completed) continue;
    const restart = r.evidence.find((e) => e.what === 'start' && e.seq > recs[i]!.seq);
    const after = recs.filter((x) => x.seq > recs[i]!.seq && x.body && !isPong(x.body) && (!restart || x.seq < restart.seq));
    if (after.length) problems.push(`H14: after a second 404 with nothing completed between, ${after[0]!.body!.method} was still sent`);
  }
  return problems.slice(0, 3);
};

export const WIRE_CHECKS: Record<string, Check> = { H1, H2, H3, H10, H11, H12, H13, H14 };
export type { Evidence };
