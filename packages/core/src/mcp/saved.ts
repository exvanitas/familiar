// Saved servers, in the settings store under `mcp.server.<id>`, schema version 1. A record holds the setup
// (never a secret's value), whether it starts with the app, its own limits, and the tools last seen with
// their fingerprints and whether the person has reviewed each. A record of a newer version than this
// code knows is left as it is and not loaded, never overwritten.
//
// Every write and delete is fenced in the same IndexedDB transaction that makes it: a record carries the
// incarnation it was added as and a revision that only grows. A write lands only on the same incarnation
// at a lower revision, the first write only where there's nothing, and a delete only on its own
// incarnation. So a write or delete that lands late can't touch a newer record, or a server added again
// under the same id. (`incarnation` and `rev` were added after version 1 shipped to no one; a record
// without them reads as incarnation "" and revision 0.)

import type { JsonValue } from '../model/port.ts';
import type { SettingsStore } from '../settings/store.ts';
import type { ServerSetup } from './setup.ts';

export const SERVER_PREFIX = 'mcp.server.';
export const SAVED_VERSION = 1;

export interface SavedTool {
  readonly name: string;
  /** The fingerprint last seen. */
  readonly fingerprint: string;
  /** The fingerprint the person last reviewed (saw its name and description), if any. The tool is
      fresh, new or changed, whenever this differs from the one last seen. */
  readonly reviewed?: string;
}

export const fresh = (t: SavedTool | undefined, fingerprint: string) => t?.reviewed !== fingerprint;

export interface ServerLimits {
  /** A call's deadline, ms. */
  readonly callMs?: number;
  /** The handshake's deadline, ms. */
  readonly initMs?: number;
}

export interface SavedServer {
  readonly setup: ServerSetup;
  readonly enabled: boolean;
  readonly limits: ServerLimits;
  readonly tools: readonly SavedTool[];
  /** Which adding of this id the record belongs to. */
  readonly incarnation: string;
  /** Grows with every write. */
  readonly rev: number;
}

export const keyOf = (id: string) => `${SERVER_PREFIX}${id}`;

const fields = (v: unknown) => (v !== null && typeof v === 'object' ? (v as { incarnation?: unknown; rev?: unknown }) : {});
const incarnationOf = (v: unknown) => (typeof fields(v).incarnation === 'string' ? (fields(v).incarnation as string) : '');
const revOf = (v: unknown) => (typeof fields(v).rev === 'number' ? (fields(v).rev as number) : 0);

/** The first write of an added server: only where nothing is saved under its id. */
export async function addServer(store: SettingsStore, s: SavedServer): Promise<boolean> {
  return store.putIf(keyOf(s.setup.id), { v: SAVED_VERSION, value: s as unknown as JsonValue }, cur => cur === undefined);
}

/** A later write: only over the same incarnation at a lower revision. */
export async function saveServer(store: SettingsStore, s: SavedServer): Promise<boolean> {
  return store.putIf(keyOf(s.setup.id), { v: SAVED_VERSION, value: s as unknown as JsonValue }, cur => cur !== undefined && incarnationOf(cur.value) === s.incarnation && revOf(cur.value) < s.rev);
}

/** The removal's delete: only of its own incarnation. */
export async function deleteServer(store: SettingsStore, id: string, incarnation: string): Promise<boolean> {
  return store.deleteIf(keyOf(id), cur => cur !== undefined && incarnationOf(cur.value) === incarnation);
}

/** Every saved server this code can read. Records it can't read are skipped, and left in the store. */
export async function loadServers(store: SettingsStore): Promise<SavedServer[]> {
  const out: SavedServer[] = [];
  for (const key of await store.keys(SERVER_PREFIX)) {
    const r = await store.get(key);
    const s = r?.v === SAVED_VERSION ? readServer(r.value) : undefined;
    if (s && keyOf(s.setup.id) === key) out.push(s);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isPairs = (v: unknown): v is [string, string][] => Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string');

/** A stored value as a saved server, or undefined if it isn't one. */
export function readServer(v: unknown): SavedServer | undefined {
  if (!isObj(v) || !isObj(v.setup) || typeof v.enabled !== 'boolean' || !isObj(v.limits) || !Array.isArray(v.tools)) return undefined;
  const s = v.setup;
  if (typeof s.id !== 'string' || typeof s.label !== 'string') return undefined;
  if (s.kind === 'local') {
    if (typeof s.program !== 'string' || !isStrings(s.args) || typeof s.cwd !== 'string' || !isPairs(s.env) || !isStrings(s.secrets)) return undefined;
  } else if (s.kind === 'remote') {
    if (typeof s.url !== 'string' || (s.transport !== 'http' && s.transport !== 'sse') || !isPairs(s.headers)) return undefined;
    if (s.key !== undefined && !(isObj(s.key) && typeof s.key.header === 'string' && typeof s.key.prefix === 'string')) return undefined;
    if (s.address !== undefined && typeof s.address !== 'string') return undefined;
  } else return undefined;
  const tools = v.tools.filter((t): t is SavedTool => isObj(t) && typeof t.name === 'string' && typeof t.fingerprint === 'string' && (t.reviewed === undefined || typeof t.reviewed === 'string'));
  const limits: ServerLimits = {
    ...(typeof v.limits.callMs === 'number' ? { callMs: v.limits.callMs } : {}),
    ...(typeof v.limits.initMs === 'number' ? { initMs: v.limits.initMs } : {})
  };
  return { setup: s as unknown as ServerSetup, enabled: v.enabled, limits, tools, incarnation: incarnationOf(v), rev: revOf(v) };
}
