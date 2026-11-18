// The named schedules (docs/mcp-design.md 7.2) the wire harness runs beside its random seeds. Each is a
// mode for the scripted server and a driver script; S4 to S7 are the journal's, and S9 is T7 (i).

import type { Driver, Mode, WireOptions } from './wire.ts';

const quiet: Partial<Mode> = { where: 'remote', era: 'legacy', pings: 0, pingWithFinal: 0, session404: 'none', redirect: 0, earlyEnd: 0, staleId: 0, listChanged: 0, inputRequired: 0, holdHelpers: 0, pages: 1 };

const callHeaded = (d: Driver, token: string) => d.exe.log.some((x) => x.body?.method === 'tools/call' && x.body.params?.arguments?.text === token && x.head !== undefined);
const lastToken = (d: Driver) => d.exe.log.filter((x) => x.body?.method === 'tools/call').at(-1)?.body?.params?.arguments?.text as string | undefined;

export interface Named {
  readonly name: string;
  readonly options: WireOptions;
  /** What the schedule itself must show, besides the checks passing. */
  readonly expect?: (r: import('./wire.ts').WireRun) => string | undefined;
}

export const SCHEDULES: Named[] = [
  {
    // S1: the card opens with F1; the catalog changes to F2 while it's shown; then the Yes. No handoff.
    name: 'S1 a fingerprint change while a card is shown',
    options: {
      mode: { ...quiet, listChanged: 1 },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          const card = d.card('echo')!;
          d.call('slow');
          const lists = () => d.exe.log.filter((x) => x.body?.method === 'tools/list' && x.final !== undefined).length;
          d.when('relisted', () => d.idle() && lists() >= 2, () => d.yes(card));
        })
    },
    expect: (r) => {
      const card = r.evidence.find((e) => e.what === 'card' && e.tool === 'echo');
      const sent = r.exe.log.some((x) => x.body?.method === 'tools/call' && x.body.params?.arguments?.text === card?.token);
      const out = r.evidence.find((e) => e.what === 'outcome' && e.token === card?.token)?.outcome;
      return !card ? 'no card shown' : sent ? 'the F1 Yes was handed off' : out?.kind !== 'error' || out.reason !== 'changed' ? `the F1 Yes came back ${JSON.stringify(out)}` : undefined;
    }
  },
  {
    // S2: a ping in the same chunk as the final reply: its pong is still handed off.
    name: 'S2 a ping in the same chunk as the final reply',
    options: { mode: { ...quiet, pingWithFinal: 1, oneChunk: true, sse: 1 }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo')) },
    expect: (r) => (r.exe.log.some((x) => x.body?.method === undefined && x.body?.result !== undefined) ? undefined : 'no pong handed off')
  },
  {
    // S3: a 404 mid-call, then a 404 again on the re-handshake's first page: the run ends, nothing more.
    name: 'S3 a 404 mid-call, then a 404 again',
    options: { mode: { ...quiet, session404: 'again' }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo')) },
    expect: (r) => (r.exe.log.filter((x) => x.status === 404).length === 2 ? undefined : 'not two 404s')
  },
  {
    // S8: Stop then Start while the call's POST is still in net_cancel (a held helper).
    name: 'S8 Stop then Start during a held net_cancel',
    options: {
      mode: { ...quiet, hold: true, holdHelpers: 1, holdWhich: 'calls' },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.call('slow');
          const token = lastToken(d)!;
          d.when('headed', () => callHeaded(d, token), () => {
            d.stop();
            d.when('stopped', () => d.client.get('s1')?.phase === 'stopped', () => d.start());
          });
        })
    },
    expect: (r) => (r.evidence.filter((e) => e.what === 'start').length === 2 && r.exe.log.some((x) => x.held && x.cancelAsked !== undefined) ? undefined : 'no Stop and Start over a held cancel')
  },
  {
    // S10: twelve servers each hold a call and a detached helper, then more, then chat fetches a model.
    name: 'S10 server saturation, then a model fetch',
    options: {
      build: 'pass',
      servers: 12,
      mode: { ...quiet, hold: true, holdHelpers: 1, holdWhich: 'calls', sse: 1 },
      schedule: (d) => {
        const ids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
        const round = (k: number): void => {
          if (k === 3) return d.model();
          const before = d.exe.log.filter((x) => x.body?.method === 'tools/call').length;
          for (const id of ids) d.call('slow', {}, false, id);
          d.when(`held:${k}`, () => d.exe.log.filter((x) => x.body?.method === 'tools/call').slice(before).every((x) => x.head !== undefined || x.refused), () => {
            d.stopAll();
            d.when(`detached:${k}`, () => ids.every((id) => d.idle(id)), () => round(k + 1));
          });
        };
        d.when('all ready', () => ids.every((id) => d.idle(id)), () => round(0));
      }
    },
    expect: (r) => (r.evidence.some((e) => e.what === 'model') ? undefined : 'no model fetch made')
  }
];
