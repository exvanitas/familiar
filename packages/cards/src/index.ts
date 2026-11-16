// Familiar's character cards: reading V1, V2 and V3 cards (PNG or JSON), the lorebook, macros, the
// persona's prompt, the plain helper and the trait reader's pure parts. No Tauri or Node imports (a
// test checks), so it runs in the webview and can be lifted into a shared package later.
export type {
  Card, CardAsset, CardFormat, JsonObject, JsonValue, LoreEntry, Lorebook, LorePosition, ReadError, ReadErrorKind, ReadResult, Warning, WarningCode
} from './types.ts';
export * from './limits.ts';
export { readCard } from './read.ts';
export { toV3Json } from './write.ts';
export { decoratorNames, KNOWN_DECORATORS, stripDecorators } from './decorators.ts';
export { compileKey } from './regex.ts';
export type { CompiledKey, KeyMatcher, RefusedWhy } from './regex.ts';
export { fitLore, matchLore, prepareLorebook, scanText } from './lore.ts';
export type { LoreChoice, PreparedEntry, PreparedLorebook, ScanMessage } from './lore.ts';
export { fillMacros, UTC_FORMAT } from './macros.ts';
export type { DateFormat, MacroContext } from './macros.ts';
export { estimateTokens } from './tokens.ts';
export type { TokenEstimator } from './tokens.ts';
export { buildPrompt, DEFAULT_PERSONA_SETTINGS, pickGreeting, PROMPT_LABELS } from './prompt.ts';
export type { Dropped, MemorySections, PersonaSettings, Prompt, PromptInput, Section, SectionName } from './prompt.ts';
export { DEFAULT_HELPER_NAME, plainHelper } from './helper.ts';
export type { PlainHelper } from './helper.ts';

export * from './traits/types.ts';
export {
  herLore, herLoreEntries, READER_DEPTH_PROMPT_CHARS, READER_EXAMPLE_CHARS, READER_GREETINGS, READER_LORE_CHARS, READER_TEXT, READER_TOTAL_CHARS,
  READER_VERSION, readerPrompt, sentCardText, SET_TRAITS_TOOL
} from './traits/reader.ts';
export type { ReaderPart, ReaderPrompt, ReaderTool } from './traits/reader.ts';
export { checkAnswer, MAX_INTEREST_CHARS, MAX_INTERESTS, MAX_QUOTE_CHARS } from './traits/check.ts';
export { plistWords, readByRules, TALKATIVE_ABOVE, TALKATIVE_BELOW, wppWords } from './traits/rules.ts';
export {
  applyReading, cardHashOf, chattinessOf, effectiveTraits, NEUTRAL_STATE, setChattiness, setYours, shownTraits, suggestChattiness, useCards
} from './traits/merge.ts';
export type { ReadingEvent, ShownTrait, ShownTraits, TraitState } from './traits/merge.ts';
export { traitCacheKey } from './traits/key.ts';
export type { Digest } from './traits/key.ts';
