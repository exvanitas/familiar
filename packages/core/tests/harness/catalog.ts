// The harness's own reading of a server's catalog, from the fake exe's log alone: shared by the checks
// (checks.ts) and by the driver, which records with each grant the version the person's card showed.

import { createHash } from 'node:crypto';
import { readPrefix } from './shape.ts';
import type { FakeExe, NativeRec } from './wire.ts';

/** The harness's own reading of a server's catalogs: every walk that completed, from its first page to a
    page with no nextCursor, each page answered and reached by the client, in one run (a process, or a
    handshake's epoch), each page the one the page before it pointed to. Its tools are every page's, and it
    counts from the step its last page reached the client. A walk cut off (a page unanswered, failed, or
    not reached) is no catalog, and the next first page begins a new one. */
export function walks(exe: FakeExe, server: string): { at: number; atSeq: number; fromSeq: number; epoch: number; tools: any[]; modern: boolean }[] {
  const done: { at: number; atSeq: number; fromSeq: number; epoch: number; tools: any[]; modern: boolean }[] = [];
  // A modern remote run, by the server's own record: its opening initialize, in that handshake epoch, was
  // refused -32022 (never by the client's own framing).
  // Read from that initialize's own accepted response: the first message the parser read with its id.
  const modernRun = (x: NativeRec) =>
    x.kind === 'post' &&
    exe.log.some((y) => {
      if (y.kind !== 'post' || y.server !== x.server || y.epoch !== x.epoch || y.body?.method !== 'initialize' || !y.plan) return false;
      const answer = readPrefix(y.plan).find((m) => m.id === y.body!.id && ('result' in m || 'error' in m));
      return answer?.error?.code === -32022;
    });
  let open: { epoch: number; next: string; tools: any[]; from: number; fromSeq: number; noticed: boolean } | undefined;
  // A notice of changed tools that reached the client during a walk invalidates it: the client walks again,
  // and publishes only that retry. Remotely a notice comes on the walk's own pages (one exchange at a time);
  // locally on any line of its process, between its first page's write and its last page's answer.
  // A notice on a page counts only if the client's parser read it: in the delivered prefix through the page's
  // final response or its first rejected message, never one in the stream's bytes after (r38).
  const noticedOnPage = (x: NativeRec) => !!x.plan && (x.kind !== 'post' || (x.changesDelivered ?? 0) > 0) && readPrefix(x.plan).some((m) => m.method === 'notifications/tools/list_changed');
  // Ordered by the global sequence, never by step: a notice read in the step a walk starts may be the very
  // notice that started it (before its first write), and doesn't invalidate it.
  const noticedLocally = (epoch: number, from: number, to: number) => exe.noticesDelivered.some((n) => n.epoch === epoch && n.seq > from && n.seq < to);
  for (const x of exe.log) {
    if (x.server !== server || x.body?.method !== 'tools/list') continue;
    const cursor = x.body.params?.cursor;
    const at = x.kind === 'post' ? (x.final === undefined ? undefined : Math.floor(x.final / 1000)) : exe.responded.get(`${x.epoch}:${x.body.id}`);
    // The page's own response as the parser accepted it: within the prefix it read, through the final or the
    // first message it rejects. Its completion and its cursor are read from that response alone.
    const res = x.plan ? readPrefix(x.plan).find((m) => m.id === x.body!.id && m.result)?.result : undefined;
    const continues = cursor === undefined || (open !== undefined && open.epoch === x.epoch && open.next === cursor);
    if (at === undefined || !res || !continues) {
      open = undefined;
      continue;
    }
    const tools = [...(cursor === undefined ? [] : open!.tools), ...((res.tools as any[] | undefined) ?? [])];
    // From the first page's write (its sequence, locally), to its last page's answer.
    const from = cursor === undefined ? (x.kind === 'write' ? x.seq : x.start) : open!.from;
    const noticed = (cursor === undefined ? false : open!.noticed) || noticedOnPage(x);
    const fromSeq = cursor === undefined ? x.seq : open!.fromSeq;
    if (typeof res.nextCursor === 'string') open = { epoch: x.epoch, next: res.nextCursor, tools, from, fromSeq, noticed };
    else {
      open = undefined;
      if (!noticed && !(x.kind === 'write' && noticedLocally(x.epoch, from, exe.respondedSeq.get(`${x.epoch}:${x.body.id}`) ?? Infinity))) done.push({ at, atSeq: (x.kind === 'post' ? x.finalSeq : exe.respondedSeq.get(`${x.epoch}:${x.body.id}`)) ?? Infinity, fromSeq, epoch: x.epoch, tools, modern: modernRun(x) });
    }
  }
  return done;
}

