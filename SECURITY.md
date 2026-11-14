# Security

Familiar is early, unreleased work. There's nothing to install yet. This file says what the design holds to, and how to report a problem.

## What the design holds to
- **No account and no telemetry.** The app's own traffic goes only to the model provider you pick, the remote MCP servers you add, and in a later part to Desktop Buddies on the same PC. The app draws in Microsoft Edge WebView2, which has its own diagnostic data and updates by Windows' settings: see Microsoft's [WebView2 data and privacy](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy).
- **Keys stay in Windows Credential Manager**, one per endpoint. Never in files, the database, logs or exports. Changing an endpoint's address asks for its key again.
- **It reaches only what has an API:** its own built-in tools and the MCP servers you add. There's no shell. Tools that write, open or send ask you first, and a yes covers that exact call.
- **A local MCP server is a program that runs as you.** The app shows its full command before it first runs, and only ever starts the setup you approved. Secrets a server needs are kept like keys and blanked from what it prints.
- **Character cards are data.** Their text is always shown as text, and nothing in a card is fetched or run.

[docs/design.md](docs/design.md) has the rest of the design.

## The exe won't be signed at first
Windows may warn about it, and Smart App Control may block it. You'll be able to build it yourself from this source if you'd rather not trust a download.

## Reporting a problem
Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (Security, then Report a vulnerability). Say what you found, how to reproduce it, and which version or commit. We'll answer as soon as we can.
