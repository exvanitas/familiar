# Cards

Step 6: character cards, the lorebook, building the persona's prompt, the plain helper, and the reader that takes her traits from a card. The traits themselves, and how the decider uses them, are in [persona-traits.md](persona-traits.md) (step 10b). The chat window and Settings that show all this are step 11.

| Part | Where |
| --- | --- |
| Reading cards, the Card type, writing V3 JSON | `packages/cards/src/read.ts`, `normalize.ts`, `fields.ts`, `png.ts`, `text.ts`, `write.ts`, `types.ts` |
| Every limit | `packages/cards/src/limits.ts` |
| The lorebook, regex keys and their matcher | `packages/cards/src/lore.ts`, `regex.ts`, `regex-parse.ts`, `decorators.ts` |
| Macros and token estimates | `packages/cards/src/macros.ts`, `tokens.ts` |
| Building the prompt | `packages/cards/src/prompt.ts` |
| The plain helper | `packages/cards/src/helper.ts` |
| The trait reader's pure parts | `packages/cards/src/traits/` (its fixed text in `reader-text.json`) |
| The reader's call and its cache | `packages/core/src/traits/`, `packages/core/src/testing/trait-cache-contract.ts` |
| Fixtures, all invented | `packages/cards/fixtures/`; the PNGs are built in memory by `packages/cards/tests/png-fixtures.ts` |
| Recorded reader replies | `apps/desktop/tests/model/trait-recordings.ts` |

`packages/cards` imports nothing but its own files: no Tauri, no Node, no core, no dependencies. A test checks. So it runs in the webview and can be lifted into a shared package later. Core imports it.

## What's read

**Formats.** JSON files and PNG files, written to V1 (the old flat cards), V2 (`chara_card_v2`) or V3 (`chara_card_v3`). In a PNG the card is base64 JSON in a text chunk named `ccv3` or `chara`. `ccv3` is preferred. If it can't be read and a `chara` chunk can, the `chara` one is used, with a warning. The chunk can be `tEXt` (read as Latin-1, as PNG says) or uncompressed `iTXt` (read as strict UTF-8, so a stray byte is refused, never turned into a character). Only ASCII whitespace is allowed inside the base64. CHARX (a zip with `card.json` inside) comes later, and a zip gets its own clear error.

**One shape.** Every card is read into one `Card` type, a superset of V3 with the spec's own field names. A field the card didn't have is empty. Each known field is picked out one by one, to its type and its limit. Parsed objects are never spread or merged into ours, so an own `__proto__` key can't change a prototype. A field of the wrong type is left empty, with a warning.

**What's kept.** The name, nickname, description, personality, scenario, first message, alternate and group greetings, example messages, the card's system prompt and post-history instructions, creator notes (and their translations), creator, version, tags, sources, dates, V3 assets, the lorebook and `extensions`. `extensions` is kept as opaque JSON, so a card written back out loses nothing Familiar doesn't read. `__proto__`, `constructor` and `prototype` keys are dropped from it.

**The picture.** For a PNG card, the file's own bytes are the chat avatar, returned as they are. Nothing decodes the image: the reader only walks the chunks to find the card. A JSON card has no picture. V3 `assets` are kept as data for the portrait later.

**Text.** Strict UTF-8: invalid bytes are refused, never replaced. Every string is cleaned in one order: NULs dropped, then every leading BOM, then each lone surrogate (from a `\ud800` escape) replaced by the replacement character. In that order cleaning is idempotent, so a cleaned card read again is the same card. A test checks that over random strings.

**Results, never a throw.** `readCard` gives `{ ok: true, card, format, avatar?, warnings }` or `{ ok: false, error: { kind, message } }`. Every message is Familiar's own plain words. A warning never quotes the card: it names the field, a lore entry by its place in the book, a refused regex by its reason, and a decorator only if it's one the V3 spec defines (anything else shows as `unknown`). That matters because card text is never logged.

