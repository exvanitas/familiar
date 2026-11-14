import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'spike-pi-ai-web', include: ['tests/**/*.test.ts'], testTimeout: 30000 }
});
