# Familiar's native shell

Build step 3. The design for `familiar.exe`, written before any of it is built.

## The rule

**The exe holds general native building blocks and the gates that must not live in a webview. Everything else is the `app` folder beside it.**

Familiar ships unsigned. Each new unsigned exe gets a fresh Smart App Control verdict on a person's PC, and a blocked exe has no "run anyway". App folder changes get no verdict. So the exe settles in step 3 and rarely changes after, as Desktop Buddies' did (`docs/native-shell-design.md` in that repo, which this follows wherever it can, and whose proven code it copies).

A gate belongs in the exe when a webview that went wrong could do lasting harm without it: read a key, send data somewhere the person never chose, or start a program. A webview goes wrong by a bug, or by script running where it shouldn't, for example through text a model or a card put on screen. Everything that is a choice, such as which hotkey, what the tray says, when to ask for consent, lives in the app.

The exe asks the person itself, in a native Windows dialog, in exactly two places: before a program runs, and before a new address joins the list of places data may go. Those are the two acts a webview must not be able to fake or skip.

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
| `keyring` | `=4.2.0`, default `v1` feature | Its Windows store only, on Windows |
| `reqwest` | `=0.13.5`, default features plus `stream`, `gzip`, `brotli`, `deflate` | rustls and the Windows system proxy are defaults in 0.13 |
| `tokio-tungstenite` | `=0.29.0`, `connect` only, no TLS | The same version Tauri's WebSocket plugin uses |
| `windows` | `0.62`, the copy Tauri already pulls in | Dialogs, registry, shell calls, job objects |
| Rust toolchain | `1.95.0`, in `rust-toolchain.toml` | The mcp-start spike's |

Every plugin requires `tauri ^2.12`, so all of them fit 2.12.5. `Cargo.lock` is committed and every build uses `--locked`.

---

## 1. The split

### What lives where

| In the exe | In the app folder |
| --- | --- |
| Serving the app folder, and refusing a missing one | Every page, script, style and image |
| The core window and view windows, with the pinned origin, data folder, browser arguments and CSP | Which views exist and what they show |
| Navigation off the origin refused | Links: when to offer one, what to show first |
| Tray icon with an exe-owned Quit | The tray menu's other items, icon and tooltip |
| Single instance, autostart's registry entry, the toast app id | When autostart is on, what a second launch means |
| Credential Manager, write-only to pages | Which endpoints and servers exist |
| The saved-address list and its native confirm | When to add an address |
| The guarded fetch, with key injection | pi-ai, the MCP client, retries, error wording |
| Starting a saved server setup, its native confirm, its job, blanking its secrets | The setup form, the MCP protocol, restarts, time limits |
| Native save and pick dialogs, the backup folder | What gets exported, how many backups, when |
| Loopback WebSocket, one discovery read and a one-shot OAuth listener, for part 2 and remote servers | The buddy protocol, the OAuth flow |

Nothing about storage is in the exe: conversations, memory, reminders and settings are in pi-durable's IndexedDB store, inside the webview.

### How the exe finds and serves the app folder

Desktop Buddies' pattern, copied:

- The app folder is `app\` beside `familiar.exe`, or `--app-dir <path>`.
- `FolderAssets` implements Tauri's `Assets` trait and replaces the embedded assets with `context.set_assets(...)`. Each request's path goes through the plain-names check from Desktop Buddies' `shell_core::paths` (no `..`, no drive letters, no device names, no `:`, no trailing dot or space, both slashes split). The file is read from disk on each request. There is no other root: unlike Desktop Buddies, nothing from the data folder is served. Card images live in IndexedDB as blobs and show through `blob:` URLs.
- Pages are served at `http://tauri.localhost/<path>`, so they have one fixed local origin and Tauri's IPC treats them as local.
- The exe's own flags: `--app-dir`, `--data-dir` (native data and `webview\` inside it, for tests), `--log`, `--seconds N`, `--devtools`, `--autostart` (added by the Run entry). All raw arguments reach the app through `shell_info`.

### If the folder is missing or broken

- **Missing**, or no `core.html` in it: the exe logs it, shows a native message box ("The app folder is missing or broken. It should sit beside familiar.exe. Looked in: ...") and exits with code 1. No window opens.
- **Broken**, meaning `core.html` loads but the core never calls `shell_ready` within 30 s: the exe logs `core not ready`, shows one native message box naming the log file, and keeps the tray with its Quit. It never retries in a loop.
- **Too new**: the app reads `api` from `shell_info`. If the exe is older than the app's `MIN_API`, the app says which Familiar it needs and does nothing else. No field or command an older exe doesn't know is ever sent.
- **No WebView2 Runtime**: window creation fails, and the exe shows a message box that says Familiar needs Microsoft Edge WebView2 Runtime, then exits with code 1. The installer (step 12) checks for it first.

