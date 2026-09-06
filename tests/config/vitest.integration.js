import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.js'],
    setupFiles: ['tests/support/integration/environment.js'],
    fileParallelism: false,
    testTimeout: 40000,
    hookTimeout: 30000,
  },
});
