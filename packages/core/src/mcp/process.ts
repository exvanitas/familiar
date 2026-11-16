// The process port: how core starts a local server. In the app it's the exe's server commands
// (apps/desktop/src/mcp.ts); in core's tests it's a Node adapter that spawns the program. Both blank the
// setup's secret values from every line before core sees it, and both run the contract in
// src/testing/process-contract.ts.

/** A local server's launch, exactly as the exe takes it. `env` holds plain settings, `secrets` the names
    of settings kept in Credential Manager as `server:<id>:<NAME>`. */
export interface ProcessSetup {
  readonly id: string;
  readonly label: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: readonly (readonly [string, string])[];
  readonly secrets: readonly string[];
}

export type ProcessEvent =
  | { readonly t: 'out'; readonly line: string }
  | { readonly t: 'err'; readonly line: string }
  | { readonly t: 'exit'; readonly code: number | null };

/** What a refused start or write rejects with: the exe's `{ kind, message }`. */
export interface ProcessError {
  readonly kind: string;
  readonly message: string;
}

export interface ProcessPort {
  /** Starts an approved setup, or asks the person first if it's new or changed. Events come in order:
      lines, then one exit. */
  start(setup: ProcessSetup, onEvent: (e: ProcessEvent) => void): Promise<{ run: string }>;
  /** Bytes to the server's stdin. */
  write(run: string, bytes: Uint8Array): Promise<void>;
  /** Closes stdin, and ends the process soon after. Its exit still arrives as an event. */
  stop(run: string): Promise<void>;
  /** Stops the setup's runs and removes its approval. */
  forget(setupId: string): Promise<void>;
}

/** The error's kind, if it's the exe's `{ kind, message }`. */
export function kindOf(e: unknown): string | undefined {
  return e !== null && typeof e === 'object' && 'kind' in e && typeof (e as ProcessError).kind === 'string' ? (e as ProcessError).kind : undefined;
}
