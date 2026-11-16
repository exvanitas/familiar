// The MCP client. See docs/mcp-design.md.
export { ServerActor } from './actor.ts';
export type { ActorOptions, CallOptions, ServerView } from './actor.ts';
export { addressUrl, McpClient } from './client.ts';
export type { AddressPort, McpClientOptions, SecretPort, ServerStatus, TestedTool, TestReport } from './client.ts';
export { canonicalJson, sha256 } from './hash.ts';
export { CALL_MS, CALL_MS_MAX, CALL_MS_MIN, createMachine, DEFAULT_LIMITS, INIT_MS, INIT_MS_MAX, INIT_MS_MIN, resting, step } from './machine.ts';
export type { Effect, Input, Limits, Machine, Phase } from './machine.ts';
export { localDraft, parsePaste, remoteDraft } from './paste.ts';
export type { Draft, DraftOptions, LocalForm, PasteResult, RemoteForm } from './paste.ts';
export { CHECKED_AT_TEST, checkPrerequisites, FINDABLE, PREREQUISITES, prerequisiteOf } from './prerequisites.ts';
export type { Findable, Found, Prerequisite, PrerequisiteRow, ProgramFinder } from './prerequisites.ts';
export { kindOf } from './process.ts';
export type { ProcessError, ProcessEvent, ProcessPort, ProcessSetup } from './process.ts';
export { ProcessTransport } from './process-transport.ts';
export type { RunTransport } from './process-transport.ts';
export { KEY_HEADERS, KEY_PLACEHOLDER, RemoteTransport, remoteHeaders } from './remote.ts';
export type { FetchLike, RemoteTarget } from './remote.ts';
export { deleteServer, fresh, keyOf, loadServers, readServer, SAVED_VERSION, saveServer, SERVER_PREFIX } from './saved.ts';
export type { SavedServer, SavedTool, ServerLimits } from './saved.ts';
export { modelNames, outcomeText, outsideContent, serverTool, toolChanges, toolFingerprint, toolPolicies, MAX_MODEL_NAME } from './server-tools.ts';
export type { ServerTool, ToolChanges, ToolChoice } from './server-tools.ts';
export { acceptAll, MAX_RESULT_CHARS, MAX_TOOLS, openSession, resultText } from './session.ts';
export type { Session, SessionEvents, SessionOptions } from './session.ts';
export {
  changesWhatRuns, keyLike, MAX_ARGS, MAX_SECRETS, MAX_SETTINGS, MAX_SETUP_BYTES, processSetupOf, remoteTargetOf, secretRefs, secretValueProblem,
  setupFingerprint, setupProblems, SETTINGS_THAT_RUN, SETTING_PREFIXES_THAT_RUN, touchesAMarker, urlProblems, validId, validName
} from './setup.ts';
export type { LocalSetup, RemoteSetup, ServerSetup } from './setup.ts';
export type { CallOutcome, Failure, FailureKind, ListedTool, Reply } from './types.ts';
export { unpinned } from './unpinned.ts';
export type { Unpinned } from './unpinned.ts';
export { exitFailure, missingProgram, remoteFailure, startFailure } from './words.ts';
