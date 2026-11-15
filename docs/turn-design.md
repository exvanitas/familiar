# The turn loop and the journal

Step 5 of the [build order](design.md#build-order). The turn loop runs on pi-durable 1.5.2, with its own IndexedDB store, and every turn is journaled before anything is shown. Kill the app at any step, open it again, and the turn goes on by the rules below. The code is `packages/core/src/journal/`. It runs with fakes only here: real tools, reminders and consent cards come in step 8, memory in step 10, and the chat that shows all of it in step 11.

## The journal facade

Nothing outside `packages/core/src/journal/` imports pi-durable, so an upgrade or a swap touches one folder. pi-durable, pi-ai and chord are pinned to exactly 1.5.2 in core's `package.json`, and `tests/portable.test.ts` fails on a range. Core may import only six of their entry points, the ones the step 2 spike bundled for the browser with no Node built-ins: pi-durable's root and `storage/indexeddb`, chord's `context`, and pi-ai's `models`, `utils/event-stream` and `utils/transcript`. The same test still keeps Tauri and Node out of core.

`openJournal(options)` takes everything as ports:

| Port | What it is | In the app | In tests |
| --- | --- | --- | --- |
| `store` | The journal's database (`openJournalStore`) | `indexedDB` in the core window | a fake IndexedDB in Node, the real one in headless Chromium |
| `owner` | One owner per database | a Web Lock (`webLockOwner(navigator.locks)`) | a lock in memory, and the real Web Lock in Chromium |
| `model` | The adapter's model port | the pi-ai adapter (step 4) | the fake model |
| `clock` | `now` and `setTimer` | `systemClock` | the wall clock with an offset, so an hour can pass while the app is closed |
| `wake` | Told the earliest wake time | the exe's `wake_at` | records what it was told |
| `consent` | Shows a consent card, resolves with the answer | step 8's card | answers, or never does |
| `presence` | The state it reports | the chat's status line; the buddy driver in part 2 | records every snapshot |
| `decider` | The decision slot | the rules decider | the rules decider, sometimes spied on |

Settings the journal gives pi-durable: `identity: { attribution: null }`, so no request names pi to a provider; tools run one at a time, so consent cards come one at a time; a request a crash cut off is sent again up to twice, 2 s then 4 s later. The model reaches pi-durable only through `portProvider` (`provider.ts`), as the spike built it, with the journal's caps and step 4's retries around the adapter.

**Errors cross coded.** pi-ai decides whether to send a failed request again by matching words like "rate limit" or "503" in its error text. Step 4's `withRetries` already retried what was safe to retry, so pi-durable must never retry on its own. `provider.ts` hands pi-ai each `ModelError` as hex-coded JSON, which holds no word or status code those patterns match, and `decodeModelError` reads it back for the chat. A request a crash cut off is still sent again: pi-durable counts that as a failed attempt whatever the text says.

## The store

pi-durable's own `IndexedDbStorage`, opened through `openJournalStore` (`store.ts`):

- **Strict, always.** pi-durable opens its transactions without a durability hint. The store hands it a wrapped IndexedDB factory whose databases add `durability: 'strict'` to every transaction they open. The open then runs a probe transaction and fails with `NotStrict` unless it reports `strict`. The schema's upgrade transaction is the browser's to open and takes no hint, and it runs once, when the database is made.
- **Tests:** `journal.test.ts` checks every transaction of a whole turn is strict, and that a browser which drops the hint gets `NotStrict` and nothing opens. In Chromium, every kill scenario and the conformance suite record each transaction's own `durability`, and the only value seen is `strict`.
- **One owner.** The journal holds its database under a Web Lock for its whole life. A second instance, in this page or another, waits for it, and the browser releases it when the page goes away, a reload or a kill included. In headless Chromium a second page waits on the real Web Lock, and a reload of the first hands it over.
- **The conformance suite.** pi-durable's own storage conformance suite (32 cases) runs against the strict store in Node on a fake IndexedDB, with Vitest's `expect`, and in CI in headless Chromium on the real IndexedDB, with the spike's small assertion shim. CI's `check` job runs it in its own step, "Journal in headless Chromium", on the runner's Chrome, and fails if no browser is found.

## The resume table, as built

| Step was | Then | How | Kill test |
| --- | --- | --- | --- |
| Model call, finished | Replayed from its record. No new request | Its answer is an entry in the journal | `model-finished` |
| Model call, in flight | Sent again. Its open cap reservation stays spent, and the new call takes its own | pi-durable keeps the partial as an aborted entry and sends the request again after the backoff. The reservation was stored before the call was sent, and only the instance that made it can settle it | `model-in-flight` |
| Tool, finished | Its result is reused | Its result is an entry | `tool-finished` |
| Read, started | Run again | `replay: "safe"` | `read-started` |
| Built-in write, started | Run again. The write is made once | `replay: "safe"`, and the write commits with its step's receipt (below) | `write-started` |
| Built-in effect, started | Not run. A question in chat: "I was sending a message to Sam when the app closed. Do it now?" | `replay: "unsafe"`. The `afterTool` hook turns pi-durable's `interrupted` result into the question, and tells the model it wasn't run again. Yes asks her to do it now, as a new step that asks consent again | `effect-started` |
| Server (MCP) tool, started | Never repeated on its own. Reported as interrupted ("may have partially run"), with Run again | `replay: "unsafe"` for every server tool, whatever its hints say. The result keeps pi-durable's words, and a `rerun` question offers Run again | `server-started` |
| Waiting for your OK | The wait is still there after a restart | The card is in the journal's consent document before it's shown. After a restart it's listed at once, and asked again with the same id. The tool runs once, after the answer. An answer given just before a kill is kept, so it isn't asked a third time | `consent-parked` |
| Waiting for a wake time | Still parked after a restart. Fires once when due | A pi-durable task that ends its phase in `sleepUntil` | `wake-parked` |

Each kill test runs twice, by the same scenario code (`tests/journal/scenarios.ts`) and the same checks (`checks.ts`):

- **Node** (`kill.test.ts`): life 1 runs until its step is under way, then the store's connection is dropped and the engine abandoned, with no shutdown path. Life 2 opens the same fake IndexedDB, resumes, and finishes.
- **Chromium** (`browser.test.ts`): the same, with the page closed at the kill point and opened again on the same origin.

A tool says what kind it is, and the kind alone decides its replay:

| Kind | What it is | Replay |
| --- | --- | --- |
| `read` | A pure read | safe |
| `write` | A built-in write, made through `step.write` | safe |
| `effect` | A built-in tool with an outside effect | unsafe |
| `server` | Any MCP server's tool | unsafe |

This keeps the spike's condition (every tool unsafe except pure reads) with the one exception the resume table asks for: a built-in write is safe to repeat because it can't be made twice.

**Built-in writes.** `step.write(change)` runs the write in one pi-durable commit together with the step's receipt, so a note or a reminder is all made or not made. A rerun of the step finds the receipt and gets the first run's value back without writing again. Writes are matched by their order within the step. pi-durable commits the step's result in its own commit right after, and that's the one gap: a kill between the two reruns the step, which then finds its receipt. `write-started` kills exactly there. Only outside effects can be cut off mid-call.

The claim is about committed rows: exactly one row in the store, whenever the kill lands. The fake note store appends rows, so a second write would show. Each row carries the life that made it, and the step's result must carry the same token, so the receipt matches the row. A write's change can run twice, once in a life a kill cut off before its commit landed, and that's fine: nothing of that run was stored. The tests count rows, not calls:

- `write-started`: the kill comes after the write's commit. One row, from life 1. The rerun's change never runs.
- The every-point test (`kill.test.ts` and `browser.test.ts`): the connection is dropped right after each transaction from the tool's start to past the turn's end (k = 1 to 14). In Chromium the page is also closed at 16 seeded delays, 0 to 39 ms after the tool starts. Every run gives exactly one row, matching the result. Runs take both paths: the row made again in life 2 (the kill came before the commit), and the row from life 1 found by its receipt.
- Splitting the write and its receipt into two commits fails the every-point test in Node and in Chromium, with two rows.

## Parked waits

- **Consent** (`beforeTool`): a tool marked `asks` stores its card, keyed by the step's id, then asks the consent port. While a card is open the state is `waiting`. The card leaves the document when the step ends, in the hook that runs just before its result is stored.
- **Wake times** (`parkUntil`, for step 8's reminders): a task that sleeps until its time. The journal gives pi-durable `onWake`, so pi-durable arms no timer of its own. Each time the earliest wake changes, the journal tells the wake port (in the app, the exe's `wake_at`, so a reminder fires though the window sleeps or the app is closed), and arms its own timer while the page lives. `journal.wake()` is what the wake port calls. pi-durable offers a wake time once, when it changes, so the page's timer checks the clock when it fires and arms again if it came early (timers can fire a millisecond early). Without that, a sleep whose timer fired early was never run: `journal.test.ts` › "a wake timer that fires early arms again" checks it with timers 20 ms early. A wake due while the app was closed fires once, on the next open.

## The step cap

8 tool steps per turn, then the turn asks: "I've taken 8 steps on this. Shall I keep going?". A step here is one model reply that calls tools, pi-durable's `maxTurns`, with its calls run one by one inside it. Yes starts a continue, with a fresh 8 steps. The calls themselves are bounded separately, below.

## Bounds on tool calls

The step cap counts replies, so on its own it doesn't bound how many calls one reply makes. Consent doesn't either, once a tool is always allowed. So `bounds.ts` sets two numbers, in one place:

- `TOOL_CALLS_PER_REPLY`, 8: at most 8 calls of one model reply run.
- `TOOL_CALLS_PER_TURN`, 32: at most 32 calls run in one turn, across every reply and every step-cap "go on". That Yes continues the steps but doesn't lift the 32.

A call past either bound never runs. The `beforeTool` hook blocks it before anything else is asked, consent included. The model gets a tool error that says why: "Familiar stopped after 8 tool calls in one reply. This call was not run." The chat gets one line per reply, or per turn: a `familiar.notice` entry, "Familiar stopped after 8 tool calls in one reply." or "Familiar stopped after 32 tool calls in this turn."

**The count is in the journal.** A tool-budget document holds the turn's admitted and refused calls by step id, changed in one commit per call. A call's place in its reply is its position among the reply's calls, which the journal keeps. A call asked again after a restart keeps its verdict: admitted stays admitted, refused stays refused, so a resume can't run a refused call. Only a message you send starts a new turn. A step-cap or cap-pause Yes, a "Do it now?" and a Run again carry on the turn they answer: their submission and its turn are written in one commit. A call that's admitted and then denied consent still counts. The count errs high.

Tests (`bounds.test.ts`):

- A reply with 20 calls runs 8 and refuses 12, each with the reason, and there's one line in chat.
- A turn of five replies of 8 calls, with a step cap of 3 (two "go on"s) and a kill in the middle, runs 32 and refuses the rest. The next message gets a new 32.
- A property over 25 seeds: replies with 0 to 20 calls, reads and always-allowed effects, step caps of 2 to 5, and one to three kills mid-call. No reply runs more than 8, no turn more than 32, and no refused call ever runs.
- Three mutations fail them: dropping the reply check, dropping the turn check, and letting a "go on" start a new turn.

## Caps that pause, not fail

A `paused` error from `cappedPort` ends the run in pi-durable's terms, but the journal reads it back and parks the turn: a `cap` question with the cap's message, and the state `waiting`, never `error`. Yes starts a continue from the turn's last step, so nothing that had finished runs again. If the cap still has no room, it pauses again. Going on past a turn's token cap gives the continue a new turn id, so a fresh turn budget: you said yes to it. Any other model error ends the turn as failed, and the state is `error`.

## Durable cap reservations

The caps ledger (step 4's `createCaps`) now keeps its reservations and settled spend in the journal's store, in one Session document (`ledger.ts`).

- **Atomic over the store.** `UsageStore` has one write: `update(change)` runs `change` on the whole ledger as one atomic step. In the journal's store that's one pi-durable commit. pi-durable's Session runs one commit at a time on its line, a commit's callback and its settlement, and the database has one owner. `before` and `settle` are each one update, the check and the reservation together. The in-memory lock step 4 had is gone. A lock in memory is what a second instance or a reload would bypass, and the store's own atomicity can't be bypassed.
- **Survives a restart.** A reservation is stored before its call is sent. Only the instance that made it can settle it, so one left open by a crash or a reload stays open, still counts toward every cap, and becomes a spent record at its deadline (30 minutes), at what was reserved.
- **Bounded.** Settled records older than two days fold into per-turn totals, so a turn keeps its cap however long it runs. A folded turn unused for 30 days is dropped.
- **The API.** `createCaps`, `Caps`, `cappedPort` and `memoryUsageStore()` keep their shapes. Only `UsageStore` changed, from five calls to `update` and `read`, and no step 4 caller implemented its own.
- **Tests.** Every step 4 caps test, the 200-seed property test included, runs on both the memory store and the journal's store (`caps.test.ts`). `ledger.test.ts` adds:
  - an open reservation across a restart
  - the fold
  - 100 seeded interleavings where the engine is killed in the middle of concurrent calls, then reopened on the same store, with about a third of the calls starting after the restart. It checks that spend never passes a cap, and that no reservation the dead instance held is lost or shrinks. It also checks they're all spent records past their deadline. Two mutations fail it: dropping expired reservations, and reading the ledger outside the commit that writes it.

## The state it reports

`presence.ts`. A presence snapshot: `{ v: 1, agent, gen, seq, state, tool?, ttl: 60 }`, sent whenever the state or the tool changes. `gen` is new for each start of the journal, and `seq` rises within it, so a restarted loop's low numbers aren't taken as old. The state comes from committed state only: pi-durable's live document, and the journal's consent and question documents.

| State | When |
| --- | --- |
| `waiting` | A consent card is open, a cap paused the turn, or the step cap asks. Waiting beats working beats thinking |
| `working` | A tool step is under way (with its name) |
| `speaking` | A reply's text is streaming in |
| `thinking` | A run is going, and nothing above holds |
| `error` | The last run ended in an error that isn't a pause or a question |
| `idle` | Nothing is going on |

## The decision slot

The rules decider is wired into the loop through `journal.notice(event)`, and the loop calls it itself when:

- a tool finishes, or a reply finishes, while the chat isn't in front (`tool-done`, `reply-done-hidden`)
- you send a bare acknowledgement (`ack-sent`)

The decider gets the ambient state the app passes in (persona sketch, chattiness, do-not-disturb, fullscreen, sent away, chat in front, teaser due). The loop adds the last 10 events, her last 3 reactions, the minutes since the last chat, the time and the local hour. A message you send is kept as a `message-sent` event, as context. A reaction above `quiet` goes to `onReaction`. The recent events and reactions live in memory, so a restart starts them again.

**A bare "thanks" or "ok"** (`send`): when `needsReply` says it needs none, the message is kept in the transcript as a `familiar.ack` entry the model never sees. Nothing is sent to the model, and the decider picks the reaction, a gesture at most. If her last message asked something, "ok" is an answer and goes to the model as usual.

## Not settled

- WebView2 itself: everything ran in headless Chromium. Step 13 kills every app and WebView2 process after a write on the Windows runner. That's the honest proxy for a power cut.
- No runner check yet for a turn journaled in the real exe's core window and resumed after the exe is killed. Step 13 owns the hard-kill checks.
- The answer to a `redo` or `rerun` question is a message asking her to do it again, so the model makes the call again, through consent again. Running the exact stored call instead is for step 8, with the real consent cards.
- The ledger is rewritten whole on every change. That's fine at today's size: a day's records, plus a total per older turn.
