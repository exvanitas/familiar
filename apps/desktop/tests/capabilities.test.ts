/* The static half of the command gate and the web surface, on Linux CI every push. It reads the
   capability files, build.rs, the handler list, src/shell.ts, tauri.conf.json and shell-core's
   pinned strings, and fails if they disagree with each other or with docs/shell-design.md. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const at = (p: string) => new URL(`../${p}`, import.meta.url);
// A Windows checkout may have CRLF line ends.
const read = (p: string) => readFileSync(at(p), 'utf8').replace(/\r\n/g, '\n');

interface Capability { identifier: string; description?: string; windows: string[]; webviews?: string[]; permissions: (string | { identifier: string })[]; remote?: unknown; platforms?: unknown }
const capFiles = readdirSync(at('src-tauri/capabilities')).filter(f => f.endsWith('.json'));
const caps: Record<string, Capability> = Object.fromEntries(capFiles.map(f => [f.replace(/\.json$/, ''), JSON.parse(read(`src-tauri/capabilities/${f}`))]));
const perms = (c: Capability) => c.permissions.map(p => (typeof p === 'string' ? p : p.identifier));
const allPerms = Object.values(caps).flatMap(perms);

const buildRs = read('src-tauri/build.rs');
const COMMANDS = [...(/const COMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(buildRs)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
const handlers = (/generate_handler!\[([^\]]*)\]/.exec(read('src-tauri/src/commands.rs'))?.[1] ?? '').split(',').map(s => s.trim().split('::').pop()).filter(Boolean);
const shellTs = read('src/shell.ts');
const clientCalls = [...shellTs.matchAll(/(?:call(?:<[^>]*>)?|internals\.invoke)\('([a-z_:|]+)'/g)].map(m => m[1]);
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const webRs = read('shell-core/src/web.rs');
const constOf = (name: string) => /"(.*)";/.exec(webRs.slice(webRs.indexOf(`pub const ${name}: &str = `)))?.[1] ?? '';
const rustSources = readdirSync(at('src-tauri/src')).filter(f => f.endsWith('.rs')).map(f => [f, read(`src-tauri/src/${f}`)] as const);
const design = readFileSync(new URL('../../../docs/shell-design.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* The design's code block that follows a heading or phrase, joined into one line. */
function designBlock(after: string): string {
  const from = design.indexOf(after);
  const open = design.indexOf('```\n', from);
  const close = design.indexOf('```', open + 4);
  return design.slice(open + 4, close).trim().split('\n').map(l => l.trim()).join(' ');
}

const PINNED_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; worker-src blob:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'";
const PINNED_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --proxy-server=http://127.0.0.1:<sink> --proxy-bypass-list=<-loopback> --force-webrtc-ip-handling-policy=disable_non_proxied_udp --dns-prefetch-disable';

/* What each capability may ever hold, from the design. A round grants a subset: only commands that
   exist. */
const DESIGN_CORE = [
  'core:event:allow-listen', 'core:event:allow-unlisten',
  'notification:allow-notify', 'notification:allow-is-permission-granted', 'notification:allow-register-action-types',
  'notification:allow-register-listener', 'notification:allow-remove-listener',
  'global-shortcut:allow-register', 'global-shortcut:allow-unregister', 'global-shortcut:allow-is-registered',
  'allow-shell-info', 'allow-shell-ready', 'allow-log-line', 'allow-quit', 'allow-quit-ready', 'allow-tray-set',
  'allow-system', 'allow-wake-at', 'allow-view-open', 'allow-window-ctl',
  'allow-address-list', 'allow-address-add', 'allow-address-remove', 'allow-net-fetch', 'allow-net-read', 'allow-net-cancel',
  'allow-secret-status', 'allow-secret-delete', 'allow-server-start', 'allow-server-write', 'allow-server-stop', 'allow-server-forget',
  'allow-pick-path', 'allow-save-as', 'allow-open-url', 'allow-open-folder',
  'allow-backup-write', 'allow-backup-list', 'allow-backup-read', 'allow-backup-delete', 'allow-autostart', 'allow-secret-set',
  'allow-ws-connect', 'allow-ws-send', 'allow-ws-close'
];
const DESIGN_VIEWS = ['core:event:allow-listen', 'core:event:allow-unlisten', 'allow-window-self', 'allow-log-line'];
const DESIGN_SETTINGS = ['allow-window-self', 'allow-log-line', 'allow-secret-set', 'allow-secret-status', 'allow-address-list'];
const toCommand = (perm: string) => perm.replace(/^allow-/, '').replace(/-/g, '_');

