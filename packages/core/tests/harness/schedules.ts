// The named schedules (docs/mcp-design.md 7.2) the wire harness runs beside its random seeds. Each is a
// mode for the scripted server and a driver script; S4 to S7 are the journal's, and S9 is T7 (i).

import type { Driver, Mode, WireOptions } from './wire.ts';

const quiet: Partial<Mode> = { where: 'remote', era: 'legacy', pings: 0, pingWithFinal: 0, session404: 'none', redirect: 0, earlyEnd: 0, staleId: 0, listChanged: 0, inputRequired: 0, holdHelpers: 0, refuseCancel: 0, pages: 1 };

const callHeaded = (d: Driver, token: string) => d.exe.log.some((x) => x.body?.method === 'tools/call' && x.body.params?.arguments?.text === token && x.head !== undefined);
const lastToken = (d: Driver) => d.exe.log.filter((x) => x.body?.method === 'tools/call').at(-1)?.body?.params?.arguments?.text as string | undefined;

export interface Named {
  readonly name: string;
  readonly options: WireOptions;
  /** What the schedule itself must show, besides the checks passing. */
  readonly expect?: (r: import('./wire.ts').WireRun) => string | undefined;
}

/** S11: Stop during the walk, or while Ready, then a call; nothing reaches the stopping run after Stop. */
function stopFence(where: 'local' | 'remote', during: 'walk' | 'ready'): Named {
  return {
    name: `S11 Stop ${during === 'walk' ? 'during a walk' : 'while Ready'}, ${where}`,
    options: {
      mode: { ...quiet, where, pages: 3, idlePings: where === 'local' ? 0.9 : 0, sse: 0.5 },
      schedule: (d) => {
        const listing = () => d.exe.log.some((x) => x.body?.method === 'tools/list' && (x.kind === 'write' ? x.end !== undefined : x.head !== undefined));
        d.when(during, during === 'walk' ? listing : () => d.ready(), () => {
          d.stop();
          // A call tried in the same step, before the Stop has finished: refused, nothing sent.
          d.call('echo');
        });
      }
    },
    expect: (r) => (r.evidence.some((e) => e.what === 'stop') ? undefined : 'no Stop made')
  };
}

/** S13, T5's named case: a call's time limit, or its Stop, ends that call only; the run stays Ready and
    the next call goes out on it, with no new handshake. */
function endsThatCallOnly(where: 'local' | 'remote', how: 'stop' | 'time-limit'): Named {
  return {
    name: `S13 a call's ${how === 'stop' ? 'Stop' : 'time limit'} ends that call only, ${where}`,
    options: {
      mode: { ...quiet, where, hold: true, sse: 1 },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.call('slow');
          const token = lastToken(d)!;
          const sent = () => d.exe.log.some((x) => x.body?.params?.arguments?.text === token && (x.kind === 'write' ? x.end !== undefined : x.head !== undefined));
          // A Stop once it's under way; a time limit is the call's own timer, picked when nothing else moves.
          if (how === 'stop') d.when('under way', sent, () => d.stopCall());
          d.when('ended', () => d.evidence.some((e) => e.what === 'outcome' && e.token === token) && d.idle(), () => d.call('echo'));
        })
    },
    expect: (r) => {
      const outs = r.evidence.filter((e) => e.what === 'outcome').map((e) => e.outcome!);
      const first = outs[0];
      const ended = how === 'stop' ? first?.kind === 'stopped' : first?.kind === 'timed-out';
      const handshakes = r.exe.log.filter((x) => x.body?.method === 'initialize').length;
      if (!ended) return `the slow call ended ${JSON.stringify(first)}`;
      if (outs[1]?.kind !== 'result') return `the next call came back ${JSON.stringify(outs[1])}`;
      if (handshakes !== 1) return `${handshakes} handshakes: the run didn't stay`;
      return undefined;
    }
  };
}

/** S14: list_changed on a walk's page (the initial walk, between pages, or a refresh): the catalog that
    walk read isn't published; another walk follows before any call goes out. */
function changeDuringWalk(pages: number, refresh: boolean): Named {
  return {
    name: `S14 list_changed during ${refresh ? 'the initial walk, then a call that brings a refresh' : pages > 1 ? 'the initial walk, between pages' : 'the initial walk'}`,
    options: {
      mode: { ...quiet, pages, changeOnList: true, sse: 1, ...(refresh ? { listChanged: 1 } : {}) },
      schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo'))
    },
    expect: (r) => {
      const recs = r.exe.log.filter((x) => x.kind === 'post');
      const changedAt = recs.filter((x) => x.body?.method === 'tools/list' && x.plan?.messages.some((m) => m.method === 'notifications/tools/list_changed'));
      if (!changedAt.length) return 'no list_changed on a walk';
      for (const c of changedAt) {
        const after = recs.filter((x) => x.seq > c.seq && x.epoch === c.epoch);
        const nextList = after.find((x) => x.body?.method === 'tools/list');
        const firstCall = after.find((x) => x.body?.method === 'tools/call');
        if (firstCall && (!nextList || nextList.seq > firstCall.seq)) return 'a call went out on a catalog a list_changed had made stale';
      }
      return undefined;
    }
  };
}

