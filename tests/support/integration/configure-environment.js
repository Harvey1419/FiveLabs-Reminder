export function configureIntegrationEnvironment(env = process.env) {
  const testUrl = env.SUPABASE_TEST_URL?.trim();
  const testSecret = env.SUPABASE_TEST_SECRET?.trim();
  const configuredRuntimeUrl = env.SUPABASE_URL?.trim();
  const configuredRuntimeSecret = env.SUPABASE_SECRET?.trim();

  if (!testUrl || !testSecret) {
    throw new Error(
      [
        'Integration test environment is not configured.',
        'Set SUPABASE_TEST_URL and SUPABASE_TEST_SECRET for an isolated Supabase test project.',
        'Use `npm run test:unit` when you only need the deterministic offline suite.',
      ].join(' ')
    );
  }

  let parsedTestUrl;
  try {
    parsedTestUrl = new URL(testUrl);
  } catch {
    throw new Error('SUPABASE_TEST_URL must be a valid absolute URL.');
  }

  if (!['http:', 'https:'].includes(parsedTestUrl.protocol)) {
    throw new Error('SUPABASE_TEST_URL must use http or https.');
  }

  if (configuredRuntimeUrl && configuredRuntimeUrl === testUrl) {
    throw new Error(
      'Refusing to run integration tests: SUPABASE_TEST_URL matches SUPABASE_URL. Use a separate test project.'
    );
  }

  if (configuredRuntimeSecret && configuredRuntimeSecret === testSecret) {
    throw new Error(
      'Refusing to run integration tests: SUPABASE_TEST_SECRET matches SUPABASE_SECRET. Use separate test credentials.'
    );
  }

  env.SUPABASE_URL = testUrl;
  env.SUPABASE_SECRET = testSecret;
}
