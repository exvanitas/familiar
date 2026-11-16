// Every limit the reader holds a card to, in one place. Each has a test in tests/limits.test.ts, and
// docs/cards-design.md says why it's that size.

/** The whole file, PNG or JSON. Card art is rarely past a few MB. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** The card's JSON, as text: the JSON file, or what a PNG text chunk decodes to. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** One PNG text chunk that holds a card (base64, so about 4/3 of the JSON). */
export const MAX_CARD_CHUNK_BYTES = Math.ceil((MAX_JSON_BYTES * 4) / 3) + 1024;
/** How deep the JSON may nest, objects and arrays together. A real card is under 10. */
export const MAX_JSON_DEPTH = 32;

/** One text field (description, a greeting, a lore entry's content...), in UTF-16 code units. Longer is cut. */
export const MAX_FIELD_CHARS = 100_000;
/** A short field: name, nickname, creator, version, a tag, a lore entry's name, an asset's name. */
export const MAX_SHORT_CHARS = 256;
/** Alternate and group-only greetings, each. */
export const MAX_GREETINGS = 64;
/** Tags. */
export const MAX_TAGS = 64;
/** Lore entries in one book. More are dropped, with a warning. */
export const MAX_LORE_ENTRIES = 2_000;
/** Keys, and secondary keys, in one lore entry. */
export const MAX_KEYS_PER_ENTRY = 64;
/** One lore key. A longer one is dropped, not cut: a cut key, a regex above all, would match something else. */
export const MAX_KEY_CHARS = 1_024;
/** V3 assets, and creator notes languages. */
export const MAX_ASSETS = 64;
export const MAX_LANGUAGES = 32;

/** `extensions`, kept as opaque data: how deep, and how big as JSON, each top-level key may be. */
export const MAX_EXTENSION_DEPTH = 12;
export const MAX_EXTENSION_BYTES = 256 * 1024;

/** A regex key, as written, `/.../flags` included. */
export const MAX_REGEX_CHARS = 256;
/** The biggest bound in `{n}`, `{n,}` or `{n,m}`. Bounds are expanded into states, so this keeps them few. */
export const MAX_REGEX_REPEAT = 100;
/** States one compiled regex key may have. A scan costs states x scanned characters. */
export const MAX_REGEX_STATES = 512;
/** Regex keys in one book, and their states together. With MAX_SCAN_CHARS, these bound a whole scan. */
export const MAX_BOOK_REGEX_KEYS = 64;
export const MAX_BOOK_REGEX_STATES = 1_024;
/** The recent text the lorebook scans: the newest characters of the newest `scan_depth` messages. */
export const MAX_SCAN_CHARS = 20_000;
/** `scan_depth` is clamped to this many messages. */
export const MAX_SCAN_DEPTH = 100;
/** The lorebook scans the newest 4 messages when a book doesn't say. */
export const DEFAULT_SCAN_DEPTH = 4;
