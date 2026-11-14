# Familiar

A character persona that helps on your Windows PC. You bring a model (your own key, or a model server on your PC or network) and a character card. Familiar gives you a chat window, a few built-in tools, memory that survives restarts, reminders, and the MCP servers you choose to add. A table in Settings shows what it can do, through what, and what's missing.

Later, once Desktop Buddies' API v2 is out, the persona can take over a buddy as its body.

**Status:** early, unreleased work. There's nothing to install yet, and no support. Things will change without notice.

## Layout

| Folder | What it holds |
| --- | --- |
| `packages/core` | The agent's core: the model port now, then the turn loop, journal, memory, reminders, tool and consent rules, and the MCP client. No Tauri or Node imports, so it runs in the app's webview. |
| `tools/fake-mcp-server` | A fake MCP server for dev and tests, over stdio or HTTP. |

Still to come: `packages/cards` (character cards), `apps/desktop` (the Windows app) and `packages/buddy-driver` (the buddy link). [docs/design.md](docs/design.md) has the design and the build order.

## Develop

You need Node 22 and pnpm 10.

```
pnpm install
pnpm typecheck
pnpm test
pnpm fake-mcp              # the fake MCP server over stdio
pnpm fake-mcp --http 0     # over HTTP on 127.0.0.1, on a free port
```

Dev and tests use a fake model and the fake MCP server: no keys and no paid services. Test and demo runs use a scratch HOME.

## Security

See [SECURITY.md](SECURITY.md). Please report problems privately, not in a public issue.

## Licence

MIT. See [LICENSE](LICENSE).
