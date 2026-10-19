import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/db/**/*.test.ts', 'tests/live/**/*.test.ts'], environment: 'node', testTimeout: 30000, hookTimeout: 60000, fileParallelism: false },
});
