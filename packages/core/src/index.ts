// Familiar's core: the turn loop, journal, memory, reminders, tool and consent rules, and the MCP client
// arrive here step by step. It never imports Tauri or Node, so it can run in the app's webview or anywhere else.
export { isTerminal } from './model/port.ts';
export type {
  ChatMessage,
  JsonSchema,
  JsonValue,
  ModelError,
  ModelErrorKind,
  ModelEvent,
  ModelPort,
  ModelRequest,
  Replay,
  StopReason,
  ToolCall,
  ToolSpec,
  Usage
} from './model/port.ts';

export { endsWithQuestion, isBareAcknowledgement, needsReply } from './decide/ack.ts';
export type { AckOptions } from './decide/ack.ts';
export type {
  Act,
  AmbientEventName,
  Chattiness,
  Decision,
  DecisionContext,
  DecisionPort,
  PastReaction,
  PersonaEvent,
  ReactionKind,
  RuleEventName
} from './decide/port.ts';
export { BACK_AFTER_MINUTES, BUBBLE_GAP_MINUTES, SETTLE_MINUTES, decideByRules, isLateNight, rulesDecider } from './decide/rules.ts';

export { cappedPort, costOf, createCaps, DROP_TURN_AFTER_MS, emptyLedger, extendTurn, FOLD_AFTER_MS, inputBound, localDay, MESSAGE_FRAME, memoryUsageStore, REQUEST_FRAME, wholeUsage, worstCost } from './model/caps.ts';
export type { CallInfo, CapCheck, Caps, CapsConfig, CapsOptions, Clock, Cost, Ledger, PauseReason, Price, PriceTier, Rates, Reservation, UsageRecord, UsageStore } from './model/caps.ts';
export { retryable, waitBefore, withRetries } from './model/retry.ts';
export type { RetryOptions } from './model/retry.ts';

export * from './journal/index.ts';

export { MAX_ANSWER_CHARS, oneJsonObject, READER_MAX_OUTPUT_TOKENS, readTraits } from './traits/read-traits.ts';
export type { ReadTraitsOptions, TraitFailure, TraitsResult } from './traits/read-traits.ts';
export { memoryTraitCache } from './traits/cache.ts';
export type { TraitCache } from './traits/cache.ts';

export * from './mcp/index.ts';
export { memorySettingsStore, openSettingsStore } from './settings/store.ts';
export type { IndexedSettingsStore, SettingsStore, Stored } from './settings/store.ts';