**Tests.** shell-core unit tests for the path check (Desktop Buddies' cases). On the runner: the exe with an empty `--app-dir` shows the box and exits 1 (the driver finds the box through UI Automation and closes it), and an app folder whose `core.html` throws gets the "not ready" box within 35 s.

---

## 2. Windows and capabilities

### Windows

- **`core`**: opened by the exe at start, hidden, no taskbar entry, `core.html`. It runs the agent core for the whole run: the turn loop, pi-durable, reminders, the MCP client. It's the only window that holds conversations and calls models and servers. It renders no untrusted content as HTML.
- **Views**, labels `view-<name>`: chat, settings, and whatever the app adds later. A view only draws what core publishes and sends requests back, over a `BroadcastChannel` on the shared origin, as Desktop Buddies' Manager does. Closing a view loses nothing.

One helper builds every window, because WebView2 windows sharing a data folder must share browser arguments. It always sets the pinned data folder, `use_https_scheme(false)`, `disable_drag_drop_handler()`, the navigation handler and these arguments:

```
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required
```

SmartScreen in the webview is off because pages are only ever local, and it would send URLs to Microsoft. Autoplay is on so a reminder can play a sound, which could not be added later without an exe.

### The command gate

Tauri 2 checks app commands against capabilities only when the app declares an app manifest. So `build.rs` lists every app command:

```rust
tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&COMMANDS),
))
```

With that, a command no capability grants to the calling window is refused with "Command <name> not allowed by ACL" (read in `tauri-2.12.5/src/webview/mod.rs`, `on_message`). Default deny, by window label. Plugin commands are always checked.

### Capability files

`capabilities/core.json`:

```json
{
  "identifier": "core",
  "description": "The core window: everything native. No view gets any of this.",
  "windows": ["core"],
  "permissions": [
    "core:event:default",
    "core:window:default",
    "core:window:allow-show", "core:window:allow-hide", "core:window:allow-set-focus",
    "core:window:allow-unminimize", "core:window:allow-close", "core:window:allow-destroy",
    "core:window:allow-set-position", "core:window:allow-set-size",
    "notification:allow-notify", "notification:allow-is-permission-granted",
    "notification:allow-register-action-types",
    "notification:allow-register-listener", "notification:allow-remove-listener",
    "global-shortcut:allow-register", "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered",
    "allow-shell-info", "allow-shell-ready", "allow-log-line", "allow-quit",
    "allow-view-open",
    "allow-address-list", "allow-address-add", "allow-address-remove",
    "allow-net-fetch", "allow-net-read", "allow-net-cancel",
    "allow-secret-status", "allow-secret-delete",
    "allow-server-start", "allow-server-write", "allow-server-stop", "allow-server-forget",
    "allow-pick-path", "allow-save-as", "allow-open-url", "allow-open-folder",
    "allow-backup-write", "allow-backup-list", "allow-backup-read",
    "allow-autostart",
    "allow-oauth-wait",
    "allow-peer-read", "allow-ws-connect", "allow-ws-send", "allow-ws-close"
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
    "core:event:default",
    "core:window:default",
    "core:window:allow-start-dragging", "core:window:allow-internal-toggle-maximize",
    "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-close",
    "allow-log-line"
  ]
}
```

`capabilities/settings-keys.json`:

```json
{
  "identifier": "settings-keys",
  "description": "Key entry. Write-only: nothing can read a key back.",
  "windows": ["view-settings"],
  "permissions": ["allow-secret-set", "allow-secret-status"]
}
```

The title-bar permissions are granted now because capabilities compile into the exe. A view can't open windows, fetch, start servers, open links, use the WebSocket, notify or register hotkeys.

**Key entry is the one exception, and it is write-only** (a decision for the lead, see [Decisions](#decisions-for-the-lead)). The person types a key in Settings, and Settings calls `secret_set` directly. The other way, sending it to core first, would put the key on the shared `BroadcastChannel`, where every page hears it, the chat view included. Nothing anywhere can read a key back, core included.

**What the split protects, honestly.** Views are where model text, card text and tool results are drawn, so they are the likeliest place for script to run that shouldn't. A view that went wrong can still ask core for things over the channel, so core treats view messages as requests a person could make through the UI, nothing more. If core itself runs bad script, the exe still holds: keys can't be read, data can only go to saved addresses, programs run only as approved. The split is defence in depth, not a wall.

### Security rules for every page

- **CSP, pinned in the exe** (`app.security.csp` in `tauri.conf.json`, which Tauri sends as a header on every HTML page, read in `manager/mod.rs` `get_asset`):

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' ipc: http://ipc.localhost; worker-src 'self' blob:;
  frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

  This closes the webview's own network: no `fetch`, `WebSocket`, image or stylesheet can reach any host but the app folder and Tauri's IPC. Without it the guarded fetch would gate nothing. It's loose on styles and strict on network on purpose: a page's own `<meta>` CSP can only add limits, so the app tightens the rest without an exe. Remote images, if the app ever wants them, come in through the guarded fetch as `blob:` URLs.
- **Navigation stays local.** Any navigation off `http://tauri.localhost` is refused and logged by scheme only. Unlike Desktop Buddies, it is not sent on to the browser, because a page could otherwise send data out in a URL with no click. `window.open` is denied the same way. Links go through `open_url`, from core only.

### Tests

- **Static, on Linux CI every push** (`apps/desktop/tests/capabilities.test.ts`): parses `capabilities/*.json` and `build.rs`. Fails if `views.json` grants anything outside its seven-item allowlist, if any capability uses a remote URL, if `settings-keys.json` grants more than its two, or if a command in `COMMANDS` is missing from every capability (or one in a capability isn't in `COMMANDS`).
- **On the runner, the refusal itself**: the check app opens `view-chat` and `view-settings`. Each calls every core-only app command and every plugin command (`plugin:notification|notify`, `plugin:global-shortcut|register`) with valid arguments, and expects each to reject with `not allowed by ACL`. `view-chat` also calls `secret_set` and must be refused. Then core makes the same calls and they must reach the command (a valid answer, or the command's own error, never the ACL's).
- **CSP on the runner**: core tries `fetch('https://example.com')`, a `WebSocket` to the fake server, and an `<img>` with a remote URL. Each must fail with a `securitypolicyviolation` event. A navigation to an `https` URL must be refused, and the driver counts browser processes before and after: none may start.

---

## 3. Origin and data folder, pinned

### The choices

- **Origin `http://tauri.localhost`.** Tauri's default on Windows, the same as Desktop Buddies. Set explicitly with `use_https_scheme(false)` in the one window helper, so a changed default in a future Tauri can't move it. `http://*.localhost` is a secure context in Chromium, so IndexedDB, Web Locks and `navigator.storage` all work. Desktop Buddies has the same origin, but its own WebView2 folder, so their storage never meets.
- **WebView2 data folder `%LOCALAPPDATA%\dev.exvanitas.familiar\webview\`**, passed to every window with `data_directory(...)`. WebView2 makes `EBWebView\` inside it, so IndexedDB lands in `webview\EBWebView\Default\IndexedDB\http_tauri.localhost_0.indexeddb.leveldb\`. A named subfolder rather than Tauri's default (the bare `%LOCALAPPDATA%\<identifier>`) so it never mixes with the exe's own files. With `--data-dir D`, it's `D\webview\`.
- **Native data `%LOCALAPPDATA%\dev.exvanitas.familiar\`**: `shell\` (the saved addresses and approved server setups, written only by the exe), `backups\`, `logs\` (`app.log`, capped at 1 MB with one old file kept, as Desktop Buddies). Local, not roaming: all of it is tied to this PC (local paths, approvals, keys' addresses), which the design keeps apart from data that could one day sync.
- **The identifier is pinned too**, because both folders are named after it.

### Why it survives updates

The install folder (`%LOCALAPPDATA%\Programs\Familiar\`) and the data folder are siblings under `%LOCALAPPDATA%`, and neither is inside the other. An app folder update replaces files in `app\`. A reinstall over the top and a winget upgrade both run the per-user installer, which replaces the install folder. None of them touch `%LOCALAPPDATA%\dev.exvanitas.familiar\`. A zip run from anywhere uses the same data folder. Uninstall keeps it unless the person ticks the box (step 12). The rule for every later step: nothing Familiar keeps may live in the install folder.

### The pin test

- **shell-core unit test** (Linux CI, every push): `ORIGIN == "http://tauri.localhost"`, `IDENTIFIER == "dev.exvanitas.familiar"`, and `webview_dir(local) == local\dev.exvanitas.familiar\webview`. The test file says in a comment that changing any of these empties every person's Familiar.
- **Config test** (Linux CI): `tauri.conf.json`'s `identifier` equals `IDENTIFIER`, and its `csp` equals the pinned string.
- **On the runner**: core reports `location.origin` and the check compares it with `ORIGIN`. Core writes a random value to IndexedDB with `durability: 'strict'` and quits. The driver checks the `.indexeddb.leveldb` folder exists at the pinned path. A second launch reads the value back. A third launch from a copy of the exe and app folder in another directory reads it too, which is what an install in a new place looks like.

### Persistent storage

At every start, core calls `navigator.storage.persisted()`, and if it's false, `navigator.storage.persist()`. It records `{ at, persisted, granted, quota, usage }` (the last two from `navigator.storage.estimate()`) in its settings and logs `persist granted=<bool>`. Settings shows the answer. If it's false, step 10's rolling backup turns on.

Whether WebView2 grants it is open. Chromium decides `persist()` by heuristics (engagement, an installed app, notification permission), and WebView2 has no permission kind for it that the exe could answer. **Step 3 measures it**: the check app logs both calls' answers and the estimate on a fresh data folder, on a second start, and after core has shown a notification. The summary records them as INFO, not pass or fail, and the result goes into this file. Nothing native depends on the answer, since `backup_write` is in the exe either way.

---

## 4. Plugins

| Plugin | Version | For | Permissions, core only |
| --- | --- | --- | --- |
| single instance | `=2.5.5` | A second launch hands its arguments to the first and exits. The exe emits `second-launch` to core | None. Rust only |
| notification | `=2.8.0` | Reminder toasts, with buttons while the toast is on screen | `notify`, `is-permission-granted`, `register-action-types`, `register-listener`, `remove-listener` |
| global shortcut | `=2.4.1` | The hotkey that shows chat | `register`, `unregister`, `is-registered` |

Dropped, each for a reason:

- **autostart plugin**: Desktop Buddies' own Run-key code (`platform::set_autostart`, proven on the runner) is 15 lines on the `windows` crate. The command is `autostart({ on? })`, current user only, and the Run entry carries `--autostart` so the app can tell a sign-in launch apart.
- **dialog plugin**: it would bring a JS surface and the fs plugin. Desktop Buddies' `IFileSaveDialog` code covers saving, the same code with `IFileOpenDialog` covers picking a file or folder, and `TaskDialogIndirect` covers the two confirms. Opening a card or an import file needs no native code: `<input type=file>` works in WebView2.
- **opener plugin**: `open_url` (https only) and `open_folder` (two named folders) are a few lines each, copied from Desktop Buddies, and their rules then live in shell-core where tests reach them.
- **HTTP plugin**: replaced by the guarded fetch ([5c](#5c-the-guarded-fetch)). Its URL scope is fixed at build time, and the endpoints people type can't be known then, so it would have to allow every `https` URL.
- **WebSocket plugin**: it has no URL scope at all (2.5.0 has only `connect` and `send`), so it would be an open network path around every gate. Replaced by loopback-only commands ([5d](#5d-the-rest)).
- **clipboard plugin**: `navigator.clipboard.writeText` works in a secure context after a click. **Step 3 checks it on the runner**: a view writes text after a real click from the driver, and the driver reads the clipboard. Only if that fails does `tauri-plugin-clipboard-manager =2.5.0` go in, with `allow-write-text` alone, for core and views. Either way it's settled before the exe is.
- **SQL plugin**: out, storage is IndexedDB. **fs and shell plugins**: never.

**Toasts need an app id Windows knows.** The notification plugin sets the toast's AppUserModelID to the identifier when the exe isn't in a `target\` folder. Windows only shows toasts for an unpackaged app whose id it knows, from a Start menu shortcut or from `HKCU\Software\Classes\AppUserModelId\dev.exvanitas.familiar` (`DisplayName`, `IconUri`). The exe writes that key at each start (current user, idempotent), so a zip run works like an install, and the uninstaller removes it. **Step 3 checks** that `ToastNotificationManager.CreateToastNotifier('dev.exvanitas.familiar').Setting` reads `Enabled` from PowerShell after a start. That a toast is really seen, and its buttons, are step 13's, on a real PC.

---

## 5. Native commands

Every command is in `COMMANDS`, takes named arguments, and returns `{ kind, message }` errors with fixed kinds. No error carries a key, a URL's query, a server's output or a file's contents. Bytes go as raw IPC bodies, with the other arguments in a percent-encoded `x-spec` header, as in Desktop Buddies. Rules live in `apps/desktop/shell-core` (plain Rust, no Tauri, `cargo test` on Linux), and `src-tauri` is thin glue.

### 5a. Credentials

**Choice: keys go into Windows Credential Manager and never come back out to any page. The guarded fetch puts the real key into a request natively, in place of a placeholder.**

```ts
secret_set(ref: string, value: string): void          // view-settings only
secret_status(ref: string): { present: boolean, boundTo: string | null }   // core, view-settings
secret_delete(ref: string): void                      // core
```

- `ref` is `addr:<addressId>` for a model endpoint or remote server, or `server:<setupId>:<NAME>` for a local server's setting. Anything else is refused (`invalid`).
- One credential per ref: service `dev.exvanitas.familiar`, user the ref, through `keyring::Entry`. The stored secret is `{"v":1,"for":"<address or setup id>","value":"..."}` as UTF-8 bytes (`set_secret`), which stays under Credential Manager's 2560-byte blob limit.
- **Bound to the address.** For `addr:` refs the exe writes `for` from its own saved-address list, never from the page. A saved address can't be edited: changing it in Settings removes the old entry and adds a new one, which has a new id and no key. So the app asks for the key again, and the old key can never go to the new address. `address_remove` deletes its key.
- **Limits**: value 1 to 1024 bytes, printable ASCII or UTF-8 with no control characters (CR or LF in a key would split a header). Refs up to 128 characters.
- **Never written** to files, logs, IndexedDB, exports or errors. There is no `secret_get`.

**The stronger option, checked: it works.** A throwaway probe on Linux ran pi-ai 1.5.2 with `apiKey: <placeholder>` and an injected fetch that recorded each request, against OpenAI-compatible, Anthropic, Gemini through Google's OpenAI-compatible endpoint, OpenRouter and an LM Studio-style local address. In every case the placeholder appeared in exactly one header and nowhere else:

| Target | Header with the placeholder | In the URL | In the body |
| --- | --- | --- | --- |
| OpenAI-compatible, OpenRouter, LM Studio | `authorization: Bearer <placeholder>` | no | no |
| Gemini through `/v1beta/openai/` | `authorization: Bearer <placeholder>` | no | no |
| Anthropic | `x-api-key: <placeholder>` | no | no |

The SDKs only need a non-empty `apiKey`, so the placeholder satisfies them. The probe also showed what the fetch receives: the URL as a string, the body as a JSON string, and a signal.

How the swap works:

- For every endpoint that has a key, the app passes the fixed placeholder `familiar-stored-key` as pi-ai's `apiKey` option. A keyless local endpoint gets any other non-empty string.
- In `net_fetch`, for a request under saved address A, the exe replaces exact occurrences of `familiar-stored-key` with A's key, only in the values of `authorization`, `x-api-key`, `api-key` and `x-goog-api-key`. Nowhere else, never in the URL or body.
- The placeholder in one of those headers with no key stored for A is refused as `no-key`, and the app asks for one.
- Remote MCP servers use the same thing for their `Authorization` header.
- On a response of 400 or more with a body up to 64 KiB, the exe buffers the body and replaces any copy of the key with `[key]` before the page sees it. Providers sometimes echo a key back in an error.

**Recommendation: do it.** It costs the swap and the header list, about an hour with tests, and it means a page that runs bad script can use a key only through Familiar, while Familiar runs, at an address the person saved. It can't carry the key away. A key stolen out of the webview would be lasting, billable harm outside the app.

**What's left.** The key passes through Settings' page once, between paste and `secret_set`. A native entry prompt would close that, at about two more hours and a harder runner test (the Windows credential prompt runs in its own broker process). I'd accept the residual: it needs script already running inside Settings at the moment of the paste, and that script could use the key through the app anyway. OAuth tokens for remote servers (see 5d) also pass through core once, at the token exchange.

**Tests.** shell-core: ref parsing, the value rules, the swap (only those headers, exact match, `no-key`, the redaction). On the runner: Settings sets `addr:<id>` to a random fake key. `secret_status` says present and bound. The driver lists Credential Manager (`cmdkey /list`) and finds the target name. Core fetches the fake server with the placeholder, and the fake server answers with a SHA-256 of the header it got, which must match the fake key's. Core removes the address, the fetch is then `not-saved` and the credential is gone from `cmdkey`. Last, the driver searches every file under the data folder, the WebView2 folder and the log, in UTF-8 and UTF-16, for the fake key's bytes. It must find none.

### 5b. Starting a local MCP server

**Choice: the exe starts only a saved setup the person approved in a native dialog, in its own kill-on-close job, with a minimal environment, and blanks the setup's secrets from everything it prints.** The mcp-start spike (`spikes/mcp-start/RESULT.md`, two green runs on `windows-latest`) proved each part, and this follows it.

```ts
server_start(setup: Setup, owner?: string, channel: Channel<ServerEvent>): { run: string }
server_write(run: string, body: bytes): void         // to stdin, at most 4 MiB a call
server_stop(run: string): void
server_forget(setupId: string): void

type Setup = { id, label, program, args: string[], cwd, env: [name, value][], secrets: string[] }
type ServerEvent = { t: 'out', line } | { t: 'err', line } | { t: 'exit', code: number | null }
```

**Resolving and checking**, before anything is shown or run:

- `program` is a bare name or a full path. A bare name is looked up the spike's way: absolute PATH folders only, never the working folder, PATHEXT order, and only `.exe`, `.cmd` or `.bat`. That picks `npx.cmd` over `npx.ps1`, which the spike showed matters. A relative path is refused.
- The resolved full path is what the dialog shows and what's stored, so a later PATH change can't swap the program silently.
- Arguments with NUL, CR or LF are refused for every program (`unsafe-argument`), so a setup doesn't work with `node` and fail with `npx`. Any other `InvalidInput` from `spawn` becomes the same error. Setting names that are empty or hold `=` or NUL, and values with NUL, are refused. Limits: 64 arguments, 32 settings, 32 secret names, 16 KiB for the whole setup.
- `cwd` must be an existing absolute folder.

**The approval.** The exe keeps approved setups in `shell\servers.json`, which only it writes. The canonical form is the resolved program, the arguments, the folder, the plain settings and the secret names, never their values. `server_start` compares that form with the stored approval for `setup.id`:

- **Equal**: it starts, with no dialog.
- **Different or new**: the exe shows a `TaskDialogIndirect`, owned by the `owner` view if it's showing, else top-most with no owner. Title "Start a program?". The text names the server, the resolved program, each argument on its own line, the folder, each plain setting as `NAME=value`, and each secret as `NAME (kept in Credential Manager)`, then "It runs as you, with your files. Only start programs you trust." The buttons are "Start it" and "Don't start", and "Don't start" is the default, so a stray Enter refuses. "Start it" stores the approval and starts. "Don't start" returns `declined`, and the same form is refused without a dialog for 10 s, so a page can't flood the screen. One dialog at a time across the exe, and a second ask meanwhile gets `busy`.
- A page can't fake or skip it: the dialog is drawn by Windows, it isn't in any webview, and nothing but the person's click writes `servers.json`.

**Starting** (the spike's sequence):

1. `env_clear`, then the 22 names of the spike's `ENV_ALLOWLIST` that exist, then the plain settings, then each secret read from Credential Manager by `server:<id>:<NAME>`. Nothing else from Familiar's environment reaches the server. The spike saw 23 variables reach it out of the parent's 147.
2. `CreateProcess` with `CREATE_NO_WINDOW | CREATE_SUSPENDED`, stdin, stdout and stderr piped.
3. A new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`, the process assigned, then its thread resumed. Nothing runs outside the job, so no grandchild escapes. One job per server, and the handle isn't inheritable and is held only by the exe. In the spike, killing the app hard ended all 14 processes of three servers within 18 ms. Without the job, a busy server lived on.
4. stdout is read line by line on its own thread. A line over 4 MiB is dropped with an `err` event saying so. stderr lines are cut at 8 KiB. Both go to core over the `Channel` core passed in, which only core receives, never as a broadcast event.
5. **Before a line leaves Rust**, every secret value of the setup (6 characters or more) is replaced with `[hidden]`, on stdout and stderr both. Without this a server that prints its token would put it in the webview. The spike did the same on stderr.

**Stopping.** `server_stop` closes stdin, waits up to 500 ms (an idle server exits in about 100 ms), then `TerminateJobObject`. When Familiar exits or crashes, the kernel closes the job handle and that ends the tree, with no code.

**Limits.** 16 servers running at once (`busy` past that). `server_write` at most 4 MiB.

**Tests.** shell-core: resolution on a fake PATH, the refusals, the canonical form (a changed argument, folder, setting or secret name changes it, a changed secret value doesn't), the blanking across line content. On the runner, against `tools/fake-mcp-server` started as `node <repo>\tools\fake-mcp-server\src\main.ts`:

- A first start shows the dialog. The driver reads its text through UI Automation, checks the resolved `node.exe` path and each argument are there, and clicks "Start it". `initialize` and `tools/list` work over the channel.
- A second start shows no dialog. A changed argument (`--variant b`) shows it again, and "Don't start" gives `declined`.
- `print_secret` comes back with `[hidden]`, and the driver's search finds the secret in no file.
- `list_env` shows only allowlisted names and the setup's own.
- The driver kills `familiar.exe` with `Stop-Process -Force` while a `slow` call runs, and no `node.exe` from the setup is left 2 s later.
- A setup with an argument holding CR, LF or NUL is refused as `unsafe-argument` under `node` and under a `.cmd` alike, before any process exists. So is a setting named `""` or `A=B`, or a value with NUL. The spike didn't run the setting checks, so these are new.
- `npx`, `uvx` and the 20 kinds of tricky argument through `npx.cmd` are proven by the spike and aren't repeated. A console flash seen by eye, and Smart App Control on binaries that npm or uv download, are step 13's, on a real PC.

### 5c. The guarded fetch

**Choice: one fetch path for every model endpoint and remote server, `net_fetch`, which reaches only saved addresses. It replaces the HTTP plugin entirely.** Combined with the CSP, it's the only way out of Familiar to the network.

**Saved addresses** come first:

```ts
address_list(): Address[]
address_add(kind: 'model' | 'server', url: string, label: string, owner?: string): Address
address_remove(id: string): void

type Address = { id, kind, url, label, reach: 'public' | 'lan' | 'loopback' }
```

- `url` is normalized: scheme and host lower case, the host as punycode, the default port dropped, no user info, query or fragment, no trailing slash. `https` is required unless `reach` is `lan` or `loopback`.
- `reach` comes from the host. A literal IP is classed directly, and `localhost` is loopback. A name is resolved once at `address_add`: all-loopback answers make it loopback (Ollama at `http://localhost:11434`), all-private answers make it lan (LM Studio on another PC at `http://192.168.1.20:1234`), and anything else is public. Mixed or empty answers are refused.
- **Adding asks the person natively.** A `TaskDialogIndirect`: "Let Familiar send to this address?", the normalized URL shown in punycode (so a look-alike name shows as what it is), what it is ("a model endpoint" or "an MCP server"), and for lan or loopback "on your own network" or "on this PC". Buttons "Allow" and "Don't allow", with "Don't allow" the default. The same one-at-a-time and 10 s rules as 5b. Adding a URL that's already saved returns the saved entry with no dialog. The list is in `shell\addresses.json`, which only the exe writes.

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
- `address` is a saved address id, and `url` must be under it: the same origin, with a path under the saved path at a segment boundary. Otherwise `not-saved`.
- **Where it may connect.** Every connection, redirects included, goes through a custom `reqwest::dns::Resolve` that keeps only answers of the address's `reach`. Link-local (`169.254/16`, `fe80::/10`, the cloud metadata address among them), unspecified, multicast and broadcast are refused always, and IPv4-mapped IPv6 is classed as its IPv4. So a public name that resolves to `127.0.0.1` or `10.0.0.5`, at add time or later (DNS rebinding), gets `blocked-address`.
- **Redirects**: up to 5, each target checked with the same rules and required to be under the same saved address. Anything else is `redirect-refused`. Since the target stays under the saved address, the key stays with the address it's bound to.
- **Proxy**: public addresses use the Windows system proxy (reqwest's default reading of the per-user settings). With a proxy the proxy resolves the name, so the exe also resolves it first and refuses a non-public answer. lan and loopback never use a proxy. A PAC script isn't supported (see [8](#8-what-could-force-a-second-exe)).
- **TLS**: rustls with the platform verifier, so roots installed on the PC, such as a company's, are trusted as Windows trusts them. Step 3 confirms on the runner that a `https` fetch to a public test host works and that a self-signed local `https` server is refused.
- **Headers**: up to 64 request headers of up to 8 KiB each. `host`, `content-length`, `transfer-encoding`, `connection`, `cookie` and `proxy-*` from the page are dropped. There's no cookie store, and `set-cookie` is dropped from responses. The key swap happens here (5a).
- **Limits**: request body up to 16 MiB. Response headers up to 64 KiB. `maxBytes` defaults to 32 MiB with a hard cap of 256 MiB, counted after decompression so a small compressed body can't expand past it. Connect 20 s fixed. `headersMs` (time to the head) and `idleMs` (between chunks) default to 120 s, with a cap of 15 min. There's no total limit, so a long reply streams for as long as it keeps coming. Up to 32 requests open at once.
- **Streaming and stopping.** `guardedFetch` returns a `Response` over a pull-based `ReadableStream`, each pull one `net_read` of up to 1 MiB. On the signal it calls `net_cancel`, which aborts the request task and drops the connection. A pending `fetch` then rejects, and the stream errors, with `new DOMException('Aborted', 'AbortError')`, the same as the browser's own fetch. (The spike's Tauri shape, a plain `Error`, passed the contract too.) A signal already aborted never reaches the exe.
- **Errors**: `not-saved`, `insecure`, `blocked-address`, `redirect-refused`, `no-key`, `too-large`, `timeout`, `tls`, `network`, `cancelled`, `busy`, `invalid`. A thrown error is a `TypeError` with `cause.kind`, as fetch's network errors are, so pi-ai's adapter sees a network failure and Familiar's wrapper reads the kind.

**Tests.** shell-core: normalization, `reach` classing (every reserved range), the under-address rule, redirect decisions, header filtering, the limits. On the runner, with a small Node server in `shell-check` on `127.0.0.1` and a `hosts` entry `familiar-check.test` pointing at it (the runner is admin, and the driver restores `hosts` afterwards):

- Adding an address shows the dialog, and the driver clicks Allow (once) and Don't allow (once). Before Allow, a fetch is `not-saved`.
- A 40-chunk stream arrives whole. A stop after chunk 3 rejects within 100 ms, and the server sees the connection close.
- `headersMs` and `idleMs` time out. A body past `maxBytes` gives `too-large`, and so does a gzip bomb.
- A redirect inside the saved address is followed. One to another path, and one to an unsaved host, give `redirect-refused`.
- `https://familiar-check.test` saved as public is `blocked-address`, since it resolves to loopback. `http://` to a public address is `insecure`.
- The key swap and redaction (5a).
- step 4's model-port contract runs over `guardedFetch` in the real webview against the same server, with recorded OpenAI and Anthropic streams, all six cases.

### 5d. The rest

Each of these is here because a page can't do it and a later need would otherwise force an exe.

| Command | Does | Limits and rules | Why it's native |
| --- | --- | --- | --- |
| `shell_info()` | `{ api, version, args, dataDir, webviewDir, origin, autostarted }` | | The app needs to know which exe it's on, so later apps run on this exe |
| `shell_ready()` | Core says it started | Once | The broken-folder box (1) |
| `log_line(line)` | One line to the log | 4 KiB a line, 100 lines a second a window | Bug reports, and the runner checks read it |
| `quit()` | Emits `quitting`, waits up to 3 s for core's `quit_ready`, exits | | Core finishes a write first. Tray Quit takes the same path and works with core dead |
| `view_open(spec)` | Opens a view window | Label `view-[a-z0-9-]{1,32}`, page a plain `.html` name in the app folder, size, title, `decorations`, `transparent`, `alwaysOnTop`, `skipTaskbar`, `visible`. The label `core` can't be made | New views need no exe, and every window gets the pinned folder, origin, CSP and arguments |
| `autostart({ on? })` | Reads, or sets then reads, the Run entry | Current user. The entry runs the exe with `--autostart` | Registry |
| `open_url(url)` | The default browser | `https` only, 2048 characters, no control characters or spaces | Navigation is refused, so links need a door, and only core holds it |
| `open_folder(which)` | Explorer at `backups` or `logs` | Only those two | Settings shows where backups are |
| `pick_path({ kind, filters?, owner? })` | Native open dialog, returns a full path or null | `kind` is `file` or `folder` | A server setup needs real paths, which `<input type=file>` hides |
| `save_as({ name, filters, owner? }, bytes)` | Native save dialog, writes the bytes there | 256 MiB. Desktop Buddies' API 2 code: a new temp file beside the target, swapped in with `ReplaceFileW`, links refused | Export (step 10) |
| `backup_write(slot, bytes)`, `backup_list()`, `backup_read(slot)` | The rolling backup | Slots 0 to 7, 128 MiB a file, atomic writes, inside `backups\` only, names fixed by slot | The fallback if `persist()` is refused (step 10). The bound is in the exe, so a page can't fill the disk |
| `oauth_wait({ path, state, timeoutMs })` | Listens once on `127.0.0.1`, on a free port, and returns `{ port }` then `{ query }` | One GET to `path` with a matching `state`, any other request gets 404, 5 min at most, one at a time | Remote MCP servers that use OAuth need a loopback redirect. Without this, the first one would need a new exe |
| `peer_read(peer)` | Text of a peer app's discovery file | `peer` is `desktop-buddies` only, mapped in the exe to its `%APPDATA%` and Store paths. 4 KiB | Part 2: finding Desktop Buddies' port and token |
| `ws_connect({ port, path, headers }, channel)`, `ws_send(id, text)`, `ws_close(id)` | A WebSocket client | `ws://127.0.0.1:<port>` only, path 256 characters, 8 headers, messages 1 MiB, 4 at once, messages to core over the channel | Part 2's buddy link, built now so part 2 needs no exe |
| `net_fetch` with `loopback: { port }` in place of `address` | Plain HTTP to `127.0.0.1:<port>` | No key swap, no redirects, the same limits | Desktop Buddies' API v2 HTTP endpoint. Loopback reaches nothing a web page couldn't already send to |

Also native, with no command: the toast app id (4), the tray with its Quit, and the single-instance hand-off.

The part 2 commands carry the format risk on purpose in the app: `peer_read` returns the file as text, and the app parses it. Only the file's location is in the exe, so it must be agreed with Desktop Buddies' API v2 now (see [Decisions](#decisions-for-the-lead)).

**Tests**: shell-core for every rule in the table. On the runner: `view_open` with a bad label or page refused, `open_url` with `http:` or `javascript:` refused and a valid one starting a browser (the driver counts browser processes and closes them, as Desktop Buddies' does), `save_as` through the dialog (the driver types a path through UI Automation), `backup_write` past slot 7 or past 128 MiB refused, `autostart` set and cleared with the registry read back, `oauth_wait` answering one matching request and 404 to others, `ws_connect` to a non-loopback host refused and a round trip to a Node WebSocket server in shell-check, `peer_read` of a fake discovery file under a scratch `%APPDATA%`.

---

## 6. Tray, hotkey, autostart, single instance, notifications

- **Tray.** Up before any page runs, with only Quit, which the exe appends and handles itself, so it works with core dead (Desktop Buddies' `tray.rs`). Core sets the rest with `tray_set({ tooltip, icon, items })` (icon a PNG from the app folder). A menu click emits `tray` to core, a left click `tray-click`. Closing every window never ends the run, only Quit does.
- **Hotkey.** Core registers the person's chosen shortcut through the plugin and shows or focuses chat when it fires. If registering fails (another app has it), Settings says so. No default hotkey is registered until the person picks one in first-run setup.
- **Autostart.** Off until the person turns it on. The Run entry starts `familiar.exe --autostart`. A sign-in start keeps chat closed and goes to the tray.
- **Single instance.** A second launch hands its arguments to the first and exits within a second. The first emits `second-launch`, and core shows chat. A sign-in start while Familiar is already running is a no-op.
- **Notifications.** Core shows reminder toasts with a title, body and up to three buttons (for example Done and Snooze). A click on the toast or a button reaches core while the toast is on screen, and core shows the reminder card in chat. A click from the Action Center is not reported (the plugin says so for Windows), so the card in chat is always the source of truth and a toast is only a nudge.

---

## 7. Checks on the Windows runner

Modelled on Desktop Buddies' `shell.yml`: `.github/workflows/shell.yml` on `windows-latest`.

1. Toolchain from `rust-toolchain.toml` (1.95.0). `cargo test --locked` in `shell-core`. `cargo build --release --locked` in `src-tauri` (`custom-protocol` on, no Tauri CLI needed). The exe's size and SHA-256 go in the job summary and it's uploaded as an artifact.
2. `pnpm install --frozen-lockfile`, then build the check app folder (`apps/desktop/shell-check`) and the real app folder.
3. **Contract check.** `shell-check/driver.ps1` launches the exe on the check app folder with a scratch `--data-dir`, `--seconds`, and `--log`. Its core page runs every check through the app's real client (`src/shell.ts`) and logs `CHECK PASS|FAIL|SKIP name detail`. When it needs something no page can do, it logs `STEP n action args` and the driver does it: click a native dialog through UI Automation, read `cmdkey`, search files for a key, edit `hosts`, kill the exe hard, count processes, read the registry and the clipboard. There's no test code in the exe. A check that couldn't run says SKIP, never PASS. The job fails on any FAIL. The checks:
   - the capability refusal from both views, and core reaching every command (2)
   - CSP blocking network and the navigation refusal (2)
   - the pinned origin, the IndexedDB folder at the pinned path, a value surviving a restart and a move (3)
   - `persist()` and `persisted()` answers and the estimate, as INFO (3)
   - the credential round trip and the no-copy search (5a)
   - the guarded fetch cases against the local fake server (5c)
   - the fake MCP server start, dialog, re-ask, blanking, environment and hard-kill cleanup (5b)
   - the rest of 5d, single instance, autostart, the toast app id, and the web clipboard (4)
   - the missing and broken app folder boxes (1)
   - a clean quit: no `familiar.exe`, no `msedgewebview2.exe` using the scratch folder, no server left
4. **Smoke run.** The real app folder with a fresh data folder: core starts, says ready, opens chat, and quits cleanly, judged from the log.
5. **Soak, by hand** (a `soak` input, as Desktop Buddies has): core hidden with no views for N seconds, logging its timer rate, to see whether WebView2 throttles it. Desktop Buddies measured no throttling for its hidden hub. Familiar's reminders depend on the same.

**When they run.** The repo is public, so Actions minutes are free, but a Windows build takes a while.

| Trigger | Runs |
| --- | --- |
| Every push, any branch, Linux | `shell-core` `cargo test`, the capability and pin tests, typecheck and tests (already in `ci.yml`) |
| Every push touching `apps/desktop/src-tauri/**`, `shell-core/**`, `shell-check/**` or `shell.yml` | The whole workflow: build, contract check, smoke |
| Every push to `main` | The contract check and smoke with the current app folders on the latest exe built from `main` (`reuse`), so an app change can't quietly break against the settled exe |
| By hand | Any of it, with `reuse` and `soak` |

---

## 8. What could force a second exe

| Could force one | How this design avoids it, or what's left |
| --- | --- |
| New views, windows or tray items | `view_open` and `tray_set` are general. Window flags for a borderless or always-on-top view are already in the spec |
| A new provider or wire | Every API goes through `net_fetch` with the placeholder swap. A provider that wants the key elsewhere than the four headers, say in the URL, would need one. None of the three planned do |
| Remote servers with OAuth | `oauth_wait` is in now |
| Desktop Buddies' API v2 | WebSocket, loopback HTTP and `peer_read` are in now. Left: the discovery file's location is compiled in. Agree it with Desktop Buddies before step 3 ends |
| `persist()` refused and data evicted | `backup_write` is in now, whatever step 3 measures |
| Clipboard, or a missing browser argument | Decided by measurement in step 3, before the exe settles. Autoplay is already on |
| Toast clicks from the Action Center | Would need a COM activator. Avoided by design: the chat card is the source of truth |
| A server program kind other than `.exe`, `.cmd`, `.bat` | `.ps1` and bare scripts are refused on purpose. Python and Node scripts run through their `.exe` |
| A network that only has a PAC proxy script, or a proxy that wants a login | Not supported. Left as a known gap for the README. It would need a new exe if people hit it |
| A Tauri or WebView2 security fix in the exe's own code | Can't be avoided. Batch it with whatever else is waiting, as Desktop Buddies' "For the next exe" list does |
| Later tiers (UI Automation, screen and mouse) | Out of part 1 on purpose. They come with their own plans and their own exe |
| Signing (SignPath after the public flip) | A signed build is a new exe by nature, of the same source. It gets a reputation of its own, which is the point |

---

## 9. Hours

Step 3 is budgeted at 8. This design needs about **14**, honestly:

| Part | Hours |
| --- | --- |
| Skeleton from Desktop Buddies: assets, windows, tray, single instance, log, quit, the missing-folder box | 1.5 |
| App manifest, capabilities, CSP, navigation, their static tests | 0.75 |
| Guarded fetch: shell-core rules, resolver, redirects, limits, streaming, the key swap, `guardedFetch` | 3 |
| Saved addresses and the native confirm | 0.75 |
| Credentials | 0.5 |
| Server start, ported from the spike, with the approval store, dialog and blanking | 1.5 |
| Dialogs, save, pick, backups, links, autostart (mostly Desktop Buddies' code) | 0.75 |
| WebSocket, `peer_read`, `oauth_wait` | 1 |
| Notifications, hotkey, toast app id | 0.5 |
| The check app, the driver, the workflow, and runs on the runner until green | 3.5 |
| **Total** | **13.75** |

About 2 of that moves forward from later steps: step 7 no longer builds the server start, its approval or blanking, and step 4 gets its fetch already proven. So part 1 grows by about 4 hours, not 6. The parts that could be cut to save time are the ones that would force a second exe, so I wouldn't cut them.

---

## Decisions for the lead

1. **Settings may call `secret_set` directly**, write-only, so a key never crosses the shared page channel. The brief said only core may touch keys. Recommended: allow it, as in `settings-keys.json`.
2. **Key entry stays in the page**, not a native prompt. Recommended: accept the residual in 5a.
3. **Adding an address asks natively**, the same way a server start does. Without it, "saved addresses only" would be a list any page could extend. Recommended: yes.
4. **Desktop Buddies' API v2 discovery file**: Familiar's exe will read `%APPDATA%\dev.exvanitas.desktop-buddies\api\endpoint.json` and the Store's `%LOCALAPPDATA%\Packages\exvanitas.DesktopBuddies_x5a6e4dh4zehg\LocalState\data\api\endpoint.json`. Desktop Buddies' API v2 should write there. Needs agreement before step 3's exe settles.
5. **Step 3 at about 14 hours**, with 2 moving out of steps 4 and 7.

## Open, for step 3 to measure

- Whether WebView2 grants `navigator.storage.persist()` (3).
- Whether `navigator.clipboard.writeText` works in a view, which decides the clipboard plugin (4).
- Whether the registry app id is enough for toasts on an unpackaged exe (4).
- Whether the hidden core is throttled over a long run (7, soak).
- That rustls with the platform verifier trusts what Windows trusts (5c).
