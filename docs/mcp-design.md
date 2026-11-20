# The MCP client

Step 7 of the [build order](design.md#build-order). Familiar's own client for MCP servers: local servers it starts through the exe, and remote servers it reaches through the guarded fetch. It speaks both eras of the protocol itself, with no MCP SDK. The exe's half (the approval dialog, the job, blanking secrets, the guarded fetch) was built in step 3 and is in [shell-design.md](shell-design.md#5b-starting-a-local-mcp-server).

| Part | Where |
| --- | --- |
| The client: saved servers with their runs, Add, Test, start, stop, remove, a turn's tools, `send` | `packages/core/src/mcp/client.ts` |
| One server's link: the wire, the exchange slot, the handshake, pages, calls, pongs | `packages/core/src/mcp/wire/link.ts` |
| The exchange machine, a pure function | `packages/core/src/mcp/wire/exchange.ts` |
| The six message kinds Familiar may send | `packages/core/src/mcp/wire/framing.ts` |
| The parser for a server's untrusted answers | `packages/core/src/mcp/wire/parse.ts` |
| The modern era's mirrored headers | `packages/core/src/mcp/wire/headers.ts` |
| `ToolDecision`, consent bound to the exact call | `packages/core/src/mcp/decision.ts` |
| The owner of durable tool config | `packages/core/src/mcp/owner.ts` |
| One server's runs | `packages/core/src/mcp/runtime.ts` |
| A tool list's bounds and fingerprints | `packages/core/src/mcp/catalog.ts` |
| Server tools as the turn loop sees them | `packages/core/src/mcp/server-tools.ts` |
| Adding by paste or form, setups, the unpinned flag | `paste.ts`, `setup.ts`, `unpinned.ts` in `packages/core/src/mcp/` |
| The exe's path and address rules, mirrored | `packages/core/src/mcp/native-rules.ts` |
| Questions as a view over pi-durable's record | `packages/core/src/journal/view.ts` |
| The card desk: cards shown, and answers from other windows | `packages/core/src/journal/desk.ts` |
| Named mutation switches, for the test build only | `packages/core/src/mutations.ts` |

Section numbers are stable: code comments and tests cite them ("docs/mcp-design.md 3.4").

## 0. The premises

- **P1. No background runs.** A moment, or her words around a reminder, is one model call with no tools, outside the journal's runs. Her line enters the chat as a write that can't start a run.
- **P2. Familiar never starts or places a run on its own.** Every submission is your act, a message or an answer, made in one commit that reads pi-durable's state. A question is a view over pi-durable's `pi.live.runFailure`, read live. The journal never starts or places a run by itself. `afterFailedRun` stays `keep`, and no `afterRun` hooks are selected.
- **P3. Familiar's own small client** for local and remote servers, speaking both eras: legacy (the five versions 2024-10-07 to 2025-11-25) and modern (2026-07-28), the latter when a server refuses the legacy handshake. Familiar's code is the only thing that sends. It runs one exchange at a time per server, behind a cleanup barrier, and the last check and the native handoff are one synchronous function.
- **P4. The exe bounds what it owns.** Helpers are detached at a bound, chat's share of the 32 open requests is reserved, and the local write bound lives in the exe.
- **P5. Observe, don't predict.** The real pi-durable and the real client run against a scripted fake server and an unkind fake exe, under seeded interleavings. The checks are independent of the code they check.

Standing rules the design keeps:

- no automatic restart after a crash;
- Test only while Stopped;
- recovery only at exe start, and any reload makes the app restart-only;
- consent is one-use, bound to the exact call, and checked at the native handoff;
- tools keep their own names, under frozen keys;
- legacy-era servers are supported;
- a legacy server's ping is answered as the spec requires, and every departure from that is named.

## 1. What you see

- **Her moments and reminder remarks** are one call each, with no tools. If the app is killed mid-call, the moment is lost, never shown late. A reminder itself is never lost: its notification and its chat line are written as before ([turn-design.md](turn-design.md#parked-waits)). Only her words around it can be.
- **What her model sees.** When she speaks into a quiet chat (nothing running, nothing queued, no question open), her model sees what she said. When she speaks while you're mid-turn or a question is open, the line is shown but her model doesn't see it.
- **After a failed run**, messages you queued stay on screen, marked as waiting. There's one **Send now** for the queue, which sends the oldest first. Nothing sends them for you.
- **In a long chat, the summary happens inside a turn.** When the conversation nears the model's context limit, her next reply first waits for the summary. Nothing is summarized quietly in the background between turns (2.5, row 1).
- **A card asked again is a new card.** If the tool or its arguments changed, an answer to the old card answers nothing.
- **A question holds your queued message.** Yes sends it, and the stopped run's work goes on. No, or Skip, also sends it: your model sees the stopped run's last tool results before your message.
- **A new message while a question is open** sends anything queued, then yours, and the question is gone. Its card says "Closed: you moved on".
- **One thing at a time per server.** A call to a server that's starting, re-reading its tools or answering another call is refused at once: "busy, try again".
- **A call that times out or is stopped** ends alone, and the server keeps running. Stopping the server itself answers a call in flight "interrupted, it may have partly run".
- **A crashed server** says so with its last output and waits for Start.
- **A remote server that ended its session** gets one fresh handshake. The call that met it fails ("the server had ended its session") and is never resent: ask again, and a card call shows a new card. If the server does it again straight away, it waits for Start.
- **A local server that stops reading** what Familiar sends is stopped within about 10 seconds, even if the main page has gone.
- **A server that floods pings** has that one operation end, with "the server sent too many pings".
- **A server that speaks only MCP 2026-07-28** works. Its tool list is re-read only at start and on Test. A legacy server's list is also re-read after a call's reply says the tools changed; a modern server sends that news only on a long-lived subscription Familiar doesn't open. A modern tool whose declaration breaks the protocol's header rule isn't offered, and Test says why.
- **After a Stop**, a DNS lookup already asked can finish in the background. Nothing is sent for it.
- **A remote server that answers with a redirect** has the redirect refused, with its status in words. Familiar never follows it (4.4).
- **No server tool runs without your Yes to that call, and no built-in runs unasked unless it's on Familiar's fixed list of note and reminder tools.** There's no "always" for a server's tool. You can mark one named server tool "may run on its own"; its card says plainly that she may then call it even after something a server said, it holds only for that version of the tool, and you can take it back.
- Test and edits only while stopped, revokes that hold at once, and "Familiar needs a restart" after a reload.

## 2. The journal side

### 2.1 Her line: one model call, one commit

A moment, or a reminder's remark, is made like this:

1. **The decider asks for a line**, as [persona-traits.md](persona-traits.md) defines it.
2. **Core makes one model request with no tools**, through `cappedPort`, so the caps count it. The ledger needs a turn key for its reservation, so the request gets its own key (`moment:<random>`), which is never resumable: its reservation settles when the call returns, or becomes a spent record at its deadline if the app dies ([turn-design.md](turn-design.md#durable-cap-reservations)). A paused cap means she stays quiet, with no question and no line. A moment ends silently; a reminder's delivery stands.
3. **One commit writes her line.** It reads `pi.live` and the inbox (`tx.doc(InboxDoc, root.id)`, pi-durable's typed handle) before its admission, then writes through `root.submit(tx, …)`:
   - if no run is live, the inbox is empty and `runFailure` is unset: a write with `model`. pi-durable appends it and starts no run;
   - otherwise: a display-only write, appended at once, busy or idle, which never restarts failed work.
4. **If the app dies before step 3**, nothing is written. The moment is lost by design.

**Why each check is needed:**

- **The empty inbox.** A write that isn't display-only, into an idle conversation with queued items, runs a final boundary and starts your queued message. That would be a run Familiar started. The check is never dropped, and never inferred from other state.
- **No `runFailure`.** A model-visible remark after a failed run would end the context. Your later Send now, or a Yes, would then continue a context ending in her words and find nothing to answer.

**What role her line takes.** It's a **user-role note** in the journal: "Familiar's note: she said …". pi-ai passes messages through unmerged, and local model templates (Ollama, LM Studio) commonly refuse roles that don't alternate. So **`toModelRequest` merges consecutive same-role text messages before the wire**: a note followed by your message becomes one user message, and two notes become one. Tool calls, replay state and tool results are never merged, so no signed assistant content is touched. A test checks that every request body alternates roles.

One side effect, intended: after a failed run, an unanswered message of yours and the next one reach the model as one user message.

**What this removes:** background submission, `whenBusy: "reject"`, a background document, the gate's background check, every "end a background run instead of asking" rule, and placement after background endings.

### 2.2 Questions are `runFailure`, read live

pi-durable records why the newest run ended without an answer in `pi.live.runFailure`. It sets the field in the commit that settles the run's inputs `unanswered`, and removes it in the next commit that starts a run. The record holds the run's task id, its input ids, the reason and a detail.

**The precondition.** A run started in the same commit as the failure keeps it, and so does a run that later answers. Two things start a run in that commit: a reset, and `afterFailedRun: "continue"`. Either would make an old question read as open again once that run answered. Section 2.5 rules both out, with tests. With them ruled out, a failure lasts exactly until the next run starts.

A question is a view over that record (`journal/view.ts`):

| Question | Open when (all read in one transaction) | Detail comes from |
| --- | --- | --- |
| The step cap, "I've taken 8 steps on this. Shall I keep going?" | No run is live, `runFailure.reason` is `turn_limit`, and no answer is recorded for this `runFailure.taskId` | [The step cap](turn-design.md#the-step-cap) |
| A cap pause | `reason` is `model_error`, and the detail decodes (`decodeModelError`) to a `paused` error. No answer recorded | The decoded pause: the turn cap's "Say yes to give it 5000 more", or a daily or dollar cap's words ([turn-design.md](turn-design.md#caps-that-pause-not-fail)) |
| Run again, or "Do it now?" | `reason` is `aborted`, and an interruption record exists for this `taskId`. No answer recorded | The interruption records |
| Error | `reason` is anything else (`model_error` that isn't a pause, `no_model`, `interrupted`, `restart_limit`, `faulted`, `orphaned`, `nothing_to_answer`), or `aborted` with no interruption record (your own Stop) | Not a question: the state is `error`, or idle after a Stop, and the chat shows the reason |

**A pause inside a compaction.** A pause hit by a blocking compaction's own summary request arrives as `Compaction failed: Summarization failed: <coded error>`. The view strips both prefixes before decoding.

**The interruption records.** When a cut-off effect or server call becomes a `redo` or `rerun` question, the `afterTools` hook stores one record per interrupted step (which tool, what it was doing, the step id), grouped under the run's task id. The hook then stops the run with `abortTask` ([turn-design.md](turn-design.md#parked-waits)). A run whose task is aborted ends with reason `aborted` and keeps its inbox. The records are inert unless `runFailure` names their task. If the app dies between the records and the abort, pi-durable resumes the task, the calls are still interrupted, and the hook writes the same records again and aborts. If it dies before the records, nothing is shown.

**A server call whose wrapper is absent on reopen.** A journal reopened without the server's tools (its server not started yet, say) holds no wrapper for a server call that was cut off. The call is still known as a server's by its name, since the `__` namespace is server tools' alone (5.9). So it still gets a `rerun` record and the Run again or Skip question, as it would with the wrapper. Nothing runs again either way: a Run again goes to the model, and a call to a tool its request didn't offer is unavailable until the server is started.

**Several interrupted steps in one round make one question.** In a sequential round an interrupted call commits its result and the next call still starts, and `afterTools` runs once, after every call. So two uncertain effects can share one task. The question lists every interrupted step of that task, and one answer settles all of them: Run again redoes every listed step; Skip skips every one, and the gate refuses each listed tool for the rest of the turn. One question per task keeps "open" exactly the view of pi-durable's record, which names one task. Per-step answers would need an open or closed state per step that `runFailure` can't give, which would be state Familiar holds.

**The answer record**, written by the answer's own commit (2.3), keyed by `runFailure.taskId`. It closes the question even when the answer starts nothing.

**Why it holds.** Nothing records a question after pi-durable's commit. A new run removes the failure in its own starting commit, so a delayed answer finds a superseded question closed. The ledger, presence and the gate all read this same view.

### 2.3 Answers: one commit, checked inside it

An answer is one commit ([turn-design.md](turn-design.md#a-persons-actions)). P2 adds what that commit reads:

1. **Read** `pi.live`, the inbox, any `tx.submission(id)`, the interruption records and the answer records, inside the commit. Every read comes before the commit's admission: `tx.submission` throws `ReadAfterWrite` after the first table write.
2. **If the question isn't open**, return what's recorded and change nothing. "Not open" means a run is live, `runFailure` names another task, or an answer is already recorded. The card shows "Closed: you moved on" or the earlier answer.
3. **Otherwise, record the answer and submit what it starts**, in the same commit:

   | Question | Yes | No or Skip |
   | --- | --- | --- |
   | Step cap | `continue`, with a fresh 8 steps; the turn's call bound still applies | If a message is queued, as read in the commit: `continue`, which places the oldest first, so your model answers it. Otherwise nothing, and the turn is finished |
   | Turn cap pause | `continue`, plus the extension in the ledger, once per Yes id | As above |
   | Daily or dollar cap pause | `continue`, only if there's room again; otherwise it pauses again without spending | As above |
   | Run again | An input asking her to do every listed step again, through the gate | Skip: a `continue`, so the turn goes on without the calls; the gate refuses each listed tool for the rest of the turn |
   | "Do it now?" | The same, asking consent again | As Skip |

The `continue` and the input are each the commit's one admission, made before its other table writes. A `continue` places queued items first and they join the run. By default a boundary takes the first queued follow-up and leaves the rest queued, in order. Familiar doesn't model that order; pi-durable does it.

Two answers at once, or an answer retried after a restart, find the first one's record and start nothing more.

**Which turn a started run belongs to.** A run's budget, its cap extensions and its calls are charged to one turn ([turn-design.md](turn-design.md#bounds-on-tool-calls)). The admission commit records which, by one rule: **the turn of the first input the run places.** The boundary places the oldest queued item first, and `followUpMode` stays `one-at-a-time` (2.5, row 18).

- **No queued item, so the run places nothing:** it belongs to the answered question's turn. That covers a Yes, or a Skip that continues.
- **A queued item placed first:** it belongs to that item's turn, and the answered turn is finished.

This holds the same for a No that places your message, for Send now, and for a Yes made while a message is queued. A Run again input queued behind another message belongs to the old turn, and its run, when it starts, is charged there.

### 2.4 A queued message: Send now, and a new message

- **Send now is one action for the queue.** It's shown beside the oldest queued message whenever no run is live, a message is queued, and no question is open (2.2).
  - **Why one button, not one per message:** the boundary places the oldest item first, so a button on a later message would send an earlier one.
  - **The button carries two things:** the oldest item's submission id, and the `runFailure.taskId` it was shown for (or "no failure"). Whether it shows is read in one commit that writes nothing (`pi.live`, `pi.inbox`, the interruption and answer records), so the offer is of one committed state.
  - **Its one commit** reads `pi.live` and `tx.submission(id)`, both before its admission. If the conversation is idle, `runFailure` still names that task, no question is open, and that submission is still `queued`, it submits a `continue`, which places the oldest first. If any of those has changed, it does nothing, and the button moves or goes away.
  - **It leaves a record**, keyed by its request id, holding the submission it was offered for and what it sent (`SendNowDoc`). A retried Send now finds it, and the harness's H7 reads it.
  - **Nothing else can move the item.** Familiar never withdraws a queued message: no conversation or submission abort exists (2.5, row 17).
  - It's your act, and the only way a message stranded after an error, a Stop or a pi-durable fault goes on.
- **A new message** goes through `send`, once per request id. pi-durable decides what happens:
  - **idle, empty inbox:** it starts a run;
  - **idle, with queued items:** it queues the new message behind them and runs a final boundary in the same commit, which starts the oldest;
  - **busy:** it queues as a follow-up.

  So a message's commit either starts a run, or queues behind one when busy, and an open question closes with it. **The exception is a bare "ok" or "thanks"** that needs no reply: a display-only `familiar.ack` write, which starts nothing and leaves any open question open.
- **A message sent while a card is open** waits behind the card (5.10).

**Why nothing is stranded unseen.** pi-durable keeps the inbox after an unanswered or aborted run. Each ending leaves one of these:

- a question that holds the inbox (2.2);
- an error or a Stop, which shows Send now;
- an answered run, which places its follow-ups.

The one pi-durable path that leaves a queue without `runFailure` is an after-run task cut off at the restart limit. It can't arise, because no `afterRun` hooks are selected (2.5, row 5). Even if it did, Send now would show, carrying "no failure", and the same commit check would apply.

### 2.5 P2's preconditions: pi-durable's own paths, all of them

P2 holds only if nothing but your acts admits a submission, runs a boundary or starts a run. This table lists every path pi-durable 1.5.2 has for that, besides the host's own `submit` and `continue`, each with its pin and its check. The tests are in `packages/core/tests/journal/pins.test.ts`, where a module-graph test walks core's bundle for call sites.

| # | Path | On by default? | Pin | Check |
| --- | --- | --- | --- | --- |
| 1 | **Background compaction.** A conversation-owned summary is a write submission. Into an idle conversation with queued items it runs a final boundary that places them, starts a run, and clears `runFailure` | Yes (`backgroundTokens: 32768`) | `compaction.backgroundTokens: 0` in the journal's settings, and Familiar sets no model overrides. No conversation `configure({compaction})` is ever called. At open, before `resume()`, any compaction task already persisted (from a journal made before the pin) is aborted, not resumed | A test reads the resolved policy, asserts 0 with no override, and checks the engine runs with exactly those settings. A second opens a journal holding an old compaction task: the queued message stays queued and the step-cap question stays open. S6 (7.2) |
| 2 | **Manual compaction**, `compact()`: the same placement as row 1 | Only if called | Never called | Module graph |
| 3 | **Blocking and overflow compaction**, owned by the generation. It appends while the generation holds the run, and places and starts nothing. Its failure ends the run `model_error` with `Compaction failed: …` | Yes | **Kept on purpose.** It's how a long chat is summarized (section 1). No compaction hook is installed: nothing declines, supplies or watches a summary | The view decodes the prefixes (2.2). T13 runs a cap pause during a blocking compaction. The engine's hook list holds no compaction hook, and the module graph has no `beforeCompact`, `afterCompact` or `CompactionTask` |
| 4 | **`afterFailedRun: "continue"`**: a final boundary in the failure's commit, whose run keeps `runFailure` | No (`keep`) | Left at the default | A settings test. The mutation, `"continue"`, must fail H7 |
| 5 | **`afterRun` hooks and after-run tasks**: the boundary moves to `drain`, and tasks may submit with a fresh turn budget. A cut-off `finish` or `drain` leaves the queue with no `runFailure` | No, unless an extension selects one | None selected | The engine's hook list is empty |
| 6 | **`onYield` continuation**: after a `stop` or `length` answer with nothing queued, it appends a continuation and resets `turns` to 0, which bypasses the step cap | No, unless selected | No `onYield` hook | The engine's hook list, and the module graph |
| 7 | **Resets**: `root.reset()`, and a tool's `control: { handoff }`. A queued reset starts a successor in the same commit, keeping `runFailure` | Only if called or returned | Never | Module graph for `reset(` and `handoff` |
| 8 | **`terminate` control**: a round whose every result asks to terminate uses the final boundary, and queued follow-ups start | Only if returned | Familiar's tools never return it | Module graph |
| 9 | **Steers** (`whenBusy: "steer"`), placed at the next `postTools` | Only if passed | Your messages are follow-ups: `send` passes no `whenBusy` | Module graph |
| 10 | **Writes that aren't display-only** (`model`, `head` or `edits`): into an idle, non-empty inbox, a final boundary starts the oldest item | Only if sent | **Every Familiar write except her line is display-only**: the reminder line, `familiar.ack` and `familiar.notice`. Her line is model-visible only under 2.1's one-commit check | A test that each of those writes carries no `model`, `head` or `edits`, and that the reminder line is a submission, never a raw `appendEntry` |
| 11 | **Subagent reporter tasks**: a background reporter posts a child's answer to the parent as a follow-up, and resumes after a restart | Only with a subagent extension | No subagent extension or tools | Exactly one extension is installed, Familiar's own |
| 12 | **Tools submitting or continuing** through `api.conversation(id)` or `ConversationHandle.submit` | Only if a tool does it | No Familiar tool does | Module graph |
| 13 | **Raw `tx.createSubmission()`**, with no admission rules | Only if called | Never | Module graph |
| 14 | **Recovery at open** (`resume()`) resumes live tasks: a generation goes on in its own run, and compaction (1), reporter (11) and after-run (5) tasks resume with their effects | Always | Covered by pinning 1, 5 and 11, plus the sweep in row 1 | Kills at every commit with a message queued behind a failure: no run starts at open |
| 15 | **Wakeups** (`parkUntil`, `onWake`): pi-durable runs the woken phase and starts nothing itself | Familiar's own | The reminder line is display-only (row 10) | Row 10's test, and turn-design's `wake-delivery` kill test |
| 16 | **Generation retry and deferred poll**: the same run resends its model request, with no new run and no boundary | Yes | Errors are hex-coded, so only a cut-off request is resent, which is intended ([turn-design.md](turn-design.md#the-journal-facade)). Model requests only, never MCP | None needed for P2 |
| 17 | **Conversation and submission abort**: withdraws queued inputs, starts nothing | Only if called | Never. Stop is `abortTask` | Module graph for `.abort(` on a conversation or submission handle. This is what makes 2.4's "nothing else can move the item" true |
| 18 | **Queue modes** (`followUpMode`, `steeringMode`): `all` places every item at once | No (`one-at-a-time`) | Left at the default | A settings test, so "the oldest first" (2.3, 2.4) stays true |

**The submit call sites.** Only these submit, and none of the run-starting ones submits from a callback, a timer, a run's ending or an open:

- run-starting or queueing: `send`, `answer` and Send now;
- her line, which never starts a run (2.1);
- two display-only writes:
  - the gate's bound notice, a `familiar.notice` written from inside the tool call;
  - the reminder line, a `familiar.reminder` written by the wake task on its timer.

A display-only write is appended at once, busy or idle, and starts nothing. The module-graph test fails on any other call site, and on `compact`, `reset`, `handoff`, `terminate`, `createSubmission`, a conversation or submission abort, `configure`, a steer, `afterRun` or `onYield` anywhere in core. The open-time sweep of row 1 is needed: without it, a compaction task persisted before the pin places queued input even under `backgroundTokens: 0`.

**An upgrade of pi-durable** must recheck this table against the new spec before the pin moves. It's a list of a dependency's own behaviours, and only the pinned version has been read.

### 2.6 What changes in step 5's code

| Part | Before ([turn-design.md](turn-design.md)) | Now |
| --- | --- | --- |
| Turn registry, questions | A pause or the step cap records its question when the run ends. Open questions are stored per turn | Removed. Questions come from the view in 2.2. The registry keeps budgets, each submission's id and turn (written in its admission commit), the interruption records and the answer records |
| Turn registry, "finished" | A turn is marked finished when its run ends with no question, or on a No | The mark stays as a hint for display and for the 64-turn limit. Anything that must not lose a resumable turn decides "resumable" live, in its own commit: from `pi.live` (the run, `runFailure` and its input ids mapped to turns), each of the turn's submissions read with `tx.submission(id)` (any still `queued`), and the consent document (an open card) |
| Ledger fold | Reads which turns can resume from the registry | Reads the live facts above in the same commit. A turn with an open question, a card, a queued submission or a call in flight is never folded. Queued submissions are read one by one with `tx.submission(id)`, never from a view of the inbox, since a Run again input belongs to the old turn and such a view could miss it |
| Presence | `waiting` from the consent and question documents | `waiting` from the consent document and the view in 2.2; `error` from the view's error row |
| `answer` | One commit with an in-commit check | The same, plus the reads in 2.3 |
| The parked-interruption gate | Refuses another call of a tool waiting on Run again, from the question document | Refuses it while the view shows the interruption open, or after a Skip recorded in this turn |
| The cap read-back | The journal reads the pause back after the run ends and records a `cap` question | Removed. The view decodes `runFailure` |
| Send now | Not present | 2.4, one action for the queue |
| Writes | The reminder line, `familiar.ack`, `familiar.notice` | Each confirmed display-only by test (2.5, row 10) |

Step 5's tests run again on this: the kill tests, the person tests, the bounds and caps property tests, and the turn registry tests. The tests that asserted "record the question at the end" now assert the view. Recording the question after the run ends, the old shape, is a named mutation that must fail H6 and H7 (7.2).

### 2.7 The recovered-run gate

pi-durable 1.5.2 can't give a recovered run its own tools: there's one tool registry per harness, resolved against a fresh snapshot each phase. So:

1. Before `resume()`, while nothing runs, core reads `pi.live`. If a run is live, it notes that run's identity in memory: `run.inputs[0]`, else `run.first`. `run.inputs[0]` is stable across a run's generations.
2. The gate refuses every server call while the current run has that identity: "This turn was resumed after a restart, so server tools aren't used in it. They work again from your next message."
3. The gate sits first after the bounds, in `beforeTool` and again in `execute`, before any decision is minted. It never waits.
4. Server calls whose intent was committed stay `interrupted`.

Nothing is recorded durably, so there's no commit to keep in step. The identity is noted before any task can run.

## 3. The client

### 3.1 Shape

One client module runs in the core window. It doesn't use an MCP SDK: `tests/mcp/bundle.test.ts` bundles it for the browser and fails on any Node built-in or any `@modelcontextprotocol` module, and `tests/mcp/no-eval.test.ts` runs it with code generation from strings off, as under the app's CSP.

**For each server** (by server id, across its runs) the link holds the **exchange slot**: the current exchange, or none. The slot outlives a run. A Stop ends the run, but a Start of the same server is refused busy until the old run's exchange has drained, because a remote Stop has no native exit to wait for. **For each server run** (one Start to one end) it holds:

- the run id from the exe;
- the era, legacy or modern, decided once at the run's start (3.3) and never changed;
- the negotiated protocol version;
- the session id, for a remote server that gave one;
- the catalog, and its stale bit;
- the closed mark, set by Stop (3.4).

There's no queue, no second exchange, and no timer that isn't an exchange's own.

The client's surface toward the wire:

- `start(run)` and `stop(run)`, called by the runtime lifecycle (5.4);
- `list(run)`, called at start, on Test, and on a legacy run whenever `list_changed` has set the stale bit: after the call whose stream carried it, or at once if it arrived while the slot was Idle (a local server can send it unprompted). Otherwise a stale catalog would refuse every call until Stop and Start;
- `send(decision, signal)`, the only way a tool call reaches a server (3.6).

T1 fixes the export list.

### 3.2 Framing and ids

- **JSON-RPC 2.0.** Every message Familiar sends is one of these kinds:
  - an `initialize` request;
  - a `notifications/initialized` notification;
  - a `tools/list` request, with an optional cursor;
  - a `tools/call` request;
  - a result response with an empty result, answering a `ping` (a **pong**);
  - for local servers only, `notifications/cancelled` for that run's own call (3.9).

  No other message can be built: the serializer (`wire/framing.ts`) takes a tagged union of these kinds and nothing else.
- **The era decides which kinds a run may build.** The serializer takes the run's era and refuses any kind outside it:
  - **legacy:** all six;
  - **modern:** only `tools/list`, `tools/call` and, for local servers, `notifications/cancelled`. The modern era has no handshake and no ping.

  Every modern request also carries, in `params._meta`: `io.modelcontextprotocol/protocolVersion: "2026-07-28"` and `io.modelcontextprotocol/clientCapabilities: {}` (both required), and `io.modelcontextprotocol/clientInfo`, Familiar's name and version.
- **Ids are Familiar's**: a counter per run, never reused. A response whose id isn't the current exchange's request id, or a ping id it's still answering, is dropped.
- **Inbound messages:**
  - a response for the current request ends the exchange's wait (3.4);
  - a `ping` request is answered (3.7);
  - any other request gets no reply. A server sending one is out of spec: Familiar declares no capabilities, so it has no sampling, elicitation or roots to serve;
  - `notifications/tools/list_changed` sets the stale bit;
  - progress, log and other notifications are ignored;
  - anything that isn't valid JSON-RPC, or breaks its kind's shape contract, fails the exchange (3.10).

### 3.3 The handshake: legacy first, modern on refusal

**Why legacy first.** Every modern-capable reference server also serves the legacy handshake by default. One narrowed to modern only answers `initialize` with `-32022`, naming its versions: the TypeScript SDK's servers and rmcp's do this. go-sdk and mcp-go never refuse a legacy `initialize`, so Familiar always runs them legacy. Probing first with `server/discover` would risk stdio servers that exit on any request before `initialize`.

**A legacy start** is three steps, each its own exchange, one after another:

1. **`initialize`.** Familiar offers protocol version 2025-11-25, and accepts exactly the five legacy versions, as a discrete list: 2024-10-07, 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25. Any other string is unsupported; there's no range comparison. It sends `capabilities: {}` and its `clientInfo`. The response must carry a supported version, server capabilities with `tools`, and `serverInfo`. On a remote server the session id comes from this response's `Mcp-Session-Id` header, and only this one, validated as in 3.8.
2. **`notifications/initialized`.** Sent only after step 1's exchange has fully cleaned up. It completes as a write-only exchange (3.4): at its `202` head on remote, at write completion locally.
3. **The tool list** (3.5).

The whole start runs under the handshake deadline. Its end is `server_stop` for a local server, or the run's end for a remote one.

**The opening's classifier.** The `initialize` exchange's answer is classified in this order, before any HTTP status rule:

1. **If the answer is at most 64 KiB and carries a JSON-RPC error response for this request's id, its code decides,** whatever the HTTP status: 200, 400 or another 4xx. It's read by media type: `application/json` is one body, and `text/event-stream` goes through the event-stream parser (3.10), which skips an empty priming event. The same `-32022` arrives four ways from real servers: as HTTP 400 JSON (the TypeScript SDK), and as 200 JSON, as a 200 event stream, and as a 200 event stream with a priming event and the id of a session already closed (rmcp). **No session id is adopted from a refused handshake** (3.8).
2. **Otherwise the HTTP status decides**, as for any exchange (3.8).

T14 replays each of those recorded refusals.

**A modern start.** If that answer is a JSON-RPC error `-32022` whose `data.supported` lists `2026-07-28` and no legacy version Familiar speaks, the run's era becomes modern. That's decided in the same synchronous step that ends the `initialize` exchange. There's no new exchange: it's the same `initialize`, classified differently. The start then goes straight to the tool list (3.5), with the modern framing:

- **no `server/discover`:** servers must implement it, but clients may skip it, and the catalog comes from `tools/list` anyway;
- **no `notifications/initialized`;**
- **no corrective `-32022` continuation:** Familiar offers exactly one modern version, so a correction could only repeat it.

**Only a run's opening decides its era.** A re-handshake after a dropped session (3.8) never changes it: a `-32022` there ends the run, and Start opens a new one.

**A start that fails:** any other `-32022` (a list with neither a legacy version Familiar speaks nor `2026-07-28`), a malformed `data.supported`, or a modern `tools/list` answered `-32022` (the server changed its mind). The start fails with the server's own list in words: "This server speaks MCP 2030-01-01 only; Familiar speaks 2024-11-05 to 2026-07-28".

There's no automatic list refresh in either era.

### 3.4 The exchange loop and its cleanup barrier

An **exchange** is one request Familiar sends, plus every pong it sends for pings that arrived on it. The exchange owns every native request it makes:

- remote: the request's POST, plus one POST per pong;
- local: the request's write, plus one write per pong, plus a call's cancel write (3.9).

The machine is a pure function (`wire/exchange.ts`): the state and one input give the next state and the effects to do. The link does the effects and feeds back what the natives answer.

| State | Means | Leaves on |
| --- | --- | --- |
| Idle | No exchange | A start, a list or a call admitted, or a local idle ping (3.7) |
| Live | Request handed off, waiting for it to complete | Its completion (below); any terminal path (3.11) |
| Draining | Ended: no more sends of any kind; cleanup in progress | Every native request it owns has terminated |

**Completion, per exchange kind.** A write-only exchange has no response to wait for:

| Kind | Remote completes at | Local completes at |
| --- | --- | --- |
| `initialize`, `tools/list`, `tools/call` | Its JSON-RPC response | Its JSON-RPC response |
| `notifications/initialized` | Its `202` head | Its write's completion |
| A pong as its own exchange (a local idle ping) | Not applicable: remote pongs belong to their request's exchange | Its write's completion |

**Every exchange runs the same steps:**

1. **Admit**, from Idle only, and only for a run that isn't closed. Anything else is answered busy at once, with no queue.
2. **Hand off the request**, in one synchronous step (3.6, or the same function without a decision for an administrative request).
3. **Wait in Live.**
4. **The first terminal event moves the exchange to Draining, synchronously.** That step makes its own last sends, then seals the exchange. For a local call ended by Stop or its time limit, that last send is the `notifications/cancelled` write. After the seal no further send is possible: the serializer checks the state, and the state changed in the same step. On remote, `net_cancel` is then called for the request's POST, after its response has been read whole. A pong already handed off stays outstanding until its native end: it's left to reach its head, within its own 5 s bounds, and then cancelled, so a pong sent just before the final response still reaches the server (3.7).
5. **Back to Idle** only when every `net_cancel` has returned (remote), or every write has completed or the run has ended (local).

**The closed mark at Stop.** `stop()` marks the run closed synchronously, before any await, for local and remote servers alike, and in the same step ends the run's live exchange ("interrupted"). A local Stop then waits for the exe and the exit, and in that window nothing reaches the stopping server: every admission path (a walk's next page, a handshake step, `send`, an idle ping's pong) refuses a closed run, and the ended exchange sends no pong and takes no reply. Its writes still end only at the exit. A Stop that comes while the exe is still starting a local server is met when the start returns: the process it started is stopped, and its exit awaited, before the start answers, so the next Start meets no orphan.

**Cleanup the exe refused.** A refused `net_cancel` is tried again 1, 2 and 4 s later; after that the run ends ("Familiar couldn't end a request to the server. Restart Familiar to use it again."), and the request stays counted. The slot is then held for good: every later Start and Stop answers with those words, and an exchange waiting for the slot (a start parked between its handshake's steps) stops waiting at once with them. A refused `server_stop` releases nothing. The slot never frees on cleanup the exe didn't confirm.

**The barrier.** The next exchange starts only from Idle. So a server never has two exchanges' native requests open at once. That holds for pages, handshake steps, calls, and a Stop followed by a Start, cleanup included. At most 3 native requests are ever open per remote server (the request and two pongs), and at most 4 per local server, counting a Stop's cancel write beside them. The barrier's bound is on native lifetimes: each request or write ends within its native bound. How long a server takes to answer is the call's own time limit, not the barrier's.

**Why it holds by construction:** there's one exchange variable per server, kept across a Stop and a Start; the Idle check and the admission are one synchronous step; and the only way back to Idle is through the barrier. P4 bounds how long the barrier can take, and 4.3 names the interim before the native pass.

### 3.5 Pages

`list(run)` is a walk of `tools/list` exchanges:

- each page passes the previous page's `nextCursor`;
- each page is its own exchange, and goes through the barrier;
- the walk takes at most 16 pages; a 17th `nextCursor` fails the list;
- it has a 30 s deadline over the whole walk, besides each page's native bounds;
- the catalog's bounds apply before any hashing (`catalog.ts`): at most 128 tools, each input schema at most 32 levels deep and 4,000 parts, at most 64 KiB per tool and 1 MiB for the whole list, and every name once. The walk over a schema is iterative and stops at the first bound;
- **on a modern remote run**, each tool's `inputSchema` is scanned for `x-mcp-header` declarations, following the TypeScript SDK's scanner exactly:
  - **Where a declaration may sit:** only on a property reached from the root by a chain of `properties` keys.
  - **Where it may not:** anywhere under `items`, `additionalProperties`, `oneOf`, `anyOf`, `allOf`, `not`, `if`, `then`, `else`, `$defs` or a `$ref` target, or at the root. A declaration found there makes the tool invalid.
  - **A `$ref` names a node, however it's written, wherever it sits.** The walk for refs is generic: every keyword's value is a schema position (an object, each element of an array, and a boolean schema too), whatever the keyword, draft-07's tuple `items`, `additionalItems` and `dependencies` and keywords Familiar has no name for included; only data (`default`, `examples`, `const`, `enum`) is skipped, and the maps of schemas (`properties` and the like) are walked by name, so a property called `default` is still a schema. A pointer fragment is percent-decoded and unescaped, and a plain-name fragment is looked up among the `$anchor`s. Whatever Familiar can't scope makes the tool invalid, closed: another document, an unknown anchor, a pointer to no schema, a dynamic ref, a `$ref` that isn't a string, and a nested `$id` (or draft-04 `id`), which opens a resource of its own. The targets go in a set, and each declaration looks up its own node and its ancestors, so the check is linear.
  - **Its value:** a non-empty string that's a valid RFC 9110 token, unique case-insensitively within the tool.
  - **Its type:** the property's `type` must be `string`, `integer` or `boolean`. A `number`, any other type, or none makes the tool invalid.

  An invalid tool is not offered, and Test lists it with the scanner's reason, cut to 200 characters. Each declaration found is kept with the tool (its path, its header name and its type), and the declarations are part of the tool's fingerprint, since they change what goes on the wire. They enter it sorted by path, then header name, so the order a schema's keys came in changes nothing. On stdio nothing is mirrored, so nothing is scanned;
- modern `tools/list` results also carry `ttlMs` and `cacheScope`. Both are read leniently and ignored: the catalog's refresh points are Familiar's (start, Test).

Every listed tool counts toward the 128 before any is kept, across pages, and every bound (names, shape, bytes, the whole list) is checked over all of them, offered or not, before the modern scan. Anything thrown while reading a start, a refresh or a recovery ends the run in words; nothing a server sends can throw out of them.

**`list_changed` during a walk.** Each run counts the `list_changed` notifications it reads. A walk publishes its catalog only if none came while it ran; otherwise it walks again from the first page, within the same deadline, and after three tries fails rather than keep a catalog Familiar knows is stale. A notification on a Ready run schedules one walk after the exchange that carried it, so a burst is one more walk.

While a walk runs, the run's catalog is stale and calls are refused busy. How a walk ends:

- **at start:** a failed walk fails the start;
- **later:** a failed walk ends the run, and the server goes to Failed with the reason, so no call ever meets a catalog it couldn't refresh;
- **Test:** Test's own walk runs only while the server is Stopped (5.4).

### 3.6 Calls, and the handoff as one synchronous function

`send(decision, signal)` takes a `ToolDecision` (5.5) and the call's abort signal. In one synchronous function, with no `await` anywhere in it, it:

1. **refuses** unless:
   - the decision is genuine (in the module-private `WeakSet`), unused and not aborted;
   - its server's run is Ready and not closed, with the run and launch the decision was minted for;
   - the catalog isn't stale, and it offers that tool with the decision's fingerprint;
   - the choice in the owner's memory, with the revoke overlay applied, still allows it: from "may run on its own", that grant still saved for these fingerprints and not revoked; from a yes, not "never";
   - the exchange slot is Idle;
2. **marks the decision used**;
3. **builds the body** from the decision itself: the tool's own name, and the arguments in the canonical form the card and the hash used (5.5). Nothing about the body comes from anywhere else;
4. **on a modern remote run, builds the headers** from the same decision:
   - `MCP-Protocol-Version: 2026-07-28`;
   - `Mcp-Method: tools/call`;
   - `Mcp-Name`, the tool's own name;
   - one `Mcp-Param-{Name}` per declaration, from the decision's own arguments at the declaration's path. The codec follows the TypeScript SDK's exactly:
     - **Omitted:** an absent or `null` value gets no header.
     - **Converted:** a string passes through; a boolean becomes `true` or `false`; an integer becomes its decimal string.
     - **Refused before the handoff** (rather than omitted, so the server never meets a body without its header): a value that isn't a primitive of the declared type, a non-finite number, an integer outside the safe range, or a string that isn't well-formed UTF-16. A lone surrogate would become U+FFFD in UTF-8, so the header and the body would disagree.
     - **Encoded:** the plain value when it's visible ASCII, space or interior tab, with no leading or trailing whitespace. Otherwise, an empty string and a value that already looks like the sentinel included, the `=?base64?…?=` sentinel over its UTF-8.

   A refused value, a mirrored header longer than `net_fetch`'s 8 KiB per header, or more than its 64 headers in all, refuses the call before the handoff: "This call's arguments can't be sent to this server's headers". Nothing is truncated;
5. **opens the exchange** in Live, and calls `net_fetch` (remote) or `server_write` (local).

The native call is the start of a Tauri `invoke`, and everything before it is synchronous. So between the last check and the handoff nothing can run: no revoke, no Stop, no catalog change. There's no token to carry through someone else's awaits, and no second place a `tools/call` could be built: the serializer's `tools/call` constructor is private to `send`.

On the call's response, the result goes to the journal's tool `execute`. The exchange drains through the barrier, and the slot frees on its own.

The call's time limit, and stopping the call, abort its signal. That's a terminal path (3.11): the exchange drains, and the call is answered "timed out (or stopped); it may have partly run". The journal never runs a server tool again on its own. The session and the run stay, so the next call uses them as they are. Stopping the server is different: it ends the run, and a call in flight is answered "interrupted, it may have partly run".

### 3.7 Pings, pongs and floods

Legacy servers may ping on any request's stream, and the spec says the receiver must respond promptly with an empty response.

**A modern run has no pings.** 2026-07-28 removed `ping`, and a modern peer answers it `-32601`. A `ping`, or any other inbound request, on a modern run's stream gets no reply. That isn't a departure, since the requirement is the legacy era's. No pong can be built on a modern run (3.2), and the rest of this section is about legacy runs.

- **A ping arriving on the current exchange's stream is answered by that exchange**, each id once. The pong is handed off synchronously by the parser, which reads messages in order, in the same step that reads the ping. So a ping that arrives with the final reply, in the same chunk and ahead of it, is answered before the reply ends the exchange, and its pong is left to reach its head (3.4). A handler run later, in a microtask, would run after the exchange had ended and lose that ping.
- **Up to 2 pongs outstanding, and up to 32 in all per exchange.** A pong counts as outstanding until its native end, not only until its head. Each has its own 5 s native bounds, and its body is never read, so it's cancelled at its head.
- **A third concurrent ping, or a 33rd in all, ends the exchange** with "the server sent too many pings". **Named departure 1:** that ping gets no answer. It keeps the work bounded: one exchange makes at most 33 native requests, at most 3 at once. A normal server that pings every 30 s through a 15-minute call sends 30.
- **A local ping with no live exchange** (a local server may ping while idle) is answered as an exchange of its own: one write, through the barrier.
- **Named departure 2:** a local ping that arrives while the exchange is Draining, or while a write is blocked, gets no pong. A blocked writer means the server stopped reading, and the exe's write bound ends that run within 10 s anyway (section 4).
- **Named departure 5:** a ping that comes after the final response on the same stream gets no pong. The parser stops at the final response and discards the rest of its chunk, and the stream is cancelled. A server should end the stream after its response, and the request has completed, so nothing waits on that ping.
- **Named departure 6:** a pong handed off in time can still be lost to its own native failure: a stalled credential read or lookup, its 5 s timeout, or `busy` from the exe's server cap (section 4). Familiar promises a timely handoff of each pong. What the network then does to it is logged, not promised.
- **A pong is a result response**, built by Familiar's code for an id it read as a `ping` on this exchange. Error replies are never built, so none can be sent.

Departures 3 and 4 are about remote cancellation and sessions (3.8).

### 3.8 Remote specifics (Streamable HTTP, legacy era)

- **Every request is one POST** through the guarded fetch ([shell-design.md](shell-design.md#5c-the-guarded-fetch)) to the server's saved address, carrying:
  - `Content-Type: application/json`;
  - `Accept: application/json, text/event-stream`;
  - after `initialize`, `MCP-Protocol-Version` set to the negotiated version;
  - `Mcp-Session-Id` if the server gave one. It's adopted only from a successful `initialize` response, never from a refused one, as exactly one header value of visible ASCII (0x21 to 0x7E), at most 1 KiB. Anything else fails the start: "the server sent a session id Familiar can't use";
  - the setup's own headers (reserved names refused, 5.7). The key goes only in one of the four swap headers, as the placeholder the exe swaps.
- **A response is read one of two ways, and only these:**
  - `application/json`: one JSON-RPC message, decoded as one text across reads;
  - `text/event-stream`: events whose data are JSON-RPC messages. Event ids and `retry:` fields are ignored, and an event with empty data (a priming event) is skipped, never a failure.

  The type is matched exactly: the part before any parameters, trimmed and compared without case. A lookalike (`application/jsonp`, `application/json-seq`, `text/event-streaming`) is another type, and any other type is refused, in Familiar's own words ("an answer of a type Familiar doesn't read"), with none of the header's text. A status other than 2xx decides on both types alike (after the opening's classifier, 3.3).
- **A notification or a pong** is answered `202` with no body. Its exchange ends at the head.
- **Never sent:** a GET of any kind (no standalone stream, no resumption, no `Last-Event-ID`), a `DELETE`, or `notifications/cancelled`. Not opening the GET and not resuming are both allowed by the 2025-11-25 transport.
- **Named departures 3 and 4:** the transport says a client should send `notifications/cancelled` to cancel, and a session `DELETE` on close. Familiar sends neither to a remote server. A legacy server may therefore finish a call Familiar stopped, and its session expires on its own. The journal already reports every stopped call as possibly partly run, and never repeats it.
- **A stream that ends before its response** is a terminal path: "the server ended the reply". The call is reported "interrupted, it may have partly run".
- **A 404 on a request that carried `Mcp-Session-Id` means the server ended the session.** The spec says the client must then start a new session with a fresh `initialize`, and servers do expire idle sessions. So:
  1. **The 404 ends that exchange** as a terminal path. If it was a call, the call becomes a tool error, "the server had ended its session", and is **never resent**: its decision is used, and a card call needs a new card. A page fails its walk, and the catalog stays stale.
  2. **The next exchange is a re-handshake.** The `initialize` POST carries no session id. The new session id from its response, validated as above, goes on `notifications/initialized` and every request after it. Then the tool list is read again. Each step is its own exchange through the barrier, under the handshake deadline. The run isn't Ready meanwhile, so calls are refused busy, as during any start.
  3. **The bound.** If the re-handshake fails, or a request gets a 404 before one exchange has completed after the recovery, the run fails: Failed, "the server ended its session", and you press Start. The bound rearms at the first page or call made after the recovery (not the re-handshake's own walk) that completes without a 404. So a server that drops its session on every call gets one re-handshake, never two in a row, and one that drops it again an hour later gets a fresh one. A refresh page's 404 is recovered the same way, not ended. A re-handshake answered with a modern refusal ends the run (3.3).
  4. **Only a Live exchange's own request counts.** A 404 on a pong, or on any request after its exchange's terminal event, schedules nothing.
  5. **It isn't a restart.** Nothing is respawned. The run, its run id and its admission stay. Local servers have no sessions and are unaffected.
- **A redirect is refused.** After the native pass, `net_fetch` never follows a redirect for a `server`-kind address, and a 3xx ends the request with its status (4.4). As a second line, the client fails any exchange whose response head says `redirected: true`, with "the server redirected Familiar's request".
- **HTTP errors** (4xx, 5xx, `401`, `403`) fail the exchange with their status in words. The opening's classifier (3.3) reads a JSON-RPC error body first. There's no sign-in flow, since OAuth isn't in part 1. **What's given up:** a pushed `list_changed` on the GET stream. The catalog refreshes at start, on Test, and after a call's stream carries `list_changed`.

### 3.8b Remote specifics, modern era (2026-07-28)

The same POST through the guarded fetch, with these differences:

- **Headers:**
  - `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method` on every request, plus `Mcp-Name` and the `Mcp-Param-*` headers on `tools/call`;
  - for `tools/list`, the headers are built by the same function that builds the body, with no decision;
  - no `Mcp-Session-Id`, ever: the modern era has no sessions, and its servers answer `GET` and `DELETE` with `405`.

  The three standard headers are required on every modern POST, and a missing or mismatched one gets `400` with `-32020`.
- **Cancel is the spec's own:** closing the request's stream. Aborting the POST is exactly that, so departure 3 doesn't apply on modern runs. Nor does departure 4: there's no session to delete.
- **A `400` whose body is a JSON-RPC error** for the request's id is read as that error. `-32020` (a header mismatch) and `-32021` (a capability Familiar didn't declare) become tool errors in words, with **no retry**. A retry would be a send Familiar's caller didn't start.
- **No session to lose,** so the 404 rule doesn't apply. A modern request answered `-32022` ends the run, with the server's list in words.
- **Never sent on modern:** `initialize` after the opening, `notifications/initialized`, pongs, `notifications/cancelled`, any GET, any `DELETE`, `server/discover` and `subscriptions/listen`.
- **Known limitation:** `list_changed` reaches a modern client only through `subscriptions/listen`, a long-lived request. Familiar doesn't open it: it would be an exchange that never ends, holding the server's one slot. So on a modern server the catalog refreshes only at start and on Test. The handoff's fingerprint check (3.6) compares the decision with Familiar's own catalog, so it can't see a change the server made in between: such a call goes out as you consented to it, against the tool as last listed. A legacy server has the same exposure between `list_changed` notifications (section 8).

### 3.9 Local specifics (stdio)

- **A request is one `server_write`** of the message plus a newline, at most 4 MiB. Responses arrive as `out` lines on the run's channel, which the exe caps at 4 MiB and blanks of the setup's secrets before they leave Rust ([shell-design.md](shell-design.md#5b-starting-a-local-mcp-server)).
- **An exchange's request write**, any pong writes and a call's cancel write are all owned by that exchange. They go through the one writer the exe keeps per server. Because the barrier admits one exchange at a time, nothing of a next exchange can queue behind a blocked write.
- **A local call that's stopped or times out** sends `notifications/cancelled` for its id, as the spec advises, as the terminal step's last send, made before the exchange is sealed (3.4). The exchange drains once that write completes or the run ends. A late response to the cancelled id is dropped by id.
- **The write bound is the exe's** (section 4). A write pending past 10 s ends the job, and the run goes to Failed with "It stopped reading what Familiar sent".
- **A run that ends ends its process.** A local run that ends for any reason, a reported one included, stops its process, and its pending writes end at the exit.
- **stderr lines**, and stray stdout lines (3.10), are kept for the server's last output: the last 40 lines, at most 16 KiB counted in UTF-8 bytes. Text cut to a bound (an error message, a line) is cut by character, never inside one.
- **A modern stdio run** uses the same `_meta` envelope, with no headers and no mirroring. It keeps the `notifications/cancelled` write, which stdio sends in either era. There are no pings.
  - **A modern refusal on stdio takes one of two paths, chosen at run time.** Some servers keep the pipe after refusing and serve modern requests on it (the TypeScript SDK's `serveStdio`); others exit before their loop (an rmcp stdio binary). So after a modern refusal the client goes on to `tools/list`:
    - **If the answer comes,** the run goes on. An answer that refuses (a `-32022`, or any JSON-RPC error) is the server's word: the start fails, with no relaunch, even if the process exits after it.
    - **If the run's `exit` arrives first,** with no answer to the list (a refused write, a closed pipe), the start makes one relaunch. A write refused before the exit is reported waits for the exit, within 2 s and the start's deadline. Only an actual exit counts: a run Familiar ended itself (the write bound) gets no relaunch. The relaunch has the era fixed to modern for that one start. The second `server_start` is readmitted through the owner (5.1), like any start: it rechecks the committed launch and the enabled flag in the admission step; if another durable effect is in flight it fails "busy", and you press Start; an approved setup with an unchanged form starts with no dialog.

    It's never a restart after a crash, and the era isn't saved: the next Start begins legacy-first again.

### 3.10 Validating untrusted answers

A server's answers are untrusted. The parser (`wire/parse.ts`) checks them before anything reaches the exchange, the journal or a card:

- **Size:** 4 MiB for a call's or a page's response, and 64 KiB for a handshake's, with `net_fetch`'s own caps underneath. The same per event-stream event, and the exe's 4 MiB line cap locally. A larger one fails the exchange.
- **Shape, per message kind.** Every message must be valid JSON, nested at most 64 deep, an object with `jsonrpc: "2.0"`. Then by kind:
  - **a response:** an `id` equal to an id this exchange is waiting on, and exactly one of `result` or `error`. `error.code` must be an integer, and `error.message` is a string, cut to 1 KiB;
  - **a request:** a `method` string of at most 128 bytes, an `id` that's a string of at most 128 bytes or a safe integer, and `params` an object if present;
  - **a notification:** a `method` string of at most 128 bytes, no `id`, and `params` an object if present.

  Anything else fails the exchange.
- **A local stdout line that doesn't start with `{`** can't be a JSON-RPC message, so it's kept as the server's output (some servers print banners), not failed. A line that starts with `{` and doesn't parse fails its exchange.
- **Text across reads:** a character split across reads comes out whole (one decoder per body), and a CR that ends a read ends its line at once, an LF right after it being its pair, not an empty line.
- **The event stream:** an event may span any number of reads, and is assembled up to 4 MiB; its `data:` lines are joined with newlines; a comment, or an event with empty data, is ignored; the events of one exchange total at most 8 MiB, notifications included. Past either bound, the exchange fails.
- **A local line the exe dropped** for being over 4 MiB arrives as an `err` event. While an exchange is Live, it fails that exchange ("the server sent a line too long") instead of leaving it to its time limit.
- **`initialize`:** a supported `protocolVersion`, `capabilities.tools` present, and `serverInfo.name` a string. A local server's answer has the handshake's 64 KiB bound too.
- **`tools/list`:** `tools` an array within the catalog's bounds, each with a valid name, an object `inputSchema`, and an optional description, title and annotations. `nextCursor` a string of at most 1 KiB.
- **`tools/call`:** `content` is an array, each item checked by its variant:
  - `text`: a string;
  - `image` and `audio`: `data` a base64 string (whole quads, with the padding its length requires) and `mimeType` a string;
  - `resource_link`: `uri` and `name` strings;
  - `resource`: a `resource` with a `uri`, and `text` or a base64 `blob`.

  Each item must be within the size bound. An unknown kind becomes a text line, "unsupported content". `isError` is a boolean. `structuredContent` is an object, passed on as untrusted JSON, and **isn't validated against the tool's `outputSchema`** (section 8). When a result has content items, `structuredContent` isn't passed to the model at all: the model reads the content.
- **Words from a server** are shown without converting its values by their own methods, and cut at characters, never inside a surrogate pair.
- **Modern results:**
  - `resultType` is required. `"complete"` is a result. `"input_required"` becomes a tool error ("the server asked for input Familiar can't give"): Familiar declares no capabilities, so a conforming server shouldn't ask. Any other value is a tool error too, and a missing `resultType` is a protocol violation;
  - tool results must carry `content` explicitly;
  - `ttlMs`, `cacheScope` and `_meta`'s `io.modelcontextprotocol/serverInfo` are tolerated and ignored;
  - no retry of any kind follows a modern result. `requestState` and `inputRequests` are never echoed back.
- Unknown fields are ignored, never trusted. Nothing from a server becomes a header, a URL or a request id, except the validated session id (3.8).

### 3.11 Terminal paths

Each of these moves the exchange to Draining in one synchronous step, and each is a check in the harness (H2, 7.2):

| Path | Answer to the caller |
| --- | --- |
| The response, a result or a JSON-RPC error | The result, or the error in words |
| The call's time limit, or the call stopped (its signal) | "Timed out (or stopped); it may have partly run" |
| The list's 30 s, or the handshake deadline | The list or the start fails |
| The stream ended before the response | "The server ended the reply" (interrupted) |
| A flood of pings | "The server sent too many pings" |
| An invalid answer (3.10) | "The server sent something Familiar couldn't read" |
| A native error (`timeout`, `network`, `busy`, `revoked`, …) | The kind in words |
| A 3xx, or a head that says `redirected` | "The server redirected Familiar's request" |
| A local line dropped as too long (`err` event) | "The server sent a line too long" |
| A 404 on a request with a session id (legacy remote) | For a call: "the server had ended its session", never resent. Then one re-handshake (3.8) |
| The run ends: Stop (the closed mark), a crash, an exit, removal, a failed re-handshake, a second 404 | "Interrupted, it may have partly run" for a call |
| Modern: `input_required`, an unknown `resultType`, `-32020`, `-32021` | A tool error in words, no retry |
| Modern: `-32022` on a later request | The run ends, with the server's versions in words |
| A mirrored value refused, or a header too long (refused before the handoff, so no exchange opens) | "This call's arguments can't be sent to this server's headers" |

## 4. The exe

### 4.1 P4's three bounds (pre-release native pass)

1. **Helpers are detached at a bound.** Today `net_cancel` and a removal return only once every helper the request started has finished, so a hung lookup or credential read holds the request.
   - **The change:** `net_cancel` returns within 1 s of the cancel, and the Resolving step's 20 s deadline ends the request whatever its helpers do. A helper still running then is detached: its result is discarded, it's counted, and it can start nothing more.
   - **Detached helpers count against their own request's share, and only that share.** A helper detached from a `server`-kind request keeps one place in the server share (item 2) until it finishes. Past 8 detached server helpers, new server fetches get `busy`, and model fetches are untouched. A helper detached from a model request counts against the model share the same way. So hung lookups on servers can never eat into chat's reservation.
   - **The guarantee becomes** "nothing of the request is sent after the cancel returns, except a DNS query already in the system's resolver". A credential read already started may finish into a dropped task.
   - Runner check `net.helper-detach`: a lookup held forever, then `net_cancel` returns within its bound, and a model fetch then succeeds.
2. **Chat's share is reserved.** Today the 32 open requests are shared by everyone.
   - **The change:** requests to `server`-kind addresses get their own cap of 24 within the 32. Every request counts until its task has terminated or been detached. So a model fetch always has at least 8. That's against server load only: chat's own fetches (her line, the decider's bigger model, the turn) can still fill those 8 themselves (section 8).
   - Runner check `net.server-cap`: with 24 server requests held, a model fetch succeeds and the 25th server request is `busy`. With 8 server helpers detached and hung, plus 16 server requests open, a model fetch still succeeds.
3. **The local write bound lives in the exe.**
   - **The change:** the writer thread notes when its oldest pending write began. Past 10 s the actor ends the job, which breaks the write, and the run's `exit` event carries `stalled-write`.
   - It holds after the page has gone, with no dependence on the exe noticing the renderer's exit. The page's own 10 s timer goes: one owner.
   - Runner check `server.write-bound`: a full pipe, then the core renderer killed, and the job ends within 11 s. Its control holds the renderer-exit relaunch back (a runner-only switch), and the check requires `stalled-write` as the `exit` event's cause. Without that, the relaunch would end the job anyway, and the control would pass for the wrong reason.

### 4.2 Other native items

- **On a second `shell_ready`, or when the core renderer goes away**, the exe ends every server job, then exits and relaunches itself, with its runner check. Renderer-exit detection still matters for the relaunch; it no longer carries the local write bound.
- **`totalMs` and `idleMs` run on shell-core's request task**, independent of `net_read` pulls, with `totalMs` a new option every MCP request sets to its whole deadline.
  - **Its runner check, `net.total-deadline`, isn't a reload.** A reload triggers the relaunch, which would end the request first and let the control pass for the wrong reason. Instead the runner calls `net_fetch` directly with `totalMs` 5 s; a server trickles a chunk every 2 s, inside `idleMs`; nobody calls `net_read`, the page sets no timer, and the exe stays alive for 15 s.
  - **What it records** is the event that ended the request. It must be the request task's `timeout`, at 5 s plus at most 1 s. The control omits `totalMs`: the request must still be open at 15 s, and the check fails if anything else ended it.
- **`address_add` answers whether it created the address** (a `created` flag), so a rollback removes only what its own add made (5.1).
- **`notify_state`**, for step 8.

### 4.3 The interim, before the native pass

- **A hung helper** holds that request, and so that server's exchange in Draining. Its slot stays held, and a call to that server is refused busy. Chat and other servers go on, unless enough helpers hang to fill the shared 32. Remove also waits, holding the owner of durable effects; Settings shows "Saving…" with the restart words (5.1).
- **The local write bound is a page timer:** each local write has a 10 s watchdog; past it the server has stopped reading, its run ends ("The server stopped reading what Familiar sent, so it was stopped") and it's stopped. A renderer crash with a full pipe leaves that write unbounded until you restart.
- **No `totalMs`.** A server trickling within `idleMs` lives past its deadline only across a reload. The page is restart-only then, and quitting ends it.
- **Redirects are followed** (4.4). The client's second line, failing a head that says `redirected`, is in both builds, but by then a 307 has re-sent the body once.
- **No `created` flag.** A rollback leaves the address in place, and the start-time sweep of addresses no record owns removes it (5.2).

The harness runs both builds, the pre-pass contract and the pass's (7.2), so each limitation is a measured one.

### 4.4 No redirects for servers (pre-release native pass)

**Order in the native pass.** These come first, ahead of every other native item, as early runner checks: the no-follow rule, with `net.no-redirect`, and 4.5's two unverified items, with `net.tls-egress` and `net.pool-retry`. Each one either changes the exe's contract or measures something it hasn't stated, and the fake exe (7.2), the client's handoff and P4's items all rest on that contract. A result that differs from what's written here is known before anything else is built on it. P4's three bounds and 4.2's items follow.

Today `net_fetch` follows up to 5 redirects under the saved address, and reports `redirected` only after the fact. A 307 or 308 sends the same POST body again to the new path; a 301, 302 or 303 is followed as a GET. So one `tools/call` handoff could reach the server twice, or as a GET. That isn't a consent problem: the destination is under your approved address, and the body is the approved one. But "never resent" and "no GET" must be true on the wire.

- **The change:** for a `server`-kind address, `net_fetch` never follows a redirect. A 3xx ends the request with its status and headers, and nothing is sent to the `Location`. Model-kind addresses keep today's rule.
- **The client** fails such an exchange (3.11), and fails any head that says `redirected: true`.
- **The runner check `net.no-redirect`:** one server answers 307 and another 303, each pointing to a second path on the same server. Arrivals are counted at both paths: exactly one at the first, none at the second, and the exchange fails with the status.
- **The fake exe** has a redirect mode that follows as today's contract does, so H14 fails if the client's second line is removed.

### 4.5 What one exe command can put on the wire

The exe's wire behaviour, listed in full:

| # | Command, or case | What reaches the wire beyond Familiar's own bytes | Pin | Check |
| --- | --- | --- | --- | --- |
| 1 | `net_fetch`, a redirect | A re-POST (307, 308), or a GET (301 to 303) | No-follow for servers (4.4) | `net.no-redirect` |
| 2 | `net_fetch` behind a manual system proxy, public addresses only | A `CONNECT`, or a forwarded request for `http`. What the proxy then does, retries included, isn't Familiar's | **Named:** behind a proxy, "one POST" holds at Familiar's side only. `net_proxy` shows the kind | The existing runner proxy check |
| 3 | DNS lookups, Familiar's pre-check and the resolver's | Queries for the address's name. After a detach, one already sent can finish after the cancel | Named (4.1, section 1) | `net.helper-detach` |
| 4 | TLS with the platform verifier | **Unverified:** whether Windows' chain building fetches issuer certificates or revocation data from CA hosts outside the saved address | Named until measured | `net.tls-egress`: capture DNS and connections during an `https` fetch to a public test host |
| 5 | Pooled lan and loopback connections | **Unverified:** whether the client re-sends a request on a pooled connection that closed before the request was written. That's a resend with nothing delivered, not a duplicate at the server | Named until measured. If it does, MCP requests get a client per request, as public addresses already do | `net.pool-retry`: a loopback server that closes idle keep-alive connections, counting arrivals per call |
| 6 | Headers Familiar didn't write | The key in one of four swap headers (by design); `Host`, `Content-Length`, and presumably `Accept-Encoding` with decompression on | Intended | The existing header-filter tests |
| 7 | `net_cancel` | A TCP close or HTTP/2 stream reset, no new request | — | — |
| 8 | `address_add` | One DNS lookup after Allow | Approved egress. Its answer gains a `created` flag (4.2) | Existing, plus the flag in the exe's own tests |
| 9 | `server_start` | One process, which may fetch packages itself (`npx`, `uvx`), outside the exe's reach. Familiar's only second start is the modern relaunch (3.9) | Readmitted through the owner (3.9) | T14 |
| 10 | `server_write` | Exactly one stdin write per call, at most 4 MiB, up to 8 in flight; never on its own, never retried | — | — |
| 11 | `server_stop` | Closes stdin, then ends the job at 500 ms; no message to the server | — | — |
| 12 | Output handling | A stdout line over 4 MiB is dropped with an `err` event, and secrets become `[hidden]`. That changes what Familiar receives, not what's sent | The `err` event is a terminal path (3.10) | T14 |

If either unverified item turns out true (certificate fetches outside the saved address, or a pooled retry), the design takes it in before the rest of the pass: by naming the egress, or by a client per MCP request.

## 5. Durable config, consent and names

### 5.1 One owner of durable effects

- **One module owns all durable tool config** (`owner.ts`): saved servers, setups, keys, enabled flags, limits, reviewed fingerprints, your choices for every tool (built-in and server), the one mark of a change under way, and the tombstones of removed servers. The journal doesn't own tool config.
- **One durable effect at a time**, for everything. A second is answered busy at once ("Saving another change. Try again in a moment."), and a refused command changes nothing.
- **Durable effects get no deadlines.** If the exe or the store never answers, Settings says "Saving…", and after 10 s: "Familiar is waiting on Windows. Restarting Familiar finishes or undoes this change." The timer changes only the words.
- **The owner keeps one record, written whole per step**, in one strict IndexedDB transaction, so each step commits atomically. The owner notifies Settings then.
- **The changes**, each a fixed list of steps with one mark, owned until done:

  | Change | Steps | If a step fails |
  | --- | --- | --- |
  | Add local | Check the draft. Save the record, stopped and not enabled, in one commit | Not saved |
  | Add remote | Normalize the URL to the exe's address identity, and refuse if a saved server has that identity. Mark (with the identity). `address_add` (the exe's dialog, unless it already holds that identity). Record and clear the mark, in one commit | Declined, or `address_add` failed: clear the mark, not saved. If `address_add` succeeded and the commit failed: the owner stays held and the mark becomes a rollback obligation until `address_remove` settles and the mark-clear commits; only then "not saved". The rollback removes the address only if this add created it, as `created` says. Until the native pass adds that flag, a rollback leaves the address for the start-time sweep (5.2). A failure there: "Couldn't finish undoing the add. Retry". An address already gone counts as done, and no dialog appears |
  | Edit a local setup | Refused unless Stopped. New record and a mark naming the dropped secrets, in one commit. `secret_delete` each. Clear the mark | Before the commit: not saved. After: "Saved; cleanup not finished" |
  | Remove | Stop (awaited). Record set to removing, plus a mark, in one commit. `server_forget` or `address_remove`. `secret_delete` each. Delete the record and its choices, keep the tombstone, clear the mark, in one commit | After the first commit: "Removing; cleanup not finished" |
  | Enable, Disable | Commit, answer, release. Then a separate start or stop | The start's failure doesn't undo the enable |
  | Limits, mark reviewed, a choice | One commit | Not saved |
  | Catalog write: the tools a run listed, saved as the tools last seen | Admitted like any other effect, in the same synchronous step as the check that the listing's run is still the server's run. One commit. A start answers Ready once its own catalog write has settled, so the next start finds the owner free | Never queued. Skipped when the owner is busy or the run is gone: the list is read again at the next listing, and until then a tool missing from it only reads as unreviewed. Admitted while a change's cleanup is unfinished, as starts are, since it changes no setup |

  Steps after the commit are idempotent. A change saved with its cleanup unfinished keeps its mark, and every other change is refused until Retry, or a restart's repair, finishes it. Starts of other servers are still admitted then, since no effect is in flight.
- **The address identity is the exe's.** Core keeps its own copy of the exe's URL normalization (case, punycode, default ports, one trailing dot, trailing slashes), and a drift test checks it against the exe's source. So `https://x` and `https://x:443` are one server, and a second is refused.
- **Native starts** are admitted by the owner, and count as the effect in flight until they return a run id or a failure. While a start's dialog is open, nothing else durable goes anywhere.
- **Fail closed:**
  - an unreadable choice loads as an explicit "ask" for its tool, never as empty, since an empty choice is a built-in's default, which for some is allow. That loosens a lost "never" to "ask", which still needs your Yes on a card for every call. It never loosens to "always";
  - an unreadable server record isn't started or overwritten, and keeps its address: repair's sweep and an Add's two address checks (its URL's identity, and the id the exe gives back) read every record raw, so a new server never shares an unreadable one's address;
  - a record of another version, or one whose shape can't be read at all, loads nothing, and nothing is written. Then no choice loads, so no built-in falls back to its default allow: every tool asks, built-ins included, until a restart reads the record. A revoke to never still denies, from the overlay (5.5), though it can't be saved;
  - a missing secret stops the start, and the refusal lists all of the setup's secrets.

#### Saved setups

The owner's record lives in core's settings store (`packages/core/src/settings/`), under `mcp.owner`, with its schema version. The store is a small key-value store on IndexedDB through core's strict wrapper, so every transaction is strict. A setup never holds a secret's value: secrets are in Credential Manager, put there by Settings (5.8).

### 5.2 Ids, keys and tombstones

Server ids are random and never reused. A removed server leaves a tombstone, which keeps each cleanup item (forget, each secret, the address) with a done flag. Each exe start retries the items not done, and completion, not age, shrinks the tombstone to its id and key. An add that reuses a removed server's id is refused: "A removed server had this id, and ids are never used again. Add it as a new server." (`REMOVED_ID_WORDS`). Any server-kind address no record owns is removed at start.

### 5.3 Restart-only, and repair in a fresh exe

- **Core calls `shell_ready` before it builds anything.** A refused second call means a reload. Then no owner is built, no journal opens or resumes, no tool is installed, and no config, choice, reservation or card command is accepted. The page shows only "Familiar needs a restart".
- **Settings fails closed.** It shows "restart needed" when its messages get no answer, or that answer.
- **Repair runs only in a fresh exe**, where every old native operation ended with the old process. The one mark is rolled back (before its commit) or finished (after it), `address_add` is never repeated, and then the enabled servers start, one admitted start at a time.

### 5.4 The runtime lifecycle

- **States:** Stopped, Starting, Ready, Stopping, Failed. Every run has the exe's run id, and an event from another run is dropped.
- **No automatic restart.** A crash ends the run, calls in flight are answered "interrupted, it may have partly run", and the server goes to Failed with the reason and its last output.
- **A server Stop during a call** answers the call "interrupted": the run ends under it (3.11).
- **A start reads the committed launch** in the same synchronous step as its admission. Edits need Stopped.
- **Nothing is ever resent.** A call while not Ready is refused "not running", and a call is never sent again on any path.
- **Stop waits** for the exe's answer and the exit, with no deadline of its own: a local Stop answers only once the process has exited. A Stop while the native start is still pending waits that start out first; the start then stops what it started. Each run is stopped natively once, whoever asks first (Stop, or the run's own end). A stop the exe refuses answers once the run has ended, and its writes and the slot still wait for the exit. A start the exe never answers stays Starting, holding the owner, until a restart. That's unbounded by design.
- **One exchange per server** (3.4). A call's timeout, or stopping the call, ends that call only.
- **Ready means drained.** A start answers Ready only once its last exchange has drained (the list's write acknowledged, its request ended), within the start's deadline, so a call made the moment Start answers is admitted, never refused busy. A drain that outlasts the deadline fails the start in time's words.
- **Test runs only while Stopped:** an admitted start, the tool list, then a stop. A failed Test leaves the server Stopped. Test acts on its own run only: a Stop (or a Stop and a Start) while its catalog write is saving means Test reports no success, and Test's own stop never touches a run started since. A catalog write that fails stops the run it was for, and the start answers failed in words; it never throws. "Mark reviewed" after it is a change.
- **Mark reviewed is bound to the report it was pressed on.** Each Test report carries an id core issued. Mark reviewed names that report and the tools' names, nothing else: each named tool is marked reviewed at the fingerprint that report showed it with, never at whatever the saved list holds when the change lands, nor at what a later Test showed. A tool a run lists changed between Test and the press stays unreviewed, and asks to be reviewed again. A name the report didn't show is marked nothing; a report core didn't issue for that server, or one older than the newest 16, marks nothing and answers "Test again". No fingerprint is ever taken from a window. A tool the report showed that the saved list lacks, because Test's own catalog write was skipped while the owner was busy, is saved as seen at that fingerprint and reviewed, so the review isn't lost.

### 5.5 Consent: `ToolDecision`, the card's facts and the canonical form

- **A `ToolDecision` is opaque** (`decision.ts`). Its constructor isn't exported, it has a type brand, and minted decisions live in a module-private `WeakSet`. Only the gate mints one, inside the tool's `execute`, from durable facts:
  - a stored yes for this card whose identity, fingerprints and arguments hash all match this call now;
  - or the person's "may run on its own" for exactly this identity and both fingerprints (5.6).

  A mismatch mints nothing, drops the old answer and asks again. A "never" mints nothing. A decision records how it was minted, is bound to its step id, and is used once.
- **Each presentation of a card gets a fresh, one-use card id.** The stored facts and any answer are keyed by that id, under the step id. When the facts change (a new fingerprint, or new arguments), the old id is retired, and the re-ask is a new presentation with a new id. An answer carrying a retired id, a duplicate included, answers nothing. So a Yes given to the first card can never mint against the second card's facts, which you never saw.
- **The card's facts are stored when the card is made:** server id, the tool's own name, the tool's fingerprint, the launch fingerprint, and the canonical arguments with their SHA-256. They live in the journal's consent document. The answer is checked against those stored facts, never against the catalog as it is when the answer arrives. A change while the card is visible makes the yes mint nothing.
- **The arguments are the ones `beforeTool` receives**, after pi-durable's repair and coercion. `execute` gets exactly those, and no hook may replace them.
- **The canonical form** is one function, used by the card, the stored answer, the mint and the body (3.6): `JSON.stringify` of the parsed value with object keys sorted by plain string order at every level, arrays kept in order, `undefined` keys dropped, and `-0` written as `0`. A value outside plain JSON is refused before a card is made.
- **Revokes hold at once.** A tightening ("may run on its own" to ask, anything to never) takes effect in an in-memory overlay that `send` reads synchronously, whatever the owner is doing. Its durable write is tried after. "Never" from either the overlay or the saved choice wins.
  - **"Ask" is saved as an explicit ask**, never as no choice. For a built-in that runs without asking, or a built-in read, no choice means its default, allow. The overlay's "ask" likewise sets ask.
  - **With the whole record unreadable, built-ins ask.** No choice loads then, and the gate's policy says so (`askAll`), so a lost "never" or "ask" is never read as a built-in's default allow. Any stricter overlay stays on top: a "never" denies.
  - **A refused durable revoke is reported.** The revoke's answer is its durable write's outcome. A revoke to Ask over a saved never writes nothing, since never stands, but answers saved only once the owner admits it: while another write is in flight (a choice of allow, say), the saved never may be about to change, and the answer is not saved. If the owner refuses the write (busy, or a change's cleanup unfinished) or the store loses it, Settings is told: "Revoked for now, but not saved: it comes back when Familiar restarts. Try again." The overlay holds until then.
- **Until step 8's choices UI**, the journal isn't fed the owner's choices, and every server tool asks.

### 5.6 What runs without your Yes

**The rule: no server tool runs without your Yes to that call, and no built-in runs unasked unless it's on Familiar's fixed list of note and reminder tools.** It holds by construction: nothing reads where any text came from, and there's no record of it to keep.

- **Server tools: every call shows its card.** There's no "always" for a server's tool. A choice of allow for one is refused when it's saved ("There's no "always" for a server's tool…"), one found in the record (saved by an older build) loads as ask, and the gate reads a policy of allow for a server tool as ask, from wherever it came. The card binding, the one-use decision and the handoff's checks (5.5, 3.6) are as they were.
- **Why not "always for tools that only read".** A server says for itself whether a tool only reads, so Familiar can't trust it, and even a reading tool sends its arguments to the server: steered text could carry the chat out through a search box.
- **"May run on its own" (`own`), the one exception, your informed choice.** A server tool's card offers a third button, beside Yes and Skip, whose words say what it lets her do: "May run on its own: Familiar will call {tool} on {server} whenever she decides to, without asking you, even when something a server said led her there. Only this version of the tool, and you can take it back in Settings." Pressing it is a Yes to this call, and Settings saves the grant for the card's stored facts (the server's id, the tool's own name, its fingerprint and the setup's), never for anything a window sent (5.7). The grant:
  - holds only while the tool and setup are exactly those: the gate reads it through the wrapper's own identity (`wrapperPolicy`), and `send` checks it again at the handoff;
  - is cleared, in the same commit as the catalog write, when a run lists the tool with another fingerprint, so a tool that changes and changes back asks again. A catalog write skipped while the owner is busy leaves the grant until the next listing, and it never applies meanwhile;
  - is revocable at once, through the overlay (5.5).
- **Built-ins.** Only `note_add`, `reminder_set` and `reminder_cancel` (`RUN_WITHOUT_ASKING`), and the reads `note_search`, `note_list` and `reminder_list` (`BUILT_IN_READS`), run unasked: they're Familiar's own notes and reminders, visible and undoable, and the reads write, open and send nothing. Every other built-in asks every time. A person's Allow for one is refused when it's saved ("Only Familiar's own notes and reminders run without asking"), and one found in the record loads as ask. A listed tool can still be set to ask or never.
- **What this replaced.** Earlier builds kept "always" for server tools but switched it off while the conversation held outside content, tracking each message's sources, with a hook recording what each compaction summary replaced. Under Familiar's pins (one conversation, no reset, summaries carry forward), that tracking only ever computed one bit that turned on at the first server answer and stayed on, so "always" was off for good from roughly the first day; and its classification rules kept finding new holes. The rule above asks about as often in practice, and states its safety in one sentence. No message carries sources, and no compaction hook is installed (2.5).
- **An acknowledgement is decided once**, after its commit wins, so two sends of one request id run the decider once, and both get its decision. The winner answers with its own decision, and a send that finds the request id only in pi-durable's record (it read the newest 256 before the winner's commit, or the record has left them) reads the record again and waits for a decision still being made. Only one resent once no decision is left to wait for gets a quiet one: no new reaction, and never a second reply.

### 5.7 Messages from other windows, and reserved headers

- **Card answers go through the card desk** (`journal/desk.ts`), the journal's consent port as the core page holds it. Another window answers a card with `{ presentation, button }`, and nothing else in the message is read. The buttons are yes, "may run on its own" (only where the card offers it: a server tool's card, which carries its words) and skip. A button the card didn't offer counts as Skip. Each presentation is answered at most once; an answer for a presentation that isn't showing (retired, already answered, or never shown) answers nothing.
- **Settings' edits** carry bounded draft values, and core validates them into its own snapshot. An Add copies the setup, its secret names included, at entry, before validation, admission or any await, and reads only the copy, so a draft changed while the exe's dialog is open changes neither the URL approved nor the id saved. Approval facts, fingerprints, ownership state and call arguments are never accepted from any window.
- **Reserved headers.** A setup header is refused, case-insensitively, if it names `mcp-session-id`, `mcp-protocol-version`, `last-event-id`, `content-type`, `accept` or `host`. Also refused, because the modern era's headers are built from the decision (3.6): `mcp-method`, `mcp-name`, and any name starting `mcp-param-`. The client's own headers are set after the setup's, so even an unrefused name couldn't override them.

### 5.8 Secrets and reservations

- **Core's side.** `Owner.reserve(ref)` grants one reservation for one secret ref of a server saved now, with a fresh id used once. The grant holds the owner (no other change, no removal of that server) until `acknowledge(id, ref)`. An acknowledgement with an unknown, used or mismatched id or ref does nothing. A grant never acknowledged holds the owner until the exe restarts, and is nothing after.
- **Settings' side** comes with step 8: it consumes the grant in the same step as it calls `secret_set`, and acknowledges by the grant's id only after that call settles. The value never passes through core.

### 5.9 Names

- **Each server gets a key at add time:** a lower-case letter, then letters and digits, up to 16, from its label. A label with no Latin letter falls back to `server`. Keys are unique against every key ever issued, tombstones included, by a digit suffix, and are never changed or reused.
- **The model's name is `<key>__<tool's own name>`**, offered only if the tool's own name is letters, digits, `_` and `-`, and the whole fits 64 characters. Nothing is converted.
- **The key has no `_`**, so the first `__` splits a name back into one server and one tool. Choices are keyed by server id and tool name.
- **A tool not offered** is listed in Test with the reason. Two tools with one name fail the list.
- **No other extension can take a name.** pi-durable lets a later extension's tool replace an earlier one of the same name. So the installed extensions are fixed to Familiar's own (2.5, row 11), server tools are registered only under `<key>__…`, and a test asserts that no built-in tool's name contains `__`.

### 5.10 Cards and chat text

- **A message sent while a card is open** is queued as a follow-up. It shows "She's waiting for your answer above" with the card's Skip beside it, which sends that card's presentation id. When the next call opens another card, the notice moves to it, and a delayed Skip for the old id answers nothing.
- **Chat text never settles a card.** The card's wait observes its call's abort signal, so `close()` never hangs.

### 5.11 Adding a server

- **By paste or by form** (`paste.ts`). A paste can be the common `mcpServers` block, VS Code's `servers`, a bare map of servers, or one server object, with comments and trailing commas forgiven. A form gives the same draft. A draft is the setup with no secret values in it, the values for Settings to store, and problems (which stop it being added) and notes (which don't). The raw paste is never kept.
- **Secrets.** Every setting of a local server is a secret by default, except the settings that change what runs (which can only be plain, since the approval binds their values) and short values whose names don't look like credentials. A setting whose name looks like a credential is only ever a secret. A remote server's key goes in one of the four swap headers as a placeholder, which the exe swaps.
- **The exe's rules, early** (`setup.ts`, `native-rules.ts`): its limits, its path rules and its classes of literal addresses, mirrored so a draft fails with the same words before anything reaches the exe. A test reads the exe's source and fails if the lists drift.
- **Legacy SSE is refused** in plain words: its server names the URL for its posts itself, so its approval would have to cover a whole origin.
- **The unpinned flag** (`unpinned.ts`): `npx`, `uvx`, `bunx`, `pnpm dlx` and `docker run` without an exact version or digest can fetch new code at any start, which the approval never saw. Such a setup is flagged, with how to pin it.
- **A tool's fingerprint** is SHA-256 over its name, title, effective description (the description, or the title when there's none) and input schema, in canonical JSON, plus its header declarations on a modern remote run (3.5). A changed fingerprint is a new tool, and goes back to ask.

## 6. Guarantees

Each check names a test (T1 to T14), a harness check (H1 to H14), or the walk (W), and the mutation that must fail it. Section 7 defines them.

| # | Guarantee | Mechanism | Check: what fails, and the mutation |
| --- | --- | --- | --- |
| G1 | Never two durable effects in flight | One owner, one synchronous admission, no timer releases it (5.1) | T3: two in flight (release on a timer) |
| G2 | Nothing waits in line | Commands that don't fit are refused at once; no queue anywhere; one exchange per server (3.4, 5.1) | T3: at most one unresolved (queue instead of refuse); H1 (queue a call behind a live exchange) |
| G3 | A start runs the committed launch | Edits need Stopped; the launch is read in the admission step (5.4) | T3 (an `await` between check and admission) |
| G4 | Any reload is terminal; repair only in a fresh exe | The `shell_ready` refusal checked first; repair at exe start (5.3) | T4 (build the owner after a refused `shell_ready`) |
| G5 | A half-done change ends wholly before or after | One mark, a rollback obligation, idempotent steps, tombstones (5.1, 5.2) | T3, T4 (no mark; release before the mark-clear) |
| G6 | An unreadable store never loosens past "ask": a lost choice becomes "ask", which needs your Yes, never "always" or a silent run | Fail closed (5.1) | T4 (load unreadable choices as empty; load them as "always") |
| G7 | One native write per reservation | One-use grants, held until acknowledged by id and ref (5.8) | T12 (a mismatched or repeated acknowledgement releasing the owner) |
| G8 | No call without a gate-minted decision | Opaque, one-use decisions; `tools/call` is built only inside `send` (3.6, 5.5) | T1, T2 (drop the `WeakSet`; export a raw call); H3 |
| G9 | The last check and the handoff are one synchronous step, and the body and its headers are the decision's | 3.6 | T2 (check, then an `await`, then hand off); H3 (an `await` before the handoff with a revoke in it; the body from the model's arguments); H11 (mirror `Mcp-Param-*` from another call's arguments; truncate an over-long header) |
| G10 | A yes covers only what the card showed | The card's facts are stored when it's made (5.5) | T7 (h), and H3 under S1 (mint from the step id; ignore the fingerprint) |
| G11 | A revoke holds at once, and one answered saved is what a restart loads | The overlay, read synchronously by `send`; the revoke's answer is its write's, admitted by the owner (5.5) | T2, T3 (the revoke waits for the owner; `revoke-denied-shortcut`: a revoke to Ask over a saved never answered saved while an earlier choice's write is held) |
| G12 | No server tool runs without your Yes to that call, and no built-in runs unasked unless it's on Familiar's fixed notes-and-reminders list | No "always" for server tools; the one exception is the person's "may run on its own" for exactly one tool version; an Allow for an unlisted built-in refused at save and read as ask (5.6) | T9 and T7 (`server-always`: a server tool's allow honoured again, so a call goes out with no Yes to it); T7 (`own-ignores-fingerprint`: a grant kept for a tool that changed); `tests/mcp/owner.test.ts` (an Allow for an unlisted built-in) |
| G13 | A client message carries no authority | Presentation id and button only; drafts validated by core (5.7) | T10 (accept a client's fingerprint; honour a button the card didn't offer) |
| G14 | One exchange per server, cleanup included, across Stop and Start | The per-server slot and the barrier (3.1, 3.4) | H1 (free the slot at the response, before cleanup; admit while draining; send page n+1 before page n drains; key the slot per run, then Stop and Start during a drain, S8); W |
| G15 | Only Familiar's own messages reach the wire, and nothing reaches a stopping run | A tagged serializer of six kinds, narrowed by the run's era; no SDK; the closed mark (3.2, 3.4) | H2 (a `DELETE` at Stop; a remote cancel; a pong after its exchange ended; the local cancel after the seal; no closed mark at Stop, S11); H12 (a modern run builds `initialized`, answers a stray ping or sends a session id; a retry after `input_required`) |
| G16 | Every native request and write an exchange makes ends within its native bound, cleanup included, and every exchange kind completes | `headersMs`, `idleMs`, `totalMs`, pongs at 5 s; P4's detach; completion per kind (3.4, 4.1) | H4 on the pass build (no detach: a held helper keeps the slot past its bound, S8); W and H1 (write-only exchanges completed only on a response: a local idle ping leaves the server busy) |
| G17 | Server load can't take chat's requests | The server cap of 24 within 32, detached server helpers counted in it (4.1) | H5 under S10 (no server cap: with 24 server requests held, a model fetch refused) |
| G18 | A call's timeout or stop ends that call only | Its signal drains its exchange; the run stays (3.6) | T5 and S13 (close the run on a call's timeout) |
| G19 | A recovered server call never runs unasked | The recovered-run gate (2.7) | T13's recovered-run test, and T7's kill mid-call (drop the run check) |
| G20 | A question is open exactly while pi-durable says its run stopped there | Questions are a view over `runFailure`, under 2.5's preconditions (2.2) | H6 and H7 (record the question when the run ends); T13. A queued reset is ruled out by the module-graph pin (2.5, row 7) |
| G21 | Every submission is your act, admitted in one commit with its check, and no pi-durable path starts a run on its own | `send`, `answer`, Send now, her line; `submit(tx, …)`; 2.5's eighteen pins (2.3 to 2.5) | H7 (split an answer's check from its `continue`; automatic placement after an error; `afterFailedRun: "continue"`; a per-message Send now); 2.5's settings and module-graph tests; S6 (7.2) |
| G22 | A queued message is never stranded unseen | A question holds it, or Send now shows (2.4) | H8 (hide Send now after a fault) |
| G23 | Her line never starts, restarts or places a run | The one-commit write choice (2.1) | H9 (drop the `runFailure` check from her line). The empty-inbox check has no reachable failing state (7.2) |
| G24 | Consent never rides on chat text, and the notice follows the open card | 5.10 | T13 (read queued text as an answer; resolve Skip against the current card) |
| G25 | A model name names one tool, for good | Frozen keys, no conversion (5.9) | T6 (keys unique only among servers saved now) |
| G26 | A sent call reaches one run, is never resent by Familiar or the exe, and never meets a catalog Familiar knows is stale. It can meet a change the server made since the last listing (3.8b, section 8) | Run ids, no resend, stale refuses (5.4, 3.5); a 404'd call is a tool error with its decision used (3.8); no redirect followed (4.4) | T5 (resend after a connection error); H10 (accept a response for any id); H14 (resend the 404'd call after the re-handshake; keep the old session id; drop the `redirected` check under the redirect mode; Ready during a session recovery, S12) |
| G27 | Test never disturbs a running server | Test only while Stopped (5.4) | T8 (allow Test while running) |
| G28 | A local server that stops reading is stopped, even with the page gone | The exe's write bound (4.1) | T11 and `server.write-bound` on the runner (the bound in the page only: the renderer killed with a full pipe outlives 11 s) |
| G29 | A run's era is decided once, from the server's own refusal, and every request of that run is framed for it | The era is set in the step that ends the `initialize` exchange, and the serializer takes it (3.2, 3.3) | H12 (turn modern on any `initialize` error); T14 |
| G30 | A tool the protocol says to exclude is never offered | The declaration scan at list time; declarations in the fingerprint (3.5) | T14 (a tool declaring a `number` header is listed); T6 (declarations left out of the fingerprint: a changed declaration keeps its "always") |
| G31 | A server that drops its session gets at most one re-handshake per drop, never two in a row | The bound in 3.8 | H14 under S3 (re-handshake on every 404) |
| G32 | Every ping a legacy server sends gets a timely pong handoff once, or meets a named departure. What the network does to a handed-off pong is logged (departure 6) | Pongs from the parser in the step that reads the ping; pongs outstanding until their native end (3.4, 3.7) | H13 under S2 (pong in a microtask; cancel pongs at once on draining: a ping with the final reply is lost with no departure) |
| G33 | A card's answer settles only the presentation you saw | A fresh one-use card id per presentation (5.5) | T7 (i), S9 (answers keyed by step id: a duplicated Yes from the first card mints against the second's facts) |
| G34 | Two saved servers never share one address, and a rollback never removes another's | The exe's normalized identity; rollback only of what this add created (5.1) | T4 (compare raw URLs: `:443` and no port make two records; roll back an address this add didn't create) |
| G35 | No `tools/call` reaches the server more than once, or as a GET | No-follow for servers (4.4); the `redirected` check (3.8) | `net.no-redirect` on the runner; H14 under the fake exe's redirect mode |

**The five classes of defect, and the guarantees that rule each out:**

| Class | Ruled out by | Why it can't arise |
| --- | --- | --- |
| **State changed outside its current owner** | G1, G3, G4, G11, G13, G20, G21, G23, G27, G34 | Durable config has one owner. Run state belongs to pi-durable alone: Familiar keeps no copy of "a question is open", and never places a run |
| **An effect landing after its change answered** | G4, G5, G7, G9, G15, G19, G20, G21, G26, G29, G31, G35 | The check and the handoff are one synchronous step. A superseded question closes in the commit that superseded it. Nothing is sent from a stage Familiar didn't start |
| **A stale waiter, queue or native request** | G2, G14, G15, G16, G17, G18, G22, G23, G28, G32 | No queues. One exchange per server, cleanup included. Cleanup is bounded natively. Chat's share is reserved |
| **Consent not bound to the exact call at the native handoff** | G8, G9, G10, G11, G12, G19, G24, G30, G33 | The body and, on modern, its mirrored headers are built from the decision inside the synchronous handoff, and the decision is checked against the card's stored facts |
| **A name mapping to two identities** | G25, G26, G30, G34 | Frozen keys, original names only, a reserved namespace, one address identity, run ids on every event |

## 7. The tests

### 7.1 The ground, checked against the real dependencies

The design reads pi-durable's spec and the reference servers' behaviour. Before the code that depends on them, each reading was checked against the real thing, and those checks stay as tests:

- **pi-durable's `runFailure` and inbox** (`tests/journal/pi-durable-b1.test.ts`), against the real 1.5.2 on a fake IndexedDB: for a step cap, a cap pause through `cappedPort`, an `abortTask`, a Stop, a new message, a `continue`, and a display-only and a model write in each state. `runFailure` is set and removed as the spec says; a cap pause arrives as `model_error` with a decodable detail, and inside a blocking compaction with both prefixes (2.2); `backgroundTokens: 0` starts no compaction task, shown at a 100,000-token window; `tx.submission(id)` reads a queued submission inside a commit before its admission, and throws `ReadAfterWrite` after; the inbox is kept after an unanswered or aborted run; a display-only write is appended in every state.
- **Role alternation** (`tests/journal/ground.test.ts`): every request body alternates roles after the merge (2.1).
- **The modern opening.** The TypeScript SDK's servers (HTTP and stdio, default and modern-only) were run, and rmcp's read from its source. Their exact refusals (status, media type, body) are what T14 replays, and they settle 3.9's two stdio paths.
- **The code pins** (`tests/journal/pins.test.ts`): 2.5's settings, hooks, extensions and call sites, and `run.inputs[0]` stable across a run's generations (2.7).
- **The address identity** (`tests/mcp/owner.test.ts`): core's normalization against the exe's (5.1).

An upgrade of pi-durable must run these, and T13, again.

### 7.2 The seeded harness

**What runs:** the real client (`McpClient`, its links and the exchange machine) and the real journal on the real pi-durable 1.5.2. There are two harnesses, both in `packages/core/tests/harness/`:

- **the wire harness** (`wire.ts`, checks in `checks.ts`, named schedules in `schedules.ts`): the client against a scripted fake server, through an unkind fake exe. CI runs H1 to H3 and H10 to H15 over 500 seeds (20,000 locally with `FAMILIAR_SEEDS`), plus H4 and H5 in the pass build, and the named schedules S1, S2, S3, S8 and S10 to S27;
- **the journal harness** (`journal.ts`, checks in `journal-checks.ts`): the real journal over a fake IndexedDB that outlives each life, with a gated fake model. It runs H6 to H9 over seeded runs (40 by default, `FAMILIAR_JSEEDS`), and the named schedule S5.

**The fake MCP server, scripted per seed.** Its legacy modes, local and remote, can:

- answer JSON or an event stream, its results carrying multibyte text, its events written over two `data:` lines with CR, LF or CRLF line ends;
- send pings (none, two concurrent, a flood, one in the same chunk as the final reply) and `list_changed`;
- end streams early, stall heads and trickle bodies;
- page with `nextCursor`, including 17 pages;
- send unsupported requests, invalid answers and responses for stale ids;
- end a session: a 404 on the next request carrying its id, on every call, or on a refresh page; then, per seed, accept the re-handshake, 404 the first request after it again, refuse it as modern-only, fail it, or 404 always;
- send `list_changed` ahead of a walk's first page;
- refuse `initialize` with `-32022`, or with another error;
- send local idle pings, and stop reading stdin.

Its **modern modes**, local and remote:

- **modern-only:** refuses `initialize` with `-32022` and `data.supported: ["2026-07-28"]`; on stdio, either keeps the pipe or exits, per seed, so both of 3.9's paths run;
- **both eras:** serves `initialize` too, so Familiar must stay legacy;
- **request validation:** rejects a request whose `_meta` envelope or standard headers are missing or disagree with the body, or whose `Mcp-Param-*` headers disagree with the arguments, with `400` and `-32020`;
- **tools:** one with a mirrored `string` argument, one with a non-ASCII mirrored value, one declaring a `number` header, one returning `input_required`, one with `resultType` absent;
- **misbehaviour:** a stray `ping` and a server-to-client request on a modern stream.

**The unkind fake exe.** It implements shell-design's `net_fetch`, `net_read`, `net_cancel`, `server_write` and the channel by their contract, not kindly:

- it hands over bytes, with chunk boundaries anywhere, through a multibyte character or between a CR and its LF;
- `net_cancel` returns only when the request's task and every helper have terminated, and a helper can be held for any time; now and then it refuses a `net_cancel` once, keeping the request alive;
- in one mode it acknowledges a local write only once the server's answer to it has been read, so a Start's last write can still be pending when its answer arrives;
- the 32 open requests are counted until termination;
- the writer takes 8 writes in flight, and blocks when the fake server stops reading;
- a redirect mode follows 3xx answers as today's contract does: a 307 re-POSTs, a 303 becomes a GET;
- a pong's native fate can be a stall, a timeout or `busy`.

The **pass build** adds P4's detach bound (1 s), the server cap, the refusal past 8 detached server helpers, and the native write bound. The checks judge by the contract's own numbers (`contract.ts`), which the fake exe never imports, so a wrong number in the fake can't pass its own check. The fake exe records every native request with its start, cancel and termination, the exchange and run it belonged to, and its body.

**The independent evidence log.** Checks never read the code under test's memory or UI. The harness keeps its own log:

- **your actions**, written by the test driver as it acts: each message, each answer with its button and presentation id, each Send now, Stop, revoke and Settings change;
- **what was shown**, recorded at the card and button ports, the journal's own ports with test doubles behind them;
- **commits**, recorded at the storage boundary: each commit's pre-state and post-state of `pi.live`, its submissions and Familiar's documents, across lives;
- **handoffs**, recorded by the fake exe: each native request, with its JSON-RPC id and body. The harness matches a body to the decision whose stored card facts (or "may run on its own" grant) produce it, rather than taking the client's word for it.

**The scheduler** (`sched.ts`). Every native answer, every timer and every action is an event in one ready set, and at each step the seed picks the next one: a server chunk, a helper finishing, a timer, an action of yours, one of her lines, or a kill and reopen at a commit. After each event the code under test runs until it settles, so a run is a function of its seed.

**The checks.** Each reads only the fake exe's log, the fake server's own record, the commit log and the evidence log:

- **H1.** Per server, the native requests of two different exchanges are never open at once, cleanup included, and at most 3 are open on a remote server, 4 on a local one (3.4). Every call refused busy is answered within the step it was made, and no handoff for it ever follows. Overlap alone can't catch a queue, since a call queued until the slot drains never overlaps. Busy, and a start that times out, only while the exe shows the server's exchange in play, and never for a call made in the step its Start answered Ready; no local write stays pending past the interim bound (4.3). After cleanup the exe refused for good (four refused `net_cancel`s), nothing more goes to that server, and Start and Stop say a restart is needed.
- **H2.** Every request body is one of the six kinds (3.2). No GET or `DELETE` is ever made, no error response is sent, and no `notifications/cancelled` goes to a remote server. No pong is sent for an id that wasn't a ping on its own exchange. No request is made after its exchange's terminal event, nothing at all (not even a pong) after its run's Stop, and none outlives its run. A local Stop answers only after its process exited, and each run is stopped natively once. The process a Stop is for is read from the exe's own record of the starts it admitted, so a Stop while `server_start` is still pending is judged too, and every Stop is answered.
- **H3.** Every `tools/call` body equals, byte for byte, the canonical body the harness builds itself from the arguments one Yes was for, answered before the handoff and not used by an earlier one. No call reaches the fake exe for a decision whose revoke, abort or fingerprint change the log shows before the handoff, and none goes out on a catalog a `list_changed` made stale before a walk after it came back.
- **H4.** In the pass build, every `net_cancel` returns within its bound, even while a helper is held, and a held helper never keeps an exchange out of Idle past the bound. The pre-pass build records the same as a measured limitation.
- **H5.** In the pass build, at saturation: with 24 server requests open (detached helpers among them), a model fetch is never refused `busy`. Its witness is a model fetch made while 24 were open, not merely one in a run that peaked.
- **H6.** Both directions, against an independent history. From the commit log, the harness keeps its own record of each unanswered ending, from the submissions' own settlements, and of every run start after it. It never reads `runFailure` to judge `runFailure`. A question is due exactly when the latest ending has no run start after it and no answer. H6 fails if a question is shown that isn't due, or if one that is due isn't shown.
- **H7.** Every run start in the store is in a commit that also holds one of these: your new message; an answer record whose commit's pre-state shows the question open, under that question's task, from a click the driver's evidence shows was on that very question (its request id is the started submission's); a Send now record whose pre-state shows its submission queued and oldest; or pi-durable's own boundary: a new task of the same run (its first input and inputs unchanged), or the next run once every input of the earlier one has settled done. Nothing else, so a compaction boundary fails it.
- **H8.** After every step: if the conversation is idle, the inbox isn't empty and no question is open, Send now is shown.
- **H9.** Her line's entry is model-visible only if, in its commit, no run was live, the inbox was empty and `runFailure` was unset. Her line never appears in a commit that starts a run.
- **H10.** A late response for an ended exchange's id never reaches a caller. Each result arrives exactly as the server wrote it, its multibyte text whole however the bytes were split, and no valid answer is read as invalid. Only the two exact media types are read, and no server header text past 40 characters reaches any words.
- **H11.** On a modern remote run (modern by the server's own refusal of its opening, never by the client's headers), every `tools/call` POST's `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` headers equal what the harness derives from that POST's body and the run's whole catalog across the last walk's pages, using its own scanner, with no undeclared `Mcp-Param-*` header and the client's plain-or-base64 rule for the 8 KiB size, measured over the whole header line (`Mcp-Param-{Name}: value`), as the native bound counts it. The driver sends fixed vectors: non-ASCII, empty, edge whitespace, sentinel-shaped, integer and boolean values, a lone surrogate, one past 8 KiB once encoded, and two at the bound of the whole line (8,192 bytes, sent; one more, refused though the value alone fits). A call whose mirrored value would be refused, or would pass 8 KiB, makes no native request. The scripted server answers `-32020` to a header that isn't the body's.
- **H12.** Judged per run, from one Start to its end, re-handshakes included. A run's requests all have one era's framing, every frame after the opening checked. A modern run never sends `initialize` after its opening, `notifications/initialized`, a pong, `Mcp-Session-Id` or a remote `notifications/cancelled`. A legacy run never sends the `_meta` envelope's reserved keys or the modern-only headers. A run turns modern only after an `initialize` answered `-32022` whose list names 2026-07-28 and no legacy version. No request follows an `input_required`, `-32020` or `-32021` answer for the same call. A local start is relaunched only when its modern list got no answer: never after one answered with a refusal.
- **H13.** Every ping id the fake server sends has exactly one disposition, kept by the fake server and the fake exe, not the client: a pong handed off for that id before its exchange sealed, or one of named departures 1, 2 and 5 whose own condition holds in the log at that step (departure 5, for example, requires the ping to have come after the final response on its stream). Departure 1 is judged at each ping's own delivery, on both transports: it covers a ping only if, when it was delivered, two of its stream's pongs were outstanding or 32 were handed off, or an earlier ping on the stream had already flooded. Remotely, departure 2 covers a ping read after its call had already ended for the client, while the exchange drained with its cancel refused: the fake exe records the client's terminal position on the stream (its first `net_cancel`, as step × 1000 plus the messages delivered by then, the same resolution as a ping's delivery), and only a ping delivered strictly after it is excused. A ping with neither fails. A handed-off pong's native fate (received, or lost: departure 6) is logged separately and never fails H13.
- **H14.** No call is sent twice:
  - no two native requests carry the same decision's call, matched through the evidence log;
  - no two requests in a run carry the same body once the JSON-RPC id is removed, unless the log shows two separately answered or "may run on its own" decisions for them. T7 (j) is the positive witness: two identical calls, approved separately, each go out once;
  - judged per run: after a 404 on a Ready run, the next request is an `initialize` with no session id, then `initialized` with the new one, and no call is admitted until the re-handshake's list has completed, each tried call refused as the run not being Ready, not only by the busy slot. An empty history there is a missed re-handshake;
  - a 404 before a page or call has completed after the recovery's own walk, or a failed re-handshake, ends the run with no further request;
  - nothing without the session id goes out between a 404 and its recovery's `initialize`, and a run walks its list no more often than its Start, its `list_changed`s, its recoveries and its Tests account for;
  - a run is one admitted Start (or Test) to its end, on one server: a Start refused busy begins none, and Ready means the Start answered ready;
  - under the redirect mode, a redirected call fails, and nothing follows it.
- **H15.** Test acts on its own run: a Test that met a Stop never reports success, and no Test reports success with no tools where the server listed some.

**Every check needs a witness.** For each check, the seed set must contain at least one step where its condition was in play and could have failed: H1 a busy refusal, H6 both a due and a superseded question, H13 a ping for each departure, H5 a saturation. A check with no witness in a build's seeds fails the build.

**Named mutations.** Each is a switch in the code under test (`src/mutations.ts`), off unless a test turns it on, and counted each time it changes behaviour. **They exist only in the test build.** Every call site is written `__FAMILIAR_MUTATIONS__ && mutant('name')`; the app build defines the constant `false`, so the bundler drops the branch and the name with it. `apps/desktop/tests/mutations-bundle.test.ts` scans the app's pages for any switch left, and a control builds the same pages with the constant `true` and finds them, so the scan can see.

**How a mutation must fail.** Each mutant runs beside its unmutated twin, on the same seed and schedule. It passes its control only if:

- the named check fails in the mutant;
- the same check passes in the twin;
- the two runs' histories are identical up to the first step where the switch changed behaviour: the scheduler's choices and every native handoff whole, its kind, server, method, URL, sorted headers and bytes (wire), or every commit's submissions, entries with their contents, and documents with their values (journal; the run's random ids come from its seed, and wall-clock times and measured durations read alike). A control that changes one header shows the comparison sees it.

Since the twin's identical prefix passes, the mutant's failure lies at or after that step. So a failure is caused by the switch, not only ordered after it. A mutation with no such seed is a broken control, and fails the build.

| Mutation | Must fail |
| --- | --- |
| `free-slot-at-response`: free the slot at the response, before cleanup | H1 |
| `queue-call`: queue a call behind a live exchange | H1 |
| `admit-while-draining` | H1 |
| `page-before-drain`: send page n+1 before page n drains | H1 |
| `slot-per-run`: key the exchange slot per run | H1, and under S8 |
| `write-only-on-response`: complete write-only exchanges only on a response | H1 (a local idle ping leaves the server busy) |
| `pong-after-end`: answer a ping after its exchange ended | H2 |
| `delete-at-stop` | H2 |
| `remote-cancel`: send a cancel to a remote server | H2 |
| `local-cancel-after-seal` | H2 (a write after the terminal event) |
| `no-stop-fence`: no closed mark at Stop | H2 under S11, local, during a walk and while Ready |
| `bound-offered-only`: the catalog bounds over offered tools only | `tests/mcp/regress/walk.test.ts` |
| `declarations-in-order`: declarations hashed in the order found | `tests/mcp/regress/walk.test.ts` |
| `relaunch-on-answer`: the stdio relaunch after a list answered with a refusal | H12 under S22; `tests/mcp/regress/relaunch.test.ts` |
| `relaunch-races-exit`: no wait for an exit that lags a closed pipe | `tests/mcp/regress/relaunch.test.ts` |
| `forget-exhaustion`: after cleanup refused for good, Start answers the ordinary busy words | H1 under S24 |
| `no-stuck-wake`: an exchange waiting for the slot isn't woken when cleanup is refused for good | H1 under S24, a start parked in its handshake |
| `stop-skips-pending-start`: Stop answers at once while `server_start` is still pending | H2 under S11, during a pending `server_start` |
| `measure-value-only`: the 8 KiB header bound measured on the value, not the whole line | H11 |
| `quadratic-ref-scan`: every declaration compared with every `$ref` target | `tests/mcp/wire-modern.test.ts` (a work count, four times the input) |
| `ready-after-stop`: a start answers ready though Stop came during its catalog write | H15 under S19 |
| `media-prefix`: a media type read by its prefix (`application/jsonp` as JSON) | H10 under S21; `tests/mcp/regress/parse.test.ts` (a lookalike with a body valid for what it looks like, and no read of it) |
| `walk-beside-walk`: a list_changed schedules a walk beside the one under way | H14 under S26 |
| `stop-before-exit`: a local Stop answers once the run has ended, not at the exit | H2 under S11, during initialize |
| `stop-twice`: Stop and the run's end each ask the exe to stop the process | H2 under S11, during initialize |
| `ready-before-drain`: a start answers Ready while its list's exchange still drains | H1 under S27, local and remote; `tests/mcp/regress/start-drain.test.ts` |
| `no-write-bound`: no interim page bound on a local write | H1 under S18 |
| `release-on-refused-cancel`: free the slot on a refused `net_cancel` or stop | H1 |
| `publish-stale-walk`: publish a walk's catalog though `list_changed` came during it | H3 under S14 |
| `decoder-per-chunk`: a new decoder for each read | H10 |
| `cr-forgets-pair`: an LF after a read-ending CR read as an empty line | H10 |
| `late-detach`: detach a held helper at 1.5 s | H4 under S8, pass build |
| `drop-pong-before-flood`: drop a ping silently before a flood | H13, remote and local, and remote in one chunk with its cancel refused |
| `mirror-wrong-value`: a mirrored value that isn't the body's | H11 |
| `era-change-on-recovery`: a re-handshake's modern refusal turns the run modern | H12 under S15 |
| `end-on-refresh-404`: end the run on a refresh page's 404 | H14 under S16 |
| `rearm-in-recovery`: rearm the 404 bound with the re-handshake's own walk | H14 under S17 |
| `body-from-model-args` | H3 |
| `await-before-handoff` | H3, with a revoke scheduled in the await |
| `ignore-fingerprint` | H3 under S1 |
| `no-detach` | H4 under S8, pass build |
| `no-server-cap` | H5 under S10 |
| `accept-any-response-id` | H10 |
| `mirror-previous-call`: mirror `Mcp-Param-*` from the previous call's arguments | H11 |
| `truncate-header`: truncate an over-long mirrored header instead of refusing | H11 |
| `modern-on-any-error` | H12 |
| `initialized-on-modern` | H12 |
| `answer-stray-ping-modern` | H12 |
| `retry-after-input-required` | H12 |
| `session-id-on-modern` | H12 |
| `pong-in-microtask` | H13 |
| `cancel-pongs-at-drain` | H13, and under S2 |
| `resend-404-call` | H14 |
| `rehandshake-every-404` | H14, and under S3 |
| `keep-old-session-id` | H14 |
| `ready-during-recovery`: Ready while a session recovery runs | H14 under S12 |
| `ignore-redirected`: drop the client's `redirected` check | H14 under the redirect mode |
| `question-at-end`: record the question when the run ends, the old shape | H6, H7 |
| `after-failed-continue`: `afterFailedRun: "continue"` | H7 (the run it starts in the failure's own commit is no act of yours; H6 sees it on too few seeds to be its control) |
| `split-answer`: split an answer's check from its `continue` | H7 |
| `answer-any-question`: a late answer to an earlier question answers the one open now, recorded under the task clicked | H7 |
| `answer-recorded-as-open`: the same, recorded under the open question's own task | H7 (the click's question isn't the one answered) |
| `auto-placement`: place queued input automatically after an error | H7 |
| `per-message-send-now` | H7 (its pre-state shows another submission oldest) |
| `hide-send-now`: hide Send now after a fault | H8 |
| `remark-no-failure-check`: drop the `runFailure` check from her line | H9 |
| `answers-by-step`: card answers keyed by step id, not presentation | T7 (i) |
| `revoke-denied-shortcut`: a revoke to Ask over a saved never answered saved at once, without the owner's admission | T3's strictness at reopen |
| `server-always`: a server tool's allow honoured, saved and handed off, the old "always" | G12, in `tests/journal/ground.test.ts` (T9) and `tests/mcp/journal.test.ts` (T7) |
| `own-ignores-fingerprint`: a "may run on its own" grant kept, and honoured, for a tool that changed | G12, in `tests/mcp/journal.test.ts` (T7) |

**Mutations with no control, and why:**

- **`walk-across-recovery`**, letting a walk begun before a session's 404 send its next page after it. With one walk owning the list at a time, and calls refused while the catalog is stale, nothing else can meet a 404 while a walk waits between its pages, so no schedule reaches it. The guard stays, as defence in depth; S20 checks the path a second walk took before.
- **`remark-no-inbox-check`**, dropping the empty-inbox check from her line. On pi-durable 1.5.2 no schedule can reach a failing state: a run's end places queued input, and a failure keeps `runFailure`, so an idle chat with no failure and input queued never exists while the `runFailure` check stands. The check stays, as defence in depth.
- **A queued reset after a step cap**, and an `onYield` continuation. No reset or `onYield` path exists in Familiar to switch on. They're covered by 2.5's module-graph and hook pins only.
- **`background-compaction`**, the default `backgroundTokens`. S6 runs it, but at the journal's 32,000-token window a background summary can't happen before a blocking one: the blocking threshold (32,000 − 16,384) is below pi-durable's default `keepRecentTokens` (20,000), so any history long enough to cut is past blocking first. In both builds the chat compacts only inside a turn, nothing is placed, and H7 holds. S6's evidence for a background summary landing in an idle, failed chat is pi-durable's own probe at a larger window (7.1), with the settings pins (2.5, row 1).

**Named schedules**, run beside the random seeds:

- **S1, a fingerprint change while a card is shown:** the card opens with fingerprint F1 and arguments A; the catalog changes to F2; you answer Yes. H3 sees no handoff, and T7 (h) asserts the card asks again.
- **S2, a ping in the same chunk as the final reply:** its pong is still handed off (H13).
- **S3, a 404 mid-call, then a 404 again** on the re-handshake's first page: the run ends, and nothing more is sent (H14).
- **S4, a kill between the interruption records and `abortTask`.** Not yet a named schedule (section 8).
- **S5, a step cap with a message queued, then a new message, then a delayed Yes** (H6, H7, in the journal harness).
- **S6, a step cap with a message queued in a chat that compacts** (H7, above).
- **S7, two interrupted steps in one round, then a kill, then Run again:** one question lists both, and one answer settles both (T13).
- **S8, Stop then Start while a remote call's POST is still in `net_cancel`** (H1; H4 in the pass build).
- **S9, a duplicated Yes from the first card arriving after the changed tool's card is shown** (T7 (i)).
- **S10, server saturation:** 4 server helpers detached and hung, then each of 24 servers holds a call, then chat fetches a model with 24 server requests open (H5). At 8 detached helpers the exe admits no server request at all, so 8 would never reach saturation.
- **S11, Stop during a walk, or while Ready, then a call, and Stop during a live local call:** nothing reaches the stopping run after Stop, and no reply read after it answers the call; and a local Stop during a pending `server_start`, `initialize` or `initialized`, which answers only after the exit, with one native stop (H2).
- **S12, calls during a session recovery:** each refused as the run not being Ready, until the re-handshake's list completes (H14).
- **S13, a call's time limit, or its stop, ends that call only:** the run stays Ready (T5's named case).
- **S14, `list_changed` on the initial walk, between pages, and before a refresh:** a walk follows before any call (H3).
- **S15, a modern refusal on a re-handshake:** the run ends, still legacy (H12).
- **S16, a 404 on a refresh page:** one fresh `initialize`, the run kept (H14).
- **S17, a 404 on every call:** the second call's 404 ends the run (H14).
- **S18, a local server that stops reading:** the interim bound stops it within 10 s, and the slot frees (H1).
- **S19, Stop and Start during Test:** Test's catalog write is held across a Stop; then it lands, and Start B is admitted in the same step as the owner's release, before Test's own continuation runs. B must answer Ready; Test reports no success, and touches no run but its own (H15).
- **S20, a 404 on a refresh's retry:** a refresh whose page carries `list_changed` tries again, and the retry meets a 404: nothing without the session id goes out before the recovery's `initialize` (H14).
- **S21, answers of other media types:** lookalike and oversized types are never read, and none of their text reaches words (H10).
- **S22, a modern stdio list refused, then an exit:** the refusal decides, with no relaunch (H12).
- **S23, a relist in another property order:** a "may run on its own" grant made on the first listing holds after a Stop and a Start (H3).
- **S24, cleanup refused for good:** every `net_cancel` of a call refused; the slot stays held, and Stop and Start say a restart is needed (H1). And every `net_cancel` of the opening `initialize` refused, with the start parked between its handshake's steps: exhaustion wakes it, and it answers the restart words before its deadline, with nothing more sent.
- **S25, a `$ref` only in schema data:** the tool is still offered (H11).
- **S26, `list_changed` on a refresh's own page:** one retry, and no walk beside it (H14).
- **S27, a call the moment Start answers Ready,** local with the exe acknowledging writes late, and remote with the list's `net_cancel` still pending: the call is admitted and answered (H1).

### 7.3 The exchange machine's exhaustive walk (W)

`tests/harness/walk.test.ts`. The exchange machine (3.4) and its terminal paths are a pure function. The walk explores every interleaving of its inputs for one server, in each era and place: admit, a response, a ping, a pong head, a stream end, a deadline, Stop, a run end, each `net_cancel` returning, each local write completing (the request, a pong, the cancel), a dropped-line `err` event, and a Stop and Start of the same server, as the link does it (the live exchange ends in Stop's own step; the slot carries on), which the clean walk must reach. It allows up to 3 pings (so 2 pongs outstanding, and a flood) and up to two exchanges per path; the modern era has no ping input.

States are deduplicated exactly: a set of the canonical state's JSON, compared by string equality, never by a hash, since a hash can collide and silently drop states. It checks H1's rule (no native request of one exchange open while another's is; the request and two pongs at most, plus a local stop's cancel), and liveness: from every reachable state, once every native request and write has ended and every request kind has its answer or its deadline, the slot is Idle. A write-only exchange gets no answer and has no deadline, so one that waits for a response fails. Its controls are H1's mutations. It models nothing Familiar doesn't own.

### 7.4 The tests, by number

| # | What it covers | Where |
| --- | --- | --- |
| T1 | Types and exports: a `ToolDecision` can't be built or skipped; the client's export list is fixed | `tests/mcp/t-suite.test.ts` |
| T2 | Decisions at the handoff: a cast object, another server's decision, an old fingerprint, a second use, an aborted signal, "never" after minting, and "may run on its own" revoked between mint and handoff each give zero handoffs; a revoke is scheduled at every point before `send`. A fresh decision hands off once | `tests/mcp/t-suite.test.ts` |
| T3 | The owner property: seeded histories of adds, edits, removes, choices and revokes, driven through `McpClient`, each life cut off at a seeded point where every later port and store call hangs, with a choice or revoke now and then left unanswered while the next is made. After repair: no mark left, no unfinished tombstone, the exe's server addresses exactly the remote records', no id or key reused, every removed secret deleted. At each reopen, every key loads a choice at least as strict as the last choice or revoke answered saved, in the order they were made | `tests/mcp/owner.property.test.ts` |
| T4 | One effect at a time, each change's steps and mark, the rollback, tombstones, repair in a fresh start, failing closed (an unreadable choice is "ask"; another version loads nothing), and the address identity: one record for a URL with and without `:443`; a rollback leaves an address it didn't create | `tests/mcp/owner.test.ts` |
| T5 | The runtime, through the real client against the fake server: start, list, call, Stop, a deadline, a crash mid-call (Failed until Start, never resent), remove with a call in flight, plain words for failures; S13 | `tests/mcp/client.test.ts`, the harness |
| T6 | Names over successive catalogs: random adds and removes of servers whose labels clash; `<key>__<tool>` maps to one server and tool for the whole history | `tests/mcp/names.property.test.ts` |
| T7 | A bound yes through the journal: a server call killed mid-call is interrupted, with Run again, and never sent again; every server call asks, and an "always" is refused at save (`server-always` the control); "may run on its own" runs that one tool unasked, a changed fingerprint clears it and a revoke takes it back (`own-ignores-fingerprint` the control); a changed tool asks again, with the facts read now; one server's grant never allows another's saved tool; (h) the catalog changes while the card is shown, and the yes mints nothing; (i) S9, a duplicated Yes from the first card answers nothing on the second; (j) two identical calls, each approved on its own card, each go out once | `tests/mcp/journal.test.ts`, `tests/mcp/client.test.ts`, `tests/mcp/t-suite.test.ts` |
| T8 | Test while running is refused | `tests/mcp/t-suite.test.ts` |
| T9 | No server tool runs without your Yes, whatever a policy says: in a clean chat, her remark included, a policy of allow still shows the card on every call (with "May run on its own" in plain words), and a No sends nothing. The control: `server-always` | `tests/journal/ground.test.ts` |
| T10 | Messages from other windows: a card answer carries a presentation id and a button, nothing else is read, a button not offered is a Skip, and each presentation answers once; a setup can't give Familiar's own headers, in any case | `tests/mcp/windows.test.ts` |
| T11 | One exchange per server, and everything it causes: a remote server that ignores cancellation and trickles; a local server that stops reading with a call larger than the pipe; a priming event then an early end; a large result in many raw chunks reaching the caller whole before the POST is cancelled; local cancel writes held in their exchange. The pass build adds the exe's write bound with the renderer killed, and the runner's `net.total-deadline` | `tests/mcp/wire.test.ts`, `tests/mcp/wire-modern.test.ts` |
| T12 | Reservations: one fresh grant for one ref of a saved server, held until acknowledged by its id and ref, used once; a grant never acknowledged holds the owner until the exe restarts, and is nothing after | `tests/mcp/windows.test.ts` |
| T13 | The journal on this ground, against the real pi-durable: the question view's every row, closed by an answer record; her line in every state (quiet, mid-turn, after a stop with a message queued, after a failure, at a paused cap) is the right kind of write and never starts a run; every answer row of 2.3; a new message closes an open question in its own commit, and a delayed Yes then does nothing; a No with a message queued charges the new run to that message's turn; a bare "ok" leaves a question open; Send now on a queue of three sends the oldest; S7; a cap pause inside a blocking compaction reads as a cap question; the recovered-run gate; every row of 2.5; card turnover, and chat text settling nothing | `tests/journal/ground.test.ts`, `tests/journal/pins.test.ts` |
| T14 | The wire against the fake server, both eras, counted at the server. Legacy: pings on every exchange kind, two concurrent, a third, 40 sequential; 17 pages; an unsupported request; a 404 session; a stream ended early; invalid answers; a session id too long, non-ASCII or doubled; each message kind's malformed shapes; events split across reads, empty events and a dropped long line; a version outside the list; the opening's `-32022` in each recorded form, each turning modern and adopting no session id; 307 and 303 under the redirect mode. Modern: a modern-only server, remote and local (both stdio paths), reaches Ready with no discover and no `initialized`; a both-era server stays legacy; the mirrored tools, the non-ASCII value included, pass the server's validation; the `number`-header tool isn't offered and Test says why; `input_required` and an absent `resultType` are tool errors with no retry; a stray ping gets nothing. No GET, `DELETE`, error reply or remote cancel is ever seen | `tests/mcp/t-suite.test.ts`, `tests/mcp/wire.test.ts`, `tests/mcp/wire-modern.test.ts` |

On the Windows runner, through the real exe, the `proc-mcp` checks run the same client in the real core page under the real CSP, with `mcp.legacy-transport` and `mcp.modern-transport` counting requests at the fake server. The native pass adds, first, `net.no-redirect`, `net.tls-egress` and `net.pool-retry` (4.4, 4.5), then `net.helper-detach`, `net.server-cap`, `server.write-bound` (with the relaunch held back) and `net.total-deadline`.

Each build reports seeds run, checks passed and mutations failed (every one with a control must fail), plus the runner's results.

## 8. What stays hard

- **Familiar's own protocol code.** The handshake, the event-stream parser and the validation of untrusted shapes are Familiar's. They're covered by T14, by the harness's chunking over the parser, and by `mcp.legacy-transport` on the runner. Whether the official conformance package can drive a client not built on the SDK is unverified.
- **P2 rests on pi-durable 1.5.2's semantics**, pinned exactly. An upgrade must recheck 2.5 against the new spec, and run 7.1's tests and T13 again. If a later step ever wants an `afterRun` hook, P2 must be revisited first.
- **The named departures:**
  1. a ping flood ends its exchange;
  2. a local ping during a blocked write or a drain gets no pong;
  3. no cancel is sent to a remote legacy server;
  4. no session `DELETE`;
  5. a ping after the final response on its stream gets no pong;
  6. a pong handed off in time can still be lost to its own native failure, `busy` from the server cap included.
- **The re-handshake on 404** is one per drop, so a server that drops sessions often costs one handshake each time. A call cut by the drop is never resent: you ask again.
- **The interim before the native pass** (4.3).
- **On modern servers the catalog refreshes only at start and on Test** (3.8b). A tool the server changed in between is still called as you consented to it, against the tool as last listed. A legacy server has the same exposure between `list_changed` notifications.
- **The modern era's evidence.** The TypeScript SDK's servers were run; rmcp's behaviour is read from its source, and `mcp.modern-transport` is its first run. go-sdk and mcp-go never refuse a legacy `initialize`, so in practice only TypeScript SDK and rmcp servers can be modern-only.
- **Header mirroring** follows the TypeScript SDK's reading of the spec. Its edge cases are checked against the fake server's validation, which is written from that same reading.
- **A revoke not saved is lost at a restart.** You're told, and the saved choice holds after the restart.
- **Structured output isn't schema-checked.** A tool's `structuredContent` goes to the model as bounded, untrusted JSON, without validation against its `outputSchema`. A validator that needs no code generation could add it later.
- **Chat's reserved share is held against servers, not against chat itself.** Her line, the decider's bigger model and a turn can together use the 8 (4.1).
- **Wire behaviour still unmeasured:** whether Windows fetches certificate data outside the saved address, and whether pooled lan or loopback connections are retried (4.5). Each has a runner check. Behind a proxy, "one POST" holds at Familiar's side only.
- **Background compaction is off.** In a long chat, a reply waits for its summary.
- **A secret holding a quote, or another character JSON escapes, isn't blanked from a server's JSON output.** The exe blanks literal copies only. The fix is the exe's, in the pre-release native pass, and `mcp.secret-json-escaped` holds the gap open on the runner as a known gap ([shell-design.md](shell-design.md#5b-starting-a-local-mcp-server)).
- **S4 isn't a named schedule yet.** A kill between the interruption records and `abortTask` is argued in 2.2: pi-durable resumes the task, and the hook writes the same records again.
- **Defects the harness found**, both fixed in the build:
  - a pong counted as outstanding only until its head let one exchange hold 5 native requests. A pong now counts until its native end (3.7; `05cf3df`);
  - a local run that ended for a reported reason kept its process alive. A local run that ends now stops its process, and its writes end at the exit (3.9; `2082356`).
