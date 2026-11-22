// The independent checks (docs/mcp-design.md 7.2). Each reads only the fake exe's log, the fake server's
// own record and the driver's evidence log, never the client's state.

import { CONTRACT_DETACH_MS, CONTRACT_INTERIM_WRITE_MS, CONTRACT_SERVER_CAP } from './contract.ts';
import { createHash } from 'node:crypto';
import { canonical, catalogAt } from './catalog.ts';
import { readPrefix, rejectedByShape, type Evidence, type NativeRec, type WireRun } from './wire.ts';
import { initialState, next, type LcEvent, type Reply } from '../../src/mcp/wire/lifecycle.ts';

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
/** The Starts and Tests the client admitted on a server, in order, as the driver saw the server go to
    Starting in the step it asked: a Start or Test refused (busy, already running, the owner busy) begins no run. */
function admittedStarts(r: WireRun, server: string): Evidence[] {
  return r.evidence.filter((e) => (e.what === 'start' || e.what === 'test') && addressOf(e.server) === server && (e.admitted || evidenceControls.countRefusedStarts));
}
/** The harness's own controls, for its tests only: count refused Starts as runs, as the old evidence did. */
import { evidenceControls } from './evidence-controls.ts';
export { evidenceControls };

function runOf(r: WireRun, x: NativeRec): number {
  if (x.kind === 'write') return x.epoch;
  return admittedStarts(r, x.server).filter((e) => e.seq < x.seq).length;
}

/** Whether the run a request belongs to had answered its Start (or Test) ready before it. */
function readyBefore(r: WireRun, x: NativeRec): boolean {
  const s = admittedStarts(r, x.server)[runOf(r, x) - 1];
  if (!s) return false;
  // Its own reply, by the action's token.
  const reply = r.evidence.find((y) => y.what === (s.what === 'start' ? 'started' : 'tested') && y.server === s.server && y.seq > s.seq && ((s.what === 'start' && evidenceControls.startsByOrder) || y.token === s.token));
  return !!reply && reply.seq < x.seq && !reply.failure && (reply.report?.ok ?? true);
}

