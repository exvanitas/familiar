// Outside-content provenance, by construction (docs/mcp-design.md 5.6). Every message the model can see
// carries its own sources, written in the commit that writes it; a request's sources are the union over
// the messages it actually sends, plus the server of every unreviewed tool description it offers. A
// message whose sources weren't recorded counts as outside. Nothing here reads the journal's history: it
// is handed pi-durable's own context for the request.

/** Where a reply, or her line's note, keeps its sources: stored with the message, never sent anywhere. */
export const SOURCES_FIELD = 'familiarSources';

/** The source a message with no recorded sources stands for: outside, since nothing says otherwise. */
export const UNRECORDED = 'unrecorded';

/**
 * How pi-durable 1.5.2 wraps a compaction summary into the user message it places (its compaction task,
 * spec 5358-5360). The summary entry can carry no field of Familiar's, so its sources are the summarized
 * set the beforeCompact hook keeps. A person's message that happens to start this way counts as a summary
 * too, which only ever adds sources.
 */
export const SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following summary:';

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('') : '';

/** A server tool's name is `key__tool` (5.9): the namespace is server tools' alone. */
export const serverOf = (toolName: string): string | undefined => (toolName.includes('__') ? `server:${toolName.slice(0, toolName.indexOf('__'))}` : undefined);

const listed = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((s) => typeof s === 'string') ? value : undefined);

/**
 * The sources of each message pi-durable hands the provider, by kind (5.6):
 * - a reply: its own `familiarSources`, the sources of the request that made it;
 * - a server tool's result: its server; a built-in's: `details.sources`, what the tool read;
 * - her line's note: its `familiarSources`;
 * - a compaction summary: the summarized set (`summarized`, undefined when no hook ever recorded one);
 * - the person's own message, and the system messages (Familiar's instructions and tool list): none.
 * Missing, anywhere it should be: `unrecorded`. A reply a crash or a stop cut off isn't sent, so it isn't
 * counted (toModelRequest skips it the same way).
 */
export function messageSources(messages: readonly any[], summarized: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  const add = (list: readonly string[] | undefined) => {
    if (!list) out.add(UNRECORDED);
    else for (const s of list) out.add(s);
  };
  for (const m of messages) {
    if (m?.role === 'assistant') {
      if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
      add(listed(m[SOURCES_FIELD]));
    } else if (m?.role === 'toolResult') {
      const server = serverOf(String(m.toolName ?? ''));
      if (server) out.add(server);
      else add(listed(m.details?.sources));
    } else if (m?.role === 'user') {
      if (SOURCES_FIELD in m) add(listed(m[SOURCES_FIELD]));
      else if (textOf(m.content).startsWith(SUMMARY_PREFIX)) add(summarized);
    } else if (m?.role === 'system') {
      // pi-durable's system messages: Familiar's own instructions, and the tool list, whose unreviewed
      // descriptions the request's caller adds from the tools the request offers (only the current list is
      // sent; toModelRequest reads it as pi-ai does).
      continue;
    } else {
      // A kind this rule doesn't know: outside.
      out.add(UNRECORDED);
    }
  }
  return [...out].sort();
}
