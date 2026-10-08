import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  envPrefix: ['VITE_NONEXISTENT_'],
  test: {
    setupFiles: ['tests/support/unit/environment.js'],
    fileParallelism: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    include: [
      'tests/unit/home.test.js',
      'tests/unit/time/**/*.test.js',
      'tests/unit/agenda/**/*.test.js',
      'tests/unit/scheduling/**/*.test.js',
      'tests/unit/messaging/**/*.test.js',
      'tests/unit/entities/**/*.test.js',
      'tests/unit/users/**/*.test.js',
      'tests/unit/reminders/**/*.test.js',
      'tests/unit/subscriptions/**/*.test.js',
      'tests/unit/integrations/**/*.test.js',
      'tests/unit/infrastructure/**/*.test.js',
      'tests/unit/memory/**/*.test.js',
      'tests/unit/calendar/**/*.test.js',
    ],
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.js',
    ],
  },
});
