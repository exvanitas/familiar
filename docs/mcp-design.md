# The MCP client

Step 7 of the [build order](design.md#build-order). Familiar's client for MCP servers: local servers it starts through the exe, and remote servers it reaches through the guarded fetch. The code is `packages/core/src/mcp/`. The exe's half (the approval dialog, the job, blanking secrets) was built in step 3 and is in [shell-design.md](shell-design.md#5b-starting-a-local-mcp-server).

| Part | Where |
| --- | --- |
| The state machine of one server | `packages/core/src/mcp/machine.ts` |
| The actor that runs it | `packages/core/src/mcp/actor.ts` |
| The MCP session over a transport | `packages/core/src/mcp/session.ts` |
| The local transport, over a process port | `packages/core/src/mcp/process-transport.ts` |
| The remote transport, over a fetch | `packages/core/src/mcp/remote.ts` |
| A tool list's bounds and fingerprints | `packages/core/src/mcp/catalog.ts` |
| The exe's path and address rules, mirrored | `packages/core/src/mcp/native-rules.ts` |
| One server's saved record, one writer | `packages/core/src/mcp/writer.ts` |
| The desktop process port, over the exe | `apps/desktop/src/mcp.ts` |

## One actor per server

Step 3's reviews found races with one cause: a setup's state changed under different locks at different moments. The exe fixed it with one owner per setup. The client is built the same way from the start.

Each server has one actor. It is the only thing that changes that server's state. Everything that happens to a server is a message to it, handled one at a time, in order:

- **Commands**, from the app: start, stop, call, stop a call, edit, list the tools again, remove.
- **Completions and events**, from the transport, the store and the clock: the run started, the handshake finished, a call's answer, the tools changed, a tool list's answer, an edit saved, a removal done, the run closed, a deadline came.

Nothing goes around it. An edit is admitted by the actor (only while the server is stopped or down), reserves its place before anything is written, and counts only once it's saved; a start made meanwhile waits for it. The actor holds the setup, and each run keeps the setup it was started from, so an edit never changes a run under way, and that run's tools carry that setup's fingerprint.

The rules are a pure function in `machine.ts`: a state and a message in, a new state and a list of effects out. The effects are what the actor then does: start a run, send a call, cancel a call, close a run, arm a timer, answer a caller. Nothing in the machine waits or touches I/O, so a property test can drive it with any order of messages.

### The states

| State | Means | Leaves on |
| --- | --- | --- |
| Stopped | Nothing runs. It may carry the last failure, in plain words. An edit can be saved here | A start (after a pending edit is saved) |
| Starting | A run is being started. For a local server this includes the exe's own dialog, if the setup is new or changed | The run started (to Initializing), or failed |
| Initializing | The MCP handshake and the first tool list, under their own deadline | Ready, a failure, or the deadline |
| Ready | The server answers calls | A crash (to Restarting or Down), a stop, a remove |
| Restarting | It crashed. The old run must be closed and a short pause must pass before the next start | The next start (to Starting) |
| Down | It crashed three times in ten minutes. It keeps its last output for the matrix | A start, which is the person's action |
| Stopping | Closing the run, under a deadline | Stopped, or Removing if a remove waits |
| Removing | The approval or the address, its secrets and its saved setup are being removed | Removed. A failed removal stays here, and the next remove tries again |
| Removed | Gone. Everything is refused | Nothing |

The resting states are Stopped, Ready, Down and Removed, with no save, removal or tool list under way, plus a failed removal. Every other state has a pending event or a deadline that leaves it, so no server is ever stuck between two.

### Generations, numbers and deadlines

Each start of a run takes a new generation, a number that only grows. Every event from a run carries its generation, and so does every timer. The actor drops anything whose generation isn't the current one. So a late answer, a late exit or a late deadline from a run that's over never touches the next run. Every other wait (an edit's save, a removal, a tool list) takes a number of its own the same way, and a late completion with an old number is dropped.

Every external wait has a deadline: starting a run (the exe's dialog included), the handshake, a later tool list, closing a run, saving an edit and removing. A start or a handshake past its deadline ends the run as a failure; a tool list past its deadline ends the run as a crash; a save or a removal past its deadline fails in plain words, and can be tried again.

A new run starts only once the old one has closed (or its stop deadline passed). The exe allows one run per setup at a time, and the machine keeps to that, so it never gets `busy` for its own restart.

### Every caller is answered exactly once

A call ends in exactly one of these:

| Answer | When |
| --- | --- |
| A result | The server answered. A tool error is a result too, marked as an error |
| An error | It couldn't be sent: the server isn't running, is stopping, was removed, has too many calls waiting, the tool it was made for changed (`changed`, below), or the protocol failed |
| `stopped` | The person pressed Stop on this call |
| `timed-out` | Its deadline came first |
| `interrupted` | The server crashed, or was stopped, while the call ran. It may have partly run. It is never sent again |

Stop and a deadline both send MCP's cancellation notification for a call that was sent, and answer the caller at once. They don't wait for the server to agree. A call that was never sent (it was waiting for the server to be ready) isn't cancelled on the wire, because the server never saw it.

A call that's already stopped when it's made is answered `stopped` at once, and nothing is written to the server. A call waits only while the server is starting, initializing or restarting, or while its tool list is being read again after the server said it changed, and only within its own deadline. A waiting call was never sent, so it may go to the next run after a crash. A call that was sent goes to one run only: once that run ends, the call is answered `interrupted`, and nothing sends it again. That holds for a crash, a stop, a remove and a deadline alike.

Start, stop, edit and remove are answered exactly once too. A start is answered when the server is ready (with its tools), when the start fails (with the failure in plain words), or when a stop or remove overtakes it. A second start while one is under way joins it.

**Admission is bounded, and a stop wins over the starts before it.** At most 8 starts, 8 stops and 8 removes wait on one server; past that a command is refused at once with plain words. Stops coalesce: one waiting stop answers them all. A stop settles every start made before it, so only a start made after the last stop can ask for another run. (Found in review: Stop A, Start B while stopping, Stop C used to start a run after C.)

**Tool lists are one at a time.** When the server says its tools changed, its catalog is stale: calls wait, and one list is asked for. Another change while it's under way asks for exactly one more after it, however many arrive. An answer whose number isn't the newest is dropped, so an older list never replaces a newer one. Writes of the saved record coalesce the same way (`writer.ts`): one write at a time, and a storm of changes makes at most one more.

### Limits

| Limit | Default | Settable |
| --- | --- | --- |
| A call's deadline | 60 s | Per server, 1 s to 15 min |
| The handshake's deadline | 120 s, since a first `npx` run downloads its package before the server says anything | Per server, 10 s to 5 min |
| Calls waiting or running at once, per server | 16 | No. Past it a call is answered `busy` |
| Starting a run, the exe's dialog included | 5 min | No |
| A tool list after the first | 30 s | No |
| Saving an edit, and a removal | 30 s each | No |
| Starts, stops or removes waiting | 8 each | No |
| Restarts after a crash | 2 in 10 minutes, each 1 s after the old run closed | No |
| Closing a run | 5 s, then it counts as closed | No. The exe ends the job after 500 ms anyway |

A start the person makes isn't a restart. If the first run of a start fails (the exe said `declined`, the program wasn't found, the handshake timed out), the server goes back to Stopped with that failure, and nothing tries again on its own. Restarting a run the person never got to approve would just show the dialog again. A crash after Ready is what restarts count, and a restart that fails counts as another crash.

### The property test

`tests/mcp/machine.property.test.ts` drives the machine with seeded random sequences: commands, and the events a fake world sends back, in any order, late ones and ones from old generations included. After each sequence every pending event is delivered and every timer fired. It checks:

- every call, start, stop, edit and remove is answered exactly once
- every run ends in a resting state
- an answer from an old run never answers a call sent on a new run, and no effect names a run that isn't the current one
- no call is ever sent twice, so a crash mid-call never sends it again
- no run starts while an earlier one is still open
- a call made for a tool is sent only while the server offers exactly that tool from that setup, and never while the catalog is stale
- at most one tool list, one save and one removal is under way, and an older list never replaces a newer one
- no waiting list grows past its bound

Its world is unkind on purpose: a start, a save, a removal or a tool list can hang for ever, a halted run may never close, the server sends storms of fifty "tools changed" at once, and old answers come back late. Seven deliberate breaks each fail it: a stop that leaves earlier starts waiting, any list answer accepted whatever its number, lists not one at a time, no consent check at send, no start deadline, unbounded waiting lists, and a second removal started while one runs. Before step 7's review the world always answered in the end, which is why it missed the hangs.

## Transports

The MCP protocol itself is the official TypeScript SDK's `Client`, pinned at 1.32.2 in core's `package.json`. Core imports only its browser-safe entry points: the client, the Streamable HTTP client transport, and the types. `tests/portable.test.ts` lists them, and `tests/mcp/bundle.test.ts` bundles them for the browser with esbuild and fails on any Node built-in. Two things in the SDK don't suit the webview, and both are replaced:

- **Its JSON Schema checker** (Ajv) compiles code with `new Function` for any tool with an output schema, and the app's CSP forbids eval and `new Function` in every page. The client is given a checker of its own instead, which accepts any structured result. A server's results are text the model reads, never trusted data, so nothing depends on their shape.
- **Its stdio transport** needs Node. Local servers get a transport of Familiar's own.

**With code generation off.** `tests/mcp/no-eval.test.ts` runs the client in a child Node started with `--disallow-code-generation-from-strings`, which refuses eval and `new Function` as the CSP does (the child checks that it does). Against the fake server: initialize, list the tools, one call, a tool error and a refused call. Then a tool with an output schema, over the SDK's in-memory transport, lists and answers. With the SDK's own Ajv checker put back, that last part fails, so the test proves the replacement is needed and enough. zod probes for eval once and falls back. On the runner, the `proc-mcp` checks run the same client in the real core page, under the real CSP, so anything that still needs code generation fails there too.

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

That is the exe's `server_start`, `server_write`, `server_stop` and `server_forget`, as typed in `apps/desktop/src/shell.ts`. The exe already splits stdout into lines and blanks literal copies of the setup's secret values from both streams before a line leaves Rust (not escaped copies: see "Not settled").

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
- **Legacy SSE is refused in v1**, in plain words: "This server uses an older connection (SSE) that Familiar doesn't support yet." Its server names the URL for its posts itself, often beside the stream's path, so its approval would have to cover a whole origin, and two servers on one origin would share one address and key. (Step 7's first build supported it with the origin as the address; review found that widening, and it's gone.)
- **One server per address.** The exe gives an identical address the same id, so two servers on it would share its key, and removing either would remove the other's. A second server on an address already in use is refused, before the dialog and again by the id the exe returns, which is never removed.
- Redirects stay with the guarded fetch's own rule: under the same saved address, or refused.
- A key goes in one header, as the placeholder (`familiar-stored-key`), and the exe swaps it. The exe swaps only in `Authorization`, `X-API-Key`, `Api-Key` and `X-Goog-Api-Key`, so a key in any other header is refused when the server is added, with words that say so.
- A remote run has no process. It starts when the transport connects and closes when the transport does (a stream error, the session ending, a stop). That close counts as a crash, so the same restarts apply.

## Tools

On Ready, and on `notifications/tools/list_changed`, the actor lists the server's tools, one list at a time (above).

- **Bounded before anything hashes it** (`catalog.ts`): at most 128 tools in up to 16 pages, each tool's input schema at most 32 levels deep and 4,000 parts, at most 64 KiB per tool and 1 MiB for the whole list. The walk is iterative and stops at the first bound, so a schema nested 10,000 levels fails in plain words instead of overflowing the stack. Two tools with one name fail the list too ("Familiar can't tell them apart"). A list that fails ends the handshake, or a later list's run, as a plain failure.
- **A fingerprint per tool**: SHA-256 of its name, its title, its effective description (the description, or the title when there's none, since that's what the model and the consent card show) and its input schema, in canonical JSON (keys sorted at every level). Annotations aren't in it. A new or changed fingerprint is a new tool.
- **A tool's identity for consent** is the server's immutable id and the tool's own name, with the fingerprint of what the person saw. Never the model's name for it, which depends on labels and on the other servers. `choiceKey(serverId, toolName)` is the key step 8 keeps choices under.
- **Checked at the moment of the call, in the actor.** Each server tool carries the server's id, its run's setup fingerprint, the tool's name and its fingerprint, and every call it makes carries the last two as an expectation. The actor sends it only if the current catalog offers exactly that tool from exactly that setup. Otherwise it answers `changed` without sending ("echo changed since it was offered, so Familiar didn't send the call. It will ask again."). So a wrapper a turn kept from before a change can never call the changed tool, and the next offer of it goes through the gate, which asks again.
- **What the person reviewed is kept.** The saved record keeps each tool's last fingerprint and the fingerprint the person last reviewed. A tool whose two differ is fresh: new, or changed since review. Test reports which tools are fresh and which changed, against what was reviewed.
- **"Always for this" is narrow.** Step 8 stores the person's choice for a tool under `choiceKey`, with the tool's fingerprint and the setup fingerprint. `toolPolicies` turns those choices into the gate's per-tool policy: an "always" holds only for that server, and only while both fingerprints are the same, so a changed tool, or a new command, folder, setting, version or address, puts it back to ask. Two servers with identical setups never share one. A "never" holds whatever changed, since stricter is safe.
- **The setup fingerprint** covers the command, its arguments, its folder, the plain settings with their values and the secret names, or for a remote server its address, transport, plain headers and key header. Not secret values, so a renewed key asks nothing. Not the label.
- **Names the model sees**: `<server>__<tool>`, letters, digits, `_` and `-` only, at most 64 characters, starting with a letter, which every provider accepts. Accents are dropped and anything else becomes `_`. Collisions are settled the same way every time: servers in id order, tools in name order, and a later duplicate gets `_2`, `_3` and so on, compared ignoring case.
- **Each tool is a `FamiliarTool` of kind `server`.** So it's never run again after a restart: the journal reports it as interrupted, with Run again. The gate asks for it unless the person chose otherwise. It carries `readOnlyHint` to show, never to trust. Its `doing` names the server ("calling echo on Fake server"), and it carries the server's id and label, so a turn shows which server it called. It doesn't set `asks`, because that would also overrule the person's "always".
- **Results are outside content.** Each server tool carries `outside: true`, and its text starts with a line saying it's what the server returned, not the person's words, and grants nothing (`outsideContent`, which step 8's rule may reword). The text is the result's text parts, a plain note for images, sounds, files and links, or the structured content as JSON if there's no text. At most 32,000 characters, with a note saying how much was cut. A tool error, a refusal, Stop, a deadline and `interrupted` reach the model as a tool error in plain words.
- **The step cap and call bounds** apply as they do to every tool: server calls count against the same 8 per reply and 32 per turn.
- **A turn's tools** are the tools of every Ready server, built fresh for each turn.

## Adding a server

**By paste.** `parsePaste(text, { newId, defaultCwd })` reads the common `mcpServers` block, VS Code's `servers` or `mcp.servers`, a bare map of servers, one server object, or the inside of a block without its braces. Comments and trailing commas are forgiven. A server with a `command` is local (`args`, `env`, `cwd`). One with `url`, `serverUrl` or `httpUrl` and no command is remote (`headers`, and `type` or `transport`; `sse` is read so it can be refused in plain words). Each server gives a draft. The raw paste is never kept: the parser returns only what it read, and the caller drops the text.

**By form.** `localDraft` (a label, a command, arguments, a folder, and settings each marked secret or not) and `remoteDraft` (a label, an address, a transport and headers) give the same draft, with the same checks.

**A draft** is the setup, with no secret values in it, plus the values for Settings to store, plus problems (which stop it being added) and notes (which don't).

**Secrets.**

- Every setting of a local server is a secret by default, kept in Credential Manager as `server:<setupId>:<NAME>`.
- Except the settings that change what runs (`PATH`, `NODE_OPTIONS` and the rest of the exe's list in 5b): those can only be plain settings, whose values the approval binds.
- And except short values (under 8 bytes, which the exe won't store as a secret) whose names don't look like credentials, such as `LOG_LEVEL=info`. Those stay plain, and a note says so, since a plain value is shown in the approval and saved with the setup.
- **A credential is only ever a secret.** A setting whose name looks like one (key, token, secret, auth, password, pwd, passphrase, credential, session, cookie, private) is a secret however short. A short one is refused in plain words, never kept as a plain setting, and such a name as a plain setting is refused too, by paste, form or edit. One that also changes what runs (`NPM_CONFIG__AUTH`) can be neither, and is refused. (Found in review: `API_KEY=abc123` used to become a plain setting, shown in the approval and saved.)
- A value the exe would refuse as a secret (over 1024 bytes, a control character, part of a `[key]` or `[hidden]` marker) is a problem, in the exe's own terms.
- A README's example value (`<YOUR_TOKEN>`, `${input:token}`, `your-api-key-here`) is a problem: "put your own value in".
- A remote server gets one key per address, as `addr:<addressId>`, from an `Authorization` (with its `Bearer`, `Token` or `Basic` prefix kept in the setup), `X-API-Key`, `Api-Key` or `X-Goog-Api-Key` header. The header then holds the placeholder. Any other header that looks like it carries a key (key, token, secret, auth, password, credential, session, cookie) is refused with words that say why, and so are two key headers.
- `secret_set` is a Settings command. So Settings puts the draft's values straight into Credential Manager, and core gets the draft without them. `add` returns the refs to store them under. Core may only delete them, when the server is removed or a secret is dropped by an edit.

**The exe's rules, early.** The checks mirror shell-core's: 64 arguments, 32 plain settings, 32 secrets, 8 KiB for the whole setup, setting names of ASCII letters, digits, `_`, `-` and `.` not starting with a digit, names compared ignoring case, no NUL, CR or LF in an argument.

- **Paths** (`native-rules.ts`, from paths.rs and server_path.rs): the program is a plain name to look up, or a full local path; the folder is a full local path. A full local path is a drive letter, `:\`, then plain names: no UNC (`\\server\share`), no `\\?\` or `\\.\`, no drive-relative `C:evil.exe`, no relative folder, no `..`, no stream (`:`), no device name (`COM1`, `CONOUT$` and the rest, with any extension), and none of the exe's invisible characters. Only syntax: links and drives are the exe's to walk. The app checks with these Windows rules; core's tests on Linux pass POSIX rules, since their fake server lives at a POSIX path.
- **Addresses**: no user name, query or `#` part, no encoded dot or slash in the path, no header the guarded fetch drops. Only a literal IP is classed here, with the exe's own rules (address.rs): loopback, the private ranges and `fc00::/7` (as literals only), IPv4-mapped IPv6 as its IPv4, link-local, documentation, multicast and the rest refused. `http://` to a literal public IP is refused. A name is never classed here, not even one starting `fc`: the exe classes it after the person approves it and it's looked up, and refuses `http://` there if it comes out public.

`apps/desktop/tests/mcp.test.ts` reads shell-core's source and fails if the lists (settings that change what runs, invisible characters, device names, swap headers) or the limits drift apart; core's tests check the rules case by case.

**The unpinned flag.** `npx`, `npm exec` (and `npm x`), `bunx`, `pnpm dlx`, `uvx` (and `uv tool run`) and `docker run` fetch what they run. With no exact version (`name@1.2.3`, `name==1.2.3`), with `@latest` or a range, or for an image with no tag other than `latest` and no digest, they can fetch new code at any start, which the approval never saw. Every package the command names is checked, not just the first: each `-p`/`--package` of npx, npm exec, bunx and pnpm dlx, and uvx's `--from` and every `--with`. A pinned main package with an unpinned extra is flagged for the extra. What those packages themselves depend on is beyond the flag. A local path, a `file:` or `git` spec, and a plain `node server.js` aren't flagged.

**Adding** saves the setup stopped and not enabled. A remote server's address (its URL) is added first, with the exe's own dialog, and refused if another server already uses it.

**Editing** keeps the id, so what the person reviewed carries over and a changed tool shows as changed. The actor admits it only while the server is stopped or down, and it counts only once saved. A remote server's address can't change: a new address needs its own approval and key, so it's removed and added again.

## Saved setups

A small key-value settings store (`packages/core/src/settings/store.ts`), general so step 11 can keep personas and the rest of Settings in it. Each record carries its schema version. Values are JSON, copied in and out. Two implementations run one contract (`src/testing/settings-contract.ts`): in memory, and on IndexedDB through core's `strictIndexedDB`, so every transaction is strict and a write counts only once it's complete (fake-indexeddb in Node).

One writer per server writes its record (`writer.ts`): one write at a time, coalesced, each of the record as it is then, and nothing after a removal begins, so a late write can't bring a removed record back. A saved server is `mcp.server.<id>`, version 1: the setup (never a secret's value), whether it starts with the app, its own limits, and its tools as last seen with the fingerprints the person reviewed. A record of a version this code doesn't know is skipped and left as it is, never overwritten.

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

**Prerequisites.** `checkPrerequisites(finder)` gives a row for each of Node.js, Python's uv and Docker: found or not, what it's for, and where to get it. Finding a program without starting it needs the exe, which has no such command. So the check takes a `ProgramFinder` port, shaped as the command will be: it takes only a name from a fixed list (`node`, `npx`, `uv`, `uvx`, `docker`), and answers only `found`, `not-found` or `unknown`, never a path. Without a finder every row is `unknown` and says "Checked when you press Test", where a missing program comes back as `not-found` with the same words. The command (`program_find`, looking one of those names up as `server_start` resolves a program, and touching nothing else) is for the pre-release native pass.

## Starting with the app, and removing

**Starting with the app**: the app's core page (`apps/desktop/src/app/core.ts`) opens the client once it has said ready, and `startEnabled` starts every enabled server. Approved ones start with no dialog, since the exe compares the setup with its stored approval. A turn's tools are the Ready servers' tools.

**Remove** stops the server (a call in flight is answered `interrupted`), then removes what's kept for it, in an order a retry can repeat: `server_forget` and each secret for a local server, or `address_remove` (which deletes the address's key) for a remote one, then its saved record and its tools with it. A removal that fails leaves the server Removing, refusing starts and calls, and the next remove tries again.

## Proof

Core's tests, in Node:

- `tests/mcp/machine.property.test.ts`: the machine under 5,000 seeded random sequences of 60 steps and 300 of 400 steps, in the unkind world above. Before review four breaks were shown to fail it (a crash that keeps its sent calls, a result accepted from any run, a start during a stop launched at once, an answer that keeps its call); after review seven more (listed above). Plus unit cases: a crash mid-call, down after three crashes, the person's failed start not retried, review's Stop A / Start B / Stop C sequence, a start and a removal that never answer, a late removal answer dropped, an edit admitted only while stopped with a start waiting for it, a call for a changed tool or another setup never sent, a storm of a thousand tool changes making one list at a time with an older answer dropped, and 10,000 starts with only 8 waiting.
- `tests/mcp/client.test.ts`, against the real fake server over the Node process adapter: add by paste with nothing secret saved, Test, the second start asking nothing, calls and their outside-content mark, Stop and a deadline answered at once with the cancellation sent, a crash mid-call answered `interrupted` and sent once, three crashes then Down with the last output, an edit to variant b made together with a start (the run is the new setup, and no "always" survives it), echo changed on the running server (the old wrapper refused before sending, only echo back to ask), "always" not passing between two servers with identical setups, a call already stopped writing nothing, `print_secret` blanked, remove with a call in flight, plain words for a refused start, a missing program, an exit and a silent program, starting with the app. Over HTTP: the address added, only the placeholder sent, a refused key and a missing key in plain words. Legacy SSE and a second server on one address refused.
- `tests/mcp/journal.test.ts`: a real server tool in the turn loop, killed mid-call. After the restart it's reported interrupted with Run again, and the server never gets it again. And a tool with "always" that the running server changes: the next call in the same turn loop goes back to ask through the gate, and the wrapper the loop holds is refused without sending. Dropping the expectation from the wrapper fails both this and the client's stale-wrapper test.
- `tests/mcp/process-contract.test.ts`: the process port contract on the Node adapter.
- `tests/mcp/paste.test.ts` and `tests/mcp/pure.test.ts`: the paste shapes, secrets and short credentials, the exe's limits and path rules, remote headers and literal addresses, the unpinned flag with unpinned extras, model names, tool-list bounds (10,000 levels, 5,000 parts, 70 KB, 129 tools, a duplicate name), the title-only fingerprint, fingerprints (SHA-256 against node:crypto), the marker rule, plain words, result text, prerequisites, the coalescing writer.
- `tests/settings-store.test.ts`: the settings store contract on memory and IndexedDB, and every IndexedDB transaction strict.
- `tests/mcp/bundle.test.ts`: the client bundles for the browser with no Node built-in and no stub.
- `tests/mcp/no-eval.test.ts`: the client with code generation from strings off, as above.

On the Windows runner, through the real exe: the `proc-mcp` phase (`apps/desktop/shell-check/mcp-checks.ts`) runs core's client over the desktop ports against the fake server, with the driver answering the exe's dialog. Its six ids are in the security inventory, so the gate requires each: `mcp.add`, `mcp.call`, `mcp.crash-mid-call`, `mcp.changed-tool`, `mcp.secret-blanked` and `mcp.remove`. The secret is a key the driver types into Settings, which the page never learns. The checks run in the real core page under the real CSP.

- `mcp.changed-tool` changes echo on the running server (`set_variant`), with the setup unchanged, so it isolates the tool's fingerprint: through `gateFor` with the person's "always" for every tool, echo asks and the others still allow; the wrapper made before the change is refused and nothing is sent; the new one answers. Its control idea: with the call's expectation dropped from the wrapper, the old wrapper would send, and the check fails.
- `mcp.remove` re-adds the exact launch it removed, secret name included, has the driver type its key into Settings again, and needs the dialog to appear. Its control idea: with `server_forget` skipped, the stored approval would match and the start would come with no dialog, and the check fails.
- `check.mcp.secret-json-escaped` measures a known gap, declared in checks.json so it can't block: a key holding a quote, stored by Settings, which tells core only its last ten characters. It reports SKIP with "KNOWN GAP" while those characters come back, and PASS once they don't.

## Later

- **OAuth** sign-in for remote servers. v1 takes servers with no sign-in or a fixed key.
- **`program_find`** in the exe, for the prerequisites check: the pre-release native pass.
- **Step 8**: the consent cards (showing a fresh tool as new or changed, and the server it calls), the policies UI that stores choices under `choiceKey` with both fingerprints, and the outside-content rule. The turn loop takes its tool list when the journal opens, so step 8 must give each turn the current catalog (`client.tools()`); until then a tool changed under a long-open journal is refused at the call, which is safe but leaves it unusable until the next offer.
- **The pre-release native pass**: JSON-escaped secret redaction (below) and `program_find`.
- **Step 9**: the capability matrix rows for servers: Down with its last output, the unpinned flag.
- **Step 11**: the Settings pages that call these functions: paste and form, Test, review, edit, remove, the prerequisites.

## Not settled

- **A secret holding a quote, or another character JSON escapes, isn't blanked from a server's JSON output.** The exe blanks literal copies only. A server printing its secret inside JSON writes `abcd\"efgh` for `abcd"efgh`, the literal match misses it, and core's `JSON.parse` rebuilds the secret, which then reaches the model and the journal. Core never sees secret values, so it can't blank them itself. So the claim is: **literal copies of a server's secrets are blanked before core sees a line; copies the server escapes or encodes are not.** The fix belongs to the exe, in the pre-release native pass: match each secret's JSON-escaped form too, bounded, on every path back. `check.mcp.secret-json-escaped` measures it on the runner meanwhile. Until then a person can avoid it by using secrets without quotes, backslashes or control characters.
- **A save that times out may still land.** An edit's save past its 30 s deadline is reported failed and the old setup stays in use; if the write completes after, the next start of the app loads the edited setup. The writer writes one record at a time, so it can't land over a newer one.
- **A remote server that goes away** isn't seen as a crash. Its transport closes only when the SDK's does: a failed call is answered with an error, and the server stays Ready. So restarts and Down apply to local servers, and to remote ones only when the transport closes.
- **A remote server's quiet stream.** The guarded fetch ends a read that's quiet past its idle limit. The desktop ports give server addresses the exe's cap of 15 minutes, and the SDK opens the stream again after.
- **A stop whose run never closes.** After 5 s the machine counts it closed. If the exe still holds that run, the next start is `busy`, which comes back as a failure in plain words rather than a second run.
- **The handshake's deadline** is 120 s by default, for a first `npx` run that downloads its package. A slow network can need more, and the person can set up to 5 minutes.
- **zod's eval probe.** The SDK checks messages with zod, which tries `new Function` once to decide whether it may compile, and falls back when it's refused (shown in Node with code generation off). In the page the refusal may show as one CSP report. Ajv isn't used at all (above).
- **The process port contract** runs on the Node adapter only. The runner's checks cover the desktop adapter end to end through the client, but not case by case, since the contract's secret case needs a value the page knows and only Settings may store one.
