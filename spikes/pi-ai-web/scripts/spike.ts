// Reruns every check of this spike with HOME set to a fresh temp directory:
// the bundle measurements, the model port contract in Node, and the headless browser run.
// Usage: pnpm --filter @familiar/spike-pi-ai-web spike [bundle|contract|browser]...

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'familiar-spike-home-'));
// SPIKE_REAL_HOME only lets the browser step find the already installed Playwright Chromium.
const env = { ...process.env, SPIKE_REAL_HOME: process.env.SPIKE_REAL_HOME ?? homedir(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') };

const steps: Record<string, string[]> = {
  bundle: ['node', 'scripts/bundle.ts'],
  contract: ['node_modules/.bin/vitest', 'run', '--reporter=verbose'],
  browser: ['node', 'scripts/browser.ts']
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps);

let failed = false;
try {
  for (const name of wanted) {
    const cmd = steps[name];
    if (!cmd) throw new Error(`unknown step ${name}`);
    console.log(`\n=== ${name} (HOME=${home}) ===`);
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: here, env, stdio: 'inherit' });
    if (r.status !== 0) {
      failed = true;
      console.log(`=== ${name} failed (exit ${r.status}) ===`);
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
