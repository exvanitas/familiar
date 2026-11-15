# Model layer

Step 4: the model port, the pi-ai adapter, the presets, the model list, Test, caps and retries. Settings and the first-run screens (step 11) and the turn loop (step 5) build on these. It follows the conditions in [spikes.md](spikes.md#pi-ai-152-yes-with-conditions).

| Part | Where |
| --- | --- |
| The port and its contract | `packages/core/src/model/port.ts`, `packages/core/src/testing/model-contract.ts` |
| Caps and retries | `packages/core/src/model/caps.ts`, `packages/core/src/model/retry.ts` |
| The pi-ai adapter | `apps/desktop/src/model/pi-ai.ts` |
| Presets, model list, Test | `apps/desktop/src/model/presets.ts`, `models.ts`, `endpoint-test.ts` |
| Recorded replies | `apps/desktop/shell-check/model-recordings.ts` |

## The port

One reply is a stream of thinking, text and tool-call events that ends in exactly one `done` or `error`. Step 4 added what the spike found missing:

- **Replay.** `done` can carry `replay`, opaque JSON the adapter needs back next turn: Anthropic's signed thinking, OpenRouter's reasoning details, Gemini's thought signatures on tool calls. Core stores it with the assistant message and sends it back untouched. Anthropic refuses a turn that mixes thinking and tools without it. A reply from another model is sent back without it.
- **Cache usage.** `inputTokens` counts every input token. `cacheReadTokens` and `cacheWriteTokens` say how many of them were cache reads and writes.
- **Error kinds.** `not-found` (HTTP 404), `filtered` (a content filter or a refusal), `paused` (a cap stopped the call before it was sent), and `invalid-tool-call`. A call is passed on only with a well-formed name of a tool the request offered, an id, and arguments that are a plain JSON object using no name every object already has (`{"toString": null}` is refused). Anything else is never passed on, so no tool runs with `{}` or with arguments that change what an object does.
- **Usage on every path.** `done` says `unreported` when the endpoint gave no usage, so zeros never stand for "free". An error carries the usage reported so far, and `usageFinal` when that is the endpoint's final count (a filter or a bad tool call is read to the end for it). A stop carries the partial usage.
- **`notProcessed`**, set only when the endpoint or the transport said the request wasn't acted on. Retries and the caps ledger depend on it.
- **`transport`**, the guarded fetch's word for why it failed (`no-key`, `not-saved` and so on), including part way through a reply (`timeout`, `too-large`, `revoked`), which the adapter reads from the body stream's error.
- **`thinking`** on a request asks a model that can think to do so.

Every error message is Familiar's own words. An endpoint's text can echo a key, so it is never shown, and the contract checks that.

## The adapter

pi-ai 1.5.2, pinned exactly. Only its `openai-completions` and `anthropic-messages` modules load, each behind its own dynamic import. Gemini goes through Google's OpenAI-compatible endpoint, because pi-ai's native Gemini path can only use the global fetch.

- **The fetch is passed in**, and in the app it is always `guardedFetch(address)`. The adapter never touches the global fetch, and a test fails if it does.
- **A keyed endpoint gets the placeholder** `familiar-stored-key` as its key. The exe swaps it for the stored key in the one key header. No real key exists in page code.
- **Error kinds come from the HTTP status** that the injected fetch saw, plus Retry-After and Anthropic's `x-should-retry`. pi-ai only gives text.
- **It never throws.** Building the request, every event and every conversion are inside one catch, which ends the reply with exactly one plain error, carrying any usage known. A failure before anything was sent is `bad-request`, not processed.
- The SDKs' `x-stainless-*` headers, which name the OS, CPU and runtime, are removed. The User-Agent is Familiar's.
- Gemini's thought signatures aren't kept by pi-ai, so the adapter reads them from the raw chunks and puts them back on the next request's tool calls.

## Presets

Each preset sets its own compatibility options instead of leaving pi-ai to guess from the address.

| Preset | Base URL | Key | API | Options |
| --- | --- | --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | required | OpenAI-compatible | OpenRouter's reasoning format, no `store`, `max_tokens`. Prices and tool calling from its model list |
| OpenAI | `https://api.openai.com/v1` | required | OpenAI chat completions | `store: false`, the `developer` role, `max_completion_tokens` |
| Anthropic | `https://api.anthropic.com` | required | Anthropic Messages | Prompt caching on (`short`) |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | required | OpenAI-compatible | No `store`, no `developer` role, `max_tokens`, reasoning effort |
| Ollama | `http://localhost:11434/v1` | none | OpenAI-compatible | As plain as possible: no `store`, no `developer` role, no reasoning effort, `max_tokens`. Priced at $0 |
| LM Studio | `http://localhost:1234/v1` | none | OpenAI-compatible | As Ollama |
| Custom | any OpenAI-compatible address | optional, sent only when one is saved | OpenAI-compatible | As Ollama. Price unknown |

Prompt caching stays on for Anthropic: a chat sends the same system prompt and history every turn, cache reads cost a tenth of input, and writes a quarter more.

## Model list

`listModels` asks the endpoint's own list (`/models`, or Anthropic's `/v1/models`) over the same guarded fetch. Tool calling is shown only where the endpoint says so: OpenRouter publishes it, and elsewhere it's unknown, never guessed. Prices follow [Prices](#prices): the endpoint's own, else the labelled catalog price for a known model, else unknown. A local server's price is a known $0. A model that can't call tools is still listed, and its note says it chats with tools off.

