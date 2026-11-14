# Changelog

Every shipped change gets an entry here. Releases are tagged.

## Unreleased
- The workspace and CI.
- The model port, a scripted fake model, and the contract every model adapter must keep.
- A fake MCP server for dev and tests, over stdio or HTTP.
- The decision slot: should the persona react to something nobody asked about, and how. The first decider is the accepted reaction rules.
- A bare "thanks" or "ok" gets no reply message, unless it answers her question.
- Step 2 checks, each a yes with conditions: pi-ai as the model layer in the webview, pi-durable as the durable engine in the webview, and starting local MCP servers on Windows. See docs/spikes.md.
- Data will live in IndexedDB through pi-durable's store, with a check for each drawback. See docs/design.md.
