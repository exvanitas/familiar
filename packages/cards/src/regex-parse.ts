// The parser for regex lore keys (regex.ts has the subset, the compiler and the matcher): a pattern to
// a small tree, refusing anything outside the subset by its reason alone.
import { MAX_REGEX_REPEAT } from './limits.ts';

export type RefusedWhy =
  | 'too-long'
  | 'bad-flags'
  | 'backreference'
  | 'lookaround'
  | 'named-group'
  | 'unicode-property'
  | 'unsupported-escape'
  | 'bound-too-large'
  | 'too-many-states'
  | 'does-not-compile'
  | 'over-book-budget';

export class Refused extends Error {
  readonly why: RefusedWhy;
  constructor(why: RefusedWhy) {
    super(why);
    this.why = why;
  }
}

export type CharTest = (c: number) => boolean;
export type Assertion = 'bol' | 'eol' | 'word' | 'not-word';
/** A character node: `test`, then negated. Case folding (flag i) happens between the two, when running. */
export type Node =
  | { t: 'char'; test: CharTest; negate: boolean }
  | { t: 'assert'; kind: Assertion }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; options: Node[] }
  | { t: 'repeat'; node: Node; min: number; max: number }; // max is Infinity when unbounded

export interface Flags {
  i: boolean;
  m: boolean;
  s: boolean;
}

export const isLine = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
export const isWord = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const SPACES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const isSpace = (c: number) => SPACES.has(c) || (c >= 0x2000 && c <= 0x200a);
const SIMPLE: Record<string, number> = { n: 0x0a, t: 0x09, r: 0x0d, f: 0x0c, v: 0x0b };
const CLASS_ESCAPES: Record<string, CharTest> = {
  d: isDigit, D: (c) => !isDigit(c), w: isWord, W: (c) => !isWord(c), s: isSpace, S: (c) => !isSpace(c)
};
const charNode = (test: CharTest, negate = false): Node => ({ t: 'char', test, negate });

