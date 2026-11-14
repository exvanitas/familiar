// The decision port: should the persona react to something nobody asked her about, and roughly how?
// Direct moments (you send a message, a reminder fires, a consent card shows) are rules elsewhere.
// This answers the ambient middle. The first decider is plain rules (rules.ts). A small local model
// can take the same port later, if it beats the rules on a shared test bench.

export type Act =
  | 'quiet'
  | 'gesture' // a pose or a small mark, no words
  | 'bubble' // one short line
  | 'chat'; // a message in the chat (or, in part 2, calling her out)

export type ReactionKind = 'greet' | 'celebrate' | 'comfort' | 'curious' | 'playful' | 'nudge' | 'inform' | 'none';

export interface Decision {
  readonly act: Act;
  readonly kind: ReactionKind;
  /** Which rule decided, for logs and tests. A model leaves it out. */
  readonly why?: string;
}

export type Chattiness = 'low' | 'medium' | 'high';

/** Ambient events. The buddy ones arrive in part 2, from Desktop Buddies' API v2. */
export type AmbientEventName =
  // the buddy
  | 'clicked'
  | 'picked-up'
  | 'thrown'
  | 'landed'
  | 'sent-home'
  | 'called-out'
  | 'hidden'
  | 'shown'
  | 'paused'
  | 'resumed'
  | 'hold-ended'
  | 'bound'
  | 'unbound'
  | 'bubble-dismissed'
  // the app
  | 'app-started'
  | 'first-open-today'
  | 'chat-opened'
  | 'chat-closed'
  | 'chat-in-front'
  | 'ack-sent' // you sent only an acknowledgement, such as "thanks" or "ok"
  | 'tool-done'
  | 'tool-failed'
  | 'reply-done-hidden'
  // music, from a music server
  | 'playback-started'
  | 'playback-paused'
  | 'playback-stopped'
  | 'track-changed'
  | 'playlist-ended'
  // the system
  | 'idle-start'
  | 'back-after'
  | 'session-locked'
  | 'session-unlocked'
  | 'fullscreen-on'
  | 'fullscreen-off'
  | 'dnd-on'
  | 'dnd-off'
  | 'sleep'
  | 'wake'
  // the clock
  | 'long-session'
  | 'day-boundary'
  // a calendar server
  | 'meeting-soon'
  | 'meeting-started';

/** Events with fixed handling elsewhere. They still appear in the recent events, as context. */
export type RuleEventName = 'double-clicked' | 'bubble-clicked' | 'menu-chosen' | 'message-sent' | 'needs-ok' | 'error' | 'reminder-due';

export interface PersonaEvent {
  readonly name: AmbientEventName | RuleEventName;
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** back-after: how long you were away. */
  readonly minutesAway?: number;
  /** playback-started and track-changed: the first play today. */
  readonly firstToday?: boolean;
  /** track-changed: a genre or mood tag from the music server. Never the track's title. */
  readonly mood?: string;
}

export interface PastReaction {
  readonly at: number;
  readonly decision: Decision;
  readonly event: PersonaEvent['name'];
}

/**
 * What a decider sees. Never window titles, paths or message text.
 */
export interface DecisionContext {
  /** The persona's short sketch, and the tags she cares about (matched against music moods). */
  readonly persona: { readonly sketch: string; readonly interests: readonly string[] };
  readonly chattiness: Chattiness;
  readonly doNotDisturb: boolean;
  readonly fullscreen: boolean;
  /** You sent her home, hid or paused her, and haven't called her out since. */
  readonly sentAway: boolean;
  /** Up to the last 10 events, oldest first. */
  readonly recentEvents: readonly PersonaEvent[];
  /** Up to her last 3 reactions (anything above quiet), oldest first. */
  readonly recentReactions: readonly PastReaction[];
  /** Minutes since the last chat message either way, or null if none yet. */
  readonly minutesSinceChat: number | null;
  readonly chatInFront: boolean;
  /** Milliseconds since the epoch. */
  readonly now: number;
  /** The local hour, 0 to 23. */
  readonly localHour: number;
  /** A teaser for a finished reply or tool is already due (the teaser rule handles it). */
  readonly teaserDue: boolean;
}

export interface DecisionPort {
  decide(event: PersonaEvent, context: DecisionContext): Promise<Decision>;
}
