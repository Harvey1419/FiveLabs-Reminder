import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 40000,
    hookTimeout: 30000,
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.js',
    ],
  },
});
