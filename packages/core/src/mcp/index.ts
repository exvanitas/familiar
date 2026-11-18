// The MCP client. See docs/mcp-design.md.
export { BUILT_IN, CALL_MS, CALL_MS_MAX, CALL_MS_MIN, McpClient } from './client.ts';
export type { AddressPort, McpClientOptions, SecretPort, ServerStatus, TestedTool, TestReport } from './client.ts';
export { canonicalJson, sha256 } from './hash.ts';
export type { Phase } from './runtime.ts';
export { canonicalArguments, plainJson, sameFacts } from './decision.ts';
export type { CardFacts, ToolDecision } from './decision.ts';
// The wire (ServerLink, the exchange machine, framing) stays inside: only the client hands off a call.
export { LINK_LIMITS, MAX_PAGES, reservedHeader } from './wire/link.ts';
export type { LinkLimits, NetHead, NetPort, NetSpec } from './wire/link.ts';
export { LEGACY_VERSIONS, MODERN_VERSION, OFFERED_VERSION } from './wire/framing.ts';
export { MAX_RESULT_CHARS, resultText } from './wire/parse.ts';
export { localDraft, parsePaste, remoteDraft } from './paste.ts';
export type { Draft, DraftOptions, LocalForm, PasteResult, RemoteForm } from './paste.ts';
export { CHECKED_AT_TEST, checkPrerequisites, FINDABLE, PREREQUISITES, prerequisiteOf } from './prerequisites.ts';
export type { Findable, Found, Prerequisite, PrerequisiteRow, ProgramFinder } from './prerequisites.ts';
export { kindOf } from './process.ts';
export type { ProcessError, ProcessEvent, ProcessPort, ProcessSetup } from './process.ts';
export { KEY_HEADERS, KEY_PLACEHOLDER, remoteHeaders } from './remote.ts';
export type { RemoteTarget } from './remote.ts';
export { fresh } from './saved.ts';
export type { SavedTool, ServerLimits } from './saved.ts';
export { addressIdentity, BUSY_WORDS, issueKey, keyBase, MAX_KEY, MAX_MODEL_NAME, modelName, Owner, OWNER_KEY, OWNER_VERSION, UNFINISHED_WORDS, WAITING_AFTER_MS, WAITING_WORDS } from './owner.ts';
export type { Mark, OwnedServer, OwnerPorts, Outcome, Tombstone } from './owner.ts';
export { choiceKey, outcomeText, wrapperPolicy, outsideContent, serverTool, toolChanges, toolFingerprint, toolPolicies } from './server-tools.ts';
export type { Sender, ServerTool, ToolChanges, ToolChoice } from './server-tools.ts';
export { CatalogError, checkTools, effectiveDescription, MAX_CATALOG_BYTES, MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, MAX_TOOL_BYTES, MAX_TOOLS } from './catalog.ts';
export {
  changesWhatRuns, credentialLike, keyLike, MAX_ARGS, MAX_SECRETS, MAX_SETTINGS, MAX_SETUP_BYTES, processSetupOf, remoteTargetOf, secretRefs, secretValueProblem,
  setupFingerprint, setupProblems, SETTINGS_THAT_RUN, SSE_WORDS, SETTING_PREFIXES_THAT_RUN, touchesAMarker, urlProblems, validId, validName
} from './setup.ts';
export type { LocalSetup, RemoteSetup, ServerSetup } from './setup.ts';
export type { CallOutcome, Failure, FailureKind, ListedTool, Reply } from './types.ts';
export { unpinned } from './unpinned.ts';
export type { Unpinned } from './unpinned.ts';
export { exitFailure, missingProgram, remoteFailure, startFailure } from './words.ts';
export { classV4, classV6, DEVICES, folderProblem, hidden, INVISIBLE, literalClass, localPath, plain, posixPaths, programProblem, windowsPaths } from './native-rules.ts';
export type { IpClass, PathRules } from './native-rules.ts';
