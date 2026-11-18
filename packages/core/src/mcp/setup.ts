// A server's setup, as Familiar saves it: never a secret's value. The checks mirror the exe's limits and
// rules (shell-core's setup.rs, 5b and 5c in docs/shell-design.md), so a setup fails here, early, with
// the same words, before anything reaches the exe.

import { reservedHeader } from './wire/link.ts';
import { canonicalJson, sha256 } from './hash.ts';
import type { ProcessSetup } from './process.ts';
import { literalClass, windowsPaths, type PathRules } from './native-rules.ts';
import { KEY_HEADERS, type RemoteTarget } from './remote.ts';

export interface LocalSetup {
  readonly kind: 'local';
  readonly id: string;
  readonly label: string;
  /** A bare name looked up on PATH (npx, uvx, docker), or a full local path. */
  readonly program: string;
  readonly args: readonly string[];
  /** The folder it runs in: a full local path. */
  readonly cwd: string;
  /** Plain settings, with their values. They're shown in the approval and saved with the setup. */
  readonly env: readonly (readonly [string, string])[];
  /** The names of settings kept in Credential Manager, as `server:<id>:<NAME>`. */
  readonly secrets: readonly string[];
}

export interface RemoteSetup {
  readonly kind: 'remote';
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly transport: 'http' | 'sse';
  /** Plain headers. */
  readonly headers: readonly (readonly [string, string])[];
  /** Where its key goes, if it has one. The key itself is in Credential Manager as `addr:<address>`. */
  readonly key?: { readonly header: string; readonly prefix: string };
  /** The saved address's id, once the person approved it. */
  readonly address?: string;
}

export type ServerSetup = LocalSetup | RemoteSetup;

export const MAX_ARGS = 64;
export const MAX_SETTINGS = 32;
export const MAX_SECRETS = 32;
export const MAX_SETUP_BYTES = 8 * 1024;
export const MAX_ID = 64;
export const MAX_NAME = 128;
export const MAX_LABEL = 64;
export const MAX_HEADERS = 32;
export const MAX_HEADER_BYTES = 8 * 1024;
export const SECRET_MIN_BYTES = 8;
export const SECRET_MAX_BYTES = 1024;

/** Settings that change what runs. They can only be plain settings, whose values the approval binds. */
export const SETTINGS_THAT_RUN: readonly string[] = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'DOTNET_STARTUP_HOOKS'
];
export const SETTING_PREFIXES_THAT_RUN: readonly string[] = ['NPM_CONFIG_', 'UV_', 'PIP_', 'COR_', 'CORECLR_'];

export function changesWhatRuns(name: string): boolean {
  const up = name.toUpperCase();
  return SETTINGS_THAT_RUN.includes(up) || SETTING_PREFIXES_THAT_RUN.some(p => up.startsWith(p));
}

/** A setup id or address id: ASCII letters, digits, `-` and `_`, up to 64. */
export function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** A setting or secret name: ASCII letters, digits, `_`, `-` and `.`, not starting with a digit, up to 128. */
export function validName(name: string): boolean {
  return name.length <= MAX_NAME && /^[A-Za-z_.-][A-Za-z0-9_.-]*$/.test(name);
}

/** Legacy SSE isn't taken in v1: its server names the URL for its posts itself, so its approval would have
    to cover more than one address. */
export const SSE_WORDS = "This server uses an older connection (SSE) that Familiar doesn't support yet. If it also offers Streamable HTTP, use that address.";

/** Request headers the guarded fetch drops, so a setup may not rely on them. */
const DROPPED_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect', 'cookie'];
/** Header names that look like they carry a key. */
const KEY_LIKE = /key|token|secret|auth|password|passwd|credential|session|cookie/i;

/** Whether a header name looks like it carries a key. */
export function keyLike(name: string): boolean {
  return KEY_LIKE.test(name);
}

