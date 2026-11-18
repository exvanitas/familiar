// The independent checks (docs/mcp-design.md 7.2). Each reads only the fake exe's log, the fake server's
// own record and the driver's evidence log, never the client's state.

import { DETACH_MS, EXE_SERVER_CAP, type Evidence, type NativeRec, type WireRun } from './wire.ts';

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
    return localPongKey(r, rec);
  }
  if (b?.method === 'notifications/cancelled') return `${rec.epoch}:${b.params?.requestId}`;
  if (b?.id !== undefined) return `${rec.epoch}:${b.id}`;
  return `${rec.epoch}:note:${rec.n}`;
}

/** Local: the exchange live when a pong's ping reached the client, read from the exe's log and the
    evidence alone. A request is live from its write until its response line, its cancel, or its outcome
    (a flood or a time limit ends it with nothing on the pipe); a write-only exchange (initialized, or an
    idle ping's own pong) is live while its one write is in flight. With neither, the pong opens its own. */
const pongKeys = new WeakMap<NativeRec, string>();
function localPongKey(r: WireRun, rec: NativeRec): string {
  const known = pongKeys.get(rec);
  if (known) return known;
  const id = String(rec.body!.id);
  const d = r.exe.pingDelivered.get(id) ?? rec.start;
  const writes = r.exe.log.filter((x) => x.kind === 'write' && x.epoch === rec.epoch && x.seq < rec.seq);
  const request = [...writes].reverse().find((x) => {
    if (x.body?.id === undefined || !x.body.method) return false;
    if ((r.exe.responded.get(`${x.epoch}:${x.body.id}`) ?? Infinity) < d) return false;
    if (writes.some((y) => y.body?.method === 'notifications/cancelled' && y.body.params?.requestId === x.body!.id && y.start < d)) return false;
    const out = x.body.method === 'tools/call' ? r.evidence.find((e) => e.what === 'outcome' && e.token === tokenOf(x.body)) : undefined;
    return !(out && out.step < d);
  });
  let key: string;
  if (request) key = `${rec.epoch}:${request.body!.id}`;
  else {
    const inFlight = (x: NativeRec) => x.start <= d && (x.end ?? Infinity) > d;
    const opener = [...writes].reverse().find((x) => inFlight(x) && ((x.body?.method !== undefined && x.body.id === undefined && x.body.method !== 'notifications/cancelled') || (isPong(x.body) && localPongKey(r, x) === `idle:${x.body!.id}`)));
    // Nothing live, but a write still in flight: an exchange is draining, so the ping is departure 2.
    key = opener ? (isPong(opener.body) ? `idle:${opener.body!.id}` : `${rec.epoch}:note:${opener.n}`) : writes.some(inFlight) ? `sealed:${id}` : `idle:${id}`;
  }
  pongKeys.set(rec, key);
  return key;
}

/** Which run of its server a native request belongs to: local, the process (an epoch); remote, the count
    of Starts made before it (a run lasts from one Start to its end, re-handshakes included). */
function runOf(r: WireRun, x: NativeRec): number {
  if (x.kind === 'write') return x.epoch;
  return r.evidence.filter((e) => e.what === 'start' && e.seq < x.seq && `addr-${(e.server ?? 's1').slice(1)}` === x.server).length;
}

