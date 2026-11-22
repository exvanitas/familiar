# Familiar's native shell

Build step 3. The design for `familiar.exe`, written before any of it is built. Revised twice after review, see [Changes after review 1](#changes-after-review-1) and [Changes after review 2](#changes-after-review-2), then for the maintainer's [decisions](#decisions) ([Changes after the decisions](#changes-after-the-decisions)).

## The rule

**The exe holds general native building blocks and the gates that must not live in a webview. Everything else is the `app` folder beside it.**

Familiar ships unsigned. Each new unsigned exe gets a fresh Smart App Control verdict on a person's PC, and a blocked exe has no "run anyway". App folder changes get no verdict. So the exe settles once and rarely changes after, as Desktop Buddies' did (`docs/native-shell-design.md` in that repo, which this follows wherever it can, and whose proven code it copies). It settles just before the first release (step 12), not at step 3 (decided 2026-11-14, see [Decisions](#decisions)). The rule is: no exe reaches a person's PC until it's settled. The owner's PC only ever sees release builds, and the runner has no Smart App Control, so exe changes during development cost nothing there. Step 3 builds and proves the exe's core. A few pieces designed here are built later, still before release, see [9](#9-hours).

A gate belongs in the exe when a page that went wrong could do lasting harm without it: carry a key away, send data somewhere the person never chose, or start a program. A page goes wrong by a bug in the app, or by script running where it shouldn't. Everything that is a choice, such as which hotkey, what the tray says, when to ask for consent to a tool call, lives in the app.

The exe asks the person itself, in a native Windows dialog, in three places: before a program runs, before a new address joins the list of places data may go, and before a link opens in the browser. Those are the acts a page must not be able to fake or skip. Consent to an MCP tool that writes, opens or sends stays in the app, as consent cards.

## What the exe promises, and what it doesn't

The promises, each with the checks that prove it in [section 7](#7-checks-on-the-windows-runner):

1. **No page reads a key back.** A key is typed into the Settings window, goes straight to Credential Manager, and from there only into requests core makes to its own saved address. After saving, pages see only that a key is set and a masked hint. Two documented exceptions: the Settings window sees a key while the person types it, and a peer's pairing token passes through core once as it arrives during pairing ([5a](#5a-credentials), [5d](#5d-the-rest)). The Settings window is kept apart so that script in the chat view can't watch a key being typed ([2](#windows)).
2. **Data leaves only to places the person approved natively**: saved addresses through the guarded fetch, saved loopback peers through the WebSocket, and links the person confirmed. **Declared 2026-11-14**, once the egress checks passed on the runner with their positive controls (run 43593746739 of `shell.yml`: 49 routes closed from core, a view and a view without Trusted Types). It rests on three things in the exe: the CSP, the sink proxy, and a script in every frame that removes WebRTC, because this WebView2 ignores both the CSP's `webrtc` directive and the WebRTC switches ([2](#egress-outside-fetch)). WebView2 updates itself, so the egress check runs again on every push to `main` against the newest runtime the runner has, and a route that opens fails the gate.
3. **Only approved programs start.** Approval binds the launch: the resolved program, its arguments, its folder, its plain settings with their values, and the names of its secrets. Secret values can change without asking again. Approved programs stop with Familiar ([5b](#5b-starting-a-local-mcp-server)).
4. **The origin and data folders never move**, so an update never starts an empty database ([3](#3-origin-and-data-folder-pinned)).

What it doesn't promise:

- **Script running inside a page owns that page's origin.** Every Familiar page shares one origin, so such script can read and change IndexedDB, and can forge messages on the pages' `BroadcastChannel`, consent answers included. The design makes that unlikely (untrusted text is never HTML, and the app's own CSP makes HTML sinks throw), and the native gates bound what such script can do. It can't make it impossible.
- **A key's recipient is trusted.** An endpoint that echoes a key back in another encoding defeats any redaction. Familiar redacts literal copies only, and only of the address's current key: an endpoint that kept an old key after it was changed or deleted could echo that one back.
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
- **Views**, labels `view-<name>`: chat, and whatever the app adds later. A view draws what core publishes and sends requests back over a `BroadcastChannel`, as Desktop Buddies' Manager does. Closing a view loses nothing.
- **`settings`**: its own window, label `settings`, always bound to `settings.html`, and no `view-*` label may load that page. It's where keys are typed. It never draws model text, card text or tool results, and it never joins the channel core publishes conversations on: it talks to core over its own `BroadcastChannel`, which carries settings only. Its capability set is its own and holds nothing it doesn't need: no events at all, the key commands, and a read of the saved addresses, so the address shown beside a key box comes from the exe, not from a message another page could forge. Its page loads only its own small bundle, with no model, MCP or Markdown code in it (checked in step 11).

**What keeps chat's script out of Settings.** All pages share one origin, so the gap would be script that reaches Settings through what they share. Each route is closed:

- No window can reach another's DOM: `window.open` is denied and no window holds a reference to another.
- No service worker can sit in front of Settings' page: the exe's CSP has `worker-src blob:`, and a service worker can't be a `blob:` URL, so registering one always fails.
- No page can read the clipboard, where a pasted key may still be: the exe answers every web permission request with deny ([below](#web-permissions)).
- Storage and channels carry data only: Settings draws everything it reads as text, so nothing stored or sent can become script there, and it never takes an address from a message.

One helper builds every window, because WebView2 windows sharing a data folder must share browser arguments. It always sets the pinned data folder, `use_https_scheme(false)`, `disable_drag_drop_handler()`, the navigation handler, the permission handler, autofill and password saving off, and the browser arguments below.

**Each window is bound to its page.** The exe remembers the page each label was opened with (`core.html` for `core`, `settings.html` for `settings`, the `page` given to `view_open` for a view). Navigation to anything else, even another page of the app, is refused. So a label's permissions always go with the page they were meant for: `settings` can't be turned into the chat page, a view can't load `settings.html`, and core can't be navigated away.

### The command gate

Tauri 2 checks app commands against capabilities only when the app declares an app manifest. So `build.rs` lists every app command in `COMMANDS`, and a command no capability grants to the calling window is refused with "Command <name> not allowed by ACL" (`tauri-2.12.5/src/webview/mod.rs`, `on_message`). Default deny, by window label. Plugin commands are always checked.

**A capability names the caller, not the target.** Tauri's window commands (`core:window:allow-close` and the rest) take a target label, so a view allowed to close "its" window could close core. So nobody gets any `core:window:*` or `core:webview:*` permission. Window operations go through two native wrappers:

- `window_self(op)`: drag, minimize, toggle maximize, close, on the **calling** window, whose label the exe reads from the IPC request, not from the page's arguments. Views and Settings.
- `window_ctl(label, op)`: show, hide, focus (restoring a minimized one), close, and get or set bounds, on `settings` or a `view-*` window only. Never `core`. Core only.

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
  "description": "Chat and later views: their own window and the log. Nothing else.",
  "windows": ["view-*"],
  "permissions": [
    "core:event:allow-listen", "core:event:allow-unlisten",
    "allow-window-self", "allow-log-line"
  ]
}
```

`capabilities/settings.json`:

```json
{
  "identifier": "settings",
  "description": "The Settings window: key entry, write-only, and a read of the saved addresses. No events.",
  "windows": ["settings"],
  "permissions": [
    "allow-window-self", "allow-log-line",
    "allow-secret-set", "allow-secret-status", "allow-address-list"
  ]
}
```

A view can't open or touch other windows, fetch, start servers, open links, use the WebSocket, notify, register hotkeys, read system state, write or check keys, or emit events. Settings can do none of that either, and can't listen to events.

**Why Settings writes keys directly** (decided 2026-11-14). The other way, sending a typed key to core first, would put it on a `BroadcastChannel`, where every page of the origin can hear it, the chat view included. So Settings calls `secret_set` itself, and nothing anywhere can read a key back, core included.

### The web surface: what the exe pins

**Untrusted content is never HTML.** Model text, card text and tool results are drawn with DOM calls and `textContent`, including any Markdown the app renders, which it builds element by element. That's the app's rule, and the app makes breaking it fail loudly with Trusted Types in each page's own `<meta>` CSP: `require-trusted-types-for 'script'; trusted-types 'none'`. Then any string assigned to `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`, a script's `src` or text, or passed to `eval` throws. It lives in the app, not the exe: the promises above already allow for script running in a page, so Trusted Types guards against the app's own mistakes, and if Tauri's injected scripts turn out to need a sink, the fix is in the app's pages with no exe and no policy name reserved in it. An app test checks every page carries it, and a runner check (below) checks it holds alongside Tauri's scripts.

**The CSP, pinned in the exe** (`app.security.csp` in `tauri.conf.json`, which Tauri sends as a header on every HTML page from `get_asset` in `manager/mod.rs`):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost; worker-src blob:;
frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
webrtc 'block'
```

- No inline script and no `eval`, so `javascript:` links and injected handlers don't run.
- The exe's CSP holds the network and frame rules. A page's own `<meta>` CSP can only add limits, so the app adds Trusted Types and tightens the rest without an exe, but can never loosen these.
- Styles are loose on purpose: with the network closed, CSS can't send anything anywhere.
- `worker-src blob:` and nothing else, so no page can register a service worker, which would sit in front of every page of the origin, Settings included.

**No sandboxed frame for untrusted rendering. Decided now, because the frame rules are in the exe.** A frame with an opaque origin (no IndexedDB, no channel to core) would contain script that got into rendered content. But with no HTML sinks and no inline script, there's no path left for content to become script. The frame would add a second rendering system and a message relay, and that relay would be a new place to forge consent. So `frame-src 'none'` stays. **Residual, honestly:** a bug in the app's own code (not in content), or a compromised dependency, runs as the page and owns the origin, as [above](#what-the-exe-promises-and-what-it-doesnt) says. The native gates still bound it.

**Navigation stays local.** Navigation off a window's own page is refused and logged by scheme only. Unlike Desktop Buddies, nothing is sent on to the browser, because a page could otherwise send data out in a URL with no click. `window.open` is denied the same way. Links go through `open_url`, which asks the person ([5d](#5d-the-rest)).

### Web permissions

The one window helper adds a `PermissionRequested` handler to each WebView2 (through `with_webview`, registered after Tauri's own, so its answer is the last) that answers **deny** to every kind: clipboard read, camera, microphone, location, web notifications, MIDI, sensors, local fonts, window management, file system access and any kind added later, with one exception: kind 13, the request `navigator.storage.persist()` raises, which it allows (decided 2026-11-14 after the runner showed `persist()` asks; a persistent-storage grant gives a page no data and no reach). Measured on the runner (run 43591797436 of `shell.yml`): clipboard read, geolocation, notifications and MIDI reach the handler and are denied within 5 ms with no prompt, kind 13 is allowed every time and no other kind is. So no page can read the clipboard, where a key someone just copied may still be. Pasting with Ctrl+V needs no permission and still works. Familiar's toasts go through the notification plugin, not web notifications. **Measured with the plugin in (run 43597901433 of `shell.yml`):** `tauri-plugin-notification` 2.8.0 adds an initialization script to every page that replaces `window.Notification` with its own, which calls the plugin's commands. So a view's or Settings' `Notification.requestPermission()` no longer reaches the handler: the command gate refuses it (`not allowed by ACL`), within 5 ms and with no prompt, and only core, which holds the plugin's permissions, can show one. The script can't be turned off from the plugin's API. Writing to the clipboard after a click is settled by measurement ([4](#4-plugins)).

### Egress outside fetch

CSP governs fetch, WebSocket, images, styles and forms. It doesn't govern WebRTC's ICE traffic (STUN and TURN), and speculative work such as DNS prefetch and preconnect isn't reliably covered either. So the claim that the guarded fetch is the only way out holds only once every route below is closed and tested. The exe closes them with browser arguments, set now in the one window helper:

```
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection
--autoplay-policy=no-user-gesture-required
--proxy-server=http://127.0.0.1:<sink> --proxy-bypass-list=<-loopback>
--force-webrtc-ip-handling-policy=disable_non_proxied_udp
--dns-prefetch-disable
```

- **A sink proxy the exe owns.** Before any window opens, the exe binds its own listener on `127.0.0.1` at a random free port, with `SO_EXCLUSIVEADDRUSE` so nothing else can take it, and passes that port as `<sink>`. The listener answers every connection with `HTTP/1.1 403`, reads nothing past the first line, and closes. Every request the webview's own network stack makes goes there, so it fails, whatever started it: a beacon, a prefetch, a form, a link's `ping`, a notification icon, anything CSP missed. `<-loopback>` removes Chromium's implicit loopback bypass, so local services are closed too. Familiar's own pages and IPC don't use that stack: `http://tauri.localhost` and `http://ipc.localhost` are answered by WebView2's request interception before any network. The guarded fetch is native and never sees this setting. Step 3 confirms both on the runner.
- **WebRTC** may then only use UDP through a proxy, which Chromium can't do over an HTTP proxy, and TCP through the sink. So it can't reach anything. **Measured on the runner, this is wrong** (runs 43590029085 and 43590687737 of `shell.yml`): WebView2's browser process is given `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (its command line shows it) and ignores it. From core, a view and a view without Trusted Types, an `RTCPeerConnection` gathers host and server-reflexive candidates: STUN binding requests reach a STUN responder on `127.0.0.1`, UDP goes to a LAN address, and the STUN and TURN host names are looked up on the wire and in the DNS Client log. WebRTC was the one route open. **Then measured, run 43591797436 of `shell.yml`**, with the same 42 routes plus seven WebRTC ways in (the page's own constructor, a script-made `about:blank` frame read before any await, a nested one, one read later through a saved reference, `srcdoc`, `object`, `embed` and `frame` elements, and RTC-looking globals left over), one build per closure:
  - `webrtc 'block'` in the exe's CSP alone: ignored by this WebView2. Every WebRTC way open, as before.
  - An initialization script for every frame (`src-tauri/src/no-webrtc.js`) that deletes `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCIceCandidate`, `RTCSessionDescription`, `RTCRtpSender`, `RTCRtpReceiver`, `RTCRtpTransceiver`, `RTCIceTransport`, `RTCDtlsTransport`, `RTCSctpTransport` and `RTCCertificate`: every route closed in all three pages, frames included. Every frame, nested and late frames included, had no constructor; `srcdoc`, `object` and `embed` threw under Trusted Types, and in the view without it they had none either. Only event and error interfaces are left (`RTCTrackEvent`, `RTCPeerConnectionIceEvent` and the like), and none of them leads to a peer connection.
  - `--enforce-webrtc-ip-permission-check` and `--webrtc-ip-handling-policy=disable_non_proxied_udp` with neither of the above: WebRTC gathers nothing, but the TURN server names are still looked up on the wire. Not closed.
  - Both closures together, which is what the exe ships: every route closed in core, a view and a view without Trusted Types, with headless Edge still sending its WebRTC traffic as the control. `egress.core` and `egress.view` pass.
- **DNS prefetch** is off, and with a fixed proxy Chromium leaves name resolution to the proxy anyway.
- **SmartScreen** in the webview is off, because pages are only ever local and it would send URLs to Microsoft.
- **Autoplay** is on so a reminder can play a sound, which could not be added later without an exe.
- The sink counts what it refused, never logging content, so the runner check can see the webview really used it.
- If the runner shows any route still open, promise 2 isn't declared. An initialization script for every frame that deletes `RTCPeerConnection` and its relatives was meant as a stopgap only (an `about:blank` frame might keep its own copy), not a way to declare it. The runner now shows the frames don't keep one (above), so promise 2 rests on that script and the sink, and is checked by the egress gate on every run. Measured: under `frame-src 'none'` a page can still make an `about:blank` frame, and that frame's own `RTCPeerConnection` gathers and sends just as the page's does, so deleting the page's copy closes nothing unless the script also reaches every such frame. Measured too: setting `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` in the environment does not replace the exe's arguments, so the proxy can't be dropped that way.

**Tests** (all in the security inventory, [7](#7-checks-on-the-windows-runner)):

- **Static, on Linux CI every push** (`apps/desktop/tests/capabilities.test.ts`): parses `capabilities/*.json`, `build.rs` and `tauri.conf.json`. It fails if any capability grants a `core:window:*`, `core:webview:*` or event `emit` permission, if `views.json` or `settings.json` grants anything outside its list, if any capability uses a remote URL, if a command in `COMMANDS` has no capability or the reverse, if the TypeScript client in `src/shell.ts` calls a command not in `COMMANDS`, or if the CSP or browser arguments (apart from the sink's port) differ from the pinned strings. An app-side test checks every page in the app folder carries the Trusted Types `<meta>`.
- **The refusal, on the runner**: `view-chat` and `settings` call every core-only command and plugin command with valid arguments, and each must reject with `not allowed by ACL`. `view-chat` calls `secret_set`, `secret_status` and `address_list` and is refused. `settings` calls `plugin:event|listen` and is refused. Core makes the same calls and each reaches its command.
- **Cross-window**: `view-chat` calls `window_self('close')` and only `view-chat` closes. Core calls `window_ctl('core', ...)` and is refused. A view calling Tauri's own `plugin:window|close` with `label: 'core'` is refused by ACL. A view calling `plugin:event|emit` is refused. A view listening for every event name core uses gets nothing while the driver clicks the tray and makes a second launch. `settings` navigating to `chat.html` is refused and stays on its page, and core's `view_open` of `view-x` with `settings.html` is refused.
- **Settings kept apart**: a page calls `navigator.serviceWorker.register` with an app script, and it fails. The driver puts a value on the clipboard, a page calls `navigator.clipboard.readText()`, `getUserMedia` and `geolocation.getCurrentPosition`, and each is refused with no prompt shown, while a paste into a text box in Settings still works.
- **Trusted Types**: core and a view each try `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `trustedTypes.createPolicy('x', ...)`. Each must throw, and IPC must still work.
- **Egress**: a hostile page in core and in a view tries every route it can: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, an `<img>`, a CSS `url()`, a web font, `<link rel=prefetch|preconnect|dns-prefetch>`, an `<a ping>` click, a form POST, `window.open`, `location.assign`, a remote `import()`, a service worker registration, a notification with a remote icon, and an `RTCPeerConnection` with STUN and TURN servers. The targets are the driver's listeners on `127.0.0.1` (TCP and UDP, including a STUN responder), a LAN-looking address, and unique random host names. DNS is watched on the wire: `pktmon` captures UDP and TCP port 53, mDNS (5353) and LLMNR (5355) for the whole check, with the DNS Client operational event log on as well. Pass means no listener saw a packet, and none of the random names is in the capture or the log. **Positive controls** prove the fixtures can see: the driver looks up a random name of its own and sends to each listener itself, and the same hostile page runs once in a headless Edge with no sink proxy, where the listeners and the capture must see its traffic. A control that sees nothing fails the check, and so does a sink refusal count of zero.

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

Whether WebView2 grants it is open. Chromium decides `persist()` by heuristics (engagement, an installed app, notification permission), and WebView2 has no permission kind for it that the exe could answer. **Measured on the runner, the last part is wrong**: each `persist()` call raises a WebView2 `PermissionRequested` of kind 13, which the SDK in `webview2-com 0.39` doesn't name, in the same millisecond. The exe's deny-everything handler answers it, and `persist()` returns false: on a fresh data folder, on a second start, and from a moved install, with `quota` 10737418240 and `usage` 0 each time. So the exe can answer it. **With kind 13 allowed** (run 43591797436 of `shell.yml`): on a fresh data folder `persisted()` is false, `persist()` resolves true, and `persisted()` is true right after; on a second start, and from a moved install, `persisted()` is already true. `estimate()` gives `quota` 10737418240 and `usage` 0 each time. So WebView2 grants it when the exe allows it. **Step 3 measures it**: the check app logs both answers and the estimate on a fresh data folder, on a second start, and after core has shown a notification. After a notification (run 43597901433, a fresh data folder): `persisted()` false, `persist()` granted, the same as without one. These are recorded as INFO, not pass or fail, and the result goes into this file. Nothing native depends on the answer, since the backup commands are in the exe either way.

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

**Toasts need an app id Windows knows.** The notification plugin sets the toast's AppUserModelID to the identifier when the exe isn't in a `target\` folder. Windows only shows toasts for an unpackaged app whose id it knows, from a Start menu shortcut or from `HKCU\Software\Classes\AppUserModelId\dev.exvanitas.familiar` (`DisplayName`, `IconUri`). The exe writes that key at each start (current user, idempotent), so a zip run works like an install, and the uninstaller removes it. **Step 3 checks** that `ToastNotificationManager.CreateToastNotifier('dev.exvanitas.familiar').Setting` reads `Enabled` from PowerShell after a start. Measured (run 43597901433): `Enabled`, read from Windows PowerShell, since PowerShell 7 has no WinRT projections, with the key holding `DisplayName` and `IconUri`. That a toast is really seen, and its buttons, are step 13's, on a real PC.

---

## 5. Native commands

Every command is in `COMMANDS`, takes named arguments, and returns `{ kind, message }` errors with fixed kinds. No error carries a key, a URL's query, a server's output or a file's contents. Bytes go as raw IPC bodies, with the other arguments in a percent-encoded `x-spec` header, as in Desktop Buddies. Rules live in `apps/desktop/shell-core` (plain Rust, no Tauri, `cargo test` on Linux), and `src-tauri` is thin glue. [The inventory](#the-command-inventory) lists every command with its caller.

### The native confirms

Starting a server (5b), adding an address (5c) and opening a link (5d) share one dialog module.

- **What it is**: `TaskDialogIndirect`, owned by the requesting view if it's showing, else top-most with no owner.
- **Nothing changes behind it.** Disabling Familiar's windows (`EnableWindow(false)`) stops the person's input, not script, so the exe also holds a confirm state while a dialog is open:
  - `view_open`, `window_ctl`, `window_self` and any new confirm are refused with `busy`. No new window can cover the dialog, and its owner can't be closed under it.
  - Every Familiar window drops always-on-top for the duration, so one that was already open can't sit over the dialog.
  - The operation shown is a copy the exe made before showing it, and approving acts on that copy alone. Nothing a page sends meanwhile changes it.
  - Each window's enabled and always-on-top state is recorded first and restored on every way out (approve, refuse, close, an error, a window that went meanwhile), by a guard that runs when the dialog call returns, whatever it returned.
- **Defaults against reflexes**: the refusing button is the default, so a stray Enter refuses. The approving button is disabled for the first second (enabled from the dialog's timer callback), so a click meant for the chat window can't land on it.
- **One at a time, and a stop after three refusals**: a second ask while one is open gets `busy`. Refusals and closes are counted across every kind of ask. After the third since the run started, or since the person last re-enabled asking, the exe stops asking (`asks-stopped`) until the person picks "Let Familiar ask again" from an exe-owned tray item. That item is native, so only the person can re-enter. Changing an argument or an address each time doesn't get around it.
- **The file dialogs run as confirms do** (`pick_path`, `save_as`): each holds the same gate, so window operations and asks are `busy` while it's open (one native dialog at a time), and every window is frozen and put back exactly as for a confirm. A file dialog asks nothing, so it counts no refusal and a stop doesn't refuse it. Checked on the runner (`security.files.modal`, run 43611599260).
- **Showing it honestly**: in every free-text field shown (arguments, setting values, labels, URLs), literal backslashes are doubled first, then control characters, bidirectional formatting characters (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069) and invisible or formatting characters (zero-width spaces and joiners, U+2028 and U+2029, the soft hyphen, variation selectors, Hangul fillers, tag characters and the rest of one named list in shell-core) are replaced with visible `\u{...}` escapes. So two different operations never show the same text. Paths and names refuse every one of those characters, so they always show as they are. Host names show in punycode. Labels are cut to 64 characters with an ellipsis and always appear after the fact they describe, never instead of it. The main text is a summary. The dialog's "Show details" area holds the complete canonical operation, so nothing that runs or sends is hidden.

**Tests** (runner): the driver reads each dialog through UI Automation and checks the default button, the disabled first second, the escaped text and the details area. While a dialog is open, core calls `view_open`, `window_ctl('settings', 'close')` on the owner and another `address_add`, and a view calls `window_self`: each gets `busy`, no new window appears, and the owner stays. Core sends a changed operation meanwhile, and approving stores the one shown. After every way out, each window's enabled and always-on-top state is back as it was. It sends three refusals in a row and checks the fourth ask is refused without a dialog until it picks the tray item.

### 5a. Credentials

**Choice: keys are typed into the Settings window, go into Windows Credential Manager, go out only into requests core makes to their own saved address, and never come back to any page.**

```ts
secret_set(ref: string, value: string): void        // settings; from core, peer tokens only (5d)
secret_status(ref: string): { present: boolean, boundTo: string | null, hint: string | null }   // core, settings
secret_delete(ref: string): void                    // core
```

- `ref` is `addr:<addressId>` for a model endpoint or remote server, or `server:<setupId>:<NAME>` for a local server's setting. Anything else is refused (`invalid`).
- One credential per ref: service `dev.exvanitas.familiar`, user the ref, through `keyring::Entry`. The stored secret is `{"v":1,"for":"<address or setup id>","value":"..."}` as UTF-8 bytes (`set_secret`), under Credential Manager's 2560-byte blob limit.
- **Bound to the address, so a changed address needs the key typed again.** For `addr:` refs the exe writes `for` from its own saved-address list, never from the page. A saved address can't be edited: changing a provider's base URL or a server's address in Settings removes the old entry and adds a new one, which has a new id and no key. So the person types the key again, in the Settings window, and an old key can never go to a new address. That's the failure seen elsewhere, where swapping a base URL sent the stored key to the new one. `address_remove` deletes its key.
- **Write-only.** There is no read command. `secret_status` says whether a key is set, which address or setup it's bound to, and a masked hint: the last 4 characters, shown as `…abcd`, only when the value is at least 20 characters long, else null. The hint is computed in the exe at each call, never stored apart from the key.
- **Limits**: a value of 8 to 1024 bytes with no control characters (CR or LF in a key would split a header). Eight is the floor so every secret can be blanked wherever it appears without blanking ordinary text. A value can't contain a marker (`[key]` or `[hidden]`), start with the end of one or end with the start of one, so a replacement can never rebuild a secret. Refs up to 128 characters.
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

**Redaction on every path back.** Every literal copy of the address's stored key, whether or not the request carried it (an endpoint can hold it from an earlier request), and of any other secret the request used, is replaced with `[key]` in every field a page can see: the final URL (raw and percent-decoded), the status text (measured: reqwest exposes only the status code's standard reason, so a server's own reason phrase never reaches a page at all), every header name and value, and the body of every response, any status, any size. A header whose name holds a secret is dropped. A redirect whose target holds a secret, raw or percent-decoded, isn't followed: it ends as `redirect-refused`, so a key can't come back as a path. The one rule and matcher serve `net_fetch`, server output ([5b](#5b-starting-a-local-mcp-server)) and WebSocket messages ([5d](#5d-the-rest)).

**The streaming matcher.** A body is redacted as it streams by an incremental matcher (Aho-Corasick over the address's stored key and every secret that request used) that holds back only the longest tail of the output so far that could still be the start of one of them, and nothing else. Ordinary text with no secret prefix at its end passes at once. So an MCP server that sends one complete SSE event and then waits for the next request gets that event straight away. A chunk that produces no output doesn't end the read: `net_read` waits for the next chunk, and returns empty only at the real end of the body, when the held tail, which can't be a whole secret, is released. Literal copies only: an endpoint that returns the key encoded some other way defeats it, so **the recipient of a key is trusted**, which it already is, since it's the service the key belongs to.

**JSON-escaped copies, in the pre-release native pass** (lead, 2026-11-16). One encoding isn't a choice of the recipient: JSON. A secret holding a quote, a backslash or a control character appears as `\"`, `\\` or `\u00XX` in JSON, which a model API or an MCP server writes as a matter of course, and core's `JSON.parse` turns it back into the secret. So from the native pass the matcher holds, for each secret, its literal form and the JSON-escaped forms common serializers write (JavaScript's and Python's defaults: a quote, a backslash and control characters escaped, and optionally `/` as `\/` and every non-ASCII character as `\uXXXX`), and blanks any of them. It stays bounded: a small fixed set of patterns a secret, each at most six times the secret's 1024 bytes. It serves every path back: the guarded fetch's responses, server output ([5b](#5b-starting-a-local-mcp-server)) and WebSocket messages. Until then a secret without quotes, backslashes or control characters is blanked whole. The runner measures it as `security.mcp.secret-json-escaped`, a known gap in everyday runs that fails the release gate while it's open ([7](#7-checks-on-the-windows-runner)).

**What the guarantee is, worded honestly.** A key reaches only its own saved address, and no page can read it back, except the Settings window while the person types it. A page running bad script can still *use* a key through Familiar, while Familiar runs, at its own address. It can't carry it away.

**Entering a key: in the Settings window** (decided 2026-11-14, [Decisions](#decisions)). Settings has a password field and calls `secret_set` itself, then clears the field. The key never touches IndexedDB, a channel or core. Four safeguards come with it:

1. **A separate window.** Settings never draws model, card or tool text, has its own channel and capability set, and the routes by which chat's script could reach it are closed ([2](#windows)).
2. **Write-only storage.** The key goes straight to Credential Manager, and pages see only "set" and the masked hint.
3. **Core makes every request with the key**, through the placeholder swap, and only to the key's own address.
4. **A changed address needs the key typed again**, in Settings, because a key is bound to one saved address.

The field is `type=password` with `autocomplete=off` and `spellcheck=false`, and the window helper turns WebView2's form autofill and password saving off (`IsGeneralAutofillEnabled` and `IsPasswordAutosaveEnabled`, both false), so nothing the person types is kept in the WebView2 profile.

**Tests.** shell-core: ref parsing, the value rules, the swap (only those headers, exact match, `no-key`), and the matcher: every split of every secret across two and three chunks, two secrets overlapping, a stream that is one long near-miss, and that output not followed by a secret prefix is released in the same read. On the runner:

- The driver types a random fake key into Settings' password field with real key presses (so autofill would have seen it) and Settings saves it for `addr:<id>`. `secret_status` says present and bound, with the right hint for a long key and none for a short one. The driver finds the target name in `cmdkey /list`.
- **Rebinding**: Settings stores a key for address A, then core removes A and adds A' with another base URL. `secret_status` for A' is not present, a fetch under A' with the placeholder is `no-key`, A's fake server never sees a request after the removal, and A's credential is gone from `cmdkey`.
- Core fetches the fake server with the placeholder, and the fake server answers with a SHA-256 of the header it got, which must match the fake key's.
- **Echo routes**: the fake server sends the key back literally in a response header value, in a header name, in the status text, in a 200 body, in a 401 body, in a 300 KB body, split across two chunks, and as a redirect to `<saved path>/<key>`. The page must see `[key]` or a dropped header every time, the redirect must end as `redirect-refused`, and the fake server must see no request to the key's path.
- **Live streams**: the fake server sends one SSE event, then keeps the connection open and quiet for 30 s. The event must reach the page within 100 ms, and the read must not end early.
- Core removes the address. The fetch is then `not-saved`, and the credential is gone from `cmdkey`.
- Last, the driver searches every file under the data folder, the WebView2 folder and the log, in UTF-8 and UTF-16, for the fake key's bytes, and must find none.

### 5b. Starting a local MCP server

**Choice: the exe starts only a setup the person approved in a native dialog, exactly as approved, in its own kill-on-close job, with a minimal environment, and blanks the setup's secrets from everything it prints.** The mcp-start spike (`spikes/mcp-start/RESULT.md`, two green runs on `windows-latest`) proved the starting parts, and this follows it.

```ts
server_start(setup: Setup, owner?: string, channel: Channel<ServerEvent>): { run: string }
server_write(run: string, body: bytes): void         // to stdin, at most 4 MiB a call
server_stop(run: string): void
server_forget(setupId: string): void                 // revokes its starts under way, stops its runs, removes the approval

type Setup = { id, label, program, args: string[], cwd, env: [name, value][], secrets: string[] }
type ServerEvent = { t: 'out', line } | { t: 'err', line } | { t: 'exit', code: number | null }
```

**Checking, before any filesystem access:**

- `program` (when it's a path) and `cwd` must be plain local absolute paths: a drive letter, a colon, a backslash, then plain names. UNC paths (`\\server\share`), device and namespace paths (`\\.\`, `\\?\`, `\??\`), drive-relative paths (`C:foo`), alternate streams and `..` are refused as `unsafe-path` before anything touches the disk.
- **The drive must be local.** Syntax can't tell `Z:\` on a mapped share from a local disk, so before any file access the exe asks `GetDriveTypeW` about the drive's root, which reads the drive table and touches no share. Only `DRIVE_FIXED` and `DRIVE_REMOVABLE` pass. `DRIVE_REMOTE`, `DRIVE_CDROM`, `DRIVE_RAMDISK`, `DRIVE_UNKNOWN` and `DRIVE_NO_ROOT_DIR` are `unsafe-path`.
- **No link may lead off the local disk.** The exe then walks the path from the root one name at a time, opening each with `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, which never follows a link. A name that is a reparse point has its reparse data read (`FSCTL_GET_REPARSE_POINT`) without following it. A symbolic link or junction passes only if its target is itself a plain local path that passes these same checks, at most 8 links deep. A target on a share (`\??\UNC\` or `\\`), on a remote drive, or a volume GUID path that isn't a local fixed or removable volume, is `unsafe-path`. An app execution alias (`IO_REPARSE_TAG_APPEXECLINK`, as Store apps install) is allowed only as the program itself, the last name. Every other tag is refused, cloud placeholders such as OneDrive's among them, since opening one can start a download.
- So nothing about a setup can make network traffic before the dialog, and the walk is repeated just before starting, so a link changed in between is caught. **What the walk doesn't cover:** another program running as the person could swap a folder for a link between two opens. It could just as well make that traffic itself, so the walk guards against what a setup names, not against other programs on the PC.
- Paths also refuse every control character and every character in the confirms' invisible list, and every name is a plain name: no device names, including `COM0` to `COM9`, `LPT0` to `LPT9`, `COM¹` to `COM³`, `LPT¹` to `LPT³`, `CONIN$`, `CONOUT$` and `CLOCK$`, with or without an extension.
- Arguments with NUL, CR or LF are refused for every program (`unsafe-argument`), so a setup doesn't work with `node` and fail with `npx`. Any other `InvalidInput` from `spawn` becomes the same error. Limits: 64 arguments, 32 settings, 32 secret names, 8 KiB for the whole setup, small enough that the details area shows all of it.
- **Setting names are ASCII and case-insensitive.** A setting or secret name is ASCII letters, digits, `_`, `-` and `.`, not starting with a digit, up to 128 characters, so upper-casing is exact. Names are compared upper-cased, as Windows does, and two that differ only in case are refused (`duplicate-setting`). Values with NUL are refused. The spike didn't run these checks, so step 3's tests are the first.
- **Known settings that change what runs can't be secrets**, as defence in depth. `PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `WINDIR`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `DOTNET_STARTUP_HOOKS`, and every name starting `NPM_CONFIG_`, `UV_`, `PIP_`, `COR_` or `CORECLR_`. A setup that lists one of them in `secrets` is refused (`unsafe-secret`). As plain settings they're allowed, and their values are part of the approval, so changing one asks again. The list lives in shell-core and in the capability matrix. It can't be complete: any server or wrapper can read its own variable as a path to run. So the claim is only the one in promise 3. Approval binds the launch and the secret names, secret values can change without asking again, and a server that treats a secret as code is trusted with it.

**Resolving** (the spike's way): a bare name is looked up in absolute local PATH folders only (a PATH entry that fails the path checks above, UNC, remote drive, a link off the local disk or relative, is skipped without being opened), never the working folder, in PATHEXT order, and only `.exe`, `.cmd` or `.bat`. That picks `npx.cmd` over `npx.ps1`, which the spike showed matters. The resolved full path is what the dialog shows and what's stored, so a later PATH change can't swap the program silently. If the program or the folder is reached through a link, the walk's final target is stored and shown too, and the check before starting walks again and compares it, so retargeting the link is refused (`unsafe-path`) until it's approved again. An app execution alias's target is the alias itself.

**A start launches the approved value, and only it.** The walk made for the approval gives the canonical form, and the setup's actor holds that form as a value from then on, on both paths: approved before (the stored form equals it) and approved just now. The spawn is built from that held form alone (`shell_core::setup::Plan`): the program and folder as approved, the arguments, the plain settings and the secret names. Never from the setup the page sent, and never from a walk made after the approval. The walk is made again just before the spawn and once more after it, with the image mapped and before any of it runs, and each time it must find exactly the held targets, or the start is refused `unsafe-path` and the suspended child ended. Measured on the runner (`server.retarget`): a program reached through a junction starts as the control; with the junction moved to another folder holding another copy of `node.exe` while the dialog was up, the approved start was `unsafe-path` with no `node.exe` left. Before this, the spawn walked `setup.program` afresh, so its check compared the new target with itself.

**The approval.** The exe keeps approved setups in `shell\servers.json`, which only it writes, atomically (a temp file then a rename). If the file can't be read, nothing counts as approved: it's renamed aside, logged, and every setup asks again. The canonical form is the resolved program and its final target, the arguments, the folder, the plain settings with their values, and the secret names. Secret values aren't in it, so a renewed token doesn't ask again. `server_start` compares that form with the stored approval for `setup.id`:

- **Equal**: it starts, with no dialog and no confirm state involved: an approved setup starts while asks are stopped or a dialog is open (decided after review: the stop is about not asking, and starting a server opens no window). So the order is the syntax, the walk (local only, it can't make network traffic), the canonical form, then this comparison, and only a new or changed form reserves the confirm, where `busy` or `asks-stopped` ends it.
- **Different or new**: the confirm dialog. Title "Start a program?". The summary names the server, the resolved program, the arguments, the folder, each plain setting as `NAME=value`, and each secret as `NAME (kept in Credential Manager)`, then "It runs as you, with your files. Only start programs you trust." The details area holds the canonical form, one argument per line. Buttons "Start it" and "Don't start". "Start it" stores the approval and starts. Otherwise `declined`.
- A page can't fake or skip it: the dialog is drawn by Windows, in no webview, and nothing but the person's click writes `servers.json`.

**What approval doesn't cover, honestly.** Pinning `npx.cmd` doesn't pin what `npx` then fetches and runs, nor what it finds on the inherited `PATH`. The inherited allowlisted values (`PATH`, `APPDATA` and the rest) aren't in the approval, because anything that can change them already runs as the person. Once started, a server runs as the person.

**Starting** (the spike's sequence):

1. `env_clear`, then the 22 names of the spike's `ENV_ALLOWLIST` that exist, then the plain settings, then each secret read from Credential Manager by `server:<id>:<NAME>`. Nothing else from Familiar's environment reaches the server. The spike saw 23 variables reach it out of the parent's 147.
2. `CreateProcess` with `CREATE_NO_WINDOW | CREATE_SUSPENDED`, stdin, stdout and stderr piped.
3. A new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`, the process assigned, then its thread resumed. If making the job, assigning or resuming fails, the suspended process is terminated, its handles are closed, and `server_start` returns `start-failed`, so nothing is left half-started. Just before resuming, under the lock that holds the runs, a start whose setup was forgotten since it began is refused (`revoked`), and otherwise the run joins the list, so a forget from then on finds it and stops it. Creating the process inside its job (`PROC_THREAD_ATTRIBUTE_JOB_LIST`) needs `CommandExt::raw_attribute`, which Rust 1.95 doesn't have stable, so a hard kill between the spawn and the assignment could leave a suspended process in no job: each child is recorded from its spawn until the start returns, and each start of the exe ends what such a record names, matched by process id and creation time. One job per server, its handle not inheritable and held only by the exe. In the spike, killing the app hard ended all 14 processes of three servers within 18 ms. Without the job, a busy server lived on.
4. stdout is read line by line on its own thread. A line over 4 MiB is dropped with an `err` event saying so. stderr lines are cut at 8 KiB. Both go to core over the channel core passed in, which only core receives.
5. **Before a line leaves Rust**, every secret value of the setup is replaced with `[hidden]`, on stdout and stderr both. Secrets are at least 8 bytes, so all of them are blanked. From the pre-release native pass, each secret's JSON-escaped form is blanked too ([5a](#5a-credentials)): a server that prints its secret inside JSON escapes a quote in it, and core's `JSON.parse` would rebuild it.

**The job is lifecycle control, not a security boundary.** It makes servers stop with Familiar. A server can still start work outside it (a scheduled task, another app), and can read or change anything the person can, `servers.json` included.

**Stopping.** `server_stop` closes stdin and, 500 ms after it began (an idle server exits in about 100 ms), ends the job with `TerminateJobObject`. Writes go through a writer thread of each server's own and are bounded to 8 in flight or 16 MiB, past which a write is `busy`, so a server that stops reading can block a write but never a stop, and ending the job breaks the write. When a server's program exits its job is ended too, so a grandchild that inherited its output can't hold it open, and the output then drains for at most 2 s before core hears `exit`. When Familiar exits or crashes, the kernel closes the job handle and that ends the tree, with no code.

**Limits.** 16 servers running or starting at once (`busy` past that), one run per setup at a time (a second start of a setup that's starting, running or stopping is `busy`), and 32 commands queued for one setup (`busy` past that).

**One owner per setup.** The exe's server manager owns the slot count, a map of setup id to that setup's actor, and the one writer of `servers.json`, which applies one read or write at a time and answers each once it's durable. Each actor is a thread that owns everything about its setup: the run if any, its job, its stdin writer and its sweep record. It handles one message at a time from its bounded queue, following explicit states, each transition logged (`shell_core::actor`, where every state meets every message in a test):

| State | Means | A start | A stop | A forget |
| --- | --- | --- | --- | --- |
| Idle | Nothing runs | Takes a slot, goes to Asking | `missing` | Forgetting |
| Asking | The walk, the approval check and, if the form is new or changed, the dialog | `busy` | `missing` | Forgetting: the answer is never stored and the start is `revoked` |
| Starting | The approval stored; the child made, suspended, in its job | `busy` | `missing` | Forgetting: the child is ended before it resumes, the start `revoked` |
| Running | The child runs | `busy` | Stopping | Stopping, then Forgetting |
| Stopping | Input closed, the job ended at the deadline | `busy` | Joins it | Forgetting once the run has ended |
| Forgetting | The approval being removed, an old attempt still in flight, or a removal that failed | `revoked`; after a failed removal with nothing in flight, it retries the removal and asks only if that succeeded | `missing` | Joins a removal under way; after a failed one, retries it and answers its result |

**Every caller is answered exactly once, and every run has a generation.** Each command reaches the machine with a token, and each token ends in exactly one reply, or, for a write, one hand-off to the run's writer, which answers it. No state lasts without a pending event that leaves it, except Idle and Running: a second forget while the first is removing joins it, and one after the removal is answered at once. Each start attempt takes a new generation. The run id `server_start` returns names it, and `server_write` and `server_stop` carry it, as does every report from a helper thread and every stop deadline. The actor drops anything whose generation isn't the current one, so a late deadline, exit or command for a run that's over never touches the next run of the same setup, and a stale "spawned" report is answered abort, so its child is ended rather than left waiting. A property test in shell-core checks both over 5,000 seeded random sequences of commands and reports (60 steps each, then every pending report delivered): each token answered exactly once, every run ends Idle or Running, and each effect only for its own generation. Four deliberate breaks (a deadline, a write or a stop applied to another run, and a second forget left waiting) each fail it.

A forget answers once the removal is durable, and its setup takes no start until then. **A failed removal is kept, never discarded.** Until a removal succeeds, the setup stays Forgetting: every later forget retries the removal and answers its result, so none can report success over the failure, and no start is admitted (`revoked`). A start with nothing in flight retries the removal itself and asks only if it succeeded, so an approval the person asked to forget is never used again without a new dialog. Found in review: with an approved setup's ask still out, a failed removal followed by a second forget answered that forget with success, and once the ask settled a start could use the approval still on disk without asking. A unit test runs exactly that sequence, and the property test fails one removal in three and checks that a forget succeeds only with the approval gone and that no start is admitted with a forgotten approval on disk. On the runner (`server.forget-failed`), with the shell folder unwritable while a changed start of an approved setup waits at its dialog, both forgets fail, the held ask approved is `revoked`, an unchanged start is `revoked` before any dialog, and once the folder is writable the next start asks. What this doesn't cover: the failure lives in the running exe, so after a restart with the removal still undone, the approval on disk counts again. A resume failure goes from Starting back to Idle, with the child reaped and the slot returned, and so does a failure to write the sweep record. Blocking work (the walk and the dialog, the spawn, pipe writes, waiting on the job) runs on threads of its own, which report back as messages, and every server command only sends a message and awaits the reply, so no command ever blocks one of Tauri's async workers. Autostart's registry calls run on a blocking thread too. A lint reads every command of the exe's server, file, system and notification files for waits outside a hand-off, but a lint isn't proof; the proof is `server.write-flood`, which passes only if `security.exec.responsive`'s async probe (`shell_info`, an async command like the others, every 50 ms for 1 s) has its longest answer under 100 ms while the 8 writes in flight are held against a server that never reads. The sweep runs in the manager at each start, before any actor exists, one record at a time (`shell_core::records`). A record is deleted only after it's been read and its process ended or proven gone. Ended means terminated and its process handle signalled, waited for at most 5 s, since `TerminateProcess` only starts the termination; a timeout or a failed wait keeps the record. Proven gone means `OpenProcess` saying `ERROR_INVALID_PARAMETER` (no such process), or a creation time that doesn't match the record's. Any other failure (access denied, an unreadable creation time, a failed terminate, a failed read or delete) keeps the record for the next start and is logged. A record that can't be parsed names nothing that can be ended but may be a child's only trace, so it's renamed aside (`.unreadable`) and logged, never deleted. A temp file a hard kill left before its rename is read as a record too. On the runner the System process (id 4) gives access denied, and the sweep keeps its record. Chosen after the third review round found four races with one cause: a setup's state changed under different locks at different moments, with no single owner.

**Tests.** shell-core: the path rules (every refused form, and that none of them reaches a filesystem call, checked with a fake filesystem that fails the test on any touch), resolution on a fake PATH, the setting rules, the canonical form (a changed argument, folder, plain setting or secret name changes it, a changed secret value doesn't), the blanking. On the runner, against `tools/fake-mcp-server` started as `node <repo>\tools\fake-mcp-server\src\main.ts`:

- A first start shows the dialog. The driver checks the resolved `node.exe` path and each argument in its details and clicks "Start it". `initialize` and `tools/list` work over the channel.
- A second start shows no dialog. A changed argument (`--variant b`) shows it again, and "Don't start" gives `declined`. `node_options` and `NODE_OPTIONS` together are `duplicate-setting`. `NODE_OPTIONS` as a secret is `unsafe-secret`. A UNC program and a UNC folder are `unsafe-path`. So are a program on a mapped drive (the driver maps `Z:` to `\\localhost\C$` with `New-SmbMapping`), a folder reached through a junction and through a directory symbolic link that point at `\\localhost\C$`, and a program reached through a link to the mapped drive. Through all of these the driver's SMB measures show nothing new: the client's connection list (`Get-SmbConnection`) and the SMB server's open count (`\Server\Files Opened Total`). Each sample must be present, and a positive control that really uses the share must move both. `pktmon` can't be the measure here: SMB to the runner's own share is loopback traffic, which it never sees (measured in step 3). A junction to a local folder passes.
- `print_secret` comes back with `[hidden]`, and the driver's search finds the secret in no file. `list_env` shows only allowlisted names and the setup's own.
- **Failure paths**: the driver runs `familiar.exe` inside a job of its own that allows only a few processes, so creating a server fails, and checks that `start-failed` comes back and no suspended process is left. A program that exits at once reports `exit`.
- **Crash recovery**: the driver kills the exe while an approval is being written, and replaces `servers.json` with garbage. The next start asks again and never starts unasked.
- **Races**: `server_forget` and `server_stop` while a call runs, then a hard kill of `familiar.exe` with a `slow` call in flight. No `node.exe` from the setup is left 2 s later.
- `npx`, `uvx` and the 20 kinds of tricky argument through `npx.cmd` are proven by the spike and aren't repeated. A console flash seen by eye, and Smart App Control on binaries that npm or uv download, are step 13's, on a real PC.

### 5c. The guarded fetch

**Choice: one fetch path for every model endpoint and remote server, `net_fetch`, which reaches only saved addresses. It replaces the HTTP plugin entirely.** With the CSP and the webview's sink proxy, it's the only way out of Familiar to the network, once the egress checks pass.

**Saved addresses** come first:

```ts
address_list(): Address[]
address_add(kind: 'model' | 'server' | 'peer', url: string, label: string, owner?: string, ports?: [first, last]): Address
address_remove(id: string): void       // ends its open requests and sockets, deletes its key

type Address = { id, kind, url, label, reach: 'public' | 'lan' | 'loopback', ports?: [first, last] }
```

- `url` is normalized: scheme and host lower case, the host as punycode, one trailing dot dropped, the default port dropped, no trailing slash. A URL with user info, a query or a fragment is refused (`invalid`), not quietly trimmed, so what's approved is what was typed. A path holding `%2e`, `%2f` or `%5c` in any case is refused too, since a server that decodes before removing dot segments could read it as leaving the saved path. `https` is required unless `reach` is `lan` or `loopback`. `peer` addresses are `ws://127.0.0.1` only, with no port in `url` and a range of up to 16 consecutive ports in `ports`, so one approval covers an app that listens on whichever port of its range is free. No port numbers live in the exe.
- **Literal IP hosts are classed directly** and never resolved: `127.0.0.0/8` and `::1` are loopback, the private ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`) are lan, IPv4-mapped IPv6, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) are classed by their IPv4. Any other IPv6 literal is public only inside `2000::/3` and outside its special ranges (all of `2001::/23`, which holds Teredo and documentation, among them), and refused otherwise. Link-local (`169.254/16`, `fe80::/10`, which holds the cloud metadata address), unspecified, multicast, broadcast, `0/8`, `240/4` and the documentation ranges are refused always. `localhost` and every name under `.localhost` are loopback with no lookup.
- **Adding goes in this order, and nothing touches the network before the person says yes.** A name in a URL can carry data to whoever runs its DNS, so a lookup before approval would itself be a way out.
  1. Normalize and check the URL's form, with no network access. A malformed URL is `invalid`.
  2. If an identical address is saved, return it with no dialog. An address's identity is its kind, its normalized URL and, for a peer, its whole port range. A peer with a different range is a different address, with its own approval, its own id and no key.
  3. Check the confirm state: `busy` or `asks-stopped` end it here, before any lookup.
  4. Ask, with the confirm dialog: "Let Familiar send to this address?", the normalized URL with the host on its own line in punycode, what it is ("a model endpoint", "an MCP server", "an app on this PC"), and for a literal lan or loopback address "on your own network" or "on this PC". A peer shows its label and range in one line, for example "Desktop Buddies on this PC, ports 47110 to 47114", or "port 47110" for a range of one. Buttons "Allow" and "Don't allow".
  5. Only after Allow, resolve a name once and class it: all-loopback answers make it loopback (Ollama at `http://localhost:11434`), all-private make it lan (LM Studio on another PC), all-public make it public. Mixed or empty answers, or `http://` on a name that comes out public, are refused, and nothing is saved. That lookup is egress the person just approved.
- The list is in `shell\addresses.json`, which only the exe writes, atomically, and an unreadable file counts as an empty list.

**The fetch**, pull-based like the HTTP plugin's, since the pi-ai spike proved that shape:

```ts
net_fetch(spec: { id, address, url, method, headers: [name, value][], maxBytes?, headersMs?, idleMs? }, body?: bytes)
  : { status, statusText, headers: [name, value][], url, redirected }
net_read(id: string): bytes          // waits for output, empty only at the real end
net_cancel(id: string): void         // at any moment, before or after the head

// in the app, apps/desktop/src/net.ts
guardedFetch(address: string): typeof fetch
```

- `id` is chosen by the page (128 random bits), so `net_cancel` works before the head arrives. A reused id is refused.
- `address` is a saved address id of kind `model` or `server`, and `url` must be under it: the same origin, with a path under the saved path at a segment boundary and no `%2e`, `%2f` or `%5c`. Otherwise `not-saved`. There is no other mode: no unsaved loopback, no port of the page's choosing.
- **Where it may connect.** Directly, only to addresses of the saved address's `reach`. Behind a system proxy, a public address's connection is the proxy's to make, so there the private-network rule rests on the proxy (next point). A literal IP is checked against the address's `reach` before connecting. A name goes through a custom `reqwest::dns::Resolve` that uses a lookup's answers only if every one is of the address's `reach`, and refuses the whole set otherwise, for every connection, a redirect's included; reqwest then connects only to those answers while TLS still checks the certificate against the name. So a public name that later resolves to `127.0.0.1` or `10.0.0.5` (DNS rebinding), or to a lan and a loopback address at once, gets `blocked-address`.
- **With a system proxy.** Public addresses use the Windows system proxy (reqwest's default reading of the per-user settings), because some networks have no other way out. **Measured:** reqwest reads the proxy when a client is built, so a public address gets a client made for its request and follows a proxy changed while Familiar runs; lan and loopback clients, which never use one, are kept. On the runner a public address went through a logging proxy set as the per-user system proxy, and a loopback and a lan address didn't (`shell.yml` run 43600729402). Then the proxy, not Familiar, resolves the name and picks the destination, and reqwest can't check where a CONNECT tunnel really lands. **So behind a proxy, the private-network guarantee rests on the proxy.** Familiar still refuses literal private IPs, still resolves the name itself first and refuses a non-public answer, and never sends lan or loopback addresses through a proxy. `net_proxy` tells core and Settings the setting's kind (`none`, `manual`, `auto-detect` or `pac`) and whether the fetch uses it, which it does for `manual` only, so Settings can say when a proxy is in use. A PAC script isn't supported (see [8](#8-what-could-force-another-exe)).
- **Redirects**: up to 5, each target checked with the same rules and required to be under the same saved address. Anything else is `redirect-refused`. Since the target stays under the saved address, the key stays with the address it's bound to.
- **TLS**: rustls with the platform verifier, so roots installed on the PC, such as a company's, are trusted as Windows trusts them. Step 3 confirms on the runner that a `https` fetch to a public test host works and a self-signed local `https` server is refused.
- **Headers**: up to 64 request headers of up to 8 KiB each. `host`, `content-length`, `transfer-encoding`, `connection`, `keep-alive`, `te`, `trailer`, `upgrade`, `expect`, `cookie` and `proxy-*` from the page are dropped. There's no cookie store, and `set-cookie` is dropped from responses. The key swap and redaction happen here ([5a](#5a-credentials)).
- **Limits**: request body up to 16 MiB. Response headers up to 64 KiB. `maxBytes` defaults to 32 MiB with a hard cap of 256 MiB, counted after decompression, so a small compressed body can't expand past it. Connect 20 s. `headersMs` (time to the head) and `idleMs` (between chunks) default to 120 s, capped at 15 min. No total limit, so a long reply streams for as long as it keeps coming. Up to 32 requests open at once.
- **Streaming and stopping.** `guardedFetch` returns a `Response` over a pull-based `ReadableStream`, each pull one `net_read` of up to 1 MiB, counted after redaction, so no limit ever cuts a body before its secrets are blanked. On the signal it calls `net_cancel`, which aborts the request task and drops the connection. A pending `fetch` then rejects, and the stream errors, with `new DOMException('Aborted', 'AbortError')`, as the browser's own fetch does. (The spike's Tauri shape, a plain `Error`, passed the contract too.) A signal already aborted never reaches the exe. Removing the address mid-request ends the request with `revoked`. Deleting its key mid-request doesn't touch a request already sent, and the next one gets `no-key`.
- **Errors**: `not-saved`, `insecure`, `blocked-address`, `redirect-refused`, `no-key`, `too-large`, `timeout`, `tls`, `network`, `cancelled`, `revoked`, `busy`, `invalid`. A thrown error is a `TypeError` with `cause.kind`, as fetch's network errors are, so pi-ai's adapter sees a network failure and Familiar's wrapper reads the kind. **Measured:** that holds for the `fetch` call and for reads from `response.body`'s stream. Read through `text()` or `json()`, a stream error reaches the page as a plain `TypeError` without the cause, as the browser's own fetch does (`shell.yml` run 43600729402), so code that needs the kind reads the stream.

**One owner of the state.** Every saved address's and every request's state belongs to one owner, a state machine in shell-core (`owner`) that the exe keeps behind one lock, never held across a wait. Each event is one transition there, and whatever a transition ends is ended in the same step: the request's waits are woken and its connection dropped.

- **An address** is `Saved`, `Removing` or `Removed`. A removal makes it `Removing` at once: every request under it ends `revoked`, and new requests and key writes are refused. Once every one of those requests' transports has terminated and no key write is running, the removal is made durable before anything irreversible: the entry is written to the list as `removing`, then its key is deleted, then the list is written without it, and only then is it `Removed`. A failed step leaves it `Removing`, still listed and still refusing everything. That holds across a restart: an entry loaded as `removing` starts `Removing`, and the start finishes the removal, so an address never comes back saved without its key. Nothing under it is left in flight to redact: each request carried its own copy of the key for redaction, and the removal waited for them all to terminate.
- **A request** is `Registered` (its address checked, nothing touched yet), `Resolving` (its key read and, for a public name, Familiar's own lookup, together under a 20 s deadline that ends it `timeout`), `Sending`, `Streaming`, then `Ended` with a kind, or done at the real end of its body. Registration checks the address and opens the request in one step, so a cancel lands either before it (the id is ended, and the registration refused `cancelled`) or after it (the request ends); never between. A request's transport, from its lookup to its last byte, is one task that owns the connection and answers `net_read`; it tells the owner when it has terminated, on every way out. `net_cancel` and a removal end the request in the owner and return, or go on, only once its task has terminated, so nothing of it is sent after a cancel returns. Every wait polls the request's stop signal first, so an ended request never polls its send again, and checks the state on leaving. The request's helper work belongs to that lifetime too: its key read and every lookup (Familiar's own pre-check and the resolver's, each request with its own client) run as its helpers, a helper starts only while the request runs, and the task tells the owner it has terminated only once every helper that started has finished. So no lookup of a request happens after its cancel returns, and one still queued then never starts.
- **A key write** for an address is a transition too: it may start only while the address is `Saved`, and is counted until it's done, so a removal deletes the key only after it.
- **No command waits on an async worker.** Every network-side command is async, and anything that blocks (the dialog, a lookup, a file or credential call) runs on a blocking thread; the dialog itself has a thread of its own. The log never blocks anyone: a line is queued for the log's own thread, and a full queue drops it and counts it. Flushing it before an exit has one deadline (1 s) for queueing the request and hearing it back, so an exit, the forced one included, never waits on a stalled log. A lint reads the source for the shapes that block; the proof is the runner's `security.exec.responsive`, which times `shell_info`, an async command answered where every command runs, while open fetches, a stalled lookup and an open dialog are each held, and which must catch a control build whose helpers block those threads on purpose.

**Tests.** shell-core: normalization, classing (every reserved range, mapped addresses, odd literal forms such as `127.1` and `0x7f.1`, which are normalized first), the under-address rule, redirect decisions, header filtering, the limits. On the runner, with a small Node server in `shell-check` on `127.0.0.1`, a TLS listener, a logging proxy, and `hosts` entries the driver writes and restores (the runner is admin):

- Before Allow, a fetch is `not-saved`. The dialog adds the address on Allow and not on Don't allow.
- A 40-chunk stream arrives whole. A stop after chunk 3 rejects within 100 ms, and the server sees the connection close. A stop before the head, and `address_remove` mid-stream (`revoked`), both leave nothing open on the server.
- `headersMs` and `idleMs` time out. A body past `maxBytes` gives `too-large`, and so does a gzip bomb.
- A redirect inside the saved address is followed. One to another path, to an unsaved host, and to `https://127.0.0.1` from a public address give `redirect-refused`.
- **No lookup before Allow**: core adds `<random>.familiar-check.test`, and the driver refuses. The `pktmon` capture and the DNS Client log hold no query for it. A fourth ask after three refusals makes no query either. After Allow, the lookup appears. A peer saved for ports 47110 to 47114 and then added for 47110 to 47115 asks again and gets a new id.
- **Changing DNS**: `familiar-check.test` maps to a public address while it's added (so it saves as public), then the driver maps it to `127.0.0.1` and clears the DNS cache. The next fetch is `blocked-address`.
- **Literal addresses**: `http://[::ffff:127.0.0.1]:<port>` saves as loopback. `http://` to a public address is `insecure`. `http://169.254.169.254` can't be saved.
- **Proxy**: the driver sets the per-user system proxy to its logging proxy. A public address goes through it, a lan and a loopback address don't, and a literal private IP is still refused.
- The key swap and every echo route ([5a](#5a-credentials)).
- In step 4, not step 3: the model-port contract runs over `guardedFetch` in the real webview against the same server, with recorded OpenAI, Anthropic and Gemini streams, every case (`check.model.contract`, and `security.model.key-swap` for the key). Step 3 keeps the broker's own security, streaming, redaction and cancellation tests.

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
| `system()` | `{ userState, idleMs, locked }` | `userState` from `SHQueryUserNotificationState`: `normal`, `fullscreen` (a D3D game or any full-screen app), `presentation`, `busy`, `quiet` (Windows' quiet time), `away`. `idleMs` from `GetLastInputInfo`, for the rules' "back after 20 minutes". `locked` from `WTSQuerySessionInformation(WTSSessionInfoEx)`'s session flags, for the moments (owner, 2026-11-16: "add lock"), **built in the pre-release native pass**: `true`, `false`, or `null` when the read fails, never a guess. The log says so at most once a minute. Core treats `null` as no change after a confirmed lock ([moments.md](moments.md#signals-what-core-reads)). Battery is left out until a feature uses it |
| `tray_pinned()` | `pinned`, `not-pinned` or `unknown` | Reads `HKCU\Control Panel\NotifyIconSettings`, undocumented, so defensively: `pinned` only if exactly one subkey's `ExecutablePath`, with known-folder prefixes expanded, is this exe's own path, compared case-insensitively, and its `IsPromoted` is 1. A missing key, no match, two matches, a wrong value type or any read error gives `unknown`. Other subkeys are compared and dropped, never returned or logged. Read fresh on every call, with no cache. Answered from a blocking thread. **Built in the pre-release native pass**, for the tray bubble ([design.md](design.md#where-reactions-show-in-part-1)) |
| `program_find(name)` | `found` or `not-found` | For step 7's prerequisites check. `name` only from a fixed list compiled into the exe: `node`, `npx`, `uv`, `uvx`, `docker`, anything else `invalid`, so it can't probe for other programs. Looked up as `server_start` resolves a program ([5b](#5b-starting-a-local-mcp-server)): absolute local folders on `PATH`, `PATHEXT`, `.exe`, `.cmd` and `.bat`, with the same path rules, and nothing is started or opened. No path is ever returned or logged. Answered from a blocking thread. **Built in the pre-release native pass** (lead, 2026-11-16) |
| `wake_at(at)` | One native deadline: at `at` (Unix ms), the exe sends `wake` over the channel | One pending deadline, each call replaces it. Fired within 1 s, also late after a resume. Doesn't wake a sleeping PC |
| `view_open(spec)` | Opens a view window, or Settings, bound to its page | Label `view-[a-z0-9-]{1,32}` with a plain `.html` page in the app folder other than `settings.html`, or `settings`, which always gets `settings.html`. size, title, `decorations`, `transparent`, `alwaysOnTop`, `skipTaskbar`, `visible`, `focused`, `focusable`. `core` can't be made |
| `window_ctl(label, op, bounds?)` | show, hide, focus (restoring a minimized one), close, get and set bounds | `settings` and `view-*` labels only |
| `window_self(op)` | drag, minimize, toggle maximize, close, on the calling window | Views and Settings |
| `autostart({ on? })` | Reads, or sets then reads, the Run entry | Current user. The entry runs the exe with `--autostart` |
| `open_url(url, owner?)` | The confirm dialog, then the default browser | `https` only, 2048 characters. The dialog shows the host on its own line in punycode and the full URL in its details, with "Open" and "Don't open". Under the one throttle. No allowlist in the exe |
| `open_folder(which)` | Explorer at `backups` or `logs` | Only those two |
| `pick_path({ kind, filters?, owner? })` | Native open dialog, returns a full path or null | `kind` is `file` or `folder` |
| `save_as({ name, filters, owner? }, bytes)` | Native save dialog, writes the bytes there | 256 MiB. Desktop Buddies' API 2 code: a new temp file beside the target, moved over the name with `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`, for a new and an existing name alike: one rename on one volume, so on a failure the target is untouched, and only then is the temp file deleted (decided after review: `ReplaceFileW` with no backup name can leave neither version). A replaced file's own ACL and alternate streams aren't kept: the new file gets its folder's. Links refused. The dialog makes no test file (`FOS_NOTESTFILECREATE`). Every remote destination is refused, a UNC path and a drive that isn't fixed or removable alike, so a share exposing a protected folder can't alias it: a person saves locally and copies it after (decided after review). Refused inside the native data folder, the WebView2 folder, and the folders holding the exe and the app folder, compared on the final path of the target's folder, and refused everywhere if one of those can't be resolved |
| `backup_write(name, bytes)`, `backup_list()`, `backup_read(name)`, `backup_delete(name)` | The rolling backup's files | Inside `backups\` only, plain names ending `.familiar-backup`, up to 16 files. One write at a time. **One budget**: 1 GiB for every file in the folder, temporary ones included, checked before a write starts. Temporary files have the exe's own exclusive `.~<16 hex>.tmp` names, and each start deletes those, and only those. Which to keep and when to delete is the app's. **Built in step 10**, before release |
| `secret_set` from core | Stores a peer's pairing token | The handler reads the caller's label from the IPC request: from `core`, only `addr:<id>` refs whose address is a `peer` are accepted, so core still can't write model or server keys. **Built in the pre-release native pass**, with the WebSocket |
| `ws_connect({ address, port, path }, channel)`, `ws_send(id, text)`, `ws_close(id)` | A WebSocket client, opened from `familiar.exe`'s own process | `address` a saved `peer` address and `port` inside its range. The exe builds the URL `ws://127.0.0.1:<port><path>` itself and checks it again. It sends `Host: 127.0.0.1:<port>` exactly and no `Origin` header, and the page sets no headers at all. Messages up to 1 MiB both ways, 4 sockets at once, messages to core over the channel. No redirects. In outgoing text, the placeholder is swapped for the address's stored token, and incoming text has literal copies redacted, as in [5a](#5a-credentials). **Built in the pre-release native pass**, against Desktop Buddies' settled protocol |

**Agreed with Desktop Buddies on 2026-11-14** (with its own session): Familiar needs only Desktop Buddies' socket. There's no discovery or port file, and no earlier file-based phase. Desktop Buddies listens on a WebSocket on `127.0.0.1`, on one of a fixed range of five consecutive ports, which isn't chosen yet. Familiar finds it by trying the range and exchanging a hello: a product id plus a protocol version the app can refuse. The app asks once, through `address_add`, for "Desktop Buddies on this PC, ports a to e" with whatever range Desktop Buddies picks, so no numbers are compiled in. Desktop Buddies identifies its caller by the process that owns the connection, so the socket must be opened by `familiar.exe` itself, never by WebView2 or a helper process, which is how `ws_connect` works. The app does the hello, the pairing and the protocol. The pairing token goes into Credential Manager through the secret commands. It passes through core once, as it arrives over the socket during pairing, and after that core only ever sends the placeholder.

**Tests**: shell-core for every rule in the table. On the runner: `view_open` with a bad label or page refused. `open_url` with `http:` or `javascript:` refused before any dialog. A valid `open_url` to the driver's local TLS listener: on "Don't open", the listener sees nothing, on "Open" it sees a connection, which proves a launch without counting browser processes. `save_as` through the dialog to a normal folder works, and into the data folder or beside the exe is refused. `backup_write` past 16 files or past the budget is refused, and a stray `.~*.tmp` is gone after a restart while a file of another name stays. `autostart` set and cleared, with the registry read back. `system` reports `idleMs` growing while the driver sends no input. `wake_at` fires within 1 s with core hidden and no views for 10 minutes. `ws_connect` to a port outside the saved range refused, and a round trip to a Node WebSocket server in shell-check on a port inside it, which checks the `Host` header is exactly `127.0.0.1:<port>`, that no `Origin` header came, that the connection's owning process is `familiar.exe` (`Get-NetTCPConnection`), that a 1 MiB message passes both ways and a larger one is refused, and that the token placeholder is swapped out and the token redacted coming back. A peer's dialog shows its range on one line. `quit` with an outstanding IndexedDB write that core finishes, and with a core that never says ready (exit after 3 s anyway).

### The command inventory

| Group | Command | Caller |
| --- | --- | --- |
| Shell | `shell_info`, `shell_ready`, `quit`, `quit_ready`, `tray_set`, `tray_pinned`, `system`, `wake_at`, `autostart` | core |
| | `log_line` | core, views, settings |
| Windows | `view_open`, `window_ctl` | core |
| | `window_self` | views, settings |
| Addresses and fetch | `address_list` | core, settings |
| | `address_add`, `address_remove`, `net_fetch`, `net_read`, `net_cancel` | core |
| Keys | `secret_set` | settings |
| | `secret_set`, for `peer` addresses only | core |
| | `secret_status` | core, settings |
| | `secret_delete` | core |
| Servers | `server_start`, `server_write`, `server_stop`, `server_forget`, `program_find` | core |
| Files and links | `pick_path`, `save_as`, `open_url`, `open_folder`, `backup_write`, `backup_list`, `backup_read`, `backup_delete` | core |
| Part 2 | `ws_connect`, `ws_send`, `ws_close` | core |

37 commands. `COMMANDS` in `build.rs`, the capability files, the Rust handler list and `src/shell.ts` are one inventory, and the static test fails if they disagree.

---

## 6. Tray, hotkey, autostart, single instance, notifications, system state

- **Tray.** Up before any page runs, with only Quit, which the exe appends and handles itself, so it works with core dead (Desktop Buddies' `tray.rs`). Core sets the rest with `tray_set`. Clicks reach core over its channel. Closing every window never ends the run, only Quit does.
- **Hotkey.** Core registers the person's chosen shortcut through the plugin and shows or focuses chat when it fires. If registering fails (another app has it), Settings says so. No hotkey is registered until the person picks one in first-run setup.
- **Autostart.** Off until the person turns it on. The Run entry starts `familiar.exe --autostart`. A sign-in start keeps chat closed and goes to the tray, and core never takes the keyboard.
- **Single instance.** A second launch hands its arguments to the first and exits within a second. Core hears it and shows chat. A sign-in start while Familiar is already running is a no-op.
- **Notifications.** Core shows reminder toasts with a title, body and up to three buttons (for example Done and Snooze). A click on the toast or a button reaches core while the toast is on screen, and core shows the reminder card in chat. A click from the Action Center is not reported (the plugin says so for Windows), so the card in chat is always the source of truth and a toast is only a nudge.
- **System state.** The exe sends `system` over the channel when anything changes: `userState` and, from the pre-release native pass, `locked` (both polled every 5 s), and resume after sleep (`WM_POWERBROADCAST`). Idle time is read on demand. Polling the lock flag with the state needs no window and no message hook, and 5 s is soon enough for an arrival. The rules decider uses `fullscreen`, `presentation` and `quiet` as do-not-disturb, next to Familiar's own do-not-disturb setting. Windows has no public way to read Focus Assist on Windows 11 beyond these states, and Windows itself holds toasts back while it's on.
- **Reminders and wake-ups.** pi-durable's Harness takes `setTimer` and `onWake`, so reminders are driven by `wake_at`, not by page timers that a hidden window might throttle. After a resume, core is told and re-checks what's due. There's no comparison of page timers against it: the native wake is in the exe either way. What's proven is that the wake reaches a hidden core (step 3, on the runner) and that a reminder due during sleep shows after resume (before release, on a real PC, since the runner can't sleep).

---

## 7. Checks on the Windows runner

Modelled on Desktop Buddies' `shell.yml`: `.github/workflows/shell.yml` on `windows-latest`.

1. Toolchain from `rust-toolchain.toml` (1.95.0). `cargo test --locked` in `shell-core`. `cargo build --release --locked` in `src-tauri` (`custom-protocol` on, no Tauri CLI needed). The exe's size and SHA-256 go in the job summary, and it's uploaded as an artifact. Then, for the check only, a control exe is built with the `check-blocking` feature, which adds one 3 s sleep on the async worker before a guarded fetch's helper work and nothing else, and kept apart as `familiar-blocking.exe`. The contract check runs it in its own phase to show `security.exec.responsive`'s probe catches blocked workers. It's never uploaded, released or shipped: a static test (`tests/check-build.test.ts`) fails if any workflow builds the uploaded or shipped exe with the feature, if anything uploads the control exe or the whole exe folder, or if the feature does more than its one sleep.
2. `pnpm install --frozen-lockfile`, then build the check app folder (`apps/desktop/shell-check`) and the real app folder.
3. **Contract check.** `shell-check/driver.ps1` launches the exe on the check app folder with a scratch `--data-dir`, `--seconds` and `--log`. Its pages run every check through the app's real client (`src/shell.ts`) and log `CHECK PASS|FAIL|SKIP id detail`. When a check needs something no page can do, it logs `STEP n action args` and the driver does it: answer a native dialog through UI Automation, read `cmdkey`, search files for a secret, write `hosts`, set the proxy, run listeners, read the DNS cache, kill the exe hard, read the registry and the clipboard. There's no test code in the exe.
4. **The security gate.** Two namespaces, two lists, one rule each:
   - `security.<id>`: every id in `shell-check/security-inventory.json` must report PASS. A FAIL, a SKIP, or a listed id that never reported fails the gate.
   - `check.<id>`: every id in `shell-check/checks.json` may PASS or SKIP. A FAIL fails the run.
   - Any reported id in neither list, in either namespace, fails the run, so a renamed or new check can't slip past.

   The security inventory, each id prefixed `security.`:
   - `caps.static`, `caps.view-refused`, `caps.core-reaches`, `caps.cross-window`, `caps.forged-event`, `caps.page-binding`
   - `csp.trusted-types`, `csp.no-service-worker`, `perm.denied`, `egress.core`, `egress.view`, `egress.controls`, `nav.refused`
   - `pin.origin`, `pin.folder`, `pin.restart`, `pin.moved-install`
   - `confirm.defaults`, `confirm.throttle`, `confirm.escaping`, `confirm.frozen`
   - `key.roundtrip`, `key.echo`, `key.no-copy`, `key.bound`, `key.rebind`, `key.write-only`
   - `fetch.saved-only`, `fetch.no-lookup-before-allow`, `fetch.stream-stop`, `fetch.live-stream`, `fetch.limits`, `fetch.redirects`, `fetch.rebinding`, `fetch.literal`, `fetch.proxy`, `fetch.revoke`
   - `server.approve`, `server.reask`, `server.paths`, `server.remote-drive`, `server.links`, `server.retarget`, `server.forget-failed`, `server.settings`, `server.blank`, `server.env`, `server.start-failed`, `server.store-recovery`, `server.kill`
   - `link.confirm`, `files.save-refused`, `quit.clean`
   - `model.key-swap` (step 4): the model adapter's requests carry only the placeholder, the endpoint gets the stored key, and its echo comes back blanked. See [model-design.md](model-design.md#recorded-replies).
   - Added with the pieces built later: `files.backup-budget` (step 10), `ws.saved-only`, `ws.host-origin`, `ws.owner-process` (the pre-release pass). The release gate requires them all.
   - Also from the pre-release pass, as `check.` ids since they test Windows more than a gate: `system.lock` (the driver locks the session with `LockWorkStation` and reads `locked` true within 6 s, if the runner allows it), and `tray.pinned` (the driver writes a `NotifyIconSettings` subkey for the exe's path with `IsPromoted` 1, then 0, then a second matching subkey, and reads `pinned`, `not-pinned` and `unknown`). That proves the reading, not where Windows draws the icon, so step 13 checks both on a real PC: a lock and unlock, and the icon pinned, dragged to the overflow and back, and after Explorer restarts, with `pinned` never shown for an icon in the overflow.

   Declared `check.` ids include the measurements below, `system.idle`, `wake.hidden`, the smoke run's steps and anything the runner may not allow.
5. **Measurements**, recorded as INFO: `persist()`, the web clipboard, the toast app id, TLS roots. Each settles a choice in this note before the exe does.
6. **Smoke run.** The real app folder with a fresh data folder: core starts, says ready, opens chat, and quits cleanly, judged from the log.
7. **Hidden wake**: the 10-minute `wake_at` check with core hidden and no views, in the contract check. There's no separate soak job.

**When they run.** The repo is public, so Actions minutes are free.

| Trigger | Runs |
| --- | --- |
| Every push, any branch, Linux | `shell-core` `cargo test`, the capability, inventory and pin tests, typecheck and tests (already in `ci.yml`) |
| Every push touching `apps/desktop/src-tauri/**`, `shell-core/**`, `shell-check/**` or `shell.yml` | The whole workflow: build, contract check with the security gate, smoke |
| Every push to `main` | The contract check, gate and smoke with the current app folders on the latest exe built from `main` (`reuse`), so an app change can't quietly break against the exe |
| By hand | Any of it, with `reuse` |

---

## 8. What could force another exe

| Could force one | How this design avoids it, or what's left |
| --- | --- |
| New views, windows or tray items | `view_open`, `window_ctl` and `tray_set` are general. Window flags for a borderless, unfocused or always-on-top view are in the spec now |
| A new provider or wire | Every API goes through `net_fetch` with the placeholder swap. A provider that wants the key outside the four headers, say in the URL, would need one. None of the three planned do |
| Remote servers that need OAuth | **Not in v1.** Remote servers take an API key or a bearer token. OAuth needs native token storage, exchange and refresh, and a callback listener done properly. It comes later with its own exe, batched with whatever else is waiting |
| Desktop Buddies' API v2 | The scoped WebSocket is designed now, as agreed with Desktop Buddies, and built in the pre-release native pass. Its port range is a saved address, not a number in the exe, so choosing or changing the range needs no exe |
| `persist()` refused and data evicted | The backup commands are designed now and built in step 10, before release, whatever step 3 measures |
| Reminders in a hidden or sleeping app | `wake_at` and the resume event are in now |
| Clipboard, an egress route left open | Decided by measurement in step 3, before the exe settles. Trusted Types is in the app's own CSP, so it needs no exe either way |
| Toast clicks from the Action Center | Would need a COM activator. Avoided by design: the chat card is the source of truth |
| A server program kind other than `.exe`, `.cmd`, `.bat` | `.ps1` and bare scripts are refused on purpose. Python and Node scripts run through their `.exe` |
| A network that only has a PAC proxy script, or a proxy that wants a login | Not supported. A known gap for the README. It would need a new exe if people hit it |
| A Tauri or WebView2 security fix in the exe's own code | Can't be avoided. Batch it with whatever else is waiting, as Desktop Buddies' "For the next exe" list does |
| Later tiers (UI Automation, screen and mouse) | Out of part 1 on purpose. They come with their own plans and their own exe |
| Signing (SignPath after the public flip) | A signed build is a new exe by nature, of the same source |

---

## 9. Hours

The exe settles just before the first release, not at step 3 ([Decisions](#decisions)). So step 3 builds and proves the exe's core, and three designed pieces are built later, still before release: the backup commands in step 10, the recorded-provider run over the guarded fetch in step 4, and the peer WebSocket in a pre-release native pass. Review 2's fixes add work, and four cuts take some away: Trusted Types moved to the app, a simpler refusal stop, battery and session lock deferred, and no page-timer soak.

**Step 3**

| Part | Implement | Validate | Rework |
| --- | --- | --- | --- |
| Skeleton: assets, windows bound to pages, tray and `tray_set`, single instance, log, quit, the missing-folder box | 2 | 0.5 | |
| Capabilities, window wrappers, the core channel, the exe's CSP, browser arguments and the sink proxy, the static tests | 1.75 | 1 | |
| The confirm module: dialog, defaults, delay, escaping, frozen state and restore, the refusal stop and tray re-entry | 1.5 | 1.25 | |
| Saved addresses: approval before any lookup, identity by full scope | 1 | 0.25 | |
| Guarded fetch: rules, literal IPs, resolver, proxy, redirects, limits, streaming, the swap, the streaming matcher, redaction of every field, revocation | 5 | 1.75 | |
| Credentials, typed in Settings | 0.5 | 0.5 | |
| Settings kept apart: its own label, page and capability set, the permission handler, autofill and password saving off, the service-worker refusal, their checks | 0.75 | 0.5 | |
| Server start: path, drive and link rules, setting rules, approval store, dialog, job, failure cleanup, blanking | 3.5 | 2.25 | |
| `save_as`, `pick_path`, links, folders, autostart | 0.75 | 0.5 | |
| `system()` (full screen, presentation, quiet time, idle) and resume, `wake_at`, notifications, hotkey, toast app id | 1 | 0.5 | |
| Egress harness (listeners, STUN, `pktmon`, positive controls), the two-namespace gate, the workflow | | 3 | |
| Runs on the runner until green, and what the measurements overturn (WebRTC, the sink proxy, clipboard, toasts) | | | 4 |
| Code reviews 3 to 9: the two restructures (one actor per setup, one owner for network state), each round's fixes, and the last batch of six | | | 4.5 |
| **Total** | **17.75** | **12** | **8.5** |

**Step 3 took about 38.25 hours.** That replaces its 8, it doesn't add to them. It was 32.5 when the owner accepted it. The safeguards that came with typing keys in Settings added 1.25. The rework row ran out during the code reviews, and the lead approved 3 more hours on 2026-11-15, then 1.5 for the last batch of six fixes ([Closing step 3](#closing-step-3)).

**What moved where, and the part 1 total**, starting from the current 93:

| Step | Was | Now | Why |
| --- | --- | --- | --- |
| 3, the shell | 8 | 38.25 | This note |
| 4, the model layer | 5 | 5.25 | Gains the recorded-provider contract run over `guardedFetch` in the real webview (0.75), saves on a fetch already proven (0.5) |
| 7, the MCP client | 12 | 10.5 | The server start, its approval and blanking are built in step 3 |
| 10, memory and export | 5 | 6 | Gains the native backup commands and their budget check |
| 11, chat and settings | 10 | 10.25 | Gains the Trusted Types `<meta>` on every page and its test |
| New: a pre-release native pass, before step 12 | 0 | 9 | The peer WebSocket and core's peer-token `secret_set`, against Desktop Buddies' settled protocol, with their checks. From 2026-11-16, the lock flag in `system()` (0.5) and `tray_pinned()` (1), for the moments, and `program_find` (0.5) for step 7's prerequisites check. JSON-escaped redaction goes into the same pass's matcher work, with no hours of its own. From step 7's rebuild, the MCP client's native items ([mcp-design.md](mcp-design.md#4-the-exe) section 4), 5.75: 9 |
| 4, 5 and 7, rework (2026-11-15) | 0 | 8 | A rework row of a third of build (1.75, 2.75 and 3.5), from what step 3's reviews cost. See [design.md](design.md#build-order) |
| 7, the client's rethink, rebuild and reviews (2026-11-22) | 0 | 179.5 | Step 7 closed at 193.5 against its 14. See [design.md](design.md#build-order) |
| **Part 1** | **93** | **353.25** | 132.5 on 2026-11-15. From 2026-11-16 also the moments, her portrait and her traits, which add steps 10b and 11b and hours to steps 6, 11 and 13 ([design.md](design.md#build-order)), and the lock flag and `tray_pinned()` above (1.5): 154.25. Then step 7's `program_find` (0.5): 154.75. Then step 10c, the decision models (13.25), with no exe change: 168. Then step 7's close (179.5 over its 14) and the client's native items (5.75): 353.25 |

The riskiest pieces (the egress closure with the sink proxy, and the reparse walk) ran on the runner first, and neither moved the estimate. The code reviews did.


## Closing step 3

Nine code reviews in all, each by Codex in a sandbox that reads only a copy of the code. From the third on, the lead's rule applied: when a third round still finds races, change the design rather than patch again. So the process side became one actor per setup ([5b](#5b-starting-a-local-mcp-server)), and the network side one owner for addresses and requests ([5c](#5c-the-guarded-fetch)). Each later round was a narrow check of the fixes, with a stop rule: new P1s go to the lead, not into another silent round.

Round 9 found six. Three were real but needed a failing disk or a queued lookup: a forget that failed on disk could be reported as a success, a stalled log could hang quit, and a queued lookup could still go out after a cancel. Three were edges in how a check proved its claim. None leaked a key, and none let page script alone start a program or send data somewhere unapproved.

Decided 2026-11-15 by the lead, in their words: "Go with A: fix all six as one batch, run no further Codex round, close step 3, and put the whole exe through one fresh Codex review in the pre-release native pass. Fix #1 (a failed forget reported as success) first and give it its own regression test, since it's a consent bug." The owner can still overrule it.

So all six are fixed, each with a test or a runner check that fails without it, and the failed forget has its own (`security.server.forget-failed`). A failed forget is remembered only while the exe runs: after a restart with the removal still undone, the approval on disk counts again. The person was told the forget failed, and a mark saying so would go to the same disk that just failed, so there is none. The fresh review of the whole exe is part of the pre-release native pass, before the exe settles.

---

## Decisions

Decided 2026-11-14 by the maintainer, in their words: "so we do option 1, the rest of your decisions make sense to me."

1. **When the exe settles: just before the first release (step 12)**, not at step 3. The rule: no exe reaches a person's PC until it's settled. The three moved pieces (backups in step 10, the recorded-provider run in step 4, the peer WebSocket in a pre-release pass) are built before release.
2. **Key entry: typed in Familiar's own Settings window** ("option 1"), not a native prompt. Settings calls `secret_set` itself, write-only, so a key never crosses a channel. It comes with four safeguards: a separate Settings window that never draws model or tool text and has its own narrow capability set, write-only storage with only "set" and a masked hint shown, core making every request with the key, and a changed address needing the key typed again ([5a](#5a-credentials)). The reason for those safeguards: in open-source chat apps the failure seen again and again is script in model output reaching a key, including one case where swapping a base URL sent the stored key to the new address.
3. **The estimate: accepted**, step 3 at about 32.5 hours and part 1 at about 118.75, to be redone after the egress closure and Trusted Types have been measured on the runner. The safeguards in 2 then added 1.25, for 33.75 and 120. Step 3 closed at 38.25, and part 1 is now 132.5 ([9](#9-hours)).

Decided in this note, after review: untrusted content is never HTML, with Trusted Types in the app's own CSP and no sandboxed frame. Consent to MCP writes and sends stays in the app. Links ask natively with no allowlist. No OAuth in v1. No loopback fetch mode. With Desktop Buddies, on 2026-11-14: its socket only, no discovery file ([5d](#5d-the-rest)).

## Open, for step 3 to measure

- Whether WebView2 grants `navigator.storage.persist()` ([3](#3-origin-and-data-folder-pinned)). Measured: it asks the exe (permission kind 13). The exe now allows that one kind, and `persist()` is granted, on a fresh data folder and after.
- Whether the sink proxy, the WebRTC policy and DNS prefetch off close every egress route, with Familiar's pages and IPC still working ([2](#egress-outside-fetch)). Promise 2 waits on it. Measured: every route but WebRTC is closed by them, from core, a view and a view without Trusted Types, with pages and IPC working under the sink (IPC went over `http://ipc.localhost` every time). WebRTC is closed by the exe's every-frame script, frames included; the WebRTC switch and `webrtc 'block'` don't close it.
- Whether Tauri's injected scripts run under the app's `trusted-types 'none'`. If not, the fix is in the app ([2](#the-web-surface-what-the-exe-pins)). Measured: they do, with no violation from them; invoke, and channel messages both small (by script) and large (by Tauri's fetch command), all work.
- Whether `navigator.clipboard.writeText` works in a view, which decides the clipboard plugin ([4](#4-plugins)). Measured: it works after a real click, so no clipboard plugin.
- Whether the registry app id is enough for toasts on an unpackaged exe ([4](#4-plugins)). Measured: the notifier reads `Enabled`. That a toast is seen stays step 13's.
- That `wake_at` reaches a core hidden for 10 minutes, and, before release on a real PC, that a reminder due during sleep shows after resume ([6](#6-tray-hotkey-autostart-single-instance-notifications-system-state)). Measured: with core hidden and no views for 10 minutes, the wake left the exe 2 ms after its deadline and reached the page within 3 ms more (runs 43597901433 and 43596106601). The page must take it as the message arrives: a hidden page's timers are throttled. Sleep and resume stay for a real PC.
- That the reparse walk reads links without following them on the runner's file system ([5b](#5b-starting-a-local-mcp-server)). Measured: it does, in `shell-win.yml` and again through `server_start` in `shell.yml`, with no SMB open and no new SMB connection while a positive control moved both.
- That rustls with the platform verifier trusts what Windows trusts ([5c](#5c-the-guarded-fetch)). Measured: a public `https` host works and a self-signed local one is refused as `tls` (`shell.yml` run 43600729402).
- That the permission handler's deny is the last word, with no prompt shown, and that paste still works in Settings ([2](#web-permissions)). Measured: clipboard read, geolocation, notifications and MIDI reached the exe's handler and were denied within 5 ms, no new window appeared, and Ctrl+V into Settings worked. Camera and microphone were refused before asking, since the runner has no devices.

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

## Changes after review 2

| Finding | What changed |
| --- | --- |
| P1-1 address approval permitted DNS egress | `address_add` now normalizes with no network access, checks the confirm state, asks, and only after Allow resolves and classes the name. Refusals and the stop apply before any lookup. A new check proves no query leaves before Allow ([5c](#5c-the-guarded-fetch)) |
| P1-2 fixed holdback could stall a stream | An incremental matcher over every secret the request used holds back only a tail that could still begin one. `net_read` waits through chunks with no output and returns empty only at the real end. A live-stream check: one SSE event, then a quiet open connection, and the event arrives within 100 ms ([5a](#5a-credentials)) |
| P1-3 keys could return through metadata | Redaction covers the final URL (raw and percent-decoded), the status text, header names and values, and bodies. A header whose name holds a secret is dropped. A redirect whose target holds a secret isn't followed. A redirect-echo check is added |
| P1-4 drive letters needn't be local | Before any file access, `GetDriveTypeW` must say fixed or removable. Then each name on the path is opened without following links, and every reparse point's target must be a local path that passes the same checks. Cloud placeholders and unknown tags are refused. Checks with a mapped drive, a junction and a symbolic link to a share, watched with SMB counters and `pktmon` ([5b](#5b-starting-a-local-mcp-server)) |
| P1-5 the dead proxy wasn't owned | The exe binds its own exclusive `127.0.0.1` listener on a random port that answers 403 to everything, and passes it as the webview's proxy. The egress gate watches DNS on the wire with `pktmon` and the DNS Client log, and has positive controls, including the same page in Edge with no sink. Promise 2 is declared only if it passes ([2](#egress-outside-fetch)) |
| P1-6 disabling windows didn't freeze script | While a confirm is open, `view_open`, `window_ctl`, `window_self` and new confirms get `busy`, every window drops always-on-top, the operation shown is an immutable copy, and every window's prior state is restored on every way out. A check sends those commands while a dialog is open ([5](#the-native-confirms)) |
| P2-7 a Trusted Types policy name fixes nothing | Trusted Types moved into the app's own `<meta>` CSP. The exe's CSP keeps the network and frame rules, and reserves no policy name |
| P2-8 peer identity lost the range | An address's identity is its kind, its URL and its whole port range. A changed range is a new approval, a new id and no key |
| P2-9 option A wasn't exception-free | The peer pairing token is a documented exception to promise 1 with either option. Option A is described as removing the Settings exception only |
| P2-10 the denylist can't be complete | Promise 3 is narrowed to the launch tuple and the secret names, with secret values free to change. The list gained `BASH_ENV`, `ENV`, `SHELLOPTS` and the `GIT_*` launch settings, and is called defence in depth |
| P2-11 the inventory contradicted itself | Two namespaces: every `security.` id listed must PASS, every `check.` id listed may SKIP, and any unlisted id fails the run |
| Cut: throttling | One prompt at a time, and three refusals stop asks until the tray re-entry. The 30 s and 10-minute windows are gone |
| Cut: system facts | Kept full screen, presentation, quiet time, idle and resume. Battery and session lock deferred until a feature uses them |
| Cut: soak | The page-timer soak is gone. A hidden `wake_at` delivery check stays in step 3, and a sleep and resume reminder check on a real PC before release |
| Moved | Backups to step 10, the recorded-provider run to step 4, the peer WebSocket to a pre-release native pass. Their designs stay in this note |
| Estimate | Step 3 at 32.5 hours (34.5 with native entry) in place of its 8, not on top of them. Part 1 from 93 to 118.75 (120.75), with each step's change listed in [9](#9-hours) |

## Changes after the decisions

| Decision | What changed |
| --- | --- |
| The exe settles before the first release | Written as decided, with the rule "no exe reaches a person's PC until it's settled" |
| Keys typed in Settings | Option A and `secret_prompt` are gone. Promise 1 names the Settings window as its one entry exception. Settings is its own window, label `settings`, bound to `settings.html`, with its own channel and a capability set of its own and no events. `secret_status` gains a masked hint. A changed address needing the key again is named as a safeguard, with a `key.rebind` check. New closures so chat's script can't reach Settings: `worker-src blob:` in the exe's CSP (no service workers), every web permission denied (no clipboard read), and WebView2's autofill and password saving off. New security ids `csp.no-service-worker`, `perm.denied`, `key.rebind` and `key.write-only` |
| Hours | Step 3 at 33.75, part 1 at 120: the accepted 32.5 and 118.75 plus 1.25 for the safeguards |

## Changes after review 3

The first code review, of shell-core's rules and the link walk, before anything is wired into the exe.

| Finding | What changed |
| --- | --- |
| P1 stderr was cut before it was blanked | A line runs through the redactor first and is cut after, so no cut can leave part of a secret |
| P1 a marker could rebuild a secret | A secret can't contain `[key]` or `[hidden]`, start with the end of one or end with the start of one ([5a](#5a-credentials)) |
| P1 encoded separators | `%2e`, `%2f` and `%5c` are refused in saved and requested paths ([5c](#5c-the-guarded-fetch)) |
| P2 the walk's race with other programs | Stated as what the walk doesn't cover ([5b](#5b-starting-a-local-mcp-server)) |
| P2 IPv6 translation forms | IPv6 is public only inside `2000::/3`, outside its special ranges, all of `2001::/23` included |
| P2 Unicode case folding | Setting and secret names are ASCII |
| P2 invisible characters, and details that two operations could share | One named list of characters to escape, backslashes doubled first, and paths and names refuse them all |
| P2 a link target could change after approval | The walk's final target, for the program and the folder, is in the approval and compared before starting |
| P2 more Windows device names | `COM0`, `LPT0`, the superscript forms, `CONIN$`, `CONOUT$` and `CLOCK$` refused |
| P2 the SMB verdict could pass with a missing sample | Every sample required. The measures are the connection list and the server's open count, each moved by a control. `pktmon` can't see SMB to the runner's own share |
| P2 hop-by-hop headers | `keep-alive`, `te`, `trailer`, `upgrade` and `expect` dropped |
| Choice | `*.localhost` is loopback with no lookup, like `localhost` |

## Changes after review 4

The second code review, of the exe's skeleton, its web surface and the check harness. Every fix has a test or a runner check that fails without it.

| Finding | What changed |
| --- | --- |
| P1 egress could pass with no route records | The analyzer holds the exact route list for core, the view, the bare view and Edge. A missing, broken, empty or skipped record fails |
| P1 the fixtures missed bare TCP and QUIC | Every TCP connection is counted and every TCP fixture port also listens for UDP, each with its own positive control |
| P1 a failed analysis could reuse an old verdict | Fresh outputs each run, Node's exit status checked, and every egress verdict carries this run's id or fails |
| P2 downloads weren't cancelled | The window helper cancels every download (`security.download.refused`, same-origin and `blob:` after a real click) |
| P2 the sink could be held open | One 2-second deadline for the whole first line. 70 trickling clients, then a new request got its 403 in 13 ms |
| P2 hardening failures left a window usable | A window opens on `about:blank` and loads its page only after hardening succeeds. On a failure it's destroyed, and for core the exe shows a box and exits 1 (`security.harden.before-page`, and the static test checks the order) |
| P2 the app folder could reach the data folder | Overlapping app and data folders refuse to start. Each asset's final path, from its open handle, must be inside the app folder (`security.assets.inside`) |
| P2 an early second launch was lost | Up to 8 messages wait for `shell_ready` |
| P2 a failed log rotation broke the cap | The size resets only after a rotation that worked. Otherwise lines past the cap are dropped and counted |
| Measured | WebRTC closed by the every-frame script (the CSP directive and the switches don't close it). `persist()` granted once kind 13 is allowed |

## Measured in step 3's process round

Server starts, files and links, system state and wake, notifications, the hotkey and autostart, built and checked on the runner (runs 43596106601 and 43597901433 of `shell.yml`). The confirm is a stand-in Yes/No box until the confirm module is merged, and secrets read as none until `secrets.rs` is, so `server.blank` waits for both.

| What | Measured |
| --- | --- |
| A server's environment | 23 variables, only allowlisted names and the setup's own, and nothing only Familiar had, as the spike saw |
| Stopping during a call | `server_stop` with a 30 s call in flight ended the run in about 560 ms: stdin closed, the 500 ms wait, then the job |
| A hard kill of the exe | With a slow call in flight, `node.exe` and the `conhost.exe` Windows makes for it under `CREATE_NO_WINDOW` were both gone 2 s later |
| `start-failed` | With the exe in a job that allows no new process, `server_start` of an approved setup gave `start-failed` and left no process |
| An unreadable `servers.json` | Renamed aside, and the approved setup asked again |
| The confirms' stop | Three refusals in one run stop every ask, as designed: the checks spend at most two refusals a run |
| SMB | Every share-reaching path was refused with 0 server opens and 0 new connections, while the control moved 16 opens and 2 connections. `pktmon` isn't used ([5b](#5b-starting-a-local-mcp-server)) |
| `system()` | The runner reports `quiet` (`QUNS_QUIET_TIME`), and `idleMs` grew by 3 s over 3 s with no input |
| Notifications | The plugin's page script replaces `window.Notification` everywhere ([2](#web-permissions)). The toast app id reads `Enabled` |

