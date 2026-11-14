import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'fake-mcp-server', include: ['tests/**/*.test.ts'] }
});
