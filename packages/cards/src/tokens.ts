// Token estimates. The real count depends on the model's tokenizer, which Familiar doesn't ship, so
// the default errs high: a prompt it says fits, fits.

export type TokenEstimator = (text: string) => number;

/**
 * About three characters a token for ASCII (English runs nearer four, so this overestimates by about
 * a third), and one token for every other character (CJK and emoji often take one or more each).
 */
export const estimateTokens: TokenEstimator = (text) => {
  let ascii = 0, other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other;
};
