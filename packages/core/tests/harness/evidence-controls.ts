// The evidence's own controls: switches that put an old, weaker reading of the evidence back, so a test can
// show the current reading is what catches (or clears) a case. Off unless a test turns one on.
export const evidenceControls = {
  countRefusedStarts: false,
  globalTests: false,
  globalStarts: false,
  /** The no-final sentinel (-1) taken as the stream's terminal index, as 6b40d2c's clamp did. */
  finalSentinel: false,
  /** A Start's reply taken as the first one after it, by order (the old pairing), not by its token. */
  startsByOrder: false,
  /** The client's end taken at the final response only, never at the message its parser rejected. */
  finalOnly: false,
  /** Remote pages bound to the fake exe's global handshake epoch, not their own destination's (the old reading). */
  globalHandshakes: false,
  /** A local page read from the scripted plan, not the response the client accepted (the old reading). */
  scriptedPages: false
};
