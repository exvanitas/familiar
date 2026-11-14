# pi-ai bundling: result

**Verdict: yes, with conditions.** pi-ai 1.5.2 works as Familiar's provider layer in the webview for OpenAI-compatible endpoints and Anthropic, with Familiar's fetch passed in per call. Gemini should go through Google's OpenAI-compatible endpoint, because pi-ai's native Gemini path can only use `globalThis.fetch`.

Rerun everything with `pnpm --filter @familiar/spike-pi-ai-web spike` (HOME is a fresh temp directory for every step). Steps can run alone: `spike bundle`, `spike contract`, `spike browser`.

Versions: `@earendil-works/pi-ai` 1.5.2, which pins `openai` 7.19.0, `@anthropic-ai/sdk` 0.129.0 and `@google/genai` 2.21.0. Vite 8.3.8 (Rolldown), vitest 4.1.12, Node 22.21.1, headless Chromium 156.0.8078.4 from `~/.cache/ms-playwright/chromium-1248`.

## 1. Bundle only what's needed

Each entry in `src/entries/` imports the draft adapter plus only the named `@earendil-works/pi-ai/api/<id>` modules, and is built on its own for the browser (`scripts/bundle.ts`, target `chrome120`, minified). Gzip is Node's default level. The full report lands in `dist/bundle-report.json`.

| Entry | Minified | Gzipped | Files |
| --- | --- | --- | --- |
| OpenAI chat completions only | 322.0 KiB | 82.9 KiB | 1 |
| Anthropic messages only | 243.4 KiB | 66.4 KiB | 3 |
| Gemini native (`@google/genai`) only | 369.9 KiB | 70.8 KiB | 1 |
| OpenAI + Anthropic | 535.7 KiB | 138.8 KiB | 3 |
| All three, one file | 886.4 KiB | 203.0 KiB | 3 |
| All three, lazy (`src/loaders.ts`) | 886.9 KiB | 206.5 KiB | 10 |

In the lazy build the start chunk is 8.4 KiB (3.5 KiB gzipped). The OpenAI chunk is 287.7 KiB (71.7 KiB gz), Anthropic 207.5 KiB (54.3 KiB gz) and Gemini 350.0 KiB (64.3 KiB gz), each loaded on the first call to that API. Most of the weight is the vendor SDKs, not pi-ai. Rendered sizes before minifying: `openai` 562 KiB, `@anthropic-ai/sdk` 345 KiB, `@google/genai` 725 KiB, pi-ai's own code 99 KiB for the OpenAI path and 169 KiB for all three.

**Node-only packages stay out.** None of `http-proxy-agent`, `https-proxy-agent`, `@smithy/node-http-handler`, `@aws-sdk/client-bedrock-runtime` or `agent-base` reach any bundle. They are imported only by `dist/api/bedrock-converse-stream.js`, which nothing here imports. The script fails if any of them shows up.

**One `node:*` import leaks in, and it needs no shim.** `node:fs`, from `require("node:fs")` in `dist/utils/provider-env.js`, inside a branch that only runs under Bun (`process.versions.bun`). Vite swaps it for its empty `__vite-browser-external` stub and warns once. In the webview `process` is undefined, so the branch never runs. Two related things are also harmless:
- `dist/env-api-keys.js` (pulled in by the Anthropic path) has bundler-opaque `import("node:fs")`, `node:os` and `node:path` calls gated on `process.versions.node || process.versions.bun`. They never run in the webview.
- `@anthropic-ai/sdk` adds two tiny lazy chunks (`node.browser-*.js`, 2 KiB together) that throw "needs a Node.js-compatible runtime" if its file-backed memory store is used. Familiar never calls it.

To silence the warning, alias `node:fs` to an empty module in the app's Vite config. That is cosmetic.

**Install footprint is the real cost.** pi-ai's dependencies are not optional, so `pnpm install` adds 82 packages to the lockfile (`playwright-core` is one of them). That includes 26 `@aws-sdk/*`, `@smithy/*` and `@aws-crypto/*` packages, `google-auth-library`, `gaxios`, `protobufjs`, `ws`, `node-fetch` and both proxy agents. None ship to the webview, but they are on the audit and supply-chain surface.