describe('the capability files', () => {
  it('are exactly core, views and settings, each for its own windows', () => {
    expect(Object.keys(caps).sort()).toEqual(['core', 'settings', 'views']);
    expect(conf.app.security.capabilities).toEqual(['core', 'views', 'settings']);
    expect(caps.core.windows).toEqual(['core']);
    expect(caps.views.windows).toEqual(['view-*']);
    expect(caps.settings.windows).toEqual(['settings']);
    for (const [name, c] of Object.entries(caps)) {
      expect(c.identifier, name).toBe(name);
      expect(c.remote, `${name} must not reach remote URLs`).toBeUndefined();
      expect(c.webviews, name).toBeUndefined();
    }
  });

  it('grant no window, webview or emit permission to anyone', () => {
    for (const p of allPerms) {
      expect(p, p).not.toMatch(/^core:window:/);
      expect(p, p).not.toMatch(/^core:webview:/);
      expect(p, p).not.toMatch(/emit/);
      expect(p, p).not.toMatch(/:default$/);
      expect(p, p).not.toBe('core:default');
      expect(p, p).not.toMatch(/^(core:)?(app|tray|menu|path|image|resources):/);
    }
  });

  it('hold nothing outside the design, and settings no events', () => {
    for (const p of perms(caps.core)) expect(DESIGN_CORE, p).toContain(p);
    for (const p of perms(caps.views)) expect(DESIGN_VIEWS, p).toContain(p);
    for (const p of perms(caps.settings)) expect(DESIGN_SETTINGS, p).toContain(p);
    expect(perms(caps.settings).filter(p => p.startsWith('core:event'))).toEqual([]);
  });

  it('give each command to the callers the design names', () => {
    expect(perms(caps.views).sort()).toEqual(DESIGN_VIEWS.slice().sort());
    expect(perms(caps.core)).not.toContain('allow-window-self');
    expect(perms(caps.views)).not.toContain('allow-window-ctl');
    expect(perms(caps.settings)).not.toContain('allow-view-open');
  });
});

describe('one inventory', () => {
  it('build.rs declares an app manifest, so app commands are gated', () => {
    expect(buildRs).toMatch(/app_manifest\(tauri_build::AppManifest::new\(\)\.commands\(COMMANDS\)\)/);
    expect(COMMANDS.length).toBeGreaterThan(0);
  });

  it('every command has a capability, and every app permission a command', () => {
    for (const c of COMMANDS) expect(allPerms, c).toContain(`allow-${c.replace(/_/g, '-')}`);
    for (const p of allPerms.filter(p => p.startsWith('allow-'))) expect(COMMANDS, p).toContain(toCommand(p));
  });

  it('the handler list is COMMANDS', () => {
    expect(handlers.slice().sort()).toEqual(COMMANDS.slice().sort());
  });

  it('src/shell.ts calls exactly the commands in COMMANDS, and no plugin command', () => {
    for (const c of clientCalls) expect(COMMANDS, c).toContain(c);
    expect(clientCalls.slice().sort()).toEqual(COMMANDS.slice().sort());
    expect(shellTs).not.toMatch(/plugin:/);
  });
});