const addressOf = (server: string | undefined) => `addr-${(server ?? 's1').slice(1)}`;

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
  // The interim write bound (4.3): no local write stays pending past it (with a second's slack for the
  // stop's own exit), however long the run goes on.
  for (const x of r.exe.log) {
    if (x.kind !== 'write' || x.startAt === undefined) continue;
    const waited = (x.endAt ?? r.sched.now) - x.startAt;
    if (waited > CONTRACT_INTERIM_WRITE_MS + 1_000) problems.push(`H1: a local write pending ${waited} ms, past the interim bound`);
  }
  // Cleanup the exe refused for good (four refused net_cancels): the slot stays held, nothing more goes to
  // that server, and a Start says the restart is needed, not "try again in a moment".
  for (const x of r.exe.log) {
    if ((x.refusals ?? 0) < 4) continue;
    const later = r.exe.log.find((y) => y.kind === 'post' && y.server === x.server && y.seq > x.seq && y.body && !isPong(y.body));
    if (later) problems.push(`H1: ${later.body!.method} went to a server whose cleanup the exe refused for good`);
    const start = r.evidence.find((e) => e.what === 'started' && addressOf(e.server) === x.server && e.step > x.start && e.failure);
    if (start && !/[Rr]estart/.test(start.words ?? '')) problems.push(`H1: after cleanup failed for good, Start said "${(start.words ?? '').slice(0, 60)}"`);
    const stop = r.evidence.find((e) => e.what === 'stopped' && e.failure !== 'refused' && addressOf(e.server) === x.server && e.step > x.start);
    if (stop && !/[Rr]estart/.test(stop.words ?? '')) problems.push(`H1: after cleanup failed for good, Stop said "${(stop.words ?? 'stopped').slice(0, 60)}"`);
  }
  // The first call made in the step its server's Start answered Ready, after that answer, is never refused
  // busy: Ready means the start's own exchanges have drained. (A second call in that step may wait behind the
  // first, and is refused busy rightly.)
  for (const e of r.evidence) {
    if (e.what !== 'started' || !e.ok) continue;
    const calls = r.evidence.filter((c) => c.what === 'call' && c.step === e.step && c.seq > e.seq && (c.server ?? 's1') === (e.server ?? 's1')).map((c) => c.token).slice(0, 1);
    const refused = r.evidence.find((o) => o.what === 'outcome' && calls.includes(o.token) && o.outcome?.kind === 'error' && o.outcome.reason === 'busy');
    if (refused) problems.push(`H1: ${refused.token}, made as its Start answered Ready, was refused busy`);
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
    // A response for this id read before the request was written is a stale one (a server replaying an
    // earlier run's id), not this request's answer.
    const seen = r.exe.responded.get(`${x.epoch}:${x.body.id}`);
    const answered = seen !== undefined && seen >= x.start ? seen : undefined;
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
  // A local Stop answers only once the process has exited, and each run is stopped natively once.
  if (r.server.mode.where === 'local') {
    for (const e of r.evidence) {
      if (e.what !== 'stop') continue;
      const answered = r.evidence.find((y) => y.what === 'stopped' && y.token === e.token && y.seq > e.seq);
      // The process Stop is for: the last one the exe admitted to start for that server before it, from the
      // exe's own start record, so a Stop while that start is still pending (no write yet) is judged too.
      const epoch = r.exe.processStarts.filter((t) => t.seq < e.seq && (evidenceControls.globalStarts || t.server === (e.server ?? 's1'))).at(-1)?.epoch;
      // Every Stop is answered, unless the run hit its step bound first.
      if (!answered) {
        if (epoch !== undefined && r.sched.step < 1500) problems.push(`H2: a local Stop made at step ${e.step} was never answered`);
        continue;
      }
      // A Stop refused (another one under way, or not running) stopped nothing; one answered "may still be
      // running" (the exe refused, or Stop's deadline came first) claims no exit.
      // Only a Stop that answered stopped claims an exit (its structured outcome, not its words).
      if (answered.stopOutcome !== 'stopped' || epoch === undefined) continue;
      const exit = r.exe.exits.find((t) => t.epoch === epoch);
      if (!exit || exit.step > answered.step) problems.push(`H2: a local Stop answered at step ${answered.step}, before its process exited${exit ? ` at ${exit.step}` : ''}`);
    }
    const perEpoch = new Map<number, number>();
    for (const t of r.exe.stopsAsked) perEpoch.set(t.epoch, (perEpoch.get(t.epoch) ?? 0) + 1);
    for (const [epoch, n] of perEpoch) if (n > 1) problems.push(`H2: run ${epoch} was stopped natively ${n} times`);
  }
  // Nothing reaches a run after its Stop: no request, notification or pong of that run starts once the
  // Stop was made. Locally the run is the stopped server's own process, the last the exe started for that
  // setup before the Stop (whether or not anything was written to it yet); remotely, its address's last epoch.
  for (const e of r.evidence) {
    if (e.what !== 'stop') continue;
    const local = r.server.mode.where === 'local';
    const address = local ? (e.server ?? 's1') : `addr-${(e.server ?? 's1').slice(1)}`;
    const epoch = local ? r.exe.processStarts.filter((t) => t.server === address && t.seq < e.seq).at(-1)?.epoch : r.exe.log.filter((x) => x.server === address && x.seq < e.seq).at(-1)?.epoch;
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
    // The expected bytes are the harness's own canonical form of the arguments the Yes was for, never the
    // client's: a shared canonicalization error can't pass.
    const want = `"arguments":${canonical(yes.args)}`;
    if (!x.raw?.includes(want) || x.body!.params?.name !== yes.tool) problems.push(`H3: the call for ${t} isn't, byte for byte, what its Yes showed: ${args.slice(0, 60)}`);
    if (used.has(t)) problems.push(`H3: the Yes for ${t} used twice`);
    used.add(t);
    // The person's one effective choice for this tool at the handoff: their latest act before it. A grant counts
    // from when its write to the owner resolved ok; a take-back from when it was made.
    // The evidence is bound to where the call went: the server it names is the handoff's own destination.
    const named = yes.server ?? 's1';
    if (destination(r, named) !== x.server) problems.push(`H3: ${t} went out to ${x.server}, its evidence names ${named}`);
    const effective = latestAct(r, named, yes.tool!, x.seq);
    if (effective?.what === 'revoke') problems.push(`H3: ${t} went out after a revoke of ${yes.tool}`);
    const now = listedAt(r, x.server, x.start, yes.tool!);
    if (yes.grant !== undefined) {
      // A call under "may run on its own": the effective choice is a grant, the one this decision names, and
      // the server lists exactly the version that grant's card showed (the grant carries the harness's own
      // reading of it). Nothing in between matters: a tool that went A, B, A runs on its own again at A (the
      // owner's option A); any other version asks.
      // The grant is matched by its full identity (server and tool by the replay, then its fingerprint and
      // setup), and it is the effective choice both when the decision was minted and at the handoff.
      const isTheGrant = (act: Evidence | undefined) => act?.what === 'grant' && act.grant === yes.grant && act.setup !== undefined && act.setup === yes.setup;
      // And the setup they name is the one the run the call reached was launched from, as the harness added
      // it, fingerprinted by the harness's own reading.
      const launched = r.setups.get(named);
      if (!launched || yes.setup !== launchFingerprint(launched)) problems.push(`H3: ${t} went out under a decision for another setup than its run was launched from`);
      const atMint = latestAct(r, named, yes.tool!, yes.seq);
      if (!isTheGrant(atMint)) problems.push(`H3: ${t} was minted under a grant that wasn't the person's choice for ${yes.tool} when it was minted`);
      else if (!isTheGrant(effective)) {
        if (effective?.what !== 'revoke') problems.push(`H3: ${t} went out under a grant that isn't the person's choice for ${yes.tool} at its handoff`);
      } else if (effective!.def === undefined || effective!.def !== now) problems.push(`H3: ${t} went out under a grant for ${yes.tool}, which the server lists at another version at its handoff`);
      continue;
    }
    // A Yes: the tool as the server last listed it before the card, and before the handoff. A change between
    // (a fingerprint change) means the Yes allowed something else (S1).
    const card = r.evidence.find((e) => e.what === 'card' && e.token === t) ?? yes;
    if (listedAt(r, x.server, card.step, yes.tool!) !== now) problems.push(`H3: ${t} went out though ${yes.tool} changed after its card was shown`);
  }
  problems.push(...staleCatalogCalls(r));
  return problems.slice(0, 3);
};

/** The fingerprint of a setup's launch, restated here from what it binds (never imported): locally, the
    program, its arguments, its folder, its environment (names upper-cased, sorted) and its secrets' names
    (upper-cased, sorted); remotely, the address, its transport, its headers (names lower-cased, sorted), its
    key's header and prefix, and the saved address id. SHA-256 over their canonical JSON, in hex. */
function launchFingerprint(s: Record<string, any>): string {
  const bound =
    s.kind === 'local'
      ? { kind: 'local', program: s.program, args: s.args, cwd: s.cwd, env: [...s.env].map(([k, v]: [string, string]) => [k.toUpperCase(), v]).sort(), secrets: [...s.secrets].map((n: string) => n.toUpperCase()).sort() }
      : { kind: 'remote', url: s.url, transport: s.transport, headers: [...s.headers].map(([k, v]: [string, string]) => [k.toLowerCase(), v]).sort(), key: s.key ? { header: s.key.header.toLowerCase(), prefix: s.key.prefix } : null, address: s.address ?? null };
  return createHash('sha256').update(canonical(bound)).digest('hex');
}

