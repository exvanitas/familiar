// The prerequisites check: Node.js, Python's uv and Docker, found or not, with what each is for. Finding a
// program without starting it needs the exe, which has no such command yet (`program_find`, planned for
// the pre-release native pass). Until then there's no finder, and each row says it's checked when the
// person presses Test, where a missing program comes back as not-found with the same words.
//
// The exe command will take only these names and answer only found or not-found, never a path, so the
// port is shaped the same way.

/** The only programs the finder can be asked about. */
export const FINDABLE = ['node', 'npx', 'uv', 'uvx', 'docker'] as const;
export type Findable = (typeof FINDABLE)[number];

/** `unknown` until the exe has the command, or when it couldn't answer. */
export type Found = 'found' | 'not-found' | 'unknown';

/** Looks a program up the way the exe would start it, without starting it. */
export interface ProgramFinder {
  find(program: Findable): Promise<Found>;
}

export interface Prerequisite {
  readonly id: 'node' | 'uv' | 'docker';
  readonly name: string;
  /** The programs that show it's there. */
  readonly programs: readonly Findable[];
  /** What it's for, in plain words. */
  readonly for: string;
  /** Where to get it. */
  readonly get: string;
}

export const PREREQUISITES: readonly Prerequisite[] = [
  { id: 'node', name: 'Node.js', programs: ['npx', 'node'], for: 'Servers started with npx, which is most of them.', get: 'Get the LTS from nodejs.org.' },
  { id: 'uv', name: "Python's uv", programs: ['uvx', 'uv'], for: 'Python servers started with uvx.', get: 'Install it from docs.astral.sh/uv.' },
  { id: 'docker', name: 'Docker', programs: ['docker'], for: 'Servers that run in a container, started with docker run.', get: 'Install Docker Desktop, and start it.' }
];

export interface PrerequisiteRow {
  readonly prerequisite: Prerequisite;
  readonly found: Found;
  readonly words: string;
}

export const CHECKED_AT_TEST = 'Checked when you press Test.';

export async function checkPrerequisites(finder?: ProgramFinder): Promise<PrerequisiteRow[]> {
  const rows: PrerequisiteRow[] = [];
  for (const p of PREREQUISITES) {
    let found: Found = 'unknown';
    if (finder) {
      for (const program of p.programs) {
        const f = await finder.find(program).catch((): Found => 'unknown');
        if (f === 'found') { found = 'found'; break; }
        if (f === 'not-found') found = 'not-found';
      }
    }
    const words = found === 'found' ? `${p.name} is installed. ${p.for}` : found === 'not-found' ? `${p.name} isn't installed. ${p.for} ${p.get}` : `${p.name}: ${CHECKED_AT_TEST} ${p.for}`;
    rows.push({ prerequisite: p, found, words });
  }
  return rows;
}

/** Which prerequisite a program needs, if it's one of them. */
export function prerequisiteOf(program: string): Prerequisite | undefined {
  const name = (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return PREREQUISITES.find(p => (p.programs as readonly string[]).includes(name));
}
