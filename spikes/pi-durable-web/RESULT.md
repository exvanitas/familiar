# pi-durable in a webview: result

**Verdict: yes, with conditions.** `@earendil-works/pi-durable` 1.5.2 bundles for the browser with no Node polyfills, runs a durable tool-calling turn in headless Chromium, survives a reload mid-tool, and reports an unsafe tool as interrupted instead of running it again. Use its IndexedDB store first. Its SQLite core works too, but not over tauri-plugin-sql as it ships: it needs one dedicated connection.

Everything below was run with `pnpm --filter @familiar/spike-pi-durable-web spike` (HOME set to a fresh temp directory per step). Raw output is in `results/`. The browser was Chrome for Testing 156.0.8078.4 (`chromium-1248`), headless, on Linux. WebView2 itself was not run.

What the spike runs, all with fakes:

- `src/engine.ts`: the engine path Familiar would use. Harness, registry, one extension with a `save_note` tool, a consent hook, a reminder task.
- `src/port-provider.ts`: a pi-ai provider built from Familiar's `ModelPort`. Every turn in this spike went through `@familiar/core`'s `createFakeModel`, not pi-ai's faux provider.
- `src/sqljs-database.ts`: pi-durable's SQLite facade over sql.js, logging every call. It saves the database to IndexedDB after each commit, so it survives reloads like a file would.
- `scripts/browser-check.mjs`: builds the page with Vite, drives Chromium, reloads mid-turn.
- `scripts/bundle-check.mjs`: bundles each entry point for the browser and records Node imports and sizes.
- `scripts/pool-hazard.mjs`: what a pooled SQL plugin does to pi-durable's transactions.
- `tests/sqljs-conformance.test.ts`: pi-durable's own storage conformance suite under Vitest.

## 1. Browser fit

Each entry point was bundled by Vite 8.3.8 for the browser, with Node built-ins left external and recorded with the import chain that reached them (`results/bundle.json`).

