// The unpinned flag. npx, uvx, bunx, `pnpm dlx` and `docker run` fetch what they run. Without an exact
// version (or an image digest), they can fetch new code at any start, which the person's approval never
// saw. So such a setup is flagged, with how to pin it. Approval binds the arguments, so pinning (or
// changing the pin) asks again.

export interface Unpinned {
  readonly runner: 'npx' | 'uvx' | 'bunx' | 'pnpm dlx' | 'docker run';
  /** The package or image as written. */
  readonly what: string;
  readonly words: string;
  /** How to pin it, in plain words with an example. */
  readonly fix: string;
}

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function base(program: string): string {
  return (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** npm's `name@version`, with a scope's own @ left alone. */
function npmVersion(spec: string): { name: string; version?: string } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at < 0 ? { name: spec } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** The first argument that isn't a flag, skipping flags that take a value. */
function firstPlain(args: readonly string[], withValue: readonly string[]): { index: number; arg?: string } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return { index: i + 1, arg: args[i + 1] };
    if (!a.startsWith('-')) return { index: i, arg: a };
    if (withValue.includes(a)) i++;
  }
  return { index: -1 };
}

/** A local setup's unpinned package or image, or undefined when it's pinned or isn't fetched. */
export function unpinned(program: string, args: readonly string[]): Unpinned | undefined {
  const name = base(program);
  if (name === 'npx' || name === 'bunx') return npmLike(name, args);
  if (name === 'pnpm') {
    const dlx = args.indexOf('dlx');
    return dlx < 0 ? undefined : npmLike('pnpm dlx', args.slice(dlx + 1), args.slice(0, dlx));
  }
  if (name === 'uvx') return uvx(args);
  if (name === 'uv') {
    const tool = args[0] === 'tool' && args[1] === 'run' ? args.slice(2) : undefined;
    return tool ? uvx(tool) : undefined;
  }
  if (name === 'docker' || name === 'podman') {
    const run = args.indexOf('run');
    return run < 0 ? undefined : docker(args.slice(run + 1));
  }
  return undefined;
}

function npmLike(runner: 'npx' | 'bunx' | 'pnpm dlx', args: readonly string[], before: readonly string[] = []): Unpinned | undefined {
  // `-p <pkg>` / `--package <pkg>` / `--package=<pkg>` name the packages; otherwise it's the first plain argument.
  const packages: string[] = [];
  const all = [...before, ...args];
  for (let i = 0; i < all.length; i++) {
    const a = all[i]!;
    if ((a === '-p' || a === '--package') && all[i + 1]) packages.push(all[++i]!);
    else if (a.startsWith('--package=')) packages.push(a.slice('--package='.length));
  }
  if (packages.length === 0) {
    const { arg } = firstPlain(args, ['-c', '--call', '--cache', '--registry', '--userconfig']);
    if (arg) packages.push(arg);
  }
  for (const spec of packages) {
    if (spec.startsWith('.') || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/') || /^(file|git|https?):/.test(spec)) continue;
    const { name, version } = npmVersion(spec);
    if (version && EXACT.test(version)) continue;
    return {
      runner,
      what: spec,
      words: version
        ? `${runner} can fetch new code for ${name} at any start: "${version}" isn't an exact version.`
        : `${runner} can fetch new code for ${name} at any start, since no version is pinned.`,
      fix: `Pin an exact version, such as ${name}@1.2.3, with the version you checked.`
    };
  }
  return undefined;
}

function uvx(args: readonly string[]): Unpinned | undefined {
  const from = args.indexOf('--from');
  const spec = from >= 0 ? args[from + 1] : args.find(a => a.startsWith('--from='))?.slice(7) ?? firstPlain(args, ['--with', '--python', '-p', '--index-url', '--extra-index-url', '--index']).arg;
  if (!spec || /^(\.|\/|[A-Za-z]:[\\/]|git\+|https?:)/.test(spec)) return undefined;
  const m = /^([A-Za-z0-9._-]+(?:\[[^\]]*\])?)\s*(?:(==|@)\s*([^\s,;]+))?/.exec(spec);
  const name = m?.[1] ?? spec;
  const version = m?.[3];
  if (version && EXACT.test(version)) return undefined;
  return {
    runner: 'uvx',
    what: spec,
    words: version ? `uvx can fetch new code for ${name} at any start: "${version}" isn't an exact version.` : `uvx can fetch new code for ${name} at any start, since no version is pinned.`,
    fix: `Pin an exact version, such as ${name}@1.2.3 (or --from ${name}==1.2.3), with the version you checked.`
  };
}

const DOCKER_WITH_VALUE = [
  '-e', '--env', '--env-file', '-v', '--volume', '--name', '-p', '--publish', '--network', '--net', '-w', '--workdir', '--mount', '-u', '--user',
  '--entrypoint', '-l', '--label', '--platform', '--pull', '-m', '--memory', '--cpus', '--add-host', '--cap-add', '--cap-drop', '--device', '--dns',
  '-h', '--hostname', '--ipc', '--pid', '--restart', '--runtime', '--security-opt', '--shm-size', '--tmpfs', '--ulimit', '--log-driver', '--log-opt',
  '--gpus', '--cidfile', '--expose', '--group-add', '--health-cmd', '--isolation', '--link', '--mac-address', '--stop-signal', '--userns', '--uts', '--volumes-from'
];

function docker(args: readonly string[]): Unpinned | undefined {
  const { arg: image } = firstPlain(args, DOCKER_WITH_VALUE);
  if (!image) return undefined;
  if (/@sha256:[0-9a-f]{64}$/.test(image)) return undefined;
  const lastPart = image.slice(image.lastIndexOf('/') + 1);
  const tag = lastPart.includes(':') ? lastPart.slice(lastPart.indexOf(':') + 1) : undefined;
  if (tag && tag !== 'latest') return undefined;
  const name = tag ? image.slice(0, image.length - tag.length - 1) : image;
  return {
    runner: 'docker run',
    what: image,
    words: tag ? `docker can fetch a new image for ${name} at any start: "latest" moves.` : `docker can fetch a new image for ${name} at any start, since no tag or digest is pinned.`,
    fix: `Pin a version tag, such as ${name}:1.2.3, or better a digest, such as ${name}@sha256:… from docker images --digests.`
  };
}
