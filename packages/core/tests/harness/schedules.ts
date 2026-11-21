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
/** S11 during the handshake: a local Stop while initialize, or initialized, is in flight. */
function stopInHandshake(step: 'initialize' | 'notifications/initialized'): Named {
  return {
    name: `S11 Stop during ${step}, local`,
    options: {
      mode: { ...quiet, where: 'local' },
      schedule: (d) => d.when('handshaking', () => d.exe.log.some((x) => x.body?.method === step), () => d.stop())
    },
    expect: (r) => (r.evidence.some((e) => e.what === 'stop') ? undefined : 'no Stop made')
  };
}

/** S11 during a pending native start: Stop while the exe hasn't yet answered server_start. It waits that
    start out, and answers only after the process it started has exited, with one native stop (H2). */
const stopInStart: Named = {
  name: 'S11 Stop during a pending server_start, local',
  options: {
    mode: { ...quiet, where: 'local' },
    schedule: (d) => {
      d.exe.holdNextStart = true;
      d.when('starting', () => !!d.exe.releaseStart, () => {
        d.stop();
        d.sched.add({ label: 'act:release-start', fire: () => d.exe.releaseStart?.() });
      });
    }
  },
  expect: (r) => {
    const stop = r.evidence.find((e) => e.what === 'stop');
    const start = r.exe.processStarts[0];
    if (!stop || !start) return 'no Stop made';
    return start.answered !== undefined && start.answered > stop.step ? undefined : 'the Stop came after server_start answered';
  }
};

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

/** S27: a call made the moment Start answers Ready, while the start's last exchange would still be
    draining (locally, the exe acknowledging writes late; remotely, the list's net_cancel still pending):
    it's admitted and answered, never refused busy (H1). */
function callAtReady(where: 'local' | 'remote'): Named {
  return {
    name: `S27 a call the moment Start answers Ready, ${where}`,
    options: {
      mode: { ...quiet, where, ...(where === 'local' ? { lateAcks: true } : {}) },
      schedule: (d) =>
        d.when('stopped', () => d.evidence.some((e) => e.what === 'started'), () => {
          d.stop();
          d.when('stopped again', () => d.client.get('s1')?.phase === 'stopped', () => d.start('s1', (ready) => ready && d.call('echo')));
        })
    },
    expect: (r) => {
      const call = r.evidence.find((e) => e.what === 'call');
      const out = r.evidence.find((e) => e.what === 'outcome' && e.token === call?.token)?.outcome;
      return !call ? 'no call made at Ready' : out?.kind === 'result' ? undefined : `the call made at Ready came back ${JSON.stringify(out)}`;
    }
  };
}

const mayRun = /may still be running/;

