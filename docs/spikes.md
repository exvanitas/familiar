# Step 2: the spikes

Three yes-or-no checks before anything depends on them. Each has its own folder under `spikes/`, with a `RESULT.md` and a `spike` script that reruns it. Everything ran with fakes or recorded responses: no keys, no paid calls.

| Spike | Verdict | Where |
| --- | --- | --- |
| pi-ai as the provider layer in the webview | Yes, with conditions | [spikes/pi-ai-web/RESULT.md](../spikes/pi-ai-web/RESULT.md) |
| pi-durable as the durable engine in the webview | Yes, with conditions | [spikes/pi-durable-web/RESULT.md](../spikes/pi-durable-web/RESULT.md) |
| The installed exe starting a local MCP server | Yes, with conditions | [spikes/mcp-start/RESULT.md](../spikes/mcp-start/RESULT.md) |

## pi-ai 1.5.2: yes, with conditions

- **Fetch:** Familiar's own fetch (Tauri's HTTP plugin in the app) can be passed per call, and it reaches the OpenAI and Anthropic SDKs. Gemini's native path can only use the global fetch, so **Gemini goes through Google's OpenAI-compatible endpoint**.
- **Contract:** a draft `PiAiModelPort` passes all six model-port contract cases for OpenAI-compatible, Anthropic and Gemini (both routes), in Node and in headless Chromium. 58 tests.
- **Size:** OpenAI-compatible plus Anthropic is 139 KiB gzipped. With each provider loaded on its first call, the start costs 3.5 KiB.
- **Clean:** Node-only parts (proxy agents, the AWS Bedrock client) stay out of the bundle. No telemetry, update ping or model-list fetch.
- **Conditions for step 4:**
  - pi-ai has no error kinds, so the adapter reads the HTTP status through the injected fetch.
  - The port gains: thinking signatures carried back on the next turn (Anthropic needs them when thinking and tools mix), cache usage, an error for invalid tool-call arguments, and a content-filter error kind.
  - Each preset sets its own compatibility options. pi-ai turns Anthropic prompt caching on, and sends `store: false` to OpenAI.
  - The install pulls 82 packages, including AWS and Google auth libraries that never reach the bundle. They still count for audits.

## pi-durable 1.5.2: yes, with conditions

- **Browser fit:** the engine bundles for the browser with no Node built-ins and no shims. Engine plus storage is 113 KiB gzipped. Images, codemode and diff stay out.
- **Durable turns:** every turn ran on Familiar's fake model through a small provider over the model port. After a reload:
  - a tool not safe to repeat is reported as interrupted ("may have partially run"), never run twice
  - a safe tool runs again
  - an unanswered consent is asked again
  - a parked reminder resumes
  - a half-streamed reply is kept as aborted, and the request is sent again
- **Fits the design:** consent before a tool (`beforeTool`), a step cap (`maxTurns`), parked reminders (`sleepUntil`), and state to report (`watch()`).
- **Storage, decided 2026-11-14: IndexedDB.** See [Where the data lives](design.md#where-the-data-lives). The question was: its own conformance suite (32 cases) passes on its IndexedDB store, and on SQLite over **one** connection. It needs real interactive transactions, so SQLite through a pool fails: 0 of 32 with two connections. Tauri's SQL plugin uses a pool of up to 10 and has no transaction command. So the choice is:
  - **IndexedDB** (its own store): no native code, and passes today. Its data sits in WebView2's own folder, tied to the app's origin. Durability on power loss needs `durability: 'strict'` forced on, and a check.
  - **One SQLite file** (as the plan said): about four small Rust commands over a single connection, roughly 130 calls per turn. It's a file Familiar controls, but transaction code in the exe is hard to fix once the exe settles.
- **Conditions for step 5:**
  - Pin it exactly, behind a small journal facade in core. Its README calls it experimental.
  - Mark every tool, MCP tools included, not safe to repeat, except pure reads.
  - Set `identity: { attribution: null }`, so no request names pi to OpenRouter.
  - Run its storage conformance suite in CI against whichever store ships.

## Starting a local MCP server on Windows: yes, with conditions

A small Rust command, run on GitHub's Windows runner (`.github/workflows/spike-mcp-start.yml`), starts saved setups for `node`, `npx` and `uvx` and speaks MCP to them over stdio.

- **Minimal environment:** the parent had 147 settings and the server got 23. A setting only on the parent didn't reach it, and the server's own secret did. Its stderr comes back separately, with the secret blanked.
- **Real servers:** `npx -y @modelcontextprotocol/server-everything@2026.8.31` listed 13 tools (about 30 s the first time, while it downloads). `uvx --from mcp-server-time==2026.10.28 mcp-server-time` answered in about 8 s.
- **Quoting:** 20 kinds of argument arrived exactly, through `node`, a `.cmd` of our own and `npx.cmd`. That covers spaces, quotes, `%PATH%`, `!PATH!`, `& ^ | < >`, a trailing backslash, the empty string, Unicode and a tab. Rust refuses NUL anywhere, and CR or LF through a `.cmd`, before any process exists.
- **Dies with the app:** with a kill-on-close job, a hard kill of the app left 0 of 14 processes after about 20 ms, grandchildren included. Without the job, a busy server's processes were still alive 5 s later.
- **Bad starts** are reported plainly: a missing program before anything runs, a bad npm package as exit code 1 with npm's own lines. Junk on stdout is skipped and counted.
- **No console window:** checked through the console API for the server and everything under it.
- **Conditions for steps 3 and 7:**
  - Resolve the program ourselves.
  - Start it suspended and put it in the job before it runs.
  - Reject NUL, CR and LF in arguments for every program, so a setup can't work under `node` and then fail under `npx`.
  - Pinning an npx or uvx version pins only the top package, since its dependencies still float. Say so in the setup help.

## Not settled by any spike

WebView2 itself: its storage folder, its origin and its timer throttling for a hidden window. Smart App Control's verdict on what npx and uvx download, and any console flash a person might see (only a real PC shows these). Real Tauri IPC. LM Studio and Ollama quirks. Live Gemini through the OpenAI-compatible route. These fall to steps 3, 4 and 13.
