// The first decider: the owner's accepted reaction rules (2026-11-14), as plain code.
// When in doubt, quiet.

import type {
  Chattiness,
  Decision,
  DecisionContext,
  DecisionPort,
  PersonaEvent,
  ReactionKind,
  RuleEventName
} from './port.ts';

const MINUTE = 60_000;

/** At most one unprompted bubble per this many minutes. */
export const BUBBLE_GAP_MINUTES: Readonly<Record<Chattiness, number>> = { low: 30, medium: 10, high: 5 };
/** After any reaction, quiet for this long unless something bigger happens. */
export const SETTLE_MINUTES = 2;
/** Away at least this long counts as coming back, and outranks the settle time. */
export const BACK_AFTER_MINUTES = 20;
/** Late night is from 23:00 to 05:00, local time. */
export const LATE_NIGHT = { from: 23, to: 5 } as const;
/** The night window is six hours, so a nudge in the last six hours means one was given tonight. */
const NIGHT_HOURS = 6;

const RULE_EVENTS: ReadonlySet<RuleEventName> = new Set<RuleEventName>([
  'double-clicked',
  'bubble-clicked',
  'menu-chosen',
  'message-sent',
  'needs-ok',
  'error',
  'reminder-due'
]);

const MUSIC_EVENTS: ReadonlySet<PersonaEvent['name']> = new Set<PersonaEvent['name']>([
  'playback-started',
  'playback-paused',
  'playback-stopped',
  'track-changed',
  'playlist-ended'
]);

export function decideByRules(event: PersonaEvent, ctx: DecisionContext): Decision {
  if (RULE_EVENTS.has(event.name as RuleEventName)) return quiet('handled-elsewhere');
  if (ctx.doNotDisturb || ctx.fullscreen) return quiet('do-not-disturb');
  if (ctx.sentAway) return quiet('sent-away');

  // Acknowledgement only: no spoken line, a gesture at most.
  if (event.name === 'ack-sent') return { act: 'gesture', kind: 'none', why: 'acknowledgement' };
  if (event.name === 'bubble-dismissed' || event.name === 'chat-closed') return quiet('acknowledgement');

  const cameBack = event.name === 'back-after' && (event.minutesAway ?? 0) >= BACK_AFTER_MINUTES;
  if (!cameBack && reactedWithin(ctx, SETTLE_MINUTES)) return quiet('reacted-recently');

  switch (event.name) {
    case 'back-after':
      return cameBack ? greet(ctx, 'back-after') : quiet('short-break');
    case 'first-open-today':
      return greet(ctx, 'first-open-today');
    case 'playback-started':
    case 'track-changed':
      return music(event, ctx);
    case 'long-session':
      if (!isLateNight(ctx.localHour)) return quiet('long-session-daytime');
      if (nudgedTonight(ctx)) return quiet('nudged-tonight');
      return bubbleIfAllowed(ctx, 'nudge', 'late-night', 'gesture');
    case 'tool-done':
    case 'tool-failed':
    case 'reply-done-hidden':
      if (ctx.teaserDue) return quiet('teaser-due');
      return { act: 'gesture', kind: finishedKind(event.name), why: 'finished-without-teaser' };
    case 'clicked':
      return { act: 'gesture', kind: 'playful', why: 'petting' };
    default:
      return quiet('when-in-doubt');
  }
}

/** The rules decider behind the decision port. */
export const rulesDecider: DecisionPort = {
  decide: (event, context) => Promise.resolve(decideByRules(event, context))
};

export function isLateNight(localHour: number): boolean {
  return localHour >= LATE_NIGHT.from || localHour < LATE_NIGHT.to;
}

function quiet(why: string): Decision {
  return { act: 'quiet', kind: 'none', why };
}

/** Greet once: a gesture at low chattiness, a bubble at medium or high (a gesture if a bubble came too recently). */
function greet(ctx: DecisionContext, why: string): Decision {
  if (ctx.chattiness === 'low') return { act: 'gesture', kind: 'greet', why };
  return bubbleIfAllowed(ctx, 'greet', why, 'gesture');
}

function music(event: PersonaEvent, ctx: DecisionContext): Decision {
  const last = ctx.recentReactions.at(-1);
  if (last && MUSIC_EVENTS.has(last.event) && last.decision.act === 'bubble') return quiet('music-not-twice');
  const mood = event.mood?.toLowerCase();
  const matches = mood !== undefined && ctx.persona.interests.some((i) => i.toLowerCase() === mood);
  if (event.firstToday) return bubbleIfAllowed(ctx, 'playful', 'music-first-today', 'quiet');
  if (matches) return bubbleIfAllowed(ctx, 'curious', 'music-matches-interests', 'quiet');
  return quiet('music-default');
}

function bubbleIfAllowed(ctx: DecisionContext, kind: ReactionKind, why: string, otherwise: 'gesture' | 'quiet'): Decision {
  const lastWords = [...ctx.recentReactions].reverse().find((r) => r.decision.act === 'bubble' || r.decision.act === 'chat');
  const gap = BUBBLE_GAP_MINUTES[ctx.chattiness] * MINUTE;
  if (!lastWords || ctx.now - lastWords.at >= gap) return { act: 'bubble', kind, why };
  if (otherwise === 'gesture') return { act: 'gesture', kind, why: `${why}, bubble-limit` };
  return quiet(`${why}, bubble-limit`);
}

function reactedWithin(ctx: DecisionContext, minutes: number): boolean {
  const last = ctx.recentReactions.at(-1);
  return last !== undefined && last.decision.act !== 'quiet' && ctx.now - last.at < minutes * MINUTE;
}

function nudgedTonight(ctx: DecisionContext): boolean {
  return ctx.recentReactions.some((r) => r.decision.kind === 'nudge' && ctx.now - r.at < NIGHT_HOURS * 60 * MINUTE);
}

function finishedKind(name: 'tool-done' | 'tool-failed' | 'reply-done-hidden'): ReactionKind {
  if (name === 'tool-done') return 'celebrate';
  if (name === 'tool-failed') return 'comfort';
  return 'inform';
}
