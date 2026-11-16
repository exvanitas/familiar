# @familiar/core

Familiar's core: the model port, caps and retries, the turn loop and journal on pi-durable, the decision slot, the trait reader, the settings store and the MCP client. No Tauri or Node imports (`tests/portable.test.ts` checks), so it runs in the app's webview. Every outside thing comes in through a port.

| Part | Where | Design |
| --- | --- | --- |
| Model port, caps, retries | `src/model/` | [model-design.md](../../docs/model-design.md) |
| Turn loop, journal, tools and the consent gate | `src/journal/` | [turn-design.md](../../docs/turn-design.md) |
| Decision slot and the rules decider | `src/decide/` | [design.md](../../docs/design.md#the-decision-slot-should-the-persona-react) |
| Trait reader's model call and cache | `src/traits/` | [cards-design.md](../../docs/cards-design.md) |
| Settings store | `src/settings/` | [mcp-design.md](../../docs/mcp-design.md#saved-setups) |
| MCP client | `src/mcp/` | [mcp-design.md](../../docs/mcp-design.md) |
| Test helpers and contracts | `src/testing/` (`@familiar/core/testing`) | |

## The MCP client's interfaces

| Function or type | Does |
| --- | --- |
| `McpClient.open(options)` | Loads the saved servers. Options are ports: the settings store, a `ProcessPort`, `fetchFor(address)`, an `AddressPort`, a `SecretPort` (delete only) and a clock |
| `client.add(draft)`, `edit(id, draft)` | Saves a draft (a remote one's address added first); returns the refs Settings stores the secret values under |
| `client.test(id)` | Starts, lists the tools with fingerprints and which are fresh, stops again; or a `Failure` in plain words |
| `client.start`, `stop`, `remove`, `startEnabled`, `setEnabled`, `setLimits`, `markReviewed` | The person's actions in Settings, and starting with the app |
| `client.tools()` | The Ready servers' tools, as `ServerTool`s for a turn |
| `parsePaste(text, options)`, `localDraft(form)`, `remoteDraft(form)` | A pasted block or a form as drafts: the setup, the secret values apart, problems and notes |
| `unpinned(program, args)` | The unpinned flag, with how to pin |
| `choiceKey(serverId, toolName)`, `toolPolicies(tools, choices)` | Where the person's per-tool choices are kept, and those choices as the gate's policy, "always" bound to that server and to both fingerprints |
| `checkTools(raw)` | A server's tool list bounded and fingerprinted, or a `CatalogError` in plain words |
| `checkPrerequisites(finder?)` | Node.js, uv and Docker, found or not, with what each is for |
| `ServerActor` | One server's actor, over any `open(events) => Session` |
| `step(machine, input, now)` | One server's rules, pure |
| `ProcessTransport`, `RemoteTransport`, `openSession` | The MCP SDK's client over a process port, or over a fetch (Streamable HTTP) |
| `windowsPaths`, `literalClass` | The exe's path and literal-address rules, mirrored so a draft fails early |
| `memorySettingsStore()`, `openSettingsStore(indexedDB)` | The settings store |

The app's adapters are in `apps/desktop/src/mcp.ts` (the exe's server commands, the guarded fetch, saved addresses).

## Extension points

- **A new port adapter** (a process port, a settings store): implement the interface and run its contract, `processPortContract` or `settingsStoreContract` from `@familiar/core/testing`, in your tests.
- **A new paste shape**: one more branch in `serversIn` in `src/mcp/paste.ts`, and a row in the shapes table in `tests/mcp/paste.test.ts`.
- **A new runner for the unpinned flag**: one more case in `unpinned` in `src/mcp/unpinned.ts`, with rows in the flagged and pinned tables in `tests/mcp/pure.test.ts`.
- **A new failure's words**: in `src/mcp/words.ts`, with a case in `tests/mcp/pure.test.ts`.
- **A new limit or state** of a server: in `src/mcp/machine.ts`. The property test must still pass, and a deliberate break of the new rule should fail it.
- **A new kind of saved setting**: a key prefix of its own in the settings store, and a version on each record from 1.

## Tests

`pnpm test` from the repo root runs everything; `pnpm vitest run --project core` runs core's alone, and `pnpm --filter @familiar/core typecheck` typechecks it. The MCP tests start `tools/fake-mcp-server` with this Node, over stdio, HTTP and SSE. They need no network and no keys.
