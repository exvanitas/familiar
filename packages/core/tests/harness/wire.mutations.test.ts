// Each named mutation fails its check, beside its unmutated twin (docs/mcp-design.md 7.2): on one seed and
// schedule, the mutant's check fails, the twin's passes, and the two runs' histories are identical up to the
// first step where the switch changed behaviour. Since the twin's identical prefix passes, the mutant's
// failure lies at or after that step. A mutation with no such seed is a broken control and fails the build.
import { describe, expect, it } from 'vitest';
import { evidenceControls, handoffHistory, PASS_CHECKS } from './checks.ts';
import { SCHEDULES } from './schedules.ts';
import { INVALID, MIRROR_VECTORS, rejectedByShape, wireRun, type Driver, type ExchangeRecord, type Mode, type WireOptions, type WireRun } from './wire.ts';

interface Control {
  readonly mutation: string;
  readonly check: keyof typeof PASS_CHECKS;
  readonly mode?: Partial<Mode>;
  readonly build?: 'prepass' | 'pass';
  readonly schedule?: (d: Driver) => void;
  /** A named schedule's options in place of the above. */
  readonly named?: string;
}

const named = (prefix: string): WireOptions => SCHEDULES.find((s) => s.name === prefix || s.name.startsWith(`${prefix} `))!.options;

const remote: Partial<Mode> = { where: 'remote' };
const local: Partial<Mode> = { where: 'local' };
const modern: Partial<Mode> = { era: 'modern', where: 'remote' };

