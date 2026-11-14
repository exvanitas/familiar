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
