// Plain words for everything that can go wrong with a server, for Test, the matrix and the model. Every
// failure says what happened and, where there's one, what to do. The exe's and the guarded fetch's
// error kinds map here; their messages never carry a key or a server's output.

import { kindOf } from './process.ts';
import type { Failure } from './types.ts';

const NODE = "Node.js isn't installed, or Familiar can't find it. Get the LTS from nodejs.org, then press Test again.";
const UV = "Python's uv isn't installed, or Familiar can't find it. Install it from docs.astral.sh/uv, then press Test again.";
const DOCKER = "Docker isn't installed, or Familiar can't find it. Install Docker Desktop and start it, then press Test again.";

/** What to install for a program that wasn't found, by its name. */
export function missingProgram(program: string): string {
  const name = (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (name === 'npx' || name === 'node' || name === 'npm' || name === 'pnpm' || name === 'bunx' || name === 'bun') return NODE;
  if (name === 'uvx' || name === 'uv' || name === 'python' || name === 'python3') return UV;
  if (name === 'docker') return DOCKER;
  return 'Check the program name, or give its full path.';
}

const START: Record<string, string> = {
  declined: 'You chose not to start it.',
  'asks-stopped': 'Familiar stopped asking after three refusals. Pick "Let Familiar ask again" in the tray menu, then try again.',
  busy: 'Familiar is busy with another start or question. Try again in a moment.',
  'unsafe-path': "Familiar won't start a program or folder on a network share, behind a link that leads off this PC, or with an unusual path.",
  'unsafe-argument': 'An argument holds a line break or a NUL character, which Familiar never passes on.',
  'duplicate-setting': 'Two settings have the same name, ignoring case.',
  'unsafe-secret': "A setting that changes what runs, such as PATH or NODE_OPTIONS, can't be kept as a secret. Make it a plain setting.",
  'start-failed': "Windows couldn't start the program.",
  revoked: 'The server was removed while it was starting.',
  invalid: "Familiar can't use this setup as it is."
};

const KIND: Record<string, Failure['kind']> = {
  declined: 'declined', 'asks-stopped': 'declined', busy: 'busy', 'not-found': 'not-found', revoked: 'failed', 'start-failed': 'failed',
  'unsafe-path': 'refused', 'unsafe-argument': 'refused', 'duplicate-setting': 'refused', 'unsafe-secret': 'refused', invalid: 'refused'
};

/** A refused or failed local start, in plain words. */
export function startFailure(e: unknown, program: string, secrets: readonly string[] = []): Failure {
  const kind = kindOf(e);
  // Fail closed (5.1): a secret the setup names isn't in Credential Manager, so it doesn't start.
  if (kind === 'no-key') return { kind: 'refused', words: `A secret this server needs isn't saved${secrets.length ? ` (${secrets.join(', ')})` : ''}. Type it in Settings, then start it again.` };
  if (kind === 'not-found') return { kind: 'not-found', words: `Familiar couldn't find the program "${program}". ${missingProgram(program)}` };
  if (kind && START[kind]) return { kind: KIND[kind] ?? 'failed', words: START[kind]! };
  return { kind: 'failed', words: "The server couldn't be started." };
}

const NET: Record<string, [Failure['kind'], string]> = {
  'no-key': ['http', "This server's key isn't saved. Type it in Settings."],
  'not-saved': ['http', "This server's address isn't saved any more. Add the server again."],
  revoked: ['http', "This server's address was removed."],
  insecure: ['http', 'The address must use https, unless it is on this PC or your own network.'],
  'blocked-address': ['network', 'The address now leads somewhere Familiar may not send to, such as this PC or your own network.'],
  'redirect-refused': ['http', 'The server sent Familiar somewhere else, outside its saved address.'],
  'too-large': ['http', 'The server sent more than Familiar accepts.'],
  timeout: ['timed-out', "The server didn't answer in time."],
  tls: ['network', "The server's certificate isn't trusted on this PC."],
  network: ['network', "Familiar couldn't reach the server. Check the address and your connection."],
  busy: ['busy', 'Familiar has too many requests open. Try again in a moment.']
};

/** A remote server's failure, from the guarded fetch's error kind or an HTTP status. */
export function remoteFailure(e: unknown): Failure {
  const cause = e instanceof Error && e.cause && typeof e.cause === 'object' ? kindOf(e.cause) : kindOf(e);
  if (cause && NET[cause]) return { kind: NET[cause][0], words: NET[cause][1] };
  const status = httpStatus(e);
  if (status === 401 || status === 403) return { kind: 'http', words: `The server refused the key (HTTP ${status}). Check the key in Settings.` };
  if (status === 404) return { kind: 'http', words: 'Nothing answered at that address (HTTP 404). Check the address.' };
  if (status !== undefined) return { kind: 'http', words: `The server answered with an error (HTTP ${status}).` };
  return { kind: 'network', words: "Familiar couldn't reach the server. Check the address and your connection." };
}

/** The SDK's HTTP errors say "Error POSTing to endpoint (HTTP 401): …". Only the number is read. */
function httpStatus(e: unknown): number | undefined {
  const code = e !== null && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined;
  if (typeof code === 'number' && code >= 400 && code < 600) return code;
  const m = e instanceof Error ? /\(HTTP (\d{3})\)/.exec(e.message) : null;
  return m ? Number(m[1]) : undefined;
}

/** A run that ended on its own. */
export function exitFailure(code: number | null | undefined, lastOutput: string | undefined): Failure {
  const words = code === undefined ? 'The connection to the server closed.' : code === null ? 'The server stopped.' : `The server exited with code ${code}.`;
  return { kind: 'exited', words: lastOutput ? `${words} Its last output is below.` : words, ...(lastOutput ? { lastOutput } : {}) };
}

/** The handshake failed: it didn't speak MCP, or spoke it wrong. */
export function protocolFailure(lastOutput: string | undefined): Failure {
  return { kind: 'protocol', words: "The program started but didn't answer as an MCP server.", ...(lastOutput ? { lastOutput } : {}) };
}
