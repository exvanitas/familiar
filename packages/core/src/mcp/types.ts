// The shapes the MCP client's parts share.

/** A tool as the server listed it, checked against core's bounds. Everything in it but the fingerprint
    is the server's word. */
export interface ListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** MCP's `readOnlyHint`: shown, never trusted. */
  readonly readOnlyHint?: boolean;
  /** Core's fingerprint of what the model and the person see of it: its name, its effective description
      and its input schema. */
  readonly fingerprint: string;
}

export type FailureKind =
  /** The program wasn't found (Node.js, uv or Docker may be missing). */
  | 'not-found'
  /** The person said no in the exe's dialog, or the exe stopped asking after three refusals. */
  | 'declined'
  /** The exe refused the setup: a path, argument, setting or secret it doesn't allow. */
  | 'refused'
  /** The exe or the guarded fetch was busy. */
  | 'busy'
  /** The program exited, or the remote connection closed. */
  | 'exited'
  | 'timed-out'
  /** A remote server answered with an HTTP error, or its address isn't saved or has no key. */
  | 'http'
  | 'network'
  /** It isn't an MCP server, or it broke the protocol. */
  | 'protocol'
  | 'failed';

/** Why something didn't work, in plain words a person can act on. */
export interface Failure {
  readonly kind: FailureKind;
  readonly words: string;
  /** The server's last output, already blanked of its secrets, bounded. */
  readonly lastOutput?: string;
}

/** How a call ended. Exactly one of these reaches each caller. */
export type CallOutcome =
  /** The server answered. A tool error is an answer too. The text is bounded. */
  | { readonly kind: 'result'; readonly text: string; readonly isError: boolean }
  /** It wasn't sent, or the protocol failed. */
  /** `changed`: the tool it was made for isn't what the server offers now, so it wasn't sent. */
  | { readonly kind: 'error'; readonly reason: 'not-running' | 'stopping' | 'removed' | 'busy' | 'down' | 'protocol' | 'changed'; readonly words: string }
  /** The person pressed Stop. */
  | { readonly kind: 'stopped' }
  | { readonly kind: 'timed-out' }
  /** The server crashed or was stopped while it ran. It may have partly run, and it's never sent again. */
  | { readonly kind: 'interrupted' };

/** How a start, stop or remove ended. */
export type Reply =
  | { readonly kind: 'ready' }
  /** A change was saved. */
  | { readonly kind: 'edited' }
  /** The server was added. */
  | { readonly kind: 'added' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'removed' }
  | { readonly kind: 'failed'; readonly failure: Failure }
  | { readonly kind: 'refused'; readonly words: string };