/** Where a server's calls go natively: its saved address (remote, issued in the order servers were added), or
    its setup's own id (local). */
const destination = (r: WireRun, server: string) => (r.server.mode.where === 'remote' ? `addr-${server.slice(1)}` : server);

/** The person's latest act on one server's tool before `before` (a sequence): a grant written to the owner,
    counted from when its write resolved ok, or a take-back, from when it was made. Undefined: no act. */
function latestAct(r: WireRun, server: string, tool: string, before: number): Evidence | undefined {
  return r.evidence
    .filter((e) => (e.server ?? 's1') === server && e.tool === tool && e.seq < before && (e.what === 'grant' || e.what === 'revoke'))
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
}

/** A list_changed delivered on a run makes its catalog stale: no call goes out on that run until a tools/list
    walked after it has come back whole (G26). The notification comes ahead of its stream's final message,
    so it was delivered by the step that message was. */
function staleCatalogCalls(r: WireRun): string[] {
  const problems: string[] = [];
  const recs = r.exe.log.filter((x) => x.kind === 'post');
  for (const c of recs) {
    // A notice the client read: one in the prefix its parser read, through the final response or the first
    // message it rejects, whichever came first (it reads nothing after either).
    if (c.final === undefined || !c.plan || !readPrefix(c.plan).some((m) => m.method === 'notifications/tools/list_changed')) continue;
    const d = Math.floor(c.final / 1000);
    // The relist: a walk from page 1 started after the notification, complete (its last page back whole).
    const firstPage = recs.find((x) => x.server === c.server && x.epoch === c.epoch && x.body?.method === 'tools/list' && x.body.params?.cursor === undefined && x.start >= d && !(x.plan && readPrefix(x.plan).some((m) => m.method === 'notifications/tools/list_changed')));
    const lastPage = firstPage && recs.find((x) => x.server === c.server && x.seq >= firstPage.seq && x.body?.method === 'tools/list' && x.final !== undefined && !x.plan?.messages.some((m) => m.result?.nextCursor !== undefined));
    const until = lastPage ? Math.floor(lastPage.final! / 1000) : Infinity;
    const call = recs.find((x) => x.server === c.server && x.epoch === c.epoch && isCall(x.body) && x.start > d && x.start <= until);
    if (call) problems.push(`H3: ${tokenOf(call.body)} went out on a catalog a list_changed had made stale`);
  }
  return problems;
}

/** The tool's definition in the last completed walk that reached the client before `step`. */
function listedAt(r: WireRun, server: string, step: number, tool: string): string | undefined {
  return catalogAt(r.exe, server, step, tool);
}

/** Whether the server wrote a well-formed answer to this call: an event stream, or a JSON body with its one
    message (an empty JSON body is the server's own invalid answer), and no message in it that 3.10's shape
    rules reject (the harness's own reading): an answer holding one is the server's invalid answer too. */
function wroteValid(r: WireRun, token: string): boolean {
  const rec = r.exe.log.find((x) => isCall(x.body) && tokenOf(x.body) === token);
  const exact = !rec?.contentType || rec.contentType === 'application/json' || rec.contentType === 'text/event-stream';
  // Judged on what the client's parser read: a malformed message after the final response is never read.
  return !!rec?.plan && exact && rec.plan.status === 200 && (rec.plan.sse || rec.plan.messages.length > 0) && !readPrefix(rec.plan).some(rejectedByShape);
}

/** H10: a late or stale response never reaches a caller: a call's result names its own token, and comes
    through exactly as the server wrote it, its multibyte characters whole however the bytes were split. */
