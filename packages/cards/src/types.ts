// The one card shape every format is read into: a superset of V3, with the spec's own field names so
// the mapping stays plain. Every field the reader knows is always present (empty when the card didn't
// have it), except the few that V3 makes optional.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type LorePosition = 'before_char' | 'after_char';

export interface LoreEntry {
  keys: string[];
  secondary_keys: string[];
  /** As the card wrote it, V3 `@@` decorator lines included. They're stripped where the content is used. */
  content: string;
  enabled: boolean;
  insertion_order: number;
  priority: number;
  case_sensitive: boolean;
  /** When true, a primary key and a secondary key must both match. */
  selective: boolean;
  /** Always in, without a key. */
  constant: boolean;
  use_regex: boolean;
  /** Kept, not used yet: the prompt has one place for lore (docs/cards-design.md). */
  position: LorePosition;
  name: string;
  comment: string;
  id?: number | string;
  extensions: JsonObject;
}

export interface Lorebook {
  name: string;
  description: string;
  /** How many of the newest messages are scanned. Absent means DEFAULT_SCAN_DEPTH. */
  scan_depth?: number;
  /** The most tokens the matched entries may take. Absent means only the prompt's own budget. */
  token_budget?: number;
  /** Kept, not honoured yet. */
  recursive_scanning: boolean;
  extensions: JsonObject;
  entries: LoreEntry[];
}

export interface CardAsset {
  type: string;
  uri: string;
  name: string;
  ext: string;
}

export interface Card {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  alternate_greetings: string[];
  group_only_greetings: string[];
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  creator: string;
  character_version: string;
  tags: string[];
  /** Opaque, depth- and size-limited. `talkativeness` and `depth_prompt` are read from here. */
  extensions: JsonObject;
  nickname?: string;
  creator_notes_multilingual?: { [language: string]: string };
  source?: string[];
  creation_date?: number;
  modification_date?: number;
  assets?: CardAsset[];
  character_book?: Lorebook;
}

export type CardFormat = 'v1' | 'v2' | 'v3';

/** Plain words, safe to log: a warning never quotes the card's own text. */
export interface Warning {
  readonly code: WarningCode;
  readonly message: string;
}

export type WarningCode =
  | 'cut' // a field was longer than its limit and was cut
  | 'too-many' // a list was longer than its limit and was cut
  | 'wrong-type' // a field had the wrong type and was left empty
  | 'dropped-key' // a `__proto__`, `constructor` or `prototype` key was dropped from opaque data
  | 'extension-dropped' // an extension was too deep or too big and was dropped
  | 'decorators' // lore entries use V3 decorators, which aren't honoured yet
  | 'regex-refused' // a regex key was refused, and its entry skipped
  | 'spec-version' // the card says a version the reader doesn't know; read as its spec anyway
  | 'duplicate-chunk' // a PNG had the same card chunk twice; the first was used
  | 'fell-back' // a PNG's ccv3 chunk was unreadable, and its chara chunk was used
  | 'card-cut' // the card alone was over the prompt's budget and was cut
  | 'over-budget'; // the parts that are never dropped already fill the budget

export type ReadErrorKind =
  | 'too-large' // the file, the JSON or a card chunk is over its limit
  | 'too-deep' // the JSON nests deeper than MAX_JSON_DEPTH
  | 'bad-png' // a PNG whose chunks can't be walked: truncated, a bad length or CRC
  | 'no-card' // a PNG with no card chunk
  | 'compressed' // the only card chunk is zTXt or compressed iTXt
  | 'bad-base64'
  | 'bad-utf8'
  | 'bad-json'
  | 'not-a-card' // valid JSON that isn't a V1, V2 or V3 card, or a card with no name
  | 'charx'; // a CHARX zip, which comes later

export interface ReadError {
  readonly kind: ReadErrorKind;
  readonly message: string;
}

export type ReadResult =
  | {
      readonly ok: true;
      readonly card: Card;
      /** Which spec the file was written to. */
      readonly format: CardFormat;
      /** For a PNG card, the file's own bytes, untouched: the chat avatar. */
      readonly avatar?: Uint8Array;
      readonly warnings: readonly Warning[];
    }
  | { readonly ok: false; readonly error: ReadError };