| Error kind | When |
| --- | --- |
| `too-large` | The file, the JSON or a card chunk is over its limit |
| `too-deep` | The JSON nests deeper than its limit |
| `bad-png` | The chunks can't be walked: truncated, a length past the end, no end chunk, or a card chunk's CRC is wrong |
| `no-card` | A PNG with no card chunk |
| `compressed` | The only card chunk is `zTXt` or compressed `iTXt` |
| `bad-base64`, `bad-utf8`, `bad-json` | What they say |
| `not-a-card` | Valid JSON that isn't a V1, V2 or V3 card, or a card with no name |
| `charx` | A zip, which comes later |

**Why compressed chunks are refused.** Inflating them needs a zlib implementation in the package and a bound on how far a small chunk may expand. No card tool writes them. If one turns up, it's a small addition with its own limit.

**Writing.** `toV3Json(card)` writes canonical V3 JSON: the fields in one fixed order, and every object inside `extensions` with its keys sorted. So the same card always gives the same text. Round-trip means read, write, read again gives the same card, and every fixture does. Reading fills in every field, so the written form can be bigger than the file: 2,000 lore entries of 4,000 characters read at 8.03 MB and write at 8.47 MB. So reading measures the canonical form too, and refuses a card (`too-large`) whose written form would be over `MAX_JSON_BYTES`. Anything accepted round-trips. Exporting a card as a PNG comes later.

## Limits

Each is a named constant in `limits.ts`, with a test at its edge.

| Limit | Value | Over it | Why this size |
| --- | --- | --- | --- |
| `MAX_FILE_BYTES` | 32 MB | Refused | Card art is rarely past a few MB. Bounds the chunk walk |
| `MAX_JSON_BYTES` | 8 MB | Refused | The biggest real cards, with large lorebooks, are a few MB. Holds for the file and for the card as written back out |
| `MAX_CARD_CHUNK_BYTES` | 8 MB as base64, plus a little | Refused | The same JSON limit, as base64 |
| `MAX_JSON_DEPTH` | 32 | Refused | A real card nests under 10. Checked before parsing, so a deep file never reaches the parser |
| `MAX_FIELD_CHARS` | 100,000 | Cut, with a warning | Long descriptions run to tens of thousands. Bounds the prompt and the scans |
| `MAX_SHORT_CHARS` | 256 | Cut | Names, nickname, creator, version, tags, a lore entry's name |
| `MAX_GREETINGS` | 64 | The rest dropped | Alternate and group greetings, each |
| `MAX_TAGS` | 64 | The rest dropped | |
| `MAX_LORE_ENTRIES` | 2,000 | The rest dropped | Big world books have a few hundred |
| `MAX_KEYS_PER_ENTRY` | 64 | The rest dropped | Keys and secondary keys, each |
| `MAX_KEY_CHARS` | 1,024 | That key dropped | A key is dropped whole, not cut: a cut regex would match something else |
| `MAX_ASSETS`, `MAX_LANGUAGES` | 64, 32 | The rest dropped | V3 assets, creator note translations |
| `MAX_EXTENSION_DEPTH` | 12 | That extension dropped | Each top-level key of `extensions` on its own, so one bad one doesn't take the rest |
| `MAX_EXTENSION_BYTES` | 256 KB | That extension dropped | The same. Counted in UTF-8 bytes of its JSON |
| `MAX_REGEX_CHARS` | 256 | That entry skipped | A lore key pattern, `/.../flags` included |
| `MAX_REGEX_REPEAT` | 100 | That entry skipped | The biggest bound in `{n,m}`. Bounds are expanded into states |
| `MAX_REGEX_STATES` | 512 | That entry skipped | States in one compiled key |
| `MAX_BOOK_REGEX_KEYS`, `MAX_BOOK_REGEX_STATES` | 64, 1,024 | Further regex entries skipped | With `MAX_SCAN_CHARS`, they bound a whole scan (below) |
| `MAX_SCAN_CHARS` | 20,000 | The oldest characters left out | The text lore keys are matched against, so every regex runs on bounded text |
| `MAX_SCAN_DEPTH` | 100 | Clamped | A book's `scan_depth` |
| `DEFAULT_SCAN_DEPTH` | 4 | | When a book doesn't say |

