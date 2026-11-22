// One owner of durable tool config (docs/mcp-design.md 5.1 to 5.3, 5.9): the saved servers, their keys,
// enabled flags, limits and tools seen and reviewed, the person's choices for every tool, the one mark of
// a change under way, and the tombstones of removed servers. All of it is one record in the settings
// store, written whole in one strict transaction per step, so each step commits atomically.
//
// - One durable effect at a time, for everything. A second is refused at once: "Saving another change.
//   Try again in a moment." A refused command changes nothing. Native starts count while the exe answers.
// - No deadlines on an effect: if the exe or the store never answers, Settings says "Saving…", and after
//   10 s that restarting finishes or undoes the change. The timer changes only the words.
// - Each change is a fixed list of steps with one mark. A change saved with its cleanup unfinished keeps
//   the mark, and every other change is refused until Retry or a restart's repair finishes it; starts of
//   other servers are still admitted then.
// - Fail closed: an unreadable choice loads as "ask"; an unreadable server is neither started nor
//   overwritten; the whole record unreadable means nothing loads and nothing is written.
// - No "always" for a server's tool, and no Allow for a built-in off the fixed notes-and-reminders list:
//   either is refused when it's saved, and one found in the record loads as "ask" (5.6).

import type { JsonValue } from '../model/port.ts';
import type { SettingsStore } from '../settings/store.ts';
import { unaskedBuiltIn } from '../journal/gate.ts';
import { mutant } from '../mutations.ts';
import { literalClass } from './native-rules.ts';
import type { ServerLimits, SavedTool } from './saved.ts';
import { choiceKey, parseChoiceKey, type ChoicePolicy, type ToolChoice } from './server-tools.ts';
import { secretRefs, type ServerSetup } from './setup.ts';

export const OWNER_KEY = 'mcp.owner';
export const OWNER_VERSION = 1;
export const BUSY_WORDS = 'Saving another change. Try again in a moment.';
export const WAITING_WORDS = 'Familiar is waiting on Windows. Restarting Familiar finishes or undoes this change.';
export const UNFINISHED_WORDS = 'A change was saved but its cleanup didn\'t finish. Press Retry first.';
export const WAITING_AFTER_MS = 10_000;
/** The server id built-in tools' choices are kept under: no saved server can have it (ids are non-empty). */
export const BUILT_IN = '';
export const NO_ALWAYS_WORDS = 'There\'s no "always" for a server\'s tool: every call asks for your Yes. To let this one tool run without asking, choose "May run on its own".';
export const ONLY_LISTED_WORDS = 'Only Familiar\'s own notes and reminders run without asking. This tool asks every time.';

/** Why a choice can't be saved, if it can't (5.6). */
export function choiceProblem(serverId: string, tool: string, choice: ToolChoice | undefined): string | undefined {
  if (!choice) return undefined;
  if (serverId === BUILT_IN) {
    if (choice.policy === 'own') return ONLY_LISTED_WORDS;
    if (choice.policy === 'allow' && !unaskedBuiltIn(tool)) return ONLY_LISTED_WORDS;
    return undefined;
  }
  if (choice.policy === 'allow' && !(__FAMILIAR_MUTATIONS__ && mutant('server-always'))) return NO_ALWAYS_WORDS;
  if (choice.policy === 'own' && (!choice.fingerprint || !choice.setupFingerprint)) return 'That grant names no version of the tool, so it was not saved.';
  return undefined;
}

/** A saved choice as the gate may read it: one that can't be saved now (an old "always" for a server tool,
    an Allow for a built-in off the list) loads as "ask", never as what it said. */
function loadable(key: string, c: ToolChoice): ToolChoice {
  const k = parseChoiceKey(key);
  if (!k) return { ...c, policy: 'ask' };
  return choiceProblem(k[0], k[1], c) ? { ...c, policy: 'ask' } : c;
}

export interface OwnedServer {
  readonly setup: ServerSetup;
  /** The frozen key models see before `__` (5.9). */
  readonly key: string;
  readonly enabled: boolean;
  readonly limits: ServerLimits;
  readonly tools: readonly SavedTool[];
  /** Set by a removal's first commit. */
  readonly removing?: true;
}

