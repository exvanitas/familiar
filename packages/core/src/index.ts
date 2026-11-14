// Familiar's core: the turn loop, journal, memory, reminders, tool and consent rules, and the MCP client
// arrive here step by step. It never imports Tauri or Node, so it can run in the app's webview or anywhere else.
export { isTerminal } from './model/port.ts';
export type {
  ChatMessage,
  JsonSchema,
  ModelError,
  ModelErrorKind,
  ModelEvent,
  ModelPort,
  ModelRequest,
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