## Test

Settings' Test makes one small call that asks the model to call a do-nothing tool, and says in plain words what's wrong. Tool calling counts as working only when a well-formed call to that tool comes back. A plain answer, or a call to another tool, says "it answered without calling the tool, so tool use is unproven", and is never a pass.

| Result | When |
| --- | --- |
| Works, and calls tools | A valid call to the test tool came back |
| Works, tool use unproven | It answered, but didn't call the tool, or called it malformed |
| Works, can't call tools | The call with the tool was refused or got a 404 (OpenRouter's answer when no provider of a model takes tools), and the same call without it worked. It chats with tools off |
| No key saved | The preset needs a key and none is saved. Checked before any call |
| Key refused | HTTP 401 or 403, or Gemini's 400 with `API_KEY_INVALID` |
| Not allowed yet | The address isn't saved |
| Couldn't reach it | A network failure. For a local server it asks whether it's running |
| No such model | The call fails with a 404 even without the tool, or is refused and the model list lacks the model |
| Limited, failed, filtered | A 429, a 5xx, a content filter |

It never shows a key or an endpoint's own text.

## Prices

Best first: a price the person typed; a local server's $0; the endpoint's own list (OpenRouter publishes per-model prices); and for OpenAI, Anthropic and Gemini, which publish none, the price pi-ai 1.5.2's catalog lists for a model id it knows. A catalog price is always labelled "listed price in Familiar's model catalog", never shown as live. `apps/desktop/src/model/catalog-prices.ts` is generated from the pinned catalog (`scripts/catalog-prices.ts`), and a test fails if it drifts. Tiered prices (a higher rate above some input size) are kept. A model with no price makes a dollar cap pause, saying it needs one. A token cap always works.

## Caps

A pure unit, `packages/core/src/model/caps.ts`, kept as a reservation ledger. The clock and the usage store are passed in, and the real store comes with the journal in step 5. `cappedPort` wraps a model port so every call goes through it.

