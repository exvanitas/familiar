// Adding a server by paste or by form. Both give the same draft: a setup with no secret values in it,
// plus the values for Settings to put straight into Credential Manager. The raw paste is never kept:
// these functions return only what they read out of it, and the caller drops the text.
//
// A paste can be the common `mcpServers` block most READMEs give, VS Code's `servers` (or `mcp.servers`),
// a bare map of servers, or one server object. Comments and trailing commas are forgiven.

import { unpinned, type Unpinned } from './unpinned.ts';
import type { PathRules } from './native-rules.ts';
import { KEY_HEADERS } from './remote.ts';
import { changesWhatRuns, credentialLike, keyLike, secretValueProblem, setupProblems, type LocalSetup, type RemoteSetup, type ServerSetup } from './setup.ts';

export interface Draft {
  readonly setup: ServerSetup;
  /** A local server's secret values by setting name, for `server:<id>:<NAME>`. Never saved by core. */
  readonly secrets: readonly (readonly [string, string])[];
  /** A remote server's key, for `addr:<address>` once its address is approved. Never saved by core. */
  readonly key?: string;
  readonly unpinned?: Unpinned;
  /** Problems that stop it being added, in plain words. */
  readonly problems: readonly string[];
  /** Things the person should know, that don't stop it. */
  readonly notes: readonly string[];
}

export interface DraftOptions {
  /** A fresh setup id. */
  readonly newId: () => string;
  /** The folder a local server runs in when the paste names none. */
  readonly defaultCwd?: string;
  /** How paths are checked: Windows' rules unless a test says otherwise. */
  readonly paths?: PathRules;
}

export interface PasteResult {
  readonly drafts: readonly Draft[];
  /** Problems with the paste as a whole. */
  readonly problems: readonly string[];
}

/** What the form gives, for a local server. Each setting says whether it's a secret. */
export interface LocalForm {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly settings: readonly { readonly name: string; readonly value: string; readonly secret: boolean }[];
}

/** What the form gives, for a remote server. */
export interface RemoteForm {
  readonly label: string;
  readonly url: string;
  readonly transport?: 'http' | 'sse';
  readonly headers: readonly (readonly [string, string])[];
}

const PLACEHOLDER_VALUE = /^<[^>]*>$|^\$\{[^}]*\}$|your[_ -]?(api[_ -]?)?(key|token|secret)|^(x{3,}|\*{3,})$|^(changeme|replace[_ -]?me)$/i;

export function parsePaste(text: string, options: DraftOptions): PasteResult {
  const value = readJson(text);
  if (value === undefined) return { drafts: [], problems: ["Familiar couldn't read that as a server's JSON. Paste the whole block from the server's README, braces included."] };
  const servers = serversIn(value);
  if (servers.length === 0) return { drafts: [], problems: ["That JSON names no server. Familiar looks for an mcpServers block, a server's command, or its url."] };
  return { drafts: servers.map(([label, s]) => draftOf(label, s, options)), problems: [] };
}

/** JSON, or JSON with comments and trailing commas, or the inside of an object without its braces. */
function readJson(text: string): unknown {
  const tries = [text, loosen(text), `{${loosen(text)}}`];
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      /* the next form */
    }
  }
  return undefined;
}

/** Drops comments (outside strings) and trailing commas. */
function loosen(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1').trim().replace(/,$/, '');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isServer = (v: unknown): boolean => isObj(v) && (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.serverUrl === 'string' || typeof v.httpUrl === 'string');

function serversIn(v: unknown): [string, Obj][] {
  if (!isObj(v)) return [];
  if (isServer(v)) return [[typeof v.name === 'string' ? v.name : '', v]];
  const map = isObj(v.mcpServers) ? v.mcpServers : isObj(v.servers) ? v.servers : isObj(v.mcp) && isObj(v.mcp.servers) ? v.mcp.servers : v;
  return Object.entries(map).filter((e): e is [string, Obj] => isServer(e[1]));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
const pairs = (v: unknown): [string, string][] => (isObj(v) ? Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]) : []);

