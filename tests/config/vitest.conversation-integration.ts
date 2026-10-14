import { defineConfig } from 'vitest/config';

/** Actual loop, durable coordinator and presenter; only external providers are simulated. */
export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    include: ['tests/integration/agent/v2-conversation.integration.test.ts', 'tests/integration/agent/v2-legacy-continuity.integration.test.ts'],
    setupFiles: ['tests/support/unit/environment.ts'],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
