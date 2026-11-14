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

/* A place data may go, approved by the person in the exe's own dialog. */
export interface Address { id: string; kind: 'model' | 'server' | 'peer'; url: string; label: string; reach: 'public' | 'lan' | 'loopback'; ports?: [number, number] }
export interface AddressSpec { kind: Address['kind']; url: string; label: string; owner?: string; ports?: [number, number] }

/* The guarded fetch's request: `address` is a saved address id, `url` must be under it. */
export interface NetSpec {
  id: string; address: string; url: string; method: string; headers: [string, string][];
  maxBytes?: number; headersMs?: number; idleMs?: number;
}
export interface NetHead { status: number; statusText: string; headers: [string, string][]; url: string; redirected: boolean }
export interface SecretStatus { present: boolean; boundTo: string | null; hint: string | null }

/* What a command rejects with. A refusal by the command gate is a plain string instead:
   "Command <name> not allowed by ACL". */
export interface ShellError {
  kind: 'invalid' | 'refused' | 'missing' | 'failed' | 'busy' | 'asks-stopped' | 'declined' | 'insecure' | 'blocked-address' | 'not-saved';
  message: string;
}

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
  /* Core and Settings. */
  addressList(): Promise<Address[]>;
  /* Core. Asks the person in a native dialog unless an identical address is saved. */
  addressAdd(spec: AddressSpec): Promise<Address>;
  /* Core. Ends the address's open requests and deletes its key. */
  addressRemove(id: string): Promise<void>;
  /* Core. The body goes as raw bytes, the spec in a header. src/net.ts builds fetch on these. */
  netFetch(spec: NetSpec, body: Uint8Array): Promise<NetHead>;
  /* Up to 1 MiB of the body; empty only at the real end. */
  netRead(id: string): Promise<Uint8Array>;
  netCancel(id: string): Promise<void>;
  /* Settings, for `addr:<id>` and `server:<setup>:<NAME>`; core, for a peer's `addr:` only.
     Write-only: no command reads a key back. */
  secretSet(ref: string, value: string): Promise<void>;
  secretStatus(ref: string): Promise<SecretStatus>;
  secretDelete(ref: string): Promise<void>;
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
    windowSelf: op => call('window_self', { op }),
    addressList: () => call<Address[]>('address_list'),
    addressAdd: spec => call<Address>('address_add', { ...spec }),
    addressRemove: id => call('address_remove', { id }),
    netFetch: (spec, body) =>
      internals.invoke('net_fetch', body, { headers: { 'x-spec': encodeURIComponent(JSON.stringify(spec)) } }) as Promise<NetHead>,
    netRead: id => call<ArrayBuffer>('net_read', { id }).then(b => new Uint8Array(b)),
    netCancel: id => call('net_cancel', { id }),
    secretSet: (ref, value) => call('secret_set', { id: ref, value }),
    secretStatus: ref => call<SecretStatus>('secret_status', { id: ref }),
    secretDelete: ref => call('secret_delete', { id: ref })
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
