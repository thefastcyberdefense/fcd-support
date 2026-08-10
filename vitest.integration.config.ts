import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 20_000,
    include: ['tests/integration/**/*.test.ts'],
    restoreMocks: true,
    sequence: {
      concurrent: false,
    },
    testTimeout: 20_000,
  },
});