const CONTROLS: Control[] = [
  { mutation: 'free-slot-at-response', check: 'H1', mode: { ...remote, era: 'legacy', pings: 2, session404: 'none', redirect: 0 } },
  { mutation: 'queue-call', check: 'H1' },
  { mutation: 'admit-while-draining', check: 'H1', mode: { ...remote, era: 'legacy', pings: 2, session404: 'none' } },
  { mutation: 'slot-per-run', check: 'H1', mode: { ...remote, era: 'legacy', pings: 2, session404: 'none' } },
  { mutation: 'pong-after-end', check: 'H2', mode: { ...local, era: 'legacy', pings: 2, idlePings: 0.6 } },
  { mutation: 'delete-at-stop', check: 'H2', mode: { ...remote, session404: 'none' } },
  { mutation: 'remote-cancel', check: 'H2', mode: { ...remote, era: 'legacy', session404: 'none' } },
  { mutation: 'local-cancel-after-seal', check: 'H2', mode: { ...local, era: 'legacy' } },
  { mutation: 'ignore-redirected', check: 'H14', mode: { ...remote, era: 'legacy', redirect: 0.6, session404: 'none' } },
  { mutation: 'body-from-model-args', check: 'H3' },
  { mutation: 'await-before-handoff', check: 'H3' },
  { mutation: 'accept-any-response-id', check: 'H10', mode: { staleId: 0.9 } },
  { mutation: 'mirror-previous-call', check: 'H11', mode: modern },
  { mutation: 'mirror-wrong-value', check: 'H11', mode: modern },
  {
    mutation: 'measure-value-only',
    check: 'H11',
    mode: { ...modern, redirect: 0 },
    schedule: (d) => d.when('ready', () => d.idle(), () => d.call('mirror', { region: MIRROR_VECTORS.at(-1) }))
  },
  { mutation: 'modern-on-any-error', check: 'H12', mode: { era: 'legacy', initError: 0.6 } },
  { mutation: 'initialized-on-modern', check: 'H12', mode: modern },
  { mutation: 'answer-stray-ping-modern', check: 'H12', mode: modern },
  { mutation: 'retry-after-input-required', check: 'H12', mode: { ...modern, inputRequired: 0.9 } },
  { mutation: 'session-id-on-modern', check: 'H12', mode: modern },
  { mutation: 'pong-in-microtask', check: 'H13', mode: { ...remote, era: 'legacy', pings: 0, pingWithFinal: 1, session404: 'none', redirect: 0 } },
  { mutation: 'cancel-pongs-at-drain', check: 'H13', mode: { ...remote, era: 'legacy', pings: 0, pingWithFinal: 1, session404: 'none', redirect: 0 } },
  { mutation: 'resend-404-call', check: 'H14', mode: { ...remote, era: 'legacy', session404: 'once', redirect: 0 } },
  { mutation: 'rehandshake-every-404', check: 'H14', mode: { ...remote, era: 'legacy', session404: 'again', redirect: 0 } },
  { mutation: 'keep-old-session-id', check: 'H14', mode: { ...remote, era: 'legacy', session404: 'once', redirect: 0 } },
  { mutation: 'page-before-drain', check: 'H1', mode: { ...remote, era: 'legacy', pages: 3, session404: 'none', redirect: 0 } },
  { mutation: 'write-only-on-response', check: 'H1', mode: { ...local, era: 'legacy', idlePings: 0.9, stopReading: 0 } },
  {
    mutation: 'truncate-header',
    check: 'H11',
    mode: { ...modern, redirect: 0 },
    schedule: (d) => d.when('ready', () => d.idle(), () => d.call('mirror', { region: 'x'.repeat(9000) }))
  },
  // Under the named schedules.
  { mutation: 'slot-per-run', check: 'H1', named: 'S8' },
  { mutation: 'ignore-fingerprint', check: 'H3', named: 'S1' },
  // Locally the notice and the refresh it starts share a step: H3 orders them within it.
  { mutation: 'ignore-fingerprint', check: 'H3', named: 'S1 a fingerprint change while a card is shown, local' },
  // The changed tool on a walk's second page: H3's catalog is every page of a completed walk.
  { mutation: 'ignore-fingerprint', check: 'H3', named: 'S1 a fingerprint change while a card is shown, the tool on a later page' },
  { mutation: 'own-ignores-fingerprint', check: 'H3', named: 'S38' },
  { mutation: 'cancel-pongs-at-drain', check: 'H13', named: 'S2' },
  { mutation: 'rehandshake-every-404', check: 'H14', named: 'S3' },
  { mutation: 'no-detach', check: 'H4', named: 'S8', build: 'pass' },
  { mutation: 'late-detach', check: 'H4', named: 'S8', build: 'pass' },
  { mutation: 'drop-pong-before-flood', check: 'H13', mode: { where: 'remote', era: 'legacy', pings: 40, session404: 'none', redirect: 0, earlyEnd: 0, sse: 1 } },
  { mutation: 'no-server-cap', check: 'H5', named: 'S10' },
  { mutation: 'no-stop-fence', check: 'H2', named: 'S11 Stop during a walk, local' },
  { mutation: 'no-stop-fence', check: 'H2', named: 'S11 Stop while Ready, local' },
  { mutation: 'walk-beside-walk', check: 'H14', named: 'S26' },
  { mutation: 'walk-beside-walk', check: 'H14', named: 'S28' },
  { mutation: 'walk-beside-walk', check: 'H14', named: 'S29' },
  { mutation: 'media-prefix', check: 'H10', named: 'S21' },
  { mutation: 'relaunch-on-answer', check: 'H12', named: 'S22' },
  { mutation: 'forget-exhaustion', check: 'H1', named: 'S24 cleanup refused for good' },
  { mutation: 'no-stuck-wake', check: 'H1', named: 'S24 cleanup refused for good while a start is parked' },
  { mutation: 'ready-after-stop', check: 'H15', named: 'S19' },
  { mutation: 'stop-before-exit', check: 'H2', named: 'S11 Stop during initialize, local' },
  { mutation: 'stop-twice', check: 'H2', named: 'S11 Stop during initialize, local' },
  { mutation: 'stop-skips-pending-start', check: 'H2', named: 'S11 Stop during a pending server_start, local' },
  { mutation: 'stop-before-exit', check: 'H2', named: 'S35' },
  { mutation: 'stop-twice', check: 'H2', named: 'S11 Stop during a pending server_start, local' },
  // One chunk with the cancel refused: the dropped ping shares its step with the flood that ends the
  // exchange, and only the exact terminal position tells them apart.
  { mutation: 'drop-pong-before-flood', check: 'H13', mode: { where: 'remote', era: 'legacy', pings: 40, session404: 'none', redirect: 0, earlyEnd: 0, sse: 1, oneChunk: true, refuseCancel: 1, holdHelpers: 0 } },
  { mutation: 'drop-pong-before-flood', check: 'H13', mode: { where: 'local', era: 'legacy', pings: 40, session404: 'none', redirect: 0, earlyEnd: 0 } },
  { mutation: 'ready-during-recovery', check: 'H14', named: 'S12' },
  { mutation: 'publish-stale-walk', check: 'H3', named: 'S14 list_changed during the initial walk' },
  { mutation: 'era-change-on-recovery', check: 'H12', named: 'S15' },
  { mutation: 'end-on-refresh-404', check: 'H14', named: 'S16' },
  { mutation: 'rearm-in-recovery', check: 'H14', named: 'S17' },
  { mutation: 'no-write-bound', check: 'H1', named: 'S18' },
  { mutation: 'release-on-refused-cancel', check: 'H1', mode: { where: 'remote', era: 'legacy', refuseCancel: 0.8, session404: 'none', redirect: 0, holdHelpers: 0 } },
  { mutation: 'decoder-per-chunk', check: 'H10', mode: { where: 'remote', era: 'legacy', sse: 0, session404: 'none', redirect: 0, earlyEnd: 0 } },
  { mutation: 'ready-before-drain', check: 'H1', named: 'S27 a call the moment Start answers Ready, local' },
  { mutation: 'ready-before-drain', check: 'H1', named: 'S27 a call the moment Start answers Ready, remote' },
  // The driver decides something outside next(): HC sees its state leave the machine's.
  { mutation: 'driver-decides', check: 'HC', mode: { ...remote, era: 'legacy', pings: 2, session404: 'none', redirect: 0 } },
  // HC's independent records: a driver that skips an effect, makes an extra native call, or answers an
  // action without its event.
  { mutation: 'driver-skips-effect', check: 'HC', named: 'S11 Stop during a live local call' },
  { mutation: 'stop-twice', check: 'HC', named: 'S11 Stop during initialize, local' },
  { mutation: 'driver-answers-unasked', check: 'HC', named: 'S11 Stop during a live local call' },
  { mutation: 'cr-forgets-pair', check: 'H10', mode: { where: 'remote', era: 'legacy', sse: 1, session404: 'none', redirect: 0, earlyEnd: 0 } }
];