export interface Tombstone {
  readonly key: string;
  /** Cleanup items, each with a done flag. When all are done the tombstone shrinks to its key. */
  readonly forget?: boolean;
  readonly secrets?: Readonly<Record<string, boolean>>;
  readonly address?: { readonly id: string; readonly done: boolean };
}

export type Mark =
  | { readonly kind: 'add-remote'; readonly server: string; readonly identity: string }
  | { readonly kind: 'edit'; readonly server: string; readonly dropped: readonly string[] }
  | { readonly kind: 'remove'; readonly server: string };

interface Doc {
  rev: number;
  servers: Record<string, JsonValue>;
  choices: Record<string, JsonValue>;
  keys: string[];
  tombstones: Record<string, Tombstone>;
  mark?: Mark;
}

export interface OwnerPorts {
  readonly store: SettingsStore;
  readonly forget: (setupId: string) => Promise<void>;
  readonly addresses: { add(spec: { url: string; label: string }): Promise<{ id: string }>; remove(id: string): Promise<void>; list?(): Promise<readonly { id: string; kind: string; url: string }[]> };
  readonly secrets: { delete(ref: string): Promise<void> };
  readonly now: () => number;
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly words: string };

const ok: Outcome = { ok: true };
const no = (words: string): Outcome => ({ ok: false, words });

/** The exe's refusal of an address it doesn't hold (`address_remove` of an absent id): `{ kind: 'not-saved' }`. */
const notSaved = (e: unknown): boolean => e !== null && typeof e === 'object' && (e as { kind?: unknown }).kind === 'not-saved';

/* ---------- B6: the exe's address identity ---------- */

/** A removed server's id stays its tombstone's for good: never saved again, so nothing of it carries over. */
export const REMOVED_ID_WORDS = 'A removed server had this id, and ids are never used again. Add it as a new server.';

/** The exe's longest address, in bytes (address.rs `MAX_URL`). */
const MAX_URL = 2048;

/**
 * A URL as the exe normalizes it (shell-core address.rs `normalize`), or undefined for one it refuses.
 * Refused: empty or over 2048 bytes, a control character or a space anywhere, a scheme other than http,
 * https or ws, user info, a query or a fragment (an empty `?` or `#` too), no host, an encoded dot or
 * slash in the path, and a literal address the exe never reaches. Otherwise: scheme and host lower case,
 * the host as punycode, one trailing dot dropped, the default port dropped, no trailing slash. WHATWG
 * `URL` parses as Rust's `url` crate does; the rest is done here. One corpus checks both sides
 * (shell-core/fixtures/address-identity.json).
 */
export function addressIdentity(url: string): string | undefined {
  if (!url || new TextEncoder().encode(url).length > MAX_URL || /[\u0000-\u001f\u007f-\u009f ]/.test(url)) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws') return undefined;
  // `search` and `hash` are empty for a bare `?` or `#`, which the serialized form keeps.
  if (u.username || u.password || u.search || u.hash || u.href.includes('?') || u.href.includes('#')) return undefined;
  let host = u.hostname;
  const literal = literalClass(host);
  if (literal === 'refused') return undefined;
  if (!literal && !host.startsWith('[')) {
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host === '' || host.endsWith('.')) return undefined;
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (/%2e|%2f|%5c/i.test(path)) return undefined;
  return `${scheme}://${host}${u.port ? `:${u.port}` : ''}${path}`;
}

/* ---------- 5.9: keys ---------- */

export const MAX_KEY = 16;
export const MAX_MODEL_NAME = 64;

/** A key from a label: a lower-case letter, then letters and digits, at most 16; `server` with no Latin letter. */
export function keyBase(label: string): string {
  const latin = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const from = latin.replace(/^[0-9]+/, '');
  return (from || 'server').slice(0, MAX_KEY);
}

