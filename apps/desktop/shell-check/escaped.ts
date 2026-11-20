/* security.mcp.secret-json-escaped's body, over any client and any record of what core heard, so a Node
   test can run it as a positive control (tests/escaped-control.test.ts). It measures before it judges:
   the server must be Ready, hold the key the driver typed (secret_shape says its length and quote, never
   the value), and print_secret's reply line must reach what the check reads. Only then does a copy of the
   key in what came back fail it, with exactly the known gap's words. Every other failure has other words. */
import type { CallOutcome, McpClient, ProcessEvent, ProcessPort } from '@familiar/core';
import { callWithYes } from '@familiar/core/testing';

/** A line core heard, with the process run and the stream it came on. */
export interface HeardLine {
  run: string;
  readonly stream: 'out' | 'err';
  readonly line: string;
}
/** A line core wrote, with the process run it went to. */
export interface WrittenLine {
  readonly run: string;
  readonly line: string;
}

/** A process port over `inner` that records every line core heard (stdout and stderr apart, per run) and
    every line it wrote, per run. */
export function recording(inner: ProcessPort, heard: HeardLine[], written: WrittenLine[], hear: (e: ProcessEvent) => ProcessEvent = (e) => e): ProcessPort {
  return {
    ...inner,
    start: async (setup, onEvent) => {
      const before: HeardLine[] = [];
      let run = '';
      const started = await inner.start(setup, (e) => {
        e = hear(e);
        if (e.t !== 'exit') {
          const h: HeardLine = { run, stream: e.t, line: e.line };
          if (!run) before.push(h);
          heard.push(h);
        }
        onEvent(e);
      });
      run = started.run;
      for (const h of before) h.run = run;
      return started;
    },
    write: (run, bytes) => {
      written.push({ run, line: new TextDecoder().decode(bytes) });
      return inner.write(run, bytes);
    }
  };
}

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

export async function escapedCopyCheck(client: McpClient, heard: readonly HeardLine[], written: readonly WrittenLine[], serverId: string, typed: TypedKey, sleep: (ms: number) => Promise<void>): Promise<string> {
  const started = await client.start(serverId);
  if (started.kind !== 'ready') failWith(`the quoted-key server didn't start: ${started.kind === 'failed' ? started.failure.kind : started.kind}`);
  // The server holds the key the driver typed: its length, and its quote.
  const shape = await callWithYes(client, serverId, 'secret_shape', {});
  const want = `length=${typed.length} quote=true`;
  if (shape.kind !== 'result') return failWith(`secret_shape didn't answer: ${said(shape, typed)}`);
  if (shape.text !== want) failWith(`the server holds another key than the one typed: ${/^length=\d+ quote=(true|false)$/.test(shape.text) ? shape.text : `${[...shape.text].length} characters`}, not ${want}`);
  const from = heard.length;
  const wrote = written.length;
  const r = await callWithYes(client, serverId, 'print_secret', {});
  if (r.kind !== 'result' || !r.text.startsWith('The secret is ')) failWith(`print_secret didn't answer: ${r.kind === 'result' ? `a result of ${[...r.text].length} characters` : said(r, typed)}`);
  await sleep(300);
  const after = heard.slice(from);
  // The reply line itself reached what this check reads: the response to this very request, by its id, on
  // stdout of the very run the request was written to. A same-id line on stderr, or from another run, isn't it.
  const parse = (line: string) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };
  const request = written.slice(wrote).map((w) => ({ w, m: parse(w.line) })).find(({ m }) => m?.method === 'tools/call' && m.params?.name === 'print_secret');
  const replied = request !== undefined && after.some((h) => {
    if (h.stream !== 'out' || h.run !== request.w.run) return false;
    const m = parse(h.line);
    return m && m.id === request.m.id && 'result' in m && Array.isArray(m.result?.content) && String(m.result.content[0]?.text ?? '').startsWith('The secret is ');
  });
  if (!replied) failWith("print_secret's reply line never reached what the check reads");
  const text = (r as { text: string }).text;
  const literal = text.includes(typed.head) && text.includes(typed.tail);
  // Words here go to the CI log: lengths only, never any of the text, which may hold part of the key.
  if (!literal && text !== 'The secret is [hidden].') failWith(`print_secret's answer is neither the key nor [hidden] (${[...text].length} characters)`);
  const leaked = [JSON.stringify(r), ...after.map((h) => h.line)].filter((t) => t.includes(typed.head) || t.includes(typed.tail)).length;
  if (leaked) failWith(`${ESCAPED_GAP}: in ${leaked} texts, unblanked; the pre-release native pass blanks escaped forms`);
  return 'a key holding a quote came back blanked in its JSON-escaped form too';
}

/** An outcome that isn't a result, for the CI log: its kind and Familiar's words, unless they hold any part
    of the typed key, which never goes to the log. */
function said(o: CallOutcome, typed: TypedKey): string {
  if (o.kind !== 'error') return o.kind;
  const words = `${o.reason}: ${o.words}`;
  return words.includes(typed.head) || words.includes(typed.tail) ? `${o.reason} (its words withheld: they hold part of the key)` : words;
}