const MAX_SEEDS = 150;
const controlName = (c: Control) => `${c.mutation} fails ${c.check}${c.named ? ` under ${c.named}` : ''}${c.build === 'pass' ? ' (pass build)' : ''}`;

describe('every named wire mutation fails its check, beside its unmutated twin', () => {
  for (const c of CONTROLS) {
    it(controlName(c), async () => {
      const tried: string[] = [];
      for (let seed = 1; seed <= MAX_SEEDS; seed++) {
        const options: WireOptions = { ...(c.named ? named(c.named) : {}), ...(c.mode ? { mode: c.mode } : {}), ...(c.build ? { build: c.build } : {}), ...(c.schedule ? { schedule: c.schedule } : {}) };
        const mutant = await wireRun(seed, { ...options, mutation: c.mutation });
        if (mutant.firstHit === undefined) continue;
        const failed = PASS_CHECKS[c.check]!(mutant);
        if (!failed.length) continue;
        const twin = await wireRun(seed, options);
        const twinFails = PASS_CHECKS[c.check]!(twin);
        const prefix = mutant.firstHit - 1;
        // The same history up to the first hit: the scheduler's choices, and every native handoff with its
        // bytes, not only the labels.
        const same = JSON.stringify(mutant.sched.log.slice(0, prefix)) === JSON.stringify(twin.sched.log.slice(0, prefix)) && handoffHistory(mutant, prefix) === handoffHistory(twin, prefix);
        tried.push(`seed ${seed}: twin ${twinFails.length ? 'fails' : 'passes'}, prefix ${same ? 'same' : 'differs'}`);
        if (!twinFails.length && same) return;
      }
      expect.fail(`${c.mutation}: no seed where ${c.check} fails only in the mutant (${tried.slice(0, 4).join('; ') || 'the switch never fired or the check never failed'})`);
    }, 120_000);
  }
});

describe("the evidence's own controls", () => {
  it('a refused Start counted as a run (the old evidence) splits the run, and walk-beside-walk escapes H14 under S28', async () => {
    const s28 = SCHEDULES.find((s) => s.name.startsWith('S28'))!.options;
    evidenceControls.countRefusedStarts = true;
    try {
      for (let seed = 1; seed <= 20; seed++) expect(PASS_CHECKS.H14!(await wireRun(seed, { ...s28, mutation: 'walk-beside-walk' })), `seed ${seed}`).toEqual([]);
    } finally {
      evidenceControls.countRefusedStarts = false;
    }
  }, 60_000);

  it('Stop paired with the last process started on any server (the old evidence): a clean run fails H2 under S35', async () => {
    const s35 = SCHEDULES.find((s) => s.name.startsWith('S35'))!.options;
    evidenceControls.globalStarts = true;
    try {
      let flagged = 0;
      for (let seed = 1; seed <= 8; seed++) if (PASS_CHECKS.H2!(await wireRun(seed, s35)).length) flagged++;
      expect(flagged).toBeGreaterThan(0);
    } finally {
      evidenceControls.globalStarts = false;
    }
  }, 60_000);

  it('a Test on another server allowing every run a walk (the old evidence): walk-beside-walk escapes H14 under S29', async () => {
    const s29 = SCHEDULES.find((s) => s.name.startsWith('S29'))!.options;
    evidenceControls.globalTests = true;
    try {
      for (let seed = 1; seed <= 20; seed++) expect(PASS_CHECKS.H14!(await wireRun(seed, { ...s29, mutation: 'walk-beside-walk' })), `seed ${seed}`).toEqual([]);
    } finally {
      evidenceControls.globalTests = false;
    }
  }, 60_000);
});