/** A key unique against every key ever issued, by a digit suffix. Never changed or reused. */
export function issueKey(label: string, issued: readonly string[]): string {
  const base = keyBase(label);
  const taken = new Set(issued);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const k = `${base.slice(0, MAX_KEY - suffix.length)}${suffix}`;
    if (!taken.has(k)) return k;
  }
}

/** The model's name for a tool: `<key>__<tool's own name>`, or why it isn't offered. Nothing is converted. */
export function modelName(key: string, tool: string): { readonly name: string } | { readonly reason: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(tool)) return { reason: `Its name "${tool.slice(0, 64)}" has characters a model can't call (only letters, digits, _ and -).` };
  const name = `${key}__${tool}`;
  if (name.length > MAX_MODEL_NAME) return { reason: `Its name is too long for a model (${name.length} characters with the server's key; at most ${MAX_MODEL_NAME}).` };
  return { name };
}

/* ---------- reading the record ---------- */

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const pairs = (v: unknown): boolean => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A saved record, checked to its leaves, as a copy of its own: a caller changing it changes nothing saved. */
function readServer(v: unknown): OwnedServer | undefined {
  if (!isObj(v) || !isObj(v.setup) || typeof v.key !== 'string' || typeof v.enabled !== 'boolean' || !isObj(v.limits) || !Array.isArray(v.tools)) return undefined;
  const s = v.setup as Record<string, unknown>;
  if (typeof s.id !== 'string' || typeof s.label !== 'string') return undefined;
  if (s.kind === 'local') {
    if (typeof s.program !== 'string' || !strings(s.args) || typeof s.cwd !== 'string' || !pairs(s.env) || !strings(s.secrets)) return undefined;
  } else if (s.kind === 'remote') {
    if (typeof s.url !== 'string' || !pairs(s.headers) || (s.transport !== 'http' && s.transport !== 'sse')) return undefined;
    if (s.key !== undefined && !(isObj(s.key) && typeof s.key.header === 'string' && typeof s.key.prefix === 'string')) return undefined;
    if (s.address !== undefined && typeof s.address !== 'string') return undefined;
  } else return undefined;
  const limits = v.limits as Record<string, unknown>;
  if ((limits.callMs !== undefined && typeof limits.callMs !== 'number') || (limits.initMs !== undefined && typeof limits.initMs !== 'number')) return undefined;
  const tools = v.tools.filter((t): t is SavedTool => isObj(t) && typeof t.name === 'string' && typeof t.fingerprint === 'string' && (t.reviewed === undefined || typeof t.reviewed === 'string'));
  return clone({ setup: s as unknown as ServerSetup, key: v.key, enabled: v.enabled, limits: limits as ServerLimits, tools, ...(v.removing === true ? { removing: true as const } : {}) });
}

function readChoice(v: unknown): ToolChoice | undefined {
  if (!isObj(v) || (v.policy !== 'allow' && v.policy !== 'ask' && v.policy !== 'deny' && v.policy !== 'own') || typeof v.fingerprint !== 'string' || typeof v.setupFingerprint !== 'string') return undefined;
  return { policy: v.policy as ChoicePolicy, fingerprint: v.fingerprint, setupFingerprint: v.setupFingerprint };
}

/* ---------- the owner ---------- */

export class Owner {
  private doc: Doc;
  /** The whole record couldn't be read: nothing loads, nothing is written. */
  readonly unreadable: boolean;
  private effect: { readonly what: string; readonly since: number } | undefined;
  /** The one reservation granted and not yet acknowledged (5.8): it holds the effect. */
  private reservation: { readonly id: string; readonly ref: string; readonly release: () => void } | undefined;
  private readonly ports: OwnerPorts;
  private readonly listeners = new Set<() => void>();

  private constructor(doc: Doc, unreadable: boolean, ports: OwnerPorts) {
    this.doc = doc;
    this.unreadable = unreadable;
    this.ports = ports;
  }

