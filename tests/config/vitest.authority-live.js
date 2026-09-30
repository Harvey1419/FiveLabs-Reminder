import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live/state-authority.eval.js'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90000,
    hookTimeout: 10000,
    retry: 0,
  },
});