/** The lifecycle machine's own cases (S31 to S35), each a sequence the old lifecycle code got wrong. */
const LIFECYCLE: Named[] = [
  {
    // S31: Stop while server_start is pending, then the exe refuses the stop and the process never exits:
    // Stop answers that it may still be running, and the owner is free (a Start is fenced, not "busy").
    name: 'S31 a refused Stop during a pending server_start',
    options: {
      mode: { ...quiet, where: 'local', refuseStop: true },
      schedule: (d) => {
        d.exe.holdNextStart = true;
        d.when('starting', () => !!d.exe.releaseStart, () => {
          d.stop();
          d.sched.add({ label: 'act:release-start', fire: () => d.exe.releaseStart?.() });
          d.when('stop answered', () => d.evidence.some((e) => e.what === 'stopped'), () => d.start());
        });
      }
    },
    expect: (r) => {
      const stopped = r.evidence.find((e) => e.what === 'stopped');
      const again = r.evidence.filter((e) => e.what === 'started').at(-1);
      if (!stopped || !mayRun.test(stopped.words ?? '')) return `the Stop answered ${stopped ? stopped.words ?? 'stopped' : 'nothing'}`;
      if (!again || !mayRun.test(again.words ?? '')) return `the next Start answered ${again ? (again.words ?? 'ready').slice(0, 60) : 'nothing'}`;
      return undefined;
    }
  },
  {
    // S32: two Stops of a Ready local run whose stop the exe refuses: both say it may still be running.
    name: 'S32 Stop twice, the stop refused',
    options: {
      mode: { ...quiet, where: 'local', refuseStop: true },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.stop();
          d.when('stop answered', () => d.evidence.some((e) => e.what === 'stopped'), () => d.stop());
        })
    },
    expect: (r) => {
      const answers = r.evidence.filter((e) => e.what === 'stopped');
      if (answers.length < 2) return `${answers.length} Stops answered`;
      return answers.every((e) => mayRun.test(e.words ?? '')) ? undefined : `a Stop answered ${answers.find((e) => !mayRun.test(e.words ?? ''))?.words ?? 'stopped'}`;
    }
  },
  {
    // S33: Test after a Stop the exe refused: the process may still run, so Test reports no success.
    name: 'S33 Test after a refused Stop',
    options: {
      mode: { ...quiet, where: 'local', refuseStop: true },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.stop();
          d.when('stop answered', () => d.evidence.some((e) => e.what === 'stopped'), () => d.test());
        })
    },
    expect: (r) => {
      const tested = r.evidence.find((e) => e.what === 'tested');
      return !tested ? 'Test never answered' : tested.report?.ok ? 'Test reported success beside a process that may still run' : undefined;
    }
  },
  {
    // S34: a notice of changed tools during Start's final drain: Start walks again before Ready, and a call
    // made the moment it answers goes out.
    name: 'S34 a notice during the final drain',
    options: {
      mode: { ...quiet, where: 'local', lateAcks: true, noticeAtDrain: true },
      schedule: (d) =>
        d.when('first answer', () => d.evidence.some((e) => e.what === 'started'), () => {
          d.stop();
          d.when('stopped', () => d.client.get('s1')?.phase === 'stopped', () => d.start('s1', (ready) => ready && d.call('echo')));
        })
    },
    expect: (r) => {
      const call = r.evidence.find((e) => e.what === 'call');
      const out = r.evidence.find((e) => e.what === 'outcome' && e.token === call?.token)?.outcome;
      const lists = r.exe.log.filter((x) => x.body?.method === 'tools/list').length;
      if (lists < 3) return `${lists} lists: no walk again after the notice`;
      return !call ? 'no call made at Ready' : out?.kind === 'result' ? undefined : `the call made at Ready came back ${JSON.stringify(out)}`;
    }
  },
  {
    // S35: two local servers, the first stopped after the second launched: H2 judges the Stop against the
    // first server's own process.
    name: 'S35 two local servers, the first stopped',
    options: {
      servers: 2,
      mode: { ...quiet, where: 'local' },
      schedule: (d) => {
        // Whichever server came up first, the other is started once the owner is free (its own start at
        // launch may have met the first's); then the first is stopped, the second still running.
        let first: string | undefined;
        d.when('one ready', () => d.idle('s1') || d.idle('s2'), () => {
          first = d.idle('s1') ? 's1' : 's2';
          const other = first === 's1' ? 's2' : 's1';
          const startOther = (n: number): void =>
            d.when(`${other} start ${n}`, () => !d.client.owner.busy && !['starting', 'ready'].includes(d.client.get(other)?.phase ?? ''), () => {
              d.start(other);
              if (n < 3) startOther(n + 1);
            });
          startOther(1);
          d.when('both ready', () => d.idle('s1') && d.idle('s2'), () => {
            d.stop(first);
            // The other server, still running, called once the Stop has answered: its writes go to its own
            // process, never the stopped one's (H2 picks the stopped server's process by its setup).
            d.when('stop answered', () => d.evidence.some((e) => e.what === 'stopped'), () => d.call('echo', {}, false, other));
          });
        });
      }
    },
    expect: (r) => {
      const stopped = r.evidence.find((e) => e.what === 'stopped');
      const other = stopped?.server === 's1' ? 's2' : 's1';
      if (!stopped || !r.exe.processStarts.some((t) => t.server === other)) return 'no Stop of one server beside the other started';
      const call = r.evidence.find((e) => e.what === 'call' && e.server === other && e.seq > stopped.seq);
      const out = r.evidence.find((e) => e.what === 'outcome' && e.token === call?.token)?.outcome;
      return out?.kind === 'result' ? undefined : `the other server's call after the Stop came back ${JSON.stringify(out)}`;
    }
  },
  {
    // S36: two Starts in one step after a Stop, the second refused and answered first, then a 404 while
    // Ready: H14 pairs each reply with its own Start, by token, and the recovery is judged on a Ready run.
    name: 'S36 two overlapping Starts, then a 404 while Ready',
    options: {
      mode: { ...quiet, session404: 'once' },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.stop();
          d.when('stopped', () => d.client.get('s1')?.phase === 'stopped', () => {
            d.start();
            d.start();
            d.when('ready again', () => d.client.get('s1')?.phase === 'ready' && d.idle(), () => d.call('echo'));
          });
        })
    },
    expect: (r) => {
      const refused = r.evidence.filter((e) => e.what === 'started' && e.failure === 'refused').length;
      if (!refused) return 'no refused Start';
      return r.exe.log.some((x) => x.status === 404) ? undefined : 'no 404';
    }
  }
];