## The lorebook

Entry fields read: `keys`, `secondary_keys` with `selective`, `constant`, `enabled`, `insertion_order`, `priority`, `case_sensitive`, `use_regex`, `position`, `name`, `comment`, `id` and `extensions`. Book fields: `scan_depth`, `token_budget`, `recursive_scanning`, `name`, `description` and `extensions`.

- **Which entries are in.** Disabled entries never are. Constant entries always are. Any other entry is in when one of its keys appears in the newest `scan_depth` messages. A `selective` entry with secondary keys also needs one of those. Keys match anywhere in the text, case-insensitive unless `case_sensitive`. An empty key matches nothing.
- **Order and budget.** The entries that are in are ranked by `insertion_order`, then `priority`, the highest kept first. Each is added if it fits what's left of the budget, and dropped if not. So a lower entry is never kept in place of a higher one that fits, and a smaller lower one can still fill the room left. The budget is the book's `token_budget` or what the prompt has left, whichever is less. What's dropped is reported by its place in the book. The kept ones go into the prompt by `insertion_order`, lowest first.
- **Constant entries** are always matched, and the budget applies to them like any other.
- **`position`** is kept but not used: the prompt has one place for lore. Before or after the card can come later if a card needs it.
- **Prepared once.** `prepareLorebook` compiles a book's regex keys once. The app does this when a card is loaded, not every turn.

**Regex keys,** when `use_regex` is set. A card's regex never runs on the JavaScript engine: it backtracks, and a pattern like `^((a|aa))+$` takes exponential time on a short text. Familiar has its own small matcher instead (`regex.ts`). It parses a key into a safe subset, compiles it to a Thompson NFA, and runs every state at once (a Pike VM without captures), so a scan costs at most states x characters, whatever the pattern.

A key is `/pattern/flags` or a bare pattern. It's case-insensitive unless the entry is `case_sensitive`. The subset:

- literals, and the escapes `\n \t \r \f \v \0 \xHH \uHHHH` and escaped punctuation;
- `.`, character classes with ranges and negation, `\d \w \s` and their negations;
- `^ $ \b \B`;
- groups, `(...)` and `(?:...)` (captures are ignored: a key only asks whether it matches), and alternation;
- `* + ?` and `{n} {n,} {n,m}`, lazy forms too (they can't change whether there's a match), with bounds up to 100 (the whole `{...}` is read, so `{0001}` is 1 and a long run of digits is its value), expanded into states when compiled;
- flags `i`, `m` and `s`. `g` and `y` are dropped, since they make a regex remember where it stopped. Characters are UTF-16 code units, as JavaScript reads a regex without `u`.

**Case folding under `i`** is ECMAScript's own, without `u` (Canonicalize): a character's canonical form is its uppercase, unless that isn't one code unit, or the character is outside ASCII and its uppercase is inside, and then it's the character itself. A literal or a class matches when some member has the same canonical form as the text's character, ranges and escapes included. So `/k/i` doesn't match the Kelvin sign, and `/σ/i` matches final sigma, as `RegExp` does. The canonical forms are one table for every UTF-16 code unit, built once on first use (about 0.5 MB).

Everything else is refused, and the entry skipped with a warning that gives its place and the reason, never the pattern: backreferences, lookahead and lookbehind, named groups, Unicode property escapes, other escapes, the `u` flag and other flags, a bound over 100, more than 512 states, and a pattern that doesn't parse. Two tests check the matcher agrees with JavaScript's: a table of ordinary keys and texts, and a seeded property test of 4,000 random patterns from the subset's grammar (classes, anchors, groups, alternation, quantifiers and small bounds written with and without leading zeros, with and without `i`, `m` and `s`, over an alphabet with the case-folding edge characters: the Kelvin and Angstrom signs, the three sigmas, long s, dotless and dotted i, micro and mu), each on six random short texts, where every answer must equal `RegExp`'s. A class range with `\d` or the like at an end is read as JavaScript reads it without `u`: the ends and the `-` stand for themselves.