/** Whether a setting's name looks like a credential: those are only ever secrets. */
const CREDENTIAL_LIKE = /key|token|secret|auth|passw|pwd|passphrase|credential|session|cookie|private/i;
export function credentialLike(name: string): boolean {
  return CREDENTIAL_LIKE.test(name);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Whether a value holds a marker, starts with the end of one, or ends with the start of one, as the
    exe refuses (secret.rs). */
export function touchesAMarker(value: string): boolean {
  return ['[key]', '[hidden]'].some(m => {
    if (value.includes(m)) return true;
    for (let k = 1; k <= m.length; k++) if (value.startsWith(m.slice(m.length - k)) || value.endsWith(m.slice(0, k))) return true;
    return false;
  });
}

/** What's wrong with a secret value, in the exe's terms (5a), or undefined. */
export function secretValueProblem(name: string, value: string): string | undefined {
  const n = bytes(value);
  if (n < SECRET_MIN_BYTES) return `${name} is shorter than ${SECRET_MIN_BYTES} characters. Familiar keeps a secret only from ${SECRET_MIN_BYTES} characters, and never shows one as a plain setting, so it can't take this value.`;
  if (n > SECRET_MAX_BYTES) return `${name} is longer than ${SECRET_MAX_BYTES} bytes, too long to keep as a secret.`;
  if (CONTROL.test(value)) return `${name} holds a line break or another control character.`;
  if (touchesAMarker(value)) return `${name} holds part of a marker Familiar uses for blanked text ([key] or [hidden]), so it can't be kept as a secret.`;
  return undefined;
}

/** Every problem with a setup, in plain words. Empty when the exe would take it. */
export function setupProblems(setup: ServerSetup, paths: PathRules = windowsPaths): string[] {
  const p: string[] = [];
  if (!validId(setup.id)) p.push('The setup id must be 1 to 64 letters, digits, - or _.');
  const label = setup.label.trim();
  if (!label) p.push('Give the server a name.');
  else if (label.length > MAX_LABEL) p.push(`The server's name is longer than ${MAX_LABEL} characters.`);
  if (CONTROL.test(setup.label)) p.push("The server's name holds a control character.");
  return setup.kind === 'local' ? [...p, ...localProblems(setup, paths)] : [...p, ...remoteProblems(setup)];
}

function localProblems(s: LocalSetup, paths: PathRules): string[] {
  const p: string[] = [];
  if (!s.program.trim()) p.push('Give the program to start, such as npx or uvx.');
  else {
    const bad = paths.program(s.program);
    if (bad) p.push(bad);
  }
  if (!s.cwd.trim()) p.push('Choose the folder it runs in.');
  else {
    const bad = paths.folder(s.cwd);
    if (bad) p.push(bad);
  }
  if (s.args.length > MAX_ARGS) p.push(`It has ${s.args.length} arguments. Familiar takes at most ${MAX_ARGS}.`);
  if (s.env.length > MAX_SETTINGS) p.push(`It has ${s.env.length} plain settings. Familiar takes at most ${MAX_SETTINGS}.`);
  if (s.secrets.length > MAX_SECRETS) p.push(`It has ${s.secrets.length} secrets. Familiar takes at most ${MAX_SECRETS}.`);
  if (s.args.some(a => /[\0\r\n]/.test(a))) p.push('An argument holds a line break or a NUL character, which Familiar never passes on.');
  const seen = new Map<string, number>();
  for (const [name, value] of s.env) {
    if (!validName(name)) p.push(`"${name}" isn't a setting name Familiar takes: use letters, digits, _, - and ., not starting with a digit.`);
    else if (credentialLike(name)) p.push(changesWhatRuns(name)
      ? `${name} looks like a key or password, but it also changes what runs, so it can be neither a secret nor a plain setting. Familiar can't take it.`
      : `${name} looks like a key or password, so Familiar keeps it only as a secret, never as a plain setting shown in the approval.`);
    if (value.includes('\0')) p.push(`${name} holds a NUL character.`);
    seen.set(name.toUpperCase(), (seen.get(name.toUpperCase()) ?? 0) + 1);
  }
  for (const name of s.secrets) {
    if (!validName(name)) p.push(`"${name}" isn't a setting name Familiar takes: use letters, digits, _, - and ., not starting with a digit.`);
    else if (changesWhatRuns(name)) p.push(`${name} changes what runs, so it can't be kept as a secret. Make it a plain setting.`);
    seen.set(name.toUpperCase(), (seen.get(name.toUpperCase()) ?? 0) + 1);
  }
  for (const [name, count] of seen) if (count > 1) p.push(`${name} is set more than once (names are compared ignoring case).`);
  if (bytes(JSON.stringify(processSetupOf(s))) > MAX_SETUP_BYTES) p.push('The setup is larger than 8 KiB, more than Familiar can show in its approval.');
  return p;
}

function remoteProblems(s: RemoteSetup): string[] {
  const p: string[] = [];
  if (s.transport === 'sse') p.push(SSE_WORDS);
  p.push(...urlProblems(s.url));
  if (s.headers.length > MAX_HEADERS) p.push(`It has ${s.headers.length} headers. Familiar takes at most ${MAX_HEADERS}.`);
  const names = new Set<string>();
  for (const [name, value] of s.headers) {
    const low = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) p.push(`"${name}" isn't a header name.`);
    else if (DROPPED_HEADERS.includes(low) || low.startsWith('proxy-')) p.push(`Familiar doesn't send the ${name} header.`);
    else if (reservedHeader(low)) p.push(`The ${name} header is Familiar's own to set, so a setup can't give it.`);
    else if (KEY_HEADERS.includes(low) || keyLike(name)) p.push(`The ${name} header looks like it carries a key. Familiar keeps a server's key in Credential Manager, in one of these headers only: Authorization, X-API-Key, Api-Key or X-Goog-Api-Key.`);
    if (/[\0\r\n]/.test(value)) p.push(`The ${name} header holds a line break.`);
    if (bytes(value) > MAX_HEADER_BYTES) p.push(`The ${name} header is larger than 8 KiB.`);
    if (names.has(low)) p.push(`The ${name} header is set more than once.`);
    names.add(low);
  }
  if (s.key && !KEY_HEADERS.includes(s.key.header.toLowerCase())) p.push('Familiar can send a key only in Authorization, X-API-Key, Api-Key or X-Goog-Api-Key.');
  if (s.key && names.has(s.key.header.toLowerCase())) p.push(`The ${s.key.header} header is set more than once.`);
  if (s.key && /[\0\r\n]/.test(s.key.prefix)) p.push('The key header holds a line break.');
  return p;
}