**Ignored build scripts don't matter.** pnpm skipped three:
- `@google/genai`'s preinstall is `echo 'preinstall: no-op'`.
- `protobufjs`'s postinstall checks versions for its CLI, which nothing here uses.
- `esbuild`'s postinstall checks its platform binary. It was already in the lockfile through vitest, and Vite 8 builds with Rolldown.

## 2. Fetch

**OpenAI-compatible and Anthropic take an injected fetch per call, with no global patch.** pi-ai's `StreamOptions.fetch` is documented as "Optional fetch implementation for provider HTTP requests". `api/openai-completions.js` passes it to `new OpenAI({ fetch })` (line 542), and `api/anthropic-messages.js` passes it to `new Anthropic({ fetch })` (lines 967 to 1031). It is per request: a client is built for each call.

Evidence: `tests/contract.test.ts`, "fetch injection". Three text calls made 3 calls to the injected fetch and 0 to `globalThis.fetch`. In headless Chromium, the three injected targets made 18 calls through the injected fetch.

**Gemini native only works through a global fetch.** `api/google-generative-ai.js` line 36 throws "Custom fetch is not supported by the Google Generative AI adapter" when `options.fetch` isn't `globalThis.fetch`. The adapter maps that to an `unknown` error, and a test pins it. Under it, `@google/genai` 2.21.0 calls the bare global `fetch` (`dist/web/index.mjs` line 13869) and has no fetch option in `HttpOptions`. To use it in the app, Familiar would have to replace `globalThis.fetch` with Tauri's for the whole webview. Instead, send Gemini through `https://generativelanguage.googleapis.com/v1beta/openai/` with the OpenAI-compatible path, which takes the injected fetch. That passes the same contract (below), and it also drops `@google/genai` from the bundle.

**Tauri's fetch shape works.** `@tauri-apps/plugin-http` 2.9.0 (`dist-js/index.js`) gives back a `new Response` over a pull-based `ReadableStream`, and on a stop it rejects with a plain `Error('Request cancelled')`, not an `AbortError`. `tauriShapedFetch` in `tests/contract.test.ts` copies that shape. All 6 contract cases pass with it for OpenAI-compatible, Anthropic and Gemini-through-OpenAI. Real Tauri IPC was not run. That belongs to step 3.

**Browser flags.** pi-ai always sets `dangerouslyAllowBrowser: true` on both SDKs. That flag only silences the SDKs' check that refuses to run where a page's visitors could read the key. Familiar runs on the person's own PC with their own key, which is the case the flag is meant for. Through Tauri's fetch there is no CORS at all. Two side effects:
- The Anthropic SDK then sends `anthropic-dangerous-direct-browser-access: true` on every request. Anthropic accepts it, and it only matters for browser CORS.
- The key still sits in webview memory while a request is built. If step 3 wants the key kept out of JS, the guarded fetch could set the auth header on the Rust side. pi-ai and both SDKs need a non-empty `apiKey`, so pass a placeholder.

**Headers the SDKs add.** Seen by the fake server (`SPIKE_REPORT` in the contract run):
- `User-Agent` defaults to `pi/1.5.2 (browser)` in a page and `pi/1.5.2 (linux; node/...; x64)` in Node. Setting `identity: { userAgent: { custom: 'Familiar/x' } }` replaces it, and the adapter does that.
- The OpenAI and Anthropic SDKs add `x-stainless-os`, `-arch`, `-runtime`, `-runtime-version`, `-lang` and `-package-version`. A `null` value in `headers` removes them (tested in `tests/raw-pi-ai.test.ts`). `x-stainless-retry-count` and `x-stainless-timeout` remain.
- `@google/genai` adds `x-goog-api-client: google-genai-sdk/2.21.0 gl-node/...`.

All of this goes only to the chosen endpoint.

## 3. Streaming behind Familiar's port

`src/pi-ai-model-port.ts` is the draft `PiAiModelPort` (`createPiAiModelPort(endpoint)`). It skips pi-ai's `Models` and provider catalog, because Familiar's endpoints are whatever the person types in. It builds one pi-ai `Model` object from the endpoint and request, turns Familiar's messages into pi-ai's `Context`, calls `stream()` from `@earendil-works/pi-ai/api/<id>`, and maps the events. It also wraps the injected fetch to keep the HTTP status, `Retry-After` and the error body, because pi-ai flattens errors into an `errorMessage` string.

