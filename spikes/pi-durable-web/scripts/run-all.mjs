// Reruns every check of the spike, each with HOME set to a fresh temp directory.
// Usage: pnpm --filter @familiar/spike-pi-durable-web spike [bundle|browser|conformance|pool ...]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const here = join(import.meta.dirname, '..');
const steps = {
  bundle: ['node', ['scripts/bundle-check.mjs']],
  browser: ['node', ['scripts/browser-check.mjs']],
  conformance: [join(here, 'node_modules/.bin/vitest'), ['run', '--config', 'vitest.config.ts']],
  pool: ['node', ['--experimental-strip-types', '--no-warnings', 'scripts/pool-hazard.mjs']]
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps);

let failed = 0;
for (const name of wanted) {
  const [cmd, args] = steps[name];
  const home = mkdtempSync(join(tmpdir(), `spike-home-${name}-`));
  console.log(`\n=== ${name} (HOME=${home}) ===`);
  const result = spawnSync(cmd, args, {
    cwd: here,
    stdio: 'inherit',
    env: { ...process.env, HOME: home, SPIKE_REAL_HOME: process.env.SPIKE_REAL_HOME ?? homedir() }
  });
  rmSync(home, { recursive: true, force: true });
  if (result.status !== 0) {
    failed++;
    console.log(`=== ${name} exited ${result.status} ===`);
  }
}
process.exit(failed ? 1 : 0);
