// Regex lore keys. A card's regex never runs on the JavaScript engine, which backtracks and can take
// exponential time. Each key is parsed here into a small safe subset, compiled to a Thompson NFA, and
// run by following every state at once (a Pike VM without captures). So a scan costs at most
// states x characters, whatever the pattern.
//
// The subset: literals; escapes \n \t \r \f \v \0 \xHH \uHHHH and escaped punctuation; `.`; character
// classes with ranges and negation; \d \w \s and their negations; ^ $ \b \B; groups `(...)` and
// `(?:...)` (captures ignored); alternation; * + ? and {n} {n,} {n,m}, lazy forms too (they can't
// change whether there's a match), with bounds up to MAX_REGEX_REPEAT, expanded when compiled. Flags
// i, m and s; g and y are dropped. Everything else is refused by its reason alone, never the pattern.
// Characters are UTF-16 code units, as JavaScript reads a regex without the u flag, and flag i folds
// case exactly as it does then (regex-fold.ts).
import { MAX_REGEX_CHARS, MAX_REGEX_STATES } from './limits.ts';
import { foldTables } from './regex-fold.ts';
import { isLine, isWord, Parser, Refused, type Assertion, type CharTest, type Flags, type Node, type RefusedWhy } from './regex-parse.ts';

export type { RefusedWhy } from './regex-parse.ts';

/** A compiled key. `test` says whether it matches anywhere in the text. */
export interface KeyMatcher {
  test(text: string): boolean;
  /** Its NFA states: what a scan costs per character. */
  readonly states: number;
}

export type CompiledKey = { ok: true; regex: KeyMatcher } | { ok: false; why: RefusedWhy };

/** `/pattern/flags` or a bare pattern. Case-insensitive unless `caseSensitive`. Never throws. */
export function compileKey(key: string, caseSensitive: boolean): CompiledKey {
  if (key.length > MAX_REGEX_CHARS) return { ok: false, why: 'too-long' };
  const slashed = /^\/([\s\S]*)\/([A-Za-z]*)$/.exec(key);
  const pattern = slashed ? slashed[1]! : key;
  const flags: Flags = { i: !caseSensitive, m: false, s: false };
  for (const f of slashed ? slashed[2]! : '') {
    if (f === 'g' || f === 'y') continue;
    if (f === 'i' || f === 'm' || f === 's') flags[f] = true;
    else return { ok: false, why: 'bad-flags' };
  }
  try {
    const prog = compile(new Parser(pattern, flags.s).parse(), flags);
    return { ok: true, regex: { test: (text) => run(prog, text), states: prog.size } };
  } catch (e) {
    return { ok: false, why: e instanceof Refused ? e.why : 'does-not-compile' };
  }
}

/* ---------- Compiling, to a Thompson NFA ---------- */

type State =
  | { k: 'char'; test: CharTest; negate: boolean; out: number }
  | { k: 'split'; a: number; b: number }
  | { k: 'assert'; kind: Assertion; out: number }
  | { k: 'match' };

/**
 * The NFA as flat typed arrays, which the run loop reads fast: per state its kind, its arrow (`out`, or
 * a split's first), a split's second arrow, and for a character state its answers for ASCII (looked up,
 * since most scanned text is ASCII), its full test for the rest, and whether it's negated.
 */
interface Prog {
  readonly size: number;
  readonly start: number;
  readonly flags: Flags;
  readonly kind: Uint8Array; // KIND_*
  readonly out: Int32Array;
  readonly alt: Int32Array;
  readonly assertion: (Assertion | undefined)[];
  readonly ascii: Uint8Array; // size x 128
  readonly tests: (CharTest | undefined)[];
  readonly negate: Uint8Array;
}

const KIND_CHAR = 0, KIND_SPLIT = 1, KIND_ASSERT = 2, KIND_MATCH = 3;

