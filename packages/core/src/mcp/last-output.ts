// A server's last output: its last lines of stderr (and stray stdout), bounded, for Test and the
// capability matrix when it exits. The lines are already blanked of the setup's secrets.

import { cutText } from './wire/parse.ts';

export const LAST_LINES = 40;
export const LAST_BYTES = 16 * 1024;
const LINE_CHARS = 2000;
const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s).length;

export class LastOutput {
  private lines: string[] = [];
  private size = 0;

  push(line: string): void {
    const cut = line.length > LINE_CHARS ? `${cutText(line, LINE_CHARS)}…` : line;
    this.lines.push(cut);
    // Counted in UTF-8 bytes, as the bound says: a line of CJK text is three times its length.
    this.size += utf8(cut) + 1;
    while (this.lines.length > LAST_LINES || (this.size > LAST_BYTES && this.lines.length > 1)) {
      this.size -= utf8(this.lines.shift()!) + 1;
    }
  }

  /** The kept lines, or undefined if there were none. */
  text(): string | undefined {
    return this.lines.length ? this.lines.join('\n') : undefined;
  }
}
