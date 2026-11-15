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
- **Error kinds.** `not-found` (HTTP 404), `filtered` (a content filter or a refusal), and `invalid-tool-call` (arguments that aren't a JSON object, with `toolName`). Such a call is never passed on, so no tool runs with `{}`.
- **`notProcessed`**, set only when the endpoint or the transport said the request wasn't acted on. Retries depend on it.
- **`transport`**, the guarded fetch's word for why it failed (`no-key`, `not-saved` and so on).
- **`thinking`** on a request asks a model that can think to do so.

Every error message is Familiar's own words. An endpoint's text can echo a key, so it is never shown, and the contract checks that.

## The adapter

pi-ai 1.5.2, pinned exactly. Only its `openai-completions` and `anthropic-messages` modules load, each behind its own dynamic import. Gemini goes through Google's OpenAI-compatible endpoint, because pi-ai's native Gemini path can only use the global fetch.

- **The fetch is passed in**, and in the app it is always `guardedFetch(address)`. The adapter never touches the global fetch, and a test fails if it does.
- **A keyed endpoint gets the placeholder** `familiar-stored-key` as its key. The exe swaps it for the stored key in the one key header. No real key exists in page code.
- **Error kinds come from the HTTP status** that the injected fetch saw, plus Retry-After and Anthropic's `x-should-retry`. pi-ai only gives text.
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

`listModels` asks the endpoint's own list (`/models`, or Anthropic's `/v1/models`) over the same guarded fetch. Price and tool calling are shown only where the endpoint says so: OpenRouter publishes both. Elsewhere they're unknown, never guessed. A local server's price is a known $0. A model that can't call tools is still listed, and its note says it chats with tools off.

## Test

Settings' Test makes one small call, with one do-nothing tool, and says in plain words what's wrong:

| Result | When |
| --- | --- |
| No key saved | The preset needs a key and none is saved. Checked before any call |
| Key refused | HTTP 401 or 403, or Gemini's 400 with `API_KEY_INVALID` |
| Not allowed yet | The address isn't saved |
| Couldn't reach it | A network failure. For a local server it asks whether it's running |
| No such model | HTTP 404, or a refusal and a model list without the model |
| Can't call tools | The call with a tool was refused and the same call without one worked. It still chats, with tools off |
| Limited, failed, filtered | A 429, a 5xx, a content filter |

It never shows a key or an endpoint's own text.

## Caps

A pure unit. The clock and the usage store are passed in, and the real store comes with the journal in step 5. The turn loop asks `before` ahead of each call and tells `after` what each call used.

- **Reply length:** every request's max output tokens is capped at `maxReplyTokens`.
- **Tokens** per turn and per day, across personas. A call pauses if its longest possible size (input estimated at three characters a token, which errs high, plus the max reply) would pass a cap.
- **Cost**, where a price is known: plain input, cache reads, cache writes and output, each at its own rate. A cost it can't price is `unknown`, never $0, and only its tokens count.
- **A daily cap per persona**, optional, in US dollars. Checked before each call against today's spend plus that call's longest possible cost. Over it, the call pauses with a plain message, and nothing is sent. If the model's price isn't known, a capped persona pauses too, because the cap can't be kept: the message asks for a price or for the cap to go.

## Retries

`withRetries` wraps any model port. Three tries in all, backing off 1 s then 2 s with jitter. A Retry-After is honoured up to 30 s. A longer one ends the call with the error, so the person sees it.

A call is sent again only if all of these hold:

- No event of the reply had been delivered.
- The error is a rate limit, a server error or a network error. Never `aborted`.
- The endpoint or the transport said the request wasn't acted on (`notProcessed`): HTTP 429, 503 or 529, Anthropic's `x-should-retry: true`, or a connection never made. An HTTP 500 or a dropped connection might have been half done, so it isn't retried. The guarded fetch reports a failed connect and a failure after sending both as `network`, so neither is retried.

## Recorded replies

Hand-built from each API's documented wire format, with the source of each in the file's header. No real endpoint produced them, and no key or paid call was used. Three wires: OpenAI chat completions (streaming), Anthropic Messages (streaming), and Gemini's OpenAI-compatible route. Each covers text, a tool call, thinking with signatures and the next turn that needs them, bad tool arguments, cache usage, a length stop, a content filter, a 401, a 429, an overload and a 500. The Gemini shapes come from Google's docs, and haven't been checked against the live endpoint.

The contract runs over them:

- **In Node** (`apps/desktop/tests/model/contract.test.ts`): for every preset with a plain injected fetch, and for the three APIs over the real `guardedFetch` with a stand-in exe that swaps and blanks the key.
- **In the real exe's core window** on the Windows runner (`shell-check/model-checks.ts`), over `guardedFetch`, against `net-server.mjs` serving the recordings at a saved address, with a key typed into Settings:
  - `check.model.contract`: every case for all three APIs. Its control: a case run against the wrong recording must fail.
  - `security.model.key-swap`: the page sent only the placeholder, the endpoint got the key typed into Settings (it answers with a hash of the key it got), its echo of the key came back as `[key]`, and nothing the page saw held the key. Its control: a key the page made itself, sent to an address with no stored key, comes back whole and hashes to match, so the hash and the scan both work.

## Not settled

- Live behaviour of every endpoint: the recordings are from docs. In particular Gemini's OpenAI-compatible endpoint (its tool-call and error shapes, whether it takes the thought signature back as recorded), and Ollama and LM Studio quirks.
- Usage of a reply that fails part way is counted only when the endpoint reported it before failing.
