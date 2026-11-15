# Familiar's design

Familiar is a small Windows app. A person brings a model and a character card, and gets a persona that chats, remembers, sets reminders and does things through tools. Part 1 is Familiar on its own. Part 2 links it to Desktop Buddies, once that app's API v2 has shipped, so the persona can live in a buddy.

This file holds the plan's decisions and the build order.

## Rules that hold everywhere

- **Bring your own model:** OpenAI-compatible endpoints (which cover OpenRouter, LM Studio and Ollama), Anthropic and Gemini. Keys are typed into Familiar's own Settings window and live in Windows Credential Manager, one entry per endpoint, write-only. Never in files, the database, logs or exports.
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

## Where the data lives

Decided 2026-11-14, by the maintainer: "Familiar storage, sure, A is fine, unless there are drawbacks." Option A was IndexedDB. So conversations, memory, reminders and settings live in pi-durable's own IndexedDB store, inside the app's webview. That replaced the plan's earlier "one SQLite file": pi-durable needs real transactions on a single connection, and Tauri's SQL plugin pools connections. With IndexedDB there's no storage code in the exe, so every storage fix ships as an app-folder update.

Each possible drawback has a test or a check, so nobody using Familiar meets it:

| Drawback | What prevents it | Checked in |
| --- | --- | --- |
| A changed origin or data folder starts an empty database | The app's origin and its WebView2 data folder are pinned in config. A test fails if either changes. Data survives an update, a reinstall over the top and a winget upgrade. | Step 3 (pins and test), step 13 (upgrade paths on the Windows runner) |
| Uninstall loses data by surprise | Uninstall keeps your data unless you tick "Also delete my conversations, memory and settings", which is off by default. The README and the uninstaller both say so. | Step 12 |
| No way to back up or move | Export writes everything to one versioned file, and import reads it back. Keys never go in the file. | Step 10, with a round-trip test |
| A power cut loses the last writes | Every write uses strict durability, and a test checks that no transaction opens without it. The runner can't cut the power, so step 13 kills every app and WebView2 process right after a write and checks the write is there on restart. That kill check is the honest proxy for a power cut, not proof of one: a real cut still relies on WebView2 flushing strict writes to disk. | Step 5 (strict), step 13 (hard-kill check) |
| WebView2 evicts the data when the disk is full | At start the app asks for persistent storage and checks it was granted. If WebView2 won't grant it, the app keeps a rolling backup export in its own folder: a fixed number of copies with a size cap, never any keys, its folder shown in Settings. | Step 3 (whether it's granted), step 10 (the fallback backup) |

## The native shell

`familiar.exe` holds the native building blocks and the gates that must not live in a webview, and the app is a folder beside it. [shell-design.md](shell-design.md) has the whole design: four promises (no page reads a key back, data leaves only to places you approved in a Windows dialog, only programs you approved start, the data folders never move), each with checks on the Windows runner.

Decided 2026-11-14 by the maintainer: "so we do option 1, the rest of your decisions make sense to me."

- **The exe settles just before the first release (step 12)**, not at step 3. No exe reaches a person's PC until it's settled.
- **Keys are typed in Familiar's own Settings window** (option 1), not a native prompt, with four safeguards: Settings is a separate window that never shows model or tool text and has its own narrow permissions, keys are write-only (pages see only "set" and a masked hint), core makes every request with the key, and changing a provider's address needs the key typed again.
- **The hours are accepted**, to be redone once the riskiest parts have run on the runner.

### The model port

`packages/core/src/model/port.ts`. One reply is a stream of events (thinking, text, tool calls) that ends in exactly one `done` or `error`. It never throws, and a stop signal ends it promptly with an `aborted` error. Every adapter runs the same contract (`packages/core/src/testing/model-contract.ts`): the fake model, and the pi-ai adapter over recorded responses. [model-design.md](model-design.md) has the model layer: the adapter, the presets, the model list, Test, caps and retries.

### The turn loop and the journal

`packages/core/src/journal/`. The turn loop runs on pi-durable 1.5.2 behind a small facade, on its IndexedDB store with every transaction strict, and journals each step before anything is shown. A turn killed at any step goes on by the resume rules when the app opens again. [turn-design.md](turn-design.md) has the facade, the resume table as built, parked waits, the step cap, the state it reports, the decision slot's wiring, and the cap reservations kept in the journal.

## The decision slot: should the persona react?

Most moments are fixed rules: you send a message and she answers, a reminder fires, a consent card shows, an error shows. Between them sits an ambient middle: something happened, nobody asked, should she react, and roughly how?

A decision port answers that. **One event goes in. Out comes an act and a kind:**

- act: `quiet`, `gesture` (a pose or a small mark, no words), `bubble` (one short line), or `chat` (a message in the chat)
- kind: `greet`, `celebrate`, `comfort`, `curious`, `playful`, `nudge`, `inform` or `none`

What the decider sees: the persona's short sketch and a chattiness setting (low, medium, high), whether do-not-disturb or fullscreen is on, the last 10 events with times, her last 3 reactions with times, how long since the last chat and whether the chat is in front, and the local time. Never window titles, paths or message text.

**Rules first.** The first decider is plain rules:

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

When you send only an acknowledgement, such as "thanks", "ok", "got it" or a thumbs up, the persona doesn't answer with a message. A reaction is fine: a small mark on your message in part 1, a pose from her buddy in part 2.

- A local check spots a bare acknowledgement. It costs no model call.
- **Except when it answers her.** If her last message asked you something, "ok" is an answer, and it goes to the model as usual. Consent never rides on chat text: consent cards have their own buttons.