/** H1: per server, the native requests of two different exchanges are never open at once, and at most 3. */
export const H1: Check = (r) => {
  const problems: string[] = [];
  const open = (x: NativeRec) => [x.start, x.end ?? Infinity] as const;
  const all = r.exe.log.filter((x) => x.kind !== 'model' && !x.refused);
  for (const server of new Set(all.map((x) => x.server))) problems.push(...H1one(r, all.filter((x) => x.server === server), open));
  const recs = all;
  // Nothing waits in line: a call goes out in the step it's made, or is answered in that step (a queue
  // would hand it off later, and never overlap, so overlap alone can't catch it).
  for (const e of r.evidence) {
    if (e.what !== 'call') continue;
    const out = recs.find((x) => isCall(x.body) && tokenOf(x.body) === e.token);
    const answered = r.evidence.find((o) => o.what === 'outcome' && o.token === e.token);
    if (out && out.start !== e.step) problems.push(`H1: ${e.token} made at step ${e.step}, handed off at ${out.start}`);
    if (!out && answered && answered.step !== e.step && answered.outcome?.kind === 'error') problems.push(`H1: ${e.token} refused only at step ${answered.step}, made at ${e.step}`);
  }
  // Busy only while the exe shows the server's exchange in play (a slot held by nothing is a write-only
  // exchange waiting for a response that never comes); likewise a start that times out.
  for (const e of r.evidence) {
    const busy = e.what === 'outcome' && e.outcome?.kind === 'error' && e.outcome.reason === 'busy' && r.evidence.some((c) => c.what === 'call' && c.token === e.token && c.step === e.step);
    const stalled = e.what === 'started' && e.failure === 'timed-out';
    if (!busy && !stalled) continue;
    const s = e.step;
    if (inPlay(r, e.server ?? 's1', s) || r.evidence.some((o) => (o.what === 'start' || o.what === 'stop') && o.step >= s - 1 && o.step <= s && o !== e)) continue;
    problems.push(busy ? `H1: ${e.token} refused busy at step ${s} with nothing of its server in play` : `H1: the start timed out at step ${s} with nothing of its server in play`);
  }
  // A call refused busy never goes out afterwards.
  for (const e of r.evidence) {
    if (e.what !== 'outcome' || e.outcome?.kind !== 'error' || e.outcome.reason !== 'busy') continue;
    if (recs.some((x) => isCall(x.body) && tokenOf(x.body) === e.token)) problems.push(`H1: ${e.token} was refused busy, then sent`);
  }
  return problems.slice(0, 3);
};

/** Whether the exe's log shows something of this server in play at `s`: a request or write still open, or
    a local request written whose response hasn't come, not cancelled, and its run alive. */
function inPlay(r: WireRun, server: string, s: number): boolean {
  const address = `addr-${server.slice(1)}`;
  return r.exe.log.some((x) => {
    if (x.kind === 'model' || x.refused) return false;
    if (x.kind === 'post') return x.server === address && x.start <= s && (x.end ?? Infinity) >= s;
    if (x.start > s) return false;
    if ((x.end ?? Infinity) >= s) return true;
    if (x.body?.id === undefined || !x.body.method) return false;
    const answered = r.exe.responded.get(`${x.epoch}:${x.body.id}`);
    const cancelled = r.exe.log.some((y) => y.kind === 'write' && y.epoch === x.epoch && y.body?.method === 'notifications/cancelled' && y.body.params?.requestId === x.body!.id && (y.end ?? Infinity) <= s);
    const exited = r.exe.exits.some((t) => t.epoch === x.epoch && t.step <= s);
    return (answered === undefined || answered >= s) && !cancelled && !exited;
  });
}