- **Reply length:** every request's max output tokens is capped at `maxReplyTokens`.
- **Before each call, `before` reserves the call's worst case**, in tokens and in dollars, against today's settled spend plus every open reservation. All of that happens in one step under one lock, so two calls that overlap can never both spend the same remainder. If the reservation would pass a cap, the call pauses: nothing is reserved or sent, and the message says which cap and why.
- **The worst case** is the input's upper bound plus the reply cap. The input bound is the request's UTF-8 bytes plus framing per message, since byte-level tokenizers never give more than one token per byte, whatever the script. When the same conversation's earlier call reported its final input count, the bound is that count plus the bytes added since, if the prefix is unchanged. Dollars are at the highest rate that could apply: with caching, input may be billed as a cache write, so the input rate is the higher of the two, and a tiered price uses its top tier. If any rate that could apply is unknown, a dollar cap pauses.
- **After each call, `settle`** reconciles the reservation:
  - The endpoint reported its final usage: it drops to that.
  - The endpoint said the request wasn't processed: it's released.
  - Anything else (a stop, an error after sending, a stream that ended early, usage that's missing or partial): it stays spent as reserved, or as the reported usage if that's more. Missing usage is unknown, never zero.
  - A reservation not settled within its deadline (30 minutes) stays spent.
- **Caps:** tokens per turn and per day, across personas, and an optional daily dollar cap per persona. A cost that can't be priced is `unknown`, never $0, and only its tokens count.
- **The property test** runs 200 seeded random interleavings of reservations, settlements, stops and errors across concurrent calls, and checks that recorded plus reserved spend never passes a cap, and that nothing settles below the usage reported.

## Retries

`withRetries` wraps any model port, outside the caps, so each try takes its own reservation. Three tries in all, backing off 1 s then 2 s with jitter. A Retry-After is honoured up to 30 s. A longer one ends the call with the error, so the person sees it.

A call is sent again only if all of these hold:

- No event of the reply had been delivered.
- The error is a rate limit, a server error or a network error. Never `aborted` or `paused`.
- The endpoint said, in its own words, that it didn't take the request (`notProcessed`). A status code alone isn't proof:
  - An HTTP 429, unless it says `x-should-retry: false`.
  - A 529 or 503 only with the provider's own sign: `x-should-retry: true`, or Anthropic's `overloaded_error` body. Never a bare 503.
  - Never after any redirect (the response was redirected, or its final URL isn't the one sent).
  - A request the guarded fetch refused before sending.

An HTTP 500 or a dropped connection might have been half done, so it isn't retried. The guarded fetch reports a failed connect and a failure after sending both as `network`, so neither is retried.

## Recorded replies

Hand-built from each API's documented wire format, with the source of each in the file's header. No real endpoint produced them, and no key or paid call was used. Three wires: OpenAI chat completions (streaming), Anthropic Messages (streaming), and Gemini's OpenAI-compatible route. Each covers text, a tool call, thinking with signatures and the next turn that needs them, bad and unsafe tool arguments, cache usage, no usage at all, a length stop, a content filter, a 401, a 429, a 429 reached through a redirect, an overload with and without the provider's sign, a 500, a stream that goes quiet past the idle limit, and one past the size limit.

The next-turn check reads each API's own structure, not just whether the signature appears somewhere: Anthropic's thinking block with its signature, before the tool call; OpenRouter's `reasoning_details`; Gemini's thought signature on the right tool call. Its controls (the signature as plain text, on the wrong call, or after the call) must be refused, and are, in `tests/model/recordings.test.ts`. The Gemini shapes come from Google's docs, and haven't been checked against the live endpoint.

The contract runs over them:

- **In Node** (`apps/desktop/tests/model/contract.test.ts`): for every preset with a plain injected fetch, and for the three APIs over the real `guardedFetch` with a stand-in exe that swaps and blanks the key.
- **In the real exe's core window** on the Windows runner (`shell-check/model-checks.ts`), over `guardedFetch`, against `net-server.mjs` serving the recordings at a saved address, with a key typed into Settings:
  - `check.model.contract`: every case for all three APIs. Its control: a case run against the wrong recording must fail.
  - `security.model.key-swap`: the page sent only the placeholder, the endpoint got the key typed into Settings (it answers with a hash of the key it got), its echo of the key came back as `[key]`, and nothing the page saw held the key. Its control: a key the page made itself, sent to an address with no stored key, comes back whole and hashes to match, so the hash and the scan both work.

## What redaction does and doesn't cover

The exe blanks literal copies of the key in everything that comes back, such as an error page that prints the header it got. It doesn't catch an endpoint that encodes the key on purpose, for example as JSON escapes or split across tool-argument events. Such an endpoint already holds the key, and [shell-design.md](shell-design.md#5a-credentials) treats the recipient of a key as trusted. JSON-escaped variants are planned for the exe's matcher in the pre-release native pass.

## Not settled

- Live behaviour of every endpoint: the recordings are from docs. In particular Gemini's OpenAI-compatible endpoint (its tool-call and error shapes, whether it takes the thought signature back as recorded), and Ollama and LM Studio quirks.
