# Model layer

Step 4: the model port, the pi-ai adapter, the presets, the model list, Test, caps and retries. Settings and the first-run screens (step 11) and the turn loop (step 5) build on these. It follows the conditions in [spikes.md](spikes.md#pi-ai-152-yes-with-conditions). Step 10c adds [the decision models](#decision-models) and their download.

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
- **Usage on every path.** `done` says `unreported` unless the endpoint sent its final usage, so zeros never stand for "free". Final means every counter the API defines is a whole, non-negative number the endpoint really sent, together with that API's own sign the reply is over: for OpenAI-compatible endpoints a usage chunk with `prompt_tokens` and `completion_tokens` and a `finish_reason`; for Anthropic `input_tokens` in `message_start`, `output_tokens` in `message_delta` with its `stop_reason`, then `message_stop`. `usage: {}`, a missing count, a string or a negative number is unreported. An error carries the usage reported so far, and `usageFinal` when that is the endpoint's final count (a filter or a bad tool call is read to the end for it). A stop carries the partial usage.
- **`notProcessed`**, set only when the endpoint or the transport said the request wasn't acted on. Retries and the caps ledger depend on it.
- **`transport`**, the guarded fetch's word for why it failed (`no-key`, `not-saved` and so on), including part way through a reply (`timeout`, `too-large`, `revoked`), which the adapter reads from the body stream's error.
- **`thinking`** on a request asks a model that can think to do so.

Every error message is Familiar's own words. An endpoint's text can echo a key, so it is never shown, and the contract checks that.

## The adapter

pi-ai 1.5.2, pinned exactly. Only its `openai-completions` and `anthropic-messages` modules load, each behind its own dynamic import. Gemini goes through Google's OpenAI-compatible endpoint, because pi-ai's native Gemini path can only use the global fetch.

- **The fetch is passed in**, and in the app it is always `guardedFetch(address)`. The adapter never touches the global fetch, and a test fails if it does.
- **A keyed endpoint gets the placeholder** `familiar-stored-key` as its key. The exe swaps it for the stored key in the one key header. No real key exists in page code.
- **Error kinds come from the HTTP status** that the injected fetch saw, plus Retry-After and Anthropic's `x-should-retry`. pi-ai only gives text.
- **It never throws.** Building the request, every event and every conversion are inside one catch, which ends the reply with exactly one plain error, carrying any usage known. Each terminal event is built in full before it counts as sent, so a hostile value (a `finish_reason` of `{"toString": null}`) that throws while it's built still ends in the catch's error. That error reads nothing the endpoint sent: fixed words and a kind. A failure before anything was sent is `bad-request`, not processed.
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

**No default, decided 2026-11-16.** The owner: "No first run default model, we just test against some popular ones like opus and others so we can recommend what we tested against." First-run setup (step 11) lists the presets evenly (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, LM Studio, a custom address), with nothing pre-selected. Beside them, a short "tested with" list says which models we've checked, on which date and Familiar version, so a person can pick one we vouch for. The setup screen reads the same file the app ships with, so it always agrees with [tested-models.md](tested-models.md). A model not on the list still works: the list only says what we checked.

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

## Local chat models

A model you already run in Ollama (`localhost:11434`) or LM Studio (`localhost:1234`) is used as it is, through the presets above (owner, 2026-11-16: "I guess we will indeed let people wire up local models still if they have something running on ollama or lmstudio etc.").

- **The same prompt as any model.** No extra persona prompt and no tune: her voice comes from her card, as with every model.
- **Tools only if the model handles them.** Test says whether it does. If it doesn't, she chats without tools, and Settings says so, as for any model that can't call tools.
- **No internet needed.** A local chat model works offline, and then she talks as usual.
- **Not on the "tested with" list yet.** Testing against local setups is a later tier, "not immediately", as the owner said ([design.md](design.md#build-order)).

## Prices

Best first: a price the person typed; a local server's $0; the endpoint's own list (OpenRouter publishes per-model prices); and for OpenAI, Anthropic and Gemini, which publish none, the price pi-ai 1.5.2's catalog lists for a model id it knows. A catalog price is always labelled "listed price in Familiar's model catalog", never shown as live. `apps/desktop/src/model/catalog-prices.ts` is generated from the pinned catalog (`scripts/catalog-prices.ts`), and a test fails if it drifts. Tiered prices (a higher rate above some input size) are kept. A model with no price makes a dollar cap pause, saying it needs one. A token cap always works.

## Caps

A pure unit, `packages/core/src/model/caps.ts`, kept as a reservation ledger. The clock and the usage store are passed in. The app's store is the journal's (step 5, [turn-design.md](turn-design.md#durable-cap-reservations)), so reservations and settled spend survive a restart. `cappedPort` wraps a model port so every call goes through it.

- **Reply length:** every request's max output tokens is capped at `maxReplyTokens`.
- **Before each call, `before` reserves the call's worst case**, in tokens and in dollars, against today's settled spend plus every open reservation. All of that is one atomic update of the store, so two calls that overlap, in one instance or two on the same store, can never both spend the same remainder. If the reservation would pass a cap, the call pauses: nothing is reserved or sent, and the message says which cap and why.
- **The worst case** is the input's upper bound plus the reply cap. The input bound is the request's UTF-8 bytes plus framing per message, since byte-level tokenizers never give more than one token per byte, whatever the script. When the same conversation's earlier call reported its final input count, the bound is that count plus the bytes added since, if the prefix is unchanged. That count is kept per endpoint and model, and the prefix includes the system prompt, the tools and the thinking setting, so a model switch or a changed prompt starts again from the byte count. Dollars are at the highest rate that could apply: with caching, input may be billed as a cache write, so the input rate is the higher of the two, and a tiered price uses its top tier. If any rate that could apply is unknown, a dollar cap pauses.
- **After each call, `settle`** reconciles the reservation:
  - The endpoint reported its final usage, as whole numbers: it drops to that. An empty, partial or malformed usage object is no count.
  - The endpoint said the request wasn't processed: it's released.
  - Anything else (a stop, an error after sending, a stream that ended early, usage that's missing or partial): it stays spent as reserved, or as the reported usage if that's more. Missing usage is unknown, never zero.
  - A reservation not settled within its deadline (30 minutes) stays spent. Only the instance that made it can settle it, so one a restart left open stays spent too.
- **Caps:** tokens per turn and per day, across personas, and an optional daily dollar cap per persona. A turn counts its spend across every date, so one that runs past midnight keeps its cap; only the daily caps start again. A cost that can't be priced is `unknown`, never $0, and only its tokens count.
- **The property test** runs, on the memory store and on the journal's store, 200 seeded random interleavings of reservations, settlements, stops and errors across concurrent calls in one conversation, switching between two models that count the same bytes differently, with empty and partial usage among the outcomes. It checks that recorded plus reserved spend never passes a cap, that nothing settles below the usage reported or really used, and that no call uses more than was reserved for it.

## Retries

`withRetries` wraps any model port, outside the caps, so each try takes its own reservation. Three tries in all, backing off 1 s then 2 s with jitter. A Retry-After is honoured up to 30 s. A longer one ends the call with the error, so the person sees it.

A call is sent again only if all of these hold:

- No event of the reply had been delivered.
- The error is a rate limit, a server error or a network error. Never `aborted` or `paused`.
- The endpoint said, in its own words, that it didn't take the request (`notProcessed`). A status code alone isn't proof:
  - An HTTP 429, unless it says `x-should-retry: false`.
  - A 529 or 503 only with the provider's own sign: `x-should-retry: true`, or Anthropic's `overloaded_error` body. Never a bare 503.
  - Never after any redirect (the response was redirected, or its final URL isn't the one sent).
  - A request the guarded fetch refused before any network: `no-key`, `not-saved` or `busy`, which the exe checks before its first send. Every other transport kind (`blocked-address`, `network`, `tls`, `insecure`, a refused connection) can come from a later hop such as a redirect, after a request was sent, so it settles as spent and is never retried.

An HTTP 500 or a dropped connection might have been half done, so it isn't retried. The guarded fetch reports a failed connect and a failure after sending both as `network`, so neither is retried.

## Recorded replies

Hand-built from each API's documented wire format, with the source of each in the file's header. No real endpoint produced them, and no key or paid call was used. Three wires: OpenAI chat completions (streaming), Anthropic Messages (streaming), and Gemini's OpenAI-compatible route. Each covers text, a tool call, thinking with signatures and the next turn that needs them, bad and unsafe tool arguments, cache usage, no usage at all, a length stop, a content filter, a 401, a 429, a 429 reached through a redirect, an overload with and without the provider's sign, a 500, a stream that goes quiet past the idle limit, and one past the size limit.

The next-turn check reads each API's own structure and the recorded content, not just whether the signature appears somewhere: Anthropic's thinking block with the recorded thinking and its signature, before the recorded tool call; OpenRouter's `reasoning_details`, with the recorded reasoning, on the assistant message that holds the recorded call; Gemini's thought signature on the recorded tool call with its recorded arguments. Its controls (the signature as plain text, under altered thinking, on the wrong call or message, or after the call) must be refused, and are, in `tests/model/recordings.test.ts`. The Gemini shapes come from Google's docs, and haven't been checked against the live endpoint.

The contract runs over them:

- **In Node** (`apps/desktop/tests/model/contract.test.ts`): for every preset with a plain injected fetch, and for the three APIs over the real `guardedFetch` with a stand-in exe that swaps and blanks the key.
- **In the real exe's core window** on the Windows runner (`shell-check/model-checks.ts`), over `guardedFetch`, against `net-server.mjs` serving the recordings at a saved address, with a key typed into Settings:
  - `check.model.contract`: every case for all three APIs. Its control: a case run against the wrong recording must fail.
  - `security.model.key-swap`: the page sent only the placeholder, the endpoint got the key typed into Settings (it answers with a hash of the key it got), its echo of the key came back as `[key]`, and nothing the page saw held the key. Its control: a key the page made itself, sent to an address with no stored key, comes back whole and hashes to match, so the hash and the scan both work.

## What redaction does and doesn't cover

The exe blanks literal copies of the key in everything that comes back, such as an error page that prints the header it got. It doesn't catch an endpoint that encodes the key on purpose, for example as JSON escapes or split across tool-argument events. Such an endpoint already holds the key, and [shell-design.md](shell-design.md#5a-credentials) treats the recipient of a key as trusted. JSON-escaped variants are planned for the exe's matcher in the pre-release native pass.

## Decision models

Step 10c. The chat model talks; decision models only decide whether she reacts unprompted, and roughly how ([design.md](design.md#the-decision-slot-should-the-persona-react)). They answer an act and a kind and never write words. Decided by the owner on 2026-11-16: "I think we download at first run." And on how it runs: "Webassembly, fine." The decider behind the port, its time limit and the limits after it are in [turn-design.md](turn-design.md#the-decision-slot).

### The small model, downloaded at first run

Under 1B parameters, picked by Claviger's bake-off, and offered only once it beats the rules on the shared test bench. Until one does, first run offers no download.

- **The offer.** One screen after the chat model's: "Familiar can download a small model (NNN MB) that helps her judge when to react. It runs on your PC, needs no account, and sends nothing anywhere. Download / Skip." The size is the real size, and the model's licence is one click away on the same screen. Skip means the rules decide. Settings keeps "Download the decision model" for later, and "Remove" to delete it, with the licence shown there too.
- **The pinned manifest.** The app folder carries a manifest that pins the model: its name and version, its licence text, and for each part a URL and a SHA-256. A changed model means a new app version with a new manifest, never a URL that quietly serves something else.
- **Parts of at most 64 MB.** The guarded fetch caps one response at 256 MiB, and parts make resuming simple. Each part's request asks for its own size as `maxBytes`, above the 32 MiB default and well under the cap.
- **Checked as they arrive.** Each part is hashed as it comes in and checked against its pinned SHA-256. A part that doesn't match is thrown away and fetched again, at most twice, and then the download stops and says so. The model is used only when every part has matched.
- **Resumable.** The parts already checked are kept in the app's storage (IndexedDB, which already holds everything else, with persistent storage granted). A download stopped by a quit, a crash or a lost connection carries on from the first missing part at the next start, or when you press Download again. A part half-fetched is fetched again whole.
- **Through the guarded fetch, as everything else.** The download host is saved once, through the exe's own approval dialog, like any address, and nothing is fetched before you allow it. It's saved as a `model` address with no key, so the dialog says "a model endpoint", which is near enough: it's where her decision model comes from. A dedicated kind with its own words would be a native-pass item (about 0.25 h), and isn't proposed. With no key on the address, redaction has nothing to blank, so the bytes arrive as sent, and the hashes would catch it if they didn't.
- **A host that serves the parts directly.** The guarded fetch follows a redirect only under the saved address ([shell-design.md](shell-design.md#5c-the-guarded-fetch)), and both GitHub's release files and Hugging Face redirect to a separate CDN host. So the parts live on a host that serves them directly. Recommended: the project's own static site (GitHub Pages serves files directly, up to 100 MB each, so 64 MB parts fit), decided with the release work in step 12. Letting the download follow redirects to one pinned CDN host would loosen a rule the fetch's security checks stand on, so it isn't proposed.
- **Where it runs: in core, by WebAssembly, in a worker.** No native code. The CSP the exe pins for every page already allows it (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src blob:`), so there's no exe change, and a downloaded model file never reaches native code. It's single-threaded there, so a decision may take a second or two, which suits ambient moments. The format follows the bake-off's pick: ONNX through onnxruntime-web, or GGUF through a WebAssembly build of llama.cpp.
- **What it reads.** What the rules decider reads: her traits and interests, chattiness, the summaries, the last 10 events and 3 reactions, the local time. Never window titles, paths, message text or the card's text.

### A bigger model on your GPU, optional

- Served by your own Ollama or LM Studio, which already run on the GPU. Familiar adds no GPU code.
- You pull the bigger model into your runtime (the docs say which, by name), and point the decision setting at it. It goes through the same guarded fetch to `localhost` that the Ollama and LM Studio presets use. A new address asks first, like any; one already saved for the chat model is the same address and doesn't ask again.
- Same inputs, same answer shape, the same limits above it, and the same time limit. It falls back to the small model, then the rules.

### The decision setting

One setting in Settings: the rules, the downloaded model, or an address you saved. With no model downloaded, it's the rules. Whichever you pick, the rules stay behind it.

### The time limit, and the rules behind it

If a model doesn't answer within its limit, isn't there, or fails to load, the rules answer for that event. The limit starts at 2 s, set from the bake-off pick's measured speed on an ordinary CPU. A decision writes nothing durable, so a deadline is safe here: abandoning the model's late answer changes no state.

## Not settled

- The decision model itself: which one, its size and format, and its time limit, from the bake-off. The bake-off times its finalists in WebAssembly; if the best can't answer within the limit there, the numbers go back to the owner.
- Where the decision model's parts are hosted, decided in step 12.
- Live behaviour of every endpoint: the recordings are from docs. In particular Gemini's OpenAI-compatible endpoint (its tool-call and error shapes, whether it takes the thought signature back as recorded), and Ollama and LM Studio quirks.