function H1one(r: WireRun, recs: NativeRec[], open: (x: NativeRec) => readonly [number, number]): string[] {
  const problems: string[] = [];
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
    // At most the request and two pongs; locally a stop's cancel may join them, as the terminal step's
    // last send while the others are still being written (3.4).
    const openNow = recs.filter((x) => x.start <= s && (x.end ?? Infinity) > s);
    const n = openNow.filter((x) => !(x.kind === 'write' && x.body?.method === 'notifications/cancelled')).length;
    if (n > 3 || openNow.length > 4) problems.push(`H1: ${openNow.length} native requests open at step ${s}`);
  }
  return problems;
}

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
        if (key.startsWith('sealed:')) problems.push(`H2: a pong for ${b.id}, which came while its exchange drained`);
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
  // Nothing reaches a run after its Stop: no request, notification or pong of that run starts once the
  // Stop was made.
  for (const e of r.evidence) {
    if (e.what !== 'stop') continue;
    const address = r.server.mode.where === 'remote' ? `addr-${(e.server ?? 's1').slice(1)}` : 'local';
    const before = r.exe.log.filter((x) => x.server === address && x.seq < e.seq);
    const epoch = before.at(-1)?.epoch;
    if (epoch === undefined) continue;
    for (const x of r.exe.log) {
      if (x.server !== address || x.epoch !== epoch || x.seq < e.seq || !x.body) continue;
      // Stop ends the live exchange in its own step too, so not even its pongs go out after it.
      const opener = x.body.method !== 'notifications/cancelled';
      if (opener) problems.push(`H2: ${x.body.method ?? `the pong for ${x.body.id}`} sent to a run after its Stop (step ${e.step})`);
    }
  }
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
    const revoked = r.evidence.find((e) => e.what === 'revoke' && e.tool === yes.tool && (e.server ?? 's1') === (yes.server ?? 's1') && e.seq < x.seq);
    if (revoked) problems.push(`H3: ${t} went out after a revoke of ${yes.tool}`);
    // The tool as the server last listed it before the card, and before the handoff: a change between
    // (a fingerprint change) means the Yes allowed something else (S1).
    const card = r.evidence.find((e) => e.what === 'card' && e.token === t) ?? yes;
    const before = listedAt(r, x.server, card.step, yes.tool!);
    const now = listedAt(r, x.server, x.start, yes.tool!);
    if (before !== now) problems.push(`H3: ${t} went out though ${yes.tool} changed after its card was shown`);
  }
  problems.push(...staleCatalogCalls(r));
  return problems.slice(0, 3);
};

/** A list_changed delivered on a run makes its catalog stale: no call goes out on that run until a tools/list
    walked after it has come back whole (G26). The notification comes ahead of its stream's final message,
    so it was delivered by the step that message was. */
function staleCatalogCalls(r: WireRun): string[] {
  const problems: string[] = [];
  const recs = r.exe.log.filter((x) => x.kind === 'post');
  for (const c of recs) {
    if (c.final === undefined || !c.plan?.messages.some((m) => m.method === 'notifications/tools/list_changed')) continue;
    const d = Math.floor(c.final / 1000);
    const relisted = recs.find((x) => x.epoch === c.epoch && x.body?.method === 'tools/list' && x.start >= d && x.final !== undefined && !x.plan?.messages.some((m) => m.method === 'notifications/tools/list_changed'));
    const until = relisted ? Math.floor(relisted.final! / 1000) : Infinity;
    const call = recs.find((x) => x.epoch === c.epoch && isCall(x.body) && x.start > d && x.start <= until);
    if (call) problems.push(`H3: ${tokenOf(call.body)} went out on a catalog a list_changed had made stale`);
  }
  return problems;
}

/** The harness's own reading of a server's catalog: the tool's definition in the last first page of a
    tools/list answer that reached the client before `step`. */
