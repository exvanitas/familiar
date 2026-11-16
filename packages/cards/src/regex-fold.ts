// Case folding for regex keys under flag i, exactly as ECMAScript does it without the u flag
// (Canonicalize): take ch's uppercase; if that isn't exactly one code unit, ch itself; if ch is
// outside ASCII and its uppercase is inside, ch itself; else the uppercase. A character matches a
// set when some member has the same canonical form. So the Kelvin sign K stays apart from k, and
// sigma's three forms are one.
//
// Built once, on first use, for every UTF-16 code unit: each one's canonical form, and the code units
// that share each form (about 0.5 MB in all).

export interface FoldTables {
  /** canon[c]: c's canonical form. */
  readonly canon: Uint16Array;
  /** The code units whose canonical form is k are members[start[k]] up to members[start[k + 1]]. */
  readonly start: Uint32Array;
  readonly members: Uint16Array;
}

let tables: FoldTables | undefined;

export function canonicalize(c: number): number {
  const u = String.fromCharCode(c).toUpperCase();
  if (u.length !== 1) return c;
  const cu = u.charCodeAt(0);
  return c >= 128 && cu < 128 ? c : cu;
}

export function foldTables(): FoldTables {
  if (tables) return tables;
  const canon = new Uint16Array(0x10000);
  const start = new Uint32Array(0x10001);
  for (let c = 0; c < 0x10000; c++) {
    canon[c] = canonicalize(c);
    start[canon[c]! + 1]!++;
  }
  for (let k = 0; k < 0x10000; k++) start[k + 1]! += start[k]!;
  const members = new Uint16Array(0x10000);
  const fill = start.slice(0, 0x10000);
  for (let c = 0; c < 0x10000; c++) members[fill[canon[c]!]!++] = c;
  tables = { canon, start, members };
  return tables;
}
