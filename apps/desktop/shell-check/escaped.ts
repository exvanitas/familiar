/* security.mcp.secret-json-escaped's body, over any client and any record of what core heard, so a Node
   test can run it as a positive control (tests/escaped-control.test.ts). It measures before it judges:
   the server must be Ready, hold the key the driver typed (secret_shape says its length and quote, never
   the value), and print_secret's reply line must reach what the check reads. Only then does a copy of the
   key in what came back fail it, with exactly the known gap's words. Every other failure has other words. */
import type { McpClient } from '@familiar/core';
import { callWithYes } from '@familiar/core/testing';

export interface TypedKey {
  readonly head: string;
  readonly tail: string;
  readonly length: number;
}

/** The detail this check fails with while its known gap is open, as its mark in security-inventory.json
    expects. */
export const ESCAPED_GAP = 'an escaped copy came back';

export class EscapedFailure extends Error {}

const failWith = (words: string): never => {
  throw new EscapedFailure(words);
};

export async function escapedCopyCheck(client: McpClient, heard: readonly string[], serverId: string, typed: TypedKey, sleep: (ms: number) => Promise<void>): Promise<string> {
  const started = await client.start(serverId);
  if (started.kind !== 'ready') failWith(`the quoted-key server didn't start: ${JSON.stringify(started).slice(0, 160)}`);
  // The server holds the key the driver typed: its length, and its quote.
  const shape = await callWithYes(client, serverId, 'secret_shape', {});
  const want = `length=${typed.length} quote=true`;
  if (shape.kind !== 'result' || shape.text !== want) failWith(`the server holds another key than the one typed: ${JSON.stringify(shape).slice(0, 160)}, not ${want}`);
  const from = heard.length;
  const r = await callWithYes(client, serverId, 'print_secret', {});
  if (r.kind !== 'result' || !r.text.startsWith('The secret is ')) failWith(`print_secret didn't answer: ${JSON.stringify(r).slice(0, 160)}`);
  await sleep(300);
  const after = heard.slice(from);
  // The reply line itself reached what this check reads.
  const replied = after.some((line) => {
    try {
      const m = JSON.parse(line);
      return m && 'result' in m && Array.isArray(m.result?.content) && String(m.result.content[0]?.text ?? '').startsWith('The secret is ');
    } catch {
      return false;
    }
  });
  if (!replied) failWith("print_secret's reply line never reached what the check reads");
  const text = (r as { text: string }).text;
  const literal = text.includes(typed.head) && text.includes(typed.tail);
  if (!literal && text !== 'The secret is [hidden].') failWith(`print_secret's answer is neither the key nor [hidden]: ${JSON.stringify(text.slice(0, 80))}`);
  const leaked = [JSON.stringify(r), ...after].filter((t) => t.includes(typed.head) || t.includes(typed.tail)).length;
  if (leaked) failWith(`${ESCAPED_GAP}: in ${leaked} texts, unblanked; the pre-release native pass blanks escaped forms`);
  return 'a key holding a quote came back blanked in its JSON-escaped form too';
}
