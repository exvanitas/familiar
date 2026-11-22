// The harness's own reading of a server's catalog, from the fake exe's log alone: shared by the checks
// (checks.ts) and by the driver, which records with each grant the version the person's card showed.

import type { FakeExe, NativeRec } from './wire.ts';

/** The harness's own reading of a server's catalogs: every walk that completed, from its first page to a
    page with no nextCursor, each page answered and reached by the client, in one run (a process, or a
    handshake's epoch), each page the one the page before it pointed to. Its tools are every page's, and it
    counts from the step its last page reached the client. A walk cut off (a page unanswered, failed, or
    not reached) is no catalog, and the next first page begins a new one. */
export function walks(exe: FakeExe, server: string): { at: number; tools: any[] }[] {
  const done: { at: number; tools: any[] }[] = [];
  let open: { epoch: number; next: string; tools: any[]; from: number; noticed: boolean } | undefined;
  // A notice of changed tools that reached the client during a walk invalidates it: the client walks again,
  // and publishes only that retry. Remotely a notice comes on the walk's own pages (one exchange at a time);
  // locally on any line of its process, between its first page's write and its last page's answer.
  const noticedOnPage = (x: NativeRec) => (x.kind === 'post' ? (x.changesDelivered ?? 0) > 0 : !!x.plan?.messages.some((m) => m.method === 'notifications/tools/list_changed'));
  // Ordered by the global sequence, never by step: a notice read in the step a walk starts may be the very
  // notice that started it (before its first write), and doesn't invalidate it.
  const noticedLocally = (epoch: number, from: number, to: number) => exe.noticesDelivered.some((n) => n.epoch === epoch && n.seq > from && n.seq < to);
  for (const x of exe.log) {
    if (x.server !== server || x.body?.method !== 'tools/list') continue;
    const cursor = x.body.params?.cursor;
    const at = x.kind === 'post' ? (x.final === undefined ? undefined : Math.floor(x.final / 1000)) : exe.responded.get(`${x.epoch}:${x.body.id}`);
    const res = x.plan?.messages.find((m) => m.id === x.body!.id && m.result)?.result;
    const continues = cursor === undefined || (open !== undefined && open.epoch === x.epoch && open.next === cursor);
    if (at === undefined || !res || !continues) {
      open = undefined;
      continue;
    }
    const tools = [...(cursor === undefined ? [] : open!.tools), ...((res.tools as any[] | undefined) ?? [])];
    // From the first page's write (its sequence, locally), to its last page's answer.
    const from = cursor === undefined ? (x.kind === 'write' ? x.seq : x.start) : open!.from;
    const noticed = (cursor === undefined ? false : open!.noticed) || noticedOnPage(x);
    if (typeof res.nextCursor === 'string') open = { epoch: x.epoch, next: res.nextCursor, tools, from, noticed };
    else {
      open = undefined;
      if (!noticed && !(x.kind === 'write' && noticedLocally(x.epoch, from, exe.respondedSeq.get(`${x.epoch}:${x.body.id}`) ?? Infinity))) done.push({ at, tools });
    }
  }
  return done;
}

/** A tool's definition in a walk, canonical, so a relist in another key order (S23) is the same tool, as
    the fingerprint has it. */
export const defIn = (w: { tools: any[] }, tool: string): string | undefined => {
  const def = w.tools.find((d: any) => d.name === tool);
  return def === undefined ? undefined : canonical(def);
};

/** The tool's definition in the last completed walk that reached the client before `step` (Infinity: every
    walk that has reached it so far). */
export function catalogAt(exe: FakeExe, server: string, step: number, tool: string): string | undefined {
  let found: { at: number; tools: any[] } | undefined;
  for (const w of walks(exe, server)) if (w.at < step && (!found || w.at >= found.at)) found = w;
  return found && defIn(found, tool);
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

