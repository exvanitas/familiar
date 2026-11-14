/* What every check page shares. Pages run checks through the app's real client (src/shell.ts) and
   write `CHECK PASS|FAIL|SKIP <id> <detail>` to the log. When a check needs something no page can
   do, the page writes `STEP <n> <action> <json>`, the driver (driver.ps1) does it and puts its
   answer at driver/<n>.json in the app folder, which the page reads back. A check that didn't run
   says SKIP, never PASS. There is no test code in the exe. */
import { createShell, reason, type Shell } from '../src/shell.ts';

export const shell: Shell = createShell();
export const internals = window.__TAURI_INTERNALS__;

export class Skip extends Error {}
export const skip = (why: string): never => { throw new Skip(why); };
export const fail = (why: string): never => { throw new Error(why); };
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const say = (line: string) => shell.log(line);
export function ok(v: unknown, why: string): void { if (!v) fail(why); }

/* Runs one check and logs its line. `id` carries its namespace: security.<id> or check.<id>. */
export async function check(id: string, f: () => Promise<unknown>): Promise<boolean> {
  try {
    const r = await f();
    await say(`CHECK PASS ${id} ${r ?? ''}`);
    return true;
  } catch (e) {
    await say(`CHECK ${e instanceof Skip ? 'SKIP' : 'FAIL'} ${id} ${e instanceof Error ? e.message : reason(e)}`);
    return false;
  }
}

export async function until<T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) return fail('timed out waiting for ' + what);
    await sleep(50);
  }
}

/* The driver's answer, if it's there yet. */
async function answer(n: number): Promise<Record<string, unknown> | null> {
  const r = await fetch(`driver/${n}.json`, { cache: 'no-store' }).catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

/* Asks the driver, and waits for its answer. Steps are numbered per page, so each page has its own
   range: core counts from 1, other pages from their own base. */
let stepN = 0;
export function stepBase(base: number) { stepN = base; }
export async function step<T = Record<string, unknown>>(action: string, args: object = {}, ms = 60000): Promise<T> {
  const n = ++stepN;
  await say(`STEP ${n} ${action} ${JSON.stringify(args)}`);
  const r = await until(() => answer(n), ms, `driver ${action}`);
  if (typeof r.error === 'string') fail(`driver ${action}: ${r.error}`);
  return r as T;
}

/* A raw call, for checks that must call what the typed client doesn't have. */
export const raw = (cmd: string, args?: object) => internals.invoke(cmd, args);

/* Whether a call was refused by the command gate, and not by the command itself. */
export async function gate(cmd: string, args?: object): Promise<'acl' | 'reached' | string> {
  try {
    await raw(cmd, args);
    return 'reached';
  } catch (e) {
    const why = reason(e);
    if (why === `Command ${cmd} not allowed by ACL`) return 'acl';
    return 'reached';
  }
}

/* Every thrown or rejected thing as a short word or two, for the log. */
export function said(e: unknown): string {
  if (e instanceof DOMException) return e.name;
  if (e instanceof Error) return e.name;
  return typeof e;
}

/* Talking between pages: core asks, a page answers. Same origin, so a BroadcastChannel reaches every
   window of the check app. */
export const bus = new BroadcastChannel('check');

/* Trusted Types and CSP violations this page saw, by directive and source. Never a sample. */
export const violations: string[] = [];
document.addEventListener('securitypolicyviolation', e => {
  violations.push(`${e.effectiveDirective}@${e.sourceFile ? new URL(e.sourceFile, location.href).pathname : '-'}:${e.lineNumber}`);
});

/* A random lower-case name, safe in a DNS label. */
export function rand(n = 12): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => a[b % a.length]).join('');
}

/* What the driver's fixtures listen on, written into the app folder before the exe starts. */
export interface Fixtures {
  run: string;
  tcp: number;
  lan: string;
  udp: Record<string, number>;
  turnTcp: Record<string, number>;
}
export const fixtures = async (): Promise<Fixtures> => {
  const r = await fetch('fixtures.json', { cache: 'no-store' });
  if (!r.ok) fail('no fixtures.json in the app folder');
  return r.json() as Promise<Fixtures>;
};