/** What's wrong with a remote server's address, as the exe would refuse it, or nothing. */
export function urlProblems(raw: string): string[] {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return ["That isn't a web address. It should start with https://."];
  }
  const p: string[] = [];
  if (u.protocol !== 'https:' && u.protocol !== 'http:') p.push('The address must start with https://.');
  if (u.username || u.password) p.push('The address carries a user name or password, which Familiar won\'t keep in an address. Put a key in a header instead.');
  if (u.search || raw.includes('?')) p.push("The address carries a query (after ?), which Familiar won't keep. If it holds a key, put the key in a header instead.");
  if (u.hash || raw.includes('#')) p.push('The address carries a # part, which Familiar won\'t keep.');
  if (/%2e|%2f|%5c/i.test(u.pathname)) p.push('The address path holds an encoded dot or slash, which Familiar refuses.');
  const reach = literalClass(u.hostname);
  if (reach === 'refused') p.push('Familiar never sends to that address.');
  else if (u.protocol === 'http:' && reach === 'public') p.push('The address must use https, unless it is on this PC or your own network.');
  return p;
}

/** The local setup as the exe's `server_start` takes it. */
export function processSetupOf(s: LocalSetup): ProcessSetup {
  return { id: s.id, label: s.label, program: s.program, args: [...s.args], cwd: s.cwd, env: s.env.map(([k, v]) => [k, v] as const), secrets: [...s.secrets] };
}

export function remoteTargetOf(s: RemoteSetup): RemoteTarget {
  return { url: s.url, transport: s.transport, headers: s.headers, ...(s.key ? { key: s.key } : {}) };
}

/** The refs of a setup's secrets in Credential Manager. A remote server's key is `addr:<address>`. */
export function secretRefs(s: ServerSetup): string[] {
  if (s.kind === 'local') return s.secrets.map(n => `server:${s.id}:${n}`);
  return s.key && s.address ? [`addr:${s.address}`] : [];
}

/**
 * What "always for this" binds to: the command, arguments, folder and plain settings with the secret
 * names, or the address with its transport, headers, and where its key goes (the header and the prefix
 * before the key). A new command, address, key prefix or version changes it,
 * and every tool of the server goes back to ask. Secret values aren't in it, so a renewed key asks
 * nothing.
 */
export function setupFingerprint(s: ServerSetup): string {
  const bound = s.kind === 'local'
    ? { kind: 'local', program: s.program, args: s.args, cwd: s.cwd, env: [...s.env].map(([k, v]) => [k.toUpperCase(), v]).sort(), secrets: [...s.secrets].map(n => n.toUpperCase()).sort() }
    : { kind: 'remote', url: s.url, transport: s.transport, headers: [...s.headers].map(([k, v]) => [k.toLowerCase(), v]).sort(), key: s.key ? { header: s.key.header.toLowerCase(), prefix: s.key.prefix } : null, address: s.address ?? null };
  return sha256(canonicalJson(bound));
}
