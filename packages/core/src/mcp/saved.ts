// The parts of a saved server's record the owner (owner.ts) keeps beside its setup: the tools last seen,
// with whether the person reviewed each, and the server's own limits.



export interface SavedTool {
  readonly name: string;
  /** The fingerprint last seen. */
  readonly fingerprint: string;
  /** The fingerprint the person last reviewed (saw its name and description), if any. The tool is
      fresh, new or changed, whenever this differs from the one last seen. */
  readonly reviewed?: string;
}

export const fresh = (t: SavedTool | undefined, fingerprint: string) => t?.reviewed !== fingerprint;

export interface ServerLimits {
  /** A call's deadline, ms. */
  readonly callMs?: number;
  /** The handshake's deadline, ms. */
  readonly initMs?: number;
}
