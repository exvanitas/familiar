// V3 decorators: `@@name value` lines in a lore entry's content. None is honoured yet. Their lines are
// left out wherever the content is used, and the card keeps them as written.

const LINE = /^[ \t]*@@/;

/** The content without its decorator lines. */
export function stripDecorators(content: string): string {
  if (!content.includes('@@')) return content;
  return content
    .split('\n')
    .filter((line) => !LINE.test(line))
    .join('\n')
    .replace(/^\n+/, '');
}

/** The decorators the V3 spec defines. Only these names ever reach a warning: anything else is card text. */
export const KNOWN_DECORATORS: ReadonlySet<string> = new Set([
  'activate', 'activate_only_after', 'activate_only_every', 'additional_keys', 'depth', 'disable_ui_prompt', 'dont_activate',
  'dont_activate_after_match', 'exclude_keys', 'ignore_on_max_context', 'instruct_depth', 'is_greeting', 'is_user_icon',
  'keep_activate_after_match', 'position', 'reverse_depth', 'reverse_instruct_depth', 'role', 'scan_depth'
]);

/** The decorator names a content uses, for the warning: known ones by name, anything else as "unknown". */
export function decoratorNames(content: string): string[] {
  if (!content.includes('@@')) return [];
  const out = new Set<string>();
  for (const line of content.split('\n')) {
    if (!LINE.test(line)) continue;
    const m = /^[ \t]*@@@?([A-Za-z_]{1,32})(?:\s|$)/.exec(line);
    const name = m?.[1]!.toLowerCase();
    out.add(name && KNOWN_DECORATORS.has(name) ? name : 'unknown');
  }
  return [...out];
}