| Entry point | Node built-ins |
| --- | --- |
| root (`Harness`, `defineTool`, `defineTask`, `MemoryStorage`, hooks) | none |
| `storage/indexeddb`, `storage/sqlite`, `storage/memory`, `storage/jsonl`, `storage/store` | none |
| `testing`, `env`, `tools`, `images`, `codemode`, `tool-search` | none |
| `env/node` | `node:child_process`, `fs`, `fs/promises`, `crypto`, `path`, `url`, `os` (from `env/node.js` and `env/node-watch.js`) |
| `storage/sqlite/node` | `node:sqlite`, `fs/promises`, `path` (from chord's `sqlite/node.js`) |
| `pi-ai` root (not needed) | `node:fs`, via `utils/provider-env.js` from `cache-warming.js` |
| `pi-ai/models` | none |

The path Familiar needs (root, a storage, `pi-ai/models`, `pi-ai/utils/event-stream`, `pi-ai/utils/transcript`, `chord/context`) bundles with zero Node built-ins and no references to `process.*`, `Buffer.*` or `require(`. The page build had no warnings and the page threw no errors. Nothing needs a shim. Only the two `/node` entries are Node-only, and Familiar never imports them.

## 2. A durable turn in a page

Each scenario starts a turn, reloads the page at a set moment, reopens the same storage with the same extensions, calls `harness.resume()`, and resubmits with the same `requestId`, which finds the same submission. Counters live in localStorage so they survive the reload.

| Scenario (store) | What happened after the reload |
| --- | --- |
| Tool in flight, default `replay: "unsafe"` (IndexedDB and sql.js) | Tool started 1 time in all. The result is an error with diagnostic code `interrupted`: "Tool save_note was interrupted and may have partially run". The model got it and answered. Settled `done`. |
| Tool in flight, `replay: "safe"` (IndexedDB and sql.js) | Tool started 2 times. Second run succeeded ("saved: buy milk"). Settled `done`. |
| Reload while consent was still being asked | Consent asked 2 times, tool started 1 time, after the second ask. The unanswered ask never ran the tool. |
| Consent denied | Tool started 0 times. Result is an error with code `blocked`: "Tool call blocked: The user said no." |
| Reload while the model was mid-answer | The partial answer is kept as an `aborted` entry ("Let me think abo"). The request was sent again after the retry backoff, and the run settled `done` about 2 s after reopening. |
| `maxTurns: 2`, model always calls a tool | Settled `unanswered`, reason `turn_limit`, `runFailure.detail` "2 turns". |

So the rule is there and it works: a call whose intent was committed and whose tool is not replay-safe is never executed again. It comes back to the model as an `interrupted` error result. Reopening and finishing a turn took 30 to 50 ms after the page script started.

One thing to know: a model request cut off by a crash is sent again (it counts as a failed attempt under `settings.retry`). That costs a second paid call, but has no side effects.

## 3. Storage

**(a) IndexedDB works in the page.** pi-durable's own storage conformance suite (`createStorageConformance`, 32 cases) passed 32 of 32 in Chromium. Every reload scenario above passed on it. The README says one owner must hold the database at a time, so use a Web Lock around the Harness lifetime, plus `navigator.storage.persist()`.

**(b) The SQLite core works over an async in-page SQLite.** Over sql.js, the same suite passed 32 of 32 in the page and 32 of 32 under Vitest with Vitest's own `expect`, which checks the page's small assertion shim. The reload scenarios passed on it too.

**How pi-durable uses `transaction()`.** It calls it in three places:

1. `SqliteStorage.commit()` (`dist/storage/sqlite/storage.js` line 102): every durable commit. Inside one transaction it reads the metadata row and the current records and documents, runs its own checks in JavaScript (a batch can be refused), then writes with multi-row statements, then updates the metadata. A batch that forks a conversation writes first and then reads the copy's source back.
2. `SqliteStorage.document()` (line 411): a read of a document's record, base and deltas that must see one committed state.
3. Migrations (chord's `applySqliteMigrations`): DDL, then a version read, then a version write.

So it needs real interactive transactions: statements whose parameters depend on rows read earlier in the same transaction, and reads that must see the transaction's own writes. A one-shot "run this batch" Rust command cannot serve it, because the writes are not known until the reads come back.

Measured over sql.js, resuming and finishing one turn cost 128 SQL calls: 14 transactions of 3 to 10 statements each (35 reads and 35 writes inside them), 9 of them reading before they write, plus 30 single reads outside transactions. The longest transaction held the database 5.4 ms. It never waits on anything but SQL while holding it.

**Why tauri-plugin-sql as it ships is not safe for this.** The plugin opens a default sqlx pool (`Pool::connect(db_url)` in `plugins/sql/src/wrapper.rs` on the plugins-workspace v2 branch, read 2026-11-14), so up to 10 connections, and it has no transaction command. A facade over it would send BEGIN, each statement and COMMIT as separate calls, and each could land on a different connection. `scripts/pool-hazard.mjs` simulates that with node:sqlite, one file and a pool that hands out the next connection per call:

| Pool | BEGIN form | Bare test: insert, then ROLLBACK | pi-durable conformance |
| --- | --- | --- | --- |
| 2 connections | `BEGIN IMMEDIATE` | fails with "database is locked" | 0 of 32 ("database is locked") |
| 2 connections | `BEGIN` | the "rolled back" row stays: 1 row left | 0 of 32 ("SQLite schema metadata is missing") |
| 1 connection | `BEGIN IMMEDIATE` | 0 rows left, as it should be | 32 of 32 |

With calls made one at a time, a real sqlx pool would often reuse one connection and look fine. It breaks once anything else opens a second connection, either loudly or by silently losing atomicity.

**The smallest safe answers, in order:**

1. **The IndexedDB store.** No Rust, passes everything here. The condition is a fixed webview origin. Tauri's Windows origin changes with settings like `useHttpsScheme`, and a new origin means an empty database. It also lives in WebView2's data folder, not in a file Familiar controls.
2. **SQLite over one dedicated connection.** About four Rust commands (`exec`, `run`, `get`, `all`) over a single connection that nothing else uses, with the JavaScript facade queueing calls the way `src/sqljs-database.ts` does. BEGIN IMMEDIATE and COMMIT are then ordinary calls, which the 1-connection row above shows is enough. rusqlite with one `Connection` in a mutex, or sqlx with `max_connections(1)`, would do. This is not a batch command, and not tauri-plugin-sql. Each turn costs about 130 IPC calls, which was not measured over real Tauri IPC.

## 4. Size

Minified, then gzipped at level 9 (`results/bundle.json`):

| Bundle | Minified | Gzipped |
| --- | --- | --- |
| Familiar engine + IndexedDB store | 451.5 KiB | 113.3 KiB |
| Familiar engine + SQLite core | 461.5 KiB | 115.4 KiB |
| Familiar engine + both | 485.2 KiB | 119.9 KiB |
| for comparison: pi-durable root alone, every export kept | 412.8 KiB | 104.2 KiB |

Where the engine's bytes come from, before minifying: pi-durable 367 KiB, chord 100 KiB, pi-schema 95 KiB (tool argument validation), pi-ai 73 KiB (`models`, the stream and transcript utilities, no providers), the spike's adapter and engine 8 KiB. Tree-shaking removes little, because the harness itself is most of it.

No pi-ai provider, provider SDK, photon, codemode, QuickJS or `diff` module is in the engine bundle. The only pi-ai module under `api/` is `api/lazy.js`, a helper with no provider code. They come in only through their own entry points: `images` is 2465.8 KiB (921.3 KiB gzipped, mostly photon's wasm), `codemode` 156.7 KiB, `tools` 46.0 KiB with `diff`. So they can be left out, simply by not importing those paths. They still download at install time as dependencies of pi-durable, which affects the lockfile, not the app.

## 5. Fit with Familiar's design

- **Model port:** it sits behind the port for calls. pi-durable insists on a pi-ai `Models` object, but a custom provider built with `createProvider` is enough (`src/port-provider.ts`, about 150 lines). Every turn here ran through it, using Familiar's own fake model. pi-ai's types do go end to end in storage, though: the transcript stores pi-ai `Message` objects. Two losses in translation: pi-ai decides retries from error text, so the adapter has to turn `rate-limit`, `server` and `network` into words its pattern matches, and `retryAfterMs` has nowhere to go.
- **Consent before a tool runs:** yes. A `beforeTool` hook may be async and return `{ block }`. It runs before the intent is recorded, so a restart during an unanswered ask asks again and never runs the tool. The pending ask is held in memory, not as a durable wait. Familiar should keep the open consent card in its own document so the UI can show it after a restart.
- **Step cap:** yes. `maxTurns` per conversation ends the run `unanswered` with `turn_limit`, and a `continue` submission can resume it.
- **Parked waits for reminders:** yes. A task ending its phase with `runtime.sleepUntil(at, checkpoint)` survived a reload and fired 4 ms after it was due. A reminder due while the page was closed fired 3 ms after `resume()`, 52 ms after the reopened engine started (1672 ms after it was due). Its timers are `setTimeout` in the webview by default. A hidden window may throttle them, which was not tested. The Harness takes `now`, `setTimer` and `onWake`, so the clock port and a native wakeup can drive it.
- **A state it can report:** yes, from committed state. `conversation.watch()` gives `docs["pi.live"]` with `run`, `generation` and `tools`. The spike reads thinking, working and idle from it, for example `idle > waiting > thinking > working > waiting > thinking > idle` for a denied tool. "Waiting for you" (consent) is not visible there and has to come from Familiar's own consent state.
- **No file or shell tools:** nothing registers tools unless you install them. The engine bundle contains no module from `tools/`, `env/` or `images/`, and Familiar never installs `CodingTools`.

Two more things to know. The README calls the package experimental, with API changes "without notice between releases", and there have been 20 releases since 2026-09-19. Also, `DEFAULT_HARNESS_IDENTITY` sends attribution headers naming pi to OpenRouter, NVIDIA NIM and OpenCode. The spike passes `identity: { attribution: null }`, and Familiar should do the same or send its own.

## What step 5 (the turn loop) should do

1. Build the turn loop on pi-durable 1.5.2, pinned exactly, behind a small journal facade in core so an upgrade or a swap touches one place. The root, `storage/indexeddb`, `storage/sqlite`, `chord/context`, `pi-ai/models` and the two `pi-ai/utils` paths bundle with no Node built-ins, so core's portability test can allow exactly those subpaths.
2. Give it the IndexedDB store from `apps/desktop`, behind the store port, inside a Web Lock, with `navigator.storage.persist()`. Fix the webview origin in step 3 and add a test that it doesn't change. Run pi-durable's storage conformance suite in CI against whatever store ships. Move to SQLite later only through a dedicated single-connection Rust command, never through tauri-plugin-sql's pool.
3. Reach models only through `portProvider(ModelPort)`, with the error-kind words above, and `identity: { attribution: null }`.
4. Declare every tool `replay: "unsafe"` (the default), including every MCP tool. Mark only pure reads `safe`. Put consent in a `beforeTool` hook that asks the decision and consent path, and record open consent cards in a Familiar document.
5. Make reminders `defineTask` tasks that park with `sleepUntil`. Feed `now` and `setTimer` from the clock port, and check timer throttling in a hidden window on Windows in step 13.
6. Report state from `watch()` on `pi.live`, plus Familiar's consent document for "waiting".
7. Write the kill-mid-step tests the way `scripts/browser-check.mjs` does them: reload headless Chromium at each step kind (model stream, unsafe tool, safe tool, consent, sleeping reminder, turn cap), then check the transcript and the execution counters.

## Not settled

- WebView2 itself. Everything ran in headless Chromium 156 on Linux. WebView2 is Chromium, but its storage folder, its origin and its timer throttling were not checked.
- IndexedDB durability on power loss. pi-durable opens its transactions without a durability hint, so the browser default applies.
- The cost of about 130 IPC calls per turn for the SQLite option over real Tauri IPC, and the Rust command itself, which was not written.
- Compaction, long transcripts, memory growth and two windows sharing one store were not exercised.
- `pnpm install` reported ignored build scripts for `@google/genai` (a no-op preinstall), `protobufjs` (a version-scheme warning) and `esbuild` (verifies its binary, and Vite 8 builds with rolldown here). None of them matter for this spike or for the app bundle.