  static async open(ports: OwnerPorts): Promise<Owner> {
    const stored = await ports.store.get(OWNER_KEY);
    if (stored === undefined) return new Owner({ rev: 0, servers: {}, choices: {}, keys: [], tombstones: {} }, false, ports);
    const v = stored.value;
    if (stored.v !== OWNER_VERSION || !isObj(v) || !isObj(v.servers) || !isObj(v.choices) || !Array.isArray(v.keys) || !isObj(v.tombstones) || typeof v.rev !== 'number') {
      return new Owner({ rev: -1, servers: {}, choices: {}, keys: [], tombstones: {} }, true, ports);
    }
    return new Owner(JSON.parse(JSON.stringify(v)) as Doc, false, ports);
  }

  /** Hears every commit. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------- reads, of committed state ---------- */

  servers(): readonly OwnedServer[] {
    return Object.values(this.doc.servers).flatMap((v) => {
      const s = readServer(v);
      return s ? [s] : [];
    });
  }
  server(id: string): OwnedServer | undefined {
    return readServer(this.doc.servers[id]);
  }
  /** Saved records that couldn't be read: never started, never overwritten. */
  unreadableServers(): readonly string[] {
    return Object.keys(this.doc.servers).filter((id) => !readServer(this.doc.servers[id]));
  }
  /**
   * The person's choices. An unreadable one loads as "ask" for its tool, never as nothing: for a built-in
   * that runs without asking, nothing would mean its default allow (5.1, G6).
   */
  choices(): Readonly<Record<string, ToolChoice>> {
    const out: Record<string, ToolChoice> = {};
    for (const [k, v] of Object.entries(this.doc.choices)) {
      const c = readChoice(v);
      out[k] = c ? loadable(k, c) : { policy: 'ask', fingerprint: '', setupFingerprint: '' };
    }
    return out;
  }
  get mark(): Mark | undefined {
    return this.doc.mark && clone(this.doc.mark);
  }
  tombstones(): Readonly<Record<string, Tombstone>> {
    return clone(this.doc.tombstones);
  }
  /** What Settings shows: nothing, "Saving…", or the restart words after 10 s. */
  saving(): { readonly what: string; readonly words: string } | undefined {
    const e = this.effect;
    if (!e) return this.doc.mark ? { what: this.doc.mark.kind, words: UNFINISHED_WORDS } : undefined;
    return { what: e.what, words: this.ports.now() - e.since >= WAITING_AFTER_MS ? WAITING_WORDS : 'Saving…' };
  }
  get busy(): boolean {
    return this.effect !== undefined;
  }

  /* ---------- the one effect ---------- */

