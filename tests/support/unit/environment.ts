/**
 * Isolated unit test environment setup for Vitest.
 * Enforces mock credentials, sandbox URLs, and a network ban so unit tests never touch
 * production infrastructure or depend on developer-local .env files.
 */
import http from 'node:http';
import https from 'node:https';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
process.env.SUPABASE_SECRET = 'placeholder-secret';
process.env.OPENROUTER_API_KEY = 'test-dummy-openrouter-key';
process.env.AI_API_KEY = 'test-dummy-openrouter-key';
process.env.GROQ_API_KEY = 'test-dummy-groq-key';
process.env.OPENAI_API_KEY = 'test-dummy-openai-key';
process.env.KAPSO_API_KEY = 'test-dummy-kapso-key';
process.env.KAPSO_PHONE_NUMBER_ID = 'test-dummy-phone-id';
process.env.KAPSO_PRODUCTION_PHONE_NUMBER_ID = 'test-dummy-prod-phone-id';
process.env.KAPSO_WEBHOOK_VERIFY_TOKEN = 'test-dummy-verify-token';
process.env.GOOGLE_CLIENT_ID = 'test-dummy-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-dummy-google-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://hermes.templelabs.co/auth/google/callback';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';

delete process.env.BILLING_PROVIDER;
delete process.env.ENFORCE_BILLING;
delete process.env.ENFORCE_BILLING_FOR_ALL;
delete process.env.ALLOW_DESTRUCTIVE_BENCHMARK;

// Outbound network call ban for unit tests
globalThis.fetch = async function blockedFetch(input) {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(`[NETWORK_BLOCKED] Unmocked network call in unit test: ${url}`);
};

function blockNodeHttp(protocol: string) {
  return function blockedRequest() {
    throw new Error(`[NETWORK_BLOCKED] Unmocked ${protocol} request in unit test`);
  };
}
http.request = blockNodeHttp('http');
http.get = blockNodeHttp('http');
https.request = blockNodeHttp('https');
https.get = blockNodeHttp('https');
