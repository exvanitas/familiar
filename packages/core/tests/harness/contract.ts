// The exe's contract as docs/mcp-design.md section 4 states it, for the checks to judge by. The fake exe
// keeps its own numbers and never imports these, so a wrong number in the fake can't pass its own check.

/** net_cancel returns within this of the cancel, whatever a helper does (4.1, item 1). */
export const CONTRACT_DETACH_MS = 1_000;
/** Server requests may hold at most this many of the 32 (4.1, item 2). */
export const CONTRACT_SERVER_CAP = 24;
/** Past this many detached server helpers, new server fetches get busy (4.1, item 1). */
export const CONTRACT_DETACHED_SERVER_HELPERS = 8;
/** The page's interim bound on a local write until the exe's own lands (4.3). */
export const CONTRACT_INTERIM_WRITE_MS = 10_000;
