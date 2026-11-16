// Core's copy of the exe's syntactic rules, so a draft fails early with the same words: plain local paths
// (shell-core's paths.rs and server_path.rs), and the classes of literal IP addresses (address.rs). Only
// what can be decided from the text: a name's reach is the exe's to decide, after the person approves it
// and it's looked up. apps/desktop/tests/mcp.test.ts reads shell-core's lists and fails if they drift.

/** Characters the exe never takes in a path, and escapes wherever it shows text (confirm.rs). */
export const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff]
];

/** Names Windows keeps for devices, with or without an extension (paths.rs). */
export const DEVICES: readonly string[] = [
  'con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt0',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9', 'com\u00b9', 'com\u00b2', 'com\u00b3',
  'lpt\u00b9', 'lpt\u00b2', 'lpt\u00b3', 'conin$', 'conout$', 'clock$'
];

const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

export function hidden(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return isControl(cp) || INVISIBLE.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** One plain file or folder name: nothing Windows would read as something else. */
export function plain(name: string): boolean {
  if (name === '' || name === '.' || name === '..' || new TextEncoder().encode(name).length > 255) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  for (const ch of name) if (isControl(ch.codePointAt(0)!) || '<>:"|?*'.includes(ch)) return false;
  const stem = (name.split('.')[0] ?? name).replace(/ +$/, '').toLowerCase();
  return !DEVICES.includes(stem);
}

/** A plain local absolute path: a drive letter, `:\`, then plain names, and no hidden character. */
export function localPath(input: string): boolean {
  if (!/^[A-Za-z]:\\/.test(input)) return false;
  const rest = input.slice(3);
  if (rest.includes('/') || [...rest].some(hidden)) return false;
  if (rest === '') return true;
  return rest.replace(/\\$/, '').split('\\').every(plain);
}

const PATH_WORDS = 'Use a full path on a local drive, such as C:\\Tools\\server.exe: no network share, no relative path, no .., no device name and no unusual characters.';

/** What's wrong with a setup's program, as the exe would refuse it. A bare name is looked up on PATH. */
export function programProblem(program: string): string | undefined {
  if (/[\\/:]/.test(program)) return localPath(program) ? undefined : `Familiar won't start the program "${program}". ${PATH_WORDS}`;
  return plain(program) && ![...program].some(hidden) ? undefined : `"${program}" isn't a program name Familiar can look up. Give a plain name, such as npx, or a full path.`;
}

/** What's wrong with a setup's folder, as the exe would refuse it. */
export function folderProblem(cwd: string): string | undefined {
  return localPath(cwd) ? undefined : `Familiar won't run a server in the folder "${cwd}". ${PATH_WORDS.replace('C:\\Tools\\server.exe', 'C:\\Servers\\files')}`;
}

export type IpClass = 'loopback' | 'lan' | 'public' | 'refused';

/** A literal IPv4 address's class, as the exe's `class_v4`. */
export function classV4(o: readonly number[]): IpClass {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 0) return 'refused';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'lan';
  if (a === 169 && b === 254) return 'refused';
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'refused';
  if (a >= 224) return 'refused';
  return 'public';
}

/** The eight 16-bit groups of an IPv6 address in the URL parser's form (hex groups, `::` once). */
function v6Groups(text: string): number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === '' ? [] : s.split(':').map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.some(Number.isNaN) ? undefined : groups;
}

/** A literal IPv6 address's class, as the exe's `class_v6`. */
export function classV6(g: readonly number[]): IpClass {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const publicOnly = (c: IpClass): IpClass => (c === 'public' ? c : 'refused');
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return classV4(v4(g[6]!, g[7]!));
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return 'loopback';
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return publicOnly(classV4(v4(g[6]!, g[7]!)));
  if ((g[0]! & 0xfe00) === 0xfc00) return 'lan';
  if ((g[0]! & 0xe000) !== 0x2000) return 'refused';
  if (g[0] === 0x2002) return publicOnly(classV4(v4(g[1]!, g[2]!)));
  if (g[0] === 0x2001 && g[1]! < 0x0200) return 'refused';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'refused';
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return 'refused';
  return 'public';
}

/** A URL host's class when it's a literal IP or `localhost`; undefined for a name, which only the exe
    classes, after the person approves it. The host is as the URL parser gives it. */
export function literalClass(host: string): IpClass | undefined {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (h.startsWith('[') && h.endsWith(']')) {
    const g = v6Groups(h.slice(1, -1));
    return g ? classV6(g) : 'refused';
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  return m ? classV4(m.slice(1).map(Number)) : undefined;
}

/** How a setup's program and folder are checked. The app is on Windows and always uses `windowsPaths`;
    core's tests in Node on Linux pass `posixPaths`, since their fake server lives at a POSIX path. */
export interface PathRules {
  program(program: string): string | undefined;
  folder(cwd: string): string | undefined;
}

export const windowsPaths: PathRules = { program: programProblem, folder: folderProblem };

/** For tests only: absolute POSIX paths, or a bare program name. */
export const posixPaths: PathRules = {
  program: p => (p.startsWith('/') || plain(p) ? undefined : `"${p}" isn't a program Familiar can start.`),
  folder: p => (p.startsWith('/') ? undefined : `Familiar won't run a server in the folder "${p}".`)
};
