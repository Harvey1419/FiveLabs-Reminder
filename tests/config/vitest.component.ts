import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    setupFiles: ['tests/support/unit/environment.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 15000,
    include: [
      'tests/unit/agent/**/*.test.{js,ts}',
    ],
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.{js,ts}',
    ],
  },
});
