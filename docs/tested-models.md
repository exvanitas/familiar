# Tested with: the chat models we check

Familiar has no default chat model. First-run setup lists the presets evenly, and beside them this list says which models we've checked, on which date and with which Familiar version, so a person can pick one we vouch for. Decided by the owner on 2026-11-16: "No first run default model, we just test against some popular ones like opus and others so we can recommend what we tested against."

## What "tested with" means

A model is on the list when it passed every check below, in one scripted run, on the date and Familiar version shown. It says what we checked, nothing more. A model not on the list still works, and a listed model can change at its provider after the date shown.

## Which models

At each release, the current top API models of each provider Familiar has a preset for:

- Anthropic's Opus and Sonnet, and Haiku as the cheap choice.
- OpenAI's flagship and its small model.
- Gemini's Pro and Flash.
- One or two popular open models through OpenRouter.

Local models (Ollama, LM Studio) join the list later, when we test that setup: a later tier, "not immediately", as the owner said ([design.md](design.md#build-order)).

## Which checks

One scripted run per model, the same each time, with a key we hold for testing. Each check passes or fails:

| Check | Passes when |
| --- | --- |
| Her voice | She answers in her card's voice for a short conversation |
| A built-in tool | She sets a reminder, through its consent card when the tool is set to ask |
| An MCP tool | She calls the fake MCP server's tool, through the card, and Stop ends a slow one |
| An unprompted chat | She writes a chat at a moment, from the moment's note alone |
| A long conversation | It compacts, and she goes on in voice after |
| Steering | Outside content that tries to steer a tool call goes nowhere (step 8's steering cases) |
| Cost | The cost of a typical day of use, from the usage the endpoint reports, is written down |

## When it runs

Before each release, as part of the release's checks (step 14), and when a provider ships a new top model. The run costs real API calls, so it's run deliberately, **never in CI**. About an hour each time, plus the API calls.

## Where the list lives

The run writes a small data file, and this list is built from it. The app ships the same file, and the setup screen reads it, so the docs and the setup screen always agree. Don't edit the table by hand.

| Model | Preset | Checked on | Familiar version | Cost of a typical day |
| --- | --- | --- | --- | --- |

None tested yet.

**How a row gets here.** Someone runs the scripted run for a model, with the testing key, before a release or after a provider ships a new top model. The run writes the model's results to the data file. A model that passed every check gets a row, built into this table and shown on the setup screen. A model that failed any check gets none.