function listedAt(r: WireRun, server: string, step: number, tool: string): string | undefined {
  let found: { at: number; def: string | undefined } | undefined;
  for (const x of r.exe.log) {
    if (x.server !== server || x.body?.method !== 'tools/list' || x.body.params?.cursor !== undefined || !x.plan) continue;
    const at = x.kind === 'post' ? (x.final === undefined ? undefined : Math.floor(x.final / 1000)) : r.exe.responded.get(`${x.epoch}:${x.body.id}`);
    if (at === undefined || at >= step) continue;
    const res = x.plan.messages.find((m) => m.id === x.body!.id && m.result)?.result;
    if (!res) continue;
    if (!found || at >= found.at) found = { at, def: JSON.stringify(res.tools?.find((d: any) => d.name === tool)) };
  }
  return found?.def;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Whether the server wrote a well-formed answer to this call: an event stream, or a JSON body with its one
    message (an empty JSON body is the server's own invalid answer). */
function wroteValid(r: WireRun, token: string): boolean {
  const rec = r.exe.log.find((x) => isCall(x.body) && tokenOf(x.body) === token);
  return !!rec?.plan && rec.plan.status === 200 && (rec.plan.sse || rec.plan.messages.length > 0);
}

/** H10: a late or stale response never reaches a caller: a call's result names its own token, and comes
    through exactly as the server wrote it, its multibyte characters whole however the bytes were split. */
export const H10: Check = (r) => {
  const results = r.evidence.filter((e) => e.what === 'outcome' && e.outcome?.kind === 'result' && !e.outcome.isError);
  return [
    ...results.filter((e) => !(e.outcome as { text: string }).text.includes(e.token!)).map((e) => `H10: ${e.token} answered with another call's result: ${(e.outcome as { text: string }).text.slice(0, 40)}`),
    ...results.filter((e) => (e.outcome as { text: string }).text.includes(e.token!) && !(e.outcome as { text: string }).text.includes('— café ✓ 𝄞')).map((e) => `H10: ${e.token}'s result came through changed: ${JSON.stringify((e.outcome as { text: string }).text.slice(-24))}`),
    // The scripted server writes only valid answers: one read as invalid was split or decoded wrong.
    ...r.evidence.filter((e) => e.what === 'outcome' && e.outcome?.kind === 'error' && /couldn't read/.test(e.outcome.words) && wroteValid(r, e.token!)).map((e) => `H10: ${e.token}'s valid answer was read as invalid: ${(e.outcome as { words: string }).words.slice(0, 60)}`)
  ].slice(0, 3);
};

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
  // Per run (one Start to its end), so a re-handshake inside a run is judged with it.
  const byRun = new Map<string, NativeRec[]>();
  for (const x of r.exe.log) {
    if (x.kind === 'model') continue;
    const k = `${x.server}:${runOf(r, x)}`;
    byRun.set(k, [...(byRun.get(k) ?? []), x]);
  }
  for (const [, recs] of byRun) {
    const modern = recs.filter((x) => x.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' || x.headers['mcp-protocol-version'] === '2026-07-28');
    if (!modern.length) {
      if (recs.some((x) => x.headers['mcp-method'] !== undefined || x.headers['mcp-name'] !== undefined)) problems.push('H12: a legacy run sent a modern header');
      continue;
    }
    if (r.server.mode.era !== 'modern') problems.push('H12: a run turned modern though the server never refused the legacy opening');
    const opening = Math.min(...recs.map((x) => x.seq));
    for (const x of recs) {
      if (x.body?.method === 'notifications/initialized') problems.push('H12: initialized on a modern run');
      if (x.body?.method === 'initialize' && x.seq !== opening) problems.push('H12: initialize after a modern opening');
      if (x.seq === opening) continue;
      // Every frame after the opening is modern: a run's era never changes.
      const isModern = x.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' || x.headers['mcp-protocol-version'] === '2026-07-28';
      if (!isModern && x.body?.method && x.body.method !== 'initialize' && x.body.method !== 'notifications/cancelled') problems.push(`H12: a legacy ${x.body.method} in a run that turned modern`);
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

/** H13: every ping the server sent has one disposition: a pong handed off for it, or a named departure
    whose own condition holds in the log (1 a flood, 2 a local ping while its exchange drains or a write is
    blocked, 5 after the final response on its stream). A handed-off pong's native fate is logged apart
    (pongFates) and never fails H13. A ping that never reached the client isn't the client's. */
export const H13: Check = (r) => {
  const problems: string[] = [];
  // Handed off: a pong the client didn't itself cancel before its head (the exe's own fate, stall, timeout
  // or busy, is departure 6 and logged apart; the client's cancel is no handoff).
  const handed = new Set(r.exe.log.filter((x) => isPong(x.body) && (x.cancelAsked === undefined || (x.head !== undefined && x.head <= x.cancelAsked) || x.refused)).map((x) => String(x.body!.id)));
  const words = (token: string) => {
    const o = r.evidence.find((e) => e.what === 'outcome' && e.token === token)?.outcome;
    return o?.kind === 'error' ? o.words : '';
  };
  for (const p of r.server.pings) {
    if (handed.has(p.id)) continue;
    const post = r.exe.log.find((x) => x.kind === 'post' && x.delivered.has(p.id));
    if (post) {
      if (post.final !== undefined && post.delivered.get(p.id)! > post.final) continue; // departure 5
      if (/too many pings/.test(words(tokenOf(post.body)))) continue; // departure 1
      problems.push(`H13: ping ${p.id} on request ${post.n} got no pong and no departure`);
      continue;
    }
    const at = r.exe.pingDelivered.get(p.id);
    if (at === undefined) continue; // never reached the client
    const carrier = r.exe.log.find((x) => `w${x.n}` === p.on);
    if (!carrier) continue;
    if (/too many pings/.test(words(tokenOf(carrier.body)))) continue; // departure 1
    const responded = r.exe.responded.get(`${carrier.epoch}:${carrier.body?.id}`);
    const draining = (responded !== undefined && responded < at) || r.exe.log.some((y) => y.kind === 'write' && y.epoch === carrier.epoch && y.body?.method === 'notifications/cancelled' && y.start <= at);
    const blocked = r.exe.log.some((y) => y.kind === 'write' && y.epoch === carrier.epoch && y.start <= at && (y.end ?? Infinity) > at);
    // Another exchange live on the same run when an idle ping comes: it waits for no one, so it's departure 2.
    const busyElsewhere = p.id.startsWith('i') && r.exe.log.some((y) => y.kind === 'write' && y.epoch === carrier.epoch && y.body?.method && y.body.id !== undefined && y.start <= at && (r.exe.responded.get(`${y.epoch}:${y.body.id}`) ?? Infinity) >= at);
    // Stop ends the live exchange in its own step, so a ping that comes after it meets a drain.
    const stopped = r.evidence.some((e) => e.what === 'stop' && e.step <= at && !r.exe.exits.some((t) => t.epoch === carrier.epoch && t.step < e.step));
    if (draining || blocked || busyElsewhere || stopped) continue; // departure 2
    problems.push(`H13: local ping ${p.id} got no pong and no departure`);
  }
  return problems.slice(0, 3);
};

/** Departure 6, logged, never judged: what happened natively to each handed-off pong. */
export function pongFates(r: WireRun): Record<string, number> {
  const fates: Record<string, number> = {};
  for (const x of r.exe.log) {
    if (!isPong(x.body)) continue;
    const fate = x.refused ? 'busy' : r.server.arrivals.some((a) => isPong(a.body) && a.body.id === x.body!.id) ? 'received' : x.cancelAsked !== undefined ? 'cancelled' : 'lost';
    fates[fate] = (fates[fate] ?? 0) + 1;
  }
  return fates;
}

/** H4 (the pass build): every net_cancel returns within the detach bound, even while a helper is held. */
export const H4: Check = (r) =>
  r.exe.log
    // A helper the fake exe didn't hold ends at once, in steps; only a held one tests the bound (a timer
    // the scheduler picked early can move the clock past any of them).
    .filter((x) => x.held && x.cancelAt !== undefined && (x.endAt === undefined ? r.sched.now - x.cancelAt! > DETACH_MS : x.endAt - x.cancelAt! > DETACH_MS))
    .map((x) => `H4: net_cancel for request ${x.n} took ${x.endAt === undefined ? 'more than' : ''}${(x.endAt ?? r.sched.now) - x.cancelAt!} ms`)
    .slice(0, 3);

/** H5 (the pass build): a model fetch is never refused busy, whatever the servers hold. */
export const H5: Check = (r) =>
  r.evidence
    .filter((e) => e.what === 'model' && !e.ok)
    .map(() => `H5: a model fetch refused busy with ${r.exe.peakServer} server requests open`)
    .slice(0, 3);

/** H14: no call reaches the server twice; after a 404, initialize with no session id, then the new one. */
export const H14: Check = (r) => {
  const problems: string[] = [];
  // The exe's own redirect follow (the pre-pass contract, 4.3) is the exe's, not the client's.
  const calls = r.server.arrivals.filter((a) => isCall(a.body) && !a.followed);
  const seen = new Map<string, number>();
  for (const a of calls) seen.set(tokenOf(a.body), (seen.get(tokenOf(a.body)) ?? 0) + 1);
  // Two identical calls each answered on their own card may each go out once (T7 (j)): the count allowed
  // is the number of separate Yes records for that call.
  for (const [t, n] of seen) {
    const yeses = r.evidence.filter((e) => e.what === 'yes' && e.token === t).length;
    if (n > Math.max(1, yeses)) problems.push(`H14: ${t} reached the server ${n} times`);
  }
  if (r.server.arrivals.some((a) => a.method === 'GET' && !a.followed)) problems.push('H14: a GET reached the server');
  // A redirected head is refused: the call it carried never comes back as a result.
  for (const x of r.exe.log) {
    if (!x.redirected || !isCall(x.body)) continue;
    const out = r.evidence.find((e) => e.what === 'outcome' && e.token === tokenOf(x.body))?.outcome;
    if (out?.kind === 'result') problems.push(`H14: ${tokenOf(x.body)} came back as a result through a redirect`);
  }
  const recs = r.exe.log.filter((x) => x.kind === 'post');
  // Per run (one Start to its end), never per initialize: a re-handshake belongs to the run it recovers.
  const sameRun = (a: NativeRec, b: NativeRec) => runOf(r, a) === runOf(r, b);
  const lastPage = (x: NativeRec) => x.body?.method === 'tools/list' && x.final !== undefined && x.status === 200 && !x.plan?.messages.some((m) => m.result?.nextCursor !== undefined);
  for (let i = 0; i < recs.length; i++) {
    const drop = recs[i]!;
    if (drop.status !== 404) continue;
    const run = recs.filter((x) => sameRun(x, drop));
    const wasReady = run.some((x) => x.seq < drop.seq && lastPage(x));
    // A second drop before any page or call completed after the last recovery's own walk ends the run.
    const prior = run.filter((x) => x.seq < drop.seq && x.status === 404).at(-1);
    let second = false;
    if (prior) {
      const reinit = run.find((x) => x.seq > prior.seq && x.body?.method === 'initialize');
      const walked = reinit ? run.find((x) => x.seq > reinit.seq && lastPage(x)) : undefined;
      const completedAfter = walked ? run.some((x) => x.seq > walked.seq && x.seq < drop.seq && (x.body?.method === 'tools/list' || x.body?.method === 'tools/call') && x.status === 200 && x.final !== undefined) : false;
      second = !completedAfter;
    }
    const after = run.filter((x) => x.seq > drop.seq && x.body && !isPong(x.body));
    if (second || !wasReady) {
      const restart = r.evidence.find((e) => e.what === 'start' && e.seq > drop.seq);
      const more = after.filter((x) => !restart || x.seq < restart.seq);
      if (more.length) problems.push(`H14: after ${second ? 'a second 404 with nothing completed since the recovery' : 'a 404 before the run was Ready'}, ${more[0]!.body!.method} was still sent`);
      continue;
    }
    const next = after[0];
    if (!next) {
      // An empty history after a recoverable 404 is a missed re-handshake, unless Stop came or the run hit
      // its step bound first.
      const stopped = r.evidence.some((e) => e.what === 'stop' && e.seq > drop.seq);
      // In the pre-pass build a held helper keeps the 404's own cleanup past the re-handshake's deadline
      // (H4's measured limitation): the recovery times out before it can send.
      const heldCleanup = drop.held && r.exe.build === 'prepass';
      if (!stopped && !heldCleanup && r.sched.step < 1500) problems.push('H14: after a 404 on a Ready run, no re-handshake');
      continue;
    }
    if (next.body?.method !== 'initialize') {
      problems.push(`H14: after a 404, ${next.body?.method} before a fresh initialize`);
      continue;
    }
    if (next.headers['mcp-session-id'] !== undefined) problems.push('H14: the re-handshake carried the old session id');
  }
  // While a session is being recovered, from the 404 until the re-handshake's tool list has come back, no
  // call is handed off (F02).
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]!.status !== 404) continue;
    const listed = recs.find((x) => x.seq > recs[i]!.seq && x.body?.method === 'tools/list' && x.final !== undefined);
    const until = listed ? Math.floor(listed.final! / 1000) : Infinity;
    const during = recs.filter((x) => x.seq > recs[i]!.seq && isCall(x.body) && x.start < until && x.epoch === (recs.find((y) => y.seq > recs[i]!.seq && y.body?.method === 'initialize')?.epoch ?? -1));
    if (during.length) problems.push(`H14: ${tokenOf(during[0]!.body)} handed off while the session was being recovered`);
    // And refused as the run not being Ready, not only by the busy slot: the fence holds on its own.
    // From the step after the 404's head (sessionDropped runs in that step) to the relisting's step.
    const from = recs[i]!.head ?? Infinity;
    const tried = r.evidence.filter((e) => e.what === 'call' && e.step > from && e.step < until).map((e) => e.token);
    const busy = r.evidence.filter((e) => e.what === 'outcome' && tried.includes(e.token) && e.outcome?.kind === 'error' && e.outcome.reason === 'busy');
    if (busy.length) problems.push(`H14: ${busy[0]!.token}, tried during the recovery, was refused only as busy: the run still said Ready`);
  }
  return problems.slice(0, 3);
};

export const WIRE_CHECKS: Record<string, Check> = { H1, H2, H3, H10, H11, H12, H13, H14 };
export const PASS_CHECKS: Record<string, Check> = { ...WIRE_CHECKS, H4, H5 };

/** Each check's witness (7.2): a step where its condition was in play and could have failed. */
export const WITNESSES: Record<string, (r: WireRun) => boolean> = {
  'H1 a busy refusal': (r) => r.evidence.some((e) => e.what === 'outcome' && e.outcome?.kind === 'error' && e.outcome.reason === 'busy'),
  'H3 a revoke before a handoff': (r) => r.evidence.some((e) => e.what === 'revoke'),
  'H10 a stale response id': (r) => r.exe.log.some((x) => x.plan?.messages.some((m) => m.result && m.id !== x.body?.id && x.body?.method === 'tools/call')),
  'H11 a mirrored header': (r) => r.exe.log.some((x) => Object.keys(x.headers).some((k) => k.startsWith('mcp-param-'))),
  'H12 a modern run': (r) => r.exe.log.some((x) => x.headers['mcp-protocol-version'] === '2026-07-28'),
  'H13 departure 1 (a flood)': (r) => r.evidence.some((e) => e.what === 'outcome' && e.outcome?.kind === 'error' && /too many pings/.test(e.outcome.words)),
  'H13 departure 2 (a local ping while draining or blocked)': (r) => r.server.pings.some((p) => r.exe.pingDelivered.has(p.id) && !r.exe.log.some((x) => isPong(x.body) && String(x.body!.id) === p.id)),
  'H13 departure 5 (a ping after the final)': (r) => r.exe.log.some((x) => x.final !== undefined && [...x.delivered.values()].some((d) => d > x.final!)),
  'H13 a ping with the final reply, answered': (r) => r.exe.log.some((x) => x.final !== undefined && [...x.delivered].some(([id, d]) => Math.floor(d / 1000) === Math.floor(x.final! / 1000) && d < x.final! && r.exe.log.some((y) => isPong(y.body) && String(y.body!.id) === id))),
  'H14 a 404 and its re-handshake': (r) => r.exe.log.some((x) => x.status === 404),
  'H14 a redirect': (r) => r.exe.log.some((x) => x.redirected)
};
export const PASS_WITNESSES: Record<string, (r: WireRun) => boolean> = {
  'H4 a held helper detached': (r) => r.exe.log.some((x) => x.detached),
  [`H5 a saturation (${EXE_SERVER_CAP} server requests open)`]: (r) => r.exe.peakServer >= EXE_SERVER_CAP && r.evidence.some((e) => e.what === 'model')
};
export type { Evidence };
