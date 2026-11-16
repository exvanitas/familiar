# The MCP client

Step 7 of the [build order](design.md#build-order). Familiar's client for MCP servers: local servers it starts through the exe, and remote servers it reaches through the guarded fetch. The code is `packages/core/src/mcp/`. The exe's half (the approval dialog, the job, blanking secrets) was built in step 3 and is in [shell-design.md](shell-design.md#5b-starting-a-local-mcp-server).

| Part | Where |
| --- | --- |
| The state machine of one server | `packages/core/src/mcp/machine.ts` |
| The actor that runs it | `packages/core/src/mcp/actor.ts` |
| The MCP session over a transport | `packages/core/src/mcp/session.ts` |
| The local transport, over a process port | `packages/core/src/mcp/process-transport.ts` |
| The remote transports, over a fetch | `packages/core/src/mcp/remote.ts` |
| The desktop process port, over the exe | `apps/desktop/src/mcp.ts` |

## One actor per server

Step 3's reviews found races with one cause: a setup's state changed under different locks at different moments. The exe fixed it with one owner per setup. The client is built the same way from the start.

Each server has one actor. It is the only thing that changes that server's state. Everything that happens to a server is a message to it, handled one at a time, in order:

- **Commands**, from the app: start, stop, call, stop a call, list the tools again, remove.
- **Events**, from the transport and the clock: the run started, the handshake finished, a call's answer, the tools changed, the run closed, a deadline came.

The rules are a pure function in `machine.ts`: a state and a message in, a new state and a list of effects out. The effects are what the actor then does: start a run, send a call, cancel a call, close a run, arm a timer, answer a caller. Nothing in the machine waits or touches I/O, so a property test can drive it with any order of messages.

### The states

| State | Means | Leaves on |
| --- | --- | --- |
| Stopped | Nothing runs. It may carry the last failure, in plain words | A start |
| Starting | A run is being started. For a local server this includes the exe's own dialog, if the setup is new or changed | The run started (to Initializing), or failed |
| Initializing | The MCP handshake and the first tool list, under their own deadline | Ready, a failure, or the deadline |
| Ready | The server answers calls | A crash (to Restarting or Down), a stop, a remove |
| Restarting | It crashed. The old run must be closed and a short pause must pass before the next start | The next start (to Starting) |
| Down | It crashed three times in ten minutes. It keeps its last output for the matrix | A start, which is the person's action |
| Stopping | Closing the run, under a deadline | Stopped, or Removing if a remove waits |
| Removing | The approval or the address, its secrets and its saved setup are being removed | Removed. A failed removal stays here, and the next remove tries again |
| Removed | Gone. Everything is refused | Nothing |

The resting states are Stopped, Ready, Down and Removed. Every other state has a pending event or a deadline that leaves it, so no server is ever stuck between two.

### Generations

Each start of a run takes a new generation, a number that only grows. Every event from a run carries its generation, and so does every timer. The actor drops anything whose generation isn't the current one. So a late answer, a late exit or a late deadline from a run that's over never touches the next run.

A new run starts only once the old one has closed (or its stop deadline passed). The exe allows one run per setup at a time, and the machine keeps to that, so it never gets `busy` for its own restart.

### Every caller is answered exactly once

A call ends in exactly one of these:

| Answer | When |
| --- | --- |
| A result | The server answered. A tool error is a result too, marked as an error |
| An error | It couldn't be sent: the server isn't running, is stopping, was removed, has too many calls waiting, or the protocol failed |
| `stopped` | The person pressed Stop on this call |
| `timed-out` | Its deadline came first |
| `interrupted` | The server crashed, or was stopped, while the call ran. It may have partly run. It is never sent again |

Stop and a deadline both send MCP's cancellation notification for a call that was sent, and answer the caller at once. They don't wait for the server to agree. A call that was never sent (it was waiting for the server to be ready) isn't cancelled on the wire, because the server never saw it.

A call waits only while the server is starting, initializing or restarting, and only within its own deadline. A waiting call was never sent, so it may go to the next run after a crash. A call that was sent goes to one run only: once that run ends, the call is answered `interrupted`, and nothing sends it again. That holds for a crash, a stop, a remove and a deadline alike.

Start, stop and remove are answered exactly once too. A start is answered when the server is ready (with its tools), when the start fails (with the failure in plain words), or when a stop or remove overtakes it. A second start while one is under way joins it.

### Limits

| Limit | Default | Settable |
| --- | --- | --- |
| A call's deadline | 60 s | Per server, 1 s to 15 min |
| The handshake's deadline | 120 s, since a first `npx` run downloads its package before the server says anything | Per server, 10 s to 5 min |
| Calls waiting or running at once, per server | 16 | No. Past it a call is answered `busy` |
| Restarts after a crash | 2 in 10 minutes, each 1 s after the old run closed | No |
| Closing a run | 5 s, then it counts as closed | No. The exe ends the job after 500 ms anyway |

A start the person makes isn't a restart. If the first run of a start fails (the exe said `declined`, the program wasn't found, the handshake timed out), the server goes back to Stopped with that failure, and nothing tries again on its own. Restarting a run the person never got to approve would just show the dialog again. A crash after Ready is what restarts count, and a restart that fails counts as another crash.

