// An MCP SDK transport over the process port: newline-delimited JSON-RPC on the server's stdin and
// stdout, as MCP's stdio transport says. The SDK's own stdio transport needs Node, so this replaces it.
// stderr, and stdout lines that aren't JSON-RPC, are kept as the last output.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { LastOutput } from './last-output.ts';
import type { ProcessEvent, ProcessPort, ProcessSetup } from './process.ts';
import type { Failure } from './types.ts';
import { exitFailure, protocolFailure, startFailure } from './words.ts';

/** A transport that can say why it ended, for the session. */
export interface RunTransport extends Transport {
  /** Why the run ended or failed: an exit with its last output, a refused start, an HTTP error. */
  failure(error?: unknown): Failure;
  /** Bounded, blanked last output, if any. */
  lastOutput(): string | undefined;
}

export class ProcessTransport implements RunTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private run: string | undefined;
  private starting: Promise<void> | undefined;
  private closing = false;
  private exited = false;
  private code: number | null | undefined;
  private refused: Failure | undefined;
  private notified = false;
  private readonly last = new LastOutput();
  private readonly encoder = new TextEncoder();

  private readonly port: ProcessPort;
  private readonly setup: ProcessSetup;

  constructor(port: ProcessPort, setup: ProcessSetup) {
    this.port = port;
    this.setup = setup;
  }

  /** Starts the run. The SDK calls it again on connect, which changes nothing. */
  start(): Promise<void> {
    this.starting ??= this.port.start(this.setup, e => this.event(e)).then(
      ({ run }) => {
        this.run = run;
        // Closed while the exe was still starting it (or asking the person): stop it now.
        if (this.closing && !this.exited) void this.port.stop(run).catch(() => {});
        if (this.exited) this.closed();
      },
      (e: unknown) => {
        this.refused = startFailure(e, this.setup.program);
        this.exited = true;
        throw e;
      }
    );
    return this.starting;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.run === undefined || this.exited) throw new Error('The server is not running.');
    await this.port.write(this.run, this.encoder.encode(`${JSON.stringify(message)}\n`));
  }

  /** Asks the run to end. `onclose` follows its exit. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.run !== undefined && !this.exited) await this.port.stop(this.run).catch(() => {});
  }

  /** With an error and a run still going, the program didn't speak MCP. */
  failure(error?: unknown): Failure {
    if (this.refused) return this.refused;
    if (error !== undefined && !this.exited) return protocolFailure(this.last.text());
    return exitFailure(this.code, this.last.text());
  }

  lastOutput(): string | undefined {
    return this.last.text();
  }

  private event(e: ProcessEvent): void {
    if (this.exited) return;
    if (e.t === 'exit') {
      this.exited = true;
      this.code = e.code;
      // An exit can arrive before the start's answer does; it closes once the run is known.
      if (this.run !== undefined) this.closed();
      return;
    }
    if (e.t === 'err') return this.last.push(e.line);
    const message = parse(e.line);
    if (message) this.onmessage?.(message);
    else if (e.line.trim()) this.last.push(e.line);
  }

  private closed(): void {
    if (this.notified) return;
    this.notified = true;
    this.onclose?.();
  }
}

function parse(line: string): JSONRPCMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const r = JSONRPCMessageSchema.safeParse(value);
  return r.success ? r.data : undefined;
}
