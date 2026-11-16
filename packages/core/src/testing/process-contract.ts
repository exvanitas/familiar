// The process port's contract. Every adapter runs these cases against the fake MCP server: the Node
// adapter in core's tests, and the desktop adapter over the exe on the Windows runner. Plain async
// checks, so any runner can drive them. No Node imports: this file is bundled into the check page.

import type { ProcessEvent, ProcessPort, ProcessSetup } from '../mcp/process.ts';

export interface ProcessPortHarness {
  readonly port: ProcessPort;
  /** A setup that starts tools/fake-mcp-server over stdio, already approved or approved when asked.
      Each call gives a new id. */
  setup(extra?: Partial<ProcessSetup>): ProcessSetup;
  /** The value stored for the setup's FAKE_SECRET secret, which the port must blank. */
  readonly secret: string;
  /** How long to wait for an answer or an exit, in ms. */
  readonly waitMs?: number;
}

export interface ProcessContractCase {
  readonly name: string;
  run(h: ProcessPortHarness): Promise<void>;
}

function check(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(why);
}

/** One run, with its events gathered. */
async function started(h: ProcessPortHarness, setup: ProcessSetup) {
  const events: ProcessEvent[] = [];
  const { run } = await h.port.start(setup, e => events.push(e));
  const wait = async (what: string, f: () => boolean) => {
    const end = Date.now() + (h.waitMs ?? 20_000);
    while (!f()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.slice(-5))}`);
      await new Promise(r => setTimeout(r, 20));
    }
  };
  const send = (o: object) => h.port.write(run, new TextEncoder().encode(`${JSON.stringify(o)}\n`));
  const answer = async (id: number) => {
    await wait(`the answer to ${id}`, () => events.some(e => e.t === 'out' && e.line.includes(`"id":${id}`)));
    const e = events.find(x => x.t === 'out' && x.line.includes(`"id":${id}`)) as { line: string };
    return JSON.parse(e.line) as { result?: { content?: { text: string }[] } };
  };
  const initialize = async () => {
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract', version: '1' } } });
    await answer(1);
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };
  const exited = () => wait('the exit', () => events.some(e => e.t === 'exit'));
  return { run, events, send, answer, initialize, exited };
}

export const processPortContract: readonly ProcessContractCase[] = [
  {
    name: 'a run speaks JSON-RPC a line at a time, and its exit comes once, last',
    async run(h) {
      const r = await started(h, h.setup());
      await r.initialize();
      await r.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const listed = await r.answer(2);
      check(JSON.stringify(listed).includes('"echo"'), 'tools/list did not come back as one line');
      await h.port.stop(r.run);
      await r.exited();
      await new Promise(res => setTimeout(res, 100));
      const exits = r.events.filter(e => e.t === 'exit');
      check(exits.length === 1, `${exits.length} exits`);
      check(r.events.at(-1)?.t === 'exit', 'an event came after the exit');
    }
  },
  {
    name: "the setup's secret is blanked on stdout and stderr before the page sees it",
    async run(h) {
      const r = await started(h, h.setup({ secrets: ['FAKE_SECRET'] }));
      await r.initialize();
      await r.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'print_secret', arguments: {} } });
      const reply = JSON.stringify(await r.answer(3));
      await new Promise(res => setTimeout(res, 300));
      const lines = r.events.map(e => ('line' in e ? e.line : ''));
      check(reply.includes('[hidden]'), 'the reply did not carry [hidden]: ' + reply.slice(0, 120));
      check(r.events.some(e => e.t === 'err' && e.line.includes('the secret is [hidden]')), 'stderr did not carry [hidden]');
      check(!lines.some(l => l.includes(h.secret)), 'a line carried the secret');
      await h.port.stop(r.run);
      await r.exited();
    }
  },
  {
    name: 'a crash ends the run with its exit code',
    async run(h) {
      const r = await started(h, h.setup());
      await r.initialize();
      await r.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'crash', arguments: {} } });
      await r.exited();
      const exit = r.events.find(e => e.t === 'exit') as { code: number | null };
      check(exit.code === 3, `exit code ${exit.code}`);
      check(r.events.some(e => e.t === 'err' && e.line.includes('crashing on purpose')), 'its last output was lost');
    }
  },
  {
    name: 'a program that is not there is refused as not-found, and nothing starts',
    async run(h) {
      const outcome = await h.port.start(h.setup({ program: 'familiar-no-such-program', args: [] }), () => {}).then(() => 'started', (e: { kind?: string }) => e?.kind ?? 'no kind');
      check(outcome === 'not-found', outcome);
    }
  },
  {
    name: 'a write to a run that ended is refused',
    async run(h) {
      const r = await started(h, h.setup());
      await h.port.stop(r.run);
      await r.exited();
      const outcome = await r.send({ jsonrpc: '2.0', id: 5, method: 'ping' }).then(() => 'written', () => 'refused');
      check(outcome === 'refused', outcome);
    }
  }
];