### The property test

`tests/mcp/machine.property.test.ts` drives the machine with seeded random sequences: commands, and the events a fake world sends back, in any order, late ones and ones from old generations included. After each sequence every pending event is delivered and every timer fired. It checks:

- every call, start, stop and remove is answered exactly once
- every run ends in a resting state
- an answer from an old run never answers a call sent on a new run, and no effect names a run that isn't the current one
- no call is ever sent twice, so a crash mid-call never sends it again
- no run starts while an earlier one is still open

## Transports

The MCP protocol itself is the official TypeScript SDK's `Client`, pinned at 1.32.2 in core's `package.json`. Core imports only its browser-safe entry points: the client, the Streamable HTTP and SSE client transports, and the types. `tests/portable.test.ts` lists them, and `tests/mcp/bundle.test.ts` bundles them for the browser with esbuild and fails on any Node built-in. Two things in the SDK don't suit the webview, and both are replaced:

- **Its JSON Schema checker** (Ajv) compiles code with `new Function`, which the app's CSP forbids. The client is given a checker of its own instead, which accepts any structured result. A server's results are text the model reads, never trusted data, so nothing depends on their shape.
- **Its stdio transport** needs Node. Local servers get a transport of Familiar's own.

### Local: over the exe

`process-transport.ts` is an SDK `Transport` over a `ProcessPort`:

```ts
interface ProcessPort {
  start(setup: ProcessSetup, onEvent: (e: ProcessEvent) => void): Promise<{ run: string }>;
  write(run: string, bytes: Uint8Array): Promise<void>;
  stop(run: string): Promise<void>;
  forget(setupId: string): Promise<void>;
}
type ProcessEvent = { t: 'out'; line: string } | { t: 'err'; line: string } | { t: 'exit'; code: number | null };
```

That is the exe's `server_start`, `server_write`, `server_stop` and `server_forget`, as typed in `apps/desktop/src/shell.ts`. The exe already splits stdout into lines and blanks the setup's secret values from both streams before a line leaves Rust.

- Each message goes out as one line of JSON, as MCP's stdio transport says.
- Each stdout line is parsed as one JSON-RPC message. A line that isn't one is kept with the last output and otherwise ignored, since some servers print banners.
- stderr is kept as the last output: the last 40 lines, at most 16 KiB. It's what Test and the matrix show when a server exits.
- The run's exit closes the transport, and the exit code goes with the last output.

The adapters:

- **Desktop**, `apps/desktop/src/mcp.ts`: over `shell.ts`. Starting may show the exe's dialog.
- **Node**, for core's tests, `packages/core/tests/mcp/node-process.ts`: spawns the program, splits lines, and blanks the setup's secret values with `[hidden]` on both streams before core sees a line, as the exe does. So core's tests see what core will see in the app.

Both run the same contract (`src/testing/process-contract.ts`).

### Remote: over the guarded fetch

A remote server is a saved address of kind `server`. Core adds it with `address_add`, which asks the person in the exe's own dialog. Every request then goes through `guardedFetch(addressId)`, which reaches only that address and swaps the placeholder for the stored key.

- **Streamable HTTP** is the SDK's `StreamableHTTPClientTransport` with the guarded fetch passed in as its `fetch`.
- **Legacy SSE** is the SDK's `SSEClientTransport`, which also takes a fetch, used both for its event stream and for its posts. So SSE servers work too, through the same guarded fetch.
- Redirects stay with the guarded fetch's own rule: under the same saved address, or refused.
- A key goes in one header, as the placeholder (`familiar-stored-key`), and the exe swaps it. The exe swaps only in `Authorization`, `X-API-Key`, `Api-Key` and `X-Goog-Api-Key`, so a key in any other header is refused when the server is added, with words that say so.
- A remote run has no process. It starts when the transport connects and closes when the transport does (a stream error, the session ending, a stop). That close counts as a crash, so the same restarts apply.

