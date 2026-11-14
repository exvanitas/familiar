# Familiar's design

Familiar is a small Windows app. A person brings a model and a character card, and gets a persona that chats, remembers, sets reminders and does things through tools. Part 1 is Familiar on its own. Part 2 links it to Desktop Buddies, once that app's API v2 has shipped, so the persona can live in a buddy.

The owner approved this plan on 2026-11-14. This file carries its decisions into the repo.

## Rules that hold everywhere

- **Bring your own model:** OpenAI-compatible endpoints (which cover OpenRouter, LM Studio and Ollama), Anthropic and Gemini. Keys live in Windows Credential Manager, one entry per endpoint. Never in files, the database, logs or exports.
- **No account and no telemetry.** The app talks only to the model you picked, the remote servers you add, and in part 2 to Desktop Buddies on the same PC.
- **It reaches only what has an API:** its own built-in tools and the MCP servers you add. No shell. Tools that write, open or send ask first. Windows UI Automation, and then screen and mouse, are later tiers with their own plans.
- **A capability matrix** in Settings and in the docs, built from one list: what it can do, through what, and what's missing.
- **The local app stays free, open (MIT) and bring-your-own-key.** Data that could one day sync stays apart from data tied to this PC (keys, server commands, window places).
- **Dev and tests use fakes:** the fake model and the fake MCP server here, and a fake Desktop Buddies in part 2. No keys, no paid services. Test and demo runs use a scratch HOME. Browsers run headless.

## Units and ports

Small units with their I/O passed in, and contract tests for each port.

| Unit | Holds |
| --- | --- |
| `packages/core` | Turn loop, journal, memory, reminders, tool and consent rules, MCP client, the capability list, the decision slot. No Tauri or Node imports (a test checks), so it runs in the webview and could run elsewhere later. |
| `packages/cards` | Character card reader (V2/V3, PNG and JSON) and lorebooks. Liftable into a shared package later. |
| `apps/desktop` | The Tauri app: model adapters, views, the native shell and its few Rust commands. |
| `packages/buddy-driver` | Part 2: the presence protocol and the buddy driver. |
| `tools/fake-mcp-server` | The fake MCP server. |

Ports core sees: model, clock, store, fetch, keyring, process (server starts), notifier, decision, and in part 2 the buddy transport.

### The model port

`packages/core/src/model/port.ts`. One reply is a stream of events (thinking, text, tool calls) that ends in exactly one `done` or `error`. It never throws, and a stop signal ends it promptly with an `aborted` error. Every adapter runs the same contract (`packages/core/src/testing/model-contract.ts`): the fake model now, the pi-ai adapter over recorded responses from step 4.

## The decision slot: should the persona react?

Most moments are fixed rules: you send a message and she answers, a reminder fires, a consent card shows, an error shows. Between them sits an ambient middle: something happened, nobody asked, should she react, and roughly how?

A decision port answers that. **One event goes in. Out comes an act and a kind:**

- act: `quiet`, `gesture` (a pose or a small mark, no words), `bubble` (one short line), or `chat` (a message in the chat)
- kind: `greet`, `celebrate`, `comfort`, `curious`, `playful`, `nudge`, `inform` or `none`

What the decider sees: the persona's short sketch and a chattiness setting (low, medium, high), whether do-not-disturb or fullscreen is on, the last 10 events with times, her last 3 reactions with times, how long since the last chat and whether the chat is in front, and the local time. Never window titles, paths or message text.

**Rules first.** The first decider is plain rules, from the owner's accepted reaction rules:

- Fullscreen or do-not-disturb: quiet, always.
- Sent home, hidden or paused by you: quiet until you call her out.
- Acknowledgement only (you thanked her, dismissed a bubble, closed the chat): no spoken line, a gesture at most.
- She reacted in the last 2 minutes: quiet, unless the new event is bigger (you came back after a long time away).
- Unprompted bubbles: at most one per 10 minutes at medium chattiness, one per 30 at low, one per 5 at high.
- Back after 20 minutes or more: greet once. A gesture at low chattiness, a bubble at medium or high.
- Music: track changes are quiet by default. A bubble only on the first play of the day, or when the mood clearly matches the persona's interests, and never twice in a row.
- Late night with a long session: one nudge per night at most.
- Tool done or reply done while the chat is hidden: the teaser rule handles it. The decider only picks gesture or quiet when no teaser is due.
- Clicked once: a gesture at most (plain clicks are petting).
- When in doubt: quiet.

