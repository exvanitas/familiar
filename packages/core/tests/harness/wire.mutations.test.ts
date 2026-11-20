// Each named mutation fails its check, beside its unmutated twin (docs/mcp-design.md 7.2): on one seed and
// schedule, the mutant's check fails, the twin's passes, and the two runs' histories are identical up to the
// first step where the switch changed behaviour. Since the twin's identical prefix passes, the mutant's
// failure lies at or after that step. A mutation with no such seed is a broken control and fails the build.
import { describe, expect, it } from 'vitest';
import { evidenceControls, handoffHistory, PASS_CHECKS } from './checks.ts';
import { SCHEDULES } from './schedules.ts';
import { MIRROR_VECTORS, wireRun, type Driver, type Mode, type WireOptions } from './wire.ts';

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