## Tools

On Ready, and on `notifications/tools/list_changed`, the actor lists the server's tools (up to 128, in up to 16 pages).

- **A fingerprint per tool**: SHA-256 of its name, description and input schema in canonical JSON (keys sorted at every level). Its title and annotations aren't in it. A new or changed fingerprint is a new tool.
- **What the person reviewed is kept.** The saved record keeps each tool's last fingerprint and the fingerprint the person last reviewed. A tool whose two differ is fresh: new, or changed since review. Test reports which tools are fresh and which changed, against what was reviewed.
- **"Always for this" is narrow.** Step 8 stores the person's choice for a tool with the tool's fingerprint and the server's setup fingerprint. `toolPolicies` turns those choices into the gate's per-tool policy: an "always" holds only while both fingerprints are the same, so a changed tool, or a new command, folder, setting, version or address, puts it back to ask. A "never" holds whatever changed, since stricter is safe.
- **The setup fingerprint** covers the command, its arguments, its folder, the plain settings with their values and the secret names, or for a remote server its address, transport, plain headers and key header. Not secret values, so a renewed key asks nothing. Not the label.
- **Names the model sees**: `<server>__<tool>`, letters, digits, `_` and `-` only, at most 64 characters, starting with a letter, which every provider accepts. Accents are dropped and anything else becomes `_`. Collisions are settled the same way every time: servers in id order, tools in name order, and a later duplicate gets `_2`, `_3` and so on, compared ignoring case.
- **Each tool is a `FamiliarTool` of kind `server`.** So it's never run again after a restart: the journal reports it as interrupted, with Run again. The gate asks for it unless the person chose otherwise. It carries `readOnlyHint` to show, never to trust. Its `doing` names the server ("calling echo on Fake server"), and it carries the server's id and label, so a turn shows which server it called. It doesn't set `asks`, because that would also overrule the person's "always".
- **Results are outside content.** Each server tool carries `outside: true`, and its text starts with a line saying it's what the server returned, not the person's words, and grants nothing (`outsideContent`, which step 8's rule may reword). The text is the result's text parts, a plain note for images, sounds, files and links, or the structured content as JSON if there's no text. At most 32,000 characters, with a note saying how much was cut. A tool error, a refusal, Stop, a deadline and `interrupted` reach the model as a tool error in plain words.
- **The step cap and call bounds** apply as they do to every tool: server calls count against the same 8 per reply and 32 per turn.
- **A turn's tools** are the tools of every Ready server, built fresh for each turn.

## Adding a server

**By paste.** `parsePaste(text, { newId, defaultCwd })` reads the common `mcpServers` block, VS Code's `servers` or `mcp.servers`, a bare map of servers, one server object, or the inside of a block without its braces. Comments and trailing commas are forgiven. A server with a `command` is local (`args`, `env`, `cwd`). One with `url`, `serverUrl` or `httpUrl` and no command is remote (`headers`, and `type` or `transport` of `sse` for legacy SSE). Each server gives a draft. The raw paste is never kept: the parser returns only what it read, and the caller drops the text.

**By form.** `localDraft` (a label, a command, arguments, a folder, and settings each marked secret or not) and `remoteDraft` (a label, an address, a transport and headers) give the same draft, with the same checks.

**A draft** is the setup, with no secret values in it, plus the values for Settings to store, plus problems (which stop it being added) and notes (which don't).

**Secrets.**

- Every setting of a local server is a secret by default, kept in Credential Manager as `server:<setupId>:<NAME>`.
- Except the settings that change what runs (`PATH`, `NODE_OPTIONS` and the rest of the exe's list in 5b): those can only be plain settings, whose values the approval binds.
- And except values under 8 bytes, which the exe won't store as a secret. Those stay plain, and a note says so, since a plain value is shown in the approval and saved with the setup.
- A value the exe would refuse as a secret (over 1024 bytes, a control character, part of a `[key]` or `[hidden]` marker) is a problem, in the exe's own terms.
- A README's example value (`<YOUR_TOKEN>`, `${input:token}`, `your-api-key-here`) is a problem: "put your own value in".
- A remote server gets one key per address, as `addr:<addressId>`, from an `Authorization` (with its `Bearer`, `Token` or `Basic` prefix kept in the setup), `X-API-Key`, `Api-Key` or `X-Goog-Api-Key` header. The header then holds the placeholder. Any other header that looks like it carries a key (key, token, secret, auth, password, credential, session, cookie) is refused with words that say why, and so are two key headers.
- `secret_set` is a Settings command. So Settings puts the draft's values straight into Credential Manager, and core gets the draft without them. `add` returns the refs to store them under. Core may only delete them, when the server is removed or a secret is dropped by an edit.

**The exe's limits, early.** The checks mirror shell-core's: 64 arguments, 32 plain settings, 32 secrets, 8 KiB for the whole setup, setting names of ASCII letters, digits, `_`, `-` and `.` not starting with a digit, names compared ignoring case, no NUL, CR or LF in an argument, a folder given. For a remote address: https unless it's on this PC or a private network, no user name, query or `#` part, no encoded dot or slash in the path, and no header the guarded fetch drops. `apps/desktop/tests/mcp.test.ts` reads shell-core's source and fails if the lists or limits drift apart.

**The unpinned flag.** `npx`, `bunx`, `pnpm dlx`, `uvx` (and `uv tool run`) and `docker run` fetch what they run. With no exact version (`name@1.2.3`, `name==1.2.3`), with `@latest` or a range, or for an image with no tag other than `latest` and no digest, they can fetch new code at any start, which the approval never saw. Such a setup is flagged, with how to pin it. A local path, a `file:` or `git` spec, and a plain `node server.js` aren't flagged.

**Adding** saves the setup stopped and not enabled. A remote server's address is added first, with the exe's own dialog. For Streamable HTTP the address is the server's URL. For legacy SSE it's the URL's origin, since an SSE server names the URL for its posts itself, often beside the stream's path, and the SDK keeps that to the same origin.

**Editing** keeps the id, so what the person reviewed carries over and a changed tool shows as changed. Only a stopped server can be edited. A remote server's address can't change: a new address needs its own approval and key, so it's removed and added again.

## Saved setups

A small key-value settings store (`packages/core/src/settings/store.ts`), general so step 11 can keep personas and the rest of Settings in it. Each record carries its schema version. Values are JSON, copied in and out. Two implementations run one contract (`src/testing/settings-contract.ts`): in memory, and on IndexedDB through core's `strictIndexedDB`, so every transaction is strict and a write counts only once it's complete (fake-indexeddb in Node).

A saved server is `mcp.server.<id>`, version 1: the setup (never a secret's value), whether it starts with the app, its own limits, and its tools as last seen with the fingerprints the person reviewed. A record of a version this code doesn't know is skipped and left as it is, never overwritten.

## Test and prerequisites

**Test** starts the server if it isn't running (the exe asks if the setup is new or changed), lists its tools with their fingerprints and which are fresh, and stops it again unless it was running or on its way up. Every failure comes back in plain words:

| What happened | What Test says |
| --- | --- |
| The program isn't there | "Familiar couldn't find the program "npx"." and what to install: Node.js (the LTS from nodejs.org) for `npx`, `node`, `npm`, `pnpm` and `bun`; uv for `uvx` and `uv`; Docker Desktop for `docker` |
| It exited | "The server exited with code 2. Its last output is below.", with the last output |
| It never finished the handshake | "The server didn't finish starting within 120 seconds." |
| It started but didn't speak MCP | "The program started but didn't answer as an MCP server.", with its last output |
| The person said no, or the exe stopped asking | "You chose not to start it.", or how to let Familiar ask again from the tray |
| The exe refused the setup | Each of `unsafe-path`, `unsafe-argument`, `duplicate-setting`, `unsafe-secret`, `invalid`, `busy`, `start-failed` and `revoked` in its own words. The exe's message isn't shown |
| A remote server refused or couldn't be reached | The guarded fetch's kind (`no-key`, `not-saved`, `insecure`, `blocked-address`, `redirect-refused`, `tls`, `timeout`, `network` and the rest), or the HTTP status: 401 and 403 say the key was refused, 404 that nothing answered there |

**Prerequisites.** `checkPrerequisites(finder)` gives a row for each of Node.js, Python's uv and Docker: found or not, what it's for, and where to get it. Finding a program without starting it needs the exe, which has no such command. So the check takes a `ProgramFinder` port, and without one every row says "Checked when you press Test", where a missing program comes back as `not-found` with the same words. The command (`program_find`, looking a name up as `server_start` resolves it, and touching nothing else) is for the pre-release native pass.

## Starting with the app, and removing

**Starting with the app**: the app's core page (`apps/desktop/src/app/core.ts`) opens the client once it has said ready, and `startEnabled` starts every enabled server. Approved ones start with no dialog, since the exe compares the setup with its stored approval. A turn's tools are the Ready servers' tools.

**Remove** stops the server (a call in flight is answered `interrupted`), then removes what's kept for it, in an order a retry can repeat: `server_forget` and each secret for a local server, or `address_remove` (which deletes the address's key) for a remote one, then its saved record and its tools with it. A removal that fails leaves the server Removing, refusing starts and calls, and the next remove tries again.

## Proof

Core's tests, in Node:

- `tests/mcp/machine.property.test.ts`: the machine under 5,000 seeded random sequences of 60 steps and 300 of 400 steps. Four deliberate breaks each fail it: a crash that keeps its sent calls (they're sent twice after the restart), a result accepted from any run (an old run answers a new call), a start during a stop launched at once (two runs open), and an answer that keeps its call (answered twice). Plus unit cases: a crash mid-call, down after three crashes in the window and not outside it, the person's failed start not retried, the handshake deadline.
- `tests/mcp/client.test.ts`, against the real fake server over the Node process adapter: add by paste with nothing secret saved, Test, the second start asking nothing, calls and their outside-content mark, Stop and a deadline answered at once with the cancellation sent, a crash mid-call answered `interrupted` and sent once, three crashes then Down with the last output, variant b with echo the one changed tool and no "always" left for the new setup, `print_secret` blanked, remove with a call in flight, plain words for a refused start, a missing program, an exit and a silent program, starting with the app. Over HTTP: the address added, only the placeholder sent, a refused key and a missing key in plain words. Over legacy SSE through the injected fetch.
- `tests/mcp/journal.test.ts`: a real server tool in the turn loop, killed mid-call. After the restart it's reported interrupted with Run again, and the server never gets it again.
- `tests/mcp/process-contract.test.ts`: the process port contract on the Node adapter.
- `tests/mcp/paste.test.ts` and `tests/mcp/pure.test.ts`: the paste shapes, secrets, the exe's limits, remote headers and addresses, the unpinned flag, model names, fingerprints (SHA-256 against node:crypto), the marker rule, plain words, result text, prerequisites.
- `tests/settings-store.test.ts`: the settings store contract on memory and IndexedDB, and every IndexedDB transaction strict.
- `tests/mcp/bundle.test.ts`: the client bundles for the browser with no Node built-in and no stub.

On the Windows runner, through the real exe: the `proc-mcp` phase (`apps/desktop/shell-check/mcp-checks.ts`) runs core's client over the desktop ports against the fake server, with the driver answering the exe's dialog. Its six ids are in the security inventory, so the gate requires each: `mcp.add`, `mcp.call`, `mcp.crash-mid-call`, `mcp.changed-tool`, `mcp.secret-blanked` and `mcp.remove`. The secret is a key the driver types into Settings, which the page never learns.

## Later

- **OAuth** sign-in for remote servers. v1 takes servers with no sign-in or a fixed key.
- **`program_find`** in the exe, for the prerequisites check: the pre-release native pass.
- **Step 8**: the consent cards (showing a fresh tool as new or changed, and the server it calls), the policies UI that stores choices with both fingerprints, and the outside-content rule.
- **Step 9**: the capability matrix rows for servers: Down with its last output, the unpinned flag.
- **Step 11**: the Settings pages that call these functions: paste and form, Test, review, edit, remove, the prerequisites.

## Not settled

- **A remote server that goes away** isn't seen as a crash. Its transport closes only when the SDK's does: a failed call is answered with an error, and the server stays Ready. Legacy SSE's event stream reconnects on its own. So restarts and Down apply to local servers, and to remote ones only when the transport closes.
- **A remote server's quiet stream.** The guarded fetch ends a read that's quiet past its idle limit. The desktop ports give server addresses the exe's cap of 15 minutes, and the SDK opens the stream again after.
- **A stop whose run never closes.** After 5 s the machine counts it closed. If the exe still holds that run, the next start is `busy`, which comes back as a failure in plain words rather than a second run.
- **The handshake's deadline** is 120 s by default, for a first `npx` run that downloads its package. A slow network can need more, and the person can set up to 5 minutes.
- **zod's eval probe.** The SDK checks messages with zod, which tries `new Function` once to decide whether it may compile, and falls back when the CSP refuses. The refusal shows as one CSP report in the page. Ajv isn't used at all (above).
- **The process port contract** runs on the Node adapter only. The runner's checks cover the desktop adapter end to end through the client, but not case by case, since the contract's secret case needs a value the page knows and only Settings may store one.
