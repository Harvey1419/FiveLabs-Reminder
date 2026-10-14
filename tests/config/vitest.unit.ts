import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    setupFiles: ['tests/support/unit/environment.ts'],
    fileParallelism: false,
    testTimeout: 40000,
    hookTimeout: 30000,
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.{js,ts}',
    ],
  },
});
