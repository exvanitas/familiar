// Each named mutation fails its check, beside its unmutated twin (docs/mcp-design.md 7.2): on one seed and
// schedule, the mutant's check fails, the twin's passes, and the two runs' histories are identical up to the
// first step where the switch changed behaviour. Since the twin's identical prefix passes, the mutant's
// failure lies at or after that step. A mutation with no such seed is a broken control and fails the build.
import { describe, expect, it } from 'vitest';
import { WIRE_CHECKS } from './checks.ts';
import { wireRun, type Driver, type Mode } from './wire.ts';

interface Control {
  readonly mutation: string;
  readonly check: keyof typeof WIRE_CHECKS;
  readonly mode?: Partial<Mode>;
  readonly build?: 'prepass' | 'pass';
  readonly schedule?: (d: Driver) => void;
}

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
  { mutation: 'modern-on-any-error', check: 'H12', mode: { era: 'legacy', initError: 0.6 } },
  { mutation: 'initialized-on-modern', check: 'H12', mode: modern },
  { mutation: 'answer-stray-ping-modern', check: 'H12', mode: modern },
  { mutation: 'retry-after-input-required', check: 'H12', mode: { ...modern, inputRequired: 0.9 } },
  { mutation: 'session-id-on-modern', check: 'H12', mode: modern },
  { mutation: 'pong-in-microtask', check: 'H13', mode: { ...remote, era: 'legacy', pings: 0, pingWithFinal: 1, session404: 'none', redirect: 0 } },
  { mutation: 'cancel-pongs-at-drain', check: 'H13', mode: { ...remote, era: 'legacy', pings: 0, pingWithFinal: 1, session404: 'none', redirect: 0 } },
  { mutation: 'resend-404-call', check: 'H14', mode: { ...remote, era: 'legacy', session404: 'once', redirect: 0 } },
  { mutation: 'rehandshake-every-404', check: 'H14', mode: { ...remote, era: 'legacy', session404: 'again', redirect: 0 } },
  { mutation: 'keep-old-session-id', check: 'H14', mode: { ...remote, era: 'legacy', session404: 'once', redirect: 0 } }
];

const MAX_SEEDS = 150;

describe('every named wire mutation fails its check, beside its unmutated twin', () => {
  for (const c of CONTROLS) {
    it(`${c.mutation} fails ${c.check}`, async () => {
      const tried: string[] = [];
      for (let seed = 1; seed <= MAX_SEEDS; seed++) {
        const options = { ...(c.mode ? { mode: c.mode } : {}), ...(c.build ? { build: c.build } : {}), ...(c.schedule ? { schedule: c.schedule } : {}) };
        const mutant = await wireRun(seed, { ...options, mutation: c.mutation });
        if (mutant.firstHit === undefined) continue;
        const failed = WIRE_CHECKS[c.check]!(mutant);
        if (!failed.length) continue;
        const twin = await wireRun(seed, options);
        const twinFails = WIRE_CHECKS[c.check]!(twin);
        const prefix = mutant.firstHit - 1;
        const same = JSON.stringify(mutant.sched.log.slice(0, prefix)) === JSON.stringify(twin.sched.log.slice(0, prefix));
        tried.push(`seed ${seed}: twin ${twinFails.length ? 'fails' : 'passes'}, prefix ${same ? 'same' : 'differs'}`);
        if (!twinFails.length && same) return;
      }
      expect.fail(`${c.mutation}: no seed where ${c.check} fails only in the mutant (${tried.slice(0, 4).join('; ') || 'the switch never fired or the check never failed'})`);
    }, 120_000);
  }
});