`src/fake-server.ts` replays the hand-written SSE recordings in `src/recordings.ts`, in each provider's documented wire format: text, tool call, refused key, and a 40-chunk reply 100 ms apart for 'slow'. The Gemini refusal is recorded as Google sends it, HTTP 400 `INVALID_ARGUMENT` with reason `API_KEY_INVALID`, not 401. The Gemini-through-OpenAI shapes (tool call ids, the 400 sent as a one-item list) are written from docs and memory. They were not checked against the live endpoint.

`modelPortContract` results in Node with vitest. All 58 tests pass in `tests/`:

| Target | text | tool-call | auth-error | stop part way | already stopped | usage |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI-compatible, injected fetch | pass | pass | pass | pass | pass | pass |
| Anthropic, injected fetch | pass | pass | pass | pass | pass | pass |
| Gemini native, global fetch | pass | pass | pass | pass | pass | pass |
| Gemini via OpenAI-compatible, injected fetch | pass | pass | pass | pass | pass | pass |
| The three injected targets, Tauri-shaped fetch | pass | pass | pass | pass | pass | pass |

No case fails. What it took:
- **Auth errors.** pi-ai has no error kinds. Its error event carries text such as `401 {"type":"error",...}`. The adapter classifies from the status its fetch wrapper saw (401 or 403 means auth, 429 rate-limit, other 4xx bad-request, 5xx server, a thrown fetch network). Without a wrapper (Gemini native), it reads the status and `API_KEY_INVALID` back out of the text. The adapter writes its own plain messages, so a provider's text, which can echo part of a key, is never shown.
- **Stopping.** pi-ai ends promptly by itself. `tests/raw-pi-ai.test.ts` measured 1 to 5 ms from the stop to pi-ai's own `error` event with reason `aborted`, on every wire. The adapter also races each read against the signal as a backstop.
- **Retries.** A refused key costs exactly one request on every wire. pi-ai calls the SDKs with `maxRetries: 0` and runs its own retry loop, which defaults to 0 retries.
- **Usage.** It comes from the final `done` message. The adapter folds Anthropic's cache reads and writes into `inputTokens`, because the port has no field for them.

## 4. In the page

`scripts/browser.ts` builds `src/entries/browser-contract.ts` (the lazy adapter plus the whole contract) with Vite, serves it from the fake server's origin, and runs it in headless Chromium 156. All 6 contract cases pass in the page for all four targets (24 of 24). The text scenario streams `Hello`, ` there.`, ` This is the`, ` contract reply.` and then `done` with stop reason `end`, for OpenAI-compatible, Anthropic and Gemini-through-OpenAI. Gemini native gives two larger chunks, because that is how its recording is split.

The injected fetch took 18 calls and `globalThis.fetch` took 6, all from Gemini native. The page made 33 requests in all: 24 POSTs to the fake endpoints, 9 GETs for the page and its lazy chunks, and 0 to any other host. Same origin means CORS was never tested here. In the app, Tauri's fetch takes it out of the picture.

## 5. No traffic but the endpoint

- **On import:** loading pi-ai and all three API modules (and with them all three SDKs) opened 0 sockets. The test patches `net.Socket.prototype.connect` before the import.
- **On calls:** across the whole Node run, the only socket address was the fake server's. In the browser, there were 0 requests to any other host.
- **Telemetry:** `@earendil-works/pi-telemetry` 1.5.2 is contracts and an in-memory or no-op context (841 lines of JS). It has no dependencies and no network code. Its only Node import is `node:assert` in its `testing/` export. pi-ai records spans only when a span is passed in `options.telemetry`.
- **Model lists:** none happen unless asked. The only `fetch(` call sites in pi-ai's own code are the OAuth flows, `providers/openrouter.js` (`/models/user`, through `Models.refresh()`), `providers/radius-config.js` and `api/cloudflare-ai-binding.js`. The adapter uses none of them.
- **Update pings:** none. There is no registry or update-check code in pi-ai's dist.

## 6. Fit: what Familiar's port loses or needs