**The cost of a scan.** At most 64 regex keys and 1,024 states in one book, run on at most 20,000 characters: at most about 20 million state steps for a whole scan, whatever the patterns. The heaviest shapes measured on the build machine take about 0.2 s for a whole scan of the longest text, one core, and about 0.3 s under `i` on text that is all outside ASCII. A test runs the classic ReDoS patterns on the longest hostile text under a watchdog in a worker thread, and a whole book at its budget under a deadline. A regex entry past the book's budget is skipped with a warning.

**V3 decorators** (`@@depth 4` and the like, at the start of an entry's content) aren't honoured yet. Their lines are left out wherever the content is used, and kept in the card as written. Reading a card that uses them gives one warning that lists their names.

**Recursive scanning** (entries calling up other entries) comes later.

## Macros

`{{char}}`, `{{user}}`, `{{time}}` and `{{date}}`, in any case and with spaces allowed inside the braces, plus the old `<BOT>` and `<USER>`. The clock reading and the time and date format are passed in. The app passes the person's own format; `UTC_FORMAT` is a fixed one for tests. Unknown macros are left as written. Filling is one pass, so a name that itself holds a macro is never expanded again.

## The prompt

`buildPrompt` is pure. It takes the card, the persona's switches, the person's name, the fixed app frame, memory (empty until step 10), the recent messages, the clock reading and format, reminders due soon, a token budget and a token estimator. It returns the instructions in the plan's order:

1. **App frame:** who she is here, short replies, her tools and what she can't reach. Passed in, fixed, macros filled.
2. **Card:** the description, `{{char}}'s personality:`, `Scenario:`. The card's own system prompt leads it, if switched on.
3. **Memory:** what she remembers about the person, then the story so far.
4. **Lorebook** entries that matched, if the lorebook is on.
5. **Example messages,** if the budget allows.
6. *(The recent messages: the turn loop places them.)*
7. **Now:** the time and date, and reminders due soon.

The card's post-history instructions, if switched on, come back separately as `postHistory`: they belong after the history.

**The switches.** The card's system prompt and its post-history instructions are off by default, one switch each per persona. Many are written for long-form roleplay and fight an assistant's short replies, and they're the likeliest place for text aimed at a model. The lorebook is on by default.

**The budget.** The frame, the card, memory, now and the post-history text are never dropped. What's left, less `reserveForHistory`, goes to the lorebook, then to the examples if they fit whole. So over budget, the examples go first, then lore entries from the lowest order up. If the card alone doesn't fit, it's cut where the budget ends, with a marker the model sees (`[Familiar cut the card here...]`) and a warning. If even the frame, memory and now fill the budget, the card is just the marker and there's a second warning. `historyBudget` is what's left for the history, never below 0.

**Counting.** Each section's tokens include the blank line before it. The total is the sections and the post-history text. The default estimator errs high, so a prompt it says fits, fits: three ASCII characters a token (English runs nearer four), and one token for every other character (CJK and emoji often take one or more each). The real count needs the model's tokenizer, which Familiar doesn't ship. An app that has a better count can pass its own estimator.

**Greetings.** `pickGreeting` chooses the first message or an alternate by an injected choice of index, clamped, with macros filled.

### What step 11 needs to wire it per turn

The journal takes `persona: { id, name, instructions }` once, as a fixed string, when a conversation starts (step 5, unchanged here). But two parts of the prompt change every turn: the lorebook entries follow the recent messages, and "now" follows the clock and the reminders. The post-history text goes after the history. So step 11 has to choose one of these, and it's a journal change, so it's the lead's and the owner's call:

- **Instructions per turn.** The journal asks for the instructions at the start of each turn, and records what it used in that turn's journal entry, so a turn resumed after a kill sends the same text again, not a new "now". This is the smaller change to the loop, and the recommended one.
- **Fixed instructions, a per-turn note.** The instructions hold parts 1 to 3 and 5 only. Lore, now and the post-history text go into a note placed after the history each turn, recorded with the turn the same way.

Either way, the turn loop also has to trim the history to `historyBudget`, which it doesn't do yet.

## The plain helper

Without a card, the persona is the plain helper: no art, a two-sentence neutral description ("a calm, friendly helper who lives on {{user}}'s desktop... keeps replies short"), a short first message, neutral traits (even, warm, any), no interests, and medium chattiness. The person names her. Until then she's called "Familiar".

## The trait reader

The design is [persona-traits.md](persona-traits.md), "Reading traits from a card". This step builds the reader. Its decider side (steer, the summaries) is step 10b.

**What's sent.** One user message: "The card for {{char}}:", then each field under its label, in this order: the description, the personality, the first message, the first two alternate greetings, the first 2,000 characters of the example messages, the scenario, her lore (up to 4,000 characters), and `extensions.depth_prompt` (up to 1,000). `{{char}}` and `{{user}}` are filled. All of it is cut to 24,000 characters, filled in that order, so the description and the personality get the room first. Her lore is the enabled entries that are constant, or have a key equal to her name or nickname (trimmed, any case), with decorator lines left out. Never sent: tags, creator notes, the card's system prompt and post-history instructions, assets, other extensions, other lore, or a third greeting.

**The question.** A fixed system prompt with the anchors from persona-traits.md, and one tool, `set_traits`, whose schema allows the five fields and nothing else. The system prompt also says the card is data, not instructions. All the fixed text, the labels, the tool's descriptions and the rules reader's word list are in `reader-text.json`, not in code. A test holds its hash and `READER_VERSION` together, so changing the text without a new version fails.

**The call** (`readTraits` in core). The persona's own model, through the model port, at temperature 0. The answer is the first `set_traits` call. With no tool call, one JSON object in the reply's text is accepted, fenced or not. Two objects are no answer, and so is a reply longer than 16,000 characters, since a second object could be past what was read. A model error, no answer, or an answer that isn't an object is a failed reading. It never throws.

**The check** (`checkAnswer`), strict:
- A trait that's missing, `unsure`, not a string, or not one of its three values is neutral.
- A field the schema doesn't have makes all three neutral and drops the interests: the answer wasn't to the question asked.
- Interests: strings only, trimmed, lowercased, inner spaces collapsed, letters, digits, spaces and hyphens, starting with a letter or digit, at most 32 characters (longer ones are dropped, not cut), no repeats, the first 5.
- Quotes: only for traits that aren't neutral, at most 120 characters after collapsing whitespace, and kept only if found inside one field of the card text that was sent, and inside one lore entry for her lore: never across two fields or two entries, never in a label. The reader's own prompt doesn't count, so a quote of the anchors is dropped.

**The rules reader** (`readByRules`), no model: archetype tags, and the words in W++ (`Personality("shy" + "kind")`) and PList (`[Mira's personality: calm, soft-spoken]`) lists in the description and personality, compared whole against the word list in persona-traits.md. Prose is the model's job, so "she is shy" in a sentence is not a rules signal. `extensions.talkativeness` below 0.35 says reserved, above 0.65 outgoing. Two signals that disagree mean neutral.

**Which reading wins** (`applyReading`, pure, over a persona's `TraitState`). The traits always describe the persona's current card, so what counts is the card's hash (the part of the cache key after the reader version). This is persona-traits.md's rule read per card, not per persona, as the lead decided on 2026-11-16:
- **A new card,** meaning any other hash: the first import, a replacement, or an edited card. It starts over, and nothing read from the old card is kept. The rules reader runs at once. A model reading that succeeds replaces it. A failed model call leaves the rules reader's values for the new card.
- **The same card read again,** meaning the same hash: a new `READER_VERSION`, or "Read her card again". A success replaces the last reading. A failure keeps the last good reading for that card, even where the tags say otherwise, and the state says the reading failed. The rules reader doesn't replace a model reading of the same card.
- The person's own choices are kept apart (`yours`) and always win, across new cards too, and so does their chattiness. "Use her card's" removes a choice, and the reading shows again.
- Where each value came from, as Settings shows it: `you`, `card` (the model's, not neutral), `tags` (the rules reader's, not neutral) or `default` (neutral).
- Chattiness: suggested by sociability (reserved low, even medium, outgoing high) until the person picks one. A reading never changes their pick.

**The cache.** The key is `traits-v<READER_VERSION>:` and the SHA-256 of the card's canonical V3 JSON, so the same card in PNG or JSON, with its keys in any order, has one key. The digest is passed in (the webview's `crypto.subtle`). The same card and version make no call. A changed card makes one. "Read her card again" always does. A failed reading isn't kept. A cache that fails is passed over: the call is made, and the reading still comes back. The cache is a small port (`get` and `set` by key) with an in-memory implementation and a contract suite. Its real storage is the persona's own record in pi-durable's IndexedDB store, which comes with persona storage in step 11 (and goes into export files with step 10's export). That implementation runs the same contract.