**A model later, if tests earn it.** A small local decision model can plug into the same port once it beats these rules on a shared test bench, runs on an ordinary PC's CPU, and ships as a separate download under its own licence. The rules stay as the fallback.

## A bare "thanks" or "ok" gets no reply message

The owner's rule (2026-11-14): when you send only an acknowledgement, such as "thanks", "ok", "got it" or a thumbs up, the persona doesn't answer with a message. A reaction is fine: a small mark on your message in part 1, a pose from her buddy in part 2.

- A local check spots a bare acknowledgement. It costs no model call.
- **Except when it answers her.** If her last message asked you something, "ok" is an answer, and it goes to the model as usual. Consent never rides on chat text: consent cards have their own buttons.

## Build order

Hours are a working estimate, not calendar time. Part 1 is re-estimated once the first real server works end to end in the installed app.

| # | Step | Done when | Hours |
| --- | --- | --- | --- |
| | **Part 1: Familiar on its own** | | **92** |
| 1 | Repo, workspace, CI, fake model, fake MCP server | Typecheck and tests green on CI | 3 |
| 2 | Spikes: pi-durable in a Tauri webview, pi-ai bundling, the installed exe starting a local MCP server | A yes or no on each, written down | 5 |
| 3 | Tauri shell: the app loaded from a folder beside the exe, windows and capabilities, tray, credentials, SQLite, notifications, hotkey, server starts with Windows' own dialog and a job, the guarded fetch, the WebSocket for part 2 | Runs on the Windows runner. Then the exe settles | 8 |
| 4 | Model layer: port, pi-ai adapter, presets, model list, Test, caps | Recorded responses pass for all three APIs | 5 |
| 5 | Turn loop and journal in core: resume rules, recorded calls, parked waits, the state it reports, the decision slot with the rules decider | Kill-mid-tool tests for every step kind | 8 |
| 6 | Cards: V2/V3, lorebook, prompt building, plain helper | Sample cards round-trip, lorebook budget tests | 5 |
| 7 | MCP client: local and remote servers, add by paste or form, Test, prerequisites, saved setups, secrets and blanking, the unpinned flag, changed-tool re-ask, time limits and Stop, restarts | Against the fake server: add, crash mid-call (never sent again), change a tool, print a secret (blanked), remove | 12 |
| 8 | Tools, reminders, consent cards, activity list, the outside-content rule | Missed-reminder, exact-call consent, revoke and steering tests | 7 |
| 9 | Capability matrix: the list, the Settings tab, the docs page, the setup guide | Settings and docs agree, checked in CI | 5 |
| 10 | Memory: notes, summaries, the Memory tab, deletion | Notes survive restart and delete cleanly | 4 |
| 11 | Chat window, first-run setup, settings | Headless screenshots, light and dark | 10 |
| 12 | Packaging: the zip, the per-user installer and the draft release. A winget manifest for the public flip | The installer runs on the owner's PC, and a local server runs there | 4 |
| 13 | What screenshots can't show: upgrades, sleep and wake, notification buttons, local servers under Smart App Control | Checked on the runner and once on the owner's PC. That last check gates the release | 8 |
| 14 | Codex reviews and fixes, spread over the steps | No open P1 or P2 | 8 |
| | **Part 2: the buddy link, after Desktop Buddies' API v2 ships** | | **25** |
| 15 | Presence protocol and buddy driver, against a fake Desktop Buddies | Contract tests for snapshots, leases, budgets, fallbacks | 6 |
| 16 | Wiring into Familiar: moments, the Buddy setup step and tab, the buddy tool, matrix rows | End to end on the runner with the fake model | 5 |
| 17 | The owner's own agents as buddies (in their own repo) | A started turn shows on that agent's buddy | 11 |
| 18 | A release, Codex reviews and fixes | No open P1 or P2 | 3 |

## Shipping

GitHub releases (a per-user installer, or a zip of the exe and its app folder, with SHA-256 sums), and winget once the repo is public. No Microsoft Store. Unsigned until free signing for open-source projects (SignPath) after the public flip, so the README says what Windows will show.

Each new unsigned exe gets a fresh Smart App Control verdict. So the exe holds only native parts, settled in step 3, and the app lives in a folder beside it. If a new exe is blocked on the owner's PC, the work stops and gets reported. Builds are never rerolled to get past it.