describe('the web surface', () => {
  it('the CSP is the pinned one, in the config, in shell-core and in the design', () => {
    expect(conf.app.security.csp).toBe(PINNED_CSP);
    expect(constOf('CSP')).toBe(PINNED_CSP);
    expect(designBlock('**The CSP, pinned in the exe**')).toBe(PINNED_CSP);
    expect(conf.app.security.dangerousDisableAssetCspModification).toBeUndefined();
    expect(conf.app.security.assetProtocol).toBeUndefined();
    expect(conf.app.withGlobalTauri).toBe(false);
  });

  it('the browser arguments are the pinned ones, apart from the sink port', () => {
    expect(constOf('BROWSER_ARGS').replace('{sink}', '<sink>')).toBe(PINNED_ARGS);
    expect(designBlock('The exe closes them with browser arguments')).toBe(PINNED_ARGS);
  });

  it('one helper builds every window, with the pins', () => {
    const builders = rustSources.filter(([, s]) => s.includes('WebviewWindowBuilder::new('));
    expect(builders.map(([f]) => f)).toEqual(['pages.rs']);
    const pages = read('src-tauri/src/pages.rs');
    expect(pages.match(/WebviewWindowBuilder::new\(/g)?.length).toBe(1);
    for (const pin of ['.initialization_script_for_all_frames(NO_WEBRTC)', '.on_download(', '.data_directory(', '.use_https_scheme(false)', '.disable_drag_drop_handler()', '.additional_browser_args(&web::browser_args(', '.on_navigation(', '.on_new_window(', '.on_permission_request(', '.general_autofill_enabled(false)']) {
      expect(pages, pin).toContain(pin);
    }
    expect(read('src-tauri/src/platform.rs')).toMatch(/SetIsPasswordAutosaveEnabled\(false\)/);
    const platform = read('src-tauri/src/platform.rs');
    expect(platform).toMatch(/COREWEBVIEW2_PERMISSION_STATE_DENY/);
    // Persistent storage, kind 13, is the one kind allowed.
    expect(platform).toContain('const PERSISTENT_STORAGE: i32 = 13;');
    expect(platform).toContain('let allow = kind.0 == PERSISTENT_STORAGE;');
    expect(platform.match(/COREWEBVIEW2_PERMISSION_STATE_ALLOW/g)?.length).toBe(2);
  });

  it('a window loads its page only once it is hardened, and goes if hardening fails', () => {
    const pages = read('src-tauri/src/pages.rs');
    expect(pages).toContain('WebviewUrl::External(blank)');
    expect(pages).not.toContain('WebviewUrl::App(');
    // In `harden`: the pins first, then the switch that lets the page load, then the load.
    const body = pages.slice(pages.indexOf('fn harden('), pages.indexOf('pub fn open_core('));
    const [h, armed, nav] = ['platform::harden_webview(', 'armed.store(true', 'platform::navigate('].map(x => body.indexOf(x));
    expect(h).toBeGreaterThan(0);
    expect(armed).toBeGreaterThan(h);
    expect(nav).toBeGreaterThan(armed);
    expect(body).toContain('window.destroy()');
    expect(pages.slice(pages.indexOf('pub fn open_core('))).toContain('std::process::exit(1)');
    expect(read('src-tauri/src/platform.rs')).toMatch(/add_DownloadStarting[\s\S]*SetCancel\(true\)/);
  });

  it('every frame loses WebRTC before page script runs', () => {
    const script = read('src-tauri/src/no-webrtc.js');
    expect(read('src-tauri/src/pages.rs')).toContain('include_str!("no-webrtc.js")');
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCCertificate']) {
      expect(script, name).toContain(`'${name}'`);
    }
  });

  it('the exe never emits a Tauri event', () => {
    for (const [f, s] of rustSources) {
      expect(s, f).not.toMatch(/\.emit(_to|_filter)?\(/);
      expect(s, f).not.toMatch(/\bEmitter\b/);
    }
  });

  it('the identifier is the pinned one', () => {
    expect(conf.identifier).toBe('dev.exvanitas.familiar');
    expect(read('shell-core/src/identity.rs')).toContain('pub const IDENTIFIER: &str = "dev.exvanitas.familiar";');
    expect(conf.mainBinaryName).toBe('familiar');
  });
});