describe("H2 and the stopped server's own process", () => {
  // S35 calls the other, still-running server after the first one's Stop: its writes are its own process's,
  // so H2 is clean. The same write, taken as one to the stopped server's process, is caught.
  it("the other server's call after a Stop is its own; the same call to the stopped server's process fails H2", async () => {
    const s35 = SCHEDULES.find((s) => s.name.startsWith('S35'))!.options;
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s35);
      expect(PASS_CHECKS.H2!(r), `seed ${seed} clean`).toEqual([]);
      const stop = r.evidence.find((e) => e.what === 'stop')!;
      const fenced = r.exe.processStarts.filter((t) => t.server === stop.server && t.seq < stop.seq).at(-1)!;
      const after = r.exe.log.find((x) => x.kind === 'write' && x.body?.method === 'tools/call' && x.seq > stop.seq)!;
      expect(after.server, `seed ${seed}`).not.toBe(stop.server);
      Object.assign(after, { server: fenced.server, epoch: fenced.epoch });
      expect(PASS_CHECKS.H2!(r), `seed ${seed} forged`).toEqual(expect.arrayContaining([expect.stringMatching(/tools\/call sent to a run after its Stop/)]));
    }
  }, 60_000);
});

describe('Start replies paired by token', () => {
  it('two overlapping Starts, the refused one answered first (S36): clean by token; by order (the old pairing) H14 misreads the 404', async () => {
    const s36 = SCHEDULES.find((s) => s.name.startsWith('S36'))!.options;
    for (let seed = 1; seed <= 4; seed++) expect(PASS_CHECKS.H14!(await wireRun(seed, s36)), `seed ${seed}`).toEqual([]);
    evidenceControls.startsByOrder = true;
    try {
      let flagged = 0;
      for (let seed = 1; seed <= 4; seed++) if (PASS_CHECKS.H14!(await wireRun(seed, s36)).length) flagged++;
      expect(flagged).toBeGreaterThan(0);
    } finally {
      evidenceControls.startsByOrder = false;
    }
  }, 60_000);
});

describe("H13 and the parser's own end", () => {
  // One chunk: a message the parser rejects, then pings, then the final, its cancel refused. The client
  // ended at the rejected message, so the pings after it are departure 2. Each of 3.10's rejections.
  const mode = (invalidFirst: keyof typeof INVALID) => ({ where: 'remote', era: 'legacy', pings: 2, session404: 'none', redirect: 0, earlyEnd: 0, sse: 1, oneChunk: true, refuseCancel: 1, holdHelpers: 0, invalidFirst }) as Partial<Mode>;
  it("the harness's own shape reading rejects each fixture, and none of the messages the server sends otherwise", () => {
    for (const [kind, m] of Object.entries(INVALID)) expect(rejectedByShape(m), kind).toBe(true);
    const valid = [
      { jsonrpc: '2.0', id: 'p1', method: 'ping' },
      { jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} },
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
      { jsonrpc: '2.0', id: 3, result: { content: [] } },
      { jsonrpc: '2.0', id: 3, error: { code: -32022, message: 'no', data: { supported: [] } } }
    ];
    for (const m of valid) expect(rejectedByShape(m), JSON.stringify(m)).toBe(false);
  });
  for (const kind of Object.keys(INVALID) as (keyof typeof INVALID)[])
    it(`pings after the rejected message (${kind}) are excused; taken at the final only (the old reading), H13 blames the client`, async () => {
      let witnessed = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const r = await wireRun(seed, { mode: mode(kind) });
        if (r.exe.log.some((x) => x.refusals && x.delivered.size)) witnessed++;
        expect(PASS_CHECKS.H13!(r), `seed ${seed}`).toEqual([]);
        // The answer holds a message the parser rejects: the client's refusal of it is no valid answer
        // read as invalid (H10), and every other check holds on the clean run too.
        for (const [name, check] of Object.entries(PASS_CHECKS)) if (name !== 'H4' && name !== 'H5') expect(check(r), `seed ${seed} ${name}`).toEqual([]);
      }
      expect(witnessed).toBeGreaterThan(0);
      evidenceControls.finalOnly = true;
      try {
        let flagged = 0;
        for (let seed = 1; seed <= 6; seed++) if (PASS_CHECKS.H13!(await wireRun(seed, { mode: mode(kind) })).length) flagged++;
        expect(flagged).toBeGreaterThan(0);
      } finally {
        evidenceControls.finalOnly = false;
      }
    }, 120_000);
});