  /**
   * Admits one effect, synchronously, or refuses at once. While a mark is left unfinished, only Retry and
   * starts are admitted.
   */
  admit(what: string, options: { readonly start?: boolean } = {}): { readonly release: () => void } | Outcome {
    if (this.unreadable) return no("Familiar can't read its saved servers, so it changes nothing. Restart Familiar.");
    if (this.effect) return no(BUSY_WORDS);
    if (this.doc.mark && !options.start && what !== 'retry' && what !== 'repair') return no(UNFINISHED_WORDS);
    const token = { what, since: this.ports.now() };
    this.effect = token;
    return {
      release: () => {
        if (this.effect === token) this.effect = undefined;
        this.notify();
      }
    };
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** One commit: the change applied to a copy, written whole in one transaction, fenced by the revision. */
  private async commit(change: (d: Doc) => void): Promise<boolean> {
    if (this.unreadable) return false;
    const draft = clone(this.doc);
    change(draft);
    // Copied again after the change, so nothing a caller handed in (a setup, a choice) is held by reference.
    const next = clone(draft);
    next.rev = this.doc.rev + 1;
    const rev = this.doc.rev;
    const written = await this.ports.store.putIf(OWNER_KEY, { v: OWNER_VERSION, value: next as unknown as JsonValue }, (cur) => (cur === undefined ? rev === 0 : isObj(cur.value) && cur.value.rev === rev));
    if (written) {
      this.doc = next;
      this.notify();
    }
    return written;
  }

  /**
   * The catalog write: the tools a run listed, saved as the tools last seen. An effect like any other,
   * admitted in the same synchronous step as `current` is checked (the listing's run is still the server's
   * run). It's skipped, never queued, when the owner is busy or the run is gone: the list is re-derived at
   * the next listing, and until then a tool missing from it only reads as unreviewed. Admitted while a mark
   * is unfinished, like a start: it changes no setup. A write the store refuses rejects, as one that fails.
   */
  async seen(id: string, tools: readonly SavedTool[], current: () => boolean = () => true): Promise<void> {
    const s = this.server(id);
    if (!s || s.removing || JSON.stringify(s.tools) === JSON.stringify(tools) || !current()) return;
    const t = this.admit('seen', { start: true });
    if (!('release' in t)) return;
    try {
      // A write the store refuses (its revision guard, or a record it can't read) is a failed write, as one that
      // throws is: the machine is told so, never that the list was saved (6b.13, r35b #3).
      const written = await this.commit((d) => {
        const cur = readServer(d.servers[id]);
        if (cur) d.servers[id] = { ...cur, tools } as unknown as JsonValue;
        // A grant is the person's: no listing clears it (5.6, option A).
      });
      if (!written && !(__FAMILIAR_MUTATIONS__ && mutant('seen-refusal-saved'))) throw new Error('The tool list was not saved.');
    } finally {
      t.release();
    }
  }

  /* ---------- the changes ---------- */

  /**
   * Add, local or remote. The id must be new: never one saved or tombstoned. The setup is copied first,
   * before any check or await, and only the copy is read: a caller changing its draft while the exe's
   * dialog is open changes nothing approved or saved.
   */
  async add(draft: ServerSetup): Promise<Outcome> {
    const setup = clone(draft);
    if (this.doc.servers[setup.id] !== undefined) return no('A server with this id is already saved.');
    if (this.doc.tombstones[setup.id] !== undefined) return no(REMOVED_ID_WORDS);
    let identity: string | undefined;
    if (setup.kind === 'remote') {
      identity = addressIdentity(setup.url);
      if (!identity) return no("That isn't a web address Familiar can use.");
      const other = this.rawSetups().find((s) => s.url !== undefined && addressIdentity(s.url) === identity);
      if (other) return no(`Another server, ${other.label}, already uses this address. Familiar keeps one server per address.`);
    }
    const t = this.admit('add');
    if (!('release' in t)) return t;
    try {
      const key = issueKey(setup.label, this.doc.keys);
      const record = (s: ServerSetup): JsonValue => ({ setup: s, key, enabled: false, limits: {}, tools: [] }) as unknown as JsonValue;
      if (setup.kind === 'local') {
        if (!(await this.commit((d) => ((d.servers[setup.id] = record(setup)), d.keys.push(key))))) return no('The server could not be saved.');
        return ok;
      }
      // Remote: the mark first, then the exe's dialog, then the record and the mark's clearing together.
      if (!(await this.commit((d) => (d.mark = { kind: 'add-remote', server: setup.id, identity: identity! })))) return no('The server could not be saved.');
      let address: { id: string };
      try {
        address = await this.ports.addresses.add({ url: setup.url, label: setup.label });
      } catch (e) {
        await this.clearMark();
        return no(e instanceof Error && /declined/i.test(e.message) ? 'You chose not to allow this address.' : 'The address could not be added.');
      }
      // The exe returns an identical saved address's id: if another server holds it, this add can't share it,
      // and the address is never removed here (it's that server's).
      const holder = this.rawSetups().find((s) => s.address === address.id);
      if (holder) {
        await this.clearMark();
        return no(`Another server, ${holder.label}, already uses this address. Familiar keeps one server per address.`);
      }
      const saved = { ...setup, address: address.id };
      if (await this.commit((d) => ((d.servers[setup.id] = record(saved)), d.keys.push(key), delete d.mark))) return ok;
      // The add's commit failed after address_add. The exe can't yet say whether it created the address
      // (B6), so the rollback leaves it for the start-time sweep, which removes any address no record owns.
      await this.clearMark();
      return no('The server could not be saved.');
    } finally {
      t.release();
    }
  }

  /**
   * Every saved record's address and URL, read raw, as repair reads them: a record unreadable otherwise
   * still owns its address, and an Add must never share it (removing either would delete the other's key).
   */
  private rawSetups(): { readonly label: string; readonly url?: string; readonly address?: string }[] {
    return Object.entries(this.doc.servers).flatMap(([id, v]) => {
      const s = isObj(v) && isObj(v.setup) ? v.setup : undefined;
      if (!s) return [];
      const label = typeof s.label === 'string' ? s.label : id;
      return [{ label, ...(typeof s.url === 'string' ? { url: s.url } : {}), ...(typeof s.address === 'string' ? { address: s.address } : {}) }];
    });
  }

  private async clearMark(): Promise<void> {
    for (let i = 0; i < 3; i++) if (await this.commit((d) => delete d.mark)) return;
  }

  /** A change of a stopped server's setup: the record and a mark naming the dropped secrets, then their deletes. */
  async edit(id: string, setup: ServerSetup, stopped: boolean): Promise<Outcome> {
    const cur = this.server(id);
    if (!cur || cur.removing) return no('No server is saved with that id.');
    if (!stopped) return no('Stop the server before changing it.');
    const t = this.admit('edit');
    if (!('release' in t)) return t;
    try {
      const dropped = secretRefs(cur.setup).filter((r) => !secretRefs(setup).includes(r));
      if (!(await this.commit((d) => ((d.servers[id] = { ...cur, setup } as unknown as JsonValue), dropped.length ? (d.mark = { kind: 'edit', server: id, dropped }) : undefined)))) return no('The change was not saved.');
      if (!dropped.length) return ok;
      return (await this.finishEdit(dropped)) ? ok : no('Saved; cleanup not finished. Press Retry.');
    } finally {
      t.release();
    }
  }

  private async finishEdit(dropped: readonly string[]): Promise<boolean> {
    try {
      for (const ref of dropped) await this.ports.secrets.delete(ref);
    } catch {
      return false;
    }
    return this.commit((d) => delete d.mark);
  }

  /** Remove: Stop (awaited), the record set removing with a mark, the native cleanup, then the record and
      its choices gone and the tombstone kept, in one commit. */
  async remove(id: string, stop: () => Promise<void>): Promise<Outcome> {
    const cur = this.server(id);
    if (!cur) return no('No server is saved with that id.');
    const t = this.admit('remove');
    if (!('release' in t)) return t;
    try {
      await stop();
      const setup = cur.setup;
      const stone: Tombstone = {
        key: cur.key,
        ...(setup.kind === 'local' ? { forget: false, secrets: Object.fromEntries(secretRefs(setup).map((r) => [r, false])) } : {}),
        ...(setup.kind === 'remote' && setup.address ? { address: { id: setup.address, done: false } } : {})
      };
      if (!(await this.commit((d) => ((d.servers[id] = { ...cur, removing: true } as unknown as JsonValue), (d.tombstones[id] = stone), (d.mark = { kind: 'remove', server: id }))))) return no('The removal was not saved.');
      return (await this.finishRemove(id)) ? ok : no('Removing; cleanup not finished. Press Retry.');
    } finally {
      t.release();
    }
  }

  /** The native cleanup of a tombstone, each item idempotent, its done flag committed as it goes. */
  private async cleanTombstone(id: string): Promise<boolean> {
    const stone = this.doc.tombstones[id];
    if (!stone) return true;
    let clean = true;
    try {
      if (stone.forget === false) {
        await this.ports.forget(id);
        await this.commit((d) => (d.tombstones[id] = { ...d.tombstones[id]!, forget: true }));
      }
      for (const [ref, done] of Object.entries(stone.secrets ?? {})) {
        if (done) continue;
        await this.ports.secrets.delete(ref);
        await this.commit((d) => (d.tombstones[id] = { ...d.tombstones[id]!, secrets: { ...d.tombstones[id]!.secrets, [ref]: true } }));
      }
      if (stone.address && !stone.address.done) {
        // Idempotent: a removal a kill cut off before this done commit left the address gone, and the exe
        // answers a second one `not-saved`. That's the step done.
        await this.ports.addresses.remove(stone.address.id).catch((e: unknown) => {
          if (!notSaved(e)) throw e;
        });
        await this.commit((d) => (d.tombstones[id] = { ...d.tombstones[id]!, address: { id: stone.address!.id, done: true } }));
      }
    } catch {
      clean = false;
    }
    return clean;
  }

  private async finishRemove(id: string): Promise<boolean> {
    if (!(await this.cleanTombstone(id))) return false;
    const prefix = choiceKey(id, '').slice(0, -2);
    // Completion, not age, shrinks the tombstone to its id and key.
    return this.commit((d) => {
      delete d.servers[id];
      for (const k of Object.keys(d.choices)) if (k.startsWith(prefix)) delete d.choices[k];
      d.tombstones[id] = { key: d.tombstones[id]!.key };
      delete d.mark;
    });
  }

  /* ---------- reservations (5.8) ---------- */

  /**
   * Settings asks before it saves a secret's value: the owner grants one reservation for that one ref, of
   * a server saved now, with a fresh id used once. The grant holds the owner (no other change, no removal
   * of that server) until Settings acknowledges it by that id, after its `secret_set` has settled, or until
   * the exe restarts and the owner is opened again. The value never passes through core.
   */
  reserve(ref: string): { readonly ok: true; readonly grant: { readonly id: string; readonly ref: string } } | Outcome {
    if (typeof ref !== 'string' || !this.servers().some((s) => !s.removing && secretRefs(s.setup).includes(ref))) return no('No saved server has that secret.');
    const t = this.admit('secret');
    if (!('release' in t)) return t;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    this.reservation = { id, ref, release: t.release };
    return { ok: true, grant: { id, ref } };
  }

  /** Settings' acknowledgement: by the grant's id and ref. Anything else (unknown, used, mismatched) does nothing. */
  acknowledge(id: unknown, ref: unknown): boolean {
    const r = this.reservation;
    if (!r || typeof id !== 'string' || id !== r.id || ref !== r.ref) return false;
    this.reservation = undefined;
    r.release();
    return true;
  }

  /** Retry: finishes the mark's cleanup. */
  async retry(): Promise<Outcome> {
    const mark = this.doc.mark;
    if (!mark) return ok;
    const t = this.admit('retry');
    if (!('release' in t)) return t;
    try {
      return (await this.finishMark(mark)) ? ok : no('Cleanup still didn\'t finish. Try again, or restart Familiar.');
    } finally {
      t.release();
    }
  }

  private async finishMark(mark: Mark): Promise<boolean> {
    if (mark.kind === 'edit') return this.finishEdit(mark.dropped);
    if (mark.kind === 'remove') return this.finishRemove(mark.server);
    // An add whose record was never committed: not saved. Its address, if one was made, is an orphan.
    await this.clearMark();
    return this.doc.mark === undefined;
  }

  /**
   * Repair, only in a fresh exe (5.3): every old native operation ended with the old process. The one mark
   * is rolled back or finished (address_add is never repeated), unfinished tombstones are retried, and any
   * server address no record owns is removed.
   */
  async repair(): Promise<Outcome> {
    const t = this.admit('repair');
    if (!('release' in t)) return t;
    try {
      if (this.doc.mark && !(await this.finishMark(this.doc.mark))) return no('Repair didn\'t finish. Press Retry.');
      for (const id of Object.keys(this.doc.tombstones)) {
        const s = this.doc.tombstones[id]!;
        if (s.forget === false || Object.values(s.secrets ?? {}).some((x) => !x) || (s.address && !s.address.done)) {
          if (await this.cleanTombstone(id)) await this.commit((d) => (d.tombstones[id] = { key: d.tombstones[id]!.key }));
        }
      }
      if (this.ports.addresses.list) {
        // Owned by any saved record that names it, read raw: a record that's unreadable otherwise still
        // owns its address, whose removal would delete its key for good.
        const owned = new Set(
          Object.values(this.doc.servers).flatMap((v) => {
            const address = isObj(v) && isObj(v.setup) ? v.setup.address : undefined;
            return typeof address === 'string' ? [address] : [];
          })
        );
        let swept = true;
        for (const a of await this.ports.addresses.list()) {
          if (a.kind !== 'server' || owned.has(a.id)) continue;
          // Gone already (the exe's not-saved) is removed; any other failure leaves repair unfinished.
          await this.ports.addresses.remove(a.id).catch((e: unknown) => {
            if (!notSaved(e)) swept = false;
          });
        }
        if (!swept) return no("Repair didn't finish: an address no server uses couldn't be removed. Familiar tries again at its next start.");
      }
      return ok;
    } finally {
      t.release();
    }
  }

  /** Enable, Disable, limits, mark reviewed, a choice: one commit each. */
  async update(id: string, change: (s: OwnedServer) => OwnedServer, what = 'update'): Promise<Outcome> {
    const cur = this.server(id);
    if (!cur || cur.removing) return no('No server is saved with that id.');
    const t = this.admit(what);
    if (!('release' in t)) return t;
    try {
      return (await this.commit((d) => (d.servers[id] = change(cur) as unknown as JsonValue))) ? ok : no('The change was not saved.');
    } finally {
      t.release();
    }
  }

  async choose(serverId: string, tool: string, choice: ToolChoice | undefined): Promise<Outcome> {
    // A grant has its own writer, for a press on its card (grant): never a choice saved here (r37 #2).
    if (choice?.policy === 'own' && !(__FAMILIAR_MUTATIONS__ && mutant('choose-own'))) return no('"May run on its own" is saved only from a press on its card.');
    const problem = choiceProblem(serverId, tool, choice);
    if (problem) return no(problem);
    // A take-back (ask, never) is let in while a change's cleanup is unfinished, as a catalog write is: it
    // changes no setup and only tightens. Nothing else is (5.6; r37 #5).
    const t = this.admit('choice', { start: choice !== undefined && (choice.policy === 'ask' || choice.policy === 'deny') });
    if (!('release' in t)) return t;
    try {
      const key = choiceKey(serverId, tool);
      // A choice for a server tool is written only for a saved server, not being removed (r37 #3).
      if (choice && serverId !== BUILT_IN && (!this.server(serverId) || this.server(serverId)!.removing)) return no('That server is gone, so the choice was not saved.');
      return (await this.commit((d) => (choice ? (d.choices[key] = choice as unknown as JsonValue) : delete d.choices[key]))) ? ok : no('The choice was not saved.');
    } finally {
      t.release();
    }
  }


  /**
   * "May run on its own" for one exact version (5.6, option A): the one writer of a grant, for a press on its
   * card (McpClient.pressOwn). Let in while a change's cleanup is unfinished: it changes no setup. Written
   * only for a saved server, not being removed, checked in the same step as its admission, so a grant never
   * outlives its server (r37 #3).
   */
  async grant(serverId: string, tool: string, version: { readonly fingerprint: string; readonly setupFingerprint: string }): Promise<Outcome> {
    if (serverId === BUILT_IN) return no(ONLY_LISTED_WORDS);
    if (!version.fingerprint || !version.setupFingerprint) return no('That grant names no version of the tool, so it was not saved.');
    const t = this.admit('choice', { start: true });
    if (!('release' in t)) return t;
    try {
      const s = this.server(serverId);
      if ((!s || s.removing) && !(__FAMILIAR_MUTATIONS__ && mutant('grant-after-remove'))) return no('That server is gone, so the grant was not saved.');
      const key = choiceKey(serverId, tool);
      const choice: ToolChoice = { policy: 'own', fingerprint: version.fingerprint, setupFingerprint: version.setupFingerprint };
      return (await this.commit((d) => void (d.choices[key] = choice as unknown as JsonValue))) ? ok : no('The choice was not saved.');
    } finally {
      t.release();
    }
  }

}
