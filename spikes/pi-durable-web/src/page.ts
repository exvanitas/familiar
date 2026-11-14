// The in-page side of the spike. The driver (scripts/browser-check.mjs) loads this page, reloads it mid-turn, and
// reads `window.__spike` once a life is done. Lives and counters live in localStorage, so they survive reloads.

import { createFakeModel } from '@familiar/core/testing';
import type { FakeReply, ModelRequest } from '@familiar/core';
import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { ctx, familiarState, LiveDoc, openEngine, Reminder } from './engine.ts';
import { SqlJsDatabase } from './sqljs-database.ts';
import { runConformance } from './conformance.ts';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'inflight-unsafe';
const store = params.get('store') ?? 'idb';
const run = params.get('run') ?? 'default';

const key = (name: string) => `${run}:${name}`;
const count = (name: string) => Number(localStorage.getItem(key(name)) ?? '0');
const bump = (name: string) => {
  const n = count(name) + 1;
  localStorage.setItem(key(name), String(n));
  return n;
};
const life = bump('life');
const log: string[] = [];
const say = (line: string) => {
  log.push(`life ${life} +${Math.round(performance.now())}ms ${line}`);
  console.log(`[spike] ${line}`);
};
const never = new Promise<never>(() => {});

// ---- storage ----

