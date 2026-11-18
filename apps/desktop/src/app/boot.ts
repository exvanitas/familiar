/* Restart-only (docs/mcp-design.md 5.3). Core calls shell_ready before it builds anything. The exe
   refuses a second call, which means this page was reloaded inside a running exe: then no owner is built,
   no journal opens or resumes, no tool is installed and no change is accepted, and the page only says
   "Familiar needs a restart". Repair runs only in a fresh exe, where every old native operation ended
   with the old process: after a successful shell_ready, before anything starts. */

export const RESTART_WORDS = 'Familiar needs a restart.';

export type Boot = { readonly ok: true } | { readonly ok: false; readonly words: string };

/** Says ready, then builds; a refused ready builds nothing. */
export async function boot(ready: () => Promise<void>, build: () => Promise<void>, refused: (words: string) => Promise<void> | void): Promise<Boot> {
  try {
    await ready();
  } catch {
    await refused(RESTART_WORDS);
    return { ok: false, words: RESTART_WORDS };
  }
  await build();
  return { ok: true };
}
