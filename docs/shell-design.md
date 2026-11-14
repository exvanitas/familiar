# Familiar's native shell

Build step 3. The design for `familiar.exe`, written before any of it is built. Revised once after review, see [Changes after review 1](#changes-after-review-1).

## The rule

**The exe holds general native building blocks and the gates that must not live in a webview. Everything else is the `app` folder beside it.**

Familiar ships unsigned. Each new unsigned exe gets a fresh Smart App Control verdict on a person's PC, and a blocked exe has no "run anyway". App folder changes get no verdict. So the exe settles once and rarely changes after, as Desktop Buddies' did (`docs/native-shell-design.md` in that repo, which this follows wherever it can, and whose proven code it copies). When it settles is a decision for the lead, see [Decisions](#decisions-for-the-lead).

A gate belongs in the exe when a page that went wrong could do lasting harm without it: carry a key away, send data somewhere the person never chose, or start a program. A page goes wrong by a bug in the app, or by script running where it shouldn't. Everything that is a choice, such as which hotkey, what the tray says, when to ask for consent to a tool call, lives in the app.

The exe asks the person itself, in a native Windows dialog, in three places: before a program runs, before a new address joins the list of places data may go, and before a link opens in the browser. Those are the acts a page must not be able to fake or skip. Consent to an MCP tool that writes, opens or sends stays in the app, as consent cards.

## What the exe promises, and what it doesn't

The promises, each with the checks that prove it in [section 7](#7-checks-on-the-windows-runner):

1. **No page reads a key back.** A key goes from Credential Manager only into requests to its own saved address. The one exception is the Settings page while the person enters a key, unless the lead picks native entry ([5a](#5a-credentials)).
2. **Data leaves only to places the person approved natively**: saved addresses through the guarded fetch, saved loopback peers through the WebSocket, and links the person confirmed. This holds once the egress inventory passes on the runner, and not before ([2](#2-windows-capabilities-and-the-web-surface)).
3. **Only approved programs start**, exactly as approved, and they stop with Familiar ([5b](#5b-starting-a-local-mcp-server)).
4. **The origin and data folders never move**, so an update never starts an empty database ([3](#3-origin-and-data-folder-pinned)).

What it doesn't promise:

- **Script running inside a page owns that page's origin.** Every Familiar page shares one origin, so such script can read and change IndexedDB, and can forge messages on the pages' `BroadcastChannel`, consent answers included. The design makes that unlikely (untrusted text is never HTML, and the exe's CSP makes HTML sinks throw), and the native gates bound what such script can do. It can't make it impossible.
- **A key's recipient is trusted.** An endpoint that echoes a key back in another encoding defeats any redaction. Familiar redacts literal copies only.
- **Behind a system proxy, the private-network rule rests on the proxy** ([5c](#5c-the-guarded-fetch)).
- **An approved server is a program running as the person.** Its job object controls when it stops. It isn't a sandbox: the server can do whatever the person can, including editing Familiar's files ([5b](#5b-starting-a-local-mcp-server)).

## Identity, pinned

| | |
| --- | --- |
| Exe | `familiar.exe` |
| Identifier | `dev.exvanitas.familiar` |
| Page origin | `http://tauri.localhost` |
| Native data | `%LOCALAPPDATA%\dev.exvanitas.familiar\` |
| WebView2 data | `%LOCALAPPDATA%\dev.exvanitas.familiar\webview\` |
| Install folder (step 12) | `%LOCALAPPDATA%\Programs\Familiar\`, holding `familiar.exe` and `app\` |
| Shell API | `1`, reported by `shell_info` |

Versions, all exact:

| Crate | Version | Why this one |
| --- | --- | --- |
| `tauri` | `=2.12.5`, features `tray-icon`, `image-png`, `custom-protocol`, `devtools` | Matches Desktop Buddies, proven on the runner |
| `tauri-build` | `=2.7.4` | What 2.12.5 resolves with in Desktop Buddies' lockfile |
| `tauri-plugin-single-instance` | `=2.5.5` | See [Plugins](#4-plugins) |
| `tauri-plugin-notification` | `=2.8.0` | 2.8.1 is four days old. 2.8.0 already shows toast buttons on Windows |
| `tauri-plugin-global-shortcut` | `=2.4.1` | Latest 2.x |
| `keyring` | `=4.2.0`, default `v1` feature | On Windows its v1 mode uses the Windows native store. Step 3 checks the Windows build tree has no other store |
| `reqwest` | `=0.13.5`, default features plus `stream`, `gzip`, `brotli`, `deflate` | rustls and the Windows system proxy are defaults in 0.13 |
| `tokio-tungstenite` | `=0.29.0`, `connect` only, no TLS | The same version Tauri's WebSocket plugin uses |
| `windows` | `0.62`, the copy Tauri already pulls in | Dialogs, registry, shell calls, job objects, session and power notifications |
| Rust toolchain | `1.95.0`, in `rust-toolchain.toml` | The mcp-start spike's |

Every plugin requires `tauri ^2.12`, so all of them fit 2.12.5. `Cargo.lock` is committed and every build uses `--locked`. Whether the locked set builds together is the first thing step 3 proves.

---

## 1. The split

### What lives where

| In the exe | In the app folder |
| --- | --- |
| Serving the app folder, and refusing a missing one | Every page, script, style and image |
| The core window and view windows, each bound to its page, with the pinned origin, data folder, browser arguments and CSP | Which views exist and what they show |
| Navigation off a window's own page refused | Links: when to offer one |
| The native confirms, with one throttle for all of them | What the app asks for, and when |
| Tray icon with an exe-owned Quit | The tray menu's other items, icon and tooltip |
| Single instance, autostart's registry entry, the toast app id | When autostart is on, what a second launch means |
| System state: full screen, idle, lock, sleep and resume, and a native deadline wake | The rules decider, reminders |
| Credential Manager, and redaction | Which endpoints and servers exist |
| The saved-address list | When to add an address |
| The guarded fetch, with key injection | pi-ai, the MCP client, retries, error wording |
| Starting an approved server setup, its job, blanking its secrets | The setup form, the MCP protocol, restarts, time limits, consent cards |
| Native save and pick dialogs, the backup folder's budget | What gets exported, which backups to keep |
| A WebSocket from the exe's own process to saved loopback peers, for part 2 | The hello, pairing and the buddy protocol |

Nothing about storage is in the exe: conversations, memory, reminders and settings are in pi-durable's IndexedDB store, inside the webview.

### How the exe finds and serves the app folder

Desktop Buddies' pattern, copied:

- The app folder is `app\` beside `familiar.exe`, or `--app-dir <path>`.
- `FolderAssets` implements Tauri's `Assets` trait and replaces the embedded assets with `context.set_assets(...)`. Each request's path goes through the plain-names check from Desktop Buddies' `shell_core::paths` (no `..`, no drive letters, no device names, no `:`, no trailing dot or space, both slashes split). The file is read from disk on each request. Nothing from the data folder is served. Card images live in IndexedDB as blobs and show through `blob:` URLs.
- Pages are served at `http://tauri.localhost/<path>`, so they share one fixed local origin and Tauri's IPC treats them as local.
- The exe's own flags: `--app-dir`, `--data-dir` (native data and `webview\` inside it, for tests), `--log`, `--seconds N`, `--devtools`, `--autostart` (added by the Run entry). All raw arguments reach the app through `shell_info`.

### If the folder is missing or broken

- **Missing**, or no `core.html` in it: the exe logs it, shows a native message box ("The app folder is missing or broken. It should sit beside familiar.exe. Looked in: ...") and exits with code 1. No window opens.
- **Broken**, meaning `core.html` loads but core never calls `shell_ready` within 30 s: the exe logs `core not ready`, shows one native message box naming the log file, and keeps the tray with its Quit. It never retries in a loop.
- **Too new**: the app reads `api` from `shell_info`. If the exe is older than the app's `MIN_API`, the app says which Familiar it needs and does nothing else. No field or command an older exe doesn't know is ever sent.
- **No WebView2 Runtime**: window creation fails, and the exe shows a message box that says Familiar needs Microsoft Edge WebView2 Runtime, then exits with code 1. The installer (step 12) checks for it first.

**Tests.** shell-core unit tests for the path check (Desktop Buddies' cases). On the runner: an empty `--app-dir` shows the box and exits 1 (the driver finds the box through UI Automation and closes it), and a `core.html` that throws gets the "not ready" box within 35 s.

---

## 2. Windows, capabilities and the web surface

### Windows

- **`core`**: opened by the exe at start from `core.html`, hidden, no taskbar entry, `focused(false)` and `focusable(false)`, so it never takes the keyboard, at a sign-in start or ever (Desktop Buddies found a hidden window takes the foreground when it opens unless told not to). It runs the agent core for the whole run: the turn loop, pi-durable, reminders, the MCP client. It never draws model text, card text or tool results.
- **Views**, labels `view-<name>`: chat, settings, and whatever the app adds later. A view draws what core publishes and sends requests back over a `BroadcastChannel`, as Desktop Buddies' Manager does. Closing a view loses nothing.

One helper builds every window, because WebView2 windows sharing a data folder must share browser arguments. It always sets the pinned data folder, `use_https_scheme(false)`, `disable_drag_drop_handler()`, the navigation handler and the browser arguments below.

**Each window is bound to its page.** The exe remembers the page each label was opened with (`core.html` for `core`, the `page` given to `view_open` for a view). Navigation to anything else, even another page of the app, is refused. So a label's permissions always go with the page they were meant for: `view-settings` can't be turned into the chat page, and core can't be navigated away.

### The command gate

Tauri 2 checks app commands against capabilities only when the app declares an app manifest. So `build.rs` lists every app command in `COMMANDS`, and a command no capability grants to the calling window is refused with "Command <name> not allowed by ACL" (`tauri-2.12.5/src/webview/mod.rs`, `on_message`). Default deny, by window label. Plugin commands are always checked.

**A capability names the caller, not the target.** Tauri's window commands (`core:window:allow-close` and the rest) take a target label, so a view allowed to close "its" window could close core. So nobody gets any `core:window:*` or `core:webview:*` permission. Window operations go through two native wrappers:

- `window_self(op)`: drag, minimize, toggle maximize, close, on the **calling** window, whose label the exe reads from the IPC request, not from the page's arguments. Views only.
- `window_ctl(label, op)`: show, hide, focus (restoring a minimized one), close, and get or set bounds, on a `view-*` window only. Never `core`. Core only.

**Events carry nothing worth having.** In Tauri 2.12.5 a page listener registered for any target receives events emitted to other windows too (`match_any_or_filter` in `src/event/listener.rs` lets a listener with target `Any` through every filter). So the exe never emits a Tauri event with content. Everything it tells core, such as tray clicks, second launches, system state, wake-ups and quitting, goes over one `Channel` that core hands to `shell_ready`. Server output and WebSocket messages go over their own channels. A channel's messages reach only the page that created it. No page gets `emit` or `emit-to`, so no page can fake an event either.

### Capability files

`capabilities/core.json`:

```json
{
  "identifier": "core",
  "description": "The core window: everything native. No view gets any of this.",
  "windows": ["core"],
  "permissions": [
    "core:event:allow-listen", "core:event:allow-unlisten",
    "notification:allow-notify", "notification:allow-is-permission-granted",
    "notification:allow-register-action-types",
    "notification:allow-register-listener", "notification:allow-remove-listener",
    "global-shortcut:allow-register", "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered",
    "allow-shell-info", "allow-shell-ready", "allow-log-line",
    "allow-quit", "allow-quit-ready", "allow-tray-set",
    "allow-system", "allow-wake-at",
    "allow-view-open", "allow-window-ctl",
    "allow-address-list", "allow-address-add", "allow-address-remove",
    "allow-net-fetch", "allow-net-read", "allow-net-cancel",
    "allow-secret-status", "allow-secret-delete",
    "allow-server-start", "allow-server-write", "allow-server-stop", "allow-server-forget",
    "allow-pick-path", "allow-save-as", "allow-open-url", "allow-open-folder",
    "allow-backup-write", "allow-backup-list", "allow-backup-read", "allow-backup-delete",
    "allow-autostart",
    "allow-secret-set",
    "allow-ws-connect", "allow-ws-send", "allow-ws-close"
  ]
}
```

`capabilities/views.json`:

```json
{
  "identifier": "views",
  "description": "Chat, settings and later views: their own window and the log. Nothing else.",
  "windows": ["view-*"],
  "permissions": [
    "core:event:allow-listen", "core:event:allow-unlisten",
    "allow-window-self", "allow-log-line"
  ]
}
```

`capabilities/settings-keys.json`, with page entry of keys (option B in [5a](#5a-credentials)):

```json
{
  "identifier": "settings-keys",
  "description": "Key entry. Write-only: nothing can read a key back.",
  "windows": ["view-settings"],
  "permissions": ["allow-secret-set", "allow-secret-status"]
}
```

With native entry (option A), this file grants `allow-secret-prompt` and `allow-secret-status` instead, and `secret_set` is left only for core's peer tokens ([5d](#5d-the-rest)).

A view can't open or touch other windows, fetch, start servers, open links, use the WebSocket, notify, register hotkeys, read system state or emit events.

**Why Settings may write keys directly** (a decision for the lead). The other way, sending a pasted key to core first, puts it on the shared `BroadcastChannel`, where every page hears it, the chat view included. Nothing anywhere can read a key back, core included.

### The web surface: what the exe pins

**Untrusted content is never HTML.** Model text, card text and tool results are drawn with DOM calls and `textContent`, including any Markdown the app renders, which it builds element by element. That's the app's rule. The exe makes breaking it fail loudly, with Trusted Types in its CSP: any string assigned to `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`, a script's `src` or text, or passed to `eval` throws.

**The CSP, pinned in the exe** (`app.security.csp` in `tauri.conf.json`, which Tauri sends as a header on every HTML page from `get_asset` in `manager/mod.rs`):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost; worker-src 'self' blob:;
frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
require-trusted-types-for 'script'; trusted-types 'none'
```

- No inline script and no `eval`, so `javascript:` links and injected handlers don't run.
- `trusted-types 'none'` means the app can't make a policy at all, so no HTML sink can ever take a string. A page's own `<meta>` CSP can only add limits, so the app can tighten the rest without an exe, but never loosen this. **Step 3 checks** that Tauri's own injected scripts and the IPC run under it. If one of them needs a sink, the exe allows exactly one named policy instead (`trusted-types tauri`), and the test pins the name.
- Styles are loose on purpose: with the network closed, CSS can't send anything anywhere.

**No sandboxed frame for untrusted rendering. Decided now, because the CSP is in the exe.** A frame with an opaque origin (no IndexedDB, no channel to core) would contain script that got into rendered content. But with no HTML sinks and no inline script, there's no path left for content to become script. The frame would add a second rendering system and a message relay, and that relay would be a new place to forge consent. So `frame-src 'none'` stays. **Residual, honestly:** a bug in the app's own code (not in content), or a compromised dependency, runs as the page and owns the origin, as [above](#what-the-exe-promises-and-what-it-doesnt) says. The native gates still bound it.

**Navigation stays local.** Navigation off a window's own page is refused and logged by scheme only. Unlike Desktop Buddies, nothing is sent on to the browser, because a page could otherwise send data out in a URL with no click. `window.open` is denied the same way. Links go through `open_url`, which asks the person ([5d](#5d-the-rest)).

### Egress outside fetch

CSP governs fetch, WebSocket, images, styles and forms. It doesn't govern WebRTC's ICE traffic (STUN and TURN), and speculative work such as DNS prefetch and preconnect isn't reliably covered either. So the claim that the guarded fetch is the only way out holds only once every route below is closed and tested. The exe closes them with browser arguments, set now in the one window helper:

```
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection
--autoplay-policy=no-user-gesture-required
--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>
--force-webrtc-ip-handling-policy=disable_non_proxied_udp
--dns-prefetch-disable
```

- **A dead proxy for the webview.** Every request the webview's own network stack makes goes to a closed loopback port, so it fails, whatever started it: a beacon, a prefetch, a form, a link's `ping`, a notification icon, anything CSP missed. `<-loopback>` removes Chromium's implicit loopback bypass, so local services are closed too. Familiar's own pages and IPC don't use that stack: `http://tauri.localhost` and `http://ipc.localhost` are answered by WebView2's request interception before any network. The guarded fetch is native and never sees this setting. Step 3 confirms both on the runner.
- **WebRTC** may then only use UDP through a proxy, which Chromium can't do over an HTTP proxy, and TCP through the dead proxy. So it can't reach anything.
- **DNS prefetch** is off, and with a fixed proxy Chromium leaves name resolution to the proxy anyway.
- **SmartScreen** in the webview is off, because pages are only ever local and it would send URLs to Microsoft.
- **Autoplay** is on so a reminder can play a sound, which could not be added later without an exe.
- If the runner shows any route still open, the fallback is an initialization script for every frame that deletes `RTCPeerConnection` and its relatives before page script runs. That's weaker (an `about:blank` frame might keep its own copy), so it's the fallback, not the plan.
- A local program listening on port 9 would receive the webview's stray requests. A program running as the person is outside what Familiar defends against.

**Tests** (all in the security inventory, [7](#7-checks-on-the-windows-runner)):

- **Static, on Linux CI every push** (`apps/desktop/tests/capabilities.test.ts`): parses `capabilities/*.json`, `build.rs` and `tauri.conf.json`. It fails if any capability grants a `core:window:*`, `core:webview:*` or event `emit` permission, if `views.json` or `settings-keys.json` grants anything outside its list, if any capability uses a remote URL, if a command in `COMMANDS` has no capability or the reverse, if the TypeScript client in `src/shell.ts` calls a command not in `COMMANDS`, or if the CSP or browser arguments differ from the pinned strings.
- **The refusal, on the runner**: `view-chat` and `view-settings` call every core-only command and plugin command with valid arguments, and each must reject with `not allowed by ACL`. `view-chat` calls `secret_set` and is refused. Core makes the same calls and each reaches its command.
- **Cross-window**: `view-chat` calls `window_self('close')` and only `view-chat` closes. Core calls `window_ctl('core', ...)` and is refused. A view calling Tauri's own `plugin:window|close` with `label: 'core'` is refused by ACL. A view calling `plugin:event|emit` is refused. A view listening for every event name core uses gets nothing while the driver clicks the tray and makes a second launch. `view-settings` navigating to `chat.html` is refused and stays on its page.
- **Trusted Types**: core and a view each try `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `trustedTypes.createPolicy('x', ...)`. Each must throw, and IPC must still work.
- **Egress**: a hostile page in core and in a view tries every route it can: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, an `<img>`, a CSS `url()`, a web font, `<link rel=prefetch|preconnect|dns-prefetch>`, an `<a ping>` click, a form POST, `window.open`, `location.assign`, a remote `import()`, a service worker registration, a notification with a remote icon, and an `RTCPeerConnection` with STUN and TURN servers. The targets are the driver's listeners on `127.0.0.1` (TCP and UDP, including a STUN responder), a LAN-looking address, and unique random host names. Pass means no listener saw a packet and `Get-DnsClientCache` holds none of the random names afterwards.

---

## 3. Origin and data folder, pinned

### The choices

- **Origin `http://tauri.localhost`.** Tauri's default on Windows, the same as Desktop Buddies. Set explicitly with `use_https_scheme(false)` in the window helper, so a changed default in a future Tauri can't move it. `http://*.localhost` is a secure context in Chromium, so IndexedDB, Web Locks and `navigator.storage` all work. Desktop Buddies has the same origin but its own WebView2 folder, so their storage never meets.
- **WebView2 data folder `%LOCALAPPDATA%\dev.exvanitas.familiar\webview\`**, passed to every window with `data_directory(...)`. WebView2 makes `EBWebView\` inside it, so IndexedDB lands in `webview\EBWebView\Default\IndexedDB\http_tauri.localhost_0.indexeddb.leveldb\`. A named subfolder, rather than Tauri's default of the bare `%LOCALAPPDATA%\<identifier>`, so it never mixes with the exe's own files. With `--data-dir D`, it's `D\webview\`.
- **Native data `%LOCALAPPDATA%\dev.exvanitas.familiar\`**: `shell\` (the saved addresses and approved server setups, written only by the exe), `backups\`, `logs\` (`app.log`, capped at 1 MB with one old file kept, as Desktop Buddies). Local, not roaming: all of it is tied to this PC (local paths, approvals, the addresses keys are bound to), which the design keeps apart from data that could one day sync.
- **The identifier is pinned too**, because both folders are named after it.

### Why it survives updates

The install folder (`%LOCALAPPDATA%\Programs\Familiar\`) and the data folder are siblings under `%LOCALAPPDATA%`, and neither is inside the other. An app folder update replaces files in `app\`. A reinstall over the top and a winget upgrade both run the per-user installer, which replaces the install folder. None of them touch `%LOCALAPPDATA%\dev.exvanitas.familiar\`. A zip run from anywhere uses the same data folder. Uninstall keeps it unless the person ticks the box (step 12). The rule for every later step: nothing Familiar keeps may live in the install folder.

### The pin test

- **shell-core unit test** (Linux CI, every push): `ORIGIN == "http://tauri.localhost"`, `IDENTIFIER == "dev.exvanitas.familiar"`, and `webview_dir(local) == local\dev.exvanitas.familiar\webview`. A comment says that changing any of these empties every person's Familiar.
- **Config test** (Linux CI): `tauri.conf.json`'s `identifier` equals `IDENTIFIER`.
- **On the runner**: core reports `location.origin`, which must equal `ORIGIN`. Core writes a random value to IndexedDB with `durability: 'strict'` and quits. The driver checks the `.indexeddb.leveldb` folder exists at the pinned path. A second launch reads the value back. A third launch, from a copy of the exe and app folder in another directory, reads it too, which is what an install in a new place looks like.

### Persistent storage

At every start, core calls `navigator.storage.persisted()`, and if it's false, `navigator.storage.persist()`. It records `{ at, persisted, granted, quota, usage }` (the last two from `navigator.storage.estimate()`) in its settings and logs `persist granted=<bool>`. Settings shows the answer. If it's false, step 10's rolling backup turns on.

Whether WebView2 grants it is open. Chromium decides `persist()` by heuristics (engagement, an installed app, notification permission), and WebView2 has no permission kind for it that the exe could answer. **Step 3 measures it**: the check app logs both answers and the estimate on a fresh data folder, on a second start, and after core has shown a notification. These are recorded as INFO, not pass or fail, and the result goes into this file. Nothing native depends on the answer, since the backup commands are in the exe either way.

---

## 4. Plugins

| Plugin | Version | For | Permissions, core only |
| --- | --- | --- | --- |
| single instance | `=2.5.5` | A second launch hands its arguments to the first and exits. The exe tells core over its channel | None. Rust only |
| notification | `=2.8.0` | Reminder toasts, with buttons while the toast is on screen | `notify`, `is-permission-granted`, `register-action-types`, `register-listener`, `remove-listener` |
| global shortcut | `=2.4.1` | The hotkey that shows chat | `register`, `unregister`, `is-registered` |

Dropped, each for a reason:

- **autostart plugin**: Desktop Buddies' own Run-key code (`platform::set_autostart`, proven on the runner) is 15 lines on the `windows` crate. The command is `autostart({ on? })`, current user only, and the Run entry carries `--autostart`.
- **dialog plugin**: it would bring a JS surface and the fs plugin. Desktop Buddies' `IFileSaveDialog` code covers saving, the same code with `IFileOpenDialog` covers picking, and `TaskDialogIndirect` covers the confirms. Opening a card or an import file needs no native code: `<input type=file>` works in WebView2.
- **opener plugin**: `open_url` (with its confirm) and `open_folder` (two named folders) are small, their rules live in shell-core where tests reach them, and the plugin can open paths and other schemes if its scope is ever wrong.
- **HTTP plugin**: replaced by the guarded fetch ([5c](#5c-the-guarded-fetch)). Its URL scope is fixed at build time, and the endpoints people type can't be known then, so it would have to allow every `https` URL.
- **WebSocket plugin**: it has no URL scope at all (2.5.0 has only `connect` and `send`), so it would be an open network path around every gate. Replaced by `ws_connect` to saved loopback peers ([5d](#5d-the-rest)).
- **clipboard plugin**: `navigator.clipboard.writeText` works in a secure context after a click. **Step 3 checks it on the runner**: a view writes text after a real click from the driver, and the driver reads the clipboard. Only if that fails does `tauri-plugin-clipboard-manager =2.5.0` go in, with `allow-write-text` alone, for views. Either way it's settled before the exe is.
- **SQL plugin**: out, storage is IndexedDB. **fs and shell plugins**: never.

**Toasts need an app id Windows knows.** The notification plugin sets the toast's AppUserModelID to the identifier when the exe isn't in a `target\` folder. Windows only shows toasts for an unpackaged app whose id it knows, from a Start menu shortcut or from `HKCU\Software\Classes\AppUserModelId\dev.exvanitas.familiar` (`DisplayName`, `IconUri`). The exe writes that key at each start (current user, idempotent), so a zip run works like an install, and the uninstaller removes it. **Step 3 checks** that `ToastNotificationManager.CreateToastNotifier('dev.exvanitas.familiar').Setting` reads `Enabled` from PowerShell after a start. That a toast is really seen, and its buttons, are step 13's, on a real PC.

---

## 5. Native commands

Every command is in `COMMANDS`, takes named arguments, and returns `{ kind, message }` errors with fixed kinds. No error carries a key, a URL's query, a server's output or a file's contents. Bytes go as raw IPC bodies, with the other arguments in a percent-encoded `x-spec` header, as in Desktop Buddies. Rules live in `apps/desktop/shell-core` (plain Rust, no Tauri, `cargo test` on Linux), and `src-tauri` is thin glue. [The inventory](#the-command-inventory) lists every command with its caller.

### The native confirms

Starting a server (5b), adding an address (5c) and opening a link (5d) share one dialog module.

- **What it is**: `TaskDialogIndirect`, owned by the requesting view if it's showing, else top-most with no owner. While it's open, every Familiar window is disabled (`EnableWindow(false)`), so nothing in the app can change behind it.
- **Defaults against reflexes**: the refusing button is the default, so a stray Enter refuses. The approving button is disabled for the first second (enabled from the dialog's timer callback), so a click meant for the chat window can't land on it.
- **One at a time, and one throttle for all**: a second ask while one is open gets `busy`. After any refusal or close, every ask of any kind is refused for 30 s (`declined-recently`), whatever it asks. After three refusals within 10 minutes, the exe stops asking altogether until the person picks "Let Familiar ask again" from an exe-owned tray item. That item is native, so only the person can re-enter. Changing an argument or an address each time doesn't get around it.
- **Showing it honestly**: every shown string has control characters and bidirectional formatting characters (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069) replaced with visible `\u{...}` escapes. Host names show in punycode. Labels are cut to 64 characters with an ellipsis and always appear after the fact they describe, never instead of it. The main text is a summary. The dialog's "Show details" area holds the complete canonical operation, so nothing that runs or sends is hidden.

**Tests** (runner): the driver reads each dialog through UI Automation and checks the default button, the disabled first second, the escaped text and the details area. It sends three refusals in a row and checks the fourth ask is refused without a dialog until it picks the tray item.

### 5a. Credentials

**Choice: keys go into Windows Credential Manager, go out only into requests to their own saved address, and never come back to any page.**

```ts
// option B, page entry (as reviewed)
secret_set(ref: string, value: string): void                   // view-settings only
// option A, native entry
secret_prompt(ref: string, owner?: string): { saved: boolean }  // view-settings only

secret_status(ref: string): { present: boolean, boundTo: string | null }   // core, view-settings
secret_delete(ref: string): void                                // core
```

- `ref` is `addr:<addressId>` for a model endpoint or remote server, or `server:<setupId>:<NAME>` for a local server's setting. Anything else is refused (`invalid`).
- One credential per ref: service `dev.exvanitas.familiar`, user the ref, through `keyring::Entry`. The stored secret is `{"v":1,"for":"<address or setup id>","value":"..."}` as UTF-8 bytes (`set_secret`), under Credential Manager's 2560-byte blob limit.
- **Bound to the address.** For `addr:` refs the exe writes `for` from its own saved-address list, never from the page. A saved address can't be edited: changing it in Settings removes the old entry and adds a new one, which has a new id and no key. So the app asks for the key again, and an old key can never go to a new address. `address_remove` deletes its key.
- **Limits**: a value of 8 to 1024 bytes with no control characters (CR or LF in a key would split a header). Eight is the floor so every secret can be blanked wherever it appears without blanking ordinary text. Refs up to 128 characters.
- **Never written** to files, logs, IndexedDB, exports or errors. There is no read command.

**The placeholder swap, checked: it works.** A throwaway probe on Linux ran pi-ai 1.5.2 with a placeholder as its `apiKey` and an injected fetch that recorded each request, against OpenAI-compatible, Anthropic, Gemini through Google's OpenAI-compatible endpoint, OpenRouter and an LM Studio-style local address. In every case the placeholder appeared in exactly one header and nowhere else:

| Target | Header with the placeholder | In the URL | In the body |
| --- | --- | --- | --- |
| OpenAI-compatible, OpenRouter, LM Studio | `authorization: Bearer <placeholder>` | no | no |
| Gemini through `/v1beta/openai/` | `authorization: Bearer <placeholder>` | no | no |
| Anthropic | `x-api-key: <placeholder>` | no | no |

The SDKs only need a non-empty `apiKey`, so the placeholder satisfies them. The probe also showed what the fetch receives: the URL as a string, the body as a JSON string, and a signal.

How the swap works:

- For every endpoint that has a key, the app passes the fixed placeholder `familiar-stored-key` as pi-ai's `apiKey` option. A keyless local endpoint gets any other non-empty string.
- In `net_fetch`, for a request under saved address A, the exe replaces exact occurrences of the placeholder with A's key, only in the values of `authorization`, `x-api-key`, `api-key` and `x-goog-api-key`. Never in the URL or body.
- The placeholder in one of those headers with no key stored for A is refused as `no-key`, and the app asks for one.
- Remote MCP servers use the same thing for their `Authorization` header.

**Redaction on every path back.** Every literal copy of the key used in a request is replaced with `[key]` before the page sees it: in response header values, and in the body of every response, any status, any size. The body is redacted as it streams, holding back the last `len(key) - 1` bytes of each chunk until the next one arrives (or the end), so a copy split across chunks is caught. Server output is blanked the same way for every secret of the setup ([5b](#5b-starting-a-local-mcp-server)). Literal copies only: an endpoint that returns the key encoded some other way defeats it, so **the recipient of a key is trusted**, which it already is, since it's the service the key belongs to.

**What the guarantee is, worded honestly.** A key reaches only its own saved address, and no page can read it back, except the Settings page while the person enters it (option B). A page running bad script can still *use* a key through Familiar, while Familiar runs, at its own address. It can't carry it away.

**Entering a key: two ways, the lead decides.**

| | Option A: native entry | Option B: page entry |
| --- | --- | --- |
| How | `secret_prompt` opens a small native dialog owned by Settings: the endpoint's label and address, a password box, Save and Cancel. Built as an in-memory dialog template on the `windows` crate. The key goes from the box to Credential Manager | Settings has a password field and calls `secret_set`, then clears the field. The key never touches IndexedDB or the channel |
| Who sees the key | Only the exe | The Settings page, between paste and the call |
| Exe surface | `secret_prompt` replaces `secret_set`. Server setting secrets use the same prompt | `secret_set` |
| Runner test | The driver types into the dialog through UI Automation | The page calls the command |
| Hours on top of B | About 2 (1 to build, 1 to test) | 0 |

Recommendation: A, if the hours are acceptable. It makes promise 1 true with no exception, and the dialog module it needs exists anyway. B is acceptable if they aren't: the gap needs script already running inside Settings at the moment of a paste.

**Tests.** shell-core: ref parsing, the value rules, the swap (only those headers, exact match, `no-key`), and redaction over every split of a key across two chunks. On the runner:

- Settings stores a random fake key for `addr:<id>`, and `secret_status` says present and bound. The driver finds the target name in `cmdkey /list`.
- Core fetches the fake server with the placeholder, and the fake server answers with a SHA-256 of the header it got, which must match the fake key's.
- **Echo routes**: the fake server sends the key back literally in a response header, in a 200 body, in a 401 body, in a 300 KB body, and split across two chunks. The page must see `[key]` every time and never the key.
- Core removes the address. The fetch is then `not-saved`, and the credential is gone from `cmdkey`.
- Last, the driver searches every file under the data folder, the WebView2 folder and the log, in UTF-8 and UTF-16, for the fake key's bytes, and must find none.

### 5b. Starting a local MCP server

**Choice: the exe starts only a setup the person approved in a native dialog, exactly as approved, in its own kill-on-close job, with a minimal environment, and blanks the setup's secrets from everything it prints.** The mcp-start spike (`spikes/mcp-start/RESULT.md`, two green runs on `windows-latest`) proved the starting parts, and this follows it.

```ts
server_start(setup: Setup, owner?: string, channel: Channel<ServerEvent>): { run: string }
server_write(run: string, body: bytes): void         // to stdin, at most 4 MiB a call
server_stop(run: string): void
server_forget(setupId: string): void                 // stops it if running, removes the approval

type Setup = { id, label, program, args: string[], cwd, env: [name, value][], secrets: string[] }
type ServerEvent = { t: 'out', line } | { t: 'err', line } | { t: 'exit', code: number | null }
```

**Checking, before any filesystem access:**

- `program` (when it's a path) and `cwd` must be plain local absolute paths: a drive letter, a colon, a backslash, then plain names. UNC paths (`\\server\share`), device and namespace paths (`\\.\`, `\\?\`, `\??\`), drive-relative paths (`C:foo`), alternate streams and `..` are refused as `unsafe-path` before anything touches the disk, so no check can make SMB traffic before the dialog.
- Arguments with NUL, CR or LF are refused for every program (`unsafe-argument`), so a setup doesn't work with `node` and fail with `npx`. Any other `InvalidInput` from `spawn` becomes the same error. Limits: 64 arguments, 32 settings, 32 secret names, 8 KiB for the whole setup, small enough that the details area shows all of it.
- **Setting names are case-insensitive**, as Windows treats them. Names are compared upper-cased, and two that differ only in case are refused (`duplicate-setting`). Names that are empty or hold `=` or NUL, and values with NUL, are refused. The spike didn't run these checks, so step 3's tests are the first.
- **Settings that change what runs can't be secrets.** `PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `WINDIR`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `DOTNET_STARTUP_HOOKS`, and every name starting `NPM_CONFIG_`, `UV_`, `PIP_`, `COR_` or `CORECLR_`. A setup that lists one of them in `secrets` is refused (`unsafe-secret`). As plain settings they're allowed, and their values are part of the approval, so changing one asks again. The list lives in shell-core and in the capability matrix.

**Resolving** (the spike's way): a bare name is looked up in absolute local PATH folders only (UNC and relative PATH entries are skipped without being touched), never the working folder, in PATHEXT order, and only `.exe`, `.cmd` or `.bat`. That picks `npx.cmd` over `npx.ps1`, which the spike showed matters. The resolved full path is what the dialog shows and what's stored, so a later PATH change can't swap the program silently.

**The approval.** The exe keeps approved setups in `shell\servers.json`, which only it writes, atomically (a temp file then a rename). If the file can't be read, nothing counts as approved: it's renamed aside, logged, and every setup asks again. The canonical form is the resolved program, the arguments, the folder, the plain settings with their values, and the secret names. Secret values aren't in it, so a renewed token doesn't ask again, and the list above keeps a secret from changing what runs. `server_start` compares that form with the stored approval for `setup.id`:

- **Equal**: it starts, with no dialog.
- **Different or new**: the confirm dialog. Title "Start a program?". The summary names the server, the resolved program, the arguments, the folder, each plain setting as `NAME=value`, and each secret as `NAME (kept in Credential Manager)`, then "It runs as you, with your files. Only start programs you trust." The details area holds the canonical form, one argument per line. Buttons "Start it" and "Don't start". "Start it" stores the approval and starts. Otherwise `declined`.
- A page can't fake or skip it: the dialog is drawn by Windows, in no webview, and nothing but the person's click writes `servers.json`.

**What approval doesn't cover, honestly.** Pinning `npx.cmd` doesn't pin what `npx` then fetches and runs, nor what it finds on the inherited `PATH`. The inherited allowlisted values (`PATH`, `APPDATA` and the rest) aren't in the approval, because anything that can change them already runs as the person. Once started, a server runs as the person.

**Starting** (the spike's sequence):

1. `env_clear`, then the 22 names of the spike's `ENV_ALLOWLIST` that exist, then the plain settings, then each secret read from Credential Manager by `server:<id>:<NAME>`. Nothing else from Familiar's environment reaches the server. The spike saw 23 variables reach it out of the parent's 147.
2. `CreateProcess` with `CREATE_NO_WINDOW | CREATE_SUSPENDED`, stdin, stdout and stderr piped.
3. A new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`, the process assigned, then its thread resumed. If making the job, assigning or resuming fails, the suspended process is terminated, its handles are closed, and `server_start` returns `start-failed`, so nothing is left half-started. One job per server, its handle not inheritable and held only by the exe. In the spike, killing the app hard ended all 14 processes of three servers within 18 ms. Without the job, a busy server lived on.
4. stdout is read line by line on its own thread. A line over 4 MiB is dropped with an `err` event saying so. stderr lines are cut at 8 KiB. Both go to core over the channel core passed in, which only core receives.
5. **Before a line leaves Rust**, every secret value of the setup is replaced with `[hidden]`, on stdout and stderr both. Secrets are at least 8 bytes, so all of them are blanked.

**The job is lifecycle control, not a security boundary.** It makes servers stop with Familiar. A server can still start work outside it (a scheduled task, another app), and can read or change anything the person can, `servers.json` included.

**Stopping.** `server_stop` closes stdin, waits up to 500 ms (an idle server exits in about 100 ms), then `TerminateJobObject`. When Familiar exits or crashes, the kernel closes the job handle and that ends the tree, with no code.

**Limits.** 16 servers running at once (`busy` past that).

**Tests.** shell-core: the path rules (every refused form, and that none of them reaches a filesystem call, checked with a fake filesystem that fails the test on any touch), resolution on a fake PATH, the setting rules, the canonical form (a changed argument, folder, plain setting or secret name changes it, a changed secret value doesn't), the blanking. On the runner, against `tools/fake-mcp-server` started as `node <repo>\tools\fake-mcp-server\src\main.ts`:

- A first start shows the dialog. The driver checks the resolved `node.exe` path and each argument in its details and clicks "Start it". `initialize` and `tools/list` work over the channel.
- A second start shows no dialog. A changed argument (`--variant b`) shows it again, and "Don't start" gives `declined`. `node_options` and `NODE_OPTIONS` together are `duplicate-setting`. `NODE_OPTIONS` as a secret is `unsafe-secret`. A UNC program and a UNC folder are `unsafe-path`, and the driver's SMB counter (`Get-SmbConnection`) shows no new connection.
- `print_secret` comes back with `[hidden]`, and the driver's search finds the secret in no file. `list_env` shows only allowlisted names and the setup's own.
- **Failure paths**: the driver runs `familiar.exe` inside a job of its own that allows only a few processes, so creating a server fails, and checks that `start-failed` comes back and no suspended process is left. A program that exits at once reports `exit`.
- **Crash recovery**: the driver kills the exe while an approval is being written, and replaces `servers.json` with garbage. The next start asks again and never starts unasked.
- **Races**: `server_forget` and `server_stop` while a call runs, then a hard kill of `familiar.exe` with a `slow` call in flight. No `node.exe` from the setup is left 2 s later.
- `npx`, `uvx` and the 20 kinds of tricky argument through `npx.cmd` are proven by the spike and aren't repeated. A console flash seen by eye, and Smart App Control on binaries that npm or uv download, are step 13's, on a real PC.

### 5c. The guarded fetch

**Choice: one fetch path for every model endpoint and remote server, `net_fetch`, which reaches only saved addresses. It replaces the HTTP plugin entirely.** With the CSP and the webview's dead proxy, it's the only way out of Familiar to the network, once the egress inventory passes.

**Saved addresses** come first:

```ts
address_list(): Address[]
address_add(kind: 'model' | 'server' | 'peer', url: string, label: string, owner?: string, ports?: [first, last]): Address
address_remove(id: string): void       // ends its open requests and sockets, deletes its key

type Address = { id, kind, url, label, reach: 'public' | 'lan' | 'loopback', ports?: [first, last] }
```

- `url` is normalized: scheme and host lower case, the host as punycode, the default port dropped, no user info, query or fragment, no trailing slash. `https` is required unless `reach` is `lan` or `loopback`. `peer` addresses are `ws://127.0.0.1` only, with no port in `url` and a range of up to 16 consecutive ports in `ports`, so one approval covers an app that listens on whichever port of its range is free. No port numbers live in the exe.
- **Literal IP hosts are classed directly** and never resolved: `127.0.0.0/8` and `::1` are loopback, the private ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`) are lan, IPv4-mapped IPv6 is classed as its IPv4. Link-local (`169.254/16`, `fe80::/10`, which holds the cloud metadata address), unspecified, multicast, broadcast and the documentation ranges are refused always. `localhost` is loopback.
- **A name** is resolved once at `address_add`: all-loopback answers make it loopback (Ollama at `http://localhost:11434`), all-private make it lan (LM Studio on another PC), all-public make it public. Mixed or empty answers are refused.
- **Adding asks the person** with the confirm dialog: "Let Familiar send to this address?", the normalized URL with the host on its own line in punycode, what it is ("a model endpoint", "an MCP server", "an app on this PC"), and for lan or loopback "on your own network" or "on this PC". A peer shows its label and range in one line, for example "Desktop Buddies on this PC, ports 47110 to 47114", or "port 47110" for a range of one. Buttons "Allow" and "Don't allow". Adding a URL that's already saved returns the saved entry with no dialog. The list is in `shell\addresses.json`, which only the exe writes, atomically, and an unreadable file counts as an empty list.

**The fetch**, pull-based like the HTTP plugin's, since the pi-ai spike proved that shape:

```ts
net_fetch(spec: { id, address, url, method, headers: [name, value][], maxBytes?, headersMs?, idleMs? }, body?: bytes)
  : { status, statusText, headers: [name, value][], url, redirected }
net_read(id: string): bytes          // empty means the end
net_cancel(id: string): void         // at any moment, before or after the head

// in the app, apps/desktop/src/net.ts
guardedFetch(address: string): typeof fetch
```

- `id` is chosen by the page (128 random bits), so `net_cancel` works before the head arrives. A reused id is refused.
- `address` is a saved address id of kind `model` or `server`, and `url` must be under it: the same origin, with a path under the saved path at a segment boundary. Otherwise `not-saved`. There is no other mode: no unsaved loopback, no port of the page's choosing.
- **Where it may connect, without a proxy.** A literal IP is checked against the address's `reach` before connecting. A name goes through a custom `reqwest::dns::Resolve` that keeps only answers of the address's `reach`, and reqwest then connects only to those answers while TLS still checks the certificate against the name. So a public name that later resolves to `127.0.0.1` or `10.0.0.5` (DNS rebinding) gets `blocked-address`. Every redirect goes through the same checks.
- **With a system proxy.** Public addresses use the Windows system proxy (reqwest's default reading of the per-user settings), because some networks have no other way out. Then the proxy, not Familiar, resolves the name and picks the destination, and reqwest can't check where a CONNECT tunnel really lands. **So behind a proxy, the private-network guarantee rests on the proxy.** Familiar still refuses literal private IPs, still resolves the name itself first and refuses a non-public answer, and never sends lan or loopback addresses through a proxy. Settings says when a proxy is in use. A PAC script isn't supported (see [8](#8-what-could-force-another-exe)).
- **Redirects**: up to 5, each target checked with the same rules and required to be under the same saved address. Anything else is `redirect-refused`. Since the target stays under the saved address, the key stays with the address it's bound to.
- **TLS**: rustls with the platform verifier, so roots installed on the PC, such as a company's, are trusted as Windows trusts them. Step 3 confirms on the runner that a `https` fetch to a public test host works and a self-signed local `https` server is refused.
- **Headers**: up to 64 request headers of up to 8 KiB each. `host`, `content-length`, `transfer-encoding`, `connection`, `cookie` and `proxy-*` from the page are dropped. There's no cookie store, and `set-cookie` is dropped from responses. The key swap and redaction happen here ([5a](#5a-credentials)).
- **Limits**: request body up to 16 MiB. Response headers up to 64 KiB. `maxBytes` defaults to 32 MiB with a hard cap of 256 MiB, counted after decompression, so a small compressed body can't expand past it. Connect 20 s. `headersMs` (time to the head) and `idleMs` (between chunks) default to 120 s, capped at 15 min. No total limit, so a long reply streams for as long as it keeps coming. Up to 32 requests open at once.
- **Streaming and stopping.** `guardedFetch` returns a `Response` over a pull-based `ReadableStream`, each pull one `net_read` of up to 1 MiB. On the signal it calls `net_cancel`, which aborts the request task and drops the connection. A pending `fetch` then rejects, and the stream errors, with `new DOMException('Aborted', 'AbortError')`, as the browser's own fetch does. (The spike's Tauri shape, a plain `Error`, passed the contract too.) A signal already aborted never reaches the exe. Removing the address mid-request ends the request with `revoked`. Deleting its key mid-request doesn't touch a request already sent, and the next one gets `no-key`.
- **Errors**: `not-saved`, `insecure`, `blocked-address`, `redirect-refused`, `no-key`, `too-large`, `timeout`, `tls`, `network`, `cancelled`, `revoked`, `busy`, `invalid`. A thrown error is a `TypeError` with `cause.kind`, as fetch's network errors are, so pi-ai's adapter sees a network failure and Familiar's wrapper reads the kind.

**Tests.** shell-core: normalization, classing (every reserved range, mapped addresses, odd literal forms such as `127.1` and `0x7f.1`, which are normalized first), the under-address rule, redirect decisions, header filtering, the limits. On the runner, with a small Node server in `shell-check` on `127.0.0.1`, a TLS listener, a logging proxy, and `hosts` entries the driver writes and restores (the runner is admin):

- Before Allow, a fetch is `not-saved`. The dialog adds the address on Allow and not on Don't allow.
- A 40-chunk stream arrives whole. A stop after chunk 3 rejects within 100 ms, and the server sees the connection close. A stop before the head, and `address_remove` mid-stream (`revoked`), both leave nothing open on the server.
- `headersMs` and `idleMs` time out. A body past `maxBytes` gives `too-large`, and so does a gzip bomb.
- A redirect inside the saved address is followed. One to another path, to an unsaved host, and to `https://127.0.0.1` from a public address give `redirect-refused`.
- **Changing DNS**: `familiar-check.test` maps to a public address while it's added (so it saves as public), then the driver maps it to `127.0.0.1` and clears the DNS cache. The next fetch is `blocked-address`.
- **Literal addresses**: `http://[::ffff:127.0.0.1]:<port>` saves as loopback. `http://` to a public address is `insecure`. `http://169.254.169.254` can't be saved.
- **Proxy**: the driver sets the per-user system proxy to its logging proxy. A public address goes through it, a lan and a loopback address don't, and a literal private IP is still refused.
- The key swap and every echo route ([5a](#5a-credentials)).
- step 4's model-port contract runs over `guardedFetch` in the real webview against the same server, with recorded OpenAI and Anthropic streams, all six cases.

### 5d. The rest

Each of these is here because a page can't do it and a later need would otherwise force an exe.

| Command | Does | Limits and rules |
| --- | --- | --- |
| `shell_info()` | `{ api, version, args, dataDir, webviewDir, origin, autostarted }` | |
| `shell_ready(channel)` | Core says it started, and hands over the channel for everything the exe tells it: `tray`, `tray-click`, `second-launch`, `system`, `wake`, `quitting` | Once a run |
| `log_line(line)` | One line to the log | 4 KiB a line, 100 lines a second a window |
| `quit()` | Sends `quitting` to core, waits up to 3 s for `quit_ready`, then exits | Tray Quit takes the same path |
| `quit_ready()` | Core has finished its last writes | After `quitting` only |
| `tray_set({ tooltip, icon, items })` | Sets the menu, as Desktop Buddies' | `icon` a PNG from the app folder. The exe appends Quit, and "Let Familiar ask again" when the confirms are stopped. Menu ids starting `shell:` are the exe's |
| `system()` | `{ userState, idleMs, locked, onBattery }` | `userState` from `SHQueryUserNotificationState`: `normal`, `fullscreen` (a D3D game or any full-screen app), `presentation`, `busy`, `quiet` (Windows' quiet time), `away`. `idleMs` from `GetLastInputInfo` |
| `wake_at(at)` | One native deadline: at `at` (Unix ms), the exe sends `wake` over the channel | One pending deadline, each call replaces it. Fired within 1 s, also late after a resume. Doesn't wake a sleeping PC |
| `view_open(spec)` | Opens a view window, bound to its page | Label `view-[a-z0-9-]{1,32}`, page a plain `.html` name in the app folder, size, title, `decorations`, `transparent`, `alwaysOnTop`, `skipTaskbar`, `visible`, `focused`, `focusable`. `core` can't be made |
| `window_ctl(label, op, bounds?)` | show, hide, focus (restoring a minimized one), close, get and set bounds | `view-*` labels only |
| `window_self(op)` | drag, minimize, toggle maximize, close, on the calling window | Views only |
| `autostart({ on? })` | Reads, or sets then reads, the Run entry | Current user. The entry runs the exe with `--autostart` |
| `open_url(url, owner?)` | The confirm dialog, then the default browser | `https` only, 2048 characters. The dialog shows the host on its own line in punycode and the full URL in its details, with "Open" and "Don't open". Under the one throttle. No allowlist in the exe |
| `open_folder(which)` | Explorer at `backups` or `logs` | Only those two |
| `pick_path({ kind, filters?, owner? })` | Native open dialog, returns a full path or null | `kind` is `file` or `folder` |
| `save_as({ name, filters, owner? }, bytes)` | Native save dialog, writes the bytes there | 256 MiB. Desktop Buddies' API 2 code: a new temp file beside the target, swapped in with `ReplaceFileW`, links refused. Refused inside the native data folder, the WebView2 folder, and the folder holding the exe and the app folder, compared on the final path of the target's folder |
| `backup_write(name, bytes)`, `backup_list()`, `backup_read(name)`, `backup_delete(name)` | The rolling backup's files | Inside `backups\` only, plain names ending `.familiar-backup`, up to 16 files. One write at a time. **One budget**: 1 GiB for every file in the folder, temporary ones included, checked before a write starts. Temporary files have the exe's own exclusive `.~<16 hex>.tmp` names, and each start deletes those, and only those. Which to keep and when to delete is the app's |
| `secret_set` from core | Stores a peer's pairing token | The handler reads the caller's label from the IPC request: from `core`, only `addr:<id>` refs whose address is a `peer` are accepted, so core still can't write model or server keys. With option A this is the only use of `secret_set` left |
| `ws_connect({ address, port, path }, channel)`, `ws_send(id, text)`, `ws_close(id)` | A WebSocket client, opened from `familiar.exe`'s own process | `address` a saved `peer` address and `port` inside its range. The exe builds the URL `ws://127.0.0.1:<port><path>` itself and checks it again. It sends `Host: 127.0.0.1:<port>` exactly and no `Origin` header, and the page sets no headers at all. Messages up to 1 MiB both ways, 4 sockets at once, messages to core over the channel. No redirects. In outgoing text, the placeholder is swapped for the address's stored token, and incoming text has literal copies redacted, as in [5a](#5a-credentials) |

**Agreed with Desktop Buddies on 2026-11-14** (with its own session): Familiar needs only Desktop Buddies' socket. There's no discovery or port file, and no earlier file-based phase. Desktop Buddies listens on a WebSocket on `127.0.0.1`, on one of a fixed range of five consecutive ports, which isn't chosen yet. Familiar finds it by trying the range and exchanging a hello: a product id plus a protocol version the app can refuse. The app asks once, through `address_add`, for "Desktop Buddies on this PC, ports a to e" with whatever range Desktop Buddies picks, so no numbers are compiled in. Desktop Buddies identifies its caller by the process that owns the connection, so the socket must be opened by `familiar.exe` itself, never by WebView2 or a helper process, which is how `ws_connect` works. The app does the hello, the pairing and the protocol. The pairing token goes into Credential Manager through the secret commands. It passes through core once, as it arrives over the socket during pairing, and after that core only ever sends the placeholder.

**Tests**: shell-core for every rule in the table. On the runner: `view_open` with a bad label or page refused. `open_url` with `http:` or `javascript:` refused before any dialog. A valid `open_url` to the driver's local TLS listener: on "Don't open", the listener sees nothing, on "Open" it sees a connection, which proves a launch without counting browser processes. `save_as` through the dialog to a normal folder works, and into the data folder or beside the exe is refused. `backup_write` past 16 files or past the budget is refused, and a stray `.~*.tmp` is gone after a restart while a file of another name stays. `autostart` set and cleared, with the registry read back. `system` reports `locked` after the driver locks the session where the runner allows it (SKIP otherwise, and it isn't in the security inventory). `wake_at` fires within 1 s with core hidden for 10 minutes. `ws_connect` to a port outside the saved range refused, and a round trip to a Node WebSocket server in shell-check on a port inside it, which checks the `Host` header is exactly `127.0.0.1:<port>`, that no `Origin` header came, that the connection's owning process is `familiar.exe` (`Get-NetTCPConnection`), that a 1 MiB message passes both ways and a larger one is refused, and that the token placeholder is swapped out and the token redacted coming back. A peer's dialog shows its range on one line. `quit` with an outstanding IndexedDB write that core finishes, and with a core that never says ready (exit after 3 s anyway).

### The command inventory

| Group | Command | Caller |
| --- | --- | --- |
| Shell | `shell_info`, `shell_ready`, `quit`, `quit_ready`, `tray_set`, `system`, `wake_at`, `autostart` | core |
| | `log_line` | core, views |
| Windows | `view_open`, `window_ctl` | core |
| | `window_self` | views |
| Addresses and fetch | `address_list`, `address_add`, `address_remove`, `net_fetch`, `net_read`, `net_cancel` | core |
| Keys | `secret_set` (B) or `secret_prompt` (A) | view-settings |
| | `secret_set`, for `peer` addresses only | core |
| | `secret_status` | core, view-settings |
| | `secret_delete` | core |
| Servers | `server_start`, `server_write`, `server_stop`, `server_forget` | core |
| Files and links | `pick_path`, `save_as`, `open_url`, `open_folder`, `backup_write`, `backup_list`, `backup_read`, `backup_delete` | core |
| Part 2 | `ws_connect`, `ws_send`, `ws_close` | core |

36 commands with option B, 37 with option A (`secret_prompt` added, `secret_set` kept for peer tokens). `COMMANDS` in `build.rs`, the capability files, the Rust handler list and `src/shell.ts` are one inventory, and the static test fails if they disagree.

---

## 6. Tray, hotkey, autostart, single instance, notifications, system state

- **Tray.** Up before any page runs, with only Quit, which the exe appends and handles itself, so it works with core dead (Desktop Buddies' `tray.rs`). Core sets the rest with `tray_set`. Clicks reach core over its channel. Closing every window never ends the run, only Quit does.
- **Hotkey.** Core registers the person's chosen shortcut through the plugin and shows or focuses chat when it fires. If registering fails (another app has it), Settings says so. No hotkey is registered until the person picks one in first-run setup.
- **Autostart.** Off until the person turns it on. The Run entry starts `familiar.exe --autostart`. A sign-in start keeps chat closed and goes to the tray, and core never takes the keyboard.
- **Single instance.** A second launch hands its arguments to the first and exits within a second. Core hears it and shows chat. A sign-in start while Familiar is already running is a no-op.
- **Notifications.** Core shows reminder toasts with a title, body and up to three buttons (for example Done and Snooze). A click on the toast or a button reaches core while the toast is on screen, and core shows the reminder card in chat. A click from the Action Center is not reported (the plugin says so for Windows), so the card in chat is always the source of truth and a toast is only a nudge.
- **System state.** The exe sends `system` over the channel when anything changes: `userState` (polled every 5 s), lock and unlock (`WTSRegisterSessionNotification`), sleep and resume (`WM_POWERBROADCAST`), and on battery. Idle time is read on demand. The rules decider uses `fullscreen`, `presentation` and `quiet` as do-not-disturb, next to Familiar's own do-not-disturb setting. Windows has no public way to read Focus Assist on Windows 11 beyond these states, and Windows itself holds toasts back while it's on.
- **Reminders and wake-ups.** pi-durable's Harness takes `setTimer` and `onWake`, so reminders are driven by `wake_at`, not by page timers that a hidden window might throttle. After a resume, core is told and re-checks what's due. The soak decides whether the webview's own timers would have been enough, but the native wake is in the exe either way.

---

## 7. Checks on the Windows runner

Modelled on Desktop Buddies' `shell.yml`: `.github/workflows/shell.yml` on `windows-latest`.

1. Toolchain from `rust-toolchain.toml` (1.95.0). `cargo test --locked` in `shell-core`. `cargo build --release --locked` in `src-tauri` (`custom-protocol` on, no Tauri CLI needed). The exe's size and SHA-256 go in the job summary, and it's uploaded as an artifact.
2. `pnpm install --frozen-lockfile`, then build the check app folder (`apps/desktop/shell-check`) and the real app folder.
3. **Contract check.** `shell-check/driver.ps1` launches the exe on the check app folder with a scratch `--data-dir`, `--seconds` and `--log`. Its pages run every check through the app's real client (`src/shell.ts`) and log `CHECK PASS|FAIL|SKIP id detail`. When a check needs something no page can do, it logs `STEP n action args` and the driver does it: answer a native dialog through UI Automation, read `cmdkey`, search files for a secret, write `hosts`, set the proxy, run listeners, read the DNS cache, kill the exe hard, read the registry and the clipboard. There's no test code in the exe.
4. **The security gate.** `shell-check/security-inventory.json` lists every security check by id. The gate passes only if every listed id reports PASS. A FAIL, a SKIP, or an id that never reported fails it, and so does an id that reported but isn't listed. Checks outside the inventory may SKIP. The inventory:
   - `caps.static`, `caps.view-refused`, `caps.core-reaches`, `caps.cross-window`, `caps.forged-event`, `caps.page-binding`
   - `csp.trusted-types`, `egress.core`, `egress.view`, `nav.refused`
   - `pin.origin`, `pin.folder`, `pin.restart`, `pin.moved-install`
   - `confirm.defaults`, `confirm.throttle`, `confirm.escaping`
   - `key.roundtrip`, `key.echo`, `key.no-copy`, `key.bound`, and `key.prompt` with option A
   - `fetch.saved-only`, `fetch.stream-stop`, `fetch.limits`, `fetch.redirects`, `fetch.rebinding`, `fetch.literal`, `fetch.proxy`, `fetch.revoke`
   - `server.approve`, `server.reask`, `server.paths`, `server.settings`, `server.blank`, `server.env`, `server.start-failed`, `server.store-recovery`, `server.kill`
   - `link.confirm`, `files.save-refused`, `files.backup-budget`, `ws.saved-only`, `quit.clean`
5. **Measurements**, recorded as INFO: `persist()`, the web clipboard, the toast app id, TLS roots. Each settles a choice in this note before the exe does.
6. **Smoke run.** The real app folder with a fresh data folder: core starts, says ready, opens chat, and quits cleanly, judged from the log.
7. **Soak**, required: core hidden with no views for 30 minutes, logging its page timers' drift against `wake_at`. It runs in its own job.

**When they run.** The repo is public, so Actions minutes are free.

| Trigger | Runs |
| --- | --- |
| Every push, any branch, Linux | `shell-core` `cargo test`, the capability, inventory and pin tests, typecheck and tests (already in `ci.yml`) |
| Every push touching `apps/desktop/src-tauri/**`, `shell-core/**`, `shell-check/**` or `shell.yml` | The whole workflow: build, contract check with the security gate, smoke, soak |
| Every push to `main` | The contract check, gate and smoke with the current app folders on the latest exe built from `main` (`reuse`), so an app change can't quietly break against the exe |
| By hand | Any of it, with `reuse` |

---

## 8. What could force another exe

| Could force one | How this design avoids it, or what's left |
| --- | --- |
| New views, windows or tray items | `view_open`, `window_ctl` and `tray_set` are general. Window flags for a borderless, unfocused or always-on-top view are in the spec now |
| A new provider or wire | Every API goes through `net_fetch` with the placeholder swap. A provider that wants the key outside the four headers, say in the URL, would need one. None of the three planned do |
| Remote servers that need OAuth | **Not in v1.** Remote servers take an API key or a bearer token. OAuth needs native token storage, exchange and refresh, and a callback listener done properly. It comes later with its own exe, batched with whatever else is waiting |
| Desktop Buddies' API v2 | The scoped WebSocket is in now, as agreed with Desktop Buddies. Its port range is a saved address, not a number in the exe, so choosing or changing the range needs no exe |
| `persist()` refused and data evicted | The backup commands are in now, whatever step 3 measures |
| Reminders in a hidden or sleeping app | `wake_at` and the resume event are in now |
| Clipboard, Trusted Types under Tauri, an egress route left open | Decided by measurement in step 3, before the exe settles |
| Toast clicks from the Action Center | Would need a COM activator. Avoided by design: the chat card is the source of truth |
| A server program kind other than `.exe`, `.cmd`, `.bat` | `.ps1` and bare scripts are refused on purpose. Python and Node scripts run through their `.exe` |
| A network that only has a PAC proxy script, or a proxy that wants a login | Not supported. A known gap for the README. It would need a new exe if people hit it |
| A Tauri or WebView2 security fix in the exe's own code | Can't be avoided. Batch it with whatever else is waiting, as Desktop Buddies' "For the next exe" list does |
| Later tiers (UI Automation, screen and mouse) | Out of part 1 on purpose. They come with their own plans and their own exe |
| Signing (SignPath after the public flip) | A signed build is a new exe by nature, of the same source |

---

## 9. Hours

The first version of this note said 14. Review showed that was an implementation estimate with almost no room for proving the guarantees, and the revision adds real work: page binding and window wrappers, Trusted Types, the egress closure and its test, the shared confirm module, streaming redaction, the path and setting rules, the failure paths, system state and the wake, and a gate that can't pass by skipping. Removed: `oauth_wait` and the loopback fetch mode.

| Part | Implement | Validate | Rework |
| --- | --- | --- | --- |
| Skeleton: assets, windows bound to pages, tray and `tray_set`, single instance, log, quit, the missing-folder box | 2 | 0.5 | |
| Capabilities, window wrappers, the core channel, CSP with Trusted Types, browser arguments, the static tests | 1.5 | 1 | |
| The confirm module: dialog, defaults, delay, modality, escaping, throttle, tray re-entry | 1.5 | 0.75 | |
| Saved addresses | 0.75 | 0.25 | |
| Guarded fetch: rules, literal IPs, resolver, proxy, redirects, limits, streaming, swap, streaming redaction, revocation | 4 | 2 | |
| Credentials (option B) | 0.5 | 0.5 | |
| Server start: path and setting rules, approval store, dialog, job, failure cleanup, blanking | 2.5 | 1.5 | |
| Files, backups budget, links, folders, autostart | 1.25 | 0.75 | |
| Scoped WebSocket with its port range, Host and owning-process checks | 0.75 | 0.5 | |
| System state, `wake_at`, notifications, hotkey, toast app id | 1.5 | 0.75 | |
| Egress test harness (listeners, STUN, DNS cache), the inventory gate, the workflow, the soak job | | 2.5 | |
| Runs on the runner until green, and what the measurements overturn (Trusted Types, WebRTC, the dead proxy, clipboard, toasts) | | | 4 |
| **Total** | **16.25** | **11** | **4** |

**About 31 hours**, and 33 with native key entry. About 3 move forward from later steps: step 4 gets its fetch proven, step 7 no longer builds the server start, its approval or blanking, and step 10 gets the backup commands. So part 1 grows by about 28 hours over its 93, not 31. This is a re-estimate before anything is built. The review's point stands that it should be re-estimated again once the riskiest pieces (the egress closure and Trusted Types under Tauri) have run on the runner, which should be the first thing step 3 does.

---

## Decisions for the lead

1. **Key entry: native (A) or page (B).** Both are designed in [5a](#5a-credentials) and change the exe (`secret_prompt` or `secret_set`). Recommended: A, at about 2 more hours.
2. **With B, Settings calls `secret_set` directly**, write-only, so a key never crosses the shared channel. That goes against "only core touches keys". Recommended: allow it.
3. **When the exe settles.** (a) At step 3, as `docs/design.md` says. (b) Before the first release (step 12), as you proposed. The owner's PC only sees release builds and the runner has no Smart App Control, so exe changes during development cost nothing there. Under (b), step 3 still builds everything above, but the measurements and later steps can change the exe until step 12, and the hours above lose part of their rework risk. Recommended: (b). The rule then reads "no exe reaches a person's PC until it's settled".
4. **The step 3 estimate**: about 31 hours (33 with A), against 8.

Decided in this note, after review: untrusted content is never HTML, with Trusted Types pinned and no sandboxed frame. Consent to MCP writes and sends stays in the app. Links ask natively with no allowlist. No OAuth in v1. No loopback fetch mode. With Desktop Buddies, on 2026-11-14: its socket only, no discovery file ([5d](#5d-the-rest)).

## Open, for step 3 to measure

- Whether WebView2 grants `navigator.storage.persist()` ([3](#3-origin-and-data-folder-pinned)).
- Whether the dead proxy, the WebRTC policy and DNS prefetch off close every egress route, with Familiar's pages and IPC still working ([2](#egress-outside-fetch)).
- Whether Tauri's injected scripts run under `trusted-types 'none'` ([2](#the-web-surface-what-the-exe-pins)).
- Whether `navigator.clipboard.writeText` works in a view, which decides the clipboard plugin ([4](#4-plugins)).
- Whether the registry app id is enough for toasts on an unpackaged exe ([4](#4-plugins)).
- How the webview's own timers drift with core hidden for 30 minutes ([7](#7-checks-on-the-windows-runner)).
- That rustls with the platform verifier trusts what Windows trusts ([5c](#5c-the-guarded-fetch)).

---

## Changes after review 1

| Finding | What changed |
| --- | --- |
| P1-1 chat consent isn't a boundary | Untrusted content is never HTML. The exe's CSP pins `require-trusted-types-for 'script'` and `trusted-types 'none'`, with a step 3 check under Tauri. A sandboxed frame was weighed and refused, with the reason and the residual stated. Consent to MCP writes and sends stays in the app. A new "What the exe promises, and what it doesn't" section says so plainly |
| P1-2 `open_url` bypasses the gate | `open_url` asks natively first, showing the host in punycode and the full URL, under the one throttle. No allowlist in the exe |
| P1-3 loopback undoes the gates | The `loopback: { port }` fetch mode is gone. `ws_connect` takes only a saved `peer` address added through the confirm, the exe builds and rechecks the final URL, and `host` and handshake headers are refused |
| P1-4 CSP isn't a firewall | Browser arguments chosen now: a dead proxy for the webview's own network with no loopback bypass, WebRTC limited to proxied UDP, DNS prefetch off. A hostile-page egress test with TCP and UDP listeners, a STUN responder and a DNS cache check. The "only way out" claim waits on it |
| P1-5 key guarantee false | Reworded to what holds. Redaction on headers and every body, any status, across chunk boundaries, literal copies only, and the recipient treated as trusted. Secrets are at least 8 bytes, so all are blanked. Native entry designed as option A with its hours, the lead decides |
| P1-6 proxy and DNS | Literal IPs are classed without DNS. Direct connections use only checked answers. Behind a proxy, the private-network guarantee is stated to rest on the proxy |
| P1-7 server approval | UNC, device, namespace and drive-relative paths are refused before any filesystem access, for program and folder. Setting names are case-insensitive. Settings that change what runs can't be secrets, and their values are in the approval. The job is described as lifecycle control, and what approval doesn't cover is stated |
| P1-8 Tauri permissions | No `core:event:default`, `core:window:*` or `core:webview:*` for anyone. `window_self` acts on the caller's own window and `window_ctl` on views only. The exe never emits content in events (Tauri delivers them to `Any` listeners in every window) and uses one channel to core. Windows are bound to their pages. Tests for cross-window targets, forged events and page binding |
| P1-9 OAuth | `oauth_wait` dropped. No OAuth in v1, a proper design comes later with its own exe |
| P1-10 tests can pass without proving | A fixed security inventory where FAIL, SKIP or a missing id fails the gate. New side-effect tests: echo routes, changing DNS, proxy routing, literal addresses, start failures, approval-store recovery, revocation and cancellation races, cross-window and forged events. Link launches are proven by a local TLS listener, not by counting browsers. The rebinding test now saves the name while it resolves publicly |
| P2-11 dialog flooding and display | One throttle across all confirms, stopping after three refusals until the person re-enables from the tray. Default refuse, a one-second delay on approve, every Familiar window disabled while it's open. Control and bidi characters escaped, labels cut, the full canonical operation in the details area, and the setup cap lowered to 8 KiB |
| P2-12 backups and export targets | One 1 GiB budget for the whole folder including temporary files, one write at a time, the exe's own temp names swept at start, names and rotation left to the app. `save_as` and backups refuse the native data folder, the WebView2 folder and the install folder |
| P2-13 inventory incomplete | `tray_set` and `quit_ready` have contracts and grants. A full command inventory, checked against `COMMANDS`, the capabilities, the handlers and `src/shell.ts`. Tests for quit with an outstanding write and with a core that never answers |
| P2-14 native needs deferred | `system()` and system events (full screen, presentation, quiet time, idle, lock, sleep and resume), `wake_at` for reminders, core never focusable, and `focused` and `focusable` for views. The soak is required |
| P2-15 estimate | Re-estimated as implementation, validation and rework: about 31 hours, 33 with native entry. When the exe settles is put to the lead, with (b) recommended |
| Discovery file | Dropped, with `peer_read`, as agreed with Desktop Buddies on 2026-11-14: a WebSocket on a fixed range of five loopback ports with a hello, the range saved as one approved address, `Host` exactly `127.0.0.1:<port>`, no `Origin`, the socket opened by `familiar.exe` itself, 1 MiB per message, and the pairing token kept in Credential Manager. Core may store tokens for peer addresses only |