function idbFiles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('spike-sqljs-files', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function loadFile(name: string): Promise<Uint8Array | undefined> {
  const db = await idbFiles();
  return new Promise((resolve, reject) => {
    const req = db.transaction('files').objectStore('files').get(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveFile(name: string, bytes: Uint8Array): Promise<void> {
  const db = await idbFiles();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite', { durability: 'strict' } as any);
    tx.objectStore('files').put(bytes, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let sqlDb: SqlJsDatabase | undefined;
async function openStorage() {
  if (store === 'idb') return IndexedDbStorage.open(`spike-${run}`);
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const bytes = await loadFile(run);
  sqlDb = new SqlJsDatabase(new SQL.Database(bytes), { persist: (b) => saveFile(run, b) });
  return SqliteStorage.open(sqlDb as any);
}

// ---- the fake model, through Familiar's own port ----

const lastIsTool = (r: ModelRequest) => r.messages.at(-1)?.role === 'tool';
function script(request: ModelRequest, index: number): FakeReply {
  bump('model-requests');
  if (scenario === 'turn-cap') {
    return { toolCalls: [{ id: `call-${count('model-requests')}`, name: 'save_note', arguments: { text: 'again' } }] };
  }
  if (scenario === 'midstream' && life === 1) {
    // Streams a few words and then stalls, so the reload lands mid-answer.
    return { text: 'Let me think about where to put that note for you...', chunkSize: 4, pause: { afterEvents: 4, until: never } };
  }
  if (lastIsTool(request)) return { text: `Done. (${request.messages.at(-1)!.content})` };
  if (scenario === 'midstream') return { text: 'Here is the whole answer after the restart.' };
  return { text: 'Saving that.', toolCalls: [{ id: 'call-1', name: 'save_note', arguments: { text: 'buy milk' } }] };
}

// ---- what a life does ----

async function conformance() {
  let n = 0;
  const SQL = store === 'sqljs' ? await initSqlJs({ locateFile: () => sqlWasmUrl }) : undefined;
  const withStorage = async (use: (storage: any) => Promise<void>) => {
    const name = `conf-${run}-${n++}`;
    const storage: any = SQL ? await SqliteStorage.open(new SqlJsDatabase(new SQL.Database()) as any) : await IndexedDbStorage.open(name);
    try {
      await use(storage);
    } finally {
      await storage.close(ctx);
      if (!SQL) await IndexedDbStorage.delete(name);
    }
  };
  const result = await runConformance(withStorage);
  say(`conformance ${result.passed}/${result.total}`);
  (window as any).__spike = { done: true, result: { scenario, store, conformance: result, log } };
}

async function main() {
  say(`scenario=${scenario} store=${store} run=${run}`);
  if (scenario === 'conformance') return conformance();
  const reports: unknown[] = [];
  const states: string[] = [];
  const fake = createFakeModel(script);
  const storage = await openStorage();
  const { harness, root } = await openEngine({
    storage,
    port: fake,
    replay: scenario === 'inflight-safe' ? 'safe' : 'unsafe',
    maxTurns: scenario === 'turn-cap' ? 2 : undefined,
    hooks: {
      onToolStart: (name) => say(`tool ${name} started (start #${bump('tool-starts')})`),
      toolBody: async (name, args: any) => {
        // In the first life the tool hangs, so the reload finds it in flight.
        if (life === 1 && scenario.startsWith('inflight')) return never;
        return `saved: ${args.text}`;
      },
      consent: async (name) => {
        const n = bump('consent-asks');
        say(`consent asked for ${name} (ask #${n})`);
        if (scenario === 'consent' && life === 1) return never; // the user has not answered yet
        if (scenario === 'consent-deny') return false;
        return true;
      },
      onReminder: (text, at, firedAt) => {
        bump('reminders-fired');
        localStorage.setItem(key('reminder-fired-late-ms'), String(firedAt - at));
        say(`reminder fired: ${text} (${firedAt - at}ms after due)`);
      },
      onReport: (r: any) => {
        reports.push({ kind: r.kind, reason: r.reason, message: String(r.error?.message ?? r.error ?? '') });
      }
    }
  });
  say('engine open');

  const watch = await root.watch(ctx);
  const track = (view: any) => {
    const s = familiarState(view);
    if (states.at(-1) !== s) states.push(s);
  };
  track(watch.value);
  watch.start(async (call: any) => {
    if (call.kind === 'value') track(call.value);
  });

  const done = async (extra: Record<string, unknown> = {}) => {
    const entries = (await root.entries({ order: 'ascending' }, 200, undefined, ctx)).items.map(summarize);
    const live = await harness.snapshot(LiveDoc, root.id, ctx);
    const result = {
      scenario,
      store,
      life,
      counters: {
        toolStarts: count('tool-starts'),
        consentAsks: count('consent-asks'),
        modelRequests: count('model-requests'),
        remindersFired: count('reminders-fired')
      },
      states,
      entries,
      runFailure: live?.runFailure,
      reports,
      sqlCalls: sqlDb ? sqlDb.calls.length : undefined,
      sqlTransactions: sqlDb ? sqlDb.calls.filter((c) => c.op === 'begin').length : undefined,
      sql: sqlDb ? sqlStats(sqlDb.calls) : undefined,
      ...extra,
      log
    };
    (window as any).__spike = { done: true, result };
  };

  if (scenario === 'reminder' || scenario === 'reminder-missed') {
    if (life === 1) {
      const at = Date.now() + (scenario === 'reminder' ? 1500 : 1000);
      await root.commit(
        (tx: any) => tx.createTask(Reminder, { text: 'stretch', at }, { ownership: { kind: 'conversation' }, background: true }),
        ctx
      );
      harness.resume();
      say(`reminder parked until +${at - Date.now()}ms`);
      (window as any).__spike = { parked: true };
      return;
    }
    const opened = Date.now();
    harness.resume();
    say('resumed');
    while (count('reminders-fired') === 0) await new Promise((r) => setTimeout(r, 50));
    const inspection = await harness.inspect(ctx);
    return done({ firedAfterOpenMs: Date.now() - opened, lateMs: Number(localStorage.getItem(key('reminder-fired-late-ms'))), inspection: summarizeInspection(inspection) });
  }

  if (life === 1) {
    harness.resume();
    const submission = await root.submit({ type: 'input', content: 'Remember to buy milk.', requestId: 'turn-1' }, ctx);
    say(`submitted ${submission.id}`);
    if (scenario === 'turn-cap' || scenario === 'consent-deny') {
      const settled = await submission.wait(ctx);
      return done({ settled: { status: settled.status, reason: settled.reason } });
    }
    (window as any).__spike = { submitted: true };
    return; // the driver reloads the page while the turn is in flight
  }

  // Life 2: the same storage, the same extensions, then resume. The same requestId finds the same submission.
  harness.resume();
  say('resumed');
  const again = await root.submit({ type: 'input', content: 'Remember to buy milk.', requestId: 'turn-1' }, ctx);
  const settled = await again.wait(ctx);
  say(`settled ${settled.status}`);
  await root.waitForIdle(ctx);
  return done({ settled: { status: settled.status, reason: settled.reason } });
}

function sqlStats(calls: SqlJsDatabase['calls']) {
  const perTransaction = new Map<number, number>();
  for (const c of calls) if (c.transaction !== undefined && c.op !== 'begin' && c.op !== 'commit') perTransaction.set(c.transaction, (perTransaction.get(c.transaction) ?? 0) + 1);
  const ends = calls.filter((c) => c.op === 'commit' || c.op === 'rollback');
  const reads = calls.filter((c) => c.transaction !== undefined && (c.op === 'get' || c.op === 'all')).length;
  const writes = calls.filter((c) => c.transaction !== undefined && (c.op === 'run' || c.op === 'runCounted' || c.op === 'exec')).length;
  return {
    calls: calls.length,
    outsideTransactions: calls.filter((c) => c.transaction === undefined).length,
    transactions: ends.length,
    rollbacks: ends.filter((c) => c.op === 'rollback').length,
    statementsPerTransaction: [...perTransaction.values()],
    readsInTransactions: reads,
    writesInTransactions: writes,
    maxHeldMs: Math.max(0, ...ends.map((c) => Math.round((c.heldMs ?? 0) * 10) / 10)),
    // A transaction whose writes depend on what it read first cannot be sent as one prepared batch.
    readThenWrite: [...new Set(calls.filter((c) => c.transaction !== undefined).map((c) => c.transaction))].filter((t) => {
      const ops = calls.filter((c) => c.transaction === t).map((c) => c.op);
      const firstWrite = ops.findIndex((o) => o === 'run' || o === 'runCounted' || o === 'exec');
      return firstWrite > 0 && ops.slice(0, firstWrite).some((o) => o === 'get' || o === 'all');
    }).length,
    largest: (() => {
      const [id] = [...perTransaction.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
      return calls.filter((c) => c.transaction === id).map((c) => `${c.op} ${c.sql}`);
    })()
  };
}

function summarize(entry: any) {
  const message = entry.model?.[0];
  const out: any = { kind: entry.kind };
  if (!message) return out;
  out.role = message.role;
  const text = Array.isArray(message.content)
    ? message.content.map((b: any) => b.text ?? (b.type === 'toolCall' ? `toolCall(${b.name} ${JSON.stringify(b.arguments)})` : '')).join(' ')
    : message.content;
  out.text = String(text).slice(0, 160);
  if (message.stopReason) out.stopReason = message.stopReason;
  if (message.isError !== undefined) out.isError = message.isError;
  const diagnostics = entry.data?.diagnostics ?? message.details?.diagnostics ?? entry.diagnostics;
  if (diagnostics) out.diagnostics = diagnostics;
  return out;
}

function summarizeInspection(inspection: any) {
  try {
    return JSON.parse(JSON.stringify(inspection, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).tasks?.length;
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  say(`FAILED ${error?.stack ?? error}`);
  (window as any).__spike = { done: true, failed: String(error?.stack ?? error), result: { log } };
});