describe('H13 on a stream with no final response', () => {
  // One chunk, its cancel refused, and no final response (earlyEnd 1): a dropped pong must still fail H13.
  const mode = { where: 'remote', era: 'legacy', pings: 40, session404: 'none', redirect: 0, earlyEnd: 1, sse: 1, oneChunk: true, refuseCancel: 1, holdHelpers: 0 } as Partial<Mode>;
  for (const sentinel of [false, true])
    it(`drop-pong-before-flood fails H13${sentinel ? ' only without the control (the -1 sentinel taken as an index: H13 misses it)' : ''}`, async () => {
      evidenceControls.finalSentinel = sentinel;
      try {
        let fired = 0;
        let caught = 0;
        for (let seed = 1; seed <= 30; seed++) {
          const r = await wireRun(seed, { mode, mutation: 'drop-pong-before-flood' });
          if (r.firstHit === undefined) continue;
          fired++;
          if (PASS_CHECKS.H13!(r).length) caught++;
        }
        expect(fired).toBeGreaterThan(0);
        if (sentinel) expect(caught).toBe(0);
        else expect(caught).toBe(fired);
      } finally {
        evidenceControls.finalSentinel = false;
      }
    }, 120_000);
});

describe("HC's replay matched to the independent records, effect by effect", () => {
  // Each control is a clean run whose independent record is then changed the way a driver defect would
  // change it: HC must pass the clean run and flag the changed one. Counts alone (the old HC) miss all four.
  const s = (prefix: string) => SCHEDULES.find((x) => x.name.startsWith(prefix))!.options;
  const clean = async (seed: number, options: WireOptions) => {
    const r = await wireRun(seed, options);
    expect(PASS_CHECKS.HC!(r), `seed ${seed} clean`).toEqual([]);
    return r;
  };
  it('a reply under another token: the admitted and refused Starts of S36 swapped', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S36'));
      const started = r.evidence.filter((e) => e.what === 'started');
      const refused = started.find((e) => e.failure === 'refused')!;
      const admitted = started.filter((e) => e.ok).at(-1)!;
      [(refused as { token?: string }).token, (admitted as { token?: string }).token] = [admitted.token, refused.token];
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it('a reply of another outcome: a Start answered ready, recorded as timed out', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const ready = r.evidence.find((e) => e.what === 'started' && e.ok)!;
      Object.assign(ready, { ok: false, failure: 'timed-out', words: "The server didn't finish starting in time." });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it("a missing release: the native start's reservation never released", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const t = r.exe.processStarts[0]!;
      const held = r.reservations.find((x) => x.what === 'start' && x.seq < t.seq && (x.released ?? Infinity) > t.seq)!;
      delete held.released;
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it("a stop sent to the wrong process: S34's Stop of the first run taken by the second run's process", async () => {
    let forged = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S34'));
      const [first, second] = r.exe.processStarts;
      const stop = r.exe.stopsAsked.find((x) => x.epoch === first?.epoch);
      if (!first || !second || !stop) continue;
      Object.assign(stop, { epoch: second.epoch, ...('run' in second ? { run: (second as { run?: string }).run } : {}) });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
      forged++;
    }
    expect(forged).toBeGreaterThan(0);
  }, 60_000);
  it('a reply to no action at all: one under an unknown token appended to S36', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S36'));
      const last = r.evidence.filter((e) => e.what === 'started').at(-1)!;
      r.evidence.push({ ...last, seq: last.seq + 100_000, token: 'start-999' });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).toEqual(expect.arrayContaining([expect.stringMatching(/start-999/)]));
    }
  }, 60_000);
  it("a reservation taken before the person's Start: the native start's reservation moved ahead of it", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const start = r.evidence.find((e) => e.what === 'start')!;
      const t = r.exe.processStarts[0]!;
      const held = r.reservations.find((x) => x.what === 'start' && x.seq < t.seq && (x.released ?? Infinity) > t.seq)!;
      Object.assign(held, { seq: start.seq - 0.5 });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it('a reply under a server and token no action had: one for s9 appended to S36', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S36'));
      const last = r.evidence.filter((e) => e.what === 'started').at(-1)!;
      r.evidence.push({ ...last, seq: last.seq + 100_000, server: 's9', token: 'start-9' });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).toEqual(expect.arrayContaining([expect.stringMatching(/start-9/)]));
    }
  }, 60_000);
  it("an exchange that ended twice on one admission: a call's end record duplicated", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const ex = r.exchanges.get('s1') as ExchangeRecord[];
      const end = ex.find((x) => x.t === 'ended' && x.kind === 'call')!;
      ex.push({ ...end, seq: Math.max(...ex.map((x) => x.seq)) + 1 });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it("an admission duplicated under one end: a call's admit record doubled", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const ex = r.exchanges.get('s1') as ExchangeRecord[];
      const k = ex.findIndex((x) => x.t === 'admit' && x.kind === 'call');
      ex.splice(k + 1, 0, { ...ex[k]!, seq: ex[k]!.seq + 0.5 });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it('an exchange end under a server with no lifecycle record', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const end = r.exchanges.get('s1')!.find((x) => x.t === 'ended')!;
      (r.exchanges as Map<string, ExchangeRecord[]>).set('s9', [{ ...end }]);
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).toEqual(expect.arrayContaining([expect.stringMatching(/s9/)]));
    }
  }, 60_000);
  it("a relaunch's reservation taken after its readmit-check: S40's moved past that transition", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S40'));
      const recs = r.lifecycle.get('s1')!;
      // The transition that requested readmission: the one that put the run in its relaunch step.
      const check = recs.findIndex((x, i) => x.state.run?.step === 'relaunch' && recs[i - 1]?.state.run?.step !== 'relaunch');
      const held = r.reservations.filter((x) => x.what === 'start').at(-1)!;
      expect(held.seq, `seed ${seed}`).toBeLessThan(recs[check]!.seq!);
      // Moved past that transition, still before the readmit event and the relaunch's native start.
      Object.assign(held, { seq: (recs[check]!.seq! + recs[check + 1]!.seq!) / 2 });
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
  it("an exchange's end with no admission: a call's admit record dropped", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await clean(seed, s('S11 Stop during a live local call'));
      const ex = r.exchanges.get('s1') as ExchangeRecord[];
      const k = ex.findIndex((x) => x.t === 'admit' && x.kind === 'call');
      ex.splice(k, 1);
      expect(PASS_CHECKS.HC!(r), `seed ${seed}`).not.toEqual([]);
    }
  }, 60_000);
});

