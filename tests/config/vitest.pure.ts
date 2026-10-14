import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    setupFiles: ['tests/support/unit/environment.ts'],
    fileParallelism: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    include: [
      'tests/unit/home.test.{js,ts}',
      'tests/unit/time/**/*.test.{js,ts}',
      'tests/unit/agenda/**/*.test.{js,ts}',
      'tests/unit/scheduling/**/*.test.{js,ts}',
      'tests/unit/messaging/**/*.test.{js,ts}',
      'tests/unit/entities/**/*.test.{js,ts}',
      'tests/unit/users/**/*.test.{js,ts}',
      'tests/unit/reminders/**/*.test.{js,ts}',
      'tests/unit/subscriptions/**/*.test.{js,ts}',
      'tests/unit/integrations/**/*.test.{js,ts}',
      'tests/unit/infrastructure/**/*.test.{js,ts}',
      'tests/unit/memory/**/*.test.{js,ts}',
      'tests/unit/calendar/**/*.test.{js,ts}',
    ],
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.{js,ts}',
    ],
  },
});
