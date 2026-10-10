import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    setupFiles: ['tests/support/unit/environment.js'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 15000,
    include: [
      'tests/unit/agent/**/*.test.js',
    ],
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.js',
    ],
  },
});