export const H10: Check = (r) => {
  const extra: string[] = [];
  for (const x of r.exe.log) {
    if (x.kind !== 'post' || !x.contentType) continue;
    const exact = x.contentType === 'application/json' || x.contentType === 'text/event-stream';
    if (exact) continue;
    // Only the two exact media types are read: an answer of any other type never comes back as a result.
    const out = isCall(x.body) ? r.evidence.find((e) => e.what === 'outcome' && e.token === tokenOf(x.body))?.outcome : undefined;
    if (out?.kind === 'result') extra.push(`H10: ${tokenOf(x.body)}'s answer, of type ${x.contentType.slice(0, 30)}, was read`);
    // And no server header text past 40 characters reaches any words.
    if (x.contentType.length > 40) {
      const piece = x.contentType.slice(0, 41);
      const leaked = r.evidence.find((e) => JSON.stringify(e.outcome ?? e.words ?? '').includes(piece));
      if (leaked) extra.push(`H10: a server's ${x.contentType.length}-character content type reached the words of ${leaked.token ?? leaked.what}`);
    }
  }
  const results = r.evidence.filter((e) => e.what === 'outcome' && e.outcome?.kind === 'result' && !e.outcome.isError);
  return [
    ...results.filter((e) => !(e.outcome as { text: string }).text.includes(e.token!)).map((e) => `H10: ${e.token} answered with another call's result: ${(e.outcome as { text: string }).text.slice(0, 40)}`),
    ...results.filter((e) => (e.outcome as { text: string }).text.includes(e.token!) && !(e.outcome as { text: string }).text.includes('— café ✓ 𝄞')).map((e) => `H10: ${e.token}'s result came through changed: ${JSON.stringify((e.outcome as { text: string }).text.slice(-24))}`),
    // The scripted server writes only valid answers: one read as invalid was split or decoded wrong.
    ...extra,
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
  const recs = r.exe.log.filter((x) => x.kind === 'post');
  // A run is modern by the server's own record: its opening initialize was refused -32022. Never by the
  // client's own headers.
  const modernRun = (x: NativeRec) => {
    const opening = recs.find((y) => runOf(r, y) === runOf(r, x) && y.server === x.server && y.body?.method === 'initialize');
    return !!opening?.plan?.messages.some((m) => m.error?.code === -32022);
  };
  for (const x of recs) {
    if (!isCall(x.body) || !modernRun(x)) continue;
    const b = x.body!;
    if (x.headers['mcp-method'] !== 'tools/call') problems.push('H11: Mcp-Method missing on a call');
    if (x.headers['mcp-name'] !== b.params?.name) problems.push('H11: Mcp-Name differs from the body');
    // The schema as the server listed it last before this call, scanned by the harness's own scanner.
    // The run's whole catalog, every page of the last walk before this call.
    const pages = recs.filter((y) => y.server === x.server && runOf(r, y) === runOf(r, x) && y.body?.method === 'tools/list' && y.seq < x.seq && y.plan);
    const firstOfLast = pages.map((y, i) => [y, i] as const).filter(([y]) => y.body?.params?.cursor === undefined).at(-1)?.[1] ?? 0;
    const listed = pages.slice(firstOfLast).flatMap((y) => (y.plan?.messages.find((m) => m.result?.tools)?.result.tools as any[] | undefined) ?? []);
    const schema = listed.find((t) => t.name === b.params?.name)?.inputSchema ?? {};
    const decls = declared(schema);
    // No header beyond the declared ones.
    for (const k of Object.keys(x.headers)) if (k.startsWith('mcp-param-') && !decls.some((d) => `mcp-param-${d.name.toLowerCase()}` === k)) problems.push(`H11: an undeclared header ${k}`);
    for (const d of decls) {
      let v: any = b.params?.arguments;
      for (const k of d.path) v = v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
      const header = x.headers[`mcp-param-${d.name.toLowerCase()}`];
      if (v === undefined || v === null) {
        if (header !== undefined) problems.push(`H11: a header for an absent ${d.name}`);
        continue;
      }
      const text = typeof v === 'string' ? v : String(v);
      const plain = typeof v !== 'string' || (v !== '' && v === v.trim() && /^[\x20-\x7e\t]*$/.test(v) && !(v.startsWith('=?base64?') && v.endsWith('?=')));
      const expected = plain ? text : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
      // A value that can't be mirrored faithfully (a lone surrogate), or whose whole header line passes 8 KiB
      // once encoded (its name and separator included, as the native bound counts it), makes no request:
      // every declared argument of every modern call, against the catalog in force at its handoff.
      const lone = typeof v === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
      if (lone || Buffer.byteLength(`Mcp-Param-${d.name}: ${expected}`) > 8 * 1024) {
        problems.push(`H11: ${tokenOf(b)}'s ${d.name} can't be mirrored, and a request went out`);
        continue;
      }
      if (header !== expected) problems.push(`H11: Mcp-Param-${d.name} is "${String(header).slice(0, 30)}", the body says "${text.slice(0, 30)}"`);
    }
  }
  // A $ref inside a schema's data (default, examples) is data, never a position: mirror3 stays offered.
  for (const e of r.evidence) if (e.what === 'not-offered' && e.tool === 'mirror3' && r.server.mode.era !== 'legacy') problems.push('H11: mirror3, whose only $ref is in its data, was not offered');
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
  // A local start relaunched (a new process with no Start between) only when its modern list got no
  // JSON-RPC answer: a definitive refusal ends the start, with no relaunch.
  for (const x of r.exe.log) {
    if (x.kind !== 'write' || x.body?.method !== 'tools/list' || !x.plan?.messages.some((m) => m.id === x.body!.id && m.error)) continue;
    const next = r.exe.log.find((y) => y.kind === 'write' && y.epoch > x.epoch);
    const restarted = next && r.evidence.some((e) => (e.what === 'start' || e.what === 'test') && e.seq > x.seq && e.seq < next.seq);
    if (next && !restarted) problems.push('H12: a start relaunched after its modern list was answered with a refusal');
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
      // Departure 1, judged at the ping's own delivery: the flood rule held then (two pongs outstanding, or
      // 32 handed off), or a flood ping came before it on this stream.
      if (/too many pings/.test(words(tokenOf(post.body))) && floodAt(r, [...post.delivered], post.delivered.get(p.id)!, handed)) continue;
      // Departure 2, remotely: the exchange had already ended for the client and only drains, its cancel
      // refused, so the exe keeps reading what the server sends. Only a ping delivered strictly after the
      // client's terminal position on this stream (its first net_cancel, at the same resolution as delivery)
      // is excused: one that came before it, in the same chunk or step, is the client's to answer.
      if (post.endedAt !== undefined && post.delivered.get(p.id)! > post.endedAt && (post.refusals ?? 0) > 0) continue;
      problems.push(`H13: ping ${p.id} on request ${post.n} got no pong and no departure`);
      continue;
    }
    const at = r.exe.pingDelivered.get(p.id);
    if (at === undefined) continue; // never reached the client
    const carrier = r.exe.log.find((x) => `w${x.n}` === p.on);
    if (!carrier) continue;
    // Departure 1, judged at the ping's own delivery, as remotely.
    const carried = r.server.pings.filter((q) => q.on === p.on && r.exe.pingDelivered.has(q.id)).map((q) => [q.id, r.exe.pingDelivered.get(q.id)! * 1000] as [string, number]);
    if (/too many pings/.test(words(tokenOf(carrier.body))) && floodAt(r, carried, at * 1000, handed)) continue;
    const responded = r.exe.responded.get(`${carrier.epoch}:${carrier.body?.id}`);
    // Draining: the carrier's own response came, or its own cancel was written (matched by its request id, not
    // any cancel on that process).
    const draining = (responded !== undefined && responded < at) || r.exe.log.some((y) => y.kind === 'write' && y.epoch === carrier.epoch && y.body?.method === 'notifications/cancelled' && String(y.body.params?.requestId) === String(carrier.body?.id) && y.start <= at);
    const blocked = r.exe.log.some((y) => y.kind === 'write' && y.epoch === carrier.epoch && y.start <= at && (y.end ?? Infinity) > at);
    // Another exchange live on the same run when an idle ping comes: it waits for no one, so it's departure 2.
    const busyElsewhere = p.id.startsWith('i') && r.exe.log.some((y) => y.kind === 'write' && y.epoch === carrier.epoch && y.body?.method && y.body.id !== undefined && y.start <= at && (r.exe.responded.get(`${y.epoch}:${y.body.id}`) ?? Infinity) >= at);
    // Stop, or any end of the run that asks the exe to stop the process, ends the live exchange in its own
    // step, so a ping that comes after it meets a drain.
    const stopped = r.evidence.some((e) => e.what === 'stop' && e.step <= at && !r.exe.exits.some((t) => t.epoch === carrier.epoch && t.step < e.step)) || r.exe.stopsAsked.some((t) => t.epoch === carrier.epoch && t.step <= at);
    if (draining || blocked || busyElsewhere || stopped) continue; // departure 2
    problems.push(`H13: local ping ${p.id} got no pong and no departure`);
  }
  return problems.slice(0, 3);
};