export const SCHEDULES: Named[] = [
  {
    // S18: a local server that stops reading, with a call written into the full pipe: the page's interim
    // bound stops it within 10 s, its writes end at the exit, and the slot frees.
    name: 'S18 a local server that stops reading',
    options: {
      mode: { ...quiet, where: 'local', stopReading: 1, pages: 2 },
      schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo'))
    },
    expect: (r) => {
      // A write the server never took (the call's, or a page's if it stopped earlier) ended at the stop.
      const blocked = r.exe.log.filter((x) => x.kind === 'write' && x.startAt !== undefined && x.endAt !== undefined && x.endAt - x.startAt >= 9_000);
      if (!blocked.length) return 'no write was held by the server';
      return r.exe.exits.length ? undefined : 'the server was never stopped';
    }
  },
  {
    // S15: a call's 404, then the re-handshake meets a modern-only server: the run ends, still legacy.
    name: 'S15 a modern refusal on a re-handshake',
    options: { mode: { ...quiet, session404: 'once', modernAfterDrop: true }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo')) },
    expect: (r) => (r.exe.log.filter((x) => x.body?.method === 'initialize').length === 2 ? undefined : 'no re-handshake')
  },
  {
    // S16: the first 404 on a refresh page (a list_changed brings the refresh): one fresh initialize, the run kept.
    name: 'S16 a 404 on a refresh page',
    options: { mode: { ...quiet, session404: 'refresh', listChanged: 1 }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo')) },
    expect: (r) => (r.exe.log.some((x) => x.status === 404 && x.body?.method === 'tools/list') ? undefined : 'no 404 on a refresh page')
  },
  {
    // S17: every call 404s, pages never do: the second call's 404 ends the run (one re-handshake per drop,
    // never two in a row).
    name: 'S17 a 404 on every call',
    options: {
      mode: { ...quiet, session404: 'calls' },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.call('echo');
          d.when('recovered', () => d.exe.log.filter((x) => x.body?.method === 'initialize').length === 2 && d.idle(), () => d.call('echo'));
        })
    },
    expect: (r) => (r.exe.log.filter((x) => x.status === 404).length === 2 ? undefined : 'not two 404s')
  },
  changeDuringWalk(1, false),
  changeDuringWalk(3, false),
  changeDuringWalk(1, true),
  {
    // S11 with a live call: Stop right after the call's write, with pings and the reply on their way.
    // Nothing is written to the stopping run, and the call isn't answered by a reply read after Stop.
    name: 'S11 Stop during a live local call',
    options: {
      mode: { ...quiet, where: 'local', pings: 2, pingWithFinal: 1 },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.call('echo');
          const token = lastToken(d)!;
          d.when('written', () => d.exe.log.some((x) => x.body?.params?.arguments?.text === token && x.end !== undefined), () => d.stop());
        })
    },
    expect: (r) => {
      const stop = r.evidence.find((e) => e.what === 'stop');
      const out = r.evidence.find((e) => e.what === 'outcome');
      if (!stop) return 'no Stop made';
      if (out && out.step > stop.step && out.outcome?.kind === 'result') return 'the call was answered by a reply read after Stop';
      return undefined;
    }
  },
  endsThatCallOnly('local', 'stop'),
  endsThatCallOnly('local', 'time-limit'),
  endsThatCallOnly('remote', 'stop'),
  endsThatCallOnly('remote', 'time-limit'),
  {
    // F02: a call tried at every step while a dropped session is recovered: each refused, none sent.
    name: 'S12 calls during a session recovery',
    options: {
      mode: { ...quiet, session404: 'once', sse: 0.5 },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.call('echo');
          let tries = 0;
          d.sched.onStep(() => {
            const dropped = d.exe.log.some((x) => x.status === 404);
            const relisted = d.exe.log.some((x) => x.epoch > 1 && x.body?.method === 'tools/list' && x.final !== undefined);
            if (dropped && !relisted && tries++ < 40) d.sched.add({ label: 'act:call-in-recovery', rank: 0, fire: () => d.call('echo') });
          });
        })
    },
    expect: (r) => (r.evidence.filter((e) => e.what === 'call').length > 2 ? undefined : 'no call tried during the recovery')
  },
  stopFence('local', 'walk'),
  stopFence('local', 'ready'),
  stopFence('remote', 'walk'),
  stopFence('remote', 'ready'),
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
            d.when(`detached:${k}`, () => ids.every(settled), () => round(k + 1));
          });
        };
        // A server whose start timed out (a timer picked early) is left out; the rest saturate.
        const settled = (id: string) => d.idle(id) || d.client.get(id)?.phase === 'failed';
        d.when('all ready', () => ids.every(settled), () => round(0));
      }
    },
    expect: (r) => (r.evidence.some((e) => e.what === 'model') ? undefined : 'no model fetch made')
  }
];
