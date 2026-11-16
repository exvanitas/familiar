# Familiar's moments: when she speaks first

Design, 2026-11-16. The owner's list of moments for unprompted chat, agreed on 11-16: "go on familiar chat, looks good to me. that goes into the capability matrix I told you for familiar." This file settles the event names, the fields each event carries, the decider's rule for `chat`, and examples. The capability matrix rows are in [design.md](design.md#the-capability-matrix), and the portrait that gives `gesture` and `bubble` a home in part 1 is in [design.md](design.md#where-reactions-show-in-part-1).

It's also the spec for the Claviger data wave that teaches `chat`: the rule text, the new event types for the validator, and timelines with the right act.

## The idea in one paragraph

A few moments open a day or a conversation: the first time you're at the PC today, a special day, coming back after an hour or more, a question of hers left hanging, and (later, opt-in) a new device or a known app. Only those moments may ever get `chat`. Each arrives as its own event, made by core from signals the exe already has, so the decider never has to piece a moment together from raw system events. Everything else keeps its rules unchanged.

## Signals: what core reads

Part 1 needs nothing new in the exe. Every part 1 moment comes from signals built in step 3 and core's own data:

| Signal | From | What it is |
| --- | --- | --- |
| Idle time | `system()`'s `idleMs`, from `GetLastInputInfo` | One number: milliseconds since any key or mouse input anywhere. Not which key, not where, not which app |
| Fullscreen, presentation, Windows quiet time | `system()`'s `userState` | Do-not-disturb, next to Familiar's own setting |
| Woke from sleep | the `system` message on resume (`WM_POWERBROADCAST`) | A fact, with no detail |
| Started at sign-in | `shell_info().autostarted` | The Run entry started it |
| Last seen | core, in its own store | The last time you were at the PC while Familiar ran |
| Her last message asked something | core's chat log and step 5's `endsWithQuestion` | Local, no model call |
| You said goodbye | a local check like the acknowledgement check, with a goodbye list | Local, no model call |
| Special days | a holiday list in the app folder, your birthday and her setup date if known, dates in memory notes | Data, updatable without an exe |

Later, opt-in, with a new exe: new devices (class only) and installed apps (matches against a small known list). See [device-added and app-installed](#later-opt-in-device-added-and-app-installed).

**Idle under fullscreen or presentation doesn't count as away.** Watching a film is not being away, so core starts the away clock only when no fullscreen or presentation state covered the stretch. Session lock isn't read: the idle number already grows while the PC is locked, and typing the password ends it.

## The presence coordinator: one moment at a time

When you show up (input after idle, a wake, a sign-in start, Familiar opened by hand), core makes **at most one** moment event, the first that applies:

1. `day / special-day` if today is a special day and she hasn't greeted you today.
2. `day / first-hello` if she hasn't greeted you today.
3. `app / question-unanswered` if her question is open (rules below).
4. `system / back-after-long` if you were away 60 minutes or more.
5. `system / back-after` if you were away 20 to 59 minutes (as now).

The day starts at 04:00 local, so someone up at 00:30 isn't greeted for a new day. The raw facts (`wake`, `unlocked`, `app-started`, `fullscreen-off`) still go to the decider as they happen, and stay quiet: the moment, if any, follows as its own event.

**Held, not lost.** A once-a-day moment (special-day, first-hello) that would land while do-not-disturb, fullscreen or presentation is on, or while she's sent home or hidden, is held and offered at the next presence after that ends, the same day. So each day has exactly one, and the decider rarely meets one under do-not-disturb. The decider's rule 1 still says quiet if it does.

**Retired names.** Core stops sending `app / first-open-today` (replaced by `first-hello`) and stops sending `back-after` for 60 minutes or more (that's `back-after-long` now). The names stay in the type list, so older data still reads.

## The events

New types, none of them rule events (every one is a decision point and carries a label). `detail` is the exact text core renders for the model, and the text writers use in timelines.

| Source / type | When core sends it | Fields (`PersonaEvent`) | `detail` |
| --- | --- | --- | --- |
| `day / first-hello` | The first presence of the local day, held through do-not-disturb | `cause`: `sign-in`, `wake`, `back`, `app-start`. `lastSeenMinutes` | `"<cause>, last seen <gap>"`: `"wake, last seen 9 h ago"`, `"sign-in, last seen 3 days ago"` |
| `day / special-day` | In place of first-hello, on a special day | `cause`, `lastSeenMinutes`, `day`: `{ kind, name? }`. `kind` is `holiday` (with `name` from the holiday list), `birthday` (yours), `setup` (a year, or more, since she was set up), `remembered` (a date in a memory note, never its text) | `"<day>, <cause>, last seen <gap>"`: `"Christmas, sign-in, last seen 10 h ago"`, `"your birthday, wake, last seen 8 h ago"`, `"a year since setup, back, last seen 14 h ago"`, `"a remembered date, sign-in, last seen 11 h ago"` |
| `system / back-after-long` | Away 60 minutes or more, same day, no once-a-day moment due | `minutesAway` | `"away <gap>"`: `"away 1 h 40 min"` |
| `app / question-unanswered` | Her last message asked something, 20 minutes or more ago, nothing from you since, and you're at the PC (input in the last 2 minutes) or just came back. Once per question | `minutesSinceAsked`, `minutesAway` (if you just came back) | `"asked <gap> ago"`, or `"asked <gap> ago, you were away <gap>"` |
| `system / device-added` | Later tier, opt-in. A device of a known class, never seen on this PC before, was plugged in | `deviceClass` | `"new <class>"`: `"new game controller"`, `"new headset"` |
| `system / app-installed` | Later tier, opt-in. An app from the known-app list appeared | `appName` (from the list only) | the app's name: `"Steam"`, `"Blender"` |

`<gap>` is written as minutes below an hour (`"40 min"`), hours and minutes below a day (`"1 h 40 min"`, `"9 h"`), and days after that (`"3 days"`). `first-hello` after `"last seen 2 days ago"` or more is the [big](#the-chat-rule) one.

**question-unanswered is never sent** if: you sent anything since her question; your message before her question was a goodbye; you closed the chat window after her question was on screen (you saw it and left); the question is more than 8 hours old, or the day started since; she's already followed up on it once.

**No chat after a goodbye.** After you say goodbye (`app / message-sent` with detail `"a goodbye"`), nothing gets `chat` until the next first-hello or special-day. A bubble at most.

### Later, opt-in: device-added and app-installed

Both need native reads the exe doesn't have, so they're a later tier, off by default, batched with the next exe (with OAuth and the UI Automation tier). Their names are fixed now so the training data covers them. About 3 hours when that exe comes: 2 native, 1 in the app and Settings.

- **Devices**: the exe watches device arrival and reports only a class from a fixed list (game controller, headset, speakers, microphone, webcam, drawing tablet, phone, keyboard, mouse, display, printer, storage). Never a name, a maker or a serial number. "Never seen before" is kept as salted hashes of device ids in the PC-tied data, never exported. A known device plugged in again sends nothing.
- **Apps**: the app passes the exe its known-app list (a small file in the app folder, about 20 names, such as Steam, Spotify, OBS Studio, Blender, Krita); the exe reads the installed-apps entries and answers only which of those names are present. The full list never leaves the exe. Checked at start and every 6 hours.

Nothing from either is ever sent anywhere: the app's network is closed to everything but the places you approved.

## The chat rule

This is the rule file for the data wave (plain text, appended to the writer and labeller prompts), and the rules decider's new rules, word for word:

> Only six events can ever get `chat`: day first-hello, day special-day, system back-after-long, app question-unanswered, system device-added, system app-installed. No other event gets `chat`, whatever happens. At these six, the act follows chattiness: high `chat`, medium `bubble`, low `gesture`. Two are big and go one step up (high and medium `chat`, low `bubble`): special-day, and first-hello after 2 days or more away. Kinds: first-hello and back-after-long `greet`; special-day `celebrate` for a holiday, birthday or setup day, `greet` for a remembered date; question-unanswered `curious`; device-added `curious`; app-installed `playful`. The usual rules still win: fullscreen or do-not-disturb, or sent home, hidden or paused, is quiet. If she reacted in the last 2 minutes, question-unanswered, device-added and app-installed are quiet; first-hello, special-day and back-after-long still go ahead. At most 2 unprompted chats a day: once she has sent 2 today, a `chat` drops to `bubble`. After the person says goodbye (message-sent, "a goodbye"), no `chat` until the next first-hello or special-day: a `bubble` at most. back-after is never `chat`: it's 20 to 59 minutes away and keeps its rule. wake, unlocked, app-started and fullscreen-off are facts, quiet: a moment, if any, comes as its own event after them.

The rules decider does the same in code. Core also enforces the daily cap and the goodbye rule itself, so a model decider can't exceed them.

**What `chat` does.** Core starts a turn with no message from you, only a note of the moment and its kind ("first hello of the day, greet"; "her question is still open, curious"; "Christmas, celebrate"). The model writes the message with memory and the card as in any turn, and it's one model call on your key, at most two a day. If the chat is hidden, the tray shows that she wrote, and the portrait shows a bubble pointing at it.

## Why the existing data stays good

The Claviger Familiar pool (key1, 21,254 points) has no `chat`. The rule above gives `chat` only to new types, and changes no existing type's rule, so none of those points goes stale:

- `back-after` keeps "greet once, gesture at low, bubble at medium or high". key1 has 37 high-chattiness points with 60 minutes or more away, labelled bubble or quiet. Core won't send `back-after` for 60 or more any more, so those never meet a live event.
- `first-open-today` keeps its points (711, greet as gesture or bubble). Core won't send it any more. Mapping them to `first-hello` is possible at low and medium, where the labels match the new rule, but not at high (201 points, where first-hello is now `chat`). Leaving key1 byte for byte is simpler.
- `long-session` stays a bubble nudge. Making it `chat` at high would make 131 key1 points stale, and a nudge to sleep doesn't need the chat.
- `wake` and `unlocked`: key1 already labels them quiet (about 95%), which is what the rule says.

## For the data worker: the validator change

`schemas.py`, `EVENTS`:

```python
"app": (... existing ..., "question-unanswered"),
"system": (... existing ..., "back-after-long", "device-added", "app-installed"),
"day": ("first-hello", "special-day"),
```

None goes in `RULE_EVENTS`. The writer prompt also says: don't use `first-open-today`; `back-after` only for 20 to 59 minutes away (or shorter, labelled quiet); the `detail` formats above; at most 2 chats per timeline-day; and after a goodbye, `message-sent` carries detail `"a goodbye"`.

Two checks the validator can add cheaply: `chat` only on the six types; and no more than 2 `chat` labels per timeline.

**Names that differ today between core and the kit.** Core's `session-unlocked`, `playback-paused`, `playback-stopped` are the kit's `unlocked`, `paused`, `stopped`; core has `ack-sent` and `bubble-dismissed`, the kit has `time-of-day`. A model decider's adapter maps them. The new names here are the same in both.

## Examples

Short timelines: the lead-up, then the moment, with its right act. Times are 24 h. `→` marks the label; unlabelled lines are context already labelled earlier.

### first-hello

1. Medium chattiness.
   - 07:42 system wake → quiet
   - 07:42 day first-hello "wake, last seen 9 h ago" → **bubble greet**
2. High.
   - 08:15 app app-started → quiet
   - 08:15 day first-hello "sign-in, last seen 11 h ago" → **chat greet**
3. High, do-not-disturb still on from last night.
   - 08:30 app app-started → quiet
   - 10:30 system dnd-off → quiet
   - 10:30 day first-hello "sign-in, last seen 13 h ago" → **chat greet** (held through do-not-disturb, offered after)
4. Medium, after a long weekend away: big.
   - 08:50 system wake → quiet
   - 08:50 day first-hello "wake, last seen 3 days ago" → **chat greet**

### special-day

1. Low.
   - 09:10 day special-day "Christmas, sign-in, last seen 12 h ago" → **bubble celebrate**
2. Medium.
   - 07:30 system wake → quiet
   - 07:30 day special-day "your birthday, wake, last seen 8 h ago" → **chat celebrate**
3. High, a remembered date.
   - 10:05 day special-day "a remembered date, back, last seen 14 h ago" → **chat greet**
4. High, do-not-disturb came on just as it arrived (core holds these, but rule 1 still says quiet if one gets through).
   - 08:00 system dnd-on → quiet
   - 08:01 day special-day "a year since setup, sign-in, last seen 10 h ago" → **quiet**

### back-after-long

1. High.
   - 12:05 system idle-start → quiet
   - 13:20 system back-after-long "away 1 h 15 min" → **chat greet**
2. Medium.
   - 13:20 system back-after-long "away 1 h 15 min" → **bubble greet**
3. High, two chats already today (first-hello at 08:10, a question follow-up at 11:00).
   - 15:40 system back-after-long "away 2 h" → **bubble greet**
4. High, near miss: under an hour.
   - 14:48 system back-after "away 52 min" → **bubble greet** (back-after is never chat)

### question-unanswered

1. High. She asked at 16:00, the chat went behind another window.
   - 16:00 app reply-done-hidden → gesture inform
   - 16:25 app question-unanswered "asked 25 min ago" → **chat curious**
2. Medium, coming back.
   - 17:10 system idle-start → quiet
   - 18:05 app question-unanswered "asked 1 h 10 min ago, you were away 55 min" → **bubble curious**
3. High, she reacted a minute ago.
   - 19:31 buddy clicked → gesture playful
   - 19:32 app question-unanswered "asked 30 min ago" → **quiet**
4. Low.
   - 21:15 app question-unanswered "asked 40 min ago" → **gesture curious**

### device-added (later tier)

1. High.
   - 20:02 system device-added "new game controller" → **chat curious**
2. Medium, in a fullscreen game.
   - 20:40 system fullscreen-on → quiet
   - 20:41 system device-added "new headset" → **quiet**
3. Low.
   - 11:12 system device-added "new drawing tablet" → **gesture curious**

### app-installed (later tier)

1. Medium.
   - 22:05 system app-installed "Steam" → **bubble playful**
2. High, after a goodbye.
   - 23:40 app message-sent "a goodbye" → (rule event, no label)
   - 23:52 system app-installed "Krita" → **bubble playful** (no chat after a goodbye)
3. High, she greeted a minute ago.
   - 09:01 day first-hello "sign-in, last seen 10 h ago" → chat greet
   - 09:02 system app-installed "Spotify" → **quiet**

### Near misses for every wave

- 23:30 clock long-session (late night, high) → bubble nudge, never chat.
- 10:00 system dnd-off (high) → as key1: quiet, or a greet bubble after a long stretch. Never chat.
- 07:42 system wake (high) → quiet. The first-hello right after it is the moment.
- 14:00 app question-unanswered under do-not-disturb → quiet. (device-added and app-installed aren't held: under do-not-disturb they're simply quiet.)

## Not in this round

- **Do-not-disturb just ended, when you'd said what you were doing.** Dropped. It needs a "you told her" flag only the chat model could set, and the clean version already exists: ask her for a reminder ("ask me how it went at 3"), which is a fixed rule.
- **Late-night long session as chat at high.** Stays a bubble (see above).
- **Lock and unlock as their own signal.** Not needed: the idle number covers them. If a later feature needs them, they ride the next exe.

## Where it's built

Step 10b in the [build order](design.md#build-order): the presence coordinator, the six events and their holds, the goodbye check, the holiday list and memory dates, the unprompted turn, the daily cap, the rules decider's new rules, and tests with a fake clock and fake system signals. The portrait and the bubble's fallback are step 11b.
