// The evidence's own controls: switches that put an old, weaker reading of the evidence back, so a test can
// show the current reading is what catches (or clears) a case. Off unless a test turns one on.
export const evidenceControls = {
  countRefusedStarts: false,
  globalTests: false,
  globalStarts: false,
  /** The no-final sentinel (-1) taken as the stream's terminal index, as 6b40d2c's clamp did. */
  finalSentinel: false
};