/** Whether a ping delivered at `d` (step × 1000 + order) on a stream met the flood rule: at that moment two
    of the stream's pongs were outstanding or 32 were handed off, or an earlier ping on it already had. */
function floodAt(r: WireRun, delivered: readonly [string, number][], d: number, handed: ReadonlySet<string>): boolean {
  const pongOf = (id: string) => r.exe.log.find((x) => isPong(x.body) && String(x.body!.id) === id);
  const at = (t: number) => {
    const before = delivered.filter(([id, when]) => when < t && handed.has(id)).map(([id]) => pongOf(id)).filter((x): x is NativeRec => !!x);
    const outstanding = before.filter((x) => (x.end ?? Infinity) * 1000 > t).length;
    return outstanding >= 2 || before.length >= 32;
  };
  // This ping, or an earlier unanswered one that flooded, met the rule.
  return at(d) || delivered.some(([id, when]) => when < d && !handed.has(id) && at(when));
}

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
    .filter((x) => x.held && x.cancelAt !== undefined && (x.endAt === undefined ? r.sched.now - x.cancelAt! > CONTRACT_DETACH_MS : x.endAt - x.cancelAt! > CONTRACT_DETACH_MS))
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
  const posts = r.exe.log.filter((x) => x.kind === 'post');
  // From a 404 on a run with a session until its recovery's initialize, nothing goes without the session id
  // (nor with it): the run's next request is that initialize.
  for (const drop of posts.filter((x) => x.status === 404 && x.headers['mcp-session-id'] !== undefined)) {
    const reinit = posts.find((x) => x.server === drop.server && x.seq > drop.seq && x.body?.method === 'initialize');
    const between = posts.filter((x) => x.server === drop.server && x.seq > drop.seq && (!reinit || x.seq < reinit.seq) && x.body && !isPong(x.body) && x.body.method !== 'notifications/cancelled' && runOf(r, x) === runOf(r, drop));
    const bare = between.find((x) => x.headers['mcp-session-id'] === undefined);
    if (bare && reinit) problems.push(`H14: a ${bare.body!.method} without the session id between a 404 and its recovery's initialize`);
  }
  // No walk beside one: per run, the walks started (first pages) are the run's first, one per list_changed
  // read since, and one per recovery; never one more.
  const runs = new Map<string, NativeRec[]>();
  for (const x of posts) runs.set(`${x.server}:${runOf(r, x)}`, [...(runs.get(`${x.server}:${runOf(r, x)}`) ?? []), x]);
  for (const [, recs] of runs) {
    const firsts = recs.filter((x) => x.body?.method === 'tools/list' && x.body.params?.cursor === undefined).length;
    // Each list_changed that reached the client's reads, whether or not its stream got to its end.
    const changes = recs.reduce((n, x) => n + (x.changesDelivered ?? 0), 0);
    const recoveries = recs.filter((x) => x.body?.method === 'initialize').length - 1;
    // A Test is a run of its own (admittedStarts), whose one walk is that run's first: a Test elsewhere, on
    // this server or another, allows this run no walk.
    const tests = evidenceControls.globalTests ? r.evidence.filter((e) => e.what === 'test').length : 0;
    if (firsts > 1 + changes + Math.max(0, recoveries) + tests) problems.push(`H14: ${firsts} walks on a run with ${changes} list_changed and ${Math.max(0, recoveries)} recoveries`);
  }
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
  const sameRun = (a: NativeRec, b: NativeRec) => a.server === b.server && runOf(r, a) === runOf(r, b);
  const lastPage = (x: NativeRec) => x.body?.method === 'tools/list' && x.final !== undefined && x.status === 200 && !x.plan?.messages.some((m) => m.result?.nextCursor !== undefined);
  for (let i = 0; i < recs.length; i++) {
    const drop = recs[i]!;
    if (drop.status !== 404) continue;
    const run = recs.filter((x) => sameRun(x, drop));
    // Ready: its Start had answered ready (a walk's last page alone isn't, since a list_changed retries it).
    const wasReady = readyBefore(r, drop);
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
      const stopped = r.evidence.some((e) => e.what === 'stop' && e.seq > drop.seq && addressOf(e.server) === drop.server);
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
    const listed = recs.find((x) => x.seq > recs[i]!.seq && x.server === recs[i]!.server && x.body?.method === 'tools/list' && x.final !== undefined);
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

/** H15: Test acts on its own run only. Between a Test and its report, the only native stop is of the run
    Test started; a Test that met a Stop doesn't report success; a report that lists names them from its run. */
export const H15: Check = (r) => {
  const problems: string[] = [];
  for (const t of r.evidence) {
    if (t.what !== 'test') continue;
    const done = r.evidence.find((e) => e.what === 'tested' && e.server === t.server && e.seq > t.seq);
    if (!done) continue;
    // Local: Test's run is the first process started after it was asked.
    const own = r.exe.log.find((x) => x.kind === 'write' && x.seq > t.seq)?.epoch;
    for (const s of r.exe.stopsAsked) {
      if (s.step < t.step || s.step > done.step) continue;
      if (own !== undefined && s.epoch !== own) problems.push(`H15: Test stopped run ${s.epoch}, not its own run ${own}`);
    }
    const stopped = r.evidence.some((e) => e.what === 'stop' && e.server === t.server && e.seq > t.seq && e.seq < done.seq);
    if (stopped && done.report?.ok) problems.push(`H15: a Test that met a Stop reported success (${done.report.tools.length} tools)`);
    if (done.report?.ok && !done.report.tools.length) problems.push('H15: Test reported success with no tools');
  }
  return problems.slice(0, 3);
};

/** Every native handoff up to a step, whole: kind, server, method, URL, headers and bytes (the twin rule). */
export function handoffHistory(r: WireRun, upTo: number): string {
  return JSON.stringify(r.exe.log.filter((x) => x.start <= upTo).map((x) => [x.kind, x.server, x.method, x.url ?? null, [...(x.headerPairs ?? Object.entries(x.headers))].map(([k, v]) => [k.toLowerCase(), v]).sort(), x.start, x.raw ?? null]));
}

/** Whether a reply the driver noted says what the machine's answer did, as the client reads that answer:
    the runtime's reading for a Start or Stop, Test's own for a Test (restated here, never imported). */
function replyAgrees(action: 'start' | 'stop' | 'test', reply: Reply, e: Evidence): boolean {
  if (action === 'test') {
    if (reply.kind === 'tested') return e.report?.ok === true;
    if (e.report?.ok !== false) return false;
    return reply.kind === 'failed' ? e.words === reply.failure.words : reply.kind === 'refused' ? e.words === reply.words : true;
  }
  const kind = reply.kind === 'tested' ? 'stopped' : reply.kind;
  if (action === 'start') {
    if (kind === 'ready') return e.ok === true && e.failure === undefined;
    if (e.ok) return false;
    if (reply.kind === 'failed') return e.failure === reply.failure.kind && e.words === reply.failure.words;
    if (reply.kind === 'refused') return e.failure === 'refused' && e.words === reply.words;
    return e.failure === undefined;
  }
  if (kind === 'stopped') return e.stopOutcome === 'stopped';
  if (reply.kind === 'refused') return e.stopOutcome === 'refused' && e.words === reply.words;
  if (reply.kind === 'failed') return (e.stopOutcome === 'failed' || e.stopOutcome === 'may-still-run') && e.failure === reply.failure.kind && e.words === reply.failure.words;
  return e.stopOutcome === 'failed' && e.failure === undefined;
}

/** An owner reservation replay says was taken: for the event at record `seq`, and released by the event
    recorded in (after, before), or never (`open`). */
interface OwedReservation {
  readonly server: string;
  readonly i: number;
  /** Taken after this record sequence (the person's action, or the start of the step that asked the owner
      again for a relaunch) and before `seq`. */
  readonly from: number;
  /** And before this record sequence: its own event's (a Start's), or the readmit-check's transition. */
  readonly to: number;
  readonly seq: number;
  readonly released: { readonly after: number; readonly before: number } | 'open';
}

/**
 * HC, conformance: the real driver decided nothing outside the machine. Each server's record of events and
 * the states the driver then held is replayed through next() from the start, and every state must be the
 * one the machine gives; and whenever the driver's queue had drained, its slot mirror must match the
 * exchange machine's. Replay's effects are then matched one by one, never by count, with what was recorded
 * apart from the driver: each answer with the person's own action (the k-th action that reaches the machine
 * is its k-th action event) and that action's reply (by its token, of the same outcome, after the answer,
 * in the order answered); each native start and stop with the port's own start and stop made while its event
 * was applied, a stop naming the very process its run's start launched; and each owner reservation taken
 * with one recorded at the owner, released while the event that releases it was applied, or still held.
 */
export const HC: Check = (r) => {
  const problems: string[] = [];
  const owed: OwedReservation[] = [];
  // Every reply answered once, across every server's replay.
  const usedReplies = new Set<Evidence>();
  // Every server present in either record, the lifecycle's or the exchange machine's: an exchange of a
  // server with no lifecycle record is accounted too.
  for (const server of new Set([...r.lifecycle.keys(), ...r.exchanges.keys()])) {
    const records = r.lifecycle.get(server) ?? [];
    let s = initialState(server);
    const actions = r.evidence.filter((e) => (e.server ?? 's1') === server && (e.what === 'start' || e.what === 'stop' || (e.what === 'test' && e.reaches)));
    const asked = records.filter((x) => x.event.t === 'start' || x.event.t === 'stop');
    if (asked.length !== actions.length) problems.push(`HC: ${server}: the machine took ${asked.length} actions, the person made ${actions.length}`);
    const actionOf = new Map<string, Evidence>();
    asked.forEach((x, k) => {
      const a = actions[k];
      const ev = x.event as Extract<LcEvent, { t: 'start' | 'stop' }>;
      const kind = ev.t === 'stop' ? 'stop' : ev.mode === 'test' ? 'test' : 'start';
      if (a && a.what !== kind) problems.push(`HC: ${server}: the machine's action ${k + 1} is a ${kind}, the person's a ${a.what}`);
      if (a) actionOf.set(ev.token, a);
    });
    const ported = r.exe.processStarts.filter((t) => t.server === server);
    const epochs = new Set(ported.map((t) => t.epoch));
    const portStart = new Map<string, (typeof ported)[number]>();
    const usedStarts = new Set<object>();
    const usedStops = new Set<object>();
    const lastReply = new Map<string, number>();
    let holding: Omit<OwedReservation, 'released'> | undefined;
    // A relaunch asks the owner while its readmit-check is applied: the reservation is taken in that step.
    let readmitTake: { from: number; to: number } | undefined;
    const endLive: { run: string; i: number; seq: number }[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      const seq = rec.seq ?? 0;
      // An event's effects are applied after the record before it and before its own.
      const after = i ? (records[i - 1]!.seq ?? 0) : -Infinity;
      const out = next(s, rec.event);
      s = out.state;
      const ev = rec.event;
      // A reservation was taken for this event: its admission asked the owner, and the owner said yes.
      const takes = (ev.t === 'start' && ev.facts.record === 'ok' && ev.facts.ownerFree) || (ev.t === 'readmit' && ev.facts.ownerFree);
      // No earlier than its own action: the person's Start (or Test), or the readmit-check that asked for it.
      const take = ev.t === 'start' ? { from: actionOf.get(ev.token)?.seq ?? Infinity, to: seq } : ev.t === 'readmit' ? (readmitTake ?? { from: Infinity, to: -Infinity }) : { from: Infinity, to: -Infinity };
      if (ev.t === 'readmit') readmitTake = undefined;
      let kept = false;
      for (const fx of out.effects) {
        if (fx.t === 'native-start') {
          const t = ported.find((x) => !usedStarts.has(x) && x.seq > after && x.seq < seq);
          if (!t) problems.push(`HC: ${server}: native-start for ${fx.run} at event ${i} (${ev.t}), and no port start in its step`);
          else {
            usedStarts.add(t);
            portStart.set(fx.run, t);
          }
        } else if (fx.t === 'native-stop') {
          // The process the run's own start launched, by the exe's own epoch and handle.
          const want = portStart.get(fx.run);
          const inStep = r.exe.stopsAsked.filter((x) => (x.seq ?? 0) > after && (x.seq ?? 0) < seq);
          const t = inStep.find((x) => !usedStops.has(x) && x.epoch === want?.epoch && x.run === fx.process);
          if (!t) problems.push(`HC: ${server}: native-stop for ${fx.run} (run ${want?.epoch ?? '?'}) at event ${i} (${ev.t}), and the port stopped ${inStep.map((x) => `run ${x.epoch}`).join(', ') || 'nothing'} in its step`);
          else usedStops.add(t);
        } else if (fx.t === 'answer') {
          const act = actionOf.get(fx.token);
          if (!act) {
            problems.push(`HC: ${server}: event ${i} (${ev.t}) answers ${fx.token}, an action the person never made`);
            continue;
          }
          const what = act.what === 'start' ? 'started' : act.what === 'stop' ? 'stopped' : 'tested';
          const reply = r.evidence.find((e) => e.what === what && e.token === act.token && (e.server ?? 's1') === server && !usedReplies.has(e));
          if (!reply) {
            problems.push(`HC: ${server}: event ${i} (${ev.t}) answers ${act.token} ${fx.reply.kind}, and no reply came for it`);
            continue;
          }
          usedReplies.add(reply);
          if (reply.seq < seq) problems.push(`HC: ${server}: ${act.token}'s reply came before the event that answers it`);
          if (!replyAgrees(act.what as 'start' | 'stop' | 'test', fx.reply, reply)) problems.push(`HC: ${server}: event ${i} answers ${act.token} ${fx.reply.kind}, its reply says ${reply.ok ? 'ready' : (reply.stopOutcome ?? reply.failure ?? (reply.report?.ok ? 'tested' : 'not tested'))}`);
          // In order: one kind of action's replies come in the order the machine answered them.
          if (reply.seq < (lastReply.get(what) ?? -Infinity)) problems.push(`HC: ${server}: ${act.token}'s reply came before an earlier answer's`);
          lastReply.set(what, reply.seq);
        } else if (fx.t === 'owner-hold') {
          if (!takes) problems.push(`HC: ${server}: event ${i} (${ev.t}) holds the owner, with no reservation taken for it`);
          else {
            kept = true;
            holding = { server, i, from: take.from, to: take.to, seq };
          }
        } else if (fx.t === 'owner-release' && holding) {
          owed.push({ ...holding, released: { after, before: seq } });
          holding = undefined;
        } else if (fx.t === 'end-live') endLive.push({ run: fx.run, i, seq });
        // The relaunch's reservation is taken while this transition's effects are applied, and only then.
        else if (fx.t === 'readmit-check') readmitTake = { from: after, to: seq };
      }
      // Taken and not kept: released as the machine refused or answered the action, in its own step.
      if (takes && !kept) owed.push({ server, i, from: take.from, to: take.to, seq, released: { after, before: seq } });
      if (problems.length < 3 && canonical(s) !== canonical(rec.state)) {
        problems.push(`HC: ${server}'s state after event ${i} (${rec.event.t}) isn't the machine's`);
        s = rec.state;
      }
      if (problems.length < 3 && rec.quiet && (rec.state.slot === 'busy') !== rec.busy) problems.push(`HC: ${server}'s slot mirror says ${rec.state.slot} after event ${i} (${rec.event.t}), the exchange machine ${rec.busy ? 'busy' : 'idle'}`);
    }
    if (holding) owed.push({ ...holding, released: 'open' });
    // No port start or stop that replay didn't ask for, and no reply to an action replay never answered.
    for (const t of ported) if (!usedStarts.has(t)) problems.push(`HC: ${server}: the port started run ${t.epoch}, which no native-start asked for`);
    for (const t of r.exe.stopsAsked) if (epochs.has(t.epoch) && !usedStops.has(t)) problems.push(`HC: ${server}: the port stopped run ${t.epoch}, which no native-stop asked for`);
    // Every reply the driver noted, whatever its token: one for no action at all is no answer either.
    // Every exchange admitted for a run ends, by the exchange machine's own terminal step, once that run is
    // over; an end-live effect for a run with an exchange still open is followed by its end.
    const ex = r.exchanges.get(server) ?? [];
    // An end-live for a run with an exchange still open ends that exchange, as the run's end.
    for (const e of endLive) {
      const open = ex.filter((x) => x.t === 'admit' && x.run === e.run && x.seq < e.seq && !ex.some((y) => y.t === 'ended' && y.n === x.n && y.seq < e.seq));
      for (const o of open) if (!ex.some((y) => y.t === 'ended' && y.n === o.n && y.end === 'run-ended')) problems.push(`HC: ${server}: end-live for run ${e.run} at event ${e.i}, and its exchange ${o.n} (${o.kind}) didn't end as the run's end`);
    }
    // And every exchange that ended was admitted, of the same run and kind, before its end: an idle pong too.
    // Each admission is consumed by one end only: a second end on it is an end never admitted.
    const consumed = new Set<object>();
    for (const e of ex.filter((x) => x.t === 'ended')) {
      const a = ex.find((y) => y.t === 'admit' && !consumed.has(y) && y.n === e.n && y.run === e.run && y.kind === e.kind && y.seq < e.seq);
      if (a) consumed.add(a);
      else problems.push(`HC: ${server}: exchange ${e.n} (${e.kind}) of run ${e.run} ended, never admitted (or ended twice)`);
    }
    // The final accounting by the consumed admissions: an admission no end consumed is open, and only the
    // current run's may be; and an exchange number is admitted once.
    const current = s.run?.id;
    const numbers = new Set<number>();
    for (const a of ex.filter((x) => x.t === 'admit')) {
      if (numbers.has(a.n)) problems.push(`HC: ${server}: exchange ${a.n} admitted twice`);
      numbers.add(a.n);
      if (!consumed.has(a) && a.run !== current) problems.push(`HC: ${server}: exchange ${a.n} (${a.kind}) of run ${a.run}, which is over, never ended`);
    }
  }
  // No reply replay never answered, on any server, under any token: one for a server with no record at all
  // is no answer either.
  for (const e of r.evidence) if ((e.what === 'started' || e.what === 'stopped' || e.what === 'tested') && !usedReplies.has(e)) problems.push(`HC: ${e.server ?? 's1'}: a reply to ${e.token ?? 'no token'} that replay never answered`);
  // Each reservation replay took is one the owner recorded, taken before its event and released while the
  // event replay releases it by was applied (or still held); and none the owner recorded that replay didn't.
  const pool = r.reservations.filter((x) => x.what === 'start');
  const used = new Set<object>();
  for (const o of owed.sort((a, b) => a.seq - b.seq)) {
    const m = pool.find((x) => !used.has(x) && x.seq > o.from && x.seq < o.to && (o.released === 'open' ? x.released === undefined : x.released !== undefined && x.released > o.released.after && x.released < o.released.before));
    if (m) used.add(m);
    else problems.push(`HC: ${o.server}: event ${o.i} took the owner, and no reservation was ${o.released === 'open' ? 'still held' : 'released as replay releases it'}`);
  }
  for (const x of pool) if (!used.has(x)) problems.push(`HC: a start reservation (${x.seq}) replay never took`);
  // At each native start the owner is reserved, and by a start.
  for (const t of r.exe.processStarts) {
    const open = r.reservations.filter((x) => x.seq < t.seq && (x.released === undefined || x.released > t.seq));
    if (open.length !== 1 || open[0]!.what !== 'start') problems.push(`HC: a native start went out with the owner ${open.length ? `held for ${open.map((x) => x.what).join(', ')}` : 'free'}`);
  }
  return problems.slice(0, 4);
};

export const WIRE_CHECKS: Record<string, Check> = { H1, H2, H3, H10, H11, H12, H13, H14, H15, HC };
export const PASS_CHECKS: Record<string, Check> = { ...WIRE_CHECKS, H4, H5 };

/** Each check's witness (7.2): a step where its condition was in play and could have failed. */
export const WITNESSES: Record<string, (r: WireRun) => boolean> = {
  'H1 a busy refusal': (r) => r.evidence.some((e) => e.what === 'outcome' && e.outcome?.kind === 'error' && e.outcome.reason === 'busy'),
  'H3 a revoke before a handoff': (r) => r.evidence.some((e) => e.what === 'revoke'),
  'H10 a stale response id': (r) => r.exe.log.some((x) => x.plan?.messages.some((m) => m.result && m.id !== x.body?.id && x.body?.method === 'tools/call')),
  'H11 a mirrored header': (r) => r.exe.log.some((x) => Object.keys(x.headers).some((k) => k.startsWith('mcp-param-'))),
  'H11 a typed mirrored header': (r) => r.exe.log.some((x) => x.headers['mcp-param-count'] !== undefined),
  'H11 a value refused before the handoff': (r) => r.evidence.some((e) => e.what === 'outcome' && e.tool === 'mirror' && e.outcome?.kind === 'error' && /headers/.test(e.outcome.words)),
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
  // The model fetch made at the saturation itself, not merely some fetch in a run that peaked.
  [`H5 a saturation (${CONTRACT_SERVER_CAP} server requests open)`]: (r) => r.exe.log.some((x) => x.kind === 'model' && (x.openServer ?? 0) >= CONTRACT_SERVER_CAP)
};
export type { Evidence };
