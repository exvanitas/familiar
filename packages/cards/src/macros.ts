// Macros: {{char}}, {{user}}, {{time}}, {{date}} in any case, and the legacy <BOT> and <USER>. One
// pass, so a name that itself holds a macro is never expanded again. Unknown macros stay as written.

export interface DateFormat {
  time(epochMs: number): string;
  date(epochMs: number): string;
}

export interface MacroContext {
  /** Fills {{char}} and <BOT>. */
  readonly char: string;
  /** Fills {{user}} and <USER>. */
  readonly user: string;
  /** The clock's reading. Without it, {{time}} and {{date}} stay as written. */
  readonly now?: number;
  readonly format?: DateFormat;
}

const MACRO = /\{\{\s*(char|user|time|date)\s*\}\}|<(bot|user)>/gi;

export function fillMacros(text: string, ctx: MacroContext): string {
  if (!text.includes('{{') && !text.includes('<')) return text;
  return text.replace(MACRO, (whole, curly: string | undefined, angle: string | undefined) => {
    const name = (curly ?? angle)!.toLowerCase();
    if (name === 'char' || name === 'bot') return ctx.char;
    if (name === 'user') return ctx.user;
    if (ctx.now === undefined || !ctx.format) return whole;
    return name === 'time' ? ctx.format.time(ctx.now) : ctx.format.date(ctx.now);
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A fixed format in UTC: `2026-11-16` and `14:05`. For tests and as a fallback; the app passes the person's own. */
export const UTC_FORMAT: DateFormat = {
  time: (ms) => {
    const d = new Date(ms);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  },
  date: (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
};
