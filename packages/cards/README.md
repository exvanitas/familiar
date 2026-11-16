# @familiar/cards

Character cards for Familiar: reading V1, V2 and V3 cards from PNG or JSON, the lorebook, macros, building the persona's prompt, the plain helper, and the trait reader's pure parts. No Tauri, Node, core or other dependencies (a test checks), so it runs in the webview and can be lifted into a shared package later. The design, every limit and what's later: [docs/cards-design.md](../../docs/cards-design.md).

## Interfaces

| Function | In | Out |
| --- | --- | --- |
| `readCard(input)` | A file's bytes (PNG or JSON) or JSON text | `{ ok: true, card, format, avatar?, warnings }` or `{ ok: false, error: { kind, message } }`. Never throws |
| `toV3Json(card)` | A `Card` | Canonical V3 JSON text |
| `prepareLorebook(book)` | A card's `character_book` | Its entries with regex keys compiled once to the package's own linear-time matcher (never the JavaScript engine), refused ones skipped with warnings |
| `compileKey(key, caseSensitive)` | One regex key | A `KeyMatcher` (`test(text)`), or the reason it's refused |
| `matchLore(book, messages)`, `fitLore(book, matched, budget, cost)` | A prepared book, the recent messages, a token budget | Matched entries; kept and dropped ones |
| `fillMacros(text, ctx)` | Text, the names, an injected clock reading and format | Text with `{{char}}`, `{{user}}`, `{{time}}`, `{{date}}`, `<BOT>`, `<USER>` filled |
| `buildPrompt(input)` | Card, switches, names, frame, memory, recent messages, now, reminders, budget, estimator | Instructions (plan order 1 to 5 and 7), the post-history text apart, sections with tokens, what was dropped, the budget left for history |
| `pickGreeting(card, choose, ctx)` | A card and an injected index choice | The greeting, macros filled |
| `plainHelper(name?)` | The name the person gave | The built-in persona: a card with no art, neutral traits, medium chattiness |
| `readerPrompt(card, { userName })` | A card | The trait reader's system prompt, user message, the parts sent and the text a quote must come from |
| `checkAnswer(raw, quotable)` | The model's `set_traits` arguments | A checked `TraitReading`, or undefined for a failed reading |
| `readByRules(card)` | A card | The rules reader's `TraitReading` |
| `applyReading(state, event)`, `setYours`, `useCards`, `shownTraits`, `effectiveTraits`, `chattinessOf` | A persona's `TraitState` | Which reading wins, the person's own choices, what Settings and the decider see |
| `traitCacheKey(card, digest)` | A card and an injected SHA-256 | `traits-v<READER_VERSION>:<hex>` |

The model call itself (`readTraits`) and the trait cache port live in `@familiar/core`, which has the model port.

## Extension points

- **A new card field:** add it to `Card` in `src/types.ts`, pick it in `src/normalize.ts` with the helpers in `src/fields.ts` (never spread a parsed object), write it in `src/write.ts`, and add it to a fixture. The round-trip test then covers it.
- **A new limit:** a named constant in `src/limits.ts`, used where the field is read, and a test at its edge in `tests/limits.test.ts`.
- **Widening the regex subset:** parse it in `src/regex-parse.ts`, compile it in `src/regex.ts`, add it to the agreement table in `tests/regex.test.ts` and to the grammar in `tests/regex-property.test.ts`. Anything that needs backtracking (backreferences, lookarounds) can't be matched in linear time and stays out.
- **A new macro:** one more name in the pattern in `src/macros.ts`, and a case in `tests/macros.test.ts`.
- **A new prompt section:** a `SectionName`, its text in `buildPrompt`, its place in the order, and whether it can be dropped. `tests/prompt.test.ts` pins the order and the arithmetic.
- **Changing the trait reader's text or word list:** edit `src/traits/reader-text.json`, bump `READER_VERSION` in `src/traits/reader.ts`, and put the new hash in `tests/reader.test.ts`. A new version makes every card be read again.
- **A new fixture:** a JSON file under `fixtures/`. A PNG one goes in `tests/png-fixtures.ts`, built in memory: no PNG is committed, since a card PNG is an image with metadata. A fixture that's meant to be refused goes on the list in `tests/roundtrip.test.ts`.

## Tests

`pnpm test` from the repo root runs everything; `pnpm vitest run --project cards` runs this package's alone. `pnpm --filter @familiar/cards typecheck` typechecks it. The tests cover reading every format, a round-trip for every fixture, every limit, hostile cards, the lorebook, the regex matcher (agreement with RegExp by table and by a seeded property test, refusals, ReDoS patterns under a worker watchdog, the book's cost budget), macros with an injected clock, the prompt's order and budget, the plain helper, and the trait reader's prompt, check, rules, merge and cache key. Core's tests run `readTraits` against the fake model; apps/desktop's run it over the pi-ai adapter against recorded replies.