- **Thinking replay.** pi-ai keeps signed thinking blocks (`thinkingSignature`, and `redacted` for redacted ones) and Gemini's `thoughtSignature` on tool calls. Anthropic needs those blocks sent back on the next turn when thinking and tool use mix. The port streams thinking text but its assistant `ChatMessage` cannot carry the signature, so the next turn can't replay it. Seen in `raw-pi-ai.test.ts`: the final message holds `thinkingSignature: "EqQBCgIYAhIM-recorded-signature"`. The port needs an opaque per-provider field on assistant messages, or to store pi-ai's `AssistantMessage` next to it.
- **Cache usage.** pi-ai reports `cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning` and a cost estimate. The port has only input and output. Adding optional `cacheReadTokens` and `cacheWriteTokens` would be enough.
- **Prompt caching is on by default.** pi-ai's Anthropic path adds `cache_control: ephemeral` to the system prompt, the last user message and the tools (`cacheRetention` "short"). That's usually what Familiar wants, but cache writes cost more. Make it a decision (`cacheRetention: 'none'` turns it off).
- **Stop reasons.** pi-ai's `stop`, `length` and `toolUse` map cleanly. A content filter comes back as an error with text only ("Provider finish_reason: content_filter"). The port might want a `refused` or `filtered` error kind. `rawStopReason` is there for logs.
- **Tool-call arguments.** pi-ai streams them (`toolcall_start` and `toolcall_delta` with partial JSON) and parses them at the end. The port only emits the whole call, which suits consent cards. One gap to close: when the model sends invalid JSON, pi-ai sets `arguments: {}` and `argumentsError`. The draft drops that, so core would run the tool with `{}`.
- **Ids.** Gemini native sends no tool call id, and pi-ai makes one up (`get_time_<ms>_1`).
- **Errors.** pi-ai has no error kinds, only text. The adapter's fetch wrapper is what gets the status and `Retry-After` back.
- **Request bodies for OpenAI-compatible servers.** pi-ai sends `store: false` and `stream_options.include_usage`. It works out quirks from the base URL (`detectCompat` in `api/openai-completions.js`), with no rule for Google's compatible endpoint, LM Studio or Ollama. Each preset should set `Model.compat`, for example `supportsStore: false` if a server rejects unknown fields. Which ones need it is not known yet.
- **Not used yet:** image input, `responseId`, `durationMs` and diagnostics.

## What step 4 (the model layer) should do

1. Depend on `@earendil-works/pi-ai` at an exact version. Import only `api/openai-completions`, `api/anthropic-messages` and `utils/transcript`, each API behind a dynamic import as in `src/loaders.ts`. Don't import the root entry, `providers/*`, `Models`, `compat` or OAuth.
2. Gemini is a preset on the OpenAI-compatible path at Google's `/v1beta/openai/` base URL, not `api/google-generative-ai`. Check Google's real stream and error shapes before trusting the recordings here.
3. Pass Familiar's guarded fetch per call, wrapped as in the draft, to keep the status, `Retry-After` and the error body. Never patch `globalThis.fetch`.
4. Set `identity.userAgent` to Familiar's own, and decide whether to null out the `x-stainless-*` headers.
5. Extend the port before the turn loop depends on it: opaque replay state on assistant messages (thinking signatures), optional cache usage, and invalid tool-call arguments.
6. Move `src/recordings.ts` and `src/fake-server.ts` into the model layer's tests, run `modelPortContract` over them for every preset, and keep the bundle check that fails on Bedrock or proxy-agent code.
7. Expect about 140 KiB gzipped for both SDK paths, loaded lazily. Writing two thin adapters would be smaller, likely tens of KiB (an estimate, nothing was built). In exchange, they would have to redo pi-ai's message conversion, partial-JSON tool arguments, retry rules and the per-server quirk table. For an app that loads from disk, pi-ai is the better trade, as long as the install footprint in section 1 is acceptable.

## Not settled

- Real Tauri IPC fetch (step 3), WebView2 itself (Windows), and the HTTP plugin's URL scope for endpoints the person types in.
- Live Gemini OpenAI-compatible behaviour: whether it accepts `store: false`, its exact tool-call and error shapes, and how it handles Gemini thought signatures on tool calls.
- LM Studio and Ollama quirks under pi-ai's default compat.
- Whether Familiar keeps Anthropic prompt caching on by default.
