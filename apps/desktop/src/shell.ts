/* The contract with familiar.exe, typed. This is the only file that touches Tauri's internals.
   Every command here is in COMMANDS in src-tauri/build.rs, and the static test
   (tests/capabilities.test.ts) fails if this file calls one that isn't. See docs/shell-design.md. */

/* The shell API this app knows, and the oldest exe it runs on. */
export const API = 1;
export const MIN_API = 1;

export interface Info {
  api: number;
  version: string;
  /* Every argument the exe got, its own flags included. */
  args: string[];
  dataDir: string;
  webviewDir: string;
  origin: string;
  autostarted: boolean;
}

/* What the exe tells core, over the one channel core hands to `ready`. */
export type CoreMessage =
  | { t: 'tray'; id: string }
  | { t: 'tray-click' }
  | { t: 'second-launch'; args: string[] }
  | { t: 'quitting' };

export interface MenuItem { id?: string; label?: string; checked?: boolean; enabled?: boolean; separator?: boolean; items?: MenuItem[] }
/* `icon` is a .png of the app folder. The exe appends Quit, and ids starting `shell:` are its own. */
export interface TraySpec { tooltip?: string; icon?: string; items?: MenuItem[] }

/* `label` is `settings`, which always gets settings.html, or `view-[a-z0-9-]{1,32}` with a plain
   .html page of the app folder other than core's or Settings'. */
export interface ViewSpec {
  label: string; page?: string; title?: string; width?: number; height?: number;
  decorations?: boolean; transparent?: boolean; alwaysOnTop?: boolean; skipTaskbar?: boolean;
  visible?: boolean; focused?: boolean; focusable?: boolean;
}
export interface Bounds { x: number; y: number; width: number; height: number }
export type CtlOp = 'show' | 'hide' | 'focus' | 'close' | 'get-bounds' | 'set-bounds';
export type SelfOp = 'drag' | 'minimize' | 'toggle-maximize' | 'close';

/* What a command rejects with. A refusal by the command gate is a plain string instead:
   "Command <name> not allowed by ACL". */
export interface ShellError { kind: 'invalid' | 'refused' | 'missing' | 'failed'; message: string }

/* The little of Tauri's injected script this file uses. */
export interface Internals {
  invoke(cmd: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<unknown>;
  transformCallback(f: (data: never) => void, once?: boolean): number;
  unregisterCallback?(id: number): void;
}
declare global { interface Window { __TAURI_INTERNALS__: Internals } }

export interface Shell {
  info(): Promise<Info>;
  /* Core only, once a run: core is up, and `onMessage` hears everything the exe tells it. */
  ready(onMessage: (m: CoreMessage) => void): Promise<void>;
  log(line: string): Promise<void>;
  quit(): Promise<void>;
  /* Core, after `quitting`: its last writes are done. */
  quitReady(): Promise<void>;
  traySet(spec: TraySpec): Promise<void>;
  viewOpen(spec: ViewSpec): Promise<void>;
  /* Core, on Settings or a view. `get-bounds` answers with the bounds, the rest with null. */
  windowCtl(label: string, op: CtlOp, bounds?: Bounds): Promise<Bounds | null>;
  /* Views and Settings, on their own window. */
  windowSelf(op: SelfOp): Promise<void>;
}

/* A channel's messages come numbered and can arrive out of order. This hands them on in order, as
   Tauri's own client does. */
export function channel<T>(internals: Internals, onMessage: (m: T) => void): { toJSON(): string } {
  let next = 0, end: number | undefined;
  const waiting = new Map<number, T>();
  let id = 0;
  const done = () => internals.unregisterCallback?.(id);
  id = internals.transformCallback((raw: { index: number; message?: T; end?: true }) => {
    if (raw.end) {
      if (raw.index === next) done(); else end = raw.index;
      return;
    }
    waiting.set(raw.index, raw.message as T);
    while (waiting.has(next)) {
      const m = waiting.get(next) as T;
      waiting.delete(next);
      next++;
      onMessage(m);
    }
    if (next === end) done();
  });
  return { toJSON: () => `__CHANNEL__:${id}` };
}

export function createShell(internals: Internals = window.__TAURI_INTERNALS__): Shell {
  const call = <T = void>(cmd: string, args?: object) => internals.invoke(cmd, args) as Promise<T>;
  return {
    info: () => call<Info>('shell_info'),
    ready: onMessage => call('shell_ready', { channel: channel<CoreMessage>(internals, onMessage) }),
    log: line => call('log_line', { line }),
    quit: () => call('quit'),
    quitReady: () => call('quit_ready'),
    traySet: spec => call('tray_set', { spec }),
    viewOpen: spec => call('view_open', { spec }),
    windowCtl: (label, op, bounds) => call<Bounds | null>('window_ctl', { label, op, bounds }),
    windowSelf: op => call('window_self', { op })
  };
}

/* A rejection's text, whichever shape it came in. */
export function reason(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const kind = 'kind' in e ? `${String((e as ShellError).kind)}: ` : '';
    return kind + String((e as { message: unknown }).message);
  }
  return String(e);
}