function flatten(states: State[], start: number, flags: Flags): Prog {
  const size = states.length;
  const prog: Prog = {
    size, start, flags, kind: new Uint8Array(size), out: new Int32Array(size), alt: new Int32Array(size), assertion: [],
    ascii: new Uint8Array(size * 128), tests: [], negate: new Uint8Array(size)
  };
  states.forEach((st, i) => {
    if (st.k === 'char') {
      prog.kind[i] = KIND_CHAR;
      prog.out[i] = st.out;
      prog.tests[i] = st.test;
      prog.negate[i] = st.negate ? 1 : 0;
      for (let c = 0; c < 128; c++) prog.ascii[i * 128 + c] = st.test(c) ? 1 : 0;
      if (flags.i) {
        // Folded for ASCII input: an ASCII code unit's canonical form is shared only with ASCII ones (a
        // character outside ASCII never folds into it), so this needs only the table just made.
        const fold = foldTables(), row = prog.ascii.slice(i * 128, i * 128 + 128);
        for (let c = 0; c < 128; c++) {
          const k = fold.canon[c]!;
          let hit = 0;
          for (let m = fold.start[k]!; m < fold.start[k + 1]! && !hit; m++) hit = row[fold.members[m]!]!;
          prog.ascii[i * 128 + c] = hit;
        }
      }
    } else if (st.k === 'split') {
      prog.kind[i] = KIND_SPLIT;
      prog.out[i] = st.a;
      prog.alt[i] = st.b;
    } else if (st.k === 'assert') {
      prog.kind[i] = KIND_ASSERT;
      prog.out[i] = st.out;
      prog.assertion[i] = st.kind;
    } else prog.kind[i] = KIND_MATCH;
  });
  return prog;
}

/** A piece of the NFA: where it starts, and the arrows out of it still to be pointed somewhere. */
interface Frag {
  start: number;
  holes: { s: number; field: 'out' | 'a' | 'b' }[];
}

function compile(root: Node, flags: Flags): Prog {
  const states: State[] = [];
  const add = (s: State) => {
    if (states.length >= MAX_REGEX_STATES) throw new Refused('too-many-states');
    return states.push(s) - 1;
  };
  const patch = (f: Frag, to: number) => {
    for (const h of f.holes) (states[h.s] as unknown as Record<string, number>)[h.field] = to;
  };
  const chain = (parts: Frag[]): Frag => {
    for (let i = 0; i + 1 < parts.length; i++) patch(parts[i]!, parts[i + 1]!.start);
    return { start: parts[0]!.start, holes: parts.at(-1)!.holes };
  };
  /** Matches nothing, without reading: a split whose two arrows go to the same place. */
  const empty = (): Frag => {
    const s = add({ k: 'split', a: -1, b: -1 });
    return { start: s, holes: [{ s, field: 'a' }, { s, field: 'b' }] };
  };
  const build = (n: Node): Frag => {
    switch (n.t) {
      case 'char': {
        const s = add({ k: 'char', test: n.test, negate: n.negate, out: -1 });
        return { start: s, holes: [{ s, field: 'out' }] };
      }
      case 'assert': {
        const s = add({ k: 'assert', kind: n.kind, out: -1 });
        return { start: s, holes: [{ s, field: 'out' }] };
      }
      case 'cat':
        return n.items.length === 0 ? empty() : chain(n.items.map(build));
      case 'alt': {
        const frags = n.options.map(build);
        let f = frags.at(-1)!;
        for (let i = frags.length - 2; i >= 0; i--) f = { start: add({ k: 'split', a: frags[i]!.start, b: f.start }), holes: [...frags[i]!.holes, ...f.holes] };
        return f;
      }
      case 'repeat': {
        // min copies, then a loop when unbounded, or (max - min) optional copies.
        const parts: Frag[] = [];
        for (let i = 0; i < n.min; i++) parts.push(build(n.node));
        if (n.max === Infinity) {
          const body = build(n.node);
          const s = add({ k: 'split', a: body.start, b: -1 });
          patch(body, s);
          parts.push({ start: s, holes: [{ s, field: 'b' }] });
        } else {
          for (let i = n.min; i < n.max; i++) {
            const body = build(n.node);
            parts.push({ start: add({ k: 'split', a: body.start, b: -1 }), holes: [...body.holes] });
            parts.at(-1)!.holes.push({ s: parts.at(-1)!.start, field: 'b' });
          }
        }
        return parts.length === 0 ? empty() : chain(parts);
      }
    }
  };
  const f = build(root);
  patch(f, add({ k: 'match' }));
  return flatten(states, f.start, flags);
}