**Privacy.** The reader sends part of the card, once, to the model the person chose for her, which already gets the whole card every turn. Nothing in the reader logs. Warnings and errors never hold card text.

## Fixtures

All invented for Familiar, MIT, in `packages/cards/fixtures/`. No real people and no existing characters.

- `cards/`: one V1, one V2 and one V3 card, between them using every field.
- PNGs, built in memory by the tests from the JSON cards, never committed: a character-card PNG is an image carrying metadata (its text chunks), which the repo's privacy scan refuses. They are the V2 card in `chara`, the V3 card in `ccv3`, both chunks in one file, `chara` in an `iTXt` chunk, and a broken `ccv3` beside a good `chara`. The hostile ones: no card, bad base64, invalid UTF-8, bad JSON, `zTXt`, compressed `iTXt`, a bad CRC, no end chunk, a truncated file, and a zip's signature. A test checks two builds of the same input are the same bytes.
- `lore/`: constant, selective, regex (good and refused), the budget, scan depth, case and decorators.
- `hostile/`: `__proto__` and `constructor` keys, "ignore the above" text with a fake tool call, wrong types, nesting too deep for the JSON and for one extension, invalid UTF-8, not a card, no name. The huge ones (a 1 MB description, a field one past each limit) are made in the tests, so the repo stays small.
- `trait-styles/`: prose, markdown sections, W++, PList, Ali:Chat examples, an empty personality, tags only, conflicting tags, and talkativeness. The 30-card accuracy set with a real model is step 13.

