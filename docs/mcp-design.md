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