/* ---------- Running: every state at once ---------- */

function holds(kind: Assertion, text: string, at: number, multiline: boolean): boolean {
  const before = at > 0 ? text.charCodeAt(at - 1) : -1, after = at < text.length ? text.charCodeAt(at) : -1;
  switch (kind) {
    case 'bol':
      return at === 0 || (multiline && isLine(before));
    case 'eol':
      return at === text.length || (multiline && isLine(after));
    case 'word':
      return isWord(before) !== isWord(after);
    case 'not-word':
      return isWord(before) === isWord(after);
  }
}

/** Whether the program matches anywhere in `text`: at most states x (length + 1) steps. */
function run(prog: Prog, text: string): boolean {
  const { size, kind, out, alt, ascii, tests, negate, flags } = prog;
  const fold = flags.i ? foldTables() : undefined;
  const seen = new Int32Array(size).fill(-1);
  // The states alive at this position and the next, each a list of at most `size`, and the walk's stack.
  let current = new Int32Array(size), next = new Int32Array(size);
  let nCurrent = 0, nNext = 0;
  const stack = new Int32Array(size * 2 + 2);
  /** Adds a state, and every state it reaches without reading, at position `at`, to `next`. True on a match. */
  const reach = (from: number, at: number): boolean => {
    let top = 0;
    stack[top++] = from;
    while (top > 0) {
      const s = stack[--top]!;
      if (seen[s] === at) continue;
      seen[s] = at;
      const k = kind[s];
      if (k === KIND_CHAR) next[nNext++] = s;
      else if (k === KIND_SPLIT) {
        stack[top++] = alt[s]!;
        stack[top++] = out[s]!;
      } else if (k === KIND_ASSERT) {
        if (holds(prog.assertion[s]!, text, at, flags.m)) stack[top++] = out[s]!;
      } else return true;
    }
    return false;
  };
  // Position 0: the start joins.
  if (reach(prog.start, 0)) return true;
  for (let at = 0; at < text.length; at++) {
    [current, next] = [next, current];
    nCurrent = nNext;
    nNext = 0;
    const c = text.charCodeAt(at);
    // Under i, a state matches c when it matches any code unit with c's canonical form (c included).
    let first = 0, last = 0;
    if (fold) {
      const k = fold.canon[c]!;
      first = fold.start[k]!;
      last = fold.start[k + 1]!;
    }
    for (let j = 0; j < nCurrent; j++) {
      const s = current[j]!;
      let hit = false;
      if (c < 128) hit = ascii[s * 128 + c] === 1; // already folded under i
      else if (fold) {
        for (let m = first; m < last && !hit; m++) {
          const x = fold.members[m]!;
          hit = x < 128 ? ascii[s * 128 + x] === 1 : tests[s]!(x);
        }
      } else hit = tests[s]!(c);
      if (hit === (negate[s] === 1)) continue;
      // The common step, one character state to the next, skips the walk.
      const to = out[s]!;
      if (kind[to] === KIND_CHAR) {
        if (seen[to] !== at + 1) {
          seen[to] = at + 1;
          next[nNext++] = to;
        }
      } else if (reach(to, at + 1)) return true;
    }
    // A match can start anywhere, so the start joins at every position.
    if (reach(prog.start, at + 1)) return true;
  }
  return false;
}
