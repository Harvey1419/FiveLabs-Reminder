import { describe, expect, it } from 'vitest';
import { configureIntegrationEnvironment } from '../../support/integration/configure-environment.js';

describe('integration environment safety guard', () => {
  it('fails when isolated Supabase credentials are missing', () => {
    expect(() => configureIntegrationEnvironment({})).toThrow(/SUPABASE_TEST_URL/);
  });

  it('refuses to reuse the configured runtime project', () => {
    const env: NodeJS.ProcessEnv = {
      SUPABASE_URL: 'https://production.supabase.co',
      SUPABASE_TEST_URL: 'https://production.supabase.co',
      SUPABASE_TEST_SECRET: 'test-secret',
    };

    expect(() => configureIntegrationEnvironment(env)).toThrow(/matches SUPABASE_URL/);
  });

  it('refuses to reuse the configured runtime secret', () => {
    const env: NodeJS.ProcessEnv = {
      SUPABASE_URL: 'https://production.supabase.co',
      SUPABASE_SECRET: 'production-secret',
      SUPABASE_TEST_URL: 'https://isolated-test.supabase.co',
      SUPABASE_TEST_SECRET: 'production-secret',
    };

    expect(() => configureIntegrationEnvironment(env)).toThrow(/matches SUPABASE_SECRET/);
  });

  it('maps isolated test credentials to the runtime names used by the data layer', () => {
    const env: NodeJS.ProcessEnv = {
      SUPABASE_URL: 'https://production.supabase.co',
      SUPABASE_TEST_URL: 'https://isolated-test.supabase.co',
      SUPABASE_TEST_SECRET: 'test-secret',
    };

    configureIntegrationEnvironment(env);

    expect(env.SUPABASE_URL).toBe('https://isolated-test.supabase.co');
    expect(env.SUPABASE_SECRET).toBe('test-secret');
  });
});
