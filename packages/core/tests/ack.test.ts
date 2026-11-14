import { describe, expect, it } from 'vitest';
import { endsWithQuestion, isBareAcknowledgement, needsReply } from '../src/index.ts';

describe('bare acknowledgements', () => {
  it.each([
    'thanks', 'Thanks!', 'thank you', 'Thank you so much!!', 'ok', 'OK.', 'okay', 'k', 'ok thanks', 'Ok, thank you!',
    'got it', 'cool, thanks', 'perfect', 'sounds good', '👍', '🙏', 'thanks 👍', '👍🏽', '❤️', 'ty', 'thx!'
  ])('%j only acknowledges', (text) => {
    expect(isBareAcknowledgement(text)).toBe(true);
  });

  it.each([
    'thanks, can you also set a timer?', 'ok?', 'ok so what about tomorrow', 'no', 'set a timer', 'thanks but that was wrong',
    '😢', 'ok 😢', '', '   ', 'thanks thanks thanks thanks thanks thanks thanks thanks', 'okay do it'
  ])('%j is more than an acknowledgement', (text) => {
    expect(isBareAcknowledgement(text)).toBe(false);
  });

  it('allows the persona name after the acknowledgement', () => {
    expect(isBareAcknowledgement('thanks Mira', { personaName: 'Mira' })).toBe(true);
    expect(isBareAcknowledgement('thanks Mira')).toBe(false);
  });
});

describe('needs a reply message', () => {
  it('skips the reply to a bare thanks after an answer', () => {
    expect(needsReply('thanks!', 'Your timer is set for 15:00.')).toBe(false);
    expect(needsReply('ok', undefined)).toBe(false);
  });

  it('replies when "ok" answers her question', () => {
    expect(needsReply('ok', 'Want me to set a reminder for that?')).toBe(true);
    expect(needsReply('ok', 'Shall I? 🙂')).toBe(true);
    expect(needsReply('ok', 'Should I add it to your notes?"')).toBe(true);
  });

  it('replies to anything more than an acknowledgement', () => {
    expect(needsReply('thanks, and one more thing', 'Done.')).toBe(true);
  });

  it('spots a question at the end of her message', () => {
    expect(endsWithQuestion('Is that right?')).toBe(true);
    expect(endsWithQuestion('Done. Anything else? 😊')).toBe(true);
    expect(endsWithQuestion('Done.')).toBe(false);
    expect(endsWithQuestion('Is it? No, it is fine.')).toBe(false);
  });
});
