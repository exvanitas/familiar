import { defineProject } from 'vitest/config';

export default defineProject({
  // As the app is built: no named mutation switches (scripts/define.ts).
  define: { __FAMILIAR_MUTATIONS__: 'false' },
  test: { name: 'desktop', include: ['tests/**/*.test.ts'] }
});