describe("H3 and a walk a notice invalidated", () => {
  // S39: a refresh page carries a notice and describes B; the client discards that walk and its retry
  // publishes A, so the call under A's grant is valid (the reading that counted every walk flagged it). With
  // the retry erased from the record, the noticed walk is still no catalog: the last one is A's, and H3 is
  // clean. Take the page's notice out too, and B is a catalog the client would have published: H3 flags it.
  it('the noticed walk is no catalog; the same walk without its notice is one, and H3 flags the call', async () => {
    const s39 = SCHEDULES.find((s) => s.name.startsWith('S39'))!.options;
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s39);
      expect(PASS_CHECKS.H3!(r), `seed ${seed} clean`).toEqual([]);
      const lists = r.exe.log.filter((x) => x.body?.method === 'tools/list');
      const noticed = lists.findIndex((x) => (x.changesDelivered ?? 0) > 0);
      const retry = lists[noticed + 1]!;
      retry.plan = { ...retry.plan!, messages: [] };
      expect(PASS_CHECKS.H3!(r), `seed ${seed} retry erased`).toEqual([]);
      const page = lists[noticed]!;
      page.plan = { ...page.plan!, messages: page.plan!.messages.filter((m) => m.method !== 'notifications/tools/list_changed') };
      page.changesDelivered = 0;
      expect(PASS_CHECKS.H3!(r), `seed ${seed} notice taken out`).toEqual(expect.arrayContaining([expect.stringMatching(/another version at its handoff/)]));
    }
  }, 60_000);
});

describe("H3 and the version a grant was given for", () => {
  // S38's grant, pressed while A was listed, then a call at A under it. The press carries the version the
  // card showed, as the harness read it: recorded as B (a grant for B pressed while A was listed), the call
  // at A runs a version the grant wasn't for, and H3 flags it; recorded as A, the clean twin passes.
  it('a call at A under a grant for B fails H3; under a grant for A it passes', async () => {
    const s38 = SCHEDULES.find((s) => s.name.startsWith('S38'))!.options;
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s38);
      const grant = r.evidence.find((e) => e.what === 'press')!;
      expect(grant.def, `seed ${seed}`).toMatch(/"description":"Echo\."/);
      expect(PASS_CHECKS.H3!(r), `seed ${seed} clean`).toEqual([]);
      Object.assign(grant, { def: grant.def!.replace('"Echo."', '"Echo, changed."') });
      expect(PASS_CHECKS.H3!(r), `seed ${seed} a grant for B`).toEqual(expect.arrayContaining([expect.stringMatching(/another version/)]));
    }
  }, 60_000);
});

