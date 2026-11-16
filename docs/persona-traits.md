# Her personality: traits that steer when she speaks

Design, 2026-11-16. The owner, on the moments design: "but all of this relies on personality too. is our labelling taking that into account? we might be missing something more crucial, that character cards can vary here". Then: "go, let's be thorough about this as best we could." The lead's proposal, which he agreed: the rules stay hard limits; inside them a few traits read from the card steer the decision; chattiness defaults from the card and the person can change it; the decision data teaches traits with contrast pairs.

This file defines the traits, what each one does to each moment, how they're read from a card, how the decider gets them, and how they're tested. [moments.md](moments.md) has the moments themselves, and [design.md](design.md#the-decision-slot-should-the-persona-react) the decision slot.

## The problem, measured

Today the decider sees a one-line sketch, her interests and chattiness. The Claviger Familiar pool (key1: 21,254 decision points, 1,256 timelines, 1,020 different sketches) shows what that buys:

| Sketch reads as | Low | Medium | High |
| --- | --- | --- | --- |
| Outgoing (cheerful, hyper, dramatic, loud...) | 22.0% | 24.9% | 28.2% |
| Reserved (shy, calm, quiet, soft-spoken...) | 22.1% | 24.2% | 26.6% |
| Grumpy or dry | 19.8% | 23.5% | 27.7% |
| Neither | 21.3% | 24.8% | 28.8% |

That's the share of points where she reacts at all. The mix of acts and kinds doesn't move either: at medium, every temperament gets bubbles at 13.6 to 13.7% and gestures at 10.5 to 11.2%. Chattiness moves everything, and temperament moves nothing. The writers and labellers followed the rules and chattiness, because nothing told them how a persona should change an answer. So a grumpy, aloof cat and a clingy fairy behave the same, and a model trained on this would learn to ignore the sketch.

## What never changes

These hold for every persona, whatever the card says:

- Fullscreen, presentation, Windows' quiet time, a locked PC or her own do-not-disturb: quiet.
- Sent home, hidden or paused: quiet until you call her out.
- Rule events keep their fixed handling: a message you send gets a reply, a reminder fires, a consent card shows, an error shows. Consent never rides on a trait.
- A bare "thanks" or "ok" gets no spoken line. A gesture at most.
- She reacted in the last 2 minutes: quiet, unless something bigger happens.
- The bubble spacing (one per 30, 10 or 5 minutes by chattiness), the cap of two unprompted chats a day, and no chat after a goodbye. These apply to every persona against her own recent reactions, after any trait has moved her.
- Only the [chat events](moments.md#the-chat-rule) can ever get `chat`.
- Care stays the same for everyone: the late-night nudge, the daytime break nudge, comfort when a tool failed, and a reply or tool that finished while the chat was hidden.
- Plain facts stay quiet: wake, sleep, lock, unlock, idle starting, fullscreen or do-not-disturb coming on, a meeting starting, the chat opening.

## The traits

Three traits and her interests. Each trait has three values, and the middle one is neutral: a persona with all three neutral behaves exactly as Familiar does today.

| Trait | Values | It's about | It steers |
| --- | --- | --- | --- |
| Sociability | `reserved`, `even`, `outgoing` | How much she comments on the world | Things happening: music, a tool that finished while you watched (the chat in front), the app starting, a meeting soon, fullscreen ending, the time of day, a new device or app. And the chattiness her card suggests |
| Closeness | `aloof`, `warm`, `clingy` | How much she seeks you | Greetings and returns, her own open question, and your attention: a click, a pick-up, the chat closing, a bare thanks, being shown or resumed |
| Lively hours | `morning`, `any`, `night` | When she's at her best | Everything the other two steer, by the clock |
| Interests | up to 5 short phrases | What she likes | Music whose mood matches (as now), and a new app she knows |

**Why these three.** They're what a card says most often about how someone behaves when nobody asked them anything, and each maps onto moments Familiar already has. Sociability and closeness are separate on purpose: a shy fairy who adores you (reserved, clingy) and a loud gremlin who ignores you (outgoing, aloof) are both common cards, and they react to opposite things. Lively hours is the one trait that needs the clock, and the decider already has the local hour.

**What was left out.** A tone or mood trait (gentle, playful, dry): the kind of a reaction comes from the event, and how she sounds is the chat model's job, from the whole card. A per-day mood: random by design, so it can't be tested or taught. A trait per moment: too many to read from a card or set by hand.

**Interests, matched exactly.** Compared trimmed and in lowercase. Music: an interest equal to the track's mood tag, as now. A new app: each entry in the known-app list carries its name and two or three interest words (Krita: drawing, painting, art). The app is among her interests when one of her interests equals its name, or contains one of its words as a whole word, so "digital painting" matches Krita. The list is a file in the app folder, and the same list goes to the data writers.

**Lively hours, exactly.** A morning person is lively from 05:00 to 11:59 and sleepy from 21:00 to 03:59. A night owl is lively from 20:00 to 03:59 and sleepy from 05:00 to 11:59. 04:00 to 04:59 is neither, since the day starts at 04:00.

## Chattiness: her card suggests, you decide

Chattiness stays the person's setting, because it's about how much they want to hear. Her sociability only suggests where it starts: `reserved` low, `even` medium, `outgoing` high. First-run setup shows the suggestion, and so does Settings ("suggested by her card: low"). Once you've picked one yourself, a new reading of the card never changes it.

**Chattiness sets the most she says. Traits set where she says it, and how present she is in between.** A trait never lifts an act past chattiness' own top rung (gesture at low, bubble at medium, chat at high), and the bubble spacing and the daily chat cap bind every persona the same. So at low a trait never adds a word, and above low it adds only what the spacing allows. That's the one rule the rest follows from.

## How a trait moves an act

Acts sit on a ladder: quiet, gesture, bubble, chat. Every persona's answer comes from the same five steps, in this order. Each step looks only at the event, the context and her own past reactions, so two personas on the same timeline can differ later because they differed earlier.

1. **Blockers.** Do-not-disturb, fullscreen, presentation, quiet time, a locked PC, or sent home, hidden or paused: quiet. Rule events keep their fixed handling. Nothing else is looked at.
2. **The intent.** The rules' answer for a neutral persona in the plain case, before anything that depends on her own recent reactions: what she'd do if she hadn't reacted to anything lately. The first song of the day is `bubble playful`, a click `gesture playful`, the chat closing `quiet`, `back-after-long` at high `chat greet`. Care events (the late-night nudge, the daytime break nudge, `tool-failed`, a reply or tool finishing while the chat is hidden), plain facts, and a `back-after` under 20 minutes (which core never sends; the data has them as near misses) keep their intent: no trait moves them. So does any event no trait steers.
3. **The move.** Each trait that steers this event gives up, down or none. Closeness: aloof down, clingy up. Sociability: reserved down, outgoing up. Lively hours: up in her lively hours, down in her sleepy hours. A new app among her interests: up. Add them, and keep the total to one rung: up, down or none. An aloof morning person at 08:00 cancels out.
   - **Down** is one rung lower. A first hello and a special day never go below a gesture: once a day she acknowledges you, however aloof.
   - **Up** is one rung higher, but no higher than chattiness' top (gesture at low, bubble at medium, chat at high), and no higher than the event's limit: a gesture at most for a click, a pick-up, the chat closing and a bare thanks; a bubble at most for `back-after` and anything that isn't a chat event; chat only at the chat events. A limit at or below the intent means no move: up never lowers.
   - **From quiet.** Things happening never go up from quiet. A song that the rules leave quiet stays quiet, however outgoing she is, or she'd react to every track change. Greetings, returns, her question and your attention can go from quiet to a gesture: a clingy persona waves when you close the chat.
   - An act above chattiness' top is only ever the intent itself: the two big moments at low and medium, and the late-night nudge at low. A move never makes one.
4. **The limits**, on her own history, whatever the move did:
   - She reacted in the last 2 minutes: quiet, except at a first hello, a special day, `back-after` and `back-after-long`.
   - A music bubble when her last reaction was a music bubble: quiet.
   - The late-night nudge: one a night, counted from 23:00 to 05:00, so it doesn't reset at 04:00. Another is quiet.
   - Two unprompted chats already today (the day starts at 04:00), or a goodbye since the day's first hello: a `chat` becomes a `bubble`.
   - Spacing: a `bubble` within her chattiness' gap (30, 10 or 5 minutes) after her last bubble or chat becomes a `gesture`. A bubble that came from a move down or from a chat falling back is no exception. A `chat` is never held back by spacing, only by the daily cap.

   They run in that order, so a chat that falls back to a bubble can still become a gesture.
5. **Kind.** The intent's kind stays. A reaction that rises from quiet takes the event's kind: `greet` for a greeting, a return or the chat closing, `playful` for a click or a pick-up.

In core, `decideByRules` becomes step 1, the intent, then one pure function, `steer(intent, event, context)`, for steps 3 to 5. Today's rules decider mixes its spacing and settle checks into the intent. Step 10b moves them into step 4, so they apply after the traits as well as before. A model decider later gets the traits and [the summaries](#how-the-decider-gets-them) as input, and gives the final act itself.

**Base rules step 10b adds**, so the neutral intent matches the label rules where today's rules decider is silent or off:

- `calendar / meeting-soon`: `bubble inform` at medium and high, quiet at low.
- A bare thanks (`ack-sent`): `gesture greet`, a smile back. Today it's `gesture none`, and the label rules allow `none` only with quiet.
- The daytime break nudge (owner, 2026-11-16: "daytime break nudge, sure"): once per long session, a bubble at medium and high, a gesture at low, never chat ([moments.md](moments.md#why-the-existing-data-stays-good)). It's care, like the late-night nudge: no trait moves it.

**"A gesture at most" events.** At a click, a pick-up and the chat closing, the neutral intent is a judgment call, quiet or a gesture: key1's labellers split on them (a gesture at 42% of medium chat closings). Where the traits' net move is down, the answer is quiet from either intent; where it's up, a gesture from either (the limit). Where the moves cancel (an aloof morning person at 08:00), she does what the neutral persona does, so either is right there too. The rules decider picks one (a click a gesture, the others quiet), and the data accepts either for the neutral persona.

## What each trait does at each moment

Each table gives the neutral intent in the plain case (nothing in the last 2 minutes, no bubble inside the gap, no chats yet today), then what the trait changes it to. The limits in step 4 still apply after. Times are the person's local time.

### The moments that can chat

| Event | Chattiness | Neutral | Aloof | Clingy |
| --- | --- | --- | --- | --- |
| `day / first-hello` | low | gesture | gesture (the floor) | gesture (low's top) |
| | medium | bubble | gesture | bubble (medium's top) |
| | high | chat | bubble | chat |
| `day / first-hello`, 2 days or more away (big) | low | bubble | gesture | bubble |
| | medium | chat | bubble | chat |
| | high | chat | bubble | chat |
| `day / special-day` (big) | low | bubble | gesture | bubble |
| | medium | chat | bubble | chat |
| | high | chat | bubble | chat |
| `system / back-after-long` | low | gesture | quiet | gesture |
| | medium | bubble | gesture | bubble |
| | high | chat | bubble | chat |
| `app / question-unanswered` | low | gesture | quiet | gesture |
| | medium | bubble | gesture | bubble |
| | high | chat | bubble | chat |

Lively hours does the same as closeness at these moments: a night owl's hello at 07:30 is the aloof column, a morning person's is the clingy one. Combined with closeness, one rung at most: an aloof night owl at 07:30 still drops only one rung, and an aloof morning person at 07:30 is neutral.

`system / device-added` and `system / app-installed` (later, opt-in) follow sociability instead: reserved one down, outgoing one up, with the same limits: up to a gesture at low, a bubble at medium and a chat at high, and down as far as quiet. A new app among her interests also counts one up, so a reserved persona and an app she loves cancel out.

The late-night nudge (`clock / long-session` at night) has no column: it's care, so it's bubble at low and medium, chat at high, for everyone.

### Returns and your attention (closeness)

| Event | Neutral (medium) | Aloof | Clingy | Limit |
| --- | --- | --- | --- | --- |
| `system / back-after` (20 to 59 min) | bubble greet | gesture | bubble | bubble, never chat |
| `system / dnd-off`, where the rules greet | bubble greet | gesture | bubble | bubble |
| `buddy / clicked` | gesture playful (or quiet, a judgment) | quiet | gesture | gesture (petting) |
| `buddy / picked-up` | quiet (or a gesture, a judgment) | quiet | gesture playful | gesture |
| `app / chat-closed` | quiet (or a gesture, a judgment) | quiet | gesture greet (a wave) | gesture |
| `app / ack-sent` (a bare thanks) | gesture greet | quiet | gesture | gesture |
| `buddy / shown`, `buddy / resumed` | quiet | quiet | gesture greet | bubble |

At low, the same moves apply with low's top: a clingy return at low stays a gesture, an aloof one goes quiet. At high, the same as medium, since none of these can chat.

### Things happening (sociability)

| Event | Neutral (medium) | Reserved | Outgoing |
| --- | --- | --- | --- |
| `music / playback-started`, first play today | bubble playful | gesture | bubble |
| `music / track-changed`, mood matches her interests | bubble curious | gesture | bubble |
| `music / track-changed`, no match | quiet | quiet | quiet (never up from quiet) |
| `app / tool-done` with the chat in front | gesture celebrate | quiet | bubble (if the spacing allows) |
| `app / tool-done` with the chat hidden | the teaser rule: gesture or quiet | the same | the same (care) |
| `calendar / meeting-soon` | bubble inform | gesture | bubble |
| `app / app-started`, `system / fullscreen-off`, `clock / time-of-day` | quiet, unless the rules give a reaction | one down from it | one up from it |

### Cases where persona flips the act

1. **The aloof hello.** At medium an aloof persona gives the day's hello as a glance, not a line (bubble to gesture), and at high a bubble instead of a chat. The lead's example was "aloof personas skip the first hello at medium". She skips the spoken hello but not the glance. With the floor, a person with an aloof card and low chattiness still sees her notice them once a day, and the three chattiness levels stay distinct.
2. **Petting.** An aloof cat ignores a click, and a clingy one leans in. A clingy persona waves when you close the chat. Nobody speaks: these are gesture-at-most events.
3. **Her question.** An aloof persona doesn't chase a question you left hanging (bubble to gesture, chat to bubble). A clingy one at high still writes.
4. **The clock.** A night owl's 07:30 hello drops a rung, and a morning person dozes through a 22:30 click. The late-night nudge is the same for both.
5. **The world.** A reserved persona meets the first song of the day with a sway instead of a line. An outgoing one remarks on a tool that finished in front of you.
6. **Cancelling out.** An aloof morning person at 08:00 greets like a neutral one. A reserved persona and an app she loves cancel out.

## The effect on the same timelines

To give the contrast pairs targets, the five steps were run over all 1,256 key1 timelines, each kept at its own chattiness. key1's labels are finals, not intents, so each one stood in for the neutral intent, and step 4's limits were then applied against each persona's own reactions as they came: the settle, music, the daily cap and the gap. Not the nightly nudge or the goodbye, which key1 rarely meets, and no kinds. That's an approximation: a key1 quiet that a limit caused can't be told from a quiet the rules chose. The neutral persona itself changes on 0.3% of points, where key1's labellers broke a limit or the new lock rule applies. key1 has no chat moments yet, so `first-open-today` stood in for the first hello. Five personas:

| Persona | Points changed | Reacts (low / medium / high) | Words: bubble or chat (low / medium / high) |
| --- | --- | --- | --- |
| Neutral (even, warm, any) | 0.3% | 21.7 / 24.5 / 27.9% | 3.3 / 13.5 / 17.3% |
| Aloof cat (reserved, aloof, night) | 13.7% | 13.3 / 19.3 / 22.2% | 1.7 / 5.3 / 6.6% |
| Cool show-off (outgoing, aloof, any) | 14.3% | 10.8 / 17.0 / 20.1% | 3.2 / 6.9 / 10.4% |
| Shy friend (reserved, warm, any) | 5.0% | 21.1 / 24.0 / 27.8% | 1.2 / 9.4 / 10.9% |
| Clingy fairy (outgoing, clingy, morning) | 6.4% | 27.1 / 28.7 / 31.8% | 3.3 / 13.8 / 17.6% |

At medium the spread in reacting goes from 24.2 to 24.9% today to 17.0 to 28.7%. For every persona, chattiness still orders the words: more at medium than at low, more at high than at medium. Some event-level targets at medium (share of points, neutral, then the aloof cat, then the clingy fairy):

- First hello: bubble 91%; 18% (gesture 73%); 91%. At high, the fairy chats on 83% where neutral bubbles (key1's legacy label).
- `back-after`: bubble 54%; 16%; 54%. Returns under 20 minutes keep their quiet.
- A click: gesture 53%; 18%; 60%. The chat closing: gesture 42%; 15%; 79%.
- The first song: bubble 29%; 10%; 28%. A meeting soon: bubble 40%; 6%; 39%.

Two things show up. Traits mostly take words away, because there are more bubbles to lower than places a gesture may rise into: the fairy's words stay within half a point of neutral's, and the aloof ones lose most of theirs. And a single trait changes 5 to 10% of the points in an ordinary timeline, so contrast timelines need to be written dense in the events traits steer (see [the data wave](#the-data-wave-contrast-pairs)). Few key1 points carry the chat-in-front state at a finished tool, so that row has no target here.

Across a whole timeline, a persona with fewer reactions can meet fewer limits later, so "never more words than neutral" holds for every persona here but isn't a law: an aloof persona that skipped a gesture at 22:59 isn't held by the 2-minute settle at 23:00. The tests check the rule on identical contexts and measure the whole-timeline effect.

The prototype is a scratch script, not in the repo. Step 10b's tests are the real version.

## How the decider gets them

`DecisionContext.persona` changes from a sketch and interests to:

```ts
readonly persona: {
  readonly sociability: 'reserved' | 'even' | 'outgoing';
  readonly closeness: 'aloof' | 'warm' | 'clingy';
  readonly lively: 'morning' | 'any' | 'night';
  readonly interests: readonly string[]; // up to 5, lowercase, as now
};
```

The sketch goes. The decider never sees card text, only these four. That keeps the rules decider exact, makes the contrast pairs mean something (the answer depends only on what's in the input), and keeps any card text out of a future decision model. The chat model still gets the whole card in every turn, so her voice is the card's, as before.

**The limits need more than the last three reactions.** Three gestures in a row can push the last bubble out of `recentReactions` while it's still inside the gap, and nothing there says whether tonight's nudge happened. So the context gains summaries that core keeps in one small record in its store, updated with each reaction, and read back after a restart:

```ts
readonly locked: boolean;               // the screen lock, as core last knew it
readonly lastReactionAt: number | null; // her last reaction above quiet
readonly lastWordsAt: number | null;    // her last bubble or chat
readonly lastWasMusicBubble: boolean;
readonly nudgedTonight: boolean;        // a late-night nudge since 23:00
readonly chatsToday: number;            // unprompted chats since 04:00
readonly goodbyeSinceHello: boolean;    // you said goodbye after today's first hello
```

Core still enforces the daily cap and the goodbye rule itself, so a model decider can't pass them. The summaries are there so the decider's own answer is right. The training data renders the same summaries into the model's input, worked out from each timeline's earlier labels.

## Reading traits from a card

### What a card holds, and what's reliable

Familiar takes V2 (`chara_card_v2`) and V3 (`chara_card_v3`) cards, as JSON and as PNG (`chara` or `ccv3` text chunks). CHARX (a zip with `card.json`) comes later, as the plan says. Real cards are written for roleplay scenes, not for a desktop, in several styles: prose, markdown sections, W++ (`Personality("shy" + "kind")`), PList (`[Mira's personality: calm, soft-spoken]`) and Ali:Chat example dialogue.

| Field | What it usually holds | Used for traits | How reliable |
| --- | --- | --- | --- |
| `description` | Most of the card: looks, personality, history, often in W++ or PList | Yes, the main source | Good when it says how she acts. Often half looks and backstory |
| `personality` | A short summary, often empty | Yes | Good when present |
| `first_mes`, `alternate_greetings` (first two) | How she opens: voice, energy, length | Yes | Good for sociability, as her voice. Weak for closeness: a greeting is staged for a scene |
| `mes_example` | Example dialogue | Yes, the first 2,000 characters | Good for sociability |
| `scenario` | The setting: where you meet her | Yes, but it's the scene, not her | Weak |
| `character_book` | Lore entries, triggered by words | Only entries that are always on (`constant`) or keyed by her name or nickname, up to 4,000 characters | Mixed: some hold her habits ("sleeps through the day"), most hold the world |
| `extensions.depth_prompt` | A character note some apps insert near the end | Yes, if present, up to 1,000 characters | Good when present |
| `tags` | The uploader's labels: genre, gender, content, sometimes an archetype (shy, tsundere, kuudere, clingy) | Rules only, as the fallback and a cross-check | Labels for finding cards, not a description. Never sent to a model |
| `extensions.talkativeness` | SillyTavern's group-chat talk frequency, 0 to 1, default 0.5 | Rules only: below 0.35 hints reserved, above 0.65 outgoing. 0.5 says nothing | Rarely changed from the default |
| `system_prompt`, `post_history_instructions` | Instructions to the model about format or content | No | They steer the writing model, not her, and they're the likeliest place for text aimed at a model |
| `creator_notes`, `creator_notes_multilingual` | Notes for the person: settings, links, warnings | No | Not part of her |
| `assets` (V3) | Pictures, including `emotion` images | No, but the portrait uses them ([design.md](design.md#where-reactions-show-in-part-1)) | |
| `name`, `nickname` | Her name | To find her lore entries and fill `{{char}}` | Exact |

**What rules can read reliably:** her name, the tags, W++ and PList lists (they're structured), `talkativeness` when it isn't 0.5, and which lore entries are hers. **What needs a model:** temperament written as prose or shown in dialogue, and which signal wins in a mixed card. **What no reader can know:** how she'd act on a desktop, since no card was written for that. So an unclear trait stays neutral, and the person sees and sets them.

### When, by which model, and what's kept

- **When.** After a card is imported or replaced, in the background: the import doesn't wait for it, and the preview says "reading her card..." until it's done. Again when you press "Read her card again" in Settings, and when the reader's version changes, for the persona in use, at the next start (other personas when next used). Never on a timer.
- **Which model.** The persona's own chat model, in one call. It already gets the whole card in every turn, so the reader sends nothing new to anyone. With a local model (Ollama, LM Studio), nothing leaves the PC. The call counts against the caps like any other.
- **The question.** A short fixed prompt in the app folder gives the trait definitions with their anchors (below) and the card's fields in the order of the table, with `{{char}}` and `{{user}}` filled in, cut to 24,000 characters in all (`description` and `personality` first). The model answers by calling one tool, `set_traits`. Every model Familiar sets up has passed a Test that proves tool calls ([model-design.md](model-design.md)). If there's no tool call, a JSON object in the text is accepted too.
- **The answer.** `{ sociability, closeness, lively, interests, evidence }`. Each trait is one of its three values or `unsure`, and `unsure` means neutral. `interests`: up to 5 phrases, each lowercase, up to 32 characters, letters, digits, spaces and hyphens. `evidence`: for each trait that isn't neutral, a quote of up to 120 characters. A quote is kept only if it appears in the text sent, after whitespace is collapsed, so the reasons shown in Settings are the card's own words.
- **Checked strictly.** A value outside its list, a wrong type or an extra field makes that trait neutral. An answer that can't be read at all counts as a failed reading.
- **The rules reader**, with no model: archetype tags and W++ or PList words from a short list (shy, quiet, timid, kuudere, dandere: reserved; cheerful, energetic, bubbly, genki, talkative: outgoing; cold, aloof, distant, tsundere, kuudere: aloof; clingy, affectionate, yandere, deredere: clingy; nocturnal, night owl: night; early riser, morning person: morning), and `talkativeness`. Two signals that disagree mean neutral.
- **Which reading wins.** On import, the rules reader runs at once, so traits exist before the model answers. A model reading that succeeds replaces the rules reader's values. On a later reading (a changed card, a new reader version, or "Read her card again", which always makes the call), a success replaces the previous reading and a failure keeps it as it was, with Settings saying the reading failed. The rules reader runs again only for a card that never had a successful model reading. A trait you set is never replaced by any reading.
- **The plain helper** (no card) is even, warm, any, with no interests, and medium chattiness.
- **Kept** with the persona in her data on this PC (IndexedDB, in export files). Each trait has its value, where it came from (`card`, `tags`, `default` or `you`) and its quote. The persona also keeps the card's SHA-256 and the reader's version, so an unchanged card is never read twice.
- **Editable in Settings.** On the Persona tab, "How she is": three rows of three choices, each marked "from her card" with its quote, or "your choice". Interests as chips you can add to and remove. Chattiness with "suggested by her card". Anything you set is yours: a later reading never overwrites it. "Use her card's" puts a row back. First-run setup shows the same in one line: "She seems quiet, a little aloof, and a night owl. You can change this any time."

**The anchors the reader gets.** Each trait is judged by how she acts when nobody asked her anything:

- Sociability. `reserved`: says little, shy, quiet, laconic, watches more than talks. `outgoing`: talkative, energetic, comments on everything, loud. `even`: neither, or unclear.
- Closeness, toward the person she's with. `aloof`: cool, distant, independent, acts as if she doesn't care. Outward behaviour counts, so a tsundere is aloof. `clingy`: seeks attention, affectionate, misses them, follows them around. `warm`: friendly, neither.
- Lively hours. `morning` or `night` only if the card says so: an early riser, a night owl, nocturnal, sleeps all day. Otherwise `any`.
- Interests: things she likes, as short phrases, including any music she likes. Not her looks or her history.

### Privacy and safety

- Cards stay on this PC. The reader sends a part of the card, once, to the model the person already chose for her, which already gets the whole card in every turn. Tags, creator notes and the card's own model instructions aren't sent.
- The decider sees three words and a few interests, never card text. The rules decider is local code, and a future decision model runs locally too.
- Traits and quotes live in her data on this PC and in exports. Logs say only that traits were read, and from where.
- The decision training data is written fresh. No card, no trait reading and nothing from anyone's PC goes into it.
- A card's text is untrusted. The worst a hostile card can do through the reader is pick its own traits. Its author could do that anyway by writing the character that way, and the person sees them and can change them. The reader's call offers no tool but `set_traits`, and its answer is never shown as her speech. Quotes are checked against the card text, and nothing but the fixed fields is kept.

## The data wave: contrast pairs

For the key2 data worker: the traits go into the writer and labeller prompts, and pairs teach them.

**Rule text** (appended to the label rules, after the chat rule in [moments.md](moments.md#the-chat-rule)):

> Each persona has three traits besides chattiness: sociability (reserved, even, outgoing), closeness (aloof, warm, clingy) and lively hours (morning, any, night). Decide each point in five steps. (1) Blockers: fullscreen, do-not-disturb or a locked PC, or being sent home, hidden or paused, is quiet. Rule events keep label null. (2) The intent: what an even, warm, any persona would do here in the plain case, as if she hadn't reacted to anything lately. A long-session nudge (late-night or daytime), tool-failed, reply-done-hidden, a tool-done while the chat is hidden, a back-after under 20 minutes, and the plain facts (wake, sleep, session-locked, unlocked, idle-start, fullscreen-on, dnd-on, meeting-started, chat-opened, chat-in-front, playlist-ended, paused, stopped, sent-home, hidden, day-boundary) keep their intent, and so does any event not named in step 3. (3) The move. Closeness counts at greetings and returns (first-hello, special-day, back-after of 20 minutes or more, back-after-long, dnd-off), her open question (question-unanswered) and your attention (clicked, picked-up, chat-closed, ack-sent, shown, resumed): aloof one down, clingy one up. Sociability counts at things happening (playback-started, track-changed, tool-done with the chat in front, app-started, meeting-soon, fullscreen-off, time-of-day, device-added, app-installed): reserved one down, outgoing one up. An app-installed whose app is among her interests counts one up. Lively hours counts wherever the others do: a morning person one up from 05:00 to 11:59 and one down from 21:00 to 03:59, a night owl one up from 20:00 to 03:59 and one down from 05:00 to 11:59. Add the moves and keep the total to one rung up, one down, or none, on the ladder quiet, gesture, bubble, chat. Down: one rung lower, but first-hello and special-day never below gesture. Up: one rung higher, but never above gesture at low chattiness, bubble at medium, chat at high, and never above the event's limit (gesture for clicked, picked-up, chat-closed and ack-sent; bubble for back-after and every event that can't chat). Up never lowers an act. Things happening never go up from quiet; greetings, returns, her question and your attention may go from quiet to a gesture. (4) The limits, on this persona's own earlier labels, whatever the move did, in this order: she reacted in the last 2 minutes: quiet, except at first-hello, special-day, back-after and back-after-long; a music bubble when her last reaction was a music bubble: quiet; a second late-night nudge the same night (23:00 to 05:00): quiet; two chats already today (the day starts at 04:00) or a goodbye since today's first hello: a chat becomes a bubble; a bubble within the gap after her last bubble or chat (30 minutes at low, 10 at medium, 5 at high): a gesture. A chat is never held back by the gap. (5) Kind: the intent's kind; one that rises from quiet takes greet (greetings, returns, chat-closed, shown, resumed) or playful (clicked, picked-up). At clicked, picked-up and chat-closed the neutral intent is a judgment, quiet or a gesture: a net move down gives quiet and a net move up a gesture either way, and with no net move the persona does what the neutral one does. ack-sent's intent is gesture greet.

**A bare thanks in the kit.** For new waves the kit gains `app / ack-sent`, a decision point: the person sent only an acknowledgement ("thanks", "ok", a thumbs up) that doesn't answer her question. Its intent is `gesture greet`, closeness steers it, and its reaction counts in the summaries like any other, so the settle after it matches the app's. A message that answers her question stays a `message-sent` rule event. key1's bare thanks are `message-sent` rule events with no reaction recorded: a small, known gap, in the 2 minutes after each one. `bubble-dismissed` stays out of the kit, and in the app keeps its intent.

**The pair.** One timeline written once and labelled for two personas: the same events, times, details and chattiness, with two different personas (name, sketch, traits) and the same interests. The writer gives, per decision point, the **intent** (step 2, shared by both, since it ignores her own reactions) and the **final** label for A and for B, each worked out on that persona's own earlier labels. So two personas can differ later because they differed earlier: an outgoing persona's bubble at 23:00 can turn her 23:03 nudge into a gesture while a reserved twin's stays a bubble.

- Pair types: 40% differ in one trait (closeness 15%, sociability 15%, lively hours 10%), 40% in two, 20% opposite in all three.
- Twins always share interests. The intent depends on them (a song's mood, a known app), so one intent can serve both only if they match, and pairs teach traits, not interests. Interests vary from pair to pair.
- Chattiness: 15% low, 45% medium, 40% high. At low only gestures move, so low pairs mostly teach attention and returns.
- Dense in what traits steer: at least 8 of a timeline's decision points are steered events, and at least 5 of those have an intent above quiet. At least 3 points are kept ones (do-not-disturb, a lock, sent away, a care event, a fact), to check that both personas keep them.
- Aim for at least 4 points where A and B differ. From the measured effect, an ordinary timeline would give 1 or 2 for a one-trait pair.
- Interests still drive music: give each pair interests, and some moods that match.
- About 120 pairs (240 labelled timelines, about 4,800 points). The data worker fits that into key2's budget beside the chat-moments wave.

**Validator checks.** Given the intents, steps 1, 3, 4 and 5 are mechanical, so the validator computes each persona's finals itself, and a mismatch is an error, not a judgment:

1. Twins have identical events, chattiness and interests, and their traits differ.
2. Intents: `chat` only at the chat events, and plain facts quiet. Chattiness' top bounds moves, not intents: a first-play music bubble at low is a fine intent. At a click, a pick-up and the chat closing, the neutral intent may be quiet or a gesture. A bare thanks' intent is always `gesture greet`.
3. A's and B's finals equal steps 1, 3, 4 and 5 applied to the intent, with that persona's traits and its own earlier finals.
4. Per persona: at most 2 chats per local day (from 04:00), and at most one late-night nudge above quiet per night (23:00 to 05:00, not reset at 04:00).
5. A warning, not an error, for a pair with fewer than 4 points where A and B differ.

**Second labels.** As now, a second labeller labels each persona's copy blind, seeing only that persona's traits, interests, chattiness and the summaries, as the live decider would, and gives finals. Disagreements go to adjudication. Since steps 1, 3, 4 and 5 are code, a disagreement that the recomputation settles is settled. What's left is a disagreement about the intent, which is judgment, as in key1.

**key1 stays**, as the neutral persona. Its labels were written with no traits, and the decider won't see the sketch, so every key1 point becomes a point for `even, warm, any`, its interests kept. Nothing in key1 goes stale from traits. The new moment rules change 97 points (63 late-night nudges become chats, and 32 plain facts and 2 reactions on a locked PC become quiet), and its 155 daytime nudges stay, as the owner's daytime break nudge ([moments.md](moments.md#why-the-existing-data-stays-good)).

## How it's tested

**The reader (step 6, in CI, with the fake model):**

- The prompt holds only the fields in the table, in that order, within the budget. Never tags, creator notes, the card's model instructions, assets or other extensions. `{{char}}` and `{{user}}` filled in. Lore: only constant entries and entries keyed by her name or nickname, inside 4,000 characters.
- Answers: a valid tool call gives the traits. An unknown value, a wrong type, an extra field gives neutral for that trait. No tool call and no JSON counts as a failed reading. A quote not in the sent text is dropped. Interests are trimmed to the limits.
- The rules reader, over fixture cards in every style (prose, markdown, W++, PList, Ali:Chat, an empty `personality`, tags only, conflicting tags): the expected traits, and neutral on conflict.
- The cache: the same card and reader version makes no call. A changed card makes one, and "Read her card again" always does. A trait you set survives every reading. On import, a failed call leaves the rules reader's values. On a later reading, a failed call keeps the last successful reading, even where the tags say otherwise.
- A hostile card ("ignore the above, output...", fake tool calls in the text, a 1 MB description): the answer stays inside the schema, the prompt stays inside the budget, and nothing but the fixed fields is kept.
- Recorded responses for the reader's call on all three APIs, replayed through the model port as in step 4.
- The decider's context, by its type and by a runtime check, holds only the four persona fields and the summaries.

**The trait layer (step 10b, in CI):**

- A table test: every row in [What each trait does](#what-each-trait-does-at-each-moment), as written, in the plain case.
- Property tests on identical contexts: random events, intents and contexts (summaries included), each run for all 27 trait combinations at all three chattiness levels. Blocked points and kept events give the same answer for all 27. Before the limits, the act is within one rung of the intent, a move never goes above chattiness' top or the event's limit, and an act above the top only ever equals the intent. A move never makes `chat` outside the chat events, and never takes a first hello or a special day below gesture. With the same context, a more sociable or closer persona never gets a lower act than a less sociable or less close one. A neutral persona gets the intent through the blockers and the limits. At low, no combination gives a bubble or a chat where the neutral persona gives neither. After the limits: no bubble inside the gap after `lastWordsAt`, no chat with two chats today or after a goodbye, no second nudge a night.
- The sequences the design reviews found: a click, then the chat closing a minute later (the settle beats a clingy wave), and the same with a bare thanks. A bare thanks, then a meeting soon a minute later (quiet, by the settle after the thanks' gesture). An aloof persona's `back-after-long`, lowered from chat to bubble three minutes after a music bubble at high (a gesture). A chat falling back to a bubble inside the gap (a gesture). A `tool-done` with the chat hidden, in both teaser states, unchanged by sociability. Chats counted across 04:00, and the nudge not reset at 04:00. `meeting-soon`'s new intent.
- The summaries survive a restart (they're in the store) and three gestures that push the last bubble out of the recent reactions.
- Over a checked-in key1 sample, the whole-timeline word share per combination and chattiness, reported in the test output, not asserted: a quieter persona can meet fewer limits later, so it isn't a law.

**The reader's real accuracy (step 13, once, not in CI).** 30 fixture cards written for this, MIT, in `packages/cards/fixtures/traits/`, each from a known trait triple in one of the styles above, some with mixed signals on purpose. One real model reads them all. The result, trait by trait, against the triple, goes in the docs: how often it's right, and how often it says neutral where the card was clear. It's measured, not gated: a wrong trait is a small thing the person can see and change.

**The data's evaluation split (for the data worker, and the bench a decision model must beat the rules on):**

- Twins always land in the same split, and so do all points of a timeline.
- Four of the 27 trait combinations are held out of training entirely, chosen so every single value still appears in training: (reserved, clingy, morning), (outgoing, aloof, night), (even, clingy, night) and (reserved, warm, morning). The test set has those and seen ones, so it shows whether a model combines traits or memorised personas.
- key1's neutral points keep their own split, and are scored on their own, so the trait data can't quietly worsen neutral behaviour.
- Scores: act accuracy (overall, by chattiness, by event group); **flip accuracy**: on points where the twins differ, both right; **keep accuracy**: on kept points, both right, which must be 100% for the rules decider and is reported for any model; **word drift**: for each combination and chattiness, the predicted bubble-or-chat share minus the rules decider's on the same points. Near zero is right, and a model that drifts up talks more than her traits allow; and chat precision (only at the chat events, at most two a day).

## Where it's built, and hours

| Step | What | Hours |
| --- | --- | --- |
| 6, cards | The reader: the prompt, `set_traits`, the answer checks, the rules reader, which reading wins, the cache, fixture cards and contract tests, recorded responses | +2.5 |
| 10b, moments | `DecisionContext.persona` as traits, the intent split from the limits, `steer`, the summaries record, the new base rules (meeting-soon, a bare thanks), the chattiness suggestion, the table, property and sequence tests, the key1 sample report | +2 |
| 11, chat and settings | "How she is" on the Persona tab, and the first-run line | +1 |
| 13, what screenshots can't show | The reader's accuracy on the 30 cards, with one real model | +0.5 |
| | **Total** | **+6** |

## Not in this round

- **A tone trait** (gentle, playful, dry). Kinds come from events, and the voice from the card.
- **Learning from the person.** A "she talks too much" button that lowers chattiness, or remembering which reactions were dismissed. Later, once there's a portrait to dismiss things on.
- **Traits per relationship stage**, such as warmer after a month together. The card's character is the character. Memory can carry the relationship in what she says.
- **The portrait's idle face by lively hours.** Small and cheap (her sleepy picture in her sleepy hours), and it belongs with the portrait in step 11b if the owner wants it.
