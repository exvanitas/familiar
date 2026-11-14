import { describe, expect, it } from 'vitest';
import { decideByRules, rulesDecider } from '../src/index.ts';
import type { Decision, DecisionContext, PastReaction, PersonaEvent } from '../src/index.ts';

const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const MIN = 60_000;

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    persona: { sketch: 'A cheerful study buddy.', interests: ['lofi', 'jazz'] },
    chattiness: 'medium',
    doNotDisturb: false,
    fullscreen: false,
    sentAway: false,
    recentEvents: [],
    recentReactions: [],
    minutesSinceChat: 30,
    chatInFront: false,
    now: NOW,
    localHour: 15,
    teaserDue: false,
    ...over
  };
}

const ev = (name: PersonaEvent['name'], over: Partial<PersonaEvent> = {}): PersonaEvent => ({ name, at: NOW, ...over });
const reaction = (minutesAgo: number, decision: Decision, event: PersonaEvent['name'] = 'clicked'): PastReaction => ({
  at: NOW - minutesAgo * MIN,
  decision,
  event
});
const act = (e: PersonaEvent, c: DecisionContext) => decideByRules(e, c).act;

describe('the reaction rules', () => {
  it('keeps quiet under fullscreen or do-not-disturb, always', () => {
    for (const c of [ctx({ fullscreen: true }), ctx({ doNotDisturb: true })]) {
      for (const name of ['back-after', 'first-open-today', 'clicked', 'long-session', 'ack-sent'] as const) {
        expect(act(ev(name, { minutesAway: 90 }), c)).toBe('quiet');
      }
    }
  });

  it('keeps quiet while sent home, hidden or paused', () => {
    expect(decideByRules(ev('back-after', { minutesAway: 90 }), ctx({ sentAway: true }))).toMatchObject({ act: 'quiet', why: 'sent-away' });
    expect(act(ev('clicked'), ctx({ sentAway: true }))).toBe('quiet');
  });

  it('answers a bare acknowledgement with a gesture, never words', () => {
    expect(decideByRules(ev('ack-sent'), ctx())).toMatchObject({ act: 'gesture', why: 'acknowledgement' });
    expect(act(ev('bubble-dismissed'), ctx())).toBe('quiet');
    expect(act(ev('chat-closed'), ctx())).toBe('quiet');
  });

  it('settles for two minutes after a reaction, unless you come back from a long time away', () => {
    const recent = ctx({ recentReactions: [reaction(1, { act: 'gesture', kind: 'playful' })] });
    expect(decideByRules(ev('clicked'), recent)).toMatchObject({ act: 'quiet', why: 'reacted-recently' });
    expect(act(ev('back-after', { minutesAway: 45 }), recent)).not.toBe('quiet');
    const older = ctx({ recentReactions: [reaction(3, { act: 'gesture', kind: 'playful' })] });
    expect(act(ev('clicked'), older)).toBe('gesture');
  });

  it('greets once after 20 minutes away: a gesture at low chattiness, a bubble at medium or high', () => {
    const back = ev('back-after', { minutesAway: 25 });
    expect(decideByRules(back, ctx({ chattiness: 'low' }))).toMatchObject({ act: 'gesture', kind: 'greet' });
    expect(decideByRules(back, ctx({ chattiness: 'medium' }))).toMatchObject({ act: 'bubble', kind: 'greet' });
    expect(decideByRules(back, ctx({ chattiness: 'high' }))).toMatchObject({ act: 'bubble', kind: 'greet' });
    expect(act(ev('back-after', { minutesAway: 10 }), ctx())).toBe('quiet');
  });

  it('keeps unprompted bubbles to one per 10, 30 or 5 minutes by chattiness', () => {
    const lastBubble = (minutesAgo: number) => [reaction(minutesAgo, { act: 'bubble', kind: 'greet' }, 'first-open-today')];
    const back = ev('back-after', { minutesAway: 25 });
    expect(act(back, ctx({ chattiness: 'medium', recentReactions: lastBubble(8) }))).toBe('gesture');
    expect(act(back, ctx({ chattiness: 'medium', recentReactions: lastBubble(11) }))).toBe('bubble');
    expect(act(back, ctx({ chattiness: 'high', recentReactions: lastBubble(6) }))).toBe('bubble');
    expect(act(back, ctx({ chattiness: 'high', recentReactions: lastBubble(4) }))).toBe('gesture');
  });

  it('keeps track changes quiet, with a bubble on the first play today or a mood she likes, never twice in a row', () => {
    expect(decideByRules(ev('track-changed', { mood: 'metal' }), ctx())).toMatchObject({ act: 'quiet', why: 'music-default' });
    expect(act(ev('playback-started', { firstToday: true }), ctx())).toBe('bubble');
    expect(act(ev('track-changed', { mood: 'Lofi' }), ctx())).toBe('bubble');
    const afterMusicBubble = ctx({ recentReactions: [reaction(15, { act: 'bubble', kind: 'curious' }, 'track-changed')] });
    expect(decideByRules(ev('track-changed', { mood: 'jazz' }), afterMusicBubble)).toMatchObject({ act: 'quiet', why: 'music-not-twice' });
  });

  it('nudges once per night on a long late session', () => {
    const late = ctx({ localHour: 1 });
    expect(decideByRules(ev('long-session'), late)).toMatchObject({ act: 'bubble', kind: 'nudge' });
    expect(act(ev('long-session'), ctx({ localHour: 15 }))).toBe('quiet');
    const nudged = ctx({ localHour: 2, recentReactions: [reaction(60, { act: 'bubble', kind: 'nudge' }, 'long-session')] });
    expect(decideByRules(ev('long-session'), nudged)).toMatchObject({ act: 'quiet', why: 'nudged-tonight' });
  });

  it('leaves finished work to the teaser rule, and only gestures when no teaser is due', () => {
    expect(decideByRules(ev('tool-done'), ctx({ teaserDue: true }))).toMatchObject({ act: 'quiet', why: 'teaser-due' });
    expect(decideByRules(ev('tool-done'), ctx())).toMatchObject({ act: 'gesture', kind: 'celebrate' });
    expect(decideByRules(ev('tool-failed'), ctx())).toMatchObject({ act: 'gesture', kind: 'comfort' });
    expect(decideByRules(ev('reply-done-hidden'), ctx())).toMatchObject({ act: 'gesture', kind: 'inform' });
  });

  it('treats a single click as petting: a gesture at most', () => {
    expect(decideByRules(ev('clicked'), ctx({ chattiness: 'high' }))).toMatchObject({ act: 'gesture', kind: 'playful' });
  });

  it('leaves rule events to their own handling, and keeps quiet when in doubt', () => {
    for (const name of ['message-sent', 'reminder-due', 'double-clicked', 'needs-ok', 'error'] as const) {
      expect(decideByRules(ev(name), ctx())).toMatchObject({ act: 'quiet', why: 'handled-elsewhere' });
    }
    for (const name of ['thrown', 'landed', 'meeting-soon', 'idle-start', 'wake', 'playlist-ended'] as const) {
      expect(decideByRules(ev(name), ctx())).toMatchObject({ act: 'quiet', why: 'when-in-doubt' });
    }
  });

  it('never speaks in the chat unprompted', () => {
    const names: PersonaEvent['name'][] = [
      'clicked', 'back-after', 'first-open-today', 'track-changed', 'playback-started', 'long-session', 'tool-done', 'ack-sent'
    ];
    for (const name of names) {
      for (const chattiness of ['low', 'medium', 'high'] as const) {
        const d = decideByRules(ev(name, { minutesAway: 60, firstToday: true, mood: 'jazz' }), ctx({ chattiness, localHour: 1 }));
        expect(d.act).not.toBe('chat');
      }
    }
  });

  it('sits behind the decision port', async () => {
    await expect(rulesDecider.decide(ev('clicked'), ctx())).resolves.toMatchObject({ act: 'gesture' });
  });
});
