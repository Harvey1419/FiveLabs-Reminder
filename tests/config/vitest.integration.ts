import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    include: ['tests/integration/**/*.integration.test.{js,ts}'],
    setupFiles: ['tests/support/integration/environment.ts'],
    fileParallelism: false,
    testTimeout: 40000,
    hookTimeout: 30000,
  },
});