describe("H3 and the person's latest act on a tool", () => {
  // The effective choice at a handoff is the person's latest act before it, by when each was made: a press
  // (once saved), or a take-back. S38's call at A runs under its grant for A.
  const s38 = () => SCHEDULES.find((s) => s.name.startsWith('S38'))!.options;
  const callAtA = (r: WireRun) => r.exe.log.filter((x) => x.body?.method === 'tools/call' && x.body.params?.name === 'echo').at(-1)!;
  it('a later saved grant for B: the call at A under the earlier grant for A fails H3', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s38());
      expect(PASS_CHECKS.H3!(r), `seed ${seed} clean`).toEqual([]);
      const grant = r.evidence.find((e) => e.what === 'grant')!;
      const at = callAtA(r).seq - 0.5;
      const forB = { ...grant, token: 'press-9', def: grant.def!.replace('"Echo."', '"Echo, changed."'), grant: 'fp-B' };
      r.evidence.push({ ...forB, what: 'press', seq: at - 0.25 }, { ...forB, what: 'grant', seq: at });
      r.evidence.sort((a, b) => a.seq - b.seq);
      expect(PASS_CHECKS.H3!(r), `seed ${seed} a later grant for B`).not.toEqual([]);
    }
  }, 60_000);
  it('an earlier take-back, then the grant pressed and saved: the call at A passes H3', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s38());
      const press = r.evidence.find((e) => e.what === 'press')!;
      r.evidence.push({ seq: press.seq - 0.5, step: press.step, what: 'revoke', tool: 'echo', server: 's1' });
      r.evidence.sort((a, b) => a.seq - b.seq);
      expect(PASS_CHECKS.H3!(r), `seed ${seed}`).toEqual([]);
    }
  }, 60_000);
});

describe("H3 and a grant's identity: its destination and setup", () => {
  // S38's grant, press and decision moved to name s2, while the call's handoff went to s1's address: the
  // grant isn't for the server the call reached. Its setup changed alone: the decision isn't the grant's.
  it('evidence naming another server than the handoff, or another setup than the grant, fails H3', async () => {
    const s38 = SCHEDULES.find((s) => s.name.startsWith('S38'))!.options;
    for (let seed = 1; seed <= 4; seed++) {
      const moved = await wireRun(seed, s38);
      expect(PASS_CHECKS.H3!(moved), `seed ${seed} clean`).toEqual([]);
      for (const e of moved.evidence) if (e.what === 'press' || e.what === 'grant' || (e.what === 'yes' && e.grant !== undefined)) Object.assign(e, { server: 's2' });
      expect(PASS_CHECKS.H3!(moved), `seed ${seed} s2`).not.toEqual([]);
      const setup = await wireRun(seed, s38);
      Object.assign(setup.evidence.find((e) => e.what === 'press')!, { setup: 'another-setup' });
      expect(PASS_CHECKS.H3!(setup), `seed ${seed} setup`).not.toEqual([]);
    }
  }, 60_000);
});

describe('H3 and a notice after a list page\'s final response', () => {
  // S38 with an unread notice after each list page's final: the catalogs stand, and the call at A under its
  // grant is valid. The same notice moved ahead of the final on the last refresh's page is read: that walk is
  // no catalog, B stands, and the call at A fails H3.
  it('an unread trailing notice leaves the walk a catalog; moved ahead of its final, it discards it', async () => {
    const o = SCHEDULES.find((s) => s.name.startsWith("S38 a granted tool on a later page changes and changes back, a notice"))!.options;
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, o);
      expect(PASS_CHECKS.H3!(r), `seed ${seed} clean`).toEqual([]);
      const callAtA = r.exe.log.filter((x) => x.body?.method === 'tools/call' && x.body.params?.name === 'echo').at(-1)!;
      const last = r.exe.log.filter((x) => x.body?.method === 'tools/list' && x.final !== undefined && x.seq < callAtA.seq).at(-1)!;
      const msgs = last.plan!.messages;
      last.plan = { ...last.plan!, messages: [msgs.at(-1)!, ...msgs.slice(0, -1)], final: last.plan!.final + 1 };
      expect(PASS_CHECKS.H3!(r), `seed ${seed} read`).not.toEqual([]);
    }
  }, 60_000);
});