export const SCHEDULES: Named[] = [
  ...LIFECYCLE,
  {
    // S28: S26 with a Start made while Ready, which the client refuses: it begins no run, so the run's
    // walks are still judged together (H14), and its era too (H12).
    name: 'S28 a refused Start splits no run',
    options: {
      mode: { ...quiet, changeOnList: true, changeOnListAt: 2, listChanged: 1 },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.start();
          d.call('echo');
        })
    },
    expect: (r) => {
      const refused = r.evidence.filter((e) => e.what === 'start' && !e.admitted).length;
      if (!refused) return 'no refused Start';
      return r.exe.log.filter((x) => x.body?.method === 'tools/list').length >= 3 ? undefined : 'no refresh carrying list_changed';
    }
  },
  {
    // S29: S26 on s1 while s2 is Tested: a Test on another server allows s1's run no extra walk (H14).
    name: 'S29 a walk beside a walk, with a Test elsewhere',
    options: {
      servers: 2,
      mode: { ...quiet, changeOnList: true, changeOnListAt: 2, listChanged: 1 },
      schedule: (d) =>
        d.when('ready', () => d.idle('s1') && d.ready('s2'), () => {
          d.stop('s2');
          d.when('s2 stopped', () => d.client.get('s2')?.phase === 'stopped', () => {
            d.test('s2');
            d.call('echo');
          });
        })
    },
    expect: (r) => (r.evidence.some((e) => e.what === 'tested' && e.server === 's2') ? undefined : 'no Test of s2')
  },
  {
    // S30: a local call whose answer carries list_changed, with an idle ping right behind it: the refresh
    // waits for the ping's pong and runs, and the next calls go out on a fresh catalog (H1, H3).
    name: 'S30 an idle ping right after a list_changed',
    options: {
      mode: { ...quiet, where: 'local', listChanged: 1, lateAcks: true, pingAtDrain: true },
      schedule: (d) => {
        let made = 0;
        const next = () => {
          if (made++ >= 4) return;
          d.call('echo');
          const token = lastToken(d);
          const call = () => d.exe.log.findIndex((x) => x.body?.method === 'tools/call' && x.body.params?.arguments?.text === token);
          // The refresh the call's list_changed asked for has come back: a tools/list written after the call,
          // answered. Then the next call, on the fresh catalog.
          // (A call refused busy, its slot taken by a pong, sent nothing: the person tries again.)
          const relisted = () => call() < 0 || d.exe.log.some((x, i) => i > call() && x.body?.method === 'tools/list' && d.exe.responded.has(`${x.epoch}:${x.body.id}`));
          d.when(`relisted ${made}`, () => d.evidence.some((e) => e.what === 'outcome' && e.token === token) && relisted() && d.idle(), next);
        };
        d.when('ready', () => d.idle(), next);
      }
    },
    expect: (r) => {
      const outs = r.evidence.filter((e) => e.what === 'outcome');
      if (outs.length < 4) return `only ${outs.length} calls answered: a refresh never came back`;
      // Busy is a pong in the slot, tried again; a call refused on a stale catalog is the dropped refresh.
      const stale = outs.find((e) => e.outcome?.kind === 'error' && e.outcome.reason === 'changed');
      if (stale) return `a call came back ${JSON.stringify(stale.outcome).slice(0, 80)}`;
      return outs.some((e) => e.outcome?.kind === 'result') ? undefined : 'no call answered with a result';
    }
  },
  callAtReady('local'),
  callAtReady('remote'),
  {
    // S26: a refresh whose own page carries list_changed: the walk tries again, and that's the only extra
    // walk (H14's walk count).
    name: 'S26 list_changed on a refresh page',
    options: { mode: { ...quiet, changeOnList: true, changeOnListAt: 2, listChanged: 1 }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo')) },
    expect: (r) => (r.exe.log.filter((x) => x.body?.method === 'tools/list').length >= 3 ? undefined : 'no refresh carrying list_changed')
  },
  {
    // S19: Test, with its catalog write held; then Stop; then the write lands, and Start B is admitted in the
    // same step as the owner's release, before Test's own continuation runs. Test acts on its own run only,
    // and B's run is left alone (H15).
    name: 'S19 Stop and Start during Test',
    options: {
      mode: { ...quiet, where: 'local' },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.stop();
          d.when('stopped', () => d.client.get('s1')?.phase === 'stopped', () => {
            // The server's tools changed meanwhile, so Test's listing makes a catalog write, which is held.
            d.server.variant = d.server.variant === 'a' ? 'b' : 'a';
            d.holdNextWrite();
            d.test();
            d.when('testing', () => !!d.store.release, () => {
              d.stop();
              d.when('stopped again', () => d.client.get('s1')?.phase !== 'stopping', () => {
                d.whenOwnerFree(() => d.start());
                d.releaseWrite();
              });
            });
          });
        })
    },
    expect: (r) => {
      const b = r.evidence.filter((e) => e.what === 'start')[1];
      const started = b && r.evidence.find((e) => e.what === 'started' && e.seq > b.seq);
      if (!r.evidence.some((e) => e.what === 'tested')) return 'Test never answered';
      if (!b) return 'Start B was never made';
      return started?.ok ? undefined : `Start B, made as the owner released, answered ${started ? started.failure : 'nothing'}: ${(started?.words ?? '').slice(0, 60)}`;
    }
  },
  {
    // S20: the walk a list_changed restarts meets a 404 on its first page: nothing goes without the session
    // id before the recovery's initialize, and no extra walk runs beside it (H14).
    name: 'S20 a 404 on the retry of a walk',
    options: { mode: { ...quiet, changeOnList: true, changeOnListAt: 2, session404: 'retry', listChanged: 1 }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('echo')) },
    expect: (r) => (r.exe.log.some((x) => x.status === 404 && x.body?.method === 'tools/list') ? undefined : 'no 404 on a retried walk')
  },
  {
    // S21: answers of other media types, lookalike and oversized: never read, and no header text in words (H10).
    name: 'S21 answers of other media types',
    options: { mode: { ...quiet, oddMedia: 0.8 } },
    expect: (r) => (r.exe.log.some((x) => x.contentType && x.contentType !== 'application/json' && x.contentType !== 'text/event-stream') ? undefined : 'no odd media type sent')
  },
  {
    // S22: a local modern-only server answers its list -32022, then exits: a definitive refusal, no relaunch (H12).
    name: 'S22 a modern list refused, then an exit',
    options: { mode: { ...quiet, where: 'local', era: 'modern', modernListExit: true }, schedule: () => {} },
    expect: (r) => (r.exe.exits.length ? undefined : 'the server never exited')
  },
  {
    // S23: a modern server that relists its tools with their properties in another order: a saved "may run on its own"
    // made on the first listing still holds after a Stop and Start (H3: nothing lost to key order).
    name: 'S23 a relist in another property order',
    options: {
      mode: { ...quiet, reorder: true, era: 'modern' },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          void d.grantOwn('mirror2')?.then(() => {
            d.stop();
            d.when('stopped', () => d.client.get('s1')?.phase === 'stopped', () => {
              d.start();
              d.when('ready again', () => d.idle() && d.evidence.some((e) => e.what === 'started' && e.ok && e.seq > [...d.evidence].reverse().find((x) => x.what === 'start')!.seq), () => d.own('mirror2', { count: 7, flag: true }));
            });
          });
        })
    },
    expect: (r) => {
      const out = r.evidence.find((e) => e.what === 'outcome' && e.tool === 'mirror2')?.outcome;
      return out?.kind === 'result' ? undefined : `the call on its own after a reordered relist came back ${JSON.stringify(out)}`;
    }
  },
  {
    // S24: the exe refuses every net_cancel: the run ends, the slot stays held, and Stop and Start say why (H1).
    name: 'S24 cleanup refused for good',
    options: {
      mode: { ...quiet, refuseCancelAlways: true },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          d.call('echo');
          d.when('failed', () => d.client.get('s1')?.phase === 'failed', () => {
            d.stop();
            d.start();
          });
        })
    },
    expect: (r) => (r.evidence.filter((e) => e.what === 'start').length >= 2 ? undefined : 'no Start after the cleanup failed')
  },
  {
    // S24 in the handshake: every net_cancel of initialize refused, so the start waits between initialize
    // and initialized for a drain that never comes. Exhaustion wakes it: Start answers the restart words
    // well before its deadline, and nothing more is sent (H1).
    name: 'S24 cleanup refused for good while a start is parked',
    options: { mode: { ...quiet, refuseCancelAlways: true, refuseCancelOf: 'initialize' }, schedule: () => {} },
    expect: (r) => {
      const init = r.exe.log.find((x) => x.body?.method === 'initialize');
      const start = r.evidence.find((e) => e.what === 'start');
      const started = r.evidence.find((e) => e.what === 'started');
      if ((init?.refusals ?? 0) < 4) return 'the handshake\'s cleanup was never refused for good';
      if (!started) return 'the parked Start never answered';
      // When, too: woken by the exhaustion, not by the start's own deadline (60 s here).
      if (start?.at !== undefined && started.at !== undefined && started.at - start.at >= 30_000) return `the parked Start answered only after ${started.at - start.at} ms`;
      if (!/[Rr]estart/.test(started.words ?? '')) return `the parked Start answered "${(started.words ?? 'ready').slice(0, 60)}"`;
      if (r.exe.log.some((x) => x.body?.method === 'notifications/initialized')) return 'initialized went out over the held slot';
      return undefined;
    }
  },
  {
    // S25: a modern tool whose only $ref is in its default and examples data stays offered, and is called (H11).
    name: 'S25 a $ref in schema data',
    options: { mode: { ...quiet, era: 'modern' }, schedule: (d) => d.when('ready', () => d.idle(), () => d.call('mirror3', { region: 'eu-2' })) },
    expect: (r) => (r.evidence.some((e) => (e.what === 'call' || e.what === 'not-offered') && e.tool === 'mirror3') ? undefined : 'mirror3 never tried')
  },
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
  stopInStart,
  stopInHandshake('initialize'),
  stopInHandshake('notifications/initialized'),
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
    // S1 with the changed tool on the walk's second page: the catalog H3 reads is every page of a walk.
    name: 'S1 a fingerprint change while a card is shown, the tool on a later page',
    options: {
      mode: { ...quiet, listChanged: 1, pages: 2, echoLast: true },
      schedule: (d) =>
        d.when('ready', () => d.idle(), () => {
          const card = d.card('echo')!;
          d.call('slow');
          const lists = () => d.exe.log.filter((x) => x.body?.method === 'tools/list' && x.body.params?.cursor === undefined && x.final !== undefined).length;
          d.when('relisted', () => d.idle() && lists() >= 2, () => d.yes(card));
        })
    },
    expect: (r) => {
      const card = r.evidence.find((e) => e.what === 'card' && e.tool === 'echo');
      const out = r.evidence.find((e) => e.what === 'outcome' && e.token === card?.token)?.outcome;
      return !card ? 'no card shown' : out?.kind !== 'error' || out.reason !== 'changed' ? `the F1 Yes came back ${JSON.stringify(out)}` : undefined;
    }
  },
  {
    // S38: "may run on its own" for a tool on the walk's second page, which then changes and changes back
    // (A, B, A): the grant no longer stands, so the call under it is refused (H3 reads every page of a walk).
    name: 'S38 a granted tool on a later page changes and changes back',
    options: {
      mode: { ...quiet, listChanged: 1, pages: 2, echoLast: true },
      schedule: (d) => {
        const walks = () => d.exe.log.filter((x) => x.body?.method === 'tools/list' && x.body.params?.cursor !== undefined && x.final !== undefined).length;
        d.when('ready', () => d.idle(), () => {
          void d.grantOwn('echo')?.then(() => {
            d.call('slow');
            d.when('B listed', () => d.idle() && walks() >= 2, () => {
              d.call('slow');
              d.when('A again', () => d.idle() && walks() >= 3, () => d.own('echo'));
            });
          });
        });
      }
    },
    expect: (r) => {
      if (!r.evidence.some((e) => e.what === 'grant')) return 'no grant saved';
      const own = r.evidence.filter((e) => e.what === 'yes' && e.grant !== undefined).at(-1);
      const out = r.evidence.find((e) => e.what === 'outcome' && e.token === own?.token)?.outcome;
      return !own ? 'no call under the grant' : out?.kind === 'error' ? undefined : `the call under a grant for A, after B, came back ${JSON.stringify(out)}`;
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
    // S10: 4 server helpers detached and hung, then every one of 24 servers holds a call, then chat fetches
    // a model with 24 server requests open. The server cap keeps the servers to 24 of the 32, detached
    // helpers included (and at 8 detached helpers the exe admits no more server requests at all).
    name: 'S10 server saturation, then a model fetch',
    options: {
      build: 'pass',
      servers: 24,
      mode: { ...quiet, hold: true, holdHelpers: 1, holdWhich: 'calls', sse: 1 },
      schedule: (d) => {
        const ids = Array.from({ length: 24 }, (_, i) => `s${i + 1}`);
        // A server whose start timed out (a timer picked early) is left out; the rest saturate.
        const settled = (id: string) => d.idle(id) || d.client.get(id)?.phase === 'failed';
        const headed = (from: number) => d.exe.log.filter((x) => x.body?.method === 'tools/call').slice(from).every((x) => x.head !== undefined || x.refused);
        d.when('all ready', () => ids.every(settled), () => {
          // Round one: 4 calls, stopped: their helpers are held and detached.
          const before = d.exe.log.filter((x) => x.body?.method === 'tools/call').length;
          for (const id of ids.slice(0, 4)) d.call('slow', {}, false, id);
          d.when('held', () => headed(before), () => {
            d.stopAll();
            d.when('detached', () => ids.slice(0, 4).every(settled), () => {
              // Round two: every server holds a call.
              const from = d.exe.log.filter((x) => x.body?.method === 'tools/call').length;
              for (const id of ids) d.call('slow', {}, false, id);
              d.when('saturated', () => headed(from), () => d.model());
            });
          });
        });
      }
    },
    expect: (r) => (r.evidence.some((e) => e.what === 'model') ? undefined : 'no model fetch made')
  }
];
