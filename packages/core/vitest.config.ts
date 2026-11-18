import { defineProject } from 'vitest/config';

// The root config's 30 s budget, which a project doesn't inherit: the CPU-bound property tests and the
// tests that spawn real server processes run near 5 s when the whole gate runs in parallel.
export default defineProject({
  test: { name: 'core', include: ['tests/**/*.test.ts'], testTimeout: 30000 }
});