## Build order

Hours are a working estimate, not calendar time. Part 1 is re-estimated once the first real server works end to end in the installed app.

**Re-estimated 2026-11-15, after step 3.** Step 3 took 38.25: the accepted 33.75, 3 more rework hours the lead approved, and 1.5 for the last batch of six review fixes. Its review rounds on security code took about as much work as the build itself, and they found races in concurrent code more than in rules. Steps 4, 5 and 7 build the same kind of code: the model layer streams over the guarded fetch, the turn loop resumes a durable journal after a kill, and the MCP client restarts servers under time limits. So each gets a rework row of a third of its build: 1.75, 2.75 and 3.5. Less than step 3's, because the hard parts they stand on (the fetch's single owner, the actor per setup, the gate) now exist and are proven. The other steps are app logic with ordinary tests, and step 14's review hours cover them. Part 1 goes from 120 to 132.5.

| # | Step | Done when | Hours |
| --- | --- | --- | --- |
| | **Part 1: Familiar on its own** | | **132.5** |
| 1 | Repo, workspace, CI, fake model, fake MCP server | Typecheck and tests green on CI | 3 |
| 2 | Spikes: pi-durable in a Tauri webview, pi-ai bundling, the installed exe starting a local MCP server | A yes or no on each, written down | 5 |
| 3 | Tauri shell ([shell-design.md](shell-design.md)): the app loaded from a folder beside the exe, its origin and WebView2 data folder pinned, persistent storage asked for, windows and capabilities, the egress closure, the native confirms, tray, keys typed in Settings, notifications, hotkey, server starts with Windows' own dialog and a job, the guarded fetch | Every security check passes on the Windows runner | 38.25 |
| 4 | Model layer: port, pi-ai adapter, presets, model list, Test, caps | Recorded responses pass for all three APIs, also over the guarded fetch in the real webview | 7 (4.5 build and 2.5 rework) |
| 5 | Turn loop and journal in core, on pi-durable with its IndexedDB store and strict durability: resume rules, recorded calls, parked waits, the state it reports, the decision slot with the rules decider | Kill-mid-tool tests for every step kind. pi-durable's storage suite passes in CI | 10.75 (8 and 2.75 rework) |
| 6 | Cards: V2/V3, lorebook, prompt building, plain helper | Sample cards round-trip, lorebook budget tests | 5 |
| 7 | MCP client: local and remote servers, add by paste or form, Test, prerequisites, saved setups, secrets, the unpinned flag, changed-tool re-ask, time limits and Stop, restarts (starting, approval and blanking are in the exe from step 3) | Against the fake server: add, crash mid-call (never sent again), change a tool, print a secret (blanked), remove | 14 (10.5 and 3.5 rework) |
| 8 | Tools, reminders, consent cards, activity list, the outside-content rule | Missed-reminder, exact-call consent, revoke and steering tests | 7 |
| 9 | Capability matrix: the list, the Settings tab, the docs page, the setup guide | Settings and docs agree, checked in CI | 5 |
| 10 | Memory: notes, summaries, the Memory tab, deletion. Export and import, and the fallback backup with its native commands | Notes survive restart and delete cleanly. Export then import gives back the same data | 6 |
| 11 | Chat window, first-run setup, settings, the Trusted Types rule on every page | Headless screenshots, light and dark | 10.25 |
| – | Pre-release native pass: the WebSocket to Desktop Buddies and its pairing token, against Desktop Buddies' settled protocol. Then the exe settles | Its security checks pass on the runner | 1.25 |
| 12 | Packaging: the zip, the per-user installer and the draft release, an uninstaller that keeps data unless you tick the box. A winget manifest for the public flip | The installer runs on a real PC with Smart App Control on, and a local server runs there | 4 |
| 13 | What screenshots can't show: data through an update, a reinstall and a winget upgrade, a write surviving a hard kill, sleep and wake, notification buttons, local servers under Smart App Control | Checked on the runner and once on a real PC. That last check gates the release | 8 |
| 14 | Codex reviews and fixes, spread over the steps | No open P1 or P2 | 8 |
| | **Part 2: the buddy link, after Desktop Buddies' API v2 ships** | | **25** |
| 15 | Presence protocol and buddy driver, against a fake Desktop Buddies | Contract tests for snapshots, leases, budgets, fallbacks | 6 |
| 16 | Wiring into Familiar: moments, the Buddy setup step and tab, the buddy tool, matrix rows | End to end on the runner with the fake model | 5 |
| 17 | Other agent apps as buddies, through the same driver (in their own repos) | A started turn shows on that agent's buddy | 11 |
| 18 | A release, Codex reviews and fixes | No open P1 or P2 | 3 |

Every narrow review after a batch of fixes in steps 3 to 5 found a new, smaller layer. So step 14 holds one fresh review of the whole app before release, and its 8 hours assume one more layer of fixes. The reviews so far were charged to each step's own rework row.

## Shipping

GitHub releases (a per-user installer, or a zip of the exe and its app folder, with SHA-256 sums), and winget once the repo is public. No Microsoft Store. Unsigned until free signing for open-source projects (SignPath) after the public flip, so the README says what Windows will show.

Each new unsigned exe gets a fresh Smart App Control verdict. So the exe holds only native parts, settled just before the first release, and the app lives in a folder beside it. No exe reaches a person's PC until it's settled. If a new exe is blocked on the test PC, the work stops and gets reported. Builds are never rerolled to get past it.
