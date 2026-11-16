// The process port for core's tests, in Node. It keeps the exe's contract (shell-design.md, 5b) where a
// test can see it: a setup starts only once approved (an `ask` stands in for the dialog, and an
// unchanged setup isn't asked again), one run per setup, a small environment plus the setup's own
// settings and secrets, stdout split into lines, stderr kept apart, and every secret value of the setup
// replaced with [hidden] on both before core sees a line. The exit comes last, once the output drained.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ProcessEvent, ProcessPort, ProcessSetup } from '../../src/mcp/process.ts';

const INHERIT = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

export interface NodeProcessOptions {
  /** The dialog: whether the person approves a new or changed setup. Approves by default. */
  ask?: (setup: ProcessSetup) => boolean | Promise<boolean>;
  /** Credential Manager: a setup's secret values by name. */
  secret?: (setupId: string, name: string) => string | undefined;
}

export interface NodeProcessPort extends ProcessPort {
  /** How many times the dialog was shown. */
  readonly asked: number;
  /** Every line written to each run's stdin, for tests that count what was sent. */
  readonly written: string[];
  /** Ends every run. */
  closeAll(): Promise<void>;
  /** The process ids of the runs still going. */
  pids(): number[];
}

const fail = (kind: string, message: string) => Object.assign(new Error(message), { kind, message });

function canonical(s: ProcessSetup): string {
  return JSON.stringify([s.program, s.args, s.cwd, s.env, [...s.secrets].sort()]);
}

function resolve(program: string): string | undefined {
  if (isAbsolute(program)) return existsSync(program) ? program : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, program);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function nodeProcessPort(options: NodeProcessOptions = {}): NodeProcessPort {
  const approved = new Map<string, string>();
  const runs = new Map<string, { setup: string; child: ChildProcessWithoutNullStreams; done: Promise<void> }>();
  let asked = 0;
  let next = 0;
  const written: string[] = [];

  const port: NodeProcessPort = {
    get asked() { return asked; },
    written,
    async start(setup, onEvent) {
      if ([...runs.values()].some(r => r.setup === setup.id)) throw fail('busy', 'This setup is already running.');
      const program = resolve(setup.program);
      if (!program) throw fail('not-found', 'The program was not found.');
      if (approved.get(setup.id) !== canonical(setup)) {
        asked++;
        if (!(await (options.ask ?? (() => true))(setup))) throw fail('declined', 'Not approved.');
        approved.set(setup.id, canonical(setup));
      }
      const env: Record<string, string> = {};
      for (const k of INHERIT) if (process.env[k] !== undefined) env[k] = process.env[k]!;
      for (const [k, v] of setup.env) env[k] = v;
      const secrets: string[] = [];
      for (const name of setup.secrets) {
        const v = options.secret?.(setup.id, name);
        if (v !== undefined) { env[name] = v; secrets.push(v); }
      }
      const blank = (line: string) => secrets.reduce((l, s) => l.split(s).join('[hidden]'), line);
      const child = spawn(program, [...setup.args], { cwd: setup.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const run = `run-${++next}`;
      let ended = false;
      const send = (e: ProcessEvent) => { if (!ended) onEvent(e); };
      const out = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const err = createInterface({ input: child.stderr, crlfDelay: Infinity });
      out.on('line', line => send({ t: 'out', line: blank(line) }));
      err.on('line', line => send({ t: 'err', line: blank(line).slice(0, 8192) }));
      const closedOut = new Promise<void>(r => out.once('close', () => r()));
      const closedErr = new Promise<void>(r => err.once('close', () => r()));
      const exited = new Promise<number | null>(r => child.once('exit', code => r(code)));
      const spawned = new Promise<void>((r, j) => {
        child.once('spawn', () => r());
        child.once('error', e => j(fail('start-failed', e.message)));
      });
      await spawned;
      const done = (async () => {
        const code = await exited;
        await Promise.race([Promise.all([closedOut, closedErr]), new Promise(r => setTimeout(r, 2000))]);
        runs.delete(run);
        send({ t: 'exit', code });
        ended = true;
      })();
      runs.set(run, { setup: setup.id, child, done });
      return { run };
    },
    async write(run, bytes) {
      const r = runs.get(run);
      if (!r) throw fail('missing', 'No such run.');
      const text = new TextDecoder().decode(bytes);
      written.push(...text.split('\n').filter(Boolean));
      await new Promise<void>((ok, no) => r.child.stdin.write(bytes, e => (e ? no(fail('failed', e.message)) : ok())));
    },
    async stop(run) {
      const r = runs.get(run);
      if (!r) throw fail('missing', 'No such run.');
      r.child.stdin.end();
      const t = setTimeout(() => r.child.kill('SIGKILL'), 500);
      void r.done.then(() => clearTimeout(t));
    },
    async forget(setupId) {
      approved.delete(setupId);
      for (const [run, r] of runs) if (r.setup === setupId) { await port.stop(run); await r.done; }
    },
    async closeAll() {
      for (const [run, r] of [...runs]) { await port.stop(run).catch(() => {}); await r.done; }
    },
    pids: () => [...runs.values()].map(r => r.child.pid ?? 0)
  };
  return port;
}
