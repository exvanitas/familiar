/* Builds the two app folders the exe can serve: dist/app (the real one) and dist/shell-check (the
   contract check's), plus dist/shell-check-broken, whose core page throws. Each page's script is
   one bundle, so pages load only 'self' scripts and nothing inline. */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_DEFINE } from './define.ts';
import { nodeStub } from './node-stub.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;
rmSync(dist, { recursive: true, force: true });

const bundle = (entryPoints: Record<string, string>, outdir: string) =>
  build({ entryPoints, outdir, bundle: true, format: 'esm', target: 'chrome120', legalComments: 'none', logLevel: 'warning', define: APP_DEFINE, plugins: [nodeStub] });

mkdirSync(`${dist}/app`, { recursive: true });
cpSync(`${root}app`, `${dist}/app`, { recursive: true });
await bundle({ core: `${root}src/app/core.ts`, chat: `${root}src/app/chat.ts`, settings: `${root}src/app/settings.ts` }, `${dist}/app`);

mkdirSync(`${dist}/shell-check`, { recursive: true });
cpSync(`${root}shell-check/pages`, `${dist}/shell-check`, { recursive: true });
await bundle({ core: `${root}shell-check/core.ts`, page: `${root}shell-check/page.ts`, edge: `${root}shell-check/edge.ts` }, `${dist}/shell-check`);

cpSync(`${root}shell-check/broken`, `${dist}/shell-check-broken`, { recursive: true });
console.log('built dist/app, dist/shell-check and dist/shell-check-broken');
