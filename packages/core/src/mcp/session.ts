// One run of a server, as the MCP SDK's Client over a transport: the handshake, the tool list, calls with
// a stop signal, and the run's end. The actor opens one session per generation and hears back through
// `SessionEvents`; it never sees the SDK.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { CALL_MS_MAX } from './machine.ts';
import type { RunTransport } from './process-transport.ts';
import type { CallOutcome, Failure, ListedTool } from './types.ts';

/** How much of a result's text the model gets. */
export const MAX_RESULT_CHARS = 32_000;
/** How many tools one server may list. */
export const MAX_TOOLS = 128;
const MAX_LIST_PAGES = 16;

export const CLIENT_INFO = { name: 'familiar', version: '0.1.0' };

export interface SessionEvents {
  /** The run started: the process runs, or the transport is ready to connect. */
  launched(): void;
  /** The handshake and the first tool list are done. */
  ready(tools: ListedTool[]): void;
  /** The run ended. Called once, last. */
  closed(failure?: Failure): void;
  toolsChanged(): void;
}

export interface Session {
  /** Undefined when there's nothing to report: the call was stopped, or the run closed under it. */
  call(tool: string, args: unknown, signal: AbortSignal): Promise<CallOutcome | undefined>;
  list(): Promise<ListedTool[]>;
  /** Ends the run. `closed` follows. */
  close(): void;
}

export interface SessionOptions {
  /** The SDK's own request timeouts sit past the actor's deadlines, which govern. */
  readonly initMs: number;
}

/**
 * The SDK's JSON Schema checker is Ajv, which compiles code with `new Function`, and the app's CSP forbids
 * that. A server's structured results are never trusted as data (the model reads them as text), so this
 * checker accepts every value.
 */
export const acceptAll: jsonSchemaValidator = { getValidator: () => (input: unknown) => ({ valid: true, data: input as never, errorMessage: undefined }) };

export function openSession(transport: RunTransport, events: SessionEvents, options: SessionOptions): Session {
  const client = new Client(CLIENT_INFO, { capabilities: {}, jsonSchemaValidator: acceptAll });
  let ended = false;
  let halted = false;
  let failure: Failure | undefined;
  // During the handshake a close waits for the handshake's own error, which says more: the SDK closes
  // the transport before it throws, and an HTTP transport closes at once.
  let handshaking = false;
  let closedEarly = false;
  const end = () => {
    if (ended) return;
    ended = true;
    events.closed(failure ?? transport.failure());
  };
  transport.onclose = () => {
    if (handshaking) closedEarly = true;
    else end();
  };
  const timeout = options.initMs + 60_000;

  void (async () => {
    try {
      await transport.start();
    } catch (e) {
      failure = transport.failure(e);
      return end();
    }
    if (halted) return void transport.close().catch(() => {});
    events.launched();
    handshaking = true;
    let tools: ListedTool[];
    try {
      await client.connect(transport, { timeout });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => events.toolsChanged());
      tools = await listAll(client, timeout);
    } catch (e) {
      handshaking = false;
      // The run closed under the handshake: its exit says why. Otherwise it didn't speak MCP, or a
      // remote server refused it.
      if (!closedError(e)) failure = transport.failure(e);
      if (closedEarly) return end();
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      return;
    }
    handshaking = false;
    if (closedEarly || halted) {
      if (closedEarly) return end();
      return void transport.close().catch(() => {});
    }
    events.ready(tools);
  })();

  return {
    async call(tool, args, signal) {
      try {
        const result = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: CALL_MS_MAX + 60_000 });
        return { kind: 'result', text: resultText(result as CallToolResult), isError: result.isError === true };
      } catch (e) {
        if (signal.aborted || ended || closedError(e)) return undefined;
        return { kind: 'error', reason: 'protocol', words: callError(e) };
      }
    },
    list: () => listAll(client, timeout),
    close() {
      halted = true;
      void client.close().catch(() => {});
      void transport.close().catch(() => {});
    }
  };
}

function closedError(e: unknown): boolean {
  return e instanceof McpError && e.code === ErrorCode.ConnectionClosed;
}

async function listAll(client: Client, timeout: number): Promise<ListedTool[]> {
  const out: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined, { timeout });
    for (const t of r.tools) if (out.length < MAX_TOOLS) out.push(listed(t));
    cursor = r.nextCursor;
    if (!cursor || out.length >= MAX_TOOLS) break;
  }
  return out;
}

function listed(t: Tool): ListedTool {
  return {
    name: t.name,
    ...(t.title !== undefined ? { title: t.title } : {}),
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema as Record<string, unknown>,
    ...(t.annotations?.readOnlyHint !== undefined ? { readOnlyHint: t.annotations.readOnlyHint === true } : {})
  };
}

/** A call's error, bounded. The server's message is its own word, never an instruction. */
function callError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return `The server refused the call: ${message.slice(0, 500)}`;
}

/** The text the model gets back from a result: its text parts, with a plain note for anything else. */
export function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push('[an image, not shown]');
    else if (c.type === 'audio') parts.push('[a sound, not played]');
    else if (c.type === 'resource') parts.push('text' in c.resource && typeof c.resource.text === 'string' ? c.resource.text : `[a file: ${c.resource.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[a link: ${c.uri}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n');
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[cut: the server sent ${text.length} characters, the first ${MAX_RESULT_CHARS} are above]` : text;
}