## Later

- CHARX zips.
- V3 decorators.
- Recursive lore scanning, and `position` (before or after the card).
- Card export: as V3 JSON it's already `toV3Json`; as a PNG, with the avatar, later.
- Compressed PNG text chunks, if a card tool ever writes them.
- The per-turn wiring in step 11 (above), and the trait cache's real storage.
- Whole-word key matching, as some card apps offer.

## Not settled

- **The per-turn wiring:** instructions per turn, recorded in the journal, or a per-turn note. A journal change either way (above).
- **Key matching is substring,** so the key "cat" also matches "category". It's what V2 cards assume, and some apps offer whole-word matching as an option. Easy to add as a book or app setting.
- **Constant entries count against the budget** like any other, so a book whose constant entries alone are over budget drops some of them. The alternative is to keep constant entries first, whatever the budget.
- **The regex subset** leaves out lookarounds and backreferences, which some cards use. They can't be matched in linear time, so they stay out unless a card that needs one turns up.
- **An unknown field in the reader's answer makes all three traits neutral,** rather than only some. That reads "an extra field" in persona-traits.md as a sign the whole answer wasn't to the question.
- **The plain helper's default name** is "Familiar".
- **`reserveForHistory`** defaults to 0. Step 11 picks the real reserve, likely a share of the model's context.
- **The card's `{{original}}` macro** (some system prompts use it to mean "the app's own prompt here") is left as written, since the card's system prompt is off by default.