describe('H3 and a notice in the step of the walk it starts', () => {
  // S1 locally: an idle notice is read, and the refresh it starts goes out in that same step. The notice came
  // before the walk, so it doesn't invalidate it: B is published, and a Yes for A after it must fail H3 under
  // ignore-fingerprint. Judged on every seed where notice and first page share their step.
  it('ignore-fingerprint fails H3 on each seed whose notice and refresh share a step', async () => {
    const o = SCHEDULES.find((s) => s.name === 'S1 a fingerprint change while a card is shown, local')!.options;
    let same = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = await wireRun(seed, { ...o, mutation: 'ignore-fingerprint' });
      const refresh = r.exe.log.filter((x) => x.body?.method === 'tools/list')[1];
      if (!refresh || !r.exe.noticesDelivered.some((n) => n.step === refresh.start)) continue;
      same++;
      expect(PASS_CHECKS.H3!(r), `seed ${seed}`).not.toEqual([]);
    }
    expect(same).toBeGreaterThan(0);
  }, 60_000);
});

describe("the client's read prefix: through its final response or its parser's rejection", () => {
  const s41 = (prefix: string) => SCHEDULES.find((s) => s.name.startsWith(`S41 ${prefix}`))!.options;
  // A notice after the final, in its chunk, was never read: the next call is no stale-catalog call. The same
  // notice ahead of the final was read, and that call is one.
  it('a notice after the final is unread (H3 clean); moved ahead of the final, H3 flags the next call', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s41('a notice'));
      expect(PASS_CHECKS.H3!(r), `seed ${seed} clean`).toEqual([]);
      const first = r.exe.log.find((x) => x.body?.method === 'tools/call')!;
      const msgs = first.plan!.messages;
      const notice = msgs.findIndex((m) => m.method === 'notifications/tools/list_changed');
      const final = first.plan!.final;
      const moved = [...msgs.slice(0, final), msgs[notice]!, ...msgs.slice(final, notice), ...msgs.slice(notice + 1)];
      first.plan = { ...first.plan!, messages: moved, final: final + 1 };
      expect(PASS_CHECKS.H3!(r), `seed ${seed} forged`).toEqual(expect.arrayContaining([expect.stringMatching(/made stale/)]));
    }
  }, 60_000);
  // A malformed message after the final was never read: the answer was valid, so a "couldn't read" outcome for
  // it is a valid answer read as invalid (H10). Clean, the call comes back as its result.
  it("a malformed message after the final leaves the answer valid: a forged \"couldn't read\" fails H10", async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = await wireRun(seed, s41('a malformed message'));
      expect(PASS_CHECKS.H10!(r), `seed ${seed} clean`).toEqual([]);
      const out = r.evidence.find((e) => e.what === 'outcome')!;
      Object.assign(out, { outcome: { kind: 'error', reason: 'protocol', words: "Familiar couldn't read the server's answer." } });
      expect(PASS_CHECKS.H10!(r), `seed ${seed} forged`).toEqual(expect.arrayContaining([expect.stringMatching(/read as invalid/)]));
    }
  }, 60_000);
});

describe('the twin comparison itself', () => {
  it('counts two histories that differ only in one header as different', async () => {
    const a = await wireRun(3, { mode: { where: 'remote', era: 'legacy', session404: 'none', redirect: 0 } });
    const b = { ...a, exe: { ...a.exe, log: a.exe.log.map((x, i) => (i === 1 ? { ...x, headerPairs: [...x.headerPairs!.filter(([k]) => k.toLowerCase() !== 'mcp-session-id'), ['Mcp-Session-Id', 'other'] as const] } : x)) } } as typeof a;
    expect(handoffHistory(a, a.sched.step)).not.toBe(handoffHistory(b, a.sched.step));
    expect(handoffHistory(a, a.sched.step)).toBe(handoffHistory({ ...a }, a.sched.step));
  });

  it('counts a duplicated header, and a local write missing its newline, as different', async () => {
    const a = await wireRun(3, { mode: { where: 'remote', era: 'legacy', session404: 'none', redirect: 0 } });
    const i = a.exe.log.findIndex((x) => x.kind === 'post');
    const dup = { ...a, exe: { ...a.exe, log: a.exe.log.map((x, k) => (k === i ? { ...x, headerPairs: [...x.headerPairs!, x.headerPairs![0]!] } : x)) } } as typeof a;
    expect(handoffHistory(a, a.sched.step)).not.toBe(handoffHistory(dup, a.sched.step));
    const l = await wireRun(3, { mode: { where: 'local', era: 'legacy' } });
    const w = l.exe.log.findIndex((x) => x.kind === 'write');
    expect(l.exe.log[w]!.raw!.endsWith('\n')).toBe(true);
    const cut = { ...l, exe: { ...l.exe, log: l.exe.log.map((x, k) => (k === w ? { ...x, raw: x.raw!.slice(0, -1) } : x)) } } as typeof l;
    expect(handoffHistory(l, l.sched.step)).not.toBe(handoffHistory(cut, l.sched.step));
  });
});
