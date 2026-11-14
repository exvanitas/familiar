// Familiar's rule: a bare acknowledgement, such as "thanks" or "ok", gets no message reply.
// A reaction is fine. One exception: if her last message asked you something, "ok" is an answer, so it goes
// to the model as usual. This check is local and costs no model call.

const ACK_PHRASES = [
  'thanks', 'thank you', 'thanks a lot', 'thanks so much', 'thank you so much', 'many thanks', 'thx', 'ty', 'tysm',
  'tyvm', 'cheers', 'ok', 'okay', 'k', 'kk', 'okie', 'oki', 'okey', 'got it', 'gotcha', 'cool', 'nice', 'great',
  'perfect', 'awesome', 'alright', 'all right', 'sounds good', 'noted', 'will do', 'roger', 'understood'
];

/** Emoji that only acknowledge. A lone 😢 is not an acknowledgement. */
const ACK_EMOJI = ['👍', '👌', '🙏', '❤', '♥', '💜', '💖', '🫶', '😊', '🙂', '😄', '✅'];

const MAX_LENGTH = 40;

const phrasePattern = ACK_PHRASES.map((p) => p.replace(/ /g, '\\s+')).sort((a, b) => b.length - a.length).join('|');
const ACK_TEXT = new RegExp(`^(?:${phrasePattern})(?:\\s+(?:${phrasePattern}))*$`, 'u');
const EMOJI = /[\p{Extended_Pictographic}♥️‍\u{1F3FB}-\u{1F3FF}]/gu;

export interface AckOptions {
  /** The persona's name, so "thanks Mira" still counts. */
  readonly personaName?: string;
}

/** True when the message only acknowledges: words like "thanks" or "ok", acknowledging emoji, or both. */
export function isBareAcknowledgement(text: string, options: AckOptions = {}): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return false;

  const emoji = trimmed.match(EMOJI) ?? [];
  const meaningful = emoji.filter((e) => e !== '️' && e !== '‍' && !/[\u{1F3FB}-\u{1F3FF}]/u.test(e));
  if (meaningful.some((e) => !ACK_EMOJI.includes(e))) return false;

  let words = trimmed
    .replace(EMOJI, ' ')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.,!~…:;)(\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = options.personaName?.trim().toLowerCase();
  if (name) words = words.replace(new RegExp(`(^|\\s)${escapeRegExp(name)}$`, 'u'), '').trim();

  if (words === '') return meaningful.length > 0;
  return ACK_TEXT.test(words);
}

/** True when her message ends by asking something, so a short "ok" in reply is an answer. */
export function endsWithQuestion(text: string): boolean {
  const tail = text.replace(EMOJI, '').replace(/[\s"'”’)\]*_]+$/u, '');
  return tail.endsWith('?');
}

/** Whether a message from you needs a reply message, or only a reaction. */
export function needsReply(userText: string, lastPersonaText: string | undefined, options: AckOptions = {}): boolean {
  if (!isBareAcknowledgement(userText, options)) return true;
  return lastPersonaText !== undefined && endsWithQuestion(lastPersonaText);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