function draftOf(label: string, s: Obj, options: DraftOptions): Draft {
  const url = [s.url, s.serverUrl, s.httpUrl].find((u): u is string => typeof u === 'string');
  if (typeof s.command !== 'string' && url !== undefined) {
    const type = String(s.type ?? s.transport ?? '').toLowerCase();
    return remoteDraft({ label, url, transport: type === 'sse' ? 'sse' : 'http', headers: pairs(s.headers) }, options);
  }
  // Every setting is a secret by default, except those that change what runs, and values too short
  // to keep as one whose names don't look like credentials.
  // A credential-like name is always a secret, however short (a short one is then a problem, never a
  // plain setting).
  const short = (v: string) => new TextEncoder().encode(v).length < 8;
  const settings = pairs(s.env).map(([name, value]) => ({ name, value, secret: !changesWhatRuns(name) && (credentialLike(name) || !short(value)) }));
  const shortOnes = pairs(s.env).filter(([name, value]) => !changesWhatRuns(name) && !credentialLike(name) && short(value)).map(([n]) => n);
  const d = localDraft({ label, command: String(s.command), args: strings(s.args), ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}), settings }, options);
  const notes = [...d.notes];
  if (shortOnes.length) notes.push(`${shortOnes.join(', ')} ${shortOnes.length === 1 ? 'is' : 'are'} too short to keep as a secret, so ${shortOnes.length === 1 ? 'it is' : 'they are'} kept as plain settings, shown in the approval and saved with the setup.`);
  return { ...d, notes };
}

export function localDraft(form: LocalForm, options: DraftOptions): Draft {
  const plain: [string, string][] = [];
  const secrets: [string, string][] = [];
  const notes: string[] = [];
  const problems: string[] = [];
  for (const { name, value, secret } of form.settings) {
    if (PLACEHOLDER_VALUE.test(value.trim())) problems.push(`${name} still holds the README's example value. Put your own value in.`);
    if (secret && !changesWhatRuns(name)) {
      const p = secretValueProblem(name, value);
      if (p) problems.push(p);
      secrets.push([name, value]);
    } else plain.push([name, value]);
  }
  const setup: LocalSetup = {
    kind: 'local',
    id: options.newId(),
    label: (form.label || guessLabel(form.command, form.args)).trim(),
    program: form.command.trim(),
    args: [...form.args],
    cwd: (form.cwd ?? options.defaultCwd ?? '').trim(),
    env: plain,
    secrets: secrets.map(([n]) => n)
  };
  const flag = unpinned(setup.program, setup.args);
  if (flag) notes.push(`${flag.words} ${flag.fix}`);
  return { setup, secrets, ...(flag ? { unpinned: flag } : {}), problems: [...setupProblems(setup, options.paths), ...problems], notes };
}

export function remoteDraft(form: RemoteForm, options: DraftOptions): Draft {
  const problems: string[] = [];
  const headers: [string, string][] = [];
  let key: { header: string; prefix: string; value: string } | undefined;
  for (const [name, value] of form.headers) {
    const low = name.toLowerCase();
    if (KEY_HEADERS.includes(low)) {
      if (key) {
        problems.push('Familiar keeps one key per address, and this server has two key headers.');
        continue;
      }
      const m = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(value.trim());
      key = m ? { header: name, prefix: `${m[1]} `, value: m[2]!.trim() } : { header: name, prefix: '', value: value.trim() };
    } else if (keyLike(name)) {
      problems.push(`The ${name} header looks like it carries a key. Familiar can send a key only in Authorization, X-API-Key, Api-Key or X-Goog-Api-Key, so this server can't be added as it is.`);
    } else headers.push([name, value]);
  }
  if (key) {
    if (PLACEHOLDER_VALUE.test(key.value)) problems.push(`The ${key.header} header still holds the README's example value. Put your own key in.`);
    const p = secretValueProblem(`The key in ${key.header}`, key.value);
    if (p) problems.push(p);
  }
  const setup: RemoteSetup = {
    kind: 'remote',
    id: options.newId(),
    label: (form.label || hostOf(form.url)).trim(),
    url: form.url.trim(),
    transport: form.transport ?? 'http',
    headers,
    ...(key ? { key: { header: key.header, prefix: key.prefix } } : {})
  };
  return { setup, secrets: [], ...(key ? { key: key.value } : {}), problems: [...setupProblems(setup), ...problems], notes: [] };
}

function guessLabel(command: string, args: readonly string[]): string {
  const pkg = args.find(a => !a.startsWith('-'));
  return (pkg ?? command).replace(/@[^/@]*$/, '').split('/').pop()?.slice(0, 64) ?? 'Server';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.slice(0, 64);
  } catch {
    return 'Server';
  }
}
