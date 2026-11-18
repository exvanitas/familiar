import { it } from 'vitest';
import { SCHEDULES } from './schedules.ts';
import { wireRun } from './wire.ts';
it('one', async () => {
  const s = SCHEDULES.find((x) => x.name.startsWith(process.env.S ?? 'S24'))!;
  const r = await wireRun(1, s.options);
  console.log('EV', JSON.stringify(r.evidence.filter((e) => e.what !== 'card' && e.what !== 'yes').map((e) => [e.step, e.what, e.token, e.outcome && ((e.outcome as any).words ?? e.outcome.kind), e.failure, e.words, e.report])).slice(0, 1500));
  console.log('LOG', r.sched.log.slice(-25).join(' '), r.sched.step);
  for (const x of r.exe.log.slice(-8)) console.log('REC', x.n, x.kind, x.epoch, x.body?.method, 'start', x.start, 'end', x.end, 'refusals', x.refusals);
  console.log('STOPS', JSON.stringify(r.exe.stopsAsked), 'EXITS', JSON.stringify(r.exe.exits));
}, 60000);