/** A tool's identity in a walk: the fields its fingerprint covers, as design 3.5 and 5.6 define them and
    restated here (never imported): its name, title, effective description (the description, or the title
    when there's none) and input schema, in canonical form, so a relist in another key order (S23) is the same
    tool. The header declarations a modern remote run adds come from that schema, so they are covered with it;
    annotations, which the fingerprint leaves out, are not part of it. */
export const defIn = (w: { tools: any[]; modern?: boolean }, tool: string): string | undefined => {
  const def = w.tools.find((d: any) => d.name === tool);
  // As the fingerprint normalizes them: an omitted title is the empty one, an omitted description the title
  // (or empty); and a modern remote run's listing is marked apart, its header declarations (none declared is
  // an empty list) coming from the schema the identity already holds.
  // The reader keeps an optional title or description only when it is a string (3.10): any other is absent.
  const title = typeof def?.title === 'string' ? def.title : undefined;
  const description = typeof def?.description === 'string' ? def.description : undefined;
  return def === undefined ? undefined : canonical({ name: def.name, title: title ?? '', description: description ?? title ?? '', inputSchema: def.inputSchema ?? null, ...(w.modern ? { modern: true } : {}) });
};

/** A tool's fingerprint as the harness derives it from a walk, restating 3.5 and 5.6 (never imported): SHA-256,
    in hex, over the canonical JSON of its name, title (the empty one when absent), effective description (the
    description, or the title when there's none) and input schema, and on a modern remote run its header
    declarations (each one's path, header name and type, sorted by path, then header name; none declared is an
    empty list, still unlike a legacy run's). A title or description that is no string is absent (3.10). */
export function fingerprintIn(w: { tools: any[]; modern?: boolean }, tool: string): string | undefined {
  const def = w.tools.find((d: any) => d.name === tool);
  if (def === undefined) return undefined;
  const title = typeof def.title === 'string' ? def.title : undefined;
  const description = typeof def.description === 'string' ? def.description : undefined;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const headers = w.modern ? declarations(def.inputSchema).sort((a, b) => cmp(a.path.join('\u0000'), b.path.join('\u0000')) || cmp(a.name, b.name)) : undefined;
  return createHash('sha256').update(canonical({ name: def.name, title: title ?? '', description: description ?? title ?? '', inputSchema: def.inputSchema, ...(headers ? { modern: { headers } } : {}) })).digest('hex');
}

/** The header declarations of a schema: on properties reached from the root by `properties` alone (3.5). */
function declarations(schema: any, path: string[] = []): { path: string[]; name: string; type: unknown }[] {
  if (!schema || typeof schema !== 'object') return [];
  const here = path.length && typeof schema['x-mcp-header'] === 'string' ? [{ path, name: schema['x-mcp-header'] as string, type: schema.type }] : [];
  return [...here, ...Object.entries((schema.properties ?? {}) as Record<string, unknown>).flatMap(([k, v]) => declarations(v, [...path, k]))];
}

/** The tool's fingerprint in the last completed walk published before the sequence `seq`. */
export function fingerprintAt(exe: FakeExe, server: string, seq: number, tool: string): string | undefined {
  let found: { atSeq: number; tools: any[]; modern: boolean } | undefined;
  for (const w of walks(exe, server)) if (w.atSeq < seq && (!found || w.atSeq >= found.atSeq)) found = w;
  return found && fingerprintIn(found, tool);
}

/** The tool's definition in the last completed walk that reached the client before the sequence `seq`
    (Infinity: every walk that has reached it so far). */
export function catalogAt(exe: FakeExe, server: string, seq: number, tool: string): string | undefined {
  // By the global sequence of each walk's publication (its last page's answer reaching the client), never by
  // step: a walk published earlier in a handoff's own step was published before it.
  let found: { atSeq: number; tools: any[]; modern: boolean } | undefined;
  for (const w of walks(exe, server)) if (w.atSeq < seq && (!found || w.atSeq >= found.atSeq)) found = w;
  return found && defIn(found, tool);
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

