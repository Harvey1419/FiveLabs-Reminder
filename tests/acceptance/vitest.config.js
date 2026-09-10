import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/acceptance/*.integration.test.js'],
    fileParallelism: false,
    testTimeout: 80000,
    hookTimeout: 10000,
    bail: 1,
  },
});
