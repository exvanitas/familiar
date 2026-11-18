import { defineProject } from 'vitest/config';

// The root config's 30 s budget, which a project doesn't inherit: the CPU-bound property tests and the
// tests that spawn real server processes run near 5 s when the whole gate runs in parallel.
export default defineProject({
  // The test build: named mutation switches exist and the harness can turn them on. The app build folds
  // this to false and drops them (apps/desktop/scripts/define.ts).
  define: { __FAMILIAR_MUTATIONS__: 'true' },
  test: { name: 'core', include: ['tests/**/*.test.ts'], testTimeout: 30000 }
});