export class Parser {
  private at = 0;
  private readonly p: string;
  private readonly dotAll: boolean;
  constructor(pattern: string, dotAll: boolean) {
    this.p = pattern;
    this.dotAll = dotAll;
  }

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.p.length) throw new Refused('does-not-compile'); // a stray ')'
    return node;
  }

  private peek(): string | undefined {
    return this.p[this.at];
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.peek() === '|') {
      this.at++;
      options.push(this.sequence());
    }
    return options.length === 1 ? options[0]! : { t: 'alt', options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.at < this.p.length && this.peek() !== '|' && this.peek() !== ')') items.push(this.quantified(this.atom()));
    return { t: 'cat', items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number, max: number, length = 1;
    if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '?') [min, max] = [0, 1];
    else if (c === '{') {
      // The whole {...}, however long its digits (the pattern is already at most MAX_REGEX_CHARS).
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.p.slice(this.at));
      if (!m) return atom; // a `{` that isn't a quantifier is a literal, as in JavaScript
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (min > max) throw new Refused('does-not-compile');
      if (min > MAX_REGEX_REPEAT || (max !== Infinity && max > MAX_REGEX_REPEAT)) throw new Refused('bound-too-large');
      length = m[0].length;
    } else return atom;
    if (atom.t === 'assert') throw new Refused('does-not-compile');
    this.at += length;
    if (this.peek() === '?') this.at++;
    const next = this.peek();
    if (next === '*' || next === '+' || next === '?' || (next === '{' && /^\{\d+(,\d*)?\}/.test(this.p.slice(this.at)))) {
      throw new Refused('does-not-compile'); // "nothing to repeat", as JavaScript says
    }
    return { t: 'repeat', node: atom, min, max };
  }

  private atom(): Node {
    const c = this.p[this.at++]!;
    if (c === '(') return this.group();
    if (c === '[') return this.charClass();
    if (c === '.') return charNode(this.dotAll ? () => true : (x) => !isLine(x));
    if (c === '^') return { t: 'assert', kind: 'bol' };
    if (c === '$') return { t: 'assert', kind: 'eol' };
    if (c === '\\') return this.escape();
    if (c === '*' || c === '+' || c === '?') throw new Refused('does-not-compile');
    const code = c.charCodeAt(0);
    return charNode((x) => x === code);
  }

  private group(): Node {
    if (this.peek() === '?') {
      const kind = this.p.slice(this.at, this.at + 3);
      if (kind.startsWith('?:')) this.at += 2;
      else if (kind.startsWith('?=') || kind.startsWith('?!') || kind === '?<=' || kind === '?<!') throw new Refused('lookaround');
      else if (kind.startsWith('?<')) throw new Refused('named-group');
      else throw new Refused('does-not-compile');
    }
    const inner = this.alternation();
    if (this.p[this.at++] !== ')') throw new Refused('does-not-compile');
    return inner;
  }

  /** After a backslash, outside a class. */
  private escape(): Node {
    const c = this.p[this.at];
    if (c === 'b' || c === 'B') {
      this.at++;
      return { t: 'assert', kind: c === 'b' ? 'word' : 'not-word' };
    }
    if (c === undefined) throw new Refused('does-not-compile');
    if (/[1-9]/.test(c) || c === 'k') throw new Refused('backreference');
    this.at++;
    if (CLASS_ESCAPES[c]) return charNode(CLASS_ESCAPES[c]);
    const code = this.escapeCode(c);
    return charNode((x) => x === code);
  }

  /** The one character an escape (the letter after the backslash, already read) stands for. */
  private escapeCode(c: string): number {
    if (SIMPLE[c] !== undefined) return SIMPLE[c];
    if (c === '0' && !/[0-9]/.test(this.peek() ?? '')) return 0;
    if (c === 'x' || c === 'u') {
      const n = c === 'x' ? 2 : 4;
      const hex = this.p.slice(this.at, this.at + n);
      if (hex.length !== n || !/^[0-9A-Fa-f]+$/.test(hex)) throw new Refused('unsupported-escape');
      this.at += n;
      return parseInt(hex, 16);
    }
    if (c === 'p' || c === 'P') throw new Refused('unicode-property');
    if (/[A-Za-z0-9]/.test(c)) throw new Refused('unsupported-escape');
    return c.charCodeAt(0); // escaped punctuation stands for itself
  }

  private charClass(): Node {
    const negate = this.peek() === '^';
    if (negate) this.at++;
    const parts: CharTest[] = [];
    while (this.peek() !== ']') {
      if (this.at >= this.p.length) throw new Refused('does-not-compile');
      const lo = this.classAtom();
      if (this.peek() === '-' && this.p[this.at + 1] !== undefined && this.p[this.at + 1] !== ']') {
        this.at++;
        const hi = this.classAtom();
        if (typeof lo !== 'number' || typeof hi !== 'number') {
          // A range with \d or the like at an end is no range: both ends and the `-` stand for themselves,
          // as JavaScript reads it without the u flag.
          for (const end of [lo, 0x2d, hi]) parts.push(typeof end === 'number' ? (x) => x === end : end);
          continue;
        }
        if (lo > hi) throw new Refused('does-not-compile');
        parts.push((x) => x >= lo && x <= hi);
      } else parts.push(typeof lo === 'number' ? (x) => x === lo : lo);
    }
    this.at++;
    return charNode((x) => parts.some((t) => t(x)), negate);
  }

  /** One member of a class: a character's code, or a class escape (\d and the like) as a test. */
  private classAtom(): number | CharTest {
    const c = this.p[this.at++]!;
    if (c !== '\\') return c.charCodeAt(0);
    const e = this.p[this.at++];
    if (e === undefined) throw new Refused('does-not-compile');
    if (e === 'b') return 0x08;
    if (/[1-9]/.test(e)) throw new Refused('backreference');
    if (CLASS_ESCAPES[e]) return CLASS_ESCAPES[e];
    return e === '-' ? 0x2d : this.escapeCode(e);
  }
}
